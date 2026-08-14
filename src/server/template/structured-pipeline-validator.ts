/**
 * Structured pipeline typestate + capability + dispatch validator (Task 5).
 *
 * Runs on a frozen structured template (spec §3.2 / design §11.4/§11.6):
 *
 * - Capability matrix (spec §3.2 table, design M02): each v3 slot session must
 *   carry the kind's complete required set, must not exceed the kind allowlist,
 *   and every session capability must be inside the Agent YAML `slotCapabilities`
 *   static ceiling. fill/seal must reference a known access profile id.
 * - Dispatch matrix (design L01/H05): structure/fill may only dispatch
 *   `send_message` (plus the optional human interrupt); seal must declare
 *   `send_message` plus at least one success dispatch, and its rework send
 *   targets must be v3 fill/structure nodes; post-Seal v2 nodes cannot declare
 *   production or send back toward the slot phase.
 * - Typestate (spec §6 / design §11.6): three-state
 *   `no_scaffold | active_unsealed | sealed` fixed-point propagation over all
 *   reachable routes. The sole initial agent must be v3 structure; fill/seal
 *   require active_unsealed input; seal success outputs sealed; sealed routes
 *   to v2 artifact nodes only and never back to v3; the seal rework edge
 *   (`seal_gate_failed -> send_message`) stays active_unsealed and targets v3
 *   fill/structure. Any edge whose output phase is outside the target's input
 *   precondition fails the template load (no runtime "maybe this edge is never
 *   taken" escape).
 *
 * Returns the compiled phase contract: `Map<agentId, ReadonlySet<ScaffoldPhase>>`
 * of every input phase each agent may run under. The loader stores this
 * contract in the frozen template so snapshots carry it.
 *
 * Platform vocabulary only — no business words (iron rule 1).
 */
import {
  TEMPLATE_ERROR_CODES,
  TemplateError,
  type FrozenAgentConfig,
  type FrozenTemplate,
  type ScaffoldPhase,
  type SlotCapabilityV1,
  type StructuredTurnContractV3,
  type TurnContract,
} from './template-schema';
import type { FrozenStructuredSlotContractV1 } from './structured-slot-contract';

const RELOAD_ACTION = '修正模板文件后重新加载模板。';

/** Per-kind closed capability allowlist (design §11.4). */
export const SLOT_SESSION_CAPABILITY_ALLOWLIST_V3: Readonly<
  Record<'structure' | 'fill' | 'seal', readonly SlotCapabilityV1[]>
> = {
  structure: [
    'read_structure_contract',
    'write_structure_proposal',
    'validate_structure_proposal',
    'submit_structure_proposal',
  ],
  fill: ['read_slot_spec', 'read_slot_content', 'write_draft_content', 'validate_draft', 'submit_draft'],
  seal: ['read_slot_spec', 'read_slot_content', 'request_seal'],
};

/** Per-kind minimum completion capability set (design §11.4 / M02). */
export const SLOT_SESSION_REQUIRED_CAPABILITIES_V3: Readonly<
  Record<'structure' | 'fill' | 'seal', readonly SlotCapabilityV1[]>
> = {
  structure: ['read_structure_contract', 'write_structure_proposal', 'submit_structure_proposal'],
  fill: ['read_slot_spec', 'read_slot_content', 'write_draft_content', 'submit_draft'],
  seal: ['request_seal'],
};

/** Dispatch intents a post-Seal v2 node may use (design L03). */
const V2_POST_SEAL_ALLOWED_ACTIONS: readonly string[] = [
  'forward_input_version',
  'submit_final_artifact',
  'request_human_input',
];

function pipelineInvalid(location: string, message: string): never {
  throw new TemplateError(TEMPLATE_ERROR_CODES.TEMPLATE_INVALID, message, location, RELOAD_ACTION);
}

function agentFile(agentId: string): string {
  return `agents/${agentId}.yaml`;
}

/** The v3 session kind of a slot agent, or null when not a v3 contract. */
function v3Kind(contract: TurnContract | null): 'structure' | 'fill' | 'seal' | null {
  if (contract === null || contract.version !== 3) {
    return null;
  }
  return contract.slotSession.kind;
}

/** Capability matrix of one agent (spec §3.2 table, design D02/M02). */
function assertCapabilityMatrix(
  agent: FrozenAgentConfig,
  contract: FrozenStructuredSlotContractV1,
): void {
  const tc = agent.turnContract;
  if (tc === null) {
    pipelineInvalid(agentFile(agent.id), `Agent ${agent.id} 缺少回合契约，结构化流水线无法校验。`);
  }
  if (tc.version !== 3) {
    return; // v2 post-Seal node carries no slot capabilities.
  }
  const session = tc.slotSession;
  const kind = session.kind;
  const allowlist = SLOT_SESSION_CAPABILITY_ALLOWLIST_V3[kind];
  const required = SLOT_SESSION_REQUIRED_CAPABILITIES_V3[kind];

  for (const capability of required) {
    if (!session.capabilities.includes(capability)) {
      pipelineInvalid(
        agentFile(agent.id),
        `Agent ${agent.id}（${kind}）缺少必需能力 ${capability}。`,
      );
    }
  }
  for (const capability of session.capabilities) {
    if (!allowlist.includes(capability)) {
      pipelineInvalid(
        agentFile(agent.id),
        `Agent ${agent.id}（${kind}）声明了不属于该阶段能力允许表的能力 ${capability}。`,
      );
    }
    if (!agent.slotCapabilities.includes(capability)) {
      pipelineInvalid(
        agentFile(agent.id),
        `Agent ${agent.id} 的会话能力 ${capability} 超出其 slotCapabilities 静态上限。`,
      );
    }
  }
  if (kind !== 'structure') {
    const profileId = session.accessProfile;
    if (!contract.accessProfiles.some((profile) => profile.id === profileId)) {
      pipelineInvalid(
        agentFile(agent.id),
        `Agent ${agent.id} 引用了未知的 accessProfile ${profileId}。`,
      );
    }
  }
}

/** Dispatch matrix of one v3 slot agent (design L01/H05). */
function assertV3Dispatch(agent: FrozenAgentConfig, agents: ReadonlyMap<string, FrozenAgentConfig>): void {
  const tc = agent.turnContract as StructuredTurnContractV3;
  const kind = tc.slotSession.kind;
  const allowed = tc.dispatch.allowedActions;
  if (kind === 'structure' || kind === 'fill') {
    const nonHuman = allowed.filter((action) => action !== 'request_human_input');
    if (nonHuman.length !== 1 || nonHuman[0] !== 'send_message') {
      pipelineInvalid(
        agentFile(agent.id),
        `Agent ${agent.id}（${kind}）的非人工分发只能且必须为 send_message。`,
      );
    }
    return;
  }
  // seal: send_message for reliable-failure rework plus one success dispatch.
  if (!allowed.includes('send_message')) {
    pipelineInvalid(
      agentFile(agent.id),
      `Agent ${agent.id}（seal）必须声明 send_message 用于可靠失败返工。`,
    );
  }
  if (!allowed.includes('publish_artifact') && !allowed.includes('submit_final_artifact')) {
    pipelineInvalid(
      agentFile(agent.id),
      `Agent ${agent.id}（seal）必须声明 publish_artifact 或 submit_final_artifact 成功分发。`,
    );
  }
  const reworkTargets = tc.dispatch.targets.send_message ?? [];
  if (reworkTargets.length === 0) {
    pipelineInvalid(
      agentFile(agent.id),
      `Agent ${agent.id}（seal）必须声明至少一个 send_message 返工目标。`,
    );
  }
  for (const targetId of reworkTargets) {
    const target = agents.get(targetId);
    const targetKind = target === undefined ? null : v3Kind(target.turnContract);
    if (targetKind !== 'fill' && targetKind !== 'structure') {
      pipelineInvalid(
        agentFile(agent.id),
        `Agent ${agent.id}（seal）的 send_message 返工目标 ${targetId} 必须是 v3 fill/structure 节点。`,
      );
    }
  }
}

/** Dispatch matrix of one post-Seal v2 node (design L03). */
function assertV2PostSeal(agent: FrozenAgentConfig): void {
  const tc = agent.turnContract;
  if (tc === null || tc.version === 3) {
    return;
  }
  if (tc.version === 4) {
    pipelineInvalid(
      agentFile(agent.id),
      `v1 structured 模板不能携带 v4 回合契约（${agent.id} 的 v4 契约属于 contract v2 协议）。`,
    );
  }
  if (tc.production !== undefined) {
    pipelineInvalid(
      agentFile(agent.id),
      `Seal 后的 v2 Agent ${agent.id} 不能声明 production。`,
    );
  }
  for (const action of tc.dispatch.allowedActions) {
    if (!V2_POST_SEAL_ALLOWED_ACTIONS.includes(action)) {
      pipelineInvalid(
        agentFile(agent.id),
        `Seal 后的 v2 Agent ${agent.id} 不允许分发 ${action}。`,
      );
    }
  }
}

/** Per-agent matrix checks (capability + dispatch). */
function assertAgentMatrices(
  frozen: FrozenTemplate,
  contract: FrozenStructuredSlotContractV1,
): void {
  const agents = new Map(frozen.agents.map((agent) => [agent.id, agent] as const));
  for (const agent of frozen.agents) {
    assertCapabilityMatrix(agent, contract);
    if (v3Kind(agent.turnContract) !== null) {
      assertV3Dispatch(agent, agents);
    } else {
      assertV2PostSeal(agent);
    }
  }
}

/** Input phases a node may run under (spec §6 transition table). */
function inputPhasesFor(agent: FrozenAgentConfig): ReadonlySet<ScaffoldPhase> {
  const tc = agent.turnContract;
  if (tc !== null && tc.version === 3) {
    switch (tc.slotSession.kind) {
      case 'structure':
        return new Set<ScaffoldPhase>(['no_scaffold', 'active_unsealed']);
      case 'fill':
        return new Set<ScaffoldPhase>(['active_unsealed']);
      case 'seal':
        return new Set<ScaffoldPhase>(['active_unsealed']);
    }
  }
  // v2 post-Seal artifact node.
  return new Set<ScaffoldPhase>(['sealed']);
}

/** Output phase a successful dispatch edge produces for its target. */
function outputPhaseFor(from: FrozenAgentConfig, route: FrozenTemplate['routes'][number]): ScaffoldPhase {
  const tc = from.turnContract;
  if (tc !== null && tc.version === 3) {
    if (tc.slotSession.kind === 'seal') {
      // A seal message route is the reliable-failure rework edge (stays
      // active_unsealed); an artifact route is the success publish edge (sealed).
      return route.kind === 'message' ? 'active_unsealed' : 'sealed';
    }
    return 'active_unsealed'; // structure/fill success output.
  }
  return 'sealed'; // v2 post-Seal stays sealed.
}

/** Three-state fixed-point typestate propagation (spec §6 / design §11.6). */
function computeTypestate(frozen: FrozenTemplate): Map<string, ReadonlySet<ScaffoldPhase>> {
  const agents = new Map(frozen.agents.map((agent) => [agent.id, agent] as const));
  const initial = frozen.agents[0];
  if (initial === undefined) {
    pipelineInvalid('pipeline.yaml', 'structured 流水线至少需要一个 Agent。');
  }
  const initialKind = v3Kind(initial.turnContract);
  if (initialKind !== 'structure') {
    pipelineInvalid('pipeline.yaml', 'structured 流水线的首节点必须是 v3 structure Agent。');
  }

  const phases = new Map<string, Set<ScaffoldPhase>>();
  phases.set(initial.id, new Set<ScaffoldPhase>(['no_scaffold']));

  let changed = true;
  while (changed) {
    changed = false;
    for (const route of frozen.routes) {
      const fromPhases = phases.get(route.from);
      if (fromPhases === undefined || fromPhases.size === 0) {
        continue; // Source not yet reached; revisit on a later pass.
      }
      const from = agents.get(route.from);
      const to = agents.get(route.to);
      if (from === undefined || to === undefined) {
        continue; // Route endpoint existence is validated by the loader.
      }
      const output = outputPhaseFor(from, route);
      const precondition = inputPhasesFor(to);
      if (!precondition.has(output)) {
        pipelineInvalid(
          'pipeline.yaml',
          `路由 ${route.from} → ${route.to} 的输出相位 ${output} 不满足目标 Agent 的前置相位。`,
        );
      }
      const targetPhases = phases.get(route.to) ?? new Set<ScaffoldPhase>();
      if (!targetPhases.has(output)) {
        targetPhases.add(output);
        phases.set(route.to, targetPhases);
        changed = true;
      }
    }
  }

  const result = new Map<string, ReadonlySet<ScaffoldPhase>>();
  for (const [agentId, set] of phases) {
    result.set(agentId, Object.freeze(new Set(set)));
  }
  return result;
}

/**
 * Validates one structured pipeline and returns the compiled phase contract.
 * Throws a `TemplateError` (TEMPLATE_INVALID) on any capability, dispatch or
 * typestate violation. Only meaningful for `productionMode: 'structured_slots'`
 * CONTRACT V1 templates: v4 turn contracts and the v2 lifecycle block belong
 * to the authoritative (v2) pipeline validator (spec §4.2 — v1 receives no
 * new defaults; cross-version fields fail rather than being ignored).
 */
export function validateStructuredPipeline(
  frozen: FrozenTemplate,
): Map<string, ReadonlySet<ScaffoldPhase>> {
  if (frozen.productionMode !== 'structured_slots' || frozen.structuredSlots === null) {
    pipelineInvalid('pipeline.yaml', '结构化流水线校验仅适用于 structured_slots 模板。');
  }
  if (frozen.structuredSlots.version !== 1) {
    pipelineInvalid('pipeline.yaml', 'v1 结构化流水线校验仅适用于 contract version 1 模板。');
  }
  if (frozen.structuredReviewLifecycle !== null) {
    pipelineInvalid('pipeline.yaml', 'structuredReviewLifecycle 仅适用于 contract v2 模板。');
  }
  assertAgentMatrices(frozen, frozen.structuredSlots);
  return computeTypestate(frozen);
}
