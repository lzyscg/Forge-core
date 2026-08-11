import type {
  CapabilityEvidence,
  HumanDecision,
  MockScenarioId,
  SkillContent,
  TaskStatus,
  TaskSummary,
  TaskWorkspace,
  TemplateDetail,
  TemplateSummary,
  TraceEntry,
  TurnTrace,
  TurnTracePhase,
} from '../../shared/contracts';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import type { DevelopmentGateway } from '../gateway/development-gateway';
import type { ForgeCoreGateway } from '../gateway/forge-core-gateway';
import { MOCK_SKILLS, templateFixture } from './__fixtures__/zhihu-single-chapter';
import type { DevelopmentEvidenceLoader } from './development-evidence';
import {
  DEVELOPMENT_EVIDENCE_SEED,
  mapDevelopmentEvidence,
} from './development-evidence';
import { projectMockWorkspace, projectTaskStatus, projectTaskSummary } from './mock-projector';
import type { MockScenarioRegistry } from './mock-simulator';
import { createMockSimulator } from './mock-simulator';
import { MOCK_SCENARIOS, type MockScenarioDefinition } from './mock-scenarios';
import type { MockClock, MockTaskEvent, MockTaskRecord } from './mock-schema';
import { MOCK_SCENARIO_IDS } from './mock-schema';
import { MockStore } from './mock-store';

/**
 * Persistent MockGateway: implements the full ForgeCoreGateway contract and
 * the DevelopmentGateway controls over versioned Storage plus an injected
 * clock. Lifecycle validation and append-only event semantics are complete
 * here; the deterministic demonstration engine plugs into the same event
 * channel in a later task and never changes these public behaviors.
 *
 * Platform module: no business roles, products or scenario content appear
 * here; everything business-specific flows in through the fixture registry.
 */

const FIXTURE_TEMPLATES: TemplateDetail[] = [templateFixture.template];

const CORRUPT_TASK_DIAGNOSTIC = '任务文件损坏、只能查看诊断。';

/** Clone display name suffix and its code-point bound (server-parity, plan Phase E). */
const CLONE_NAME_SUFFIX = '（重跑）';
const CLONE_NAME_MAX_CODE_POINTS = 120;

/**
 * The mock simulates basic templates only, so every read-only structured slot
 * method rejects with the same stable code the HTTP server returns for a basic
 * task (spec §14 basic-task absence behavior).
 */
function structuredNotActive(location: string): CoreError {
  return new CoreError(
    CORE_ERROR_CODES.STRUCTURED_NOT_ACTIVE,
    '该任务未启用结构槽。',
    location,
    '查看基本任务画布。',
  );
}

/** `<source name>（重跑）` truncated to 120 code points, exactly like the server. */
function buildCloneName(sourceName: string): string {
  const combined = `${sourceName}${CLONE_NAME_SUFFIX}`;
  const codePoints = [...combined];
  if (codePoints.length <= CLONE_NAME_MAX_CODE_POINTS) return combined;
  return codePoints.slice(0, CLONE_NAME_MAX_CODE_POINTS).join('');
}

export interface MockGatewayOptions {
  /**
   * Test-only scenario registry override. Production renders omit it and get
   * the six shipped deterministic scripts.
   */
  scenarios?: MockScenarioDefinition[];
  /**
   * Evidence source for DevelopmentGateway.getCapabilities. Omitted callers
   * (including all two-argument renders) keep the not_run seed semantics; the
   * composition root injects the browser loader that fetches the generated
   * /development-evidence.json.
   */
  evidenceLoader?: DevelopmentEvidenceLoader;
}

export function createMockGateway(
  storage: Storage,
  clock: MockClock,
  options: MockGatewayOptions = {},
): ForgeCoreGateway & DevelopmentGateway {
  const store = new MockStore(storage, clock, { templates: FIXTURE_TEMPLATES });
  const listeners = new Map<string, Set<() => void>>();

  /**
   * Process traces recorded by the simulator, keyed by turn id (the id embeds
   * the task id, so lookups can never cross task boundaries). Display only —
   * never part of the persisted event history and never read by gates. The
   * optional phase is the turn's display-only final phase summary.
   */
  const turnTraces = new Map<string, { entries: TraceEntry[]; phase?: TurnTracePhase }>();

  const evidenceLoader: DevelopmentEvidenceLoader = options.evidenceLoader ?? {
    load: async () => ({ ...DEVELOPMENT_EVIDENCE_SEED, passedCapabilities: [] }),
  };

  const timestamp = (): string => new Date(clock.now()).toISOString();
  const newId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

  const notify = (taskId: string): void => {
    const set = listeners.get(taskId);
    if (!set) return;
    for (const listener of [...set]) listener();
  };

  const notifyAll = (): void => {
    for (const taskId of [...listeners.keys()]) notify(taskId);
  };

  const append = (taskId: string, event: MockTaskEvent): void => {
    store.appendTaskEvent(taskId, event);
    notify(taskId);
  };

  const scenarioRegistry: MockScenarioRegistry = options.scenarios
    ? Object.fromEntries(options.scenarios.map((scenario) => [scenario.id, scenario]))
    : MOCK_SCENARIOS;

  /**
   * Exactly one simulator per gateway. Normal renders and refreshed browsers
   * share the same recovery path: bootstrap() runs once, before the gateway
   * is handed out, and is a no-op on empty storage.
   */
  const simulator = createMockSimulator(
    {
      store,
      clock,
      timestamp,
      newId,
      append,
      recordTrace: (turnId, entries, phase) => {
        turnTraces.set(turnId, { entries: [...entries], ...(phase ? { phase } : {}) });
      },
      resolveContent: (contentFixture) =>
        contentFixture === 'v1'
          ? templateFixture.sampleArtifacts.v1.content
          : templateFixture.sampleArtifacts.v2.content,
    },
    scenarioRegistry,
  );

  function requireTemplate(templateId: string, location: string): TemplateDetail {
    const detail = store.getTemplateDetail(templateId);
    if (!detail) {
      throw new CoreError(
        CORE_ERROR_CODES.TEMPLATE_NOT_FOUND,
        `未找到模板 ${templateId}。`,
        location,
        '返回模板列表重新加载。',
      );
    }
    return detail;
  }

  function requireRecord(taskId: string, location: string): MockTaskRecord {
    const entry = store.getTaskEntry(taskId);
    if (!entry) {
      throw new CoreError(
        CORE_ERROR_CODES.TASK_NOT_FOUND,
        `未找到任务 ${taskId}。`,
        location,
        '返回任务列表刷新后重试。',
      );
    }
    if (entry.corrupt) {
      throw new CoreError(
        CORE_ERROR_CODES.TASK_CORRUPTED,
        `任务 ${taskId} 的本地模拟数据未通过校验，已被隔离。`,
        location,
        '在开发进度页重置模拟数据后重试。',
      );
    }
    return entry.record;
  }

  function requireStatus(
    record: MockTaskRecord,
    allowed: readonly TaskStatus[],
    location: string,
  ): TaskStatus {
    const status = projectTaskStatus(record);
    if (!allowed.includes(status)) {
      throw new CoreError(
        CORE_ERROR_CODES.INVALID_TRANSITION,
        `任务当前状态为 ${status}，不允许该操作。`,
        location,
        '刷新任务状态后重试。',
      );
    }
    return status;
  }

  /** Global invariant: at most one task is running at any moment. */
  function requireNoOtherRunning(taskId: string, location: string): void {
    for (const entry of store.listTaskEntries()) {
      if (entry.corrupt || entry.id === taskId) continue;
      if (projectTaskStatus(entry.record) === 'running') {
        throw new CoreError(
          CORE_ERROR_CODES.TASK_ALREADY_RUNNING,
          `已有任务 ${entry.id} 正在运行。`,
          location,
          '先停止正在运行的任务，再启动本任务。',
        );
      }
    }
  }

  function validateInput(
    detail: TemplateDetail,
    input: Record<string, string>,
    location: string,
  ): void {
    if (input === null || typeof input !== 'object') {
      throw new CoreError(
        CORE_ERROR_CODES.INVALID_INPUT,
        '任务输入必须是字符串字段表。',
        location,
        '按模板声明的输入字段重新填写。',
      );
    }
    const declared = new Set(detail.inputFields.map((field) => field.id));
    for (const [key, value] of Object.entries(input)) {
      if (!declared.has(key)) {
        throw new CoreError(
          CORE_ERROR_CODES.INVALID_INPUT,
          `输入字段 ${key} 未在模板中声明。`,
          location,
          '移除未声明的输入字段后重新提交。',
        );
      }
      if (typeof value !== 'string') {
        throw new CoreError(
          CORE_ERROR_CODES.INVALID_INPUT,
          `输入字段 ${key} 的值必须是字符串。`,
          location,
          '按模板声明的输入字段重新填写。',
        );
      }
    }
    for (const field of detail.inputFields) {
      if (!field.required) continue;
      const value = input[field.id];
      if (typeof value !== 'string' || value.length === 0) {
        throw new CoreError(
          CORE_ERROR_CODES.INVALID_INPUT,
          `缺少必填输入字段 ${field.id}。`,
          location,
          '补齐必填输入字段后重新提交。',
        );
      }
    }
  }

  function toTemplateSummary(detail: TemplateDetail, updatedAt: string): TemplateSummary {
    return {
      id: detail.id,
      name: detail.name,
      description: detail.description,
      version: detail.version,
      agentCount: detail.agentCount,
      status: detail.status,
      updatedAt,
    };
  }

  function toCorruptSummary(id: string, updatedAt: string): TaskSummary {
    return {
      id,
      name: id,
      templateId: '',
      templateName: '',
      status: 'corrupt',
      currentAgentName: null,
      latestVersion: null,
      updatedAt,
      diagnostic: CORRUPT_TASK_DIAGNOSTIC,
    };
  }

  /**
   * The one creation path, shared by createTask and cloneTask so a clone
   * freezes its input on the CURRENT template version with exactly the same
   * validation as a hand-filled form (plan Phase E, Global Constraint 12).
   */
  function createTaskInternal(
    request: { templateId: string; name: string; input: Record<string, string> },
    location: string,
  ): TaskSummary {
    const detail = requireTemplate(request.templateId, location);
    if (typeof request.name !== 'string' || request.name.trim().length === 0) {
      throw new CoreError(
        CORE_ERROR_CODES.INVALID_INPUT,
        '任务名称不能为空。',
        location,
        '填写任务名称后重新提交。',
      );
    }
    validateInput(detail, request.input, location);
    const now = timestamp();
    const record: MockTaskRecord = {
      id: newId('task'),
      name: request.name,
      templateId: detail.id,
      templateName: detail.name,
      frozenInput: { ...request.input },
      frozenTemplate: structuredClone(detail),
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    store.createTaskRecord(record);
    return projectTaskSummary(record);
  }

  const gateway: ForgeCoreGateway & DevelopmentGateway = {
    /* ------------------------- ForgeCoreGateway ------------------------- */

    async listTemplates(): Promise<TemplateSummary[]> {
      const catalog = store.ensureCatalog();
      return Object.values(catalog.templates).map((entry) =>
        toTemplateSummary(entry.template, entry.updatedAt),
      );
    },

    async getTemplate(templateId: string): Promise<TemplateDetail> {
      return requireTemplate(templateId, 'MockGateway.getTemplate');
    },

    async reloadTemplate(templateId: string): Promise<TemplateDetail> {
      const reloaded = store.reloadTemplate(templateId);
      if (!reloaded) {
        throw new CoreError(
          CORE_ERROR_CODES.TEMPLATE_NOT_FOUND,
          `未找到模板 ${templateId}。`,
          'MockGateway.reloadTemplate',
          '返回模板列表重新加载。',
        );
      }
      return reloaded;
    },

    async createTask(request): Promise<TaskSummary> {
      return createTaskInternal(request, 'MockGateway.createTask');
    },

    async listTasks(): Promise<TaskSummary[]> {
      return store.listTaskEntries().map((entry) =>
        entry.corrupt ? toCorruptSummary(entry.id, entry.updatedAt) : projectTaskSummary(entry.record),
      );
    },

    async getWorkspace(taskId: string): Promise<TaskWorkspace> {
      const record = requireRecord(taskId, 'MockGateway.getWorkspace');
      // Live streaming preview (plan C): the in-flight result turn, when one
      // is due; memory-derived and never persisted.
      return { ...projectMockWorkspace(record), activeTurn: simulator.activeTurn(taskId) };
    },

    async startTask(taskId: string): Promise<void> {
      const location = 'MockGateway.startTask';
      const record = requireRecord(taskId, location);
      const status = projectTaskStatus(record);
      if (status === 'running') {
        throw new CoreError(
          CORE_ERROR_CODES.TASK_ALREADY_RUNNING,
          `任务 ${taskId} 已经在运行。`,
          location,
          '无需重复启动，可等待运行完成或先停止。',
        );
      }
      requireStatus(record, ['ready'], location);
      requireNoOtherRunning(taskId, location);
      // Validates the whole script against the frozen template first; an
      // invalid script throws here and appends no events at all.
      simulator.start(taskId);
    },

    async stopTask(taskId: string): Promise<void> {
      const location = 'MockGateway.stopTask';
      const record = requireRecord(taskId, location);
      requireStatus(record, ['running', 'waiting_human', 'retryable_failure', 'interrupted'], location);
      simulator.stop(taskId);
    },

    async resumeTask(taskId: string): Promise<void> {
      const location = 'MockGateway.resumeTask';
      const record = requireRecord(taskId, location);
      requireStatus(record, ['stopped', 'interrupted'], location);
      requireNoOtherRunning(taskId, location);
      simulator.resume(taskId);
    },

    async retryTask(taskId: string): Promise<void> {
      const location = 'MockGateway.retryTask';
      const record = requireRecord(taskId, location);
      requireStatus(record, ['retryable_failure'], location);
      requireNoOtherRunning(taskId, location);
      simulator.retry(taskId);
    },

    async answerHuman(taskId: string, answer: string): Promise<void> {
      const location = 'MockGateway.answerHuman';
      const record = requireRecord(taskId, location);
      requireStatus(record, ['waiting_human'], location);
      if (typeof answer !== 'string' || answer.length === 0) {
        throw new CoreError(
          CORE_ERROR_CODES.INVALID_INPUT,
          '人工回答不能为空。',
          location,
          '填写回答内容后重新提交。',
        );
      }
      simulator.answer(taskId, answer);
    },

    async submitHumanDecision(taskId: string, decision: HumanDecision): Promise<void> {
      const location = 'MockGateway.submitHumanDecision';
      const record = requireRecord(taskId, location);
      requireStatus(record, ['waiting_human'], location);
      // The mock simulates ordinary model-asked questions (agent_request)
      // only: the structured accept/stop decisions belong to the platform's
      // progress-guard flow, which the simulator never parks. `continue`
      // degrades to the plain answer with the guidance text.
      if (decision.decision !== 'continue') {
        throw new CoreError(
          CORE_ERROR_CODES.INVALID_TRANSITION,
          '该模拟任务不提供结构化决策，仅接受文字回答。',
          location,
          '填写回答内容后重新提交。',
        );
      }
      simulator.answer(taskId, decision.text);
    },

    watchTask(taskId: string, listener: () => void): () => void {
      const entry = store.getTaskEntry(taskId);
      if (!entry) {
        throw new CoreError(
          CORE_ERROR_CODES.TASK_NOT_FOUND,
          `未找到任务 ${taskId}。`,
          'MockGateway.watchTask',
          '返回任务列表刷新后重试。',
        );
      }
      let set = listeners.get(taskId);
      if (!set) {
        set = new Set();
        listeners.set(taskId, set);
      }
      const target = set;
      target.add(listener);
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        target.delete(listener);
        if (target.size === 0) listeners.delete(taskId);
      };
    },

    /* ------ Phase E display reads (plan Tasks E4/E5: shared interface) ----- */

    async getTurnTrace(taskId: string, turnId: string): Promise<TurnTrace> {
      const location = 'MockGateway.getTurnTrace';
      // Task identity first: unknown or corrupt tasks surface their own codes.
      requireRecord(taskId, location);
      const recorded = turnTraces.get(turnId);
      if (!recorded) {
        throw new CoreError(
          CORE_ERROR_CODES.TRACE_NOT_FOUND,
          `未找到回合 ${turnId} 的执行过程记录。`,
          location,
          '返回画布选择其他节点后重试。',
        );
      }
      return {
        turnId,
        ...(recorded.phase ? { phase: structuredClone(recorded.phase) } : {}),
        entries: structuredClone(recorded.entries),
      };
    },

    async getSkillContent(taskId: string, skillId: string): Promise<SkillContent> {
      const location = 'MockGateway.getSkillContent';
      const record = requireRecord(taskId, location);
      const declared = record.frozenTemplate.agents.some((agent) =>
        agent.skills.some((skill) => skill.id === skillId),
      );
      const fixtureSkill = MOCK_SKILLS[skillId];
      if (!declared || !fixtureSkill) {
        throw new CoreError(
          CORE_ERROR_CODES.SKILL_NOT_FOUND,
          `未找到技能 ${skillId}。`,
          location,
          '返回画布查看模板声明的技能。',
        );
      }
      return {
        skillId,
        content: fixtureSkill.content,
        versionHash: fixtureSkill.versionHash,
      };
    },

    async cloneTask(taskId: string): Promise<TaskSummary> {
      const location = 'MockGateway.cloneTask';
      const record = requireRecord(taskId, location);
      // Same-input rerun on the CURRENT template version; the source task is
      // never modified. Reuses the internal creation path end to end.
      return createTaskInternal(
        {
          templateId: record.templateId,
          name: buildCloneName(record.name),
          input: { ...record.frozenInput },
        },
        location,
      );
    },

    async deleteTask(taskId: string): Promise<void> {
      const location = 'MockGateway.deleteTask';
      // Presence (not validity) gates deletion: corrupt entries delete too.
      const entry = store.getTaskEntry(taskId);
      if (!entry) {
        throw new CoreError(
          CORE_ERROR_CODES.TASK_NOT_FOUND,
          `未找到任务 ${taskId}。`,
          location,
          '返回任务列表刷新后重试。',
        );
      }
      // A running task is stopped first: the simulator clears its schedule
      // timers, so no scripted step survives the record removal.
      if (!entry.corrupt && projectTaskStatus(entry.record) === 'running') {
        simulator.stop(taskId);
      }
      store.deleteTaskRecord(taskId);
      notify(taskId);
    },

    /* ---------- read-only structured slots (spec §14, mock is basic-only) ---------- */

    async getStructuredContract(taskId: string): Promise<never> {
      const location = 'MockGateway.getStructuredContract';
      requireRecord(taskId, location);
      throw structuredNotActive(location);
    },

    async listStructuredSlots(taskId: string): Promise<never> {
      const location = 'MockGateway.listStructuredSlots';
      requireRecord(taskId, location);
      throw structuredNotActive(location);
    },

    async getStructuredSlot(taskId: string): Promise<never> {
      const location = 'MockGateway.getStructuredSlot';
      requireRecord(taskId, location);
      throw structuredNotActive(location);
    },

    async listStructuredIssues(taskId: string): Promise<never> {
      const location = 'MockGateway.listStructuredIssues';
      requireRecord(taskId, location);
      throw structuredNotActive(location);
    },

    async getStructuredSeal(taskId: string): Promise<never> {
      const location = 'MockGateway.getStructuredSeal';
      requireRecord(taskId, location);
      throw structuredNotActive(location);
    },

    /* ------------------------- DevelopmentGateway ------------------------ */

    async getCapabilities(): Promise<CapabilityEvidence[]> {
      // Evidence refines all three columns; backendConnection and
      // realAcceptance stay not_started until their owning gates
      // (verify-backend/verify-runtime and write-final-evidence) persist
      // the corresponding fields — see mapDevelopmentEvidence.
      return mapDevelopmentEvidence(await evidenceLoader.load());
    },

    async getNextScenario(): Promise<MockScenarioId> {
      return store.loadDevelopment().nextScenario;
    },

    async setNextScenario(scenario: MockScenarioId): Promise<void> {
      if (!MOCK_SCENARIO_IDS.includes(scenario)) {
        throw new CoreError(
          CORE_ERROR_CODES.INVALID_SCENARIO,
          `未知的演示脚本 ${String(scenario)}。`,
          'MockGateway.setNextScenario',
          '从内置的六个演示脚本中选择。',
        );
      }
      store.saveDevelopment({ nextScenario: scenario });
    },

    async resetMockData(): Promise<void> {
      store.resetMockKeys();
      notifyAll();
    },
  };

  simulator.bootstrap();
  return gateway;
}
