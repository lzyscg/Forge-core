/**
 * Thin application service owning Forge Core modules (plan Phase B Tasks 3/4;
 * Phase C Task 4 attaches the runtime stack).
 *
 * Construction performs no IO; `initialize()` boots each module in order.
 * Task creation delegates to the TaskStore; listing projects every task from
 * its record, snapshot, committed events and committed artifacts through the
 * pure projector — a damaged task becomes a `corrupt` summary with a public
 * diagnostic instead of throwing, while healthy tasks stay visible
 * (spec §8.3).
 *
 * Phase C Task 4: the service owns the runtime stack — SkillService,
 * ActionCommitter, the serial TaskRunner and the one-slot TaskScheduler — and
 * the lifecycle methods (start/stop/resume/retry/answer) delegate to the
 * scheduler, replacing the Phase B RUNTIME_NOT_CONNECTED placeholders. The
 * constructor accepts an injected `AgentRuntime` (tests use the deterministic
 * fake); production defaults to the constrained Pi adapter. `shutdown` stops
 * the scheduler before the HTTP server closes.
 *
 * `appendTestEvent`/`publishTestArtifact` are test-only seeding APIs (plan
 * Task 4; reused by the Task 6 e2e harness): the production event producer
 * is the committer (through the runner), never this service.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Value } from 'typebox/value';
import type {
  ArtifactVersion,
  SkillContent,
  StructuredIssuePageV1,
  StructuredSlotOutlinePageV1,
  StructuredSlotPublicContractV1,
  StructuredSlotReadResponseV1,
  TaskSummary,
  TaskWorkspace,
  TurnTrace,
} from '../shared/contracts';
import { structuredSealRecordSchema } from '../shared/api-schemas';
import type {
  JsonObject,
  SealRecord,
  StructuredIssueV1,
  StructuredSlotTreeCursorV1,
} from '../shared/structured-slots';
import { CorePaths } from './storage/core-paths';
import { ArtifactStore, type ArtifactProposal } from './storage/artifact-store';
import { EventStore, type CommittedEvent } from './storage/event-store';
import { TaskStore, type CreateTaskRequest, type CreatedTask } from './storage/task-store';
import { deriveOwnerIssues, projectTask } from './storage/task-projector';
import type { TaskEvent } from './storage/task-events';
import { StructuredSlotBlobStore } from './storage/structured-slot-blob-store';
import { projectStructuredSlotState } from './storage/structured-slot-state';
import { TraceStore } from './storage/trace-store';
import { TemplateCatalog } from './template/template-catalog';
import type { StructuredRuntimeEnvironmentV1 } from './structured-slots/runtime-capability';
import type { AgentRuntime, AgentTurnInput } from './runtime/agent-runtime';
import type { AcceptanceStopHook } from './acceptance-boundary';
import {
  PiAgentRuntime,
  type PiStructuredSlotRuntime,
  type StructuredSlotRuntimeContext,
} from './runtime/pi-agent-runtime';
import { LiveStore } from './runtime/live-store';
import { WorkspaceStore } from './runtime/workspace-store';
import { SkillService } from './runtime/skill-service';
import { GateRunner } from './runtime/gate-runner';
import { ActionCommitter } from './runtime/action-committer';
import { TaskRunner } from './runtime/task-runner';
import { TaskScheduler, type HumanAnswerRequest } from './runtime/task-scheduler';
import type {
  FrozenStructuredSlotContractV1,
} from './template/structured-slot-contract';
import type { FrozenTemplate } from './template/template-schema';
import {
  createStructuredSlotDataSource,
} from './runtime/structured-slot/session-service';
import {
  createTaskLocalCursorSigner,
  StructuredSlotProjectionService,
  type ProjectionErrorCode,
  type StructuredSlotDataSource,
  type TaskLocalCursorSigner,
} from './runtime/structured-slot/projection-service';
import { canonicalJson, canonicalJsonSha256 } from './structured-slots/canonical-json';
import { ALL_LOCATION_KINDS, projectStructuredVerdict } from './structured-slots/issues';
import type { CompiledSlotSchemaV1 } from './structured-slots/slot-schema';
import type { CompiledLayoutGrammarV1 } from './structured-slots/layout-grammar';

export interface CoreServiceOptions {
  /** Injected runtime (tests use the deterministic fake); defaults to Pi. */
  runtime?: AgentRuntime;
  /**
   * The one structured runtime environment (spec §5 / design O05): injected
   * into the TemplateCatalog, from which TaskStore derives it and (Task 17)
   * the Scheduler reuses the same reference. Defaults to the checked-in
   * production manifest (disabled, no profile).
   */
  runtimeEnvironment?: StructuredRuntimeEnvironmentV1;
  /**
   * Acceptance-only boundary seam (plan Phase D Task 4), threaded into the
   * scheduler; production entry points leave it undefined.
   */
  acceptanceStopAfterCommit?: AcceptanceStopHook;
}

/** Clone display name suffix and its code-point bound (plan Phase E Task 3). */
const CLONE_NAME_SUFFIX = '（重跑）';

const CLONE_NAME_MAX_CODE_POINTS = 120;

/** `<source name>（重跑）` truncated to 120 code points. */
function buildCloneName(sourceName: string): string {
  const combined = `${sourceName}${CLONE_NAME_SUFFIX}`;
  const codePoints = [...combined];
  if (codePoints.length <= CLONE_NAME_MAX_CODE_POINTS) {
    return combined;
  }
  return codePoints.slice(0, CLONE_NAME_MAX_CODE_POINTS).join('');
}

/**
 * Structural sink surface of runtimes that apply scripted workspace writes
 * (the deterministic fake). The check stays structural so this module never
 * imports the fake runtime (plan Phase E Task 3).
 */
interface WorkspaceSinkTarget {
  setWorkspaceSink?: (
    sink: (
      taskId: string,
      agentId: string,
      writes: ReadonlyArray<{ path: string; content: string }>,
    ) => Promise<void>,
  ) => void;
}

/**
 * Read-only structured slot projection failure (spec §14). Satisfies the
 * public error shape so the router maps it through the stable status table:
 * `STRUCTURED_NOT_ACTIVE` / `SEAL_NOT_FOUND` → 404, `CURSOR_INVALID` → 409,
 * `SLOT_NOT_VISIBLE` → 404 (identical for missing and hidden).
 */
export class StructuredSlotReadError extends Error {
  readonly code: 'STRUCTURED_NOT_ACTIVE' | 'SLOT_NOT_VISIBLE' | 'CURSOR_INVALID' | 'SEAL_NOT_FOUND';

  readonly location: string | null;

  readonly action: string | null;

  constructor(
    code: StructuredSlotReadError['code'],
    message: string,
    location: string | null = null,
    action: string | null = null,
  ) {
    super(message);
    this.name = 'StructuredSlotReadError';
    this.code = code;
    this.location = location;
    this.action = action;
  }
}

export class CoreService {
  readonly paths: CorePaths;

  readonly templates: TemplateCatalog;

  readonly tasks: TaskStore;

  readonly events: EventStore;

  readonly artifacts: ArtifactStore;

  readonly workspaces: WorkspaceStore;

  readonly traces: TraceStore;

  readonly runtime: AgentRuntime;

  readonly skills: SkillService;

  /**
   * Template-declared artifact gate executor (plan 2026-08-07 Phase 2, spec
   * §4.3): compiles and runs template-owned JS validators in an isolated
   * sandbox. Read-only — never proposes or commits anything.
   */
  readonly gate: GateRunner;

  readonly committer: ActionCommitter;

  readonly runner: TaskRunner;

  readonly scheduler: TaskScheduler;

  /**
   * The ONE structured runtime environment (spec §5 / design O05): the same
   * immutable reference the TemplateCatalog holds. TaskStore derives it from
   * the catalog and the Scheduler/Runner recheck the same reference on every
   * start/resume/retry/answer and per structured Turn — never a second default
   * and never an environment-variable fallback.
   */
  readonly runtimeEnvironment: StructuredRuntimeEnvironmentV1;

  /**
   * Memory-only live-preview buffer behind `TaskWorkspace.activeTurn` (plan
   * C realtime streaming). Strictly in-memory: streamed thinking/text never
   * touches files or events.
   */
  readonly live: LiveStore;

  /**
   * ONE cursor signer per task (Task 10 note): the projection service binds
   * every cursor to a task-local in-memory HMAC secret, so pagination stays
   * coherent across REST requests and a process restart invalidates held
   * cursors (fail closed).
   */
  private readonly structuredCursorSigners = new Map<string, TaskLocalCursorSigner>();

  constructor(paths: CorePaths, options: CoreServiceOptions = {}) {
    this.paths = paths;
    // The catalog owns ONE structured runtime environment; TaskStore derives
    // it from the catalog and the Scheduler/Runner reuse the same reference
    // (design O05).
    this.templates = new TemplateCatalog(paths, {
      runtimeEnvironment: options.runtimeEnvironment,
    });
    this.runtimeEnvironment = this.templates.runtimeEnvironment;
    this.tasks = new TaskStore(paths, this.templates);
    this.events = new EventStore(paths);
    this.artifacts = new ArtifactStore(paths, this.events);
    // Phase E stores exist before the runtime/runner so every consumer shares
    // the same derivation (plan Task E3).
    this.workspaces = new WorkspaceStore(paths);
    this.traces = new TraceStore(paths);
    // Task 17: the per-turn structured slot runtime seam. The production Pi
    // adapter resolves it after the runner exists (the runner owns the
    // coordinator/session bundle); the mutable holder is filled below so the
    // runtime can be constructed first. Fakes/tests never read the seam.
    const structuredSlotSeam: {
      createContext?: (input: AgentTurnInput) => Promise<StructuredSlotRuntimeContext | null>;
    } = {};
    this.runtime =
      options.runtime ??
      new PiAgentRuntime({
        coreCwd: paths.dataRoot,
        workspaces: this.workspaces,
        structuredSlot: structuredSlotSeam as PiStructuredSlotRuntime,
      });
    // Structural fake-runtime wiring: the deterministic fake applies scripted
    // workspace writes through the offered sink; real runtimes own their
    // workspace tools and never expose the method.
    const sinkTarget = this.runtime as WorkspaceSinkTarget;
    if (typeof sinkTarget.setWorkspaceSink === 'function') {
      const workspaces = this.workspaces;
      sinkTarget.setWorkspaceSink(async (taskId, agentId, writes) => {
        for (const write of writes) {
          await workspaces.writeFile(taskId, agentId, write.path, write.content);
        }
      });
    }
    this.skills = new SkillService({ paths, tasks: this.tasks, events: this.events });
    // Structural skill-content-reader wiring: runtimes that expose a setter
    // (the constrained Pi adapter) receive a reader backed by the SkillService
    // display read, so load_skill returns the full skill text in the same Turn.
    // Real runtimes own their tools and never expose the method; the check
    // stays structural so this module never imports the Pi adapter (iron rule 5).
    const skillReaderTarget = this.runtime as Partial<{
      setSkillContentReader?: (
        reader: (
          taskId: string,
          agentId: string,
          skillId: string,
        ) => Promise<{ content: string; versionHash: string } | null>,
      ) => void;
    }>;
    if (typeof skillReaderTarget.setSkillContentReader === 'function') {
      const skills = this.skills;
      skillReaderTarget.setSkillContentReader((taskId, _agentId, skillId) =>
        skills.readSkillForDisplay(taskId, skillId),
      );
    }
    // Structural skill-section-reader wiring (plan 2026-08-07 Phase 1): the
    // same structural-setter discipline as the content reader above. Runtimes
    // exposing `setSkillSectionReader` receive a reader backed by the
    // SkillService authorization + snapshot-containment read.
    const sectionReaderTarget = this.runtime as Partial<{
      setSkillSectionReader?: (
        reader: (
          taskId: string,
          agentId: string,
          skillId: string,
          sectionPath: string,
        ) => Promise<{ content: string; versionHash: string }>,
      ) => void;
    }>;
    if (typeof sectionReaderTarget.setSkillSectionReader === 'function') {
      const skills = this.skills;
      sectionReaderTarget.setSkillSectionReader((taskId, agentId, skillId, sectionPath) =>
        skills.readSection(taskId, agentId, skillId, sectionPath),
      );
    }
    // Template-declared artifact gate (plan 2026-08-07 Phase 2, spec §4.5):
    // one shared runner executes template-owned validators in an isolated
    // sandbox. Wired into the committer as the non-bypassable commit gate and
    // structurally into runtimes exposing setGateRunner (the read-only
    // self_check tool); the wiring check stays structural (iron rule 5).
    this.gate = new GateRunner({ paths });
    const gateRunnerTarget = this.runtime as Partial<{
      setGateRunner?: (runner: GateRunner) => void;
    }>;
    if (typeof gateRunnerTarget.setGateRunner === 'function') {
      gateRunnerTarget.setGateRunner(this.gate);
    }
    this.committer = new ActionCommitter({
      events: this.events,
      artifacts: this.artifacts,
      skills: this.skills,
      gateRunner: this.gate,
    });
    // Live-preview buffer (plan C): the runner tags every runtime patch with
    // the task id and merges it here. Memory-only — never persisted.
    this.live = new LiveStore();
    this.runner = new TaskRunner({
      tasks: this.tasks,
      events: this.events,
      artifacts: this.artifacts,
      skills: this.skills,
      committer: this.committer,
      runtime: this.runtime,
      workspaces: this.workspaces,
      traces: this.traces,
      paths: this.paths,
      runtimeEnvironment: this.runtimeEnvironment,
      liveSink: (taskId, patch) => this.live.merge(taskId, patch),
    });
    // Fill the mutable structured-slot seam now that the runner exists: the Pi
    // runtime builds its per-turn structured slot context (tool set, meter,
    // dispatch guard) from the runner's coordinator-built session bundle.
    structuredSlotSeam.createContext = (input) => this.runner.createStructuredSlotContext(input);
    // Structural wiring (Task 19): a custom/scripted runtime exposing
    // `setStructuredSlotProvider` receives the SAME per-turn structured slot
    // context provider the Pi adapter gets — the identical sealed coordinator/
    // session bundle, never a second default (design O05). The check stays
    // structural so this module never imports the concrete runtime.
    const structuredProviderTarget = this.runtime as Partial<{
      setStructuredSlotProvider?: (
        provider: (input: AgentTurnInput) => Promise<StructuredSlotRuntimeContext | null>,
      ) => void;
    }>;
    if (typeof structuredProviderTarget.setStructuredSlotProvider === 'function') {
      structuredProviderTarget.setStructuredSlotProvider((input) =>
        this.runner.createStructuredSlotContext(input),
      );
    }
    this.scheduler = new TaskScheduler({
      service: this,
      runner: this.runner,
      runtime: this.runtime,
      runtimeEnvironment: this.runtimeEnvironment,
      ...(options.acceptanceStopAfterCommit !== undefined
        ? { acceptanceStopAfterCommit: options.acceptanceStopAfterCommit }
        : {}),
    });
  }

  async initialize(): Promise<void> {
    await this.templates.initialize();
  }

  /** Creates a frozen task from a validated request (delegates to TaskStore). */
  createTask(request: CreateTaskRequest): Promise<CreatedTask> {
    return this.tasks.create(request);
  }

  /**
   * Lists every task projected from its committed state. Per-task try/catch
   * isolates corruption: a damaged task summarizes to `status: 'corrupt'`
   * with a public diagnostic and never escapes as a throw (spec §8.3).
   */
  async listTasks(): Promise<TaskSummary[]> {
    const ids = await this.tasks.listTaskIds();
    const summaries: TaskSummary[] = [];
    for (const id of ids) {
      try {
        summaries.push((await this.projectTask(id)).task);
      } catch {
        summaries.push(await this.corruptSummary(id));
      }
    }
    summaries.sort((a, b) =>
      a.updatedAt !== b.updatedAt
        ? a.updatedAt < b.updatedAt
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
    return summaries;
  }

  /** Projects one task; storage errors propagate to the caller unmapped. */
  async getWorkspace(taskId: string): Promise<TaskWorkspace> {
    return this.projectTask(taskId);
  }

  /**
   * Reads one committed turn trace (display only, plan Phase E Task 3). Task
   * identity is checked first so unknown/corrupt tasks surface their public
   * storage codes; a healthy task without the trace resolves to null.
   */
  async getTurnTrace(taskId: string, turnId: string): Promise<TurnTrace | null> {
    await this.tasks.readTaskRecord(taskId);
    return this.traces.readTurnTrace(taskId, turnId);
  }

  /**
   * Reads one declared Skill's snapshot content for display (plan Phase E
   * Task 3). Task identity is checked first; unknown skills resolve to null.
   */
  async getSkillContent(taskId: string, skillId: string): Promise<SkillContent | null> {
    await this.tasks.readTaskRecord(taskId);
    return this.skills.readSkillForDisplay(taskId, skillId);
  }

  /**
   * Public contract projection of the frozen structured-slot contract (spec
   * §14 / I02). Executes as the built-in `task_owner` subject and NEVER
   * includes implementation paths, validator/Assembler registrations,
   * accessProfiles (ACL) or the resource manifest (host paths). Basic tasks
   * reject with STRUCTURED_NOT_ACTIVE; runtime-unavailable snapshots surface
   * the stable TEMPLATE_RUNTIME_UNAVAILABLE.
   */
  async getStructuredContract(taskId: string): Promise<StructuredSlotPublicContractV1> {
    const context = await this.structuredReadContext(taskId);
    return projectPublicContract(context.contract);
  }

  /**
   * Paged owner outline (spec §14 / design §10.6). The owner sees every formal
   * slot/spec/content of the active scaffold; the cursor binds generation,
   * revision, the owner projection identity and document order — a stale or
   * forged cursor is a stable CURSOR_INVALID. Never reveals hidden totals.
   */
  async listStructuredSlots(
    taskId: string,
    cursor: StructuredSlotTreeCursorV1 | null,
    limit: number,
  ): Promise<StructuredSlotOutlinePageV1> {
    const context = await this.structuredReadContext(taskId);
    const result = await context.projection.listSlots({ kind: 'task_owner' }, cursor, limit);
    if (!result.ok) {
      throw structuredReadFailure(result.code, result.reason);
    }
    return { entries: result.entries, nextCursor: result.nextCursor };
  }

  /**
   * The authorized owner projection of one slot. Missing and hidden slots
   * return the IDENTICAL stable SLOT_NOT_VISIBLE envelope (D05 — no slotId
   * echo). A visible deep node is padded with its ancestor outline shell.
   */
  async getStructuredSlot(taskId: string, slotId: string): Promise<StructuredSlotReadResponseV1> {
    const context = await this.structuredReadContext(taskId);
    const result = await context.projection.readSlot({ kind: 'task_owner' }, slotId);
    if (!result.ok) {
      throw structuredReadFailure(result.code, result.reason);
    }
    return { slot: result.slot };
  }

  /**
   * Paged owner-visible issues (spec §14 / F06). Issues are folded from
   * authoritative structured events and projected through the closed registry
   * pipeline with owner visibility (all location kinds); private Draft/Proposal
   * journals are never read. The cursor binds the same generation/revision/
   * projection identity as the tree outline.
   */
  async listStructuredIssues(
    taskId: string,
    cursor: StructuredSlotTreeCursorV1 | null,
    limit: number,
  ): Promise<StructuredIssuePageV1> {
    const context = await this.structuredReadContext(taskId);
    const events = (await this.events.read(taskId)).map((entry) => entry.event);
    const issues = deriveOwnerIssues(events);
    const errors = issues.filter((issue) => issue.severity === 'error').length;
    const verdict = projectStructuredVerdict(
      {
        version: 1,
        status: errors > 0 ? 'failed' : 'passed',
        issues,
        truncated: false,
        summary: { errors, warnings: issues.length - errors },
      },
      { visibleLocationKinds: ALL_LOCATION_KINDS },
    );
    const sorted = verdict.issues;

    if (limit < 1) {
      throw structuredReadFailure('CURSOR_INVALID', 'limit must be a positive safe integer');
    }
    const identity = {
      generationId: context.state.generationId,
      revision: context.state.contentRevision,
      projectionHash: OWNER_PROJECTION_HASH,
    };
    let start = 0;
    if (cursor !== null) {
      const invalid = validateIssueCursor(identity, cursor, this.signerFor(taskId), sorted);
      if (invalid !== null) {
        throw structuredReadFailure('CURSOR_INVALID', invalid);
      }
      const lastKey = cursor.lastDocumentKey;
      const index = sorted.findIndex((issue, index) => issueCursorKey(issue, index) === lastKey);
      if (index === -1) {
        throw structuredReadFailure('CURSOR_INVALID', 'cursor does not belong to this issue projection');
      }
      start = index + 1;
    }
    const page = sorted.slice(start, start + limit);
    const hasMore = start + limit < sorted.length;
    let nextCursor: StructuredSlotTreeCursorV1 | null = null;
    if (hasMore && page.length > 0) {
      const lastIndex = start + page.length - 1;
      const payload = issueCursorPayload(identity, issueCursorKey(page[page.length - 1], lastIndex));
      nextCursor = {
        version: 1,
        generationId: identity.generationId ?? '',
        revision: identity.revision ?? 0,
        projectionHash: identity.projectionHash,
        lastDocumentKey: issueCursorKey(page[page.length - 1], lastIndex),
        orderingVersion: 1,
        signature: this.signerFor(taskId).sign(canonicalJson(payload)),
      };
    }
    return { issues: page, nextCursor };
  }

  /**
   * The immutable SealRecord of the active sealed scaffold (design §17.2).
   * The owner reads the content-addressed seal-record blob referenced by the
   * committed `structured_scaffold_sealed` event — never a staging path.
   * Unsealed scaffolds reject with the stable SEAL_NOT_FOUND.
   */
  async getStructuredSeal(taskId: string): Promise<SealRecord> {
    const context = await this.structuredReadContext(taskId);
    const events = (await this.events.read(taskId)).map((entry) => entry.event);
    let sealEvent: Extract<TaskEvent, { type: 'structured_scaffold_sealed' }> | null = null;
    for (const event of events) {
      if (event.type === 'structured_scaffold_sealed') {
        sealEvent = event;
      }
    }
    if (sealEvent === null) {
      throw new StructuredSlotReadError(
        'SEAL_NOT_FOUND',
        '该任务尚未封存，没有 SealRecord。',
        'CoreService.structuredRead',
        '等待封存完成后重试。',
      );
    }
    // The committed ref must be a seal_record blob (guards a future committer
    // bug that points the seal event at a non-seal blob), and the blob bytes
    // must satisfy the exact SealRecord schema — the server fails closed
    // rather than emitting unvalidated bytes.
    if (sealEvent.sealRecord.kind !== 'seal_record') {
      throw new StructuredSlotReadError(
        'SEAL_NOT_FOUND',
        '封存记录引用无效。',
        'CoreService.structuredRead',
        '联系平台检查该任务的封存记录。',
      );
    }
    let bytes: Buffer;
    try {
      bytes = await context.blobStore.readBlob(sealEvent.sealRecord.sha256);
    } catch {
      throw new StructuredSlotReadError(
        'SEAL_NOT_FOUND',
        '封存记录不可读。',
        'CoreService.structuredRead',
        '联系平台检查该任务的封存记录。',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new StructuredSlotReadError(
        'SEAL_NOT_FOUND',
        '封存记录格式无效。',
        'CoreService.structuredRead',
        '联系平台检查该任务的封存记录。',
      );
    }
    if (!Value.Check(structuredSealRecordSchema, parsed)) {
      throw new StructuredSlotReadError(
        'SEAL_NOT_FOUND',
        '封存记录不符合契约。',
        'CoreService.structuredRead',
        '联系平台检查该任务的封存记录。',
      );
    }
    return parsed as SealRecord;
  }

  /**
   * Clones one task with the same frozen input on the CURRENT template
   * version (plan Phase E Task 3, Global Constraint 12): a fresh frozen task
   * named `<source name>（重跑）` (120-code-point bound). The source task is
   * never modified.
   */
  async cloneTask(taskId: string): Promise<TaskSummary> {
    const record = await this.tasks.readTaskRecord(taskId);
    const created: CreatedTask = await this.tasks.create({
      templateId: record.templateId,
      name: buildCloneName(record.name),
      input: { ...record.frozenInput },
    });
    const { templateVersion: _templateVersion, ...summary } = created;
    return summary;
  }

  /**
   * Permanently deletes one task in ANY status (task list delete): when the
   * task holds the single execution slot the run is aborted and its disposal
   * awaited first, so no execution survives; then the whole task directory
   * (frozen record, snapshot, events, artifacts, traces, workspaces) is
   * removed and the in-memory live buffer cleared. Corrupt tasks delete the
   * same way; unknown ids reject with the public TASK_NOT_FOUND code.
   */
  async deleteTask(taskId: string): Promise<void> {
    await this.scheduler.releaseIfRunning(taskId);
    await this.tasks.deleteTask(taskId);
    this.live.clear(taskId);
  }

  /** Lifecycle delegation to the one-slot scheduler (plan Phase C Task 4). */
  startTask(taskId: string): Promise<TaskSummary> {
    return this.scheduler.start(taskId);
  }

  stopTask(taskId: string): Promise<TaskSummary> {
    return this.scheduler.stop(taskId);
  }

  resumeTask(taskId: string): Promise<TaskSummary> {
    return this.scheduler.resume(taskId);
  }

  retryTask(taskId: string): Promise<TaskSummary> {
    return this.scheduler.retry(taskId);
  }

  answerHuman(taskId: string, answer: string | HumanAnswerRequest): Promise<TaskSummary> {
    return this.scheduler.answer(taskId, answer);
  }

  /** Stops the scheduler (abort + bounded disposal + interruption marking). */
  shutdown(): Promise<void> {
    return this.scheduler.shutdown();
  }

  /** Test-only: appends one canonical event (Phase C committer owns real appends). */
  appendTestEvent(taskId: string, event: TaskEvent): Promise<CommittedEvent> {
    return this.events.append(taskId, event);
  }

  /**
   * Test-only: publishes one artifact version and records the matching
   * `artifact_published` event, so seeded tasks carry the same history the
   * Phase C committer will produce.
   */
  async publishTestArtifact(taskId: string, proposal: ArtifactProposal): Promise<ArtifactVersion> {
    const published = await this.artifacts.publish(taskId, proposal);
    // Record the event BEFORE reading back: the store cross-checks disk
    // files against the committed event (spec §8), so the event must exist.
    await this.events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'artifact_published',
      artifact: {
        version: published.version,
        title: published.title,
        sourceNodeId: published.sourceNodeId,
        format: published.format,
        files: published.files,
        artifactType: null,
        artifactId: published.id,
      },
    });
    const entry = await this.artifacts.read(taskId, published.version);
    return {
      id: published.id,
      version: published.version,
      title: published.title,
      files: entry.files.map((file) => ({
        name: file.name,
        extract: 'content',
        content: file.content,
      })),
      sourceNodeId: published.sourceNodeId,
      createdAt: published.createdAt,
      final: false,
    };
  }

  /** Reads identity + snapshot + events + artifacts and folds them. */
  private async projectTask(taskId: string): Promise<TaskWorkspace> {
    const record = await this.tasks.readTaskRecord(taskId);
    const frozenTemplate = await this.tasks.readFrozenTemplate(taskId);
    const committed = await this.events.read(taskId);
    const artifacts = await this.artifacts.list(taskId);
    const events = committed.map((entry) => entry.event);
    const workspace = projectTask(
      { record, frozenTemplate },
      events,
      artifacts,
      // Exact filled-slot count from the ACTIVE generation's content root
      // (design §18.3 authoritative events + verifiable blob projection). Null
      // when none committed or unreadable → the summary reports 0 filled.
      await this.structuredContentRootFor(taskId, frozenTemplate, events),
    );
    // Live-preview attachment (plan C): the in-memory buffer, when present,
    // rides along as activeTurn. Never persisted; display only.
    workspace.activeTurn = this.live.get(taskId);
    return this.enrichSkillNodeBodies(taskId, workspace);
  }

  /**
   * Resolves the active generation's content root mapping from the content
   * root blob referenced by the authoritative events (design §18.3). Returns
   * null for basic templates, pre-scaffold tasks and unreadable/malformed
   * roots — the summary then reports 0 filled. This is a display projection
   * and never embeds content values (only slotId -> presence/digest).
   */
  private async structuredContentRootFor(
    taskId: string,
    frozen: FrozenTemplate,
    events: readonly TaskEvent[],
  ): Promise<Record<string, 'unset' | string> | null> {
    if (frozen.productionMode !== 'structured_slots' || frozen.structuredSlots === null) {
      return null;
    }
    const state = projectStructuredSlotState(events);
    if (state.content === null) {
      return null;
    }
    // The content root lives under content-revisions/ (not the generic blobs
    // dir); read + re-hash it so the projection is verifiable (design §18.3).
    let bytes: Buffer;
    try {
      bytes = await readFile(
        this.paths.taskStructuredContentRevisionFile(taskId, state.content.sha256),
      );
    } catch {
      return null;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== state.content.sha256) {
      return null;
    }
    let root: unknown;
    try {
      root = JSON.parse(bytes.toString('utf8'));
    } catch {
      return null;
    }
    if (typeof root !== 'object' || root === null) {
      return null;
    }
    const mappings = (root as { version?: unknown; mappings?: unknown }).mappings;
    if (typeof mappings !== 'object' || mappings === null) {
      return null;
    }
    const out: Record<string, 'unset' | string> = {};
    for (const [slotId, value] of Object.entries(mappings as Record<string, unknown>)) {
      if (value === 'unset' || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))) {
        out[slotId] = value;
      }
    }
    return out;
  }

  /** The ONE cursor signer per task (Task 10 note). */
  private signerFor(taskId: string): TaskLocalCursorSigner {
    const cached = this.structuredCursorSigners.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    const signer = createTaskLocalCursorSigner(taskId);
    this.structuredCursorSigners.set(taskId, signer);
    return signer;
  }

  /**
   * Builds the owner read context: the frozen structured template/contract,
   * the same authorized projection service Agent grants use (spec §14), and
   * the task's structured state. Basic tasks reject with STRUCTURED_NOT_ACTIVE;
   * storage identity failures propagate their public codes.
   */
  private async structuredReadContext(taskId: string): Promise<{
    contract: FrozenStructuredSlotContractV1;
    projection: StructuredSlotProjectionService;
    blobStore: StructuredSlotBlobStore;
    state: ReturnType<typeof projectStructuredSlotState>;
  }> {
    const frozen = await this.tasks.readFrozenTemplate(taskId);
    if (frozen.productionMode !== 'structured_slots' || frozen.structuredSlots === null) {
      throw new StructuredSlotReadError(
        'STRUCTURED_NOT_ACTIVE',
        '该任务未启用结构槽。',
        'CoreService.structuredRead',
        '查看基本任务画布。',
      );
    }
    const blobStore = new StructuredSlotBlobStore(this.paths, taskId);
    const events = async (): Promise<readonly TaskEvent[]> =>
      (await this.events.read(taskId)).map((entry) => entry.event);
    const source: StructuredSlotDataSource = createStructuredSlotDataSource({ blobStore, events });
    const projection = new StructuredSlotProjectionService({
      contract: frozen.structuredSlots,
      source,
      signer: this.signerFor(taskId),
    });
    const state = projectStructuredSlotState(await events());
    return { contract: frozen.structuredSlots, projection, blobStore, state };
  }

  /**
   * Replaces each skill node body with the loaded content's display version
   * hash (first 12 hex characters, template-version display policy); any
   * failure keeps the skillId body (plan Phase E Task 3).
   */
  private async enrichSkillNodeBodies(taskId: string, workspace: TaskWorkspace): Promise<TaskWorkspace> {
    for (const node of workspace.nodes) {
      if (node.kind !== 'skill') {
        continue;
      }
      try {
        const loaded = await this.skills.loadedSkillsFor(taskId, node.agentId);
        const match = loaded.find((skill) => skill.id === node.title);
        if (match !== undefined) {
          node.body = match.versionHash.slice(0, 12);
        }
      } catch {
        // Display enrichment only: the skillId body stays on any failure.
      }
    }
    return workspace;
  }

  /** Builds the public `corrupt` summary; keeps any readable identity. */
  private async corruptSummary(taskId: string): Promise<TaskSummary> {
    let name = taskId;
    let templateId = '';
    let templateName = '';
    let updatedAt: string;
    try {
      const record = await this.tasks.readTaskRecord(taskId);
      name = record.name;
      templateId = record.templateId;
      templateName = record.templateName;
      updatedAt = record.createdAt;
    } catch {
      // Identity unreadable: fall back to the directory name and mtime.
      try {
        updatedAt = (await stat(this.paths.taskRoot(taskId))).mtime.toISOString();
      } catch {
        updatedAt = new Date().toISOString();
      }
    }
    return {
      id: taskId,
      name,
      templateId,
      templateName,
      status: 'corrupt',
      currentAgentName: null,
      latestVersion: null,
      updatedAt,
      diagnostic: '任务数据损坏，需要人工检查任务目录。',
      // No frozen snapshot identity is readable on a corrupt task: the
      // protocol fails closed to 'none' and never guesses v2 (spec §4.1).
      structuredProtocol: 'none',
    };
  }
}

export function createCoreService(paths: CorePaths, options: CoreServiceOptions = {}): CoreService {
  return new CoreService(paths, options);
}

/* ------------------- owner structured-slot read helpers (spec §14) ------------------- */

/** The owner projection identity hash (matches the projection service formula). */
const OWNER_PROJECTION_HASH = canonicalJsonSha256({ subject: 'task_owner' });

/** Stable public envelope for the projection failures the owner can hit. */
function structuredReadFailure(code: ProjectionErrorCode, _reason: string): StructuredSlotReadError {
  if (code === 'SLOT_NOT_VISIBLE') {
    // D05: identical for missing and hidden; never echoes the slotId.
    return new StructuredSlotReadError(
      'SLOT_NOT_VISIBLE',
      '槽位不可见。',
      'CoreService.structuredRead',
      '从树形大纲中选择可见槽位。',
    );
  }
  if (code === 'CURSOR_INVALID') {
    return new StructuredSlotReadError(
      'CURSOR_INVALID',
      '分页游标已失效，请从第一页重新读取。',
      'CoreService.structuredRead',
      '返回第一页重试。',
    );
  }
  // The owner subject is fixed at `task_owner`, so agent-only failures
  // (GRANT_INVALID / GRANT_STALE / UNKNOWN_SUBJECT) are unreachable here. Fail
  // closed with the stable internal envelope rather than leaking a reason.
  return new StructuredSlotReadError(
    'CURSOR_INVALID',
    '分页游标已失效，请从第一页重新读取。',
    'CoreService.structuredRead',
    '返回第一页重试。',
  );
}

/** Issue-page cursor key: (phase, code, index) — stable sorted position. */
function issueCursorKey(issue: StructuredIssueV1, index: number): string {
  return `${issue.phase}|${issue.code}|${index}`;
}

/** Canonical signed payload binding the owner issue projection identity. */
function issueCursorPayload(
  identity: { generationId: string | null; revision: number | null; projectionHash: string },
  lastDocumentKey: string | null,
): Record<string, unknown> {
  return {
    version: 1,
    generationId: identity.generationId,
    revision: identity.revision,
    projectionHash: identity.projectionHash,
    lastDocumentKey,
    orderingVersion: 1,
    subject: 'task_owner',
  };
}

/** Validates an issue cursor against the current projection identity. */
function validateIssueCursor(
  identity: { generationId: string | null; revision: number | null; projectionHash: string },
  cursor: StructuredSlotTreeCursorV1,
  signer: TaskLocalCursorSigner,
  sorted: readonly StructuredIssueV1[],
): string | null {
  if (cursor.version !== 1 || cursor.orderingVersion !== 1) {
    return 'unsupported cursor version';
  }
  if (cursor.generationId !== (identity.generationId ?? '')) {
    return 'cursor is bound to a different generation';
  }
  if (cursor.revision !== (identity.revision ?? 0)) {
    return 'cursor is bound to a different revision';
  }
  if (cursor.projectionHash !== identity.projectionHash) {
    return 'cursor is bound to a different projection';
  }
  if (
    cursor.lastDocumentKey !== null &&
    !sorted.some((issue, index) => issueCursorKey(issue, index) === cursor.lastDocumentKey)
  ) {
    return 'cursor references an unknown issue position';
  }
  const payload = issueCursorPayload(identity, cursor.lastDocumentKey);
  if (!signer.verify(canonicalJson(payload), cursor.signature)) {
    return 'cursor signature is invalid';
  }
  return null;
}

/** Serializes one compiled slot schema, dropping the internal hash fields. */
function serializeSchema(schema: CompiledSlotSchemaV1): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '_enumHashes' || key === '_constHash') continue;
    if (key === 'pattern' && value !== undefined) {
      const compiled = value as { pattern: string; sourceLength: number };
      out[key] = { pattern: compiled.pattern, sourceLength: compiled.sourceLength };
      continue;
    }
    if (key === 'properties' && value !== undefined) {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, CompiledSlotSchemaV1>)) {
        properties[name] = serializeSchema(child);
      }
      out[key] = properties;
      continue;
    }
    if (key === 'items' && value !== undefined) {
      out[key] = serializeSchema(value as CompiledSlotSchemaV1);
      continue;
    }
    if (key === 'additionalProperties' && value !== undefined && typeof value === 'object') {
      out[key] = serializeSchema(value as CompiledSlotSchemaV1);
      continue;
    }
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as JsonObject;
}

/** Serializes the compiled grammar: sets to arrays, drops the internal matcher. */
function serializeGrammar(
  grammar: CompiledLayoutGrammarV1,
): StructuredSlotPublicContractV1['layoutGrammar'] {
  const productions: StructuredSlotPublicContractV1['layoutGrammar']['productions'] = {};
  for (const [typeId, production] of Object.entries(grammar.productions)) {
    productions[typeId] = {
      children: production.children as JsonObject,
      nullable: production.nullable,
      minConsumption: production.minConsumption,
      maxConsumption: production.maxConsumption,
      first: [...production.first],
      generatable: production.generatable,
    };
  }
  return { rootType: grammar.rootType, productions };
}

/**
 * The owner contract projection: slot types (serialized schemas), the layout
 * grammar, the frozen limits and the ABI/profile identity. Implementation
 * paths, validator/Assembler registrations, accessProfiles and the resource
 * manifest are NEVER included (I02/I05).
 */
function projectPublicContract(contract: FrozenStructuredSlotContractV1): StructuredSlotPublicContractV1 {
  return {
    version: 1,
    slotTypes: contract.slotTypes.map((slotType) => ({
      id: slotType.id,
      name: slotType.name,
      description: slotType.description,
      specSchema: serializeSchema(slotType.specSchema),
      content:
        slotType.content.presence === 'forbidden'
          ? { presence: 'forbidden' as const }
          : { presence: slotType.content.presence, schema: serializeSchema(slotType.content.schema) },
    })),
    layoutGrammar: serializeGrammar(contract.layoutGrammar),
    limits: contract.limits,
    abiProfileIdentity: contract.abiProfileIdentity,
    semanticDigest: contract.semanticDigest,
  };
}
