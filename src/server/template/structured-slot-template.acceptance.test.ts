// @vitest-environment node
/**
 * Structured slot template acceptance (Task 19, spec §15/§16, design §25.13 O09).
 *
 * Two-phase capability protocol (spec §15): the checked-in production manifest
 * stays `disabled` with a provisional profile throughout Steps 1-5. This test
 * NEVER asserts the checked-in phase — only the release command may. It drives
 * the SAME structured fixture through an EXPLICIT injected matching enabled
 * environment by default and, under `--capability production` (Step 9), through
 * the production default. The env variable `FORGE_STRUCTURED_CAPABILITY_MODE`
 * is set by `scripts/verify-structured-slots.ts`; the default is `injected`.
 *
 * The end-to-end flow runs the REAL CoreService + TaskScheduler + structured
 * v3 runNext path with a scripted Agent runtime that drives the REAL closed
 * Slot Tools (precharge + execute) and dispatches the REAL ForgeActions:
 *
 *   initial structure → fill → no-op fill → Seal reliable failure →
 *   rework fill → Seal publish → v2 final submit
 *
 * Assertions: the scaffold generation commits; a no-op Draft is legal (merged,
 * revision unchanged, no content blob); a reliable seal failure freezes a
 * rework receipt and routes to fill; the passing seal freezes a sealed
 * candidate whose artifact content DERIVES from the sealed scaffold; and the
 * task completes ONLY at the v2 final submission (never at the seal).
 */
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeAction } from '../runtime/forge-actions';
import { FORGE_ACTION_NAMES, FORBIDDEN_ACTION_KEYS } from '../runtime/forge-actions';
import type { AgentRuntime, AgentTurnInput, AgentTurnResult } from '../runtime/agent-runtime';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import { SLOT_TOOL_NAMES, STRUCTURE_TOOL_NAMES, FILL_TOOL_NAMES, SEAL_TOOL_NAMES } from '../runtime/structured-slot/tool-factory';
import {
  createTestRuntimeEnvironment,
} from '../structured-slots/runtime-capability';
import type { StructuredRuntimeEnvironmentV1 } from '../structured-slots/runtime-capability';
import { CoreService } from '../core-service';
import { CorePaths } from '../storage/core-paths';
import { EventStore } from '../storage/event-store';
import { StructuredSlotBlobStore } from '../storage/structured-slot-blob-store';
import { projectStructuredSlotState } from '../storage/structured-slot-state';
import { createStructuredSlotDataSource } from '../runtime/structured-slot/session-service';
import {
  StructuredSlotProjectionService,
  createTaskLocalCursorSigner,
} from '../runtime/structured-slot/projection-service';
import { resolveAccessScope } from '../runtime/structured-slot/grant-service';
import {
  deriveDraftId,
  deriveTurnId,
  recoverDanglingAttempts,
  startAttempt,
  terminalize,
} from '../runtime/structured-slot/attempt-coordinator';
import type { StructuredSlotRuntimeContext } from '../runtime/pi-agent-runtime';
import { makeTempCorePaths, disposeAllTestRoots } from '../test-support';
import type { FrozenStructuredSlotContractV1 } from './structured-slot-contract';
import type { TaskEvent } from '../storage/task-events';
import type { SlotCapabilityV1 } from '../../shared/structured-slots';
import {
  projectV1AcceptanceSummary,
  readV1CompatibilitySnapshot,
} from './v1-compatibility-support';

const ACCEPTANCE_TEMPLATE_ID = 'structured-acceptance';

/** Locates the structured-acceptance fixture (node + jsdom fallback). */
function acceptanceFixtureDir(): string {
  try {
    return fileURLToPath(new URL('__fixtures__/structured-acceptance', import.meta.url));
  } catch {
    return join(
      process.cwd(),
      'src',
      'server',
      'template',
      '__fixtures__',
      'structured-acceptance',
    );
  }
}

/** The capability mode the verify command sets; default is injected. */
function capabilityMode(): 'injected' | 'production' {
  return process.env.FORGE_STRUCTURED_CAPABILITY_MODE === 'production' ? 'production' : 'injected';
}

/**
 * Builds the runtime environment for this run: an explicit injected enabled
 * environment by default; `undefined` under `--capability production` so the
 * CoreService reads the checked-in production manifest (which Step 8 enabled).
 */
function acceptanceEnvironment(): StructuredRuntimeEnvironmentV1 | undefined {
  return capabilityMode() === 'production' ? undefined : createTestRuntimeEnvironment();
}

// ---------------------------------------------------------------------------
// Scripted structured Agent runtime
// ---------------------------------------------------------------------------

/** One scripted slot-tool step; params may derive from prior tool results. */
interface ToolStep {
  tool: string;
  params?: unknown;
  paramsFrom?: (results: ReadonlyMap<string, unknown>) => unknown;
}

/** One scripted turn: the tools to run and the action to dispatch. */
interface ScriptedTurn {
  tools: ToolStep[];
  action: (results: ReadonlyMap<string, unknown>, input: AgentTurnInput) => ForgeAction;
}

/**
 * A deterministic scripted Agent runtime that drives the REAL closed Slot
 * Tools (precharge + execute) for structured v3 turns and dispatches real
 * ForgeActions. It receives the SAME per-turn structured slot context
 * provider the Pi adapter gets (`setStructuredSlotProvider`, wired
 * structurally by CoreService) so the meter / tool set / dispatch guard are
 * the runner's own instances.
 */
class ScriptedStructuredRuntime implements AgentRuntime {
  private readonly scripts = new Map<string, ScriptedTurn[]>();

  private readonly turnIndex = new Map<string, number>();

  private provider: ((input: AgentTurnInput) => Promise<StructuredSlotRuntimeContext | null>) | null =
    null;

  /** The executed tool names per turn, for assertion. */
  readonly executedTools: string[] = [];

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
    if (turns === undefined) {
      throw new Error(`scripted runtime: no script for agent ${input.agent.id}`);
    }
    const index = this.turnIndex.get(input.agent.id) ?? 0;
    const plan = turns[index];
    if (plan === undefined) {
      throw new Error(`scripted runtime: no scripted turn #${index} for ${input.agent.id}`);
    }
    this.turnIndex.set(input.agent.id, index + 1);

    const ctx = input.slotSession !== null ? (await this.provider?.(input)) ?? null : null;
    const results = new Map<string, unknown>();
    for (let i = 0; i < plan.tools.length; i += 1) {
      const step = plan.tools[i];
      if (ctx === null) {
        throw new Error(`scripted runtime: ${input.agent.id} requested ${step.tool} without a context`);
      }
      const def = ctx.toolDefinitions.find((d) => d.name === step.tool);
      if (def === undefined) {
        throw new Error(`scripted runtime: tool ${step.tool} is not exposed in the ${input.agent.id} session`);
      }
      const params = step.paramsFrom !== undefined ? step.paramsFrom(results) : step.params;
      const toolCallId = `scripted-${input.turnId}-${i}`;
      const canonicalArgsHash = canonicalJsonSha256(params);
      const precharge = await ctx.meter.prechargeRawTool({
        toolCallId,
        canonicalArgsHash,
        toolName: step.tool,
      });
      if (precharge.status !== 'ok') {
        throw new Error(`scripted runtime: ${step.tool} precharge failed (${precharge.status})`);
      }
      const result = await (def.execute as (id: string, params: unknown) => Promise<unknown>)(
        toolCallId,
        params,
      );
      results.set(step.tool, result);
      this.executedTools.push(step.tool);
    }
    const action = plan.action(results, input);
    return {
      turnId: input.turnId,
      publicText: `scripted ${input.agent.id} turn`,
      actions: [action],
      usage: null,
      trace: [],
    };
  }

  async disposeAgent(): Promise<void> {
    // no-op: the scripted runtime owns no provider session
  }

  async disposeAll(): Promise<void> {
    // no-op
  }
}

/** Parses the JSON payload from a SlotToolResult content text. */
function toolPayload(result: unknown): unknown {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text ?? '';
  const index = text.indexOf(': ');
  if (index === -1) {
    throw new Error(`scripted runtime: cannot parse tool result '${text}'`);
  }
  return JSON.parse(text.slice(index + 2));
}

/** Builds the proposed structure tree (document → title + one body). */
function proposalTree() {
  return {
    tree: {
      clientKey: 'document',
      typeId: 'document',
      spec: {},
      children: [
        { clientKey: 'title', typeId: 'title', spec: {}, children: [] },
        { clientKey: 'body-1', typeId: 'body', spec: {}, children: [] },
      ],
    },
  };
}

/** Finds visible slot ids by typeId from a list_slots payload. */
function slotIdsByType(payload: unknown, typeId: string): string[] {
  const entries = (payload as { entries: Array<{ slotId: string; typeId: string }> }).entries;
  return entries.filter((entry) => entry.typeId === typeId).map((entry) => entry.slotId);
}

const sendMessage = (targetAgentId: string): ForgeAction => ({
  type: 'send_message',
  targetAgentId,
  summary: 'scripted handoff',
});

/** The full scripted flow for the acceptance fixture pipeline. */
function acceptanceScripts(): ScriptedStructuredRuntime {
  const runtime = new ScriptedStructuredRuntime();
  // structure: propose + submit the scaffold, route to fill.
  runtime.setScript('structure', [
    {
      tools: [
        { tool: 'put_structure_proposal', params: proposalTree() },
        { tool: 'submit_structure_proposal', params: {} },
      ],
      action: () => sendMessage('fill'),
    },
  ]);
  // fill turn 1: fill ONLY the title (leaves the body unfilled so the first
  // seal gate reliably fails with CONTENT_REQUIRED).
  runtime.setScript('fill', [
    {
      tools: [
        { tool: 'list_slots', params: {} },
        {
          tool: 'replace_draft_content',
          paramsFrom: (results) => {
            const payload = toolPayload(results.get('list_slots'));
            const titleIds = slotIdsByType(payload, 'title');
            return { changes: [{ slotId: titleIds[0], content: 'Acceptance Title' }] };
          },
        },
        { tool: 'submit_draft', params: {} },
      ],
      action: () => sendMessage('seal'),
    },
    // fill turn 2: a NO-OP draft — list + submit without any change. Legal:
    // the draft merges with no content revision bump (spec §9.2).
    {
      tools: [
        { tool: 'list_slots', params: {} },
        { tool: 'submit_draft', params: {} },
      ],
      action: () => sendMessage('seal'),
    },
    // fill turn 3: rework fill — fill the title AND the first body slot so the
    // following seal gate passes.
    {
      tools: [
        { tool: 'list_slots', params: {} },
        {
          tool: 'replace_draft_content',
          paramsFrom: (results) => {
            const payload = toolPayload(results.get('list_slots'));
            const titleIds = slotIdsByType(payload, 'title');
            const bodyIds = slotIdsByType(payload, 'body');
            return {
              changes: [
                { slotId: titleIds[0], content: 'Acceptance Title' },
                { slotId: bodyIds[0], content: 'Acceptance body paragraph.' },
              ],
            };
          },
        },
        { tool: 'submit_draft', params: {} },
      ],
      action: () => sendMessage('seal'),
    },
  ]);
  // seal: request the Seal Gate; dispatch by the frozen dispatch state.
  runtime.setScript('seal', [
    {
      tools: [{ tool: 'request_seal', params: {} }],
      action: (results) => {
        const receipt = toolPayload(results.get('request_seal')) as { status: string };
        return receipt.status === 'passed'
          ? { type: 'publish_artifact' }
          : sendMessage('fill');
      },
    },
    {
      tools: [{ tool: 'request_seal', params: {} }],
      action: (results) => {
        const receipt = toolPayload(results.get('request_seal')) as { status: string };
        return receipt.status === 'passed'
          ? { type: 'publish_artifact' }
          : sendMessage('fill');
      },
    },
    {
      tools: [{ tool: 'request_seal', params: {} }],
      action: (results) => {
        const receipt = toolPayload(results.get('request_seal')) as { status: string };
        return receipt.status === 'passed'
          ? { type: 'publish_artifact' }
          : sendMessage('fill');
      },
    },
  ]);
  // submitter: v2 post-seal node — submit the sealed input version as final.
  runtime.setScript('submitter', [
    {
      tools: [],
      action: () => ({ type: 'submit_final_artifact' }),
    },
  ]);
  return runtime;
}

/** Builds a CoreService over the acceptance fixture with the given env. */
async function createAcceptanceService(options: {
  runtime: AgentRuntime;
  environment?: StructuredRuntimeEnvironmentV1;
}): Promise<{ service: CoreService; paths: CorePaths }> {
  const { paths, templateRoot } = makeTempCorePaths('forge-core-structured-accept-');
  const templateDir = join(templateRoot, ACCEPTANCE_TEMPLATE_ID);
  cpSync(acceptanceFixtureDir(), templateDir, { recursive: true });
  const service = new CoreService(paths, {
    runtime: options.runtime,
    ...(options.environment !== undefined ? { runtimeEnvironment: options.environment } : {}),
  });
  await service.initialize();
  return { service, paths };
}

async function createAcceptanceTask(service: CoreService): Promise<string> {
  const created = await service.createTask({
    templateId: ACCEPTANCE_TEMPLATE_ID,
    name: 'Structured Acceptance Task',
    input: { 'source-text': 'neutral structured source' },
  });
  return created.id;
}

afterEach(() => {
  disposeAllTestRoots();
});

// ---------------------------------------------------------------------------
// End-to-end flow (Step 1)
// ---------------------------------------------------------------------------

describe('structured-slot-template acceptance — end-to-end flow (Task 19)', () => {
  it('runs structure → fill → no-op fill → seal fail → rework fill → seal publish → final submit', async () => {
    const runtime = acceptanceScripts();
    const { service } = await createAcceptanceService({
      runtime,
      environment: acceptanceEnvironment(),
    });
    const taskId = await createAcceptanceTask(service);

    const summary = await service.scheduler.start(taskId);
    expect(summary.status).toBe('completed');

    const committed = (await service.events.read(taskId)).map((entry) => entry.event);
    const eventsOf = <T extends TaskEvent['type']>(type: T) =>
      committed.filter((event): event is Extract<TaskEvent, { type: T }> => event.type === type);

    // Exactly one scaffold generation, committed by the structure turn.
    const generations = eventsOf('structured_scaffold_generation_committed');
    expect(generations).toHaveLength(1);
    const generation = generations[0]!;

    // Exactly three fill attempts: real fill, no-op fill, rework fill.
    const opened = eventsOf('structured_fill_draft_opened');
    expect(opened).toHaveLength(3);
    const draftTerminals = eventsOf('structured_fill_draft_terminal');
    expect(draftTerminals).toHaveLength(3);
    expect(draftTerminals.every((d) => d.status === 'merged')).toBe(true);

    // The no-op fill (turn 2) merges with a resultRevision equal to its
    // baseRevision and changeCount 0 — a legal no-op Draft (spec §9.2).
    const noOp = draftTerminals.find((d) => d.changeCount === 0);
    expect(noOp).toBeDefined();
    if (noOp !== undefined) {
      expect(noOp.resultRevision).toBe(noOp.baseRevision);
      expect(noOp.content).toBeNull();
    }

    // The final fill bumps the content revision (a real content blob exists).
    const contentRevisions = eventsOf('structured_fill_draft_terminal').filter((d) => d.content !== null);
    expect(contentRevisions).toHaveLength(2); // fill 1 (title) + fill 3 (title+body)

    // Seal: two reliable failures (rework receipts, no scaffold change) then one
    // pass. Only ONE sealed event exists.
    const sealEvents = eventsOf('structured_scaffold_sealed');
    expect(sealEvents).toHaveLength(1);
    const sealed = sealEvents[0]!;
    expect(sealed.scaffoldId).toBe(generation.scaffoldId);
    expect(sealed.generationId).toBe(generation.generationId);

    // Every started attempt has exactly one terminal (no dangling, no
    // terminal-without-opened).
    const started = eventsOf('structured_slot_attempt_started');
    const terminals = eventsOf('structured_slot_attempt_terminal');
    expect(started.length).toBe(terminals.length);
    const startedTurns = new Set(started.map((s) => s.turnId));
    const terminalTurns = new Set(terminals.map((t) => t.turnId));
    expect(terminalTurns).toEqual(startedTurns);

    // The task completes ONLY at the v2 final submission: exactly one
    // final_submission_accepted exists and no earlier event completed it.
    const finalSubmissions = eventsOf('final_submission_accepted');
    expect(finalSubmissions).toHaveLength(1);

    // Final content derives from the sealed scaffold: the assembled artifact
    // embeds the title/body content the rework fill committed.
    const workspace = await service.getWorkspace(taskId);
    const finalArtifact = [...(workspace.artifacts ?? [])]
      .filter((artifact) => artifact.final)
      .sort((a, b) => a.version - b.version)[0];
    expect(finalArtifact).toBeDefined();
    const contentFile = finalArtifact?.files.find((file) => file.name === 'document.md');
    expect(contentFile?.content).toContain('# Acceptance Title');
    expect(contentFile?.content).toContain('Acceptance body paragraph.');

    // v1 acceptance fence (plan 2026-08-14 Task 1): the projected completed
    // v1 acceptance summary must equal the frozen bytes. The summary only
    // carries deterministic fold results (statuses, counts, revisions) — the
    // Seal path, Draft lifecycle, Attempt pairing and replay result stay
    // byte stable across runs and later v2 work.
    expect(
      projectV1AcceptanceSummary(committed, summary.status, finalArtifact?.version ?? null),
    ).toEqual(readV1CompatibilitySnapshot().completedV1AcceptanceSummary);

    await service.shutdown();
  });

  it('projects the sealed scaffold to both the task_owner and an agent grant subject', async () => {
    const runtime = acceptanceScripts();
    const { service } = await createAcceptanceService({
      runtime,
      environment: acceptanceEnvironment(),
    });
    const taskId = await createAcceptanceTask(service);
    const summary = await service.scheduler.start(taskId);
    expect(summary.status).toBe('completed');

    const events = (await service.events.read(taskId)).map((entry) => entry.event);
    const blobStore = new StructuredSlotBlobStore(service.paths, taskId);
    const state = projectStructuredSlotState(events);
    expect(state.generationId).not.toBeNull();
    expect(state.content).not.toBeNull();

    const frozen = await service.tasks.readFrozenTemplate(taskId);
    const contract = frozen.structuredSlots as FrozenStructuredSlotContractV1;
    const source = createStructuredSlotDataSource({
      blobStore,
      events: async () => events,
    });
    const signer = createTaskLocalCursorSigner(taskId);
    const projection = new StructuredSlotProjectionService({ contract, source, signer });

    // task_owner (local read-only audit view, spec §14/O07): sees every formal
    // slot at content level — including the sealed title/body content.
    const owner = await projection.listSlots({ kind: 'task_owner' }, null, 100);
    expect(owner.ok).toBe(true);
    if (owner.ok) {
      const typeIds = owner.entries.map((entry) => entry.typeId);
      expect(typeIds).toContain('document');
      expect(typeIds).toContain('title');
      expect(typeIds).toContain('body');
      expect(owner.entries.every((entry) => entry.level === 'content')).toBe(true);
    }
    const ownerList = owner.ok ? owner.entries : [];
    const titleEntry = ownerList.find((entry) => entry.typeId === 'title');
    expect(titleEntry).toBeDefined();
    if (titleEntry !== undefined) {
      const read = await projection.readSlot({ kind: 'task_owner' }, titleEntry.slotId);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.slot.level).toBe('content');
        expect(read.slot.content).toBe('Acceptance Title');
      }
    }

    // Agent subject: a fill grant over the active scaffold/revision sees the
    // authorized scope (the 'editor' profile writes everything).
    const index = await blobStore.getGenerationIndex(state.generationId as string);
    const effective = await blobStore.readEffectiveContent(state.content as never);
    const presence: Record<string, 'unset' | 'set'> = {};
    for (const [id, entry] of Object.entries(effective)) {
      presence[id] = entry.presence;
    }
    const profile = contract.accessProfiles.find((p) => p.id === 'editor');
    expect(profile).toBeDefined();
    if (profile === undefined) return;
    const fillCapabilities: SlotCapabilityV1[] = [
      'read_slot_spec',
      'read_slot_content',
      'write_draft_content',
      'submit_draft',
    ];
    const scope = resolveAccessScope(profile, index, presence, fillCapabilities);
    const agentGrant = {
      grantId: 'grant-acceptance',
      kind: 'fill' as const,
      caseId: taskId,
      turnId: 'acceptance-fill-t1',
      agentId: 'fill',
      snapshotHash: frozen.versionHash,
      accessProfileId: 'editor',
      scaffoldId: state.scaffoldId as string,
      generationId: state.generationId as string,
      baseRevision: state.contentRevision ?? 0,
      draftId: `${deriveTurnId('acceptance-fill', 1)}-draft`,
      capabilities: fillCapabilities,
      readableSlotIds: [...scope.readableSlotIds],
      writableSlotIds: [...scope.writableSlotIds],
    };
    const agent = await projection.listSlots({ kind: 'agent', grant: agentGrant }, null, 100);
    expect(agent.ok).toBe(true);
    if (agent.ok) {
      expect(agent.entries.length).toBe(ownerList.length);
    }
    if (titleEntry !== undefined) {
      const agentTitle = await projection.readSlot(
        { kind: 'agent', grant: agentGrant },
        titleEntry.slotId,
      );
      expect(agentTitle.ok).toBe(true);
      if (agentTitle.ok) {
        expect(agentTitle.slot.content).toBe('Acceptance Title');
      }
    }

    // A structure grant has no slot projection (GRANT_INVALID) and an unknown
    // subject is never granted owner visibility.
    const structureGrant = { ...agentGrant, kind: 'structure' as const, draftId: undefined };
    const badSubject = await projection.listSlots(
      { kind: 'agent', grant: structureGrant as never },
      null,
      10,
    );
    expect(badSubject.ok).toBe(false);
    if (!badSubject.ok) expect(badSubject.code).toBe('GRANT_INVALID');
    const unknown = await projection.listSlots({ kind: 'anonymous' as never }, null, 10);
    expect(unknown.ok).toBe(false);

    // v1 cursor behavior fence (plan 2026-08-14 Task 1): the signed, bound
    // cursor continues the IDENTICAL v1 projection and a tampered cursor
    // fails closed with CURSOR_INVALID — the cursor protocol stays
    // unchanged and v1-only.
    const page = await projection.listSlots({ kind: 'task_owner' }, null, 2);
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.entries).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
      if (page.nextCursor !== null) {
        const continued = await projection.listSlots({ kind: 'task_owner' }, page.nextCursor, 2);
        expect(continued.ok).toBe(true);
        if (continued.ok) {
          // The scaffold tree is exactly three formal slots: two on the
          // first page, the remaining one (depth-first pre-order) behind the
          // signed cursor.
          expect(continued.entries).toHaveLength(1);
        }
        const tampered = { ...page.nextCursor, signature: 'forged-signature' };
        const rejected = await projection.listSlots({ kind: 'task_owner' }, tampered, 2);
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(rejected.code).toBe('CURSOR_INVALID');
      }
    }

    await service.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Crash and replay acceptance (Step 2)
// ---------------------------------------------------------------------------

describe('structured-slot-template acceptance — crash and replay (Task 19)', () => {
  /** Builds a minimal committed scaffold so a fill turn can bind draft_opened. */
  async function seedSealedScaffold(paths: CorePaths, taskId: string): Promise<void> {
    const blobStore = new StructuredSlotBlobStore(paths, taskId);
    const manifest = await blobStore.putGeneration({
      generationId: 'gen-1',
      scaffoldId: 'scaffold-1',
      slots: [
        {
          slotId: 'r',
          scaffoldId: 'scaffold-1',
          parentSlotId: null,
          order: 0,
          typeId: 'document',
          spec: {},
          contentPresence: 'unset',
        },
        {
          slotId: 't1',
          scaffoldId: 'scaffold-1',
          parentSlotId: 'r',
          order: 1,
          typeId: 'title',
          spec: {},
          contentPresence: 'unset',
        },
      ],
    });
    const contentRef = await blobStore.putContentRevision({ r: 'unset', t1: 'unset' });
    const events = new EventStore(paths);
    await events.append(taskId, {
      id: 'gen-committed',
      at: new Date().toISOString(),
      type: 'structured_scaffold_generation_committed',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      supersedesGenerationId: null,
      rootSlotId: 'r',
      slotCount: 2,
      maxDepth: 1,
      structure: manifest.structure,
      content: contentRef,
      contentRevision: 0,
      proposalId: 'p-1',
    });
  }

  it('recovery closes a fill-start crash with exactly one terminal and no terminal-without-opened', async () => {
    const { paths } = makeTempCorePaths('forge-core-structured-recovery-');
    const taskId = 'task-recovery';
    mkdirSync(paths.taskRoot(taskId), { recursive: true });
    await seedSealedScaffold(paths, taskId);

    const events = new EventStore(paths);
    const readEvents = async () => events.read(taskId);
    const appendBatch = (
      commitId: string,
      batch: readonly TaskEvent[],
      expectedLastSequence: number,
    ) => events.appendBatch(taskId, commitId, batch, { expectedLastSequence });

    // Fill start batch: attempt_started + draft_opened atomically.
    const start = await startAttempt({
      taskId,
      inputNodeId: 'in-fill',
      agentId: 'fill',
      sessionKind: 'fill',
      events: await readEvents(),
      readEvents,
      appendBatch,
      draftContext: { scaffoldId: 'scaffold-1', generationId: 'gen-1', baseRevision: 0 },
      clock: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(start.attemptEpoch).toBe(1);

    // "Process boundary": restart the store/coordinator over the SAME roots
    // before any private draft materialization. The start batch is visible;
    // recovery must close it with abandoned/crash_recovery.
    const events2 = new EventStore(paths);
    const readEvents2 = async () => events2.read(taskId);
    const appendBatch2 = (
      commitId: string,
      batch: readonly TaskEvent[],
      expectedLastSequence: number,
    ) => events2.appendBatch(taskId, commitId, batch, { expectedLastSequence });
    const recovered = await recoverDanglingAttempts({
      taskId,
      events: await readEvents2(),
      appendBatch: appendBatch2,
      clock: () => new Date('2026-01-02T00:00:00Z'),
    });
    expect(recovered.closed).toBe(1);

    const committed = (await events2.read(taskId)).map((entry) => entry.event);
    const terminals = committed.filter((e) => e.type === 'structured_slot_attempt_terminal');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      turnId: deriveTurnId('in-fill', 1),
      status: 'abandoned',
      reason: 'crash_recovery',
    });
    const draftTerminals = committed.filter((e) => e.type === 'structured_fill_draft_terminal');
    expect(draftTerminals).toHaveLength(1);
    expect(draftTerminals[0]).toMatchObject({
      draftId: deriveDraftId(deriveTurnId('in-fill', 1)),
      status: 'abandoned',
    });
    // No terminal-without-opened: the draft terminal is paired with its opened.
    expect(committed.filter((e) => e.type === 'structured_fill_draft_opened')).toHaveLength(1);

    // Re-running recovery is a no-op (exactly one authority result).
    const again = await recoverDanglingAttempts({
      taskId,
      events: await readEvents2(),
      appendBatch: appendBatch2,
    });
    expect(again.closed).toBe(0);
  });

  it('appendBatch replays the same commitId with a changed clock — never a duplicate', async () => {
    const { paths } = makeTempCorePaths('forge-core-structured-replay-');
    const taskId = 'task-replay';
    mkdirSync(paths.taskRoot(taskId), { recursive: true });
    const events = new EventStore(paths);
    const readEvents = async () => events.read(taskId);
    const appendBatch = (
      commitId: string,
      batch: readonly TaskEvent[],
      expectedLastSequence: number,
    ) => events.appendBatch(taskId, commitId, batch, { expectedLastSequence });

    // Start the structure attempt first (a terminal must follow a started
    // attempt — no terminal-without-opened / no terminal-without-started).
    await startAttempt({
      taskId,
      inputNodeId: 'in-structure',
      agentId: 'structure',
      sessionKind: 'structure',
      events: await readEvents(),
      readEvents,
      appendBatch,
      clock: () => new Date('2026-01-01T00:00:00Z'),
    });

    const terminalizeInput = {
      taskId,
      inputNodeId: 'in-structure',
      attemptEpoch: 1,
      turnId: deriveTurnId('in-structure', 1),
      status: 'committed' as const,
      reason: 'completion_dispatch' as const,
      expectedTail: 1,
      readEvents,
      appendBatch,
    };
    const first = await terminalize({
      ...terminalizeInput,
      clock: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(first.committed).toHaveLength(1);

    // Restart with a different clock/random source: the SAME commitId returns
    // the ORIGINAL committed terminal (replayed, never a second write).
    const events2 = new EventStore(paths);
    const readEvents2 = async () => events2.read(taskId);
    const appendBatch2 = (
      commitId: string,
      batch: readonly TaskEvent[],
      expectedLastSequence: number,
    ) => events2.appendBatch(taskId, commitId, batch, { expectedLastSequence });
    const second = await terminalize({
      ...terminalizeInput,
      expectedTail: 1,
      readEvents: readEvents2,
      appendBatch: appendBatch2,
      clock: () => new Date('2030-06-01T00:00:00Z'),
    });
    expect(second.committed[0]?.event.id).toBe(first.committed[0]?.event.id);
    const all = (await events2.read(taskId)).map((entry) => entry.event);
    expect(all.filter((e) => e.type === 'structured_slot_attempt_terminal')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Security and source scans (Step 3)
// ---------------------------------------------------------------------------

/** Reads a workspace-relative source file (for static source scans). */
function sourceText(workspaceRelative: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${workspaceRelative}`, import.meta.url)),
    'utf8',
  );
}

/** Strips line + block comments from TS/JS source for a code-only scan. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('structured-slot-template acceptance — security and source scans (Task 19)', () => {
  it('keeps the ForgeAction registry at the original nine names', () => {
    expect([...FORGE_ACTION_NAMES].sort()).toEqual(
      [
        'annotate_artifact',
        'finish_production',
        'forward_input_version',
        'load_skill',
        'publish_artifact',
        'read_artifact_version',
        'request_human_input',
        'send_message',
        'submit_final_artifact',
      ].sort(),
    );
    expect(FORGE_ACTION_NAMES).toHaveLength(9);
  });

  it('Slot Tool schemas carry no forbidden engineering keys (code-only scan)', () => {
    expect(SLOT_TOOL_NAMES).toEqual([
      ...STRUCTURE_TOOL_NAMES,
      ...FILL_TOOL_NAMES,
      ...SEAL_TOOL_NAMES,
    ]);
    expect(SEAL_TOOL_NAMES).toEqual(['request_seal']);
    const code = stripComments(sourceText('src/server/runtime/structured-slot/tool-factory.ts'));
    // The model-facing parameter schemas are the TypeBox property names; they
    // must never contain a forbidden engineering key as a quoted string
    // literal. Unquoted property accesses (e.g. grant.scaffoldId) are the
    // server-side type system, not the model parameter surface (spec §15).
    for (const key of ['taskId', 'scaffoldId', 'draftId', 'grantId', 'revision', 'requestId', 'path']) {
      expect(code, `tool-factory schema must not quote '${key}'`).not.toContain(`'${key}'`);
      expect(code, `tool-factory schema must not quote "${key}"`).not.toContain(`"${key}"`);
    }
    // The closed tool names still appear in the code.
    expect(code).toContain('request_seal');
    expect(code).toContain('submit_draft');
  });

  it('the send_message.targetAgentId exception stays limited to ForgeAction', () => {
    // targetAgentId is a frozen route parameter of send_message/forward; it is
    // NOT in the forbidden engineering-key list and appears in no Slot Tool
    // parameter schema (only as the ForgeAction dispatch field the seal guard
    // consumes, which is exactly the existing exception).
    expect(FORBIDDEN_ACTION_KEYS).not.toContain('targetAgentId');
    expect(FORGE_ACTION_NAMES).toContain('send_message');
    const toolFactoryCode = stripComments(
      sourceText('src/server/runtime/structured-slot/tool-factory.ts'),
    );
    expect(toolFactoryCode).not.toContain("'targetAgentId'");
    expect(toolFactoryCode).not.toContain('"targetAgentId"');
    const forgeActionsCode = stripComments(
      sourceText('src/server/runtime/forge-actions.ts'),
    );
    expect(forgeActionsCode).toContain('targetAgentId');
  });

  it('evaluator modules carry no business fixture words', () => {
    for (const file of [
      'src/server/runtime/structured-slot/evaluator-runner.ts',
      'src/server/runtime/structured-slot/validation-engine.ts',
      'src/server/runtime/structured-slot/proposal-service.ts',
      'src/server/runtime/structured-slot/draft-service.ts',
      'src/server/runtime/structured-slot/seal-service.ts',
    ]) {
      const source = sourceText(file);
      expect(source, `${file} must be vocabulary-free`).not.toContain('zhihu');
      expect(source, `${file} must be vocabulary-free`).not.toContain('知乎');
      expect(source, `${file} must be vocabulary-free`).not.toContain('story');
    }
  });

  it('public issues carry no absolute workspace path, secret key names or raw thinking', async () => {
    const { makeStructuredIssue } = await import('../structured-slots/issues');
    // CONTENT_REQUIRED is registered for slot locations (the seal gate uses
    // this exact shape); assert the serialized public issue never carries a
    // host path, secret key name or raw provider thinking.
    const issue = makeStructuredIssue(
      'CONTENT_REQUIRED',
      'seal_input',
      { kind: 'slot', slotId: 'title', field: 'content', valuePointer: '' },
      {},
    );
    const serialized = JSON.stringify(issue);
    expect(serialized).not.toMatch(/\/Users\/|\/home\/|C:\\/);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('thinking');
    // The issue registry source itself never builds paths from host state.
    const issuesCode = sourceText('src/server/structured-slots/issues.ts');
    expect(issuesCode).not.toContain('process.env');
  });
});

// ---------------------------------------------------------------------------
// Production-default readiness (Step 9, release command only)
// ---------------------------------------------------------------------------

describe('structured-slot-template acceptance — production default readiness (Task 19 Step 9)', () => {
  it.skipIf(capabilityMode() !== 'production')(
    'loads/creates/starts the valid structured fixture under the production default',
    async () => {
      const runtime = acceptanceScripts();
      // No runtimeEnvironment: the CoreService reads the checked-in production
      // manifest, which Step 8 enabled with the final profile.
      const { service } = await createAcceptanceService({ runtime });
      const taskId = await createAcceptanceTask(service);
      const summary = await service.scheduler.start(taskId);
      expect(summary.status).toBe('completed');
      await service.shutdown();
    },
  );
});
