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
import { structuredProtocolOf } from '../shared/authoritative-review-v2';
import { ReviewCursorKeyring } from './storage/review-cursor-keyring';
import type { TaskEvent } from './storage/task-events';
import { StructuredSlotBlobStore } from './storage/structured-slot-blob-store';
import { projectStructuredSlotState } from './storage/structured-slot-state';
import { TraceStore } from './storage/trace-store';
import { TemplateCatalog } from './template/template-catalog';
import type { StructuredRuntimeEnvironmentV1 } from './structured-slots/runtime-capability';
import {
  createProductionAuthoritativeReviewEnvironment,
  currentAuthoritativeReviewProfileDigest,
  deriveAuthoritativeReviewExecutionEligibility,
  requiredAuthoritativeReviewAbiAvailable,
  type AuthoritativeReviewRuntimeEnvironmentV1,
} from './structured-slots/authoritative-review-capability';
import { RuntimeFailure, type AgentRuntime, type AgentTurnInput } from './runtime/agent-runtime';
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
import {
  AuthoritativeV2SchedulingEngine,
  TaskScheduler,
  type HumanAnswerRequest,
} from './runtime/task-scheduler';
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
import { AuthoritativeTaskIndexV1 } from './storage/authoritative-task-index';
import { AuthoritativeTaskDeletionV2, type DeleteTaskRequestV2 } from './storage/authoritative-task-deletion';
import { AuthoritativeWakeupIndexV1 } from './runtime/authoritative-review/wakeup-index';
import { AuthoritativeReviewBlobStore } from './storage/authoritative-review-blob-store';
import { AuthoritativePublicationStore } from './storage/authoritative-publication-store';
import { AuthoritativeAppendFacadeV2 } from './storage/authoritative-append-facade';
import {
  AuthoritativeReviewCheckpointStore,
  type ValidatedEventSource,
} from './storage/authoritative-review-checkpoint-store';
import {
  ProjectionCorruptionError,
  projectAuthoritativeReviewStateSync,
} from './storage/authoritative-review-state';
import type { AuthoritativeReviewEventV2 } from './storage/authoritative-review-events';
import { runStartupRecoveryV2, recoverySummaryOf } from './runtime/authoritative-review/startup-recovery';
import {
  TaskLifecycleServiceV2,
  failedRecoverySummaryResolved,
  type FrozenTaskProfileV2,
  type ReopenRequestV2,
} from './runtime/authoritative-review/task-lifecycle';
import { WorkItemCoordinatorV2 } from './runtime/authoritative-review/work-item-coordinator';
import {
  installAuthoritativeReviewRuntime,
  type AuthoritativeReviewCompositionV2,
} from './runtime/authoritative-review/production-composition';
import { V2AssignmentRunner } from './runtime/authoritative-review/assignment-runner';
import type { BlobRefV2, AuthoritativeReviewExecutionEligibilityV1 } from '../shared/authoritative-review-v2';
import { STORAGE_ERROR_CODES, StorageError } from './storage/atomic-file';
import type { PublicationOperationPayloadV2 } from './authoritative-review/authority-types';
import type { AuthoritativeReviewProjectionV2 } from './storage/authoritative-review-state';
import type {
  AuthoritativeCandidateDetailV2,
  AuthoritativeFindingSummaryV2,
  AuthoritativeLocateResultV2,
  AuthoritativeMapDetailV2,
  AuthoritativeRelationReviewDetailV2,
  AuthoritativeReviewRoundSummaryV2,
  AuthoritativeReviewSummaryV2,
  AuthoritativeSealReadinessDetailV2,
  AuthoritativeSlotReviewDetailV2,
  AuthoritativeTreePageV2,
  CollectionPageV2,
  DeleteTaskBodyV2,
  DeleteTaskResultV2,
  ReopenFailedRequestV2,
  SnapshotCursorV2,
} from '../shared/authoritative-review-v2';
import { defaultMaxBytesByKind } from './authoritative-review/object-schemas';
import type { AuthoritativeReviewProfile } from './authoritative-review/authority-types';
import {
  AuthoritativeReviewProjectionService,
  AuthoritativeReviewReadError,
} from './runtime/authoritative-review/projection-service';

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
   * The ONE authoritative review runtime environment (spec §17 / design O05,
   * Task 5): threaded from production manifest load in main.ts through the
   * Catalog, cache, TaskStore snapshot reopen, scheduler, runner and every v2
   * service. Defaults to the checked-in disabled production manifest; no
   * module may re-read a default or build a second environment.
   */
  authoritativeReviewEnvironment?: AuthoritativeReviewRuntimeEnvironmentV1;
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
   * The ONE authoritative review runtime environment (spec §17, Task 5): the
   * same immutable reference the TemplateCatalog holds, threaded into the
   * Scheduler/Runner for the v2 dispatch gates. No module may accept a second
   * independently constructed environment.
   */
  readonly authoritativeReviewEnvironment: AuthoritativeReviewRuntimeEnvironmentV1;

  /**
   * Memory-only live-preview buffer behind `TaskWorkspace.activeTurn` (plan
   * C realtime streaming). Strictly in-memory: streamed thinking/text never
   * touches files or events.
   */
  readonly live: LiveStore;

  /**
   * ONE installation-persistent cursor signing keyring for the v2 read APIs
   * (spec §14.2, Task 9): cursors carry `keyId`, retired keys verify through
   * the frozen retention window, and the v1 in-memory task-local signer stays
   * v1-only and untouched (Task 11 reads it for the v2 snapshot cursors).
   */
  readonly cursorKeyring: ReviewCursorKeyring;

  /**
   * ONE cursor signer per task (Task 10 note): the projection service binds
   * every cursor to a task-local in-memory HMAC secret, so pagination stays
   * coherent across REST requests and a process restart invalidates held
   * cursors (fail closed).
   */
  private readonly structuredCursorSigners = new Map<string, TaskLocalCursorSigner>();

  /* ------------------- Task 11 v2 lifecycle stack (spec §10.5/§14.3) ------------------- */

  /** The ONE installation task index (sole ID/root registry, §10.5). */
  readonly v2Index: AuthoritativeTaskIndexV1;

  /** The fenced v2 deletion engine (prepared→detached→purged tombstones). */
  readonly v2Deletion: AuthoritativeTaskDeletionV2;

  /** The durable per-task wakeup index (§10.4). */
  readonly v2Wakeups: AuthoritativeWakeupIndexV1;

  /** The ONE v2 append facade (every v2 write goes through it, §8). */
  readonly v2Facade: AuthoritativeAppendFacadeV2;

  /** The checkpoint-backed v2 projection store (§9.4). */
  readonly v2CheckpointStore: AuthoritativeReviewCheckpointStore;

  /** The Task 10 WorkItem coordinator. */
  readonly v2Coordinator: WorkItemCoordinatorV2;

  /** The v2 lifecycle dispatcher (start/stop/resume/retry/answer/reopen). */
  readonly v2Lifecycle: TaskLifecycleServiceV2;

  /** The deterministic v2 scheduling engine (§10.4 — the v2 loop). */
  readonly v2Scheduling: AuthoritativeV2SchedulingEngine;

  /**
   * Task 21 P1#1: the production composition root — the SIX real system-command
   * handlers (the seal is ALWAYS the real SystemSealServiceV2; the five domain
   * handlers are installed as their services are wired), the attempt
   * coordinator that EXECUTES leased work items, and the scheduling tick that
   * runs pass + executeLeased after every v2 mutation (the pass-only driver
   * below never executed anything). Dormant while the authoritative capability
   * is disabled — nothing is leased/executed.
   */
  readonly v2Composition: AuthoritativeReviewCompositionV2;

  private readonly v2PublicationStore: AuthoritativePublicationStore;

  readonly v2BlobStore: AuthoritativeReviewBlobStore;

  constructor(paths: CorePaths, options: CoreServiceOptions = {}) {
    this.paths = paths;
    // The catalog owns ONE structured runtime environment; TaskStore derives
    // it from the catalog and the Scheduler/Runner reuse the same reference
    // (design O05). The authoritative review environment follows the exact
    // same discipline (spec §17, Task 5).
    this.templates = new TemplateCatalog(paths, {
      runtimeEnvironment: options.runtimeEnvironment,
      authoritativeReviewEnvironment: options.authoritativeReviewEnvironment,
    });
    this.runtimeEnvironment = this.templates.runtimeEnvironment;
    this.authoritativeReviewEnvironment = this.templates.authoritativeReviewEnvironment;
    this.events = new EventStore(paths);
    // Task 11 v2 stack. Construction performs no IO; the fence is the SAME
    // installation store lock the facade/GC/delete share. The v2 profile the
    // blob store/facade size against is the CURRENT authoritative profile's
    // runtime group (its maxBytesByKind); while the capability is disabled
    // (production default) the registry's platform defaults apply and the
    // whole stack simply idles — no v2 rows, no pins, no wakeups.
    this.v2Wakeups = new AuthoritativeWakeupIndexV1({ paths });
    this.v2PublicationStore = new AuthoritativePublicationStore(paths);
    const v2Clock = (): string => new Date().toISOString();
    const withStoreFence = async <T>(fn: () => Promise<T>): Promise<T> => {
      const hold = await this.v2PublicationStore.lock().acquire();
      try {
        return await fn();
      } finally {
        await hold.release();
      }
    };
    this.v2Index = new AuthoritativeTaskIndexV1({ paths, withStoreFence, clock: v2Clock });
    this.v2Deletion = new AuthoritativeTaskDeletionV2({
      paths,
      index: this.v2Index,
      wakeups: this.v2Wakeups,
      withStoreFence,
      snapshotPins: () => this.v2PublicationStore.snapshotPins(),
      clock: v2Clock,
    });
    const reviewProfile = this.authoritativeReviewEnvironment.profile;
    const v2Profile: AuthoritativeReviewProfile =
      reviewProfile === null
        ? ({ maxBytesByKind: defaultMaxBytesByKind() } as AuthoritativeReviewProfile)
        : (reviewProfile.runtime as unknown as AuthoritativeReviewProfile);
    this.v2BlobStore = new AuthoritativeReviewBlobStore(paths, v2Profile);
    this.v2Facade = new AuthoritativeAppendFacadeV2({
      eventStore: this.events,
      blobStore: this.v2BlobStore,
      publicationStore: this.v2PublicationStore,
      profile: v2Profile,
      paths,
      clock: v2Clock,
    });
    const v2EventSource: ValidatedEventSource = {
      read: async (taskId) =>
        (await this.events.read(taskId)).map((entry) => ({
          sequence: entry.sequence,
          fileName: entry.fileName,
          size: entry.size,
          event: entry.event as never,
        })),
      readAfter: async (taskId, throughSequence) =>
        (await this.events.readAfter(taskId, throughSequence)).map((entry) => ({
          sequence: entry.sequence,
          fileName: entry.fileName,
          size: entry.size,
          event: entry.event as never,
        })),
    };
    this.v2CheckpointStore = new AuthoritativeReviewCheckpointStore(paths, v2EventSource);
    const resolver = (taskId: string, ref: BlobRefV2): Promise<unknown> =>
      this.v2BlobStore.readJson(taskId, ref, ref.kind);
    this.v2Coordinator = new WorkItemCoordinatorV2({
      facade: this.v2Facade,
      checkpointStore: this.v2CheckpointStore,
      resolver,
      tail: (taskId) => this.events.tail(taskId),
      committedOperation: async (taskId, operationId) => {
        const committed = await this.events.readBatchByCommitId(taskId, operationId);
        return committed === null
          ? null
          : committed.map((entry) => ({ sequence: entry.sequence, event: entry.event }));
      },
      clock: v2Clock,
      leaseDurationMs: 30 * 60 * 1000,
    });
    this.v2Lifecycle = new TaskLifecycleServiceV2({
      facade: this.v2Facade,
      checkpointStore: this.v2CheckpointStore,
      resolver,
      tail: (taskId) => this.events.tail(taskId),
      committedOperation: async (taskId, operationId) => {
        const committed = await this.events.readBatchByCommitId(taskId, operationId);
        return committed === null
          ? null
          : committed.map((entry) => ({ sequence: entry.sequence, event: entry.event }));
      },
      events: async (taskId) =>
        (await this.events.read(taskId)).map((entry) => ({
          sequence: entry.sequence,
          fileName: entry.fileName,
          event: entry.event,
        })),
      clock: v2Clock,
      leaseDurationMs: 30 * 60 * 1000,
      coordinator: this.v2Coordinator,
      wakeups: this.v2Wakeups,
      deletion: this.v2Deletion,
      eligibility: (frozenProfileDigest) => this.executionEligibilityOf(frozenProfileDigest),
      frozenProfile: (taskId) => this.frozenProfileV2(taskId),
      orchestratorRoleBinding: (taskId) => this.frozenRoleBinding(taskId, 'orchestrator'),
      repairRoleBinding: (taskId, session) =>
        this.frozenRoleBindingV2(taskId, session === 'map_repair' ? 'mapRepair' : 'contentRepair'),
      defaultAutomaticRetries: (taskId) => this.frozenAutomaticRetries(taskId),
    });
    this.v2Scheduling = new AuthoritativeV2SchedulingEngine({
      index: this.v2Index,
      deletion: this.v2Deletion,
      wakeups: this.v2Wakeups,
      lifecycle: this.v2Lifecycle,
      coordinator: this.v2Coordinator,
      checkpointStore: this.v2CheckpointStore,
      resolver,
      eligibility: (frozenProfileDigest) => this.executionEligibilityOf(frozenProfileDigest),
      frozenProfileDigest: async (taskId) => (await this.frozenProfileV2(taskId)).profileDigest,
      clock: v2Clock,
      // The fixed local owner principal leases v2 work; Task 12's
      // attempt-coordinator replaces the claim with the executing worker.
      leaseOwner: 'task_owner',
    });
    this.tasks = new TaskStore(paths, this.templates, this.v2Index);
    // P1#4: the artifact store resolves v2 provenance blobs through the SAME
    // content-addressed blob store (never the v1 path); the closure cross-check
    // only fires for system_seal_v2 meta. v2BlobStore is constructed above.
    this.artifacts = new ArtifactStore(paths, this.events, (taskId, ref) =>
      this.v2BlobStore.readJson(taskId, ref, ref.kind),
    );
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
    this.cursorKeyring = new ReviewCursorKeyring(paths);
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
      authoritativeReviewEnvironment: this.authoritativeReviewEnvironment,
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
      authoritativeReviewEnvironment: this.authoritativeReviewEnvironment,
      v2Scheduling: this.v2Scheduling,
      ...(options.acceptanceStopAfterCommit !== undefined
        ? { acceptanceStopAfterCommit: options.acceptanceStopAfterCommit }
        : {}),
    });
    // Task 21 P1#1: install the production composition — the six real
    // system-command handlers + the attempt coordinator + the pass+execute
    // tick. The runner's tool provider is the Task 13 V2ToolFactory seam
    // (empty here); the seal command path never uses Agent tools, and the
    // disabled capability keeps everything idle until qualified.
    this.v2Composition = installAuthoritativeReviewRuntime({
      coordinator: this.v2Coordinator,
      facade: this.v2Facade,
      blobStore: this.v2BlobStore,
      wakeups: this.v2Wakeups,
      artifacts: this.artifacts,
      scheduling: this.v2Scheduling,
      readProjection: (taskId) => this.v2Projection(taskId),
      resolver: (taskId, ref) => this.v2BlobStore.readJson(taskId, ref, ref.kind),
      frozenProfile: (taskId) => this.frozenProfileV2(taskId),
      frozenTemplate: (taskId) => this.tasks.readFrozenTemplate(taskId),
      profileBody: async (taskId) => {
        // The profile_snapshot blob parser strips the limit/installed-handler
        // groups, so the FULL body (the validator registry resolves against its
        // budgetProfiles/installedHandlers) is read from the raw snapshot file.
        const profile = await this.frozenProfileV2(taskId);
        const file = this.paths.taskStructuredV2BlobFile(taskId, 'profile_snapshot', profile.profileSnapshotRef.digest);
        const raw = await readFile(file, 'utf8');
        return JSON.parse(raw) as never;
      },
      frozenAutomaticRetries: (taskId) => this.frozenAutomaticRetries(taskId),
      eligibility: (frozenProfileDigest) => this.executionEligibilityOf(frozenProfileDigest),
      runner: new V2AssignmentRunner({
        runtime: this.runtime,
        // Task 13 wires the real V2ToolFactory here. Until then an Agent
        // session has no domain tools and therefore cannot produce its §9.2
        // domain result carriers — `collectResultRefs` fails RETRYABLE (the
        // runner classifies RuntimeFailure.transient as retryable), so the
        // leased work item parks on a durable retry_due wakeup instead of
        // crashing the mutation driver with a bare-completion rejection. The
        // System Command (seal) path never touches the runner.
        toolProvider: {
          async toolsFor() { return []; },
          async collectResultRefs() {
            throw RuntimeFailure.transient(
              'V2_AGENT_TOOLS_NOT_WIRED',
              'v2 Agent tool factory is not wired; the session cannot produce domain result refs',
            );
          },
        },
      }),
      clock: () => new Date().toISOString(),
      traces: this.traces,
      terminalFail: (taskId, input) => this.v2Lifecycle.terminalFailWorkItem(taskId, input),
      eventStore: this.events,
      publicationStore: this.v2PublicationStore,
    });
  }

  async initialize(): Promise<void> {
    await this.templates.initialize();
    // The v2 cursor keyring is created durably at service bootstrap
    // (spec §14.2); fail-closed loading never mints a replacement key.
    await this.cursorKeyring.initialize();
    // Task 11 startup wiring (spec §10.5/§10.4): the installation migration
    // barrier, creation recovery BEFORE any GC sweep, the deletion-tombstone
    // resume, the facade pin recovery, the post-marker unindexed quarantine,
    // and finally the deterministic §10.4 startup scan of every v2 task.
    if (!(await this.v2Index.migrationComplete())) {
      await this.v2Index.runMigrationBarrier();
    }
    await this.v2Index.runCreationRecovery();
    await this.v2Deletion.runStartupRecovery();
    await this.v2Facade.startupRecovery();
    await this.quarantineUnindexedDirectories();
    await runStartupRecoveryV2({
      index: this.v2Index,
      deletion: this.v2Deletion,
      wakeups: this.v2Wakeups,
      lifecycle: this.v2Lifecycle,
      coordinator: this.v2Coordinator,
      facade: this.v2Facade,
      checkpointStore: this.v2CheckpointStore,
      resolver: (taskId, ref) => this.v2BlobStore.readJson(taskId, ref, ref.kind),
      tail: (taskId) => this.events.tail(taskId),
      committedOperation: async (taskId, operationId) => {
        const committed = await this.events.readBatchByCommitId(taskId, operationId);
        return committed === null
          ? null
          : committed.map((entry) => ({ sequence: entry.sequence, event: entry.event }));
      },
      clock: () => new Date().toISOString(),
      eligibility: (frozenProfileDigest) => this.executionEligibilityOf(frozenProfileDigest),
      frozenProfileDigest: async (taskId) => (await this.frozenProfileV2(taskId)).profileDigest,
    });
  }

  /**
   * Every post-marker task directory WITHOUT a prepared/active index row is
   * quarantined (spec §10.5: "a directory first appearing after the marker
   * without a prepared/active index is never classified legacy and is
   * quarantined/fail-closed"). Platform-created v1/basic tasks legitimately
   * carry NO index row (the index registers v2 identities only), so they are
   * recognized by their frozen-snapshot copy and left alone; only directories
   * that cannot prove platform creation — unreadable record AND no snapshot,
   * or a v2-shaped snapshot without its row — fail closed. Examined at
   * bootstrap under the fence.
   */
  private async quarantineUnindexedDirectories(): Promise<string[]> {
    const quarantined: string[] = [];
    const ids = await this.tasks.listTaskIds();
    await this.v2Index.withFence(async () => {
      for (const taskId of ids) {
        const row = await this.v2Index.entryFor(taskId);
        if (row !== null) continue;
        if (await this.platformCreatedLegacyDir(taskId)) continue;
        const moved = await this.v2Index.quarantineUnindexedDirectory(taskId, 'post-marker unindexed');
        if (moved !== null) quarantined.push(taskId);
      }
    });
    return quarantined;
  }

  /**
   * True when a directory is a platform-created legacy (v1/basic) task. Spec
   * §10.5 fails closed EVEN when the bytes resemble a valid v1 task, so the
   * ONLY discriminator is the frozen SNAPSHOT COPY — only TaskStore.create
   * publishes a `snapshot/` directory. A readable non-v2 record WITHOUT the
   * snapshot (or a damaged record without the snapshot) is a foreign/unindexed
   * directory and is quarantined, never legacy-deleted. Shared by the startup
   * quarantine and the delete dispatch (review A-M3).
   */
  private async platformCreatedLegacyDir(taskId: string): Promise<boolean> {
    try {
      await stat(this.paths.taskSnapshotRoot(taskId));
    } catch {
      return false;
    }
    try {
      const frozen = await this.tasks.readFrozenTemplate(taskId);
      // Platform-created v2 tasks ALWAYS have an index row (fenced create);
      // a v2 snapshot without a row is proof of a tampered/foreign dir.
      if (structuredProtocolOf(frozen) === 'v2') {
        return false;
      }
      return true;
    } catch {
      // Damaged record: the snapshot copy itself is the platform-creation
      // proof (the pre-existing corrupt-v1 delete contract).
      return true;
    }
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
   * Deletes one task. The v2 branch (spec §10.5) dispatches by the
   * INSTALLATION TASK INDEX — never the request body, the public summary or a
   * guessed protocol: a prepared/active v2 row (and every tombstoned id) uses
   * the fenced tombstone machine; a legacy-preexisting/corrupt v1 keeps the
   * legacy recursive deletion; an unindexed post-marker directory is
   * quarantined and refused (it can never bypass fenced handling). The v1
   * slot for a running task still aborts the run first (unchanged).
   */
  async deleteTask(taskId: string, body?: DeleteTaskBodyV2): Promise<DeleteTaskResultV2 | { ok: true }> {
    // The dispatch must never guess a protocol from a possibly corrupt root:
    // CorePaths validates the identifier FIRST so unsafe ids surface the
    // stable CORE_PATH_INVALID (400), exactly like the legacy path.
    void this.paths.taskFile(taskId);
    const row = await this.v2Index.entryFor(taskId);
    const tombstone = await this.v2Deletion.tombstoneFor(taskId);
    const isV2 = row !== null && row.state !== 'legacy_preexisting';
    if (isV2 || tombstone !== null) {
      if (body === undefined) {
        throw new StorageError(
          STORAGE_ERROR_CODES.INVALID_INPUT,
          'v2 任务删除必须携带 operationId 与 reason。',
          null,
          '按 { operationId, reason } 形状重新提交。',
        );
      }
      await this.scheduler.releaseIfRunning(taskId);
      const result = await this.v2Deletion.runDelete(taskId, body as DeleteTaskRequestV2);
      this.live.clear(taskId);
      // The recursive purge of the detached quarantine happens afterward
      // (spec §10.5: purgeTask is crash-resumed from the tombstone); the
      // confirmed fenced result is detached/purged.
      const current = await this.v2Deletion.tombstoneFor(taskId);
      if (current !== null && current.state === 'detached') {
        await this.v2Deletion.purgeTask(taskId, current.deleteEpoch).catch(() => undefined);
      }
      return { operationId: result.operationId, state: result.state };
    }
    if (body !== undefined) {
      // A v2-protocol body on a v1 task is a stable exact-error: reject
      // BEFORE any deletion begins (spec §10.5).
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_INPUT,
        '该任务不是 v2 任务，不接受 v2 删除载荷。',
        null,
        '移除删除载荷后重试。',
      );
    }
    if (row === null && (await this.v2Index.migrationComplete()) && !(await this.platformCreatedLegacyDir(taskId))) {
      // Post-marker directory that cannot prove platform creation: quarantine
      // + fail closed (spec §10.5 — never legacy deletion, never fenced
      // bypass; a corrupt legacy task keeps its legacy delete THROUGH its
      // legacy_preexisting row or its snapshot copy, never through a guess).
      const moved = await this.v2Index.quarantineUnindexedDirectory(taskId, 'unindexed delete refused');
      if (moved !== null) {
        throw new StorageError(
          STORAGE_ERROR_CODES.TASK_CORRUPTED,
          '任务目录未登记，已被隔离。',
          null,
          '联系平台检查任务目录登记。',
        );
      }
    }
    await this.scheduler.releaseIfRunning(taskId);
    await this.tasks.deleteTask(taskId);
    this.live.clear(taskId);
    return { ok: true };
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

  /* ------------------- Task 11 v2 lifecycle API (deliverable 9) ------------------- */

  /** V2 start: one atomic batch, then the v2 scheduling pass. */
  async startTaskV2(taskId: string): Promise<TaskSummary> {
    await this.v2Lifecycle.startV2(taskId, { operationId: randomUUID(), userInputText: '' });
    await this.runV2SchedulingTick();
    return (await this.getWorkspace(taskId)).task;
  }

  /** V2 stop (composed envelope: abandon + reclaim + overlay in ONE batch). */
  async stopTaskV2(taskId: string): Promise<TaskSummary> {
    await this.v2Lifecycle.stopV2(taskId, { operationId: randomUUID(), reason: 'user_stop' });
    return (await this.getWorkspace(taskId)).task;
  }

  /** V2 resume (clears the exact suspension overlay, reactivates wakeups). */
  async resumeTaskV2(taskId: string): Promise<TaskSummary> {
    await this.v2Lifecycle.resumeV2(taskId, { operationId: randomUUID() });
    await this.runV2SchedulingTick();
    return (await this.getWorkspace(taskId)).task;
  }

  /**
   * V2 retry: clears ONLY the retry-budget park of the budget-exhausted
   * workitem (projected — no body, mirroring the v1 retry surface).
   */
  async retryTaskV2(taskId: string): Promise<TaskSummary> {
    const projection = await this.v2Projection(taskId);
    const workItemId = projection.retryBudgetExhaustedWorkItemId;
    if (workItemId === null) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_INPUT,
        '该任务没有耗尽重试预算的 WorkItem，无法手动重试。',
        null,
        '刷新任务状态后重试。',
      );
    }
    await this.v2Lifecycle.manualRetryV2(taskId, { operationId: randomUUID(), workItemId });
    await this.runV2SchedulingTick();
    return (await this.getWorkspace(taskId)).task;
  }

  /** V2 human answer (question identity + operation from the validated body). */
  async answerTaskV2(taskId: string, body: import('../shared/authoritative-review-v2').AnswerTaskBodyV2): Promise<TaskSummary> {
    // B-F1: the wire schema accepts the plain { answer } variant — the
    // decision union is only for the structured progress-guard choices.
    if ('decision' in body && body.decision === 'stop') {
      await this.v2Lifecycle.stopV2(taskId, {
        operationId: body.operationId,
        reason: 'user_stop',
      });
    } else {
      await this.v2Lifecycle.answerV2(taskId, {
        operationId: body.operationId,
        questionId: body.questionId,
        questionVersion: body.questionVersion,
        answer: 'answer' in body ? body.answer : body.text,
      });
    }
    await this.runV2SchedulingTick();
    return (await this.getWorkspace(taskId)).task;
  }

  /** V2 fenced reopen (frozen §10.3.1 policy table only). */
  async reopenFailedTask(taskId: string, request: ReopenFailedRequestV2): Promise<TaskSummary> {
    // B-M2 (delete-route pattern): a v1 task carrying a reopen body is a
    // stable exact-error BEFORE the lifecycle path (which would surface the
    // TASK_CORRUPTED index-identity code).
    try {
      const frozen = await this.tasks.readFrozenTemplate(taskId);
      if (structuredProtocolOf(frozen) !== 'v2') {
        throw new StorageError(
          STORAGE_ERROR_CODES.INVALID_INPUT,
          '该任务不是 v2 任务，不接受 reopen_failed 载荷。',
          null,
          '移除 reopen 载荷后重试。',
        );
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      // Unreadable identity: let the lifecycle path fail closed as corruption.
    }
    await this.v2Lifecycle.reopenFailed(taskId, request as unknown as ReopenRequestV2);
    await this.runV2SchedulingTick();
    return (await this.getWorkspace(taskId)).task;
  }

  /* ------------------------------------------------------------------ */
  /* §14.1 v2 read-only projection API (Task 23)                         */
  /* ------------------------------------------------------------------ */

  /**
   * The owner v2 read projection service (spec §14.1/§14.2). Read routes work
   * on ANY v2 task — with the authoritative capability disabled they still
   * return the readable historical projection (spec §4.3: historical reads
   * use the task-frozen profile) — so no capability check is done here; the
   * projection/checkpoint/blob reads fail closed on corruption. Basic/v1
   * tasks are NOT v2 and reject with AUTHORITATIVE_REVIEW_UNAVAILABLE.
   */
  private authoritativeReadService(): AuthoritativeReviewProjectionService {
    return new AuthoritativeReviewProjectionService({
      readSnapshot: async (taskId, throughSequence) => {
        try {
          const resolver = (ref: BlobRefV2): Promise<unknown> => this.v2BlobStore.readJson(taskId, ref, ref.kind);
          const result = throughSequence === undefined
            ? await this.v2CheckpointStore.readState(taskId, resolver)
            : await this.v2CheckpointStore.rebuild(taskId, resolver, throughSequence);
          return { throughSequence: result.throughSequence, projection: result.projection };
        } catch (error) {
          if (error instanceof ProjectionCorruptionError) {
            throw new AuthoritativeReviewReadError('TASK_CORRUPTED', '任务权威历史损坏。', 'CoreService.authoritativeRead', '联系平台检查任务事件账本。');
          }
          throw error;
        }
      },
      resolveBlob: async (taskId, ref, kind) => this.v2BlobStore.readJson(taskId, ref, kind),
      keyring: this.cursorKeyring,
    });
  }

  /** Guards that the task is a v2 task (frozen snapshot), else AUTHORITATIVE_REVIEW_UNAVAILABLE. */
  private async requireAuthoritativeReviewTask(taskId: string): Promise<void> {
    try {
      const frozen = await this.tasks.readFrozenTemplate(taskId);
      if (structuredProtocolOf(frozen) !== 'v2') {
        throw new AuthoritativeReviewReadError('AUTHORITATIVE_REVIEW_UNAVAILABLE', '该任务未启用权威评审协议。', 'CoreService.authoritativeRead', '查看任务画布。');
      }
    } catch (error) {
      if (error instanceof AuthoritativeReviewReadError) throw error;
      if (error instanceof StorageError) {
        // TASK_NOT_FOUND / TASK_CORRUPTED propagate their stable public codes.
        throw error;
      }
      throw new AuthoritativeReviewReadError('AUTHORITATIVE_REVIEW_UNAVAILABLE', '该任务未启用权威评审协议。', 'CoreService.authoritativeRead', '查看任务画布。');
    }
  }

  async authoritativeMap(taskId: string): Promise<AuthoritativeMapDetailV2> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().map(taskId);
  }

  async authoritativeCandidate(taskId: string): Promise<AuthoritativeCandidateDetailV2> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().candidate(taskId);
  }

  async authoritativeTree(taskId: string, parentId: string | null, limit: number, after: SnapshotCursorV2 | null): Promise<AuthoritativeTreePageV2> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().tree(taskId, parentId, limit, after);
  }

  async authoritativeLocate(taskId: string, slotId: string, snapshotCursor: SnapshotCursorV2 | null): Promise<AuthoritativeLocateResultV2> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().locate(taskId, slotId, snapshotCursor);
  }

  async authoritativeMapRounds(taskId: string, limit: number, after: SnapshotCursorV2 | null): Promise<CollectionPageV2<AuthoritativeReviewRoundSummaryV2>> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().mapRounds(taskId, limit, after);
  }

  async authoritativeReviewSummary(taskId: string): Promise<AuthoritativeReviewSummaryV2> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().summary(taskId);
  }

  async authoritativeRounds(taskId: string, limit: number, after: SnapshotCursorV2 | null): Promise<CollectionPageV2<AuthoritativeReviewRoundSummaryV2>> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().rounds(taskId, limit, after);
  }

  async authoritativeSlotReview(taskId: string, slotId: string, snapshotCursor: SnapshotCursorV2 | null): Promise<AuthoritativeSlotReviewDetailV2> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().slotReview(taskId, slotId, snapshotCursor);
  }

  async authoritativeRelationReview(taskId: string, relationId: string, snapshotCursor: SnapshotCursorV2 | null): Promise<AuthoritativeRelationReviewDetailV2> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().relationReview(taskId, relationId, snapshotCursor);
  }

  async authoritativeFindings(taskId: string, limit: number, after: SnapshotCursorV2 | null): Promise<CollectionPageV2<AuthoritativeFindingSummaryV2>> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().findings(taskId, limit, after);
  }

  async authoritativeSealReadiness(taskId: string): Promise<AuthoritativeSealReadinessDetailV2> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().sealReadiness(taskId);
  }

  /**
   * Legacy-compatible v2 issues projection (spec §14.1): current open Findings
   * + deterministic validator/lifecycle issues in the v1 `StructuredIssueV1`
   * shape. Never maps a Seal boolean to a per-slot pass.
   */
  async authoritativeIssues(taskId: string): Promise<StructuredIssueV1[]> {
    await this.requireAuthoritativeReviewTask(taskId);
    return this.authoritativeReadService().issues(taskId);
  }

  /** One deterministic v2 scheduling pass (the §10.4 loop; idempotent per tail). */
  runV2SchedulingPass(now?: string): Promise<Awaited<ReturnType<AuthoritativeV2SchedulingEngine['runPass']>>> {
    return this.v2Scheduling.runPass(now);
  }

  /**
   * Task 21 P1#1: one deterministic v2 scheduling TICK — the pass (reclaim/
   * requeue/lease ONE work item per task) followed by EXECUTING every freshly
   * leased work item through the installed real system-command registry +
   * attempt coordinator. Every v2 mutation driver calls this (replacing the
   * pass-only driver, which never executed anything). With the authoritative
   * capability disabled the pass leases nothing and the tick is a no-op.
   */
  runV2SchedulingTick(now?: string): Promise<import('./runtime/authoritative-review/attempt-coordinator').V2SchedulingTickResult> {
    return this.v2Composition.runTick(now);
  }

  /** The current v2 projection of one task (corrupt histories fail closed). */
  private async v2Projection(taskId: string): Promise<AuthoritativeReviewProjectionV2> {
    try {
      return (await this.v2CheckpointStore.readState(taskId, (ref) => this.v2BlobStore.readJson(taskId, ref, ref.kind))).projection;
    } catch (error) {
      if (error instanceof ProjectionCorruptionError) {
        throw new StorageError(STORAGE_ERROR_CODES.TASK_CORRUPTED, '任务权威历史损坏。', null, '联系平台检查任务事件账本。');
      }
      throw error;
    }
  }

  /** The task-FROZEN profile carrier (constraint B: row refs + frozen digest). */
  private async frozenProfileV2(taskId: string): Promise<FrozenTaskProfileV2> {
    const row = await this.v2Index.entryFor(taskId);
    if (row === null || row.state === 'legacy_preexisting') {
      throw new StorageError(STORAGE_ERROR_CODES.TASK_CORRUPTED, '该任务没有 v2 索引身份。', null, '联系平台检查任务索引。');
    }
    const record = await this.tasks.readTaskRecord(taskId);
    const frozen = await this.tasks.readFrozenTemplate(taskId);
    const binding = frozen.authoritativeReviewProfile;
    if (binding === null) {
      throw new StorageError(STORAGE_ERROR_CODES.TASK_CORRUPTED, 'frozen 快照缺少 authoritative profile 绑定。', null, '联系平台检查任务快照。');
    }
    return {
      profileSnapshotRef: row.profileSnapshotRef,
      templateSnapshotRef: row.templateSnapshotRef,
      profileDigest: binding.profileDigest,
      snapshotHash: record.templateVersion,
    };
  }

  /**
   * The separately derived execution eligibility (spec §4.3): frozen task
   * profile digest vs the CURRENT deployed profile/ABI. Never TaskStatus and
   * never written into event history.
   */
  private executionEligibilityOf(frozenProfileDigest: string): AuthoritativeReviewExecutionEligibilityV1 {
    const environment = this.authoritativeReviewEnvironment;
    const profile = environment.profile;
    const availableAbis =
      profile === null
        ? new Set<string>()
        : new Set<string>([profile.abi.validatorAbi, profile.abi.assemblerAbi, profile.abi.profileAbi]);
    return deriveAuthoritativeReviewExecutionEligibility({
      frozenProfileDigest,
      baseStructuredCapabilityEnabled:
        this.runtimeEnvironment.capability.status === 'enabled' && this.runtimeEnvironment.profile !== null,
      currentCapability: environment.capability,
      currentProfileDigest: currentAuthoritativeReviewProfileDigest(environment),
      requiredAbisAvailable: requiredAuthoritativeReviewAbiAvailable(environment, availableAbis),
    });
  }

  /** The frozen orchestrator role binding of one task's snapshot. */
  private async frozenRoleBinding(taskId: string, role: 'orchestrator'): Promise<string> {
    const frozen = await this.tasks.readFrozenTemplate(taskId);
    const bindings = frozen.structuredReviewLifecycle?.roleBindings;
    const binding = bindings?.[role];
    if (typeof binding !== 'string' || binding.length === 0) {
      throw new StorageError(STORAGE_ERROR_CODES.TASK_CORRUPTED, 'frozen 快照缺少 orchestrator 角色绑定。', null, '联系平台检查任务快照。');
    }
    return binding;
  }

  /**
   * The repair-session role binding: the frozen template declares no repair
   * role key, so repairs reuse the orchestrator role binding of the snapshot
   * (Task 13 owns the final repair-role model).
   */
  private frozenRoleBindingV2(taskId: string, _session: 'mapRepair' | 'contentRepair'): Promise<string> {
    return this.frozenRoleBinding(taskId, 'orchestrator');
  }

  /** The frozen automatic retry budget: the profile's consecutive-attempts floor. */
  private async frozenAutomaticRetries(taskId: string): Promise<number> {
    const frozen = await this.tasks.readFrozenTemplate(taskId);
    const profile = this.authoritativeReviewEnvironment.profile;
    if (profile === null) return 0;
    void frozen;
    return profile.runtime.maxConsecutiveAttemptsWithoutProgress;
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
    const isV2 = structuredProtocolOf(frozenTemplate) === 'v2';
    const workspace = projectTask(
      { record, frozenTemplate },
      events,
      artifacts,
      // Exact filled-slot count from the ACTIVE generation's content root
      // (design §18.3 authoritative events + verifiable blob projection). Null
      // when none committed or unreadable → the summary reports 0 filled.
      // Contract v2 never reads v1 content revisions (spec §4.4).
      isV2 ? null : await this.structuredContentRootFor(taskId, frozenTemplate, events),
    );
    if (isV2) {
      // Task 11 (spec §4.3/§10.3.1/§14): the versioned v2 workspace summary —
      // execution eligibility SEPARATE from the event-derived status, the
      // pending question, and the bounded failed-recovery summary (only the
      // policy-allowed reopen/clone surface; never private refs). A corrupt
      // v2 history already projects `corrupt` (Task 9) and gets no v2
      // enrichment beyond the status.
      const projected = projectAuthoritativeReviewStateSync(events as AuthoritativeReviewEventV2[]);
      if (projected.ok && workspace.task.status !== 'corrupt') {
        const frozenDigest = await this.frozenProfileDigestFor(taskId);
        // The public question display text rides the LEGACY human_requested
        // companion the v2 open batch carries (spec §17.3 display event);
        // the v2 projection holds the authoritative identity fields.
        let questionText = '';
        for (const entry of events) {
          if (entry.type === 'human_requested' && 'question' in entry && typeof entry.question === 'string') {
            questionText = entry.question;
          }
        }
        const pending = projected.state.pendingQuestion;
        // B-M7 (loud, no silent guess): the frozen v2 opened-question event
        // carries NO source discriminator — every v2 question the lifecycle
        // opens is an AGENT request in this release, so the summary pins
        // source='agent_request'. Introducing system/progress-guard questions
        // REQUIRES a source member on the opened event + projection wiring;
        // until then this is documented, not inferred.
        workspace.authoritativeReview = {
          version: 2,
          executionEligibility: this.executionEligibilityOf(frozenDigest),
          pendingQuestion:
            pending === null
              ? null
              : {
                  questionId: pending.questionId,
                  questionDigest: pending.questionDigest,
                  questionVersion: pending.questionVersion,
                  source: 'agent_request',
                  text: questionText,
                },
        };
        if (projected.state.taskStatus === 'failed') {
          // B-F3: the TRACK-EXACT summary — the recorded track is resolved
          // from the failureRecoveryPayloadRef blob (kind-checked by the
          // strict projector) so the UI never offers an impossible recipe.
          const recovery = await failedRecoverySummaryResolved(projected.state, (ref) =>
            this.v2BlobStore.readJson(taskId, ref, ref.kind),
          );
          if (recovery !== null) {
            workspace.task.failedRecovery = recovery;
          }
        }
      }
    }
    // Live-preview attachment (plan C): the in-memory buffer, when present,
    // rides along as activeTurn. Never persisted; display only.
    workspace.activeTurn = this.live.get(taskId);
    return this.enrichSkillNodeBodies(taskId, workspace);
  }

  /** The frozen profile digest (row identity + archived binding). */
  private async frozenProfileDigestFor(taskId: string): Promise<string> {
    return (await this.frozenProfileV2(taskId)).profileDigest;
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
    if (frozen.structuredSlots.version !== 1) {
      // The v1 owner read APIs never interpret a contract-v2 snapshot (spec
      // §4.4): v2 tasks get the future authoritative read routes.
      throw new StructuredSlotReadError(
        'STRUCTURED_NOT_ACTIVE',
        '该任务使用 contract v2 协议，请使用权威评审视图查看。',
        'CoreService.structuredRead',
        '使用权威评审阅读视图。',
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
