// @vitest-environment node
/**
 * Fail-closed template loading tests (plan Phase B Task 2 Step 1; turn
 * contract requirement added by plan 2026-08-04 Task 2).
 *
 * The first three cases are the plan's verbatim segments: an unknown route
 * target is rejected with a stable code, a failed explicit reload retains the
 * last valid cache, and a restart with a broken source boots from cache.
 * Remaining cases cover the validation matrix and hash determinism.
 *
 * The committed `__fixtures__` directories intentionally stay LEGACY (no
 * `turnContract`): they double as historical-snapshot fixtures for the
 * incompatibility gate (plan Task 3). Current-contract behavior is exercised
 * through `withContracts`-upgraded copies. Fixture files may carry business
 * copy (they are data); the modules under test carry none (iron rule 1).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CorePaths } from '../storage/core-paths';
import { PROGRESS_POLICY_CEILING } from '../runtime/progress-guard';
import { loadTemplateDirectory } from './template-loader';
import { TemplateCatalog } from './template-catalog';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`__fixtures__/${name}`, import.meta.url));
}

function copyFixture(name: string, templateId: string, templateRoot: string): string {
  const dest = join(templateRoot, templateId);
  cpSync(fixturePath(name), dest, { recursive: true });
  return dest;
}

/** A complete version-1 turn contract block for agent YAML injection/rewrites. */
const CONTRACT_YAML = [
  'turnContract:',
  '  version: 1',
  '  production:',
  '    completionAction: finish_production',
  '    output:',
  '      formats: [markdown]',
  '      sources: [inline, workspace_file]',
  '  dispatch:',
  '    cardinality: single',
  '    allowedActions: [publish_artifact]',
  '    targets:',
  '      publish_artifact: reviewer',
  '    productionPackageRef: current',
  '',
].join('\n');

/** The reviewer contract: one of two intents per turn, message target writer. */
const REVIEWER_CONTRACT_YAML = [
  'turnContract:',
  '  version: 1',
  '  production:',
  '    completionAction: finish_production',
  '    output:',
  '      formats: [markdown, text]',
  '      sources: [inline, current_input_artifact]',
  '  dispatch:',
  '    cardinality: single',
  '    allowedActions: [send_message, submit_final_artifact]',
  '    targets:',
  '      send_message: writer',
  '    productionPackageRef: current',
  '',
].join('\n');

function readFixtureAgent(templateDir: string, agentId: string): string {
  return readFileSync(join(templateDir, `agents/${agentId}.yaml`), 'utf8')
    .replace(/\r\n?/g, '\n')
    .trimEnd();
}

/**
 * Upgrades one copied legacy fixture directory to the current turn contract
 * in place. The committed fixtures stay legacy (no `turnContract`) so Task 3
 * can exercise historical frozen snapshots; current-template behavior is
 * tested through these upgraded copies.
 */
function withContracts(templateDir: string): string {
  writeFileSync(
    join(templateDir, 'agents/writer.yaml'),
    `${readFixtureAgent(templateDir, 'writer')}\n${CONTRACT_YAML}`,
    'utf8',
  );
  writeFileSync(
    join(templateDir, 'agents/reviewer.yaml'),
    `${readFixtureAgent(templateDir, 'reviewer')}\n${REVIEWER_CONTRACT_YAML}`,
    'utf8',
  );
  return templateDir;
}

/** Strips every turnContract block: recreates the legacy shape from a copy. */
function stripContracts(templateDir: string): string {
  for (const agentId of ['writer', 'reviewer']) {
    const file = join(templateDir, `agents/${agentId}.yaml`);
    writeFileSync(
      file,
      readFixtureAgent(templateDir, agentId).replace(/\nturnContract:[\s\S]*$/, ''),
      'utf8',
    );
  }
  return templateDir;
}

/** Rewrites the writer agent file body + one contract block. */
function writeWriterWith(dest: string, contractYaml: string): void {
  writeFileSync(
    join(dest, 'agents/writer.yaml'),
    `id: writer\nname: 初稿 Agent\ndescription: 生成初稿。\nmodel: deepseek/deepseek-chat\nsystemPrompt: |\n  生成初稿。\nskills:\n  - id: style-guide\n    name: 文风指南\n    description: 参考。\n    contentPath: skills/style-guide/SKILL.md\n${contractYaml}`,
    'utf8',
  );
}

/** Rewrites the reviewer agent file body + one contract block. */
function writeReviewerWith(dest: string, contractYaml: string): void {
  writeFileSync(
    join(dest, 'agents/reviewer.yaml'),
    `id: reviewer\nname: 审核 Agent\ndescription: 审核初稿。\nmodel: deepseek/deepseek-chat\nsystemPrompt: |\n  审核初稿。\nskills:\n  - id: review-checklist\n    name: 审核清单\n    description: 参考。\n    contentPath: skills/review-checklist/SKILL.md\n${contractYaml}`,
    'utf8',
  );
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

async function catalogWithValidSource(): Promise<TemplateCatalog> {
  const dataRoot = makeTempDir('forge-core-t2-data-');
  const templateRoot = makeTempDir('forge-core-t2-templates-');
  withContracts(copyFixture('valid', 'test-template', templateRoot));
  const catalog = new TemplateCatalog(CorePaths.create({ dataRoot, templateRoot }));
  await catalog.initialize();
  return catalog;
}

/** Corrupts the source pipeline so a route entry is structurally invalid. */
function breakSourceRoute(paths: CorePaths, templateId: string): void {
  const pipelineFile = join(paths.templateSource(templateId), 'pipeline.yaml');
  const broken = [
    'agents:',
    '  - writer',
    '  - reviewer',
    'routes:',
    '  - from: writer',
    'finalOutput:',
    '  submitters:',
    '    - reviewer',
    '',
  ].join('\n');
  writeFileSync(pipelineFile, broken, 'utf8');
}

async function existingCacheWithBrokenSource(): Promise<CorePaths> {
  const dataRoot = makeTempDir('forge-core-t2-data-');
  const templateRoot = makeTempDir('forge-core-t2-templates-');
  withContracts(copyFixture('valid', 'test-template', templateRoot));
  const paths = CorePaths.create({ dataRoot, templateRoot });
  const catalog = new TemplateCatalog(paths);
  await catalog.initialize();
  breakSourceRoute(paths, 'test-template');
  return paths;
}

describe('loadTemplateDirectory', () => {
  it('loads a contract-upgraded fixture as a frozen template', async () => {
    const root = makeTempDir('forge-core-t2-load-');
    const dest = withContracts(copyFixture('valid', 'valid', root));
    const frozen = await loadTemplateDirectory(dest);
    expect(frozen.id).toBe('valid');
    expect(frozen.name).toBe('双 Agent 协作模板');
    expect(frozen.description).toBe('两位 Agent 通过消息边与产物边协作，产出单一终稿。');
    expect(frozen.inputFields).toEqual([
      {
        id: 'source-material',
        label: '原始素材',
        kind: 'textarea',
        required: true,
        description: '本次生产所依据的素材摘要',
      },
      {
        id: 'style-note',
        label: '风格备注',
        kind: 'text',
        required: false,
        description: '可选的风格约束',
      },
    ]);
    expect(frozen.agents.map((agent) => agent.id)).toEqual(['writer', 'reviewer']);
    expect(frozen.agents[0]?.model).toBe('deepseek/deepseek-chat');
    expect(frozen.agents[1]?.model).toBe('deepseek/deepseek-chat');
    expect(frozen.agents[0]?.skills).toEqual([
      {
        id: 'style-guide',
        name: '文风指南',
        description: '语气与节奏参考。',
        contentPath: 'skills/style-guide/SKILL.md',
        sectionsPath: null,
        sections: [],
      },
    ]);
    expect(frozen.agents[0]?.gate).toBeNull();
    expect(frozen.routes).toEqual([
      { from: 'writer', to: 'reviewer', kind: 'artifact', label: '提交初稿' },
      { from: 'reviewer', to: 'writer', kind: 'message', label: '退回意见' },
    ]);
    expect(frozen.finalOutput).toEqual({ name: '终稿', format: 'markdown', submitters: ['reviewer'] });
    expect(frozen.versionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.sourcePath).toBe(dest);
  });

  it('rejects a legacy fixture whose agents lack turnContract', async () => {
    await expect(loadTemplateDirectory(fixturePath('valid'))).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects a route whose target Agent is absent', async () => {
    const root = makeTempDir('forge-core-t2-route-');
    const dest = withContracts(copyFixture('invalid-route', 'badroute', root));
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_ROUTE_TARGET_UNKNOWN',
      location: 'pipeline.yaml',
    });
  });

  it('retains the previous valid cache when explicit reload fails', async () => {
    const catalog = await catalogWithValidSource();
    const before = catalog.get('test-template');
    breakSourceRoute(catalog.paths, 'test-template');
    await expect(catalog.reload('test-template')).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    expect(catalog.get('test-template')?.version).toBe(before?.version);
  });

  it('boots from last valid cache while source is broken', async () => {
    const restarted = new TemplateCatalog(await existingCacheWithBrokenSource());
    await restarted.initialize();
    expect(restarted.get('test-template')?.status).toBe('invalid_using_cache');
  });

  it('derives the same version hash for identical content in different directories', async () => {
    const rootA = makeTempDir('forge-core-t2-a-');
    const rootB = makeTempDir('forge-core-t2-b-');
    const alpha = withContracts(copyFixture('valid', 'alpha', rootA));
    const beta = withContracts(copyFixture('valid', 'beta', rootB));
    const frozenA = await loadTemplateDirectory(alpha);
    const frozenB = await loadTemplateDirectory(beta);
    expect(frozenA.id).not.toBe(frozenB.id);
    expect(frozenA.versionHash).toBe(frozenB.versionHash);
  });

  it('changes the version hash when skill content changes', async () => {
    const root = makeTempDir('forge-core-t2-skill-');
    const first = withContracts(copyFixture('valid', 'one', root));
    const before = await loadTemplateDirectory(first);
    writeFileSync(join(first, 'skills/style-guide/SKILL.md'), '# 文风指南\n\n- 语气：更活泼。\n', 'utf8');
    const after = await loadTemplateDirectory(first);
    expect(after.versionHash).not.toBe(before.versionHash);
  });

  it('normalizes line endings before hashing', async () => {
    const rootPlain = makeTempDir('forge-core-t2-lf-');
    const rootCrlf = makeTempDir('forge-core-t2-crlf-');
    const plain = withContracts(copyFixture('valid', 'plain', rootPlain));
    const crlfDir = withContracts(copyFixture('valid', 'crlf', rootCrlf));
    const crlfSkill = join(crlfDir, 'skills/style-guide/SKILL.md');
    const plainContent = await loadTemplateDirectory(plain);
    // Rewrite the CRLF copy's skill with CRLF endings only. Normalize the
    // checkout first: with core.autocrlf the source may already carry CRLF,
    // and a blind \n → \r\n rewrite would yield \r\r\n.
    const original = readFileSync(join(plain, 'skills/style-guide/SKILL.md'), 'utf8')
      .replace(/\r\n?/g, '\n');
    writeFileSync(crlfSkill, original.replace(/\n/g, '\r\n'), 'utf8');
    const crlf = await loadTemplateDirectory(crlfDir);
    expect(crlf.versionHash).toBe(plainContent.versionHash);
  });

  it('rejects duplicate YAML mapping keys', async () => {
    const root = makeTempDir('forge-core-t2-dup-');
    const dest = withContracts(copyFixture('valid', 'dup', root));
    writeFileSync(
      join(dest, 'pipeline.yaml'),
      'agents:\n  - writer\n  - reviewer\nagents:\n  - writer\nroutes: []\nfinalOutput:\n  submitters:\n    - writer\n',
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_DUPLICATE_KEY',
      location: 'pipeline.yaml',
    });
  });

  it('rejects a missing skill file', async () => {
    const root = makeTempDir('forge-core-t2-skillmiss-');
    const dest = withContracts(copyFixture('broken-skill', 'brokenskill', root));
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_SKILL_MISSING',
      location: 'skills/missing/SKILL.md',
    });
  });

  it('rejects a skill path escaping the template directory', async () => {
    const root = makeTempDir('forge-core-t2-escape-');
    const dest = withContracts(copyFixture('valid', 'escape', root));
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      `id: writer\nname: 初稿 Agent\ndescription: 生成初稿。\nmodel: deepseek/deepseek-chat\nsystemPrompt: |\n  生成初稿。\nskills:\n  - id: style-guide\n    name: 文风指南\n    description: 参考。\n    contentPath: ../outside/SKILL.md\n${CONTRACT_YAML}`,
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_SKILL_MISSING',
      location: '../outside/SKILL.md',
    });
  });

  it('rejects models outside a single provider namespace', async () => {
    const root = makeTempDir('forge-core-t2-provider-');
    const dest = withContracts(copyFixture('valid', 'mixed', root));
    writeFileSync(
      join(dest, 'agents/reviewer.yaml'),
      `id: reviewer\nname: 审核 Agent\ndescription: 审核。\nmodel: other-provider/model-x\nsystemPrompt: |\n  审核。\nskills:\n  - id: review-checklist\n    name: 审核清单\n    description: 检查项。\n    contentPath: skills/review-checklist/SKILL.md\n${REVIEWER_CONTRACT_YAML}`,
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/reviewer.yaml',
    });
  });

  it('rejects malformed model identifiers', async () => {
    const root = makeTempDir('forge-core-t2-model-');
    const dest = withContracts(copyFixture('valid', 'badmodel', root));
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      `id: writer\nname: 初稿 Agent\ndescription: 生成。\nmodel: no-slash-model\nsystemPrompt: |\n  生成。\nskills:\n  - id: style-guide\n    name: 文风指南\n    description: 参考。\n    contentPath: skills/style-guide/SKILL.md\n${CONTRACT_YAML}`,
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects an unknown final submitter', async () => {
    const root = makeTempDir('forge-core-t2-submitter-');
    const dest = withContracts(copyFixture('valid', 'badsubmit', root));
    writeFileSync(
      join(dest, 'pipeline.yaml'),
      'agents:\n  - writer\n  - reviewer\nroutes: []\nfinalOutput:\n  submitters:\n    - ghost-agent\n',
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_FINAL_SUBMITTER_UNKNOWN',
      location: 'pipeline.yaml',
    });
  });

  it('rejects empty final submitters', async () => {
    const root = makeTempDir('forge-core-t2-nosubmit-');
    const dest = withContracts(copyFixture('valid', 'nosubmit', root));
    writeFileSync(
      join(dest, 'pipeline.yaml'),
      'agents:\n  - writer\n  - reviewer\nroutes: []\nfinalOutput:\n  submitters: []\n',
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'pipeline.yaml',
    });
  });

  it('rejects a route from an unknown agent', async () => {
    const root = makeTempDir('forge-core-t2-from-');
    const dest = withContracts(copyFixture('valid', 'badfrom', root));
    writeFileSync(
      join(dest, 'pipeline.yaml'),
      'agents:\n  - writer\n  - reviewer\nroutes:\n  - from: ghost-agent\n    to: writer\n    kind: message\n    label: x\nfinalOutput:\n  submitters:\n    - reviewer\n',
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_ROUTE_SOURCE_UNKNOWN',
      location: 'pipeline.yaml',
    });
  });

  it('rejects duplicate agent ids in the pipeline order', async () => {
    const root = makeTempDir('forge-core-t2-dupagent-');
    const dest = withContracts(copyFixture('valid', 'dupagent', root));
    writeFileSync(
      join(dest, 'pipeline.yaml'),
      'agents:\n  - writer\n  - writer\nroutes: []\nfinalOutput:\n  submitters:\n    - writer\n',
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'pipeline.yaml',
    });
  });

  it('rejects duplicate input field ids', async () => {
    const root = makeTempDir('forge-core-t2-dupinput-');
    const dest = withContracts(copyFixture('valid', 'dupinput', root));
    writeFileSync(
      join(dest, 'template.yaml'),
      'name: t\ndescription: d\ninputFields:\n  - id: same\n    label: a\n    kind: text\n    required: true\n  - id: same\n    label: b\n    kind: text\n    required: false\nfinalArtifact:\n  name: 终稿\n  format: text\n',
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'template.yaml',
    });
  });

  it('rejects an input field missing required metadata', async () => {
    const root = makeTempDir('forge-core-t2-badinput-');
    const dest = withContracts(copyFixture('valid', 'badinput', root));
    writeFileSync(
      join(dest, 'template.yaml'),
      'name: t\ndescription: d\ninputFields:\n  - id: only-id\n    kind: text\n    required: true\nfinalArtifact:\n  name: 终稿\n  format: text\n',
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'template.yaml',
    });
  });

  it('rejects an undeclared agent file', async () => {
    const root = makeTempDir('forge-core-t2-undeclared-');
    const dest = withContracts(copyFixture('valid', 'undeclared', root));
    writeFileSync(join(dest, 'agents/ghost.yaml'), 'id: ghost\nname: 幽灵\ndescription: 未声明。\nmodel: deepseek/deepseek-chat\nsystemPrompt: |\n  x\nskills: []\n', 'utf8');
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/ghost.yaml',
    });
  });

  it('rejects a pipeline agent without a file', async () => {
    const root = makeTempDir('forge-core-t2-nofile-');
    const dest = withContracts(copyFixture('valid', 'nofile', root));
    writeFileSync(
      join(dest, 'pipeline.yaml'),
      'agents:\n  - writer\n  - reviewer\n  - ghost\nroutes: []\nfinalOutput:\n  submitters:\n    - reviewer\n',
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/ghost.yaml',
    });
  });

  it('rejects an agent file whose name differs from its id', async () => {
    const root = makeTempDir('forge-core-t2-rename-');
    const dest = withContracts(copyFixture('valid', 'renamed', root));
    const reviewer = join(dest, 'agents/reviewer.yaml');
    const renamed = join(dest, 'agents/critic.yaml');
    cpSync(reviewer, renamed);
    unlinkSync(reviewer);
    writeFileSync(
      join(dest, 'pipeline.yaml'),
      'agents:\n  - writer\n  - reviewer\nroutes: []\nfinalOutput:\n  submitters:\n    - reviewer\n',
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/critic.yaml',
    });
  });

  it('rejects a missing template.yaml', async () => {
    const root = makeTempDir('forge-core-t2-notemplate-');
    const dest = withContracts(copyFixture('valid', 'notemplate', root));
    unlinkSync(join(dest, 'template.yaml'));
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'template.yaml',
    });
  });

  it('rejects a missing pipeline.yaml', async () => {
    const root = makeTempDir('forge-core-t2-nopipeline-');
    const dest = withContracts(copyFixture('valid', 'nopipeline', root));
    unlinkSync(join(dest, 'pipeline.yaml'));
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'pipeline.yaml',
    });
  });

  it('reports the directory basename as the template id', async () => {
    const root = makeTempDir('forge-core-t2-id-');
    const dest = withContracts(copyFixture('valid', 'my-template', root));
    const frozen = await loadTemplateDirectory(dest);
    expect(frozen.id).toBe('my-template');
    expect(basename(frozen.sourcePath)).toBe('my-template');
  });
});

describe('turnContract requirement (plan 2026-08-04 Task 2, spec §6)', () => {
  it('loads upgraded fixtures with version 1 contracts on both agents', async () => {
    const root = makeTempDir('forge-core-t2-contracts-');
    const dest = withContracts(copyFixture('valid', 'contracts', root));
    const frozen = await loadTemplateDirectory(dest);
    const writer = frozen.agents.find((agent) => agent.id === 'writer');
    const reviewer = frozen.agents.find((agent) => agent.id === 'reviewer');
    expect(writer?.turnContract).toEqual({
      version: 1,
      production: {
        completionAction: 'finish_production',
        output: { formats: ['markdown'], sources: ['inline', 'workspace_file'] },
      },
      dispatch: {
        cardinality: 'single',
        allowedActions: ['publish_artifact'],
        // Scalar YAML targets normalize to one-element candidate sets.
        targets: { publish_artifact: ['reviewer'] },
        productionPackageRef: 'current',
      },
    });
    expect(reviewer?.turnContract).toMatchObject({
      version: 1,
      dispatch: {
        cardinality: 'single',
        allowedActions: ['send_message', 'submit_final_artifact'],
        targets: { send_message: ['writer'] },
      },
    });
  });

  it('accepts a list of candidate targets for one dispatch intent', async () => {
    const root = makeTempDir('forge-core-t2-targetlist-');
    const dest = withContracts(copyFixture('valid', 'targetlist', root));
    writeReviewerWith(
      dest,
      REVIEWER_CONTRACT_YAML.replace('send_message: writer', 'send_message: [writer, reviewer]'),
    );
    const frozen = await loadTemplateDirectory(dest);
    const reviewer = frozen.agents.find((agent) => agent.id === 'reviewer');
    expect(reviewer?.turnContract?.dispatch.targets).toEqual({
      send_message: ['writer', 'reviewer'],
    });
  });

  it('rejects an empty dispatch target list', async () => {
    const root = makeTempDir('forge-core-t2-emptytargets-');
    const dest = withContracts(copyFixture('valid', 'emptytargets', root));
    writeWriterWith(dest, CONTRACT_YAML.replace('publish_artifact: reviewer', 'publish_artifact: []'));
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects duplicate agents in one dispatch target list', async () => {
    const root = makeTempDir('forge-core-t2-duptargets-');
    const dest = withContracts(copyFixture('valid', 'duptargets', root));
    writeReviewerWith(
      dest,
      REVIEWER_CONTRACT_YAML.replace('send_message: writer', 'send_message: [writer, writer]'),
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/reviewer.yaml',
    });
  });

  it('rejects a dispatch target list containing an undeclared agent', async () => {
    const root = makeTempDir('forge-core-t2-ghostlist-');
    const dest = withContracts(copyFixture('valid', 'ghostlist', root));
    writeWriterWith(
      dest,
      CONTRACT_YAML.replace('publish_artifact: reviewer', 'publish_artifact: [reviewer, ghost-agent]'),
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects agents whose contracts were stripped (legacy shape)', async () => {
    const root = makeTempDir('forge-core-t2-nocontract-');
    const dest = stripContracts(withContracts(copyFixture('valid', 'nocontract', root)));
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects unsupported contract versions', async () => {
    const root = makeTempDir('forge-core-t2-badversion-');
    const dest = withContracts(copyFixture('valid', 'badversion', root));
    writeWriterWith(dest, CONTRACT_YAML.replace('version: 1', 'version: 2'));
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects unknown production sources', async () => {
    const root = makeTempDir('forge-core-t2-badsource-');
    const dest = withContracts(copyFixture('valid', 'badsource', root));
    writeWriterWith(
      dest,
      CONTRACT_YAML.replace('sources: [inline, workspace_file]', 'sources: [latest]'),
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects a dispatch target that is not a declared agent', async () => {
    const root = makeTempDir('forge-core-t2-badtarget-');
    const dest = withContracts(copyFixture('valid', 'badtarget', root));
    writeWriterWith(
      dest,
      CONTRACT_YAML.replace('publish_artifact: reviewer', 'publish_artifact: ghost-agent'),
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects an empty dispatch allowedActions list', async () => {
    const root = makeTempDir('forge-core-t2-noactions-');
    const dest = withContracts(copyFixture('valid', 'noactions', root));
    writeWriterWith(dest, CONTRACT_YAML.replace('allowedActions: [publish_artifact]', 'allowedActions: []'));
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('changes the version hash when the turn contract changes', async () => {
    const rootA = makeTempDir('forge-core-t2-contracthash-a-');
    const rootB = makeTempDir('forge-core-t2-contracthash-b-');
    const destA = withContracts(copyFixture('valid', 'contract-a', rootA));
    const destB = withContracts(copyFixture('valid', 'contract-b', rootB));
    const before = await loadTemplateDirectory(destA);
    writeWriterWith(destB, CONTRACT_YAML.replace('formats: [markdown]', 'formats: [text]'));
    const after = await loadTemplateDirectory(destB);
    expect(after.versionHash).not.toBe(before.versionHash);
  });

  it('hashes a scalar target identically to a one-element target list', async () => {
    // Plan 2026-08-06 hash fold: scalar ≡ [single] is semantically identical,
    // and the fold keeps every existing frozen-snapshot hash byte-stable.
    const rootA = makeTempDir('forge-core-t2-fold-scalar-');
    const rootB = makeTempDir('forge-core-t2-fold-list-');
    const destA = withContracts(copyFixture('valid', 'fold-scalar', rootA));
    const destB = withContracts(copyFixture('valid', 'fold-list', rootB));
    writeWriterWith(destA, CONTRACT_YAML);
    writeWriterWith(destB, CONTRACT_YAML.replace('publish_artifact: reviewer', 'publish_artifact: [reviewer]'));
    expect((await loadTemplateDirectory(destB)).versionHash).toBe(
      (await loadTemplateDirectory(destA)).versionHash,
    );
  });

  it('changes the version hash when a target list gains a second candidate', async () => {
    const rootA = makeTempDir('forge-core-t2-multitarget-hash-a-');
    const rootB = makeTempDir('forge-core-t2-multitarget-hash-b-');
    const destA = withContracts(copyFixture('valid', 'multitarget-a', rootA));
    const destB = withContracts(copyFixture('valid', 'multitarget-b', rootB));
    writeWriterWith(destA, CONTRACT_YAML);
    writeWriterWith(destB, CONTRACT_YAML.replace('publish_artifact: reviewer', 'publish_artifact: [reviewer, writer]'));
    expect((await loadTemplateDirectory(destB)).versionHash).not.toBe(
      (await loadTemplateDirectory(destA)).versionHash,
    );
  });
});

describe('template progress budget (plan 2026-08-06)', () => {
  /** Appends a `budget:` block to a copied fixture's pipeline.yaml. */
  function withBudget(dest: string, budgetYaml: string): string {
    writeFileSync(
      join(dest, 'pipeline.yaml'),
      `${readFileSync(join(dest, 'pipeline.yaml'), 'utf8').trimEnd()}\n${budgetYaml}`,
      'utf8',
    );
    return dest;
  }

  const BUDGET_ONE = 'budget:\n  maxTurnsSinceHumanAnswer: 1';

  it('parses a declared progress budget from pipeline.yaml', async () => {
    const root = makeTempDir('forge-core-budget-parse-');
    const dest = withBudget(withContracts(copyFixture('valid', 'budget-parse', root)), BUDGET_ONE);
    const frozen = await loadTemplateDirectory(dest);
    expect(frozen.budget).toEqual({ maxTurnsSinceHumanAnswer: 1 });
  });

  it('keeps budget null when pipeline.yaml declares none', async () => {
    const root = makeTempDir('forge-core-budget-null-');
    const dest = withContracts(copyFixture('valid', 'budget-null', root));
    const frozen = await loadTemplateDirectory(dest);
    expect(frozen.budget).toBeNull();
  });

  it('rejects a budget above the platform ceiling', async () => {
    const root = makeTempDir('forge-core-budget-too-big-');
    const dest = withBudget(
      withContracts(copyFixture('valid', 'budget-too-big', root)),
      `budget:\n  maxTurnsSinceHumanAnswer: ${PROGRESS_POLICY_CEILING + 1}`,
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'pipeline.yaml',
    });
  });

  it('rejects budget values that are zero, negative, non-integer or missing', async () => {
    for (const value of ['0', '-1', '1.5', '{}']) {
      const root = makeTempDir(`forge-core-budget-bad-${value.replace(/[^0-9]/g, 'x')}-`);
      const dest = withBudget(
        withContracts(copyFixture('valid', 'budget-bad', root)),
        value === '{}' ? 'budget: {}' : `budget:\n  maxTurnsSinceHumanAnswer: ${value}`,
      );
      await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
        code: 'TEMPLATE_INVALID',
        location: 'pipeline.yaml',
      });
    }
  });

  it('treats an empty budget block as the platform default', async () => {
    const root = makeTempDir('forge-core-budget-empty-null-');
    const dest = withBudget(
      withContracts(copyFixture('valid', 'budget-empty-null', root)),
      'budget:',
    );
    const frozen = await loadTemplateDirectory(dest);
    expect(frozen.budget).toBeNull();
  });

  it('rejects unknown keys inside budget', async () => {
    const root = makeTempDir('forge-core-budget-unknown-key-');
    const dest = withBudget(
      withContracts(copyFixture('valid', 'budget-unknown-key', root)),
      'budget:\n  maxTurnsSinceHumanAnswer: 4\n  extra: 1',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'pipeline.yaml',
    });
  });

  it('changes the version hash when a budget is declared', async () => {
    const rootA = makeTempDir('forge-core-budget-hash-a-');
    const rootB = makeTempDir('forge-core-budget-hash-b-');
    const destA = withContracts(copyFixture('valid', 'budget-hash-a', rootA));
    const destB = withBudget(
      withContracts(copyFixture('valid', 'budget-hash-b', rootB)),
      BUDGET_ONE,
    );
    expect((await loadTemplateDirectory(destB)).versionHash).not.toBe(
      (await loadTemplateDirectory(destA)).versionHash,
    );
  });
});

describe('skill sections (plan 2026-08-07 Phase 1)', () => {
  /** Rewrites the writer agent with a `sectionsPath` on the style-guide skill. */
  function writeWriterWithSectionsPath(dest: string, sectionsPath: string): void {
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      `id: writer\nname: 初稿 Agent\ndescription: 生成初稿。\nmodel: deepseek/deepseek-chat\nsystemPrompt: |\n  生成初稿。\nskills:\n  - id: style-guide\n    name: 文风指南\n    description: 参考。\n    contentPath: skills/style-guide/SKILL.md\n    sectionsPath: ${sectionsPath}\n${CONTRACT_YAML}`,
      'utf8',
    );
  }

  it('collects only declared .md section files, sorted, with forward slashes', async () => {
    const root = makeTempDir('forge-core-t2-sections-');
    const dest = withContracts(copyFixture('valid', 'sections', root));
    writeWriterWithSectionsPath(dest, 'skills/style-guide/references');
    const refs = join(dest, 'skills/style-guide/references');
    mkdirSync(join(refs, 'sub'), { recursive: true });
    writeFileSync(join(refs, '01-a.md'), '# 第一节\n', 'utf8');
    writeFileSync(join(refs, 'sub/02-b.md'), '# 第二节\n', 'utf8');
    writeFileSync(join(refs, 'notes.txt'), 'not markdown\n', 'utf8');
    writeFileSync(join(refs, '.hidden.md'), '# hidden\n', 'utf8');
    const frozen = await loadTemplateDirectory(dest);
    const writer = frozen.agents.find((agent) => agent.id === 'writer');
    const reviewer = frozen.agents.find((agent) => agent.id === 'reviewer');
    expect(writer?.skills[0]?.sections).toEqual([
      'skills/style-guide/references/01-a.md',
      'skills/style-guide/references/sub/02-b.md',
    ]);
    expect(writer?.skills[0]?.sectionsPath).toBe('skills/style-guide/references');
    expect(reviewer?.skills[0]?.sections).toEqual([]);
    expect(reviewer?.skills[0]?.sectionsPath).toBeNull();
  });

  it('keeps the version hash stable when an undeclared file changes', async () => {
    const root = makeTempDir('forge-core-t2-sections-unrelated-');
    const dest = withContracts(copyFixture('valid', 'unrelated', root));
    const before = await loadTemplateDirectory(dest);
    // A stray non-declared file inside the skill directory never enters the hash.
    writeFileSync(join(dest, 'skills/style-guide/notes.txt'), 'stray\n', 'utf8');
    const after = await loadTemplateDirectory(dest);
    expect(after.versionHash).toBe(before.versionHash);
  });

  it('changes the version hash when a section file content changes', async () => {
    const root = makeTempDir('forge-core-t2-sections-hash-');
    const dest = withContracts(copyFixture('valid', 'sectionhash', root));
    writeWriterWithSectionsPath(dest, 'skills/style-guide/references');
    const refs = join(dest, 'skills/style-guide/references');
    mkdirSync(refs, { recursive: true });
    writeFileSync(join(refs, '01.md'), '# v1\n', 'utf8');
    const before = await loadTemplateDirectory(dest);
    writeFileSync(join(refs, '01.md'), '# v2\n', 'utf8');
    const after = await loadTemplateDirectory(dest);
    expect(after.versionHash).not.toBe(before.versionHash);
  });

  it('keeps the pre-change version hash for templates without sectionsPath', async () => {
    const root = makeTempDir('forge-core-t2-sections-nullhash-');
    const dest = withContracts(copyFixture('valid', 'nullhash', root));
    const frozen = await loadTemplateDirectory(dest);
    expect(frozen.agents[0]?.skills[0]?.sections).toEqual([]);
    expect(frozen.agents[0]?.skills[0]?.sectionsPath).toBeNull();
    // Byte-stability regression (iron rule 2): the canonical form must omit
    // the `sections` key when empty, reproducing the pre-change hash exactly.
    expect(frozen.versionHash).toBe(
      '5dee5a79b2aa95a0fe9494a3379a6859f5586f35d06fd82d00629a71b38ddd5a',
    );
  });

  it('rejects a missing sectionsPath directory', async () => {
    const root = makeTempDir('forge-core-t2-sections-missing-');
    const dest = withContracts(copyFixture('valid', 'missingsec', root));
    writeWriterWithSectionsPath(dest, 'skills/style-guide/references');
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_SKILL_MISSING',
      location: 'skills/style-guide/references',
    });
  });
});

describe('agent gate (plan 2026-08-07 Phase 2, spec §4.1)', () => {
  const GATE_YAML = [
    'gate:',
    '  validator: gates/validate.cjs',
    '  artifactType: chapter_markdown',
    '  mode: [self_check, commit]',
    '',
  ].join('\n');

  /** Appends a gate block to the writer agent and writes the validator file. */
  function writeWriterGate(dest: string, gateYaml: string, validatorSource: string): void {
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      `${readFixtureAgent(dest, 'writer')}\n${gateYaml}`,
      'utf8',
    );
    mkdirSync(join(dest, 'gates'), { recursive: true });
    writeFileSync(join(dest, 'gates/validate.cjs'), validatorSource, 'utf8');
  }

  it('folds a declared gate into the frozen agent (validator/artifactType/mode)', async () => {
    const root = makeTempDir('forge-core-t2-gate-parse-');
    const dest = withContracts(copyFixture('valid', 'gateparse', root));
    writeWriterGate(dest, GATE_YAML, 'module.exports = { validate() { return { pass: true }; } };');
    const frozen = await loadTemplateDirectory(dest);
    const writer = frozen.agents.find((agent) => agent.id === 'writer');
    expect(writer?.gate).toEqual({
      validator: 'gates/validate.cjs',
      artifactType: 'chapter_markdown',
      mode: ['self_check', 'commit'],
    });
    const reviewer = frozen.agents.find((agent) => agent.id === 'reviewer');
    expect(reviewer?.gate).toBeNull();
  });

  it('changes the version hash when the gate validator content changes', async () => {
    const rootA = makeTempDir('forge-core-t2-gatehash-a-');
    const rootB = makeTempDir('forge-core-t2-gatehash-b-');
    const destA = withContracts(copyFixture('valid', 'gatehash-a', rootA));
    const destB = withContracts(copyFixture('valid', 'gatehash-b', rootB));
    writeWriterGate(destA, GATE_YAML, 'module.exports = { validate() { return { pass: true }; } };');
    writeWriterGate(destB, GATE_YAML, 'module.exports = { validate() { return { pass: false }; } };');
    expect((await loadTemplateDirectory(destB)).versionHash).not.toBe(
      (await loadTemplateDirectory(destA)).versionHash,
    );
  });

  it('keeps the pre-change version hash for templates without a gate', async () => {
    const root = makeTempDir('forge-core-t2-gate-nullhash-');
    const dest = withContracts(copyFixture('valid', 'gatenullhash', root));
    const frozen = await loadTemplateDirectory(dest);
    expect(frozen.agents[0]?.gate).toBeNull();
    // Byte-stability regression (iron rule 2): the canonical form must omit
    // the `gate` key when absent, reproducing the pre-change hash exactly.
    expect(frozen.versionHash).toBe(
      '5dee5a79b2aa95a0fe9494a3379a6859f5586f35d06fd82d00629a71b38ddd5a',
    );
  });

  it('rejects a declared gate whose validator file is missing', async () => {
    const root = makeTempDir('forge-core-t2-gate-missing-');
    const dest = withContracts(copyFixture('valid', 'gatemissing', root));
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      `${readFixtureAgent(dest, 'writer')}\n${GATE_YAML}`,
      'utf8',
    );
    // No gates/ directory is written: the referenced file cannot be read.
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'gates/validate.cjs',
    });
  });

  it('rejects a gate validator path escaping the template directory', async () => {
    const root = makeTempDir('forge-core-t2-gate-escape-');
    const dest = withContracts(copyFixture('valid', 'gateescape', root));
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      `${readFixtureAgent(dest, 'writer')}\ngate:\n  validator: ../outside.cjs\n  artifactType: chapter_markdown\n  mode: [commit]\n`,
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: '../outside.cjs',
    });
  });

  it('rejects an invalid gate mode value', async () => {
    const root = makeTempDir('forge-core-t2-gate-mode-');
    const dest = withContracts(copyFixture('valid', 'gatemode', root));
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      `${readFixtureAgent(dest, 'writer')}\ngate:\n  validator: gates/validate.cjs\n  artifactType: chapter_markdown\n  mode: [self_check, preflight]\n`,
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });
});
