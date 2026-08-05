// @vitest-environment node
/**
 * `systemPromptFile` template-loader extension (plan Phase D Task 1 deviation).
 *
 * Phase B froze `agents/<id>.yaml` with an inline `systemPrompt` scalar. The
 * Phase D Zhihu template keeps long Agent prompts as separate `prompts/*.md`
 * files, so this is the minimal, backwards-compatible extension that lets an
 * Agent declare exactly one of `systemPrompt` (inline) or `systemPromptFile`
 * (a template-relative path). The loader resolves the file content into the
 * frozen `systemPrompt`, confined to the template directory with the same
 * realpath containment used for Skills. The resolved content participates in
 * the deterministic version hash; the provenance (inline vs file) does not.
 *
 * No business vocabulary here (iron rule 1): the tests mutate the neutral
 * Phase B `valid` fixture.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CorePaths } from '../storage/core-paths';
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

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Version-1 turn contract blocks; the committed fixtures stay legacy. */
const WRITER_CONTRACT_LINES = [
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
];

const REVIEWER_CONTRACT_LINES = [
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
];

/** Appends the current turn contracts to both legacy fixture agents. */
function appendContracts(dest: string): void {
  const writerFile = join(dest, 'agents/writer.yaml');
  const reviewerFile = join(dest, 'agents/reviewer.yaml');
  writeFileSync(
    writerFile,
    `${readFileSync(writerFile, 'utf8').replace(/\r\n?/g, '\n').trimEnd()}\n${WRITER_CONTRACT_LINES.join('\n')}\n`,
    'utf8',
  );
  writeFileSync(
    reviewerFile,
    `${readFileSync(reviewerFile, 'utf8').replace(/\r\n?/g, '\n').trimEnd()}\n${REVIEWER_CONTRACT_LINES.join('\n')}\n`,
    'utf8',
  );
}

/** Copies the neutral `valid` fixture and returns its destination. */
function copyValid(templateId: string): string {
  const root = makeTempDir('forge-core-promptfile-');
  const dest = join(root, templateId);
  cpSync(fixturePath('valid'), dest, { recursive: true });
  appendContracts(dest);
  return dest;
}

/** Rewrites writer to reference a prompt file and creates that file. */
function useWriterPromptFile(dest: string, promptBody: string, rel = 'prompts/writer.md'): void {
  mkdirSync(join(dest, 'prompts'), { recursive: true });
  writeFileSync(join(dest, rel), promptBody, 'utf8');
  writeFileSync(
    join(dest, 'agents/writer.yaml'),
    [
      'id: writer',
      'name: 初稿 Agent',
      'description: 依据输入素材生成初稿。',
      'model: deepseek/deepseek-chat',
      `systemPromptFile: ${rel}`,
      'skills:',
      '  - id: style-guide',
      '    name: 文风指南',
      '    description: 语气与节奏参考。',
      '    contentPath: skills/style-guide/SKILL.md',
      ...WRITER_CONTRACT_LINES,
      '',
    ].join('\n'),
    'utf8',
  );
}

describe('loadTemplateDirectory systemPromptFile extension', () => {
  it('keeps loading inline systemPrompt unchanged (backwards compatible)', async () => {
    const dest = copyValid('inline');
    const frozen = await loadTemplateDirectory(dest);
    const writer = frozen.agents.find((agent) => agent.id === 'writer');
    expect(writer?.systemPrompt).toContain('你是初稿 Agent');
  });

  it('resolves systemPromptFile into the frozen systemPrompt', async () => {
    const dest = copyValid('filebased');
    useWriterPromptFile(dest, '你是章节写作 Agent。\n仅输出正文。\n');
    const frozen = await loadTemplateDirectory(dest);
    const writer = frozen.agents.find((agent) => agent.id === 'writer');
    expect(writer?.systemPrompt).toBe('你是章节写作 Agent。\n仅输出正文。\n');
  });

  it('includes resolved prompt content in the version hash', async () => {
    const dest = copyValid('hashchange');
    useWriterPromptFile(dest, '版本一。\n');
    const before = await loadTemplateDirectory(dest);
    useWriterPromptFile(dest, '版本二。\n');
    const after = await loadTemplateDirectory(dest);
    expect(after.versionHash).not.toBe(before.versionHash);
  });

  it('hashes identical content the same whether inline or file-referenced', async () => {
    const shared = '完全一致的提示内容。\n';
    const inlineDest = copyValid('inline-eq');
    writeFileSync(
      join(inlineDest, 'agents/writer.yaml'),
      [
        'id: writer',
        'name: 初稿 Agent',
        'description: 依据输入素材生成初稿。',
        'model: deepseek/deepseek-chat',
        'systemPrompt: |',
        `  ${shared.trimEnd()}`,
        'skills:',
        '  - id: style-guide',
        '    name: 文风指南',
        '    description: 语气与节奏参考。',
        '    contentPath: skills/style-guide/SKILL.md',
        ...WRITER_CONTRACT_LINES,
        '',
      ].join('\n'),
      'utf8',
    );
    const fileDest = copyValid('file-eq');
    useWriterPromptFile(fileDest, shared);
    const inlineFrozen = await loadTemplateDirectory(inlineDest);
    const fileFrozen = await loadTemplateDirectory(fileDest);
    expect(fileFrozen.agents.find((a) => a.id === 'writer')?.systemPrompt).toBe(
      inlineFrozen.agents.find((a) => a.id === 'writer')?.systemPrompt,
    );
    expect(fileFrozen.versionHash).toBe(inlineFrozen.versionHash);
  });

  it('rejects an agent declaring both systemPrompt and systemPromptFile', async () => {
    const dest = copyValid('both');
    useWriterPromptFile(dest, '文件内容。\n');
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      [
        'id: writer',
        'name: 初稿 Agent',
        'description: 依据输入素材生成初稿。',
        'model: deepseek/deepseek-chat',
        'systemPrompt: 内联内容',
        'systemPromptFile: prompts/writer.md',
        'skills:',
        '  - id: style-guide',
        '    name: 文风指南',
        '    description: 语气与节奏参考。',
        '    contentPath: skills/style-guide/SKILL.md',
        ...WRITER_CONTRACT_LINES,
        '',
      ].join('\n'),
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects an agent declaring neither systemPrompt nor systemPromptFile', async () => {
    const dest = copyValid('neither');
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      [
        'id: writer',
        'name: 初稿 Agent',
        'description: 依据输入素材生成初稿。',
        'model: deepseek/deepseek-chat',
        'skills:',
        '  - id: style-guide',
        '    name: 文风指南',
        '    description: 语气与节奏参考。',
        '    contentPath: skills/style-guide/SKILL.md',
        ...WRITER_CONTRACT_LINES,
        '',
      ].join('\n'),
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'agents/writer.yaml',
    });
  });

  it('rejects a systemPromptFile pointing outside the template directory', async () => {
    const dest = copyValid('escape');
    mkdirSync(join(dest, 'prompts'), { recursive: true });
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      [
        'id: writer',
        'name: 初稿 Agent',
        'description: 依据输入素材生成初稿。',
        'model: deepseek/deepseek-chat',
        'systemPromptFile: ../outside.md',
        'skills:',
        '  - id: style-guide',
        '    name: 文风指南',
        '    description: 语气与节奏参考。',
        '    contentPath: skills/style-guide/SKILL.md',
        ...WRITER_CONTRACT_LINES,
        '',
      ].join('\n'),
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
    });
  });

  it('rejects a missing systemPromptFile', async () => {
    const dest = copyValid('missing');
    writeFileSync(
      join(dest, 'agents/writer.yaml'),
      [
        'id: writer',
        'name: 初稿 Agent',
        'description: 依据输入素材生成初稿。',
        'model: deepseek/deepseek-chat',
        'systemPromptFile: prompts/absent.md',
        'skills:',
        '  - id: style-guide',
        '    name: 文风指南',
        '    description: 语气与节奏参考。',
        '    contentPath: skills/style-guide/SKILL.md',
        ...WRITER_CONTRACT_LINES,
        '',
      ].join('\n'),
      'utf8',
    );
    await expect(loadTemplateDirectory(dest)).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
    });
  });

  it('survives the template cache copy (prompts/ is copied and revalidated)', async () => {
    const dataRoot = makeTempDir('forge-core-promptfile-cache-data-');
    const templateRoot = makeTempDir('forge-core-promptfile-cache-templates-');
    const dest = join(templateRoot, 'prompt-file-template');
    cpSync(fixturePath('valid'), dest, { recursive: true });
    appendContracts(dest);
    useWriterPromptFile(dest, '缓存复核用的提示内容。\n');
    const catalog = new TemplateCatalog(CorePaths.create({ dataRoot, templateRoot }));
    await catalog.initialize();
    const detail = catalog.get('prompt-file-template');
    expect(detail?.status).toBe('valid');
    const frozen = catalog.getFrozen('prompt-file-template');
    expect(frozen?.agents.find((agent) => agent.id === 'writer')?.systemPrompt).toBe(
      '缓存复核用的提示内容。\n',
    );
  });
});
