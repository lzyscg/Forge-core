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
import { validateTaskEvent } from '../storage/task-events';
import { PROGRESS_POLICY_CEILING } from '../runtime/progress-guard';
import { createTestRuntimeEnvironment } from '../structured-slots/runtime-capability';
import { createProductionAuthoritativeReviewEnvironment } from '../structured-slots/authoritative-review-capability';
import {
  createAuthoritativeReviewTestEnvironment,
} from '../structured-slots/test-support/authoritative-review-test-registry';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../structured-slots/authoritative-review-profile';
import {
  profileCanonicalDigest,
  validateAuthoritativeReviewProfile,
} from '../structured-slots/authoritative-review-profile';
import { createAuthoritativeReviewRuntimeEnvironment } from '../structured-slots/authoritative-review-capability';
import { isArtifactSystemProducerRef, TEMPLATE_ERROR_CODES } from './template-schema';
import { cacheTemplate, readCurrentHash } from './template-cache';
import { loadTemplateDirectory } from './template-loader';
import { TemplateCatalog } from './template-catalog';
import {
  STRUCTURED_VALID_FIXTURE,
  V1_PACKAGE_FIXTURE,
  projectV1TemplateCompatibility,
  readV1CompatibilitySnapshot,
  v1SealEvent,
} from './v1-compatibility-support';

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

describe('structured production mode (Task 5, spec §3.2/§15)', () => {
  it('loads the structured-valid fixture with an enabled runtime environment', async () => {
    const root = makeTempDir('forge-core-t2-structured-');
    const dest = copyFixture('structured-valid', 'structured', root);
    const frozen = await loadTemplateDirectory(dest, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
    });
    expect(frozen.productionMode).toBe('structured_slots');
    expect(frozen.structuredSlots?.version).toBe(1);
    expect(frozen.agents.map((agent) => agent.id)).toEqual(['structure', 'fill', 'seal', 'submitter']);
    expect(frozen.agents[0]?.turnContract?.version).toBe(3);
    expect(frozen.agents[0]?.slotCapabilities).toEqual([
      'read_structure_contract',
      'write_structure_proposal',
      'submit_structure_proposal',
    ]);
    expect(frozen.structuredPhases).toEqual({
      structure: ['no_scaffold'],
      fill: ['active_unsealed'],
      seal: ['active_unsealed'],
      submitter: ['sealed'],
    });
    expect(frozen.versionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives the same structured hash for identical content in different directories', async () => {
    const rootA = makeTempDir('forge-core-t2-structhash-a-');
    const rootB = makeTempDir('forge-core-t2-structhash-b-');
    const destA = copyFixture('structured-valid', 'structhash-a', rootA);
    const destB = copyFixture('structured-valid', 'structhash-b', rootB);
    const env = createTestRuntimeEnvironment();
    expect((await loadTemplateDirectory(destB, { runtimeEnvironment: env })).versionHash).toBe(
      (await loadTemplateDirectory(destA, { runtimeEnvironment: env })).versionHash,
    );
  });

  it('changes the structured hash when the slots contract changes', async () => {
    const rootA = makeTempDir('forge-core-t2-structcontract-a-');
    const rootB = makeTempDir('forge-core-t2-structcontract-b-');
    const destA = copyFixture('structured-valid', 'structcontract-a', rootA);
    const destB = copyFixture('structured-valid', 'structcontract-b', rootB);
    const contractFile = join(destB, 'slots/contract.yaml');
    writeFileSync(
      contractFile,
      readFileSync(contractFile, 'utf8').replace('maxSlots: 2500', 'maxSlots: 2400'),
      'utf8',
    );
    const env = createTestRuntimeEnvironment();
    expect((await loadTemplateDirectory(destB, { runtimeEnvironment: env })).versionHash).not.toBe(
      (await loadTemplateDirectory(destA, { runtimeEnvironment: env })).versionHash,
    );
  });

  it('rejects structured loading without an enabled runtime environment', async () => {
    const root = makeTempDir('forge-core-t2-structured-gated-');
    const dest = copyFixture('structured-valid', 'structured-gated', root);
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_RUNTIME_UNAVAILABLE',
    });
  });

  it('rejects an unknown productionMode value', async () => {
    const root = makeTempDir('forge-core-t2-mode-unknown-');
    const dest = withContracts(copyFixture('valid', 'mode-unknown', root));
    writeFileSync(
      join(dest, 'pipeline.yaml'),
      `${readFileSync(join(dest, 'pipeline.yaml'), 'utf8')}\nproductionMode: experimental\n`,
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'pipeline.yaml',
    });
  });

  it('rejects a basic template that contains slots/contract.yaml', async () => {
    const root = makeTempDir('forge-core-t2-basic-slots-');
    const dest = withContracts(copyFixture('valid', 'basic-slots', root));
    mkdirSync(join(dest, 'slots'), { recursive: true });
    writeFileSync(join(dest, 'slots/contract.yaml'), 'version: 1\n', 'utf8');
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'slots/contract.yaml',
    });
  });

  it('rejects a basic template with a v3 binding', async () => {
    const root = makeTempDir('forge-core-t2-basic-v3-');
    const dest = withContracts(copyFixture('valid', 'basic-v3', root));
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      `${readFixtureAgent(dest, 'writer').replace(/\nturnContract:[\s\S]*$/, '')}\nturnContract:\n  version: 3\n  slotSession:\n    kind: structure\n    accessProfile: null\n    capabilities: [read_structure_contract, write_structure_proposal, submit_structure_proposal]\n    completion: structure_commit_candidate_created\n  dispatch:\n    allowedActions: [send_message]\n    targets:\n      send_message: reviewer\n`,
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'pipeline.yaml',
    });
  });

  it('rejects an invalid structured route graph (seal as the first agent)', async () => {
    const root = makeTempDir('forge-core-t2-structured-badgraph-');
    const dest = copyFixture('structured-valid', 'structured-badgraph', root);
    const pipelineFile = join(dest, 'pipeline.yaml');
    writeFileSync(
      pipelineFile,
      readFileSync(pipelineFile, 'utf8').replace(
        '  - structure\n  - fill\n  - seal\n  - submitter',
        '  - seal\n  - structure\n  - fill\n  - submitter',
      ),
      'utf8',
    );
    await expect(
      loadTemplateDirectory(dest, { runtimeEnvironment: createTestRuntimeEnvironment() }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_INVALID', location: 'pipeline.yaml' });
  });
});

describe('structured slot v1 compatibility fence (plan 2026-08-14 Task 1)', () => {
  it('keeps historical v1 template and event semantics byte stable', async () => {
    const env = createTestRuntimeEnvironment();
    const snapshot = readV1CompatibilitySnapshot();
    // The ARCHIVED production v1 package must keep loading byte-identically:
    // frozen hash, Route list, v3 session union and Contract v1 top-level
    // keys never drift once Task 1 lands. Later tasks migrate the production
    // source to v2; this archived fixture is the machine-checked v1 boundary
    // and stays untouched.
    const archived = await loadTemplateDirectory(V1_PACKAGE_FIXTURE, { runtimeEnvironment: env });
    expect(projectV1TemplateCompatibility(archived)).toEqual({
      versionHash: snapshot.zhihuV1VersionHash,
      routes: snapshot.zhihuV1Routes,
      v3SessionKinds: snapshot.v3SessionUnion,
      contractTopLevelKeys: snapshot.contractV1TopLevelKeys,
    });
    // The current structured fixture's compiled semantic digest is frozen too
    // (the v2 compiler gets a separate digest branch; the v1 digest never
    // changes).
    const structuredValid = await loadTemplateDirectory(STRUCTURED_VALID_FIXTURE, {
      runtimeEnvironment: env,
    });
    expect(structuredValid.structuredSlots?.semanticDigest).toBe(
      snapshot.structuredValidSemanticDigest,
    );
    // The v1 Seal event bytes stay accepted unchanged by the canonical event
    // validator (task-events retains every v1 member exactly).
    expect(validateTaskEvent(v1SealEvent)).toEqual(v1SealEvent);
  });
});

describe('authoritative (v2) template loading (Task 5)', () => {
  const V2_FIXTURE = 'authoritative-valid';
  const V1_STRUCTURED_HASH_PIN = 'c38455b92b3c3529b020fc6195a17d1321918a46bc5ca0ba95a12397c7aac60b';

  function makeTempCorePathsWith(): { paths: CorePaths; templateRoot: string } {
    const root = makeTempDir('forge-core-v2catalog-');
    const templateRoot = join(root, 'templates');
    return {
      paths: CorePaths.create({ dataRoot: join(root, 'data'), templateRoot }),
      templateRoot,
    };
  }

  async function loadV2(templateRoot: string, env?: ReturnType<typeof createAuthoritativeReviewTestEnvironment>) {
    const root = makeTempDir('forge-core-v2load-');
    copyFixture(V2_FIXTURE, 'authoritative-valid', root);
    return loadTemplateDirectory(join(root, 'authoritative-valid'), {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: env ?? createAuthoritativeReviewTestEnvironment(),
    });
  }

  it('loads the full v2 fixture with the test environment (first valid v2 FrozenTemplate)', async () => {
    const frozen = await loadV2(makeTempDir('forge-core-v2-'));
    expect(frozen.productionMode).toBe('structured_slots');
    expect(frozen.structuredSlots?.version).toBe(2);
    expect(frozen.structuredReviewLifecycle).toEqual({
      protocol: 'authoritative_review_v1',
      roleBindings: { orchestrator: 'structure', generator: 'fill', reviewer: 'review', submitter: 'submitter' },
      systemArtifactProducer: 'system:structured_seal',
    });
    expect(frozen.authoritativeReviewProfile?.profileIdentity).toBe('forge-authoritative-review/v1');
    expect(frozen.authoritativeReviewProfile?.profileDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.authoritativeReviewProfile?.profileSnapshotRef?.kind).toBe('profile_snapshot');
    // profileDigest and snapshot-ref digest are distinct identities
    expect(frozen.authoritativeReviewProfile?.profileDigest).not.toBe(
      frozen.authoritativeReviewProfile?.profileSnapshotRef?.digest,
    );
    // the explicit system producer is frozen as a discriminated ref
    expect(frozen.artifactSchema.files[0].producer).toEqual({ kind: 'system', systemId: 'structured_seal' });
    // the reviewer is NOT the orchestrator/generator and has no write session kind
    const review = frozen.agents.find((agent) => agent.id === 'review');
    expect(review?.turnContract?.version).toBe(4);
    if (review?.turnContract?.version === 4) {
      expect(review.turnContract.authoritativeReview.allowedSessionKinds).not.toContain('structure_chunk');
      expect(review.turnContract.authoritativeReview.allowedSessionKinds).not.toContain('generation_batch');
    }
  });

  it('keeps the v1 structured version hash byte-identical (no new defaults)', async () => {
    const root = makeTempDir('forge-core-v1pin-');
    copyFixture('structured-valid', 'pin', root);
    const frozen = await loadTemplateDirectory(join(root, 'pin'), {
      runtimeEnvironment: createTestRuntimeEnvironment(),
    });
    expect(frozen.versionHash).toBe(V1_STRUCTURED_HASH_PIN);
  });

  it('refuses a v2 source while the authoritative capability is disabled (production env)', async () => {
    const root = makeTempDir('forge-core-v2disabled-');
    copyFixture(V2_FIXTURE, 'authoritative-valid', root);
    await expect(
      loadTemplateDirectory(join(root, 'authoritative-valid'), {
        runtimeEnvironment: createTestRuntimeEnvironment(),
        authoritativeReviewEnvironment: createProductionAuthoritativeReviewEnvironment(),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_RUNTIME_UNAVAILABLE' });
  });

  it('refuses a v2 source without an authoritative environment (fail closed)', async () => {
    const root = makeTempDir('forge-core-v2noenv-');
    copyFixture(V2_FIXTURE, 'authoritative-valid', root);
    await expect(
      loadTemplateDirectory(join(root, 'authoritative-valid'), {
        runtimeEnvironment: createTestRuntimeEnvironment(),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_RUNTIME_UNAVAILABLE' });
  });

  it('hashes deterministically across copies and changes when the contract changes', async () => {
    const env = createAuthoritativeReviewTestEnvironment();
    const rootA = makeTempDir('forge-core-v2hasha-');
    const rootB = makeTempDir('forge-core-v2hashb-');
    copyFixture(V2_FIXTURE, 'authoritative-valid', rootA);
    copyFixture(V2_FIXTURE, 'authoritative-valid', rootB);
    const options = { runtimeEnvironment: createTestRuntimeEnvironment(), authoritativeReviewEnvironment: env };
    const hashA = (await loadTemplateDirectory(join(rootA, 'authoritative-valid'), options)).versionHash;
    expect((await loadTemplateDirectory(join(rootB, 'authoritative-valid'), options)).versionHash).toBe(hashA);
    // contract change re-versions the template
    const contractFile = join(rootB, 'authoritative-valid', 'slots', 'contract.yaml');
    writeFileSync(
      contractFile,
      readFileSync(contractFile, 'utf8').replace('maxRounds: 8', 'maxRounds: 12'),
      'utf8',
    );
    expect((await loadTemplateDirectory(join(rootB, 'authoritative-valid'), options)).versionHash).not.toBe(hashA);
  });

  it('changes the hash when the profile changes (same identity, different bytes)', async () => {
    const envA = createAuthoritativeReviewTestEnvironment();
    const profile = envA.profile as AuthoritativeReviewProfileSnapshotV1Body;
    const revised = { ...profile, profileVersion: profile.profileVersion + 1 };
    const revisedComplete = validateAuthoritativeReviewProfile({
      ...revised,
      profileDigest: profileCanonicalDigest(revised),
    });
    const envB = createAuthoritativeReviewRuntimeEnvironment(
      {
        version: 1,
        status: 'enabled',
        profileIdentity: 'forge-authoritative-review/v1',
        profileDigest: profileCanonicalDigest(revisedComplete),
        evidenceDigest: '0'.repeat(64),
        requiredAbis: ['forge-validator/v2', 'forge-assembler/v2'],
      },
      revisedComplete,
      envA.handlerRegistry,
    );
    expect(envB.profileSnapshotRef?.digest).not.toBe(envA.profileSnapshotRef?.digest);
    const rootA = makeTempDir('forge-core-v2profa-');
    copyFixture(V2_FIXTURE, 'authoritative-valid', rootA);
    const hashA = (
      await loadTemplateDirectory(join(rootA, 'authoritative-valid'), {
        runtimeEnvironment: createTestRuntimeEnvironment(),
        authoritativeReviewEnvironment: envA,
      })
    ).versionHash;
    const hashB = (
      await loadTemplateDirectory(join(rootA, 'authoritative-valid'), {
        runtimeEnvironment: createTestRuntimeEnvironment(),
        authoritativeReviewEnvironment: envB,
      })
    ).versionHash;
    expect(hashB).not.toBe(hashA);
  });

  it('artifacts: scalar v1 producers stay strings; the system mapping is the frozen v2 ref', async () => {
    const f = isArtifactSystemProducerRef;
    expect(f({ kind: 'system', systemId: 'structured_seal' })).toBe(true);
    expect(f('seal')).toBe(false);
    expect(f({ kind: 'agent', agentId: 'seal' })).toBe(false);
    // v1 scalar producers are untouched strings
    const root = makeTempDir('forge-core-v2prod-');
    copyFixture('structured-valid', 'prod', root);
    const v1 = await loadTemplateDirectory(join(root, 'prod'), { runtimeEnvironment: createTestRuntimeEnvironment() });
    expect(v1.artifactSchema.files[0].producer).toBe('seal');
    // v2 with a scalar (non-system) producer fails the system-producer rule
    const root2 = makeTempDir('forge-core-v2prod2-');
    copyFixture(V2_FIXTURE, 'authoritative-valid', root2);
    const pipeline = join(root2, 'authoritative-valid', 'pipeline.yaml');
    writeFileSync(
      pipeline,
      readFileSync(pipeline, 'utf8')
        .replace('producer:\n        system: structured_seal', 'producer: fill'),
      'utf8',
    );
    await expect(
      loadTemplateDirectory(join(root2, 'authoritative-valid'), {
        runtimeEnvironment: createTestRuntimeEnvironment(),
        authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });

  it('rejects the system producer mapping on a v1/basic template', async () => {
    const root = makeTempDir('forge-core-v2prodv1-');
    copyFixture('structured-valid', 'prodv1', root);
    const pipeline = join(root, 'prodv1', 'pipeline.yaml');
    writeFileSync(
      pipeline,
      readFileSync(pipeline, 'utf8').replace('producer: seal', 'producer:\n        system: structured_seal'),
      'utf8',
    );
    await expect(
      loadTemplateDirectory(join(root, 'prodv1'), { runtimeEnvironment: createTestRuntimeEnvironment() }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });

  it('rejects a colon-bearing producer scalar (the safe Agent-ID regex never relaxes)', async () => {
    const root = makeTempDir('forge-core-v2prodcolon-');
    copyFixture('structured-valid', 'prodcolon', root);
    const pipeline = join(root, 'prodcolon', 'pipeline.yaml');
    writeFileSync(
      pipeline,
      readFileSync(pipeline, 'utf8').replace('producer: seal', 'producer: system:structured_seal'),
      'utf8',
    );
    await expect(
      loadTemplateDirectory(join(root, 'prodcolon'), { runtimeEnvironment: createTestRuntimeEnvironment() }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });

  it('rejects the v2 lifecycle block on a contract-v1 template and on a basic template', async () => {
    const env = createAuthoritativeReviewTestEnvironment();
    // contract v1 + lifecycle block
    const root = makeTempDir('forge-core-v2lcv1-');
    copyFixture('structured-valid', 'lcv1', root);
    const pipeline = join(root, 'lcv1', 'pipeline.yaml');
    const lifecycleYaml = [
      '',
      'structuredReviewLifecycle:',
      '  protocol: authoritative_review_v1',
      '  roleBindings:',
      '    orchestrator: structure',
      '    generator: fill',
      '    reviewer: review',
      '    submitter: submitter',
      '  systemArtifactProducer: system:structured_seal',
    ].join('\n');
    writeFileSync(pipeline, `${readFileSync(pipeline, 'utf8').trimEnd()}${lifecycleYaml}`, 'utf8');
    await expect(
      loadTemplateDirectory(join(root, 'lcv1'), {
        runtimeEnvironment: createTestRuntimeEnvironment(),
        authoritativeReviewEnvironment: env,
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    // basic template + lifecycle block (block only belongs to structured mode)
    const rootBasic = makeTempDir('forge-core-v2lcbasic-');
    copyFixture('valid', 'lcbasic', rootBasic);
    const basicPipeline = join(rootBasic, 'lcbasic', 'pipeline.yaml');
    writeFileSync(
      basicPipeline,
      `${readFileSync(basicPipeline, 'utf8').trimEnd()}${lifecycleYaml}`,
      'utf8',
    );
    await expect(loadTemplateDirectory(join(rootBasic, 'lcbasic'))).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
    });
  });

  it('rejects contract implementations that are not installed in the registry', async () => {
    const root = makeTempDir('forge-core-v2reg-');
    copyFixture(V2_FIXTURE, 'authoritative-valid', root);
    const contractFile = join(root, 'authoritative-valid', 'slots', 'contract.yaml');
    writeFileSync(
      contractFile,
      readFileSync(contractFile, 'utf8').replace(
        'handlerKey: authoritative.review.completeness',
        'handlerKey: ghost.handler',
      ),
      'utf8',
    );
    await expect(
      loadTemplateDirectory(join(root, 'authoritative-valid'), {
        runtimeEnvironment: createTestRuntimeEnvironment(),
        authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });

  it('rejects template limits above the profile ceiling', async () => {
    const root = makeTempDir('forge-core-v2ceiling-');
    copyFixture(V2_FIXTURE, 'authoritative-valid', root);
    const contractFile = join(root, 'authoritative-valid', 'slots', 'contract.yaml');
    writeFileSync(
      contractFile,
      readFileSync(contractFile, 'utf8').replace('maxSlots: 2500', 'maxSlots: 20000'),
      'utf8',
    );
    await expect(
      loadTemplateDirectory(join(root, 'authoritative-valid'), {
        runtimeEnvironment: createTestRuntimeEnvironment(),
        authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });

  it('the catalog stays on the prior valid cache while the v2 capability is disabled', async () => {
    const { paths, templateRoot } = makeTempCorePathsWith();
    copyFixture(V2_FIXTURE, 'authoritative-valid', templateRoot);
    const enabledEnv = createAuthoritativeReviewTestEnvironment();
    const enabledCatalog = new TemplateCatalog(paths, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: enabledEnv,
    });
    await enabledCatalog.initialize();
    const detail = enabledCatalog.get('authoritative-valid');
    expect(detail?.status).toBe('valid');
    const cachedHash = await readCurrentHash(paths, 'authoritative-valid');
    expect(cachedHash?.length).toBe(64);
    // the catalog version is the 12-char display prefix of the full hash
    expect(detail?.version).toBe(cachedHash?.slice(0, 12));
    // Disabled production env: source load gates, prior cache pointer survives.
    const disabledCatalog = new TemplateCatalog(paths, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: createProductionAuthoritativeReviewEnvironment(),
    });
    await disabledCatalog.initialize();
    expect(disabledCatalog.get('authoritative-valid')).toBeUndefined();
    expect(disabledCatalog.getDiagnostic('authoritative-valid')?.code).toBe(
      TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE,
    );
    expect(await readCurrentHash(paths, 'authoritative-valid')).toBe(cachedHash);
    // Re-enabled: the exact same source revalidates with the identical hash.
    const reEnabled = new TemplateCatalog(paths, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: enabledEnv,
    });
    await reEnabled.initialize();
    expect(reEnabled.get('authoritative-valid')?.version).toBe(cachedHash?.slice(0, 12));
  });

  it('cacheTemplate stores a v2 template with the unified environment seam', async () => {
    const { paths, templateRoot } = makeTempCorePathsWith();
    copyFixture(V2_FIXTURE, 'authoritative-valid', templateRoot);
    const env = createAuthoritativeReviewTestEnvironment();
    const frozen = await loadTemplateDirectory(join(templateRoot, 'authoritative-valid'), {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: env,
    });
    const cached = await cacheTemplate(paths, frozen, createTestRuntimeEnvironment(), env);
    expect(cached.frozen.versionHash).toBe(frozen.versionHash);
  });
});

