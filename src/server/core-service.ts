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
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type {
  ArtifactVersion,
  SkillContent,
  TaskSummary,
  TaskWorkspace,
  TurnTrace,
} from '../shared/contracts';
import { CorePaths } from './storage/core-paths';
import { ArtifactStore, type ArtifactProposal } from './storage/artifact-store';
import { EventStore, type CommittedEvent } from './storage/event-store';
import { TaskStore, type CreateTaskRequest, type CreatedTask } from './storage/task-store';
import { projectTask } from './storage/task-projector';
import type { TaskEvent } from './storage/task-events';
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
    const workspace = projectTask(
      { record, frozenTemplate },
      committed.map((entry) => entry.event),
      artifacts,
    );
    // Live-preview attachment (plan C): the in-memory buffer, when present,
    // rides along as activeTurn. Never persisted; display only.
    workspace.activeTurn = this.live.get(taskId);
    return this.enrichSkillNodeBodies(taskId, workspace);
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
    };
  }
}

export function createCoreService(paths: CorePaths, options: CoreServiceOptions = {}): CoreService {
  return new CoreService(paths, options);
}
