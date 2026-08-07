// @vitest-environment node
/**
 * Forge tool factory tests for the v7 production/operate turn contract (plan
 * 2026-08-07 Phase 2, spec §5.1/§5.2/§5.3).
 *
 * The tool layer is the model-facing boundary: parameter schemas mirror the
 * frozen action shapes exactly, and the phase-aware ActionBuffer returns
 * stable, CORRECTABLE rejections for illegal phase transitions so the model
 * can self-correct within the same Turn (the ActionCommitter revalidates the
 * final set as the non-bypassable boundary). v7 dispatch tools carry no
 * `productionPackageRef` — publish/submit take no parameters, send_message
 * carries a short summary. Neutral identities only (iron rule 1); fixture
 * agent ids appear exclusively in test data.
 */
import { describe, expect, it } from 'vitest';
import { RuntimeFailure } from './agent-runtime';
import { ActionBuffer, ACTION_BUFFER_ERROR_CODES } from './action-buffer';
import { FORGE_ACTION_NAMES } from './forge-actions';
import {
  createForgeToolDefinitions,
  createSkillSectionToolDefinitions,
  SKILL_SECTION_TOOL_NAMES,
} from './pi-tool-factory';
import { finishProductionProposal, sendMessageProposal } from './test-support';

async function execute(
  tools: ReturnType<typeof createForgeToolDefinitions>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; accepted: boolean; code?: string }> {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool, `tool ${name} must exist`).toBeDefined();
  const result = await tool?.execute('tc', args, undefined, undefined, {} as never);
  const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
  const details = (result as { details?: { accepted: boolean; code?: string } })?.details;
  return { text, accepted: details?.accepted ?? false, code: details?.code };
}

function toolsFor(buffer = new ActionBuffer('turn-gate')): {
  buffer: ActionBuffer;
  tools: ReturnType<typeof createForgeToolDefinitions>;
} {
  return { buffer, tools: createForgeToolDefinitions(buffer) };
}

async function sealInline(tools: ReturnType<typeof createForgeToolDefinitions>): Promise<void> {
  const sealed = await execute(tools, 'finish_production', {
    source: 'inline',
    files: [{ name: 'content.md', content: 'sealed body' }],
    format: 'text',
  });
  expect(sealed.accepted).toBe(true);
}

describe('pi-tool-factory action shapes (plan 2026-08-07 Phase 2)', () => {
  it('exposes exactly the nine closed registry tools', () => {
    const { tools } = toolsFor();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...FORGE_ACTION_NAMES].sort());
  });

  it('accepts finish_production inline with a files array through the buffer', async () => {
    const { buffer, tools } = toolsFor();
    const inline = await execute(tools, 'finish_production', {
      source: 'inline',
      files: [{ name: 'content.md', content: 'review text' }],
      format: 'text',
    });
    expect(inline.accepted).toBe(true);
    expect(buffer.snapshot()).toEqual([
      finishProductionProposal({ files: [{ name: 'content.md', content: 'review text' }], format: 'text' }),
    ]);
  });

  it('accepts the workspace_file source with a relative reference', async () => {
    const { buffer, tools } = toolsFor();
    const workspace = await execute(tools, 'finish_production', {
      source: 'workspace_file',
      files: [{ name: 'chapter.md', workspaceFile: 'draft/chapter.md' }],
      format: 'markdown',
      artifactType: 'chapter_markdown',
      title: '第一章',
    });
    expect(workspace.accepted).toBe(true);
    expect(buffer.snapshot()).toEqual([
      {
        type: 'finish_production',
        source: 'workspace_file',
        files: [{ name: 'chapter.md', workspaceFile: 'draft/chapter.md' }],
        format: 'markdown',
        artifactType: 'chapter_markdown',
        title: '第一章',
      },
    ]);
  });

  it('rejects the removed current_input_artifact source', async () => {
    const { tools } = toolsFor();
    const rejected = await execute(tools, 'finish_production', {
      source: 'current_input_artifact',
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.code).toBe('ACTION_FIELD_INVALID');
  });

  it('accepts annotate_artifact and forward_input_version with their v7 fields', async () => {
    const { buffer, tools } = toolsFor();
    const annotate = await execute(tools, 'annotate_artifact', {
      file: 'review.md',
      content: '---\nverdict: pass\n---\n意见',
    });
    expect(annotate.accepted).toBe(true);
    const forward = await execute(tools, 'forward_input_version', {
      targetAgentId: 'agent-beta',
    });
    expect(forward.accepted).toBe(true);
    expect(buffer.snapshot()).toEqual([
      { type: 'annotate_artifact', file: 'review.md', content: '---\nverdict: pass\n---\n意见' },
      { type: 'forward_input_version', targetAgentId: 'agent-beta' },
    ]);
  });

  it('rejects annotate_artifact content whose frontmatter lacks a valid verdict', async () => {
    const { buffer, tools } = toolsFor();
    // Missing frontmatter, and a frontmatter with an unknown verdict: both are
    // rejected with a stable, model-correctable code (semantic audit P1, plan
    // 2026-08-07) — nothing is buffered.
    for (const content of ['今天感觉还行，建议改一下。', '---\nverdict: maybe\n---\n意见']) {
      const result = await execute(tools, 'annotate_artifact', { file: 'review.md', content });
      expect(result.accepted).toBe(false);
      expect(result.code).toBe('ANNOTATE_FRONTMATTER_INVALID');
    }
    expect(buffer.snapshot()).toEqual([]);
  });

  it('rejects dispatch tools that still carry productionPackageRef', async () => {
    const { tools } = toolsFor();
    for (const name of ['publish_artifact', 'submit_final_artifact']) {
      const wrong = await execute(tools, name, { productionPackageRef: 'current' });
      expect(wrong.accepted, name).toBe(false);
      expect(wrong.code, name).toBe('ACTION_UNKNOWN_KEY');
    }
    const wrongSend = await execute(tools, 'send_message', {
      targetAgentId: 'agent-beta',
      summary: 's',
      productionPackageRef: 'current',
    });
    expect(wrongSend.accepted).toBe(false);
    expect(wrongSend.code).toBe('ACTION_UNKNOWN_KEY');
  });

  it('rejects dispatch shapes that still carry legacy content or metadata', async () => {
    const { tools } = toolsFor();
    const legacyPublish = await execute(tools, 'publish_artifact', {
      content: 'duplicate body',
    });
    expect(legacyPublish.accepted).toBe(false);
    expect(legacyPublish.code).toBe('ACTION_UNKNOWN_KEY');

    const legacySubmit = await execute(tools, 'submit_final_artifact', {
      artifactRef: 'turn:artifact:1',
    });
    expect(legacySubmit.accepted).toBe(false);
    expect(legacySubmit.code).toBe('ACTION_UNKNOWN_KEY');

    const legacyMessage = await execute(tools, 'send_message', {
      targetAgentId: 'agent-beta',
      message: 'duplicate body',
    });
    expect(legacyMessage.accepted).toBe(false);
    expect(legacyMessage.code).toBe('ACTION_UNKNOWN_KEY');
  });

  it('declares parameter schemas matching the frozen action field names', () => {
    const { tools } = toolsFor();
    const schemaOf = (name: string) =>
      tools.find((tool) => tool.name === name)?.parameters as {
        properties?: Record<string, unknown>;
        required?: string[];
        anyOf?: Array<{ properties?: Record<string, unknown>; required?: string[] }>;
      };

    // Plain-object tools: exact property + required sets.
    const plain = new Map<string, { properties: string[]; required: string[] }>([
      ['load_skill', { properties: ['skillId'], required: ['skillId'] }],
      ['send_message', { properties: ['targetAgentId', 'summary'], required: ['targetAgentId', 'summary'] }],
      ['publish_artifact', { properties: [], required: [] }],
      ['submit_final_artifact', { properties: [], required: [] }],
      ['annotate_artifact', { properties: ['file', 'content'], required: ['file', 'content'] }],
      ['forward_input_version', { properties: ['targetAgentId'], required: ['targetAgentId'] }],
      ['request_human_input', { properties: ['question'], required: ['question'] }],
    ]);
    for (const [name, expected] of plain) {
      const schema = schemaOf(name);
      expect(Object.keys(schema.properties ?? {}).sort(), name).toEqual(
        [...expected.properties].sort(),
      );
      expect([...(schema.required ?? [])].sort(), name).toEqual([...expected.required].sort());
    }

    // finish_production: a single top-level object (provider-compatible) with a
    // `source` discriminator and the multi-file `files` array.
    const finish = schemaOf('finish_production');
    expect((finish as { type?: string }).type).toBe('object');
    expect(finish.anyOf).toBeUndefined();
    expect(Object.keys(finish.properties ?? {}).sort()).toEqual(
      ['artifactType', 'files', 'format', 'source', 'title'].sort(),
    );
    expect([...(finish.required ?? [])]).toEqual(['source', 'files']);
  });

  it('serializes every tool parameter schema as a top-level JSON object (DeepSeek requires type:"object")', () => {
    const { tools } = toolsFor();
    for (const tool of tools) {
      const schema = tool.parameters as { type?: string; anyOf?: unknown };
      expect(schema.type, tool.name).toBe('object');
      expect(schema.anyOf, tool.name).toBeUndefined();
    }
  });
});

describe('pi-tool-factory phase gate rejections are correctable (spec §5.3)', () => {
  it('rejects publish_artifact before finish_production with the stable phase code', async () => {
    const { buffer, tools } = toolsFor();
    const rejected = await execute(tools, 'publish_artifact', {});
    expect(rejected.accepted).toBe(false);
    expect(rejected.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_PUBLISH_WITHOUT_FINISH_INVALID);
    expect(buffer.snapshot()).toEqual([]);
  });

  it('dispatches operate actions directly from production without sealing', async () => {
    const { buffer, tools } = toolsFor();
    const sent = await execute(tools, 'send_message', {
      targetAgentId: 'agent-beta',
      summary: 'neutral coordination message',
    });
    expect(sent.accepted).toBe(true);
    const late = await execute(tools, 'publish_artifact', {});
    expect(late.accepted).toBe(false);
    expect(late.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE);
    expect(buffer.snapshot()).toEqual([sendMessageProposal()]);
  });

  it('rejects a second finish_production once the package is sealed', async () => {
    const { tools } = toolsFor();
    await sealInline(tools);
    const rejected = await execute(tools, 'finish_production', {
      source: 'inline',
      files: [{ name: 'content.md', content: 'second seal' }],
      format: 'text',
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_FINISH_DUPLICATE);
  });

  it('rejects production tools after sealing', async () => {
    const { tools } = toolsFor();
    await sealInline(tools);
    const rejected = await execute(tools, 'load_skill', { skillId: 'skill-alpha' });
    expect(rejected.accepted).toBe(false);
    expect(rejected.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_ORDER_INVALID);
  });

  it('rejects annotate_artifact after the package is sealed', async () => {
    const { tools } = toolsFor();
    await sealInline(tools);
    const rejected = await execute(tools, 'annotate_artifact', {
      file: 'review.md',
      content: '---\nverdict: reject\n---\n意见',
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_ANNOTATE_AFTER_SEAL_INVALID);
  });

  it('rejects any action after the one dispatch', async () => {
    const { tools } = toolsFor();
    await sealInline(tools);
    const dispatched = await execute(tools, 'send_message', {
      targetAgentId: 'agent-beta',
      summary: 'neutral coordination message',
    });
    expect(dispatched.accepted).toBe(true);
    const late = await execute(tools, 'publish_artifact', {});
    expect(late.accepted).toBe(false);
    expect(late.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE);
  });

  it('accepts request_human_input as the sole first action and then nothing', async () => {
    const { buffer, tools } = toolsFor();
    const interrupt = await execute(tools, 'request_human_input', { question: '需要确认吗？' });
    expect(interrupt.accepted).toBe(true);
    expect(buffer.snapshot()).toEqual([{ type: 'request_human_input', question: '需要确认吗？' }]);
    const late = await execute(tools, 'finish_production', {
      source: 'inline',
      files: [{ name: 'content.md', content: 'late' }],
      format: 'text',
    });
    expect(late.accepted).toBe(false);
    expect(late.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE);
  });

  it('accepts request_human_input mid-production after load_skill (F7 flipped)', async () => {
    const { tools } = toolsFor();
    const loaded = await execute(tools, 'load_skill', { skillId: 'skill-alpha' });
    expect(loaded.accepted).toBe(true);
    const interrupt = await execute(tools, 'request_human_input', { question: '现在问？' });
    expect(interrupt.accepted).toBe(true);
    expect(interrupt.code).toBeUndefined();
  });

  it('accepts the full legal writer sequence finish then publish', async () => {
    const { buffer, tools } = toolsFor();
    await sealInline(tools);
    const published = await execute(tools, 'publish_artifact', {});
    expect(published.accepted).toBe(true);
    expect(buffer.snapshot()).toEqual([
      finishProductionProposal({ files: [{ name: 'content.md', content: 'sealed body' }], format: 'text' }),
      { type: 'publish_artifact' },
    ]);
    void sendMessageProposal(); // Shared proposal builders stay import-safe.
  });
});

describe('read_skill_section tool (plan 2026-08-07 Phase 1)', () => {
  function sectionTools(
    readSection: (skillId: string, sectionPath: string) => Promise<{ content: string; versionHash: string }>,
  ): ReturnType<typeof createSkillSectionToolDefinitions> {
    return createSkillSectionToolDefinitions({ readSection });
  }

  it('exposes read_skill_section with a top-level object parameter schema', () => {
    const tools = sectionTools(async () => ({ content: '', versionHash: 'x' }));
    expect(tools.map((tool) => tool.name)).toEqual([...SKILL_SECTION_TOOL_NAMES]);
    const tool = tools[0];
    const schema = tool?.parameters as {
      type?: string;
      anyOf?: unknown;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    // DeepSeek requires a single top-level object, never an anyOf union.
    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['sectionPath', 'skillId']);
    expect([...(schema.required ?? [])].sort()).toEqual(['sectionPath', 'skillId']);
  });

  it('returns the section content with accepted details on a successful read', async () => {
    const tools = sectionTools(async () => ({ content: '## 参考正文', versionHash: 'abc' }));
    const result = await execute(tools, 'read_skill_section', {
      skillId: 'style-guide',
      sectionPath: 'skills/style-guide/references/01.md',
    });
    expect(result.accepted).toBe(true);
    expect(result.text).toContain('## 参考正文');
    expect(result.text).toContain('skills/style-guide/references/01.md');
  });

  it('rejects with the stable code when the reader throws a RuntimeFailure', async () => {
    const tools = sectionTools(async () => {
      throw new RuntimeFailure('SKILL_SECTION_MISSING', 'section missing', false);
    });
    const result = await execute(tools, 'read_skill_section', {
      skillId: 'style-guide',
      sectionPath: 'skills/style-guide/references/01.md',
    });
    expect(result.accepted).toBe(false);
    expect(result.code).toBe('SKILL_SECTION_MISSING');
    expect(result.text).toBe('read_skill_section rejected: SKILL_SECTION_MISSING');
  });

  it('falls back to the tool failure code for a non-RuntimeFailure error', async () => {
    const tools = sectionTools(async () => {
      throw new Error('boom');
    });
    const result = await execute(tools, 'read_skill_section', {
      skillId: 'style-guide',
      sectionPath: 'a.md',
    });
    expect(result.accepted).toBe(false);
    expect(result.code).toBe('SKILL_SECTION_TOOL_FAILED');
  });

  it('never touches any ActionBuffer: a successful read leaves a fresh buffer empty', async () => {
    const buffer = new ActionBuffer('turn-section');
    const tools = sectionTools(async () => ({ content: 'body', versionHash: 'abc' }));
    const result = await execute(tools, 'read_skill_section', {
      skillId: 'style-guide',
      sectionPath: 'a.md',
    });
    expect(result.accepted).toBe(true);
    // The factory receives no buffer handle, so nothing can ever be proposed.
    expect(buffer.snapshot()).toEqual([]);
  });
});
