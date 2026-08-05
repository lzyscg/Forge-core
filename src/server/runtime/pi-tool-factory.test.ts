// @vitest-environment node
/**
 * Forge tool factory tests for the production/dispatch turn contract (plan
 * 2026-08-04 Task 4, spec §5.1/§5.2/§5.3).
 *
 * The tool layer is the model-facing boundary: parameter schemas mirror the
 * frozen action shapes exactly, and the phase-aware ActionBuffer returns
 * stable, CORRECTABLE rejections for illegal phase transitions so the model
 * can self-correct within the same Turn (the ActionCommitter revalidates the
 * final set as the non-bypassable boundary). Neutral identities only (iron
 * rule 1); fixture agent ids appear exclusively in test data.
 */
import { describe, expect, it } from 'vitest';
import { ActionBuffer, ACTION_BUFFER_ERROR_CODES } from './action-buffer';
import { FORGE_ACTION_NAMES } from './forge-actions';
import { createForgeToolDefinitions } from './pi-tool-factory';
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
    content: 'sealed body',
    format: 'text',
  });
  expect(sealed.accepted).toBe(true);
}

describe('pi-tool-factory action shapes (plan 2026-08-04 Task 4)', () => {
  it('exposes exactly the six closed registry tools', () => {
    const { tools } = toolsFor();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...FORGE_ACTION_NAMES].sort());
  });

  it('accepts all three finish_production sources through the buffer', async () => {
    const { buffer, tools } = toolsFor();
    const inline = await execute(tools, 'finish_production', {
      source: 'inline',
      content: 'review text',
      format: 'text',
    });
    expect(inline.accepted).toBe(true);
    expect(buffer.snapshot()).toEqual([finishProductionProposal({ content: 'review text', format: 'text' })]);
  });

  it('accepts the workspace_file source with a relative reference', async () => {
    const { buffer, tools } = toolsFor();
    const workspace = await execute(tools, 'finish_production', {
      source: 'workspace_file',
      workspaceFile: 'draft/chapter.md',
      format: 'markdown',
      artifactType: 'chapter_markdown',
      title: '第一章',
    });
    expect(workspace.accepted).toBe(true);
    expect(buffer.snapshot()).toEqual([
      {
        type: 'finish_production',
        source: 'workspace_file',
        workspaceFile: 'draft/chapter.md',
        format: 'markdown',
        artifactType: 'chapter_markdown',
        title: '第一章',
      },
    ]);
  });

  it('accepts current_input_artifact with no model-supplied version fields', async () => {
    const { buffer, tools } = toolsFor();
    const reference = await execute(tools, 'finish_production', { source: 'current_input_artifact' });
    expect(reference.accepted).toBe(true);
    expect(buffer.snapshot()).toEqual([{ type: 'finish_production', source: 'current_input_artifact' }]);
  });

  it('rejects current_input_artifact carrying any engineering key', async () => {
    const { tools } = toolsFor();
    const rejected = await execute(tools, 'finish_production', {
      source: 'current_input_artifact',
      version: 3,
    });
    expect(rejected.accepted).toBe(false);
    // Versions are platform-assigned; models may never supply them.
    expect(rejected.code).toBe('ACTION_FORBIDDEN_KEY');
  });

  it('requires productionPackageRef to be exactly current on dispatch tools', async () => {
    const { tools } = toolsFor();
    await sealInline(tools);
    for (const name of ['publish_artifact', 'submit_final_artifact']) {
      const wrong = await execute(tools, name, { productionPackageRef: 'latest' });
      expect(wrong.accepted, name).toBe(false);
      expect(wrong.code, name).toBe('ACTION_FIELD_INVALID');
    }
    // send_message keeps its target field alongside the package reference.
    const wrongSend = await execute(tools, 'send_message', {
      targetAgentId: 'agent-beta',
      productionPackageRef: 'latest',
    });
    expect(wrongSend.accepted).toBe(false);
    expect(wrongSend.code).toBe('ACTION_FIELD_INVALID');
  });

  it('rejects dispatch shapes that still carry legacy content or metadata', async () => {
    const { tools } = toolsFor();
    await sealInline(tools);
    const legacyPublish = await execute(tools, 'publish_artifact', {
      productionPackageRef: 'current',
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
      [
        'send_message',
        { properties: ['targetAgentId', 'productionPackageRef'], required: ['targetAgentId', 'productionPackageRef'] },
      ],
      ['publish_artifact', { properties: ['productionPackageRef'], required: ['productionPackageRef'] }],
      ['submit_final_artifact', { properties: ['productionPackageRef'], required: ['productionPackageRef'] }],
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
    // `source` discriminator and optional per-source fields.
    const finish = schemaOf('finish_production');
    expect((finish as { type?: string }).type).toBe('object');
    expect(finish.anyOf).toBeUndefined();
    expect(Object.keys(finish.properties ?? {}).sort()).toEqual(
      ['artifactType', 'content', 'format', 'source', 'title', 'workspaceFile'].sort(),
    );
    expect([...(finish.required ?? [])]).toEqual(['source']);
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
  it('rejects a dispatch before finish_production with the stable phase code', async () => {
    const { buffer, tools } = toolsFor();
    const rejected = await execute(tools, 'send_message', {
      targetAgentId: 'agent-beta',
      productionPackageRef: 'current',
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_ORDER_INVALID);
    expect(buffer.snapshot()).toEqual([]);
  });

  it('rejects a second finish_production once the package is sealed', async () => {
    const { tools } = toolsFor();
    await sealInline(tools);
    const rejected = await execute(tools, 'finish_production', {
      source: 'inline',
      content: 'second seal',
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

  it('rejects any action after the one dispatch', async () => {
    const { tools } = toolsFor();
    await sealInline(tools);
    const dispatched = await execute(tools, 'send_message', {
      targetAgentId: 'agent-beta',
      productionPackageRef: 'current',
    });
    expect(dispatched.accepted).toBe(true);
    const late = await execute(tools, 'publish_artifact', { productionPackageRef: 'current' });
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
      content: 'late',
      format: 'text',
    });
    expect(late.accepted).toBe(false);
    expect(late.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE);
  });

  it('rejects request_human_input mid-production (after work, before sealing)', async () => {
    const { tools } = toolsFor();
    const loaded = await execute(tools, 'load_skill', { skillId: 'skill-alpha' });
    expect(loaded.accepted).toBe(true);
    const rejected = await execute(tools, 'request_human_input', { question: '现在问？' });
    expect(rejected.accepted).toBe(false);
    expect(rejected.code).toBe(ACTION_BUFFER_ERROR_CODES.PHASE_HUMAN_INTERRUPT_INVALID);
  });

  it('accepts the full legal writer sequence finish then publish', async () => {
    const { buffer, tools } = toolsFor();
    await sealInline(tools);
    const published = await execute(tools, 'publish_artifact', { productionPackageRef: 'current' });
    expect(published.accepted).toBe(true);
    expect(buffer.snapshot()).toEqual([
      finishProductionProposal({ content: 'sealed body', format: 'text' }),
      { type: 'publish_artifact', productionPackageRef: 'current' },
    ]);
    void sendMessageProposal(); // Shared proposal builders stay import-safe.
  });
});
