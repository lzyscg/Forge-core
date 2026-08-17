// @vitest-environment node
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeAction } from '../runtime/forge-actions';
import type { AgentRuntime, AgentTurnInput, AgentTurnResult } from '../runtime/agent-runtime';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import type { StructuredRuntimeEnvironmentV1 } from '../structured-slots/runtime-capability';
import { createTestRuntimeEnvironment } from '../structured-slots/runtime-capability';
import type { StructuredSlotRuntimeContext } from '../runtime/pi-agent-runtime';
import { CoreService } from '../core-service';
import { makeTempCorePaths, disposeAllTestRoots } from '../test-support';
import type { TaskEvent } from '../storage/task-events';
import { V1_PACKAGE_FIXTURE } from './v1-compatibility-support';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
// The v1 acceptance test loads the FROZEN Task 1 archive (Task 25 migrated the
// production source to contract v2; the historical v1 fixture remains a stable
// regression baseline).
const templateSource = V1_PACKAGE_FIXTURE;
const templateId = 'zhihu-salt-chapter-draft';

interface ToolStep {
  tool: string;
  params?: unknown;
  paramsFrom?: (results: ReadonlyMap<string, unknown>) => unknown;
}

interface ScriptedTurn {
  tools: ToolStep[];
  action: (results: ReadonlyMap<string, unknown>) => ForgeAction;
}

class ScriptedStructuredRuntime implements AgentRuntime {
  private readonly scripts = new Map<string, ScriptedTurn[]>();
  private readonly turnIndex = new Map<string, number>();
  private provider: ((input: AgentTurnInput) => Promise<StructuredSlotRuntimeContext | null>) | null = null;

  setScript(agentId: string, turns: ScriptedTurn[]): void {
    this.scripts.set(agentId, turns);
    this.turnIndex.set(agentId, 0);
  }

  setStructuredSlotProvider(
    provider: (input: AgentTurnInput) => Promise<StructuredSlotRuntimeContext | null>,
  ): void {
    this.provider = provider;
  }

  async run(input: AgentTurnInput, _signal: AbortSignal): Promise<AgentTurnResult> {
    const turns = this.scripts.get(input.agent.id);
    if (turns === undefined) throw new Error(`missing script for ${input.agent.id}`);
    const index = this.turnIndex.get(input.agent.id) ?? 0;
    const plan = turns[index];
    if (plan === undefined) throw new Error(`missing scripted turn ${index} for ${input.agent.id}`);
    this.turnIndex.set(input.agent.id, index + 1);

    const context = input.slotSession === null ? null : (await this.provider?.(input)) ?? null;
    const results = new Map<string, unknown>();
    for (let i = 0; i < plan.tools.length; i += 1) {
      if (context === null) throw new Error(`tool ${plan.tools[i]?.tool} without slot context`);
      const step = plan.tools[i]!;
      const definition = context.toolDefinitions.find((tool) => tool.name === step.tool);
      if (definition === undefined) throw new Error(`tool ${step.tool} was not exposed`);
      const params = step.paramsFrom === undefined ? step.params : step.paramsFrom(results);
      const toolCallId = `chapter-script-${input.turnId}-${i}`;
      const precharge = await context.meter.prechargeRawTool({
        toolCallId,
        canonicalArgsHash: canonicalJsonSha256(params),
        toolName: step.tool,
      });
      if (precharge.status !== 'ok') throw new Error(`${step.tool} precharge ${precharge.status}`);
      let result: unknown;
      try {
        result = await (definition.execute as (id: string, params: unknown) => Promise<unknown>)(
          toolCallId,
          params,
        );
      } catch (error) {
        throw error;
      }
      results.set(step.tool, result);
    }
    return {
      turnId: input.turnId,
      publicText: `scripted ${input.agent.id}`,
      actions: [plan.action(results)],
      usage: null,
      trace: [],
    };
  }

  async disposeAgent(): Promise<void> {}
  async disposeAll(): Promise<void> {}
}

function toolPayload(result: unknown): unknown {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
  const split = text.indexOf(': ');
  if (split < 0) throw new Error(`invalid slot tool result: ${text}`);
  return JSON.parse(text.slice(split + 2));
}

function slotIdsByType(result: unknown, typeId: string): string[] {
  const entries = (toolPayload(result) as { entries: Array<{ slotId: string; typeId: string }> }).entries;
  return entries.filter((entry) => entry.typeId === typeId).map((entry) => entry.slotId);
}

function sendMessage(targetAgentId: string): ForgeAction {
  return { type: 'send_message', targetAgentId, summary: 'chapter template handoff' };
}

function chapterProposal() {
  return {
    tree: {
      clientKey: 'chapter',
      typeId: 'chapter',
      spec: {},
      children: [
        { clientKey: 'title', typeId: 'title', spec: {}, children: [] },
        { clientKey: 'opening', typeId: 'opening', spec: {}, children: [] },
        { clientKey: 'scene-1', typeId: 'scene_block', spec: {}, children: [] },
        { clientKey: 'closure', typeId: 'emotional_closure', spec: {}, children: [] },
        { clientKey: 'end', typeId: 'chapter_end', spec: {}, children: [] },
      ],
    },
  };
}

function chapterScripts(): ScriptedStructuredRuntime {
  const runtime = new ScriptedStructuredRuntime();
  runtime.setScript('structure', [
    {
      tools: [
        { tool: 'put_structure_proposal', params: chapterProposal() },
        { tool: 'submit_structure_proposal', params: {} },
      ],
      action: () => sendMessage('fill'),
    },
  ]);
  runtime.setScript('fill', [
    {
      tools: [
        { tool: 'list_slots', params: {} },
        {
          tool: 'replace_draft_content',
          paramsFrom: (results) => {
            const title = slotIdsByType(results.get('list_slots'), 'title')[0];
            return { changes: [{ slotId: title, content: '雨夜的缴费单' }] };
          },
        },
        { tool: 'submit_draft', params: {} },
      ],
      action: () => sendMessage('seal'),
    },
    {
      tools: [
        { tool: 'list_slots', params: {} },
        {
          tool: 'replace_draft_content',
          paramsFrom: (results) => {
            const ids = (typeId: string) => slotIdsByType(results.get('list_slots'), typeId)[0];
            return {
              changes: [
                { slotId: ids('title'), content: '雨夜的缴费单' },
                { slotId: ids('opening'), content: '林晚在缴费窗口停住了手。' },
                { slotId: ids('scene_block'), content: '她查出那笔已经结清的费用来自一个陌生账户。' },
                { slotId: ids('emotional_closure'), content: '她第一次怀疑母亲隐瞒的不是债务。' },
                { slotId: ids('chapter_end'), content: '雨幕里，陌生号码发来一张旧仓库的照片。' },
              ],
            };
          },
        },
        { tool: 'submit_draft', params: {} },
      ],
      action: () => sendMessage('seal'),
    },
  ]);
  runtime.setScript('seal', [
    {
      tools: [{ tool: 'request_seal', params: {} }],
      action: (results) => {
        const receipt = toolPayload(results.get('request_seal')) as { status: string };
        return receipt.status === 'passed' ? { type: 'publish_artifact' } : sendMessage('fill');
      },
    },
    {
      tools: [{ tool: 'request_seal', params: {} }],
      action: (results) => {
        const receipt = toolPayload(results.get('request_seal')) as { status: string };
        return receipt.status === 'passed' ? { type: 'publish_artifact' } : sendMessage('fill');
      },
    },
  ]);
  runtime.setScript('submitter', [
    { tools: [], action: () => ({ type: 'submit_final_artifact' }) },
  ]);
  return runtime;
}

async function makeService(runtime: AgentRuntime, environment: StructuredRuntimeEnvironmentV1) {
  const { paths, templateRoot } = makeTempCorePaths('forge-core-zhihu-chapter-');
  cpSync(templateSource, join(templateRoot, templateId), { recursive: true });
  const service = new CoreService(paths, { runtime, runtimeEnvironment: environment });
  await service.initialize();
  return service;
}

afterEach(() => disposeAllTestRoots());

describe('zhihu-salt-chapter-draft structured runtime acceptance', () => {
  it('runs structure → fill → seal rework → publish → final submit', async () => {
    const service = await makeService(chapterScripts(), createTestRuntimeEnvironment());
    const task = await service.createTask({
      templateId,
      name: '知乎盐选单章验收',
      input: {
        chapter_packet: '本章写林晚在缴费窗口发现父亲留下的线索。',
        previous_draft: '',
        repair_order: '',
      },
    });

    const summary = await service.scheduler.start(task.id);
    expect(summary.status, JSON.stringify(summary, null, 2)).toBe('completed');
    const events = (await service.events.read(task.id)).map((entry) => entry.event);
    expect(events.filter((event) => event.type === 'structured_scaffold_generation_committed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'structured_scaffold_sealed')).toHaveLength(1);
    const sealAttemptTerminals = events.filter(
      (event): event is Extract<TaskEvent, { type: 'structured_slot_attempt_terminal' }> =>
        event.type === 'structured_slot_attempt_terminal' &&
        events.some((candidate) => candidate.type === 'structured_slot_attempt_started' && candidate.turnId === event.turnId && candidate.agentId === 'seal'),
    );
    expect(sealAttemptTerminals).toHaveLength(2);
    expect(sealAttemptTerminals[0]?.reason).toBe('rework_dispatch');
    expect(events.filter((event) => event.type === 'final_submission_accepted')).toHaveLength(1);

    const workspace = await service.getWorkspace(task.id);
    const final = workspace.artifacts?.find((artifact) => artifact.final);
    const chapter = final?.files.find((file) => file.name === 'chapter.md');
    expect(chapter?.content).toContain('# 雨夜的缴费单');
    expect(chapter?.content).toContain('陌生号码发来一张旧仓库的照片。');
    await service.shutdown();
  });
});
