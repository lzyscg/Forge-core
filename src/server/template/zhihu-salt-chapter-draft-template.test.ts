// @vitest-environment node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplateDirectory } from './template-loader';
import { createTestRuntimeEnvironment } from '../structured-slots/runtime-capability';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const templateRoot = join(repoRoot, 'templates', 'zhihu-salt-chapter-draft');

function node(slotId: string, typeId: string, order: number, content?: string) {
  return {
    slotId,
    parentSlotId: slotId === 'root' ? null : 'root',
    order,
    typeId,
    spec: {},
    contentPresence: content === undefined ? 'unset' : 'set',
    ...(content === undefined ? {} : { content }),
  };
}

describe('zhihu-salt-chapter-draft template package', () => {
  it('loads as a structured template with the local skill projection', async () => {
    const frozen = await loadTemplateDirectory(templateRoot, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
    });

    expect(frozen.id).toBe('zhihu-salt-chapter-draft');
    expect(frozen.structuredSlots?.version).toBe(1);
    expect(frozen.structuredPhases).toEqual({
      structure: ['no_scaffold'],
      fill: ['active_unsealed'],
      seal: ['active_unsealed'],
      submitter: ['sealed'],
    });
    expect(frozen.routes).toEqual([
      { from: 'structure', to: 'fill', kind: 'message', label: '槽树已建立，开始填充' },
      { from: 'fill', to: 'seal', kind: 'message', label: '草稿已提交，开始校验' },
      { from: 'seal', to: 'fill', kind: 'message', label: '校验发现问题，定向返工' },
      { from: 'seal', to: 'submitter', kind: 'artifact', label: '校验通过，交付 Markdown' },
    ]);
    expect(frozen.agents.find((agent) => agent.id === 'fill')?.skills[0]?.sections).toHaveLength(8);
    expect(frozen.artifactSchema?.files[0]).toMatchObject({
      name: 'chapter.md',
      producer: 'seal',
      extract: 'content',
    });
    expect(frozen.agents.every((agent) => agent.model === 'opencode/claude-haiku-4-5')).toBe(true);
  });

  it('validates the chapter tree and assembles ordered Markdown', () => {
    const validator = require(join(templateRoot, 'slots/validators/validate.cjs')) as {
      validate: (input: unknown) => { pass: boolean; issues: unknown[] };
    };
    const assembler = require(join(templateRoot, 'slots/assembler/render.cjs')) as {
      assemble: (input: unknown) => Array<{ routeId: string; content: string }>;
    };
    const tree = [
      node('root', 'chapter', 0),
      node('title', 'title', 1, '雨夜的缴费单'),
      node('opening', 'opening', 2, '林晚在缴费窗口停住了手。'),
      node('scene-1', 'scene_block', 3, '她查出那笔已经结清的费用来自一个陌生账户。'),
      node('closure', 'emotional_closure', 4, '她第一次怀疑母亲隐瞒的不是债务。'),
      node('end', 'chapter_end', 5, '雨幕里，陌生号码发来一张旧仓库的照片。'),
    ];

    expect(validator.validate({ tree })).toEqual({ pass: true, issues: [] });
    const output = assembler.assemble({ tree });
    expect(output[0]?.routeId).toBe('chapter-md');
    expect(output[0]?.content).toBe(
      '# 雨夜的缴费单\n\n林晚在缴费窗口停住了手。\n\n她查出那笔已经结清的费用来自一个陌生账户。\n\n她第一次怀疑母亲隐瞒的不是债务。\n\n雨幕里，陌生号码发来一张旧仓库的照片。\n',
    );

    const missing = tree.map((entry) => ({ ...entry }));
    missing[4] = { ...missing[4], contentPresence: 'unset', content: undefined };
    expect(validator.validate({ tree: missing }).pass).toBe(false);
    expect(assembler.assemble({ tree: missing })[0]?.content).toContain('雨夜的缴费单');
  });

  it('keeps the copied production skill and all eight progressive sections local', () => {
    const skill = readFileSync(join(templateRoot, 'skills/chapter-drafting/SKILL.md'), 'utf8');
    expect(skill).toContain('references/01-focus-contract.md');
    for (const file of [
      '01-focus-contract.md',
      '02-change-skeleton.md',
      '03-prose-render.md',
      '04-causality-pass.md',
      '05-character-emotion-pass.md',
      '06-information-continuity-pass.md',
      '07-compression-pass.md',
      '08-targeted-repair.md',
    ]) {
      expect(readFileSync(join(templateRoot, 'skills/chapter-drafting/references', file), 'utf8').length).toBeGreaterThan(100);
    }
  });

  it('freezes a one-dispatch completion protocol for every production agent', () => {
    const structure = readFileSync(join(templateRoot, 'prompts/structure-system.md'), 'utf8');
    const fill = readFileSync(join(templateRoot, 'prompts/fill-system.md'), 'utf8');
    const seal = readFileSync(join(templateRoot, 'prompts/seal-system.md'), 'utf8');
    const submitter = readFileSync(join(templateRoot, 'prompts/submitter-system.md'), 'utf8');

    expect(structure).toContain('整个回合只能有一个 dispatch 动作');
    expect(structure).toContain('submit_structure_proposal');
    expect(structure).toContain('send_message');
    expect(structure).toContain('不要调用 finish_production');
    expect(structure).toContain('不要调用 load_skill');
    expect(structure).toContain('优先只建立一个 scene_block');
    expect(fill).toContain('整个回合只能有一个 dispatch 动作');
    expect(fill).toContain('submit_draft');
    expect(fill).toContain('不要调用 finish_production');
    expect(fill).toContain('不要调用 load_skill');
    expect(seal).toContain('整个回合只能有一个 dispatch 动作');
    expect(seal).toContain('request_seal');
    expect(seal).toContain('publish_artifact');
    expect(seal).toContain('不要调用 send_message');
    expect(seal).toContain('不要调用 load_skill');
    expect(submitter).toContain('整个回合只能有一个 dispatch 动作');
    expect(submitter).toContain('submit_final_artifact');
    expect(submitter).toContain('不要调用 send_message');
    expect(submitter).toContain('只调用一次 submit_final_artifact');
  });
});
