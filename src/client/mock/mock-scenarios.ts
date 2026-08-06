import type {
  MockScenarioId,
  RouteKind,
  TemplateDetail,
  TurnTracePhase,
} from '../../shared/contracts';
import {
  INPUT_CHAPTER_BRIEF_ID,
  MOCK_SKILLS,
  REVIEWER_AGENT_ID,
  SKILL_CHAPTER_WRITING_ID,
  WRITER_AGENT_ID,
  templateFixture,
} from './__fixtures__/zhihu-single-chapter';

/**
 * Deterministic demonstration scripts. Each step references template Agent
 * ids (through fixture constants) and node references named by earlier
 * steps; the simulator engine executes steps purely by `kind` and never
 * branches on scenario id or business meaning. All business copy flows in
 * from the template fixture; labels/descriptions are demo script names.
 *
 * Node reference convention (shared with validation and the engine):
 * an input step names `${agentId}:input`, a result step names
 * `${agentId}:result`, always the latest node of that pair. A route step
 * pre-names its target agent's input reference.
 */

export type ScenarioStep =
  | { kind: 'input'; delayMs: number; agentId: string; title: string; body: string }
  | {
      kind: 'result';
      delayMs: number;
      agentId: string;
      title: string;
      body: string;
      /** Optional model thinking recorded into the turn's process trace. */
      thinking?: string;
      /**
       * Optional display-only final phase recorded with the turn's process
       * trace (plan 2026-08-04 Task 6); declared by the script, passed
       * through untouched by the engine — mock mode's phase-row demo data.
       */
      phase?: TurnTracePhase;
    }
  | { kind: 'skill'; delayMs: number; agentId: string; skillId: string; versionHash: string }
  | { kind: 'route'; delayMs: number; fromNodeRef: string; toAgentId: string; routeKind: RouteKind; label: string }
  | { kind: 'artifact'; delayMs: number; sourceNodeRef: string; title: string; contentFixture: 'v1' | 'v2' }
  | { kind: 'transient_failure'; delayMs: number; nodeRef: string; attempt: number }
  | { kind: 'manual_failure'; delayMs: number; nodeRef: string }
  | { kind: 'human_request'; delayMs: number; agentId: string; question: string }
  | { kind: 'final'; delayMs: number; inputVersion: number };

export interface MockScenarioDefinition {
  id: MockScenarioId;
  label: string;
  description: string;
  steps: ScenarioStep[];
}

export function inputRef(agentId: string): string {
  return `${agentId}:input`;
}

export function resultRef(agentId: string): string {
  return `${agentId}:result`;
}

/**
 * Validate an entire script against the frozen template before any event is
 * appended. Returns every problem found (empty = valid): unknown agents,
 * forward/unknown node references, attempt numbers that do not follow the
 * current count, routes without a receiving input step, non-positive delays
 * and final steps accepting an unpublished version.
 */
export function validateMockScenario(
  scenario: MockScenarioDefinition,
  template: TemplateDetail,
): string[] {
  const errors: string[] = [];
  const agents = new Set(template.agents.map((agent) => agent.id));
  const named = new Set<string>();
  const attemptCounts = new Map<string, number>();
  let publishedArtifacts = 0;

  const checkAgent = (agentId: string, where: string): void => {
    if (!agents.has(agentId)) {
      errors.push(`${where} 引用了模板未声明的 Agent ${agentId}。`);
    }
  };
  const checkRef = (ref: string, where: string): void => {
    if (!named.has(ref)) {
      errors.push(`${where} 引用了尚未命名的节点 ${ref}。`);
    }
  };

  scenario.steps.forEach((step, index) => {
    const where = `步骤 ${index + 1}（${step.kind}）`;
    if (!Number.isInteger(step.delayMs) || step.delayMs <= 0) {
      errors.push(`${where} 的延迟必须是正整数毫秒。`);
    }
    switch (step.kind) {
      case 'input':
        checkAgent(step.agentId, where);
        named.add(inputRef(step.agentId));
        attemptCounts.set(inputRef(step.agentId), 1);
        break;
      case 'result':
        checkAgent(step.agentId, where);
        named.add(resultRef(step.agentId));
        break;
      case 'skill':
        checkAgent(step.agentId, where);
        break;
      case 'route': {
        checkAgent(step.toAgentId, where);
        checkRef(step.fromNodeRef, where);
        const receivesInput = scenario.steps
          .slice(index + 1)
          .some((later) => later.kind === 'input' && later.agentId === step.toAgentId);
        if (!receivesInput) {
          errors.push(`${where} 的目标 Agent ${step.toAgentId} 之后没有输入步骤接收该路由。`);
        }
        named.add(inputRef(step.toAgentId));
        break;
      }
      case 'artifact':
        checkRef(step.sourceNodeRef, where);
        publishedArtifacts += 1;
        break;
      case 'transient_failure': {
        checkRef(step.nodeRef, where);
        const current = attemptCounts.get(step.nodeRef);
        if (current === undefined) {
          errors.push(`${where} 的节点 ${step.nodeRef} 没有可失败的输入节点。`);
        } else if (step.attempt !== current) {
          errors.push(`${where} 声明的尝试序号 ${step.attempt} 与当前计数 ${current} 不符。`);
        }
        attemptCounts.set(step.nodeRef, step.attempt + 1);
        break;
      }
      case 'manual_failure': {
        checkRef(step.nodeRef, where);
        const current = attemptCounts.get(step.nodeRef);
        if (current !== undefined) attemptCounts.set(step.nodeRef, current + 1);
        break;
      }
      case 'human_request':
        checkAgent(step.agentId, where);
        named.add(`${step.agentId}:human`);
        break;
      case 'final':
        if (step.inputVersion < 1 || step.inputVersion > publishedArtifacts) {
          errors.push(
            `${where} 接受的版本 ${step.inputVersion} 尚未发布（此前仅发布 ${publishedArtifacts} 个）。`,
          );
        }
        break;
    }
  });

  return errors;
}

/* ---------------------------------------------------------------------------
 * The six shipped scripts. Copy comes exclusively from the template fixture;
 * delays stay within 450-900ms so the browser demo plays at a natural pace.
 * ------------------------------------------------------------------------- */

const template = templateFixture.template;
const briefLabel = template.inputFields[0].label;
const brief = templateFixture.sampleInput[INPUT_CHAPTER_BRIEF_ID];
const submitLabel = template.routes[0].label;
const returnLabel = template.routes[1].label;
const v1 = templateFixture.sampleArtifacts.v1;
const v2 = templateFixture.sampleArtifacts.v2;
const finalName = template.finalOutput.name;
const writer = WRITER_AGENT_ID;
const reviewer = REVIEWER_AGENT_ID;

/** Fixture display name of an Agent, so phase targets read like the real UI. */
const agentName = (agentId: string): string =>
  template.agents.find((agent) => agent.id === agentId)?.name ?? agentId;

/**
 * Shipped demo phases (plan 2026-08-04 Task 6): every result turn dispatches
 * exactly one intent, mirroring the new turn contract's final phases.
 */
const publishedTo = (agentId: string): TurnTracePhase => ({
  state: 'dispatched',
  dispatchAction: 'publish_artifact',
  target: agentName(agentId),
  message: null,
});
const messagedTo = (agentId: string): TurnTracePhase => ({
  state: 'dispatched',
  dispatchAction: 'send_message',
  target: agentName(agentId),
  message: null,
});
const submittedFinalPhase: TurnTracePhase = {
  state: 'dispatched',
  dispatchAction: 'submit_final_artifact',
  target: null,
  message: null,
};

/**
 * The one skill load shared by every script that shows one: the writer loads
 * its writing skill right before producing its first result. Content and the
 * frozen version hash both come from the fixture (plan Task E4).
 */
const writerSkillStep: ScenarioStep = {
  kind: 'skill',
  delayMs: 500,
  agentId: writer,
  skillId: SKILL_CHAPTER_WRITING_ID,
  versionHash: MOCK_SKILLS[SKILL_CHAPTER_WRITING_ID].versionHash,
};

const reviewReturnSteps: ScenarioStep[] = [
  { kind: 'input', delayMs: 500, agentId: writer, title: briefLabel, body: brief },
  writerSkillStep,
  {
    kind: 'result',
    delayMs: 600,
    agentId: writer,
    title: v1.title,
    body: v1.content,
    phase: publishedTo(reviewer),
  },
  { kind: 'artifact', delayMs: 500, sourceNodeRef: resultRef(writer), title: v1.title, contentFixture: 'v1' },
  { kind: 'route', delayMs: 500, fromNodeRef: resultRef(writer), toAgentId: reviewer, routeKind: 'artifact', label: submitLabel },
  { kind: 'input', delayMs: 550, agentId: reviewer, title: submitLabel, body: v1.title },
  {
    kind: 'result',
    delayMs: 650,
    agentId: reviewer,
    title: returnLabel,
    body: templateFixture.sampleReturnNote,
    phase: messagedTo(writer),
  },
  { kind: 'route', delayMs: 500, fromNodeRef: resultRef(reviewer), toAgentId: writer, routeKind: 'message', label: returnLabel },
  { kind: 'input', delayMs: 600, agentId: writer, title: returnLabel, body: templateFixture.sampleReturnNote },
  {
    kind: 'result',
    delayMs: 700,
    agentId: writer,
    title: v2.title,
    body: v2.content,
    phase: publishedTo(reviewer),
  },
  { kind: 'artifact', delayMs: 500, sourceNodeRef: resultRef(writer), title: v2.title, contentFixture: 'v2' },
  { kind: 'route', delayMs: 500, fromNodeRef: resultRef(writer), toAgentId: reviewer, routeKind: 'artifact', label: submitLabel },
  { kind: 'input', delayMs: 550, agentId: reviewer, title: submitLabel, body: v2.title },
  {
    kind: 'result',
    delayMs: 650,
    agentId: reviewer,
    title: finalName,
    body: templateFixture.sampleApprovalNote,
    phase: submittedFinalPhase,
  },
  { kind: 'final', delayMs: 450, inputVersion: 2 },
];

export const MOCK_SCENARIOS: Record<MockScenarioId, MockScenarioDefinition> = {
  happy_path: {
    id: 'happy_path',
    label: '正常完成',
    description: '产出 V1 后审核通过，系统确认终稿。',
    steps: [
      { kind: 'input', delayMs: 500, agentId: writer, title: briefLabel, body: brief },
      writerSkillStep,
      {
        kind: 'result',
        delayMs: 600,
        agentId: writer,
        title: v1.title,
        body: v1.content,
        thinking: templateFixture.sampleThinking,
        phase: publishedTo(reviewer),
      },
      { kind: 'artifact', delayMs: 500, sourceNodeRef: resultRef(writer), title: v1.title, contentFixture: 'v1' },
      { kind: 'route', delayMs: 500, fromNodeRef: resultRef(writer), toAgentId: reviewer, routeKind: 'artifact', label: submitLabel },
      { kind: 'input', delayMs: 550, agentId: reviewer, title: submitLabel, body: v1.title },
      {
        kind: 'result',
        delayMs: 600,
        agentId: reviewer,
        title: finalName,
        body: templateFixture.sampleApprovalNote,
        phase: submittedFinalPhase,
      },
      { kind: 'final', delayMs: 450, inputVersion: 1 },
    ],
  },
  review_return_v2: {
    id: 'review_return_v2',
    label: '审核退回并生成 V2',
    description: 'V1 被审核退回，返修产出 V2 后复审通过并确认终稿。',
    steps: reviewReturnSteps,
  },
  transient_retry: {
    id: 'transient_retry',
    label: '瞬时错误后自动重试',
    description: '首次尝试失败一次，自动重试成功后正常完成。',
    steps: [
      { kind: 'input', delayMs: 500, agentId: writer, title: briefLabel, body: brief },
      { kind: 'transient_failure', delayMs: 450, nodeRef: inputRef(writer), attempt: 1 },
      {
        kind: 'result',
        delayMs: 700,
        agentId: writer,
        title: v1.title,
        body: v1.content,
        phase: publishedTo(reviewer),
      },
      { kind: 'artifact', delayMs: 500, sourceNodeRef: resultRef(writer), title: v1.title, contentFixture: 'v1' },
      { kind: 'route', delayMs: 500, fromNodeRef: resultRef(writer), toAgentId: reviewer, routeKind: 'artifact', label: submitLabel },
      { kind: 'input', delayMs: 550, agentId: reviewer, title: submitLabel, body: v1.title },
      {
        kind: 'result',
        delayMs: 600,
        agentId: reviewer,
        title: finalName,
        body: templateFixture.sampleApprovalNote,
        phase: submittedFinalPhase,
      },
      { kind: 'final', delayMs: 450, inputVersion: 1 },
    ],
  },
  manual_retry: {
    id: 'manual_retry',
    label: '自动重试耗尽后等待手动重试',
    description: '两次自动失败后停下等待手动重试，重试后跑完。',
    steps: [
      { kind: 'input', delayMs: 500, agentId: writer, title: briefLabel, body: brief },
      { kind: 'transient_failure', delayMs: 500, nodeRef: inputRef(writer), attempt: 1 },
      { kind: 'transient_failure', delayMs: 600, nodeRef: inputRef(writer), attempt: 2 },
      { kind: 'manual_failure', delayMs: 700, nodeRef: inputRef(writer) },
      {
        kind: 'result',
        delayMs: 800,
        agentId: writer,
        title: v1.title,
        body: v1.content,
        phase: publishedTo(reviewer),
      },
      { kind: 'artifact', delayMs: 500, sourceNodeRef: resultRef(writer), title: v1.title, contentFixture: 'v1' },
      { kind: 'route', delayMs: 500, fromNodeRef: resultRef(writer), toAgentId: reviewer, routeKind: 'artifact', label: submitLabel },
      { kind: 'input', delayMs: 550, agentId: reviewer, title: submitLabel, body: v1.title },
      {
        kind: 'result',
        delayMs: 600,
        agentId: reviewer,
        title: finalName,
        body: templateFixture.sampleApprovalNote,
        phase: submittedFinalPhase,
      },
      { kind: 'final', delayMs: 450, inputVersion: 1 },
    ],
  },
  human_input: {
    id: 'human_input',
    label: '等待用户补充信息',
    description: '请求用户回答后暂停，回答后同一 Agent 续跑并完成。',
    steps: [
      { kind: 'input', delayMs: 500, agentId: writer, title: briefLabel, body: brief },
      { kind: 'human_request', delayMs: 600, agentId: writer, question: templateFixture.sampleHumanQuestion },
      {
        kind: 'result',
        delayMs: 700,
        agentId: writer,
        title: v1.title,
        body: v1.content,
        phase: publishedTo(reviewer),
      },
      { kind: 'artifact', delayMs: 500, sourceNodeRef: resultRef(writer), title: v1.title, contentFixture: 'v1' },
      { kind: 'route', delayMs: 500, fromNodeRef: resultRef(writer), toAgentId: reviewer, routeKind: 'artifact', label: submitLabel },
      { kind: 'input', delayMs: 550, agentId: reviewer, title: submitLabel, body: v1.title },
      {
        kind: 'result',
        delayMs: 600,
        agentId: reviewer,
        title: finalName,
        body: templateFixture.sampleApprovalNote,
        phase: submittedFinalPhase,
      },
      { kind: 'final', delayMs: 450, inputVersion: 1 },
    ],
  },
  refresh_recovery: {
    id: 'refresh_recovery',
    label: '运行中刷新并恢复',
    description: '每一步都持久化下一步与到期时间，刷新后从最后确认步骤续跑到终稿。',
    steps: reviewReturnSteps,
  },
};

/**
 * The scenario a freshly started task plays when neither the task record nor
 * the development console has chosen one: the full return loop, so the main
 * demo path always shows V1, a return, V2 and system acceptance.
 */
export const DEFAULT_START_SCENARIO: MockScenarioId = 'review_return_v2';
