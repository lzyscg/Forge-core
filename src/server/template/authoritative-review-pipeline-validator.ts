/**
 * Authoritative (v2) pipeline: roles, v4 turn contracts, system producer and
 * forbidden Agent Routes (Task 5, spec §6.3/§6.4, design §9).
 *
 * Runs on a frozen v2 template (contract version 2) and enforces:
 *
 * - exactly one binding per role; the four bindings are distinct, declared
 *   Agents and cover every declared Agent;
 * - reviewer independence: the reviewer id differs from the orchestrator, the
 *   generator and every Agent allowed to write Map/content (design §9 — the
 *   reviewer structurally has no write session kind);
 * - `system:structured_seal` is not an Agent and never a Route endpoint;
 * - structured roles never Route completion to review, repair, Seal, artifact
 *   publication, or the Submitter; the reviewer has no outgoing routes;
 * - the Submitter accepts only SystemArtifactDelivery: a generic
 *   BasicTurnContractV2 with no production/annotate and no sending intents;
 * - the artifact schema's create producer is exactly `{system:
 *   structured_seal}` and no annotate files exist in v2;
 * - no v2 Agent exposes `request_seal` (v3/v1 contracts are rejected outright);
 * - the v4 session-kind floors and the bound access-profile ceilings (design
 *   §9 per-session table).
 *
 * The safe Agent-ID regex is NEVER relaxed: `system:structured_seal` cannot
 * pass `asSafeId`, so the loader's route/agent identity checks and this
 * validator's literal guards agree that it is only ever the system producer.
 */
import {
  TEMPLATE_ERROR_CODES,
  TemplateError,
  type ArtifactSystemProducerRef,
  type AuthoritativeReviewLifecycleV1,
  type AuthoritativeStructuredTurnContractV4,
  type FrozenAgentConfig,
  type FrozenTemplate,
} from './template-schema';
import type {
  SlotCapabilityV2,
  StructuredSessionKindV2,
} from './structured-slot-contract-v2';
import { SLOT_CAPABILITIES_V2 } from './structured-slot-contract-v2';
import type { FrozenStructuredSlotContractV2 } from './structured-slot-contract-v2';

const RELOAD_ACTION = '修正模板文件后重新加载模板。';

/** The frozen system producer identity (spec §6.3). */
export const SYSTEM_ARTIFACT_PRODUCER_IDENTITY = 'system:structured_seal';

/** The closed system producer reference (spec §6.3 discriminator). */
export const SYSTEM_ARTIFACT_PRODUCER_REF: ArtifactSystemProducerRef = Object.freeze({
  kind: 'system',
  systemId: 'structured_seal',
});

/** The four session kinds that write Map or content (design §9). */
export const V2_WRITE_SESSION_KINDS: readonly StructuredSessionKindV2[] = [
  'structure_chunk',
  'generation_batch',
  'map_repair',
  'content_repair',
];

/** The four review session kinds (the reviewer role's floor). */
export const V2_REVIEW_SESSION_KINDS: readonly StructuredSessionKindV2[] = [
  'review_map_batch',
  'review_map_whole',
  'review_content_batch',
  'review_content_whole',
];

/**
 * Role floors (design §6.4/§9): the orchestrator handles structure chunks and
 * Map repair, the generator handles generation and content repair, the
 * reviewer handles Map/content batch and whole observations.
 */
export const V2_ROLE_REQUIRED_SESSION_KINDS: Readonly<
  Record<'orchestrator' | 'generator' | 'reviewer', readonly StructuredSessionKindV2[]>
> = {
  orchestrator: ['structure_chunk', 'map_repair'],
  generator: ['generation_batch', 'content_repair'],
  reviewer: V2_REVIEW_SESSION_KINDS,
};

/**
 * Per-kind required capability floor (design §9 per-session table, transcribed
 * exactly; `write_map_patch` comes from the map_repair row as recorded in the
 * Task 4 report).
 */
export const V2_REQUIRED_CAPABILITIES_BY_SESSION: Readonly<
  Record<StructuredSessionKindV2, readonly SlotCapabilityV2[]>
> = {
  structure_chunk: [
    'read_structure_contract',
    'read_map_build_frontier',
    'append_map_candidate_chunk',
    'finish_map_build',
  ],
  review_map_batch: [
    'read_map_candidate',
    'submit_map_node_review',
    'submit_map_relation_review',
    'submit_finding_verification',
    'complete_review_assignment',
  ],
  review_map_whole: [
    'read_map_candidate',
    'submit_map_whole_finding',
    'submit_finding_verification',
    'complete_review_assignment',
  ],
  generation_batch: ['read_active_map', 'read_slot_content', 'write_slot_content', 'submit_content_draft'],
  review_content_batch: [
    'read_active_map',
    'read_slot_content',
    'submit_slot_review',
    'submit_relation_review',
    'submit_finding_verification',
    'complete_review_assignment',
  ],
  review_content_whole: [
    'read_active_map',
    'read_slot_content',
    'submit_whole_tree_finding',
    'submit_finding_verification',
    'complete_review_assignment',
  ],
  map_repair: [
    'read_active_map',
    'read_slot_content',
    'read_map_repair_staging',
    'write_map_patch',
    'submit_map_patch',
    'request_scope_expansion',
  ],
  content_repair: [
    'read_active_map',
    'read_slot_content',
    'write_slot_content',
    'submit_content_draft',
    'request_scope_expansion',
  ],
};

/** Re-export of the closed capability union for consumers (single source). */
export { SLOT_CAPABILITIES_V2 };

function pipelineInvalid(location: string, message: string): never {
  throw new TemplateError(TEMPLATE_ERROR_CODES.TEMPLATE_INVALID, message, location, RELOAD_ACTION);
}

function agentFile(agentId: string): string {
  return `agents/${agentId}.yaml`;
}

function lifecycleOf(frozen: FrozenTemplate): AuthoritativeReviewLifecycleV1 {
  if (frozen.structuredReviewLifecycle === null) {
    pipelineInvalid('pipeline.yaml', 'contract v2 模板必须声明 structuredReviewLifecycle。');
  }
  return frozen.structuredReviewLifecycle;
}

/** The v2 contract (version asserted by the caller; fail-closed here too). */
function contractV2Of(frozen: FrozenTemplate): FrozenStructuredSlotContractV2 {
  if (frozen.structuredSlots === null || frozen.structuredSlots.version !== 2) {
    pipelineInvalid('pipeline.yaml', 'authoritative 流水线校验仅适用于 contract v2 模板。');
  }
  return frozen.structuredSlots;
}

function v4Of(agent: FrozenAgentConfig): AuthoritativeStructuredTurnContractV4 {
  const tc = agent.turnContract;
  if (tc === null || tc.version !== 4) {
    pipelineInvalid(agentFile(agent.id), `Agent ${agent.id} 必须携带 v4 回合契约。`);
  }
  if (agent.slotCapabilities.length > 0) {
    pipelineInvalid(
      agentFile(agent.id),
      `Agent ${agent.id} 的 slotCapabilities 是 v1 域字段，v2 能力上限来自 contract 的 accessProfiles。`,
    );
  }
  for (const capability of agent.slotCapabilities) {
    if (capability === 'request_seal') {
      pipelineInvalid(agentFile(agent.id), 'v2 不允许任何 Agent 暴露 request_seal。');
    }
  }
  return tc;
}

/** Exactly one binding per role; distinct; declared; covers every declared Agent. */
function assertRoleBindings(
  lifecycle: AuthoritativeReviewLifecycleV1,
  frozen: FrozenTemplate,
): { orchestrator: FrozenAgentConfig; generator: FrozenAgentConfig; reviewer: FrozenAgentConfig; submitter: FrozenAgentConfig } {
  const bindings = lifecycle.roleBindings;
  const boundIds = Object.values(bindings);
  // Reviewer independence (design §9): checked first with a specific message
  // so an overlapping binding is never silently treated as a generic duplicate.
  if (bindings.reviewer === bindings.orchestrator || bindings.reviewer === bindings.generator) {
    pipelineInvalid(
      'pipeline.yaml',
      `reviewer 身份 ${bindings.reviewer} 与 orchestrator/generator 重叠，独立审核被破坏。`,
    );
  }
  const distinct = new Set(boundIds);
  if (distinct.size !== 4) {
    pipelineInvalid(
      'pipeline.yaml',
      '每个角色必须恰好一个绑定：四个角色必须绑定四个不同的 Agent 身份。',
    );
  }
  for (const id of boundIds) {
    if (id === SYSTEM_ARTIFACT_PRODUCER_IDENTITY) {
      pipelineInvalid('pipeline.yaml', `${SYSTEM_ARTIFACT_PRODUCER_IDENTITY} 是系统生产者，不是 Agent。`);
    }
  }
  const agents = new Map(frozen.agents.map((agent) => [agent.id, agent] as const));
  for (const id of boundIds) {
    if (!agents.has(id)) {
      pipelineInvalid('pipeline.yaml', `角色绑定的 Agent ${id} 未在 pipeline.yaml 的 agents 列表中声明。`);
    }
  }
  for (const agent of frozen.agents) {
    if (!distinct.has(agent.id)) {
      pipelineInvalid(
        agentFile(agent.id),
        `Agent ${agent.id} 未绑定任何权威评审角色（每个声明 Agent 必须恰好绑定一个角色）。`,
      );
    }
  }
  return {
    orchestrator: agents.get(bindings.orchestrator) as FrozenAgentConfig,
    generator: agents.get(bindings.generator) as FrozenAgentConfig,
    reviewer: agents.get(bindings.reviewer) as FrozenAgentConfig,
    submitter: agents.get(bindings.submitter) as FrozenAgentConfig,
  };
}

/** Reviewer independence (design §9): differs from every Map/content write Agent. */
function assertReviewerIndependence(
  reviewer: FrozenAgentConfig,
  writeAgents: readonly FrozenAgentConfig[],
): void {
  for (const writer of writeAgents) {
    if (writer.id === reviewer.id) {
      pipelineInvalid(
        agentFile(reviewer.id),
        `reviewer 身份 ${reviewer.id} 与可写（write）Map/内容的 Agent 身份重叠，独立审核被破坏。`,
      );
    }
  }
}

/** The v4 capability matrix: floors per session kind within the bound profiles. */
function assertV4CapabilityMatrix(
  agent: FrozenAgentConfig,
  contract: FrozenStructuredSlotContractV2,
  allowedKinds: readonly StructuredSessionKindV2[],
): void {
  const v4 = v4Of(agent);
  const session = v4.authoritativeReview;
  const accessProfileIds = new Map(
    contract.accessProfiles.map((profile) => [profile.id, profile.capabilities] as const),
  );
  for (const kind of allowedKinds) {
    const required = V2_REQUIRED_CAPABILITIES_BY_SESSION[kind];
    for (const capability of required) {
      if (!session.capabilities.includes(capability)) {
        pipelineInvalid(
          agentFile(agent.id),
          `Agent ${agent.id} 的 ${kind} 会话缺少必需能力 ${capability}。`,
        );
      }
    }
    const bound = session.accessProfiles[kind];
    if (bound !== null && bound !== undefined) {
      const ceiling = accessProfileIds.get(bound);
      if (ceiling === undefined) {
        pipelineInvalid(
          agentFile(agent.id),
          `Agent ${agent.id} 引用了未知的 accessProfile ${bound}。`,
        );
      }
      for (const capability of session.capabilities) {
        if (!ceiling.includes(capability)) {
          pipelineInvalid(
            agentFile(agent.id),
            `Agent ${agent.id} 的能力 ${capability} 超出 accessProfile ${bound} 的上限。`,
          );
        }
      }
    } else if (bound === undefined) {
      pipelineInvalid(
        agentFile(agent.id),
        `Agent ${agent.id} 的会话类型 ${kind} 未在 accessProfiles 中声明。`,
      );
    }
  }
  for (const capability of session.capabilities) {
    if (!(SLOT_CAPABILITIES_V2 as readonly string[]).includes(capability)) {
      pipelineInvalid(
        agentFile(agent.id),
        `Agent ${agent.id} 声明了封闭联合之外的能力 ${capability}。`,
      );
    }
  }
}

/** The Submitter accepts only SystemArtifactDelivery (spec §6.3/§13.5). */
function assertSubmitterDeliveryOnly(submitter: FrozenAgentConfig): void {
  const tc = submitter.turnContract;
  if (tc === null || tc.version !== 2) {
    pipelineInvalid(
      agentFile(submitter.id),
      `submitter ${submitter.id} 必须是通用 BasicTurnContractV2 Agent（只接受 SystemArtifactDelivery）。`,
    );
  }
  if (tc.production !== undefined || tc.annotate !== undefined) {
    pipelineInvalid(
      agentFile(submitter.id),
      `submitter ${submitter.id} 不能声明 production 或 annotate。`,
    );
  }
  const nonHuman = tc.dispatch.allowedActions.filter((action) => action !== 'request_human_input');
  if (nonHuman.length !== 1 || nonHuman[0] !== 'submit_final_artifact') {
    pipelineInvalid(
      agentFile(submitter.id),
      `submitter ${submitter.id} 只允许 submit_final_artifact（外加可选 request_human_input）。`,
    );
  }
  const targets = Object.keys(tc.dispatch.targets);
  if (targets.length > 0) {
    pipelineInvalid(
      agentFile(submitter.id),
      `submitter ${submitter.id} 不能声明发送目标（仅接收系统交付）。`,
    );
  }
}

/** No v2 Agent exposes `request_seal`; v3/v1 contracts are rejected outright. */
function assertNoLegacyOrSealContracts(frozen: FrozenTemplate): void {
  for (const agent of frozen.agents) {
    if (agent.turnContract !== null && agent.turnContract.version === 3) {
      pipelineInvalid(
        agentFile(agent.id),
        `v2 模板不能声明旧版本 v3 回合契约（${agent.id} 携带 v1 协议 seal 会话形状）。`,
      );
    }
    if (agent.turnContract !== null && agent.turnContract.version === 1) {
      pipelineInvalid(agentFile(agent.id), `v2 模板不能声明 v1 基本回合契约。`);
    }
    for (const capability of agent.slotCapabilities) {
      if (capability === 'request_seal') {
        pipelineInvalid(agentFile(agent.id), 'v2 不允许任何 Agent 暴露 request_seal。');
      }
    }
  }
}

/** Route matrix (spec §6.3 / design §9): no Agent-controlled completion edges. */
function assertRouteMatrix(
  frozen: FrozenTemplate,
  lifecycle: AuthoritativeReviewLifecycleV1,
  reviewer: FrozenAgentConfig,
  submitter: FrozenAgentConfig,
): void {
  for (const route of frozen.routes) {
    if (route.from === SYSTEM_ARTIFACT_PRODUCER_IDENTITY || route.to === SYSTEM_ARTIFACT_PRODUCER_IDENTITY) {
      pipelineInvalid('pipeline.yaml', `${SYSTEM_ARTIFACT_PRODUCER_IDENTITY} 不能作为 Route 端点。`);
    }
    if (route.kind === 'artifact') {
      pipelineInvalid(
        'pipeline.yaml',
        `v2 不允许 artifact Route（${
          route.from
        } → ${route.to}）：系统 Seal 是唯一的生产者（spec §6.3）。`,
      );
    }
    if (route.from === reviewer.id) {
      pipelineInvalid(
        'pipeline.yaml',
        `reviewer ${reviewer.id} 不能声明任何 completion Route（v2 完全由系统协调）。`,
      );
    }
    if (route.to === reviewer.id) {
      pipelineInvalid(
        'pipeline.yaml',
        `structured 角色不能 Route completion 到 reviewer（${reviewer.id}）。`,
      );
    }
    if (route.to === submitter.id) {
      pipelineInvalid(
        'pipeline.yaml',
        `structured 角色不能 Route completion 到 submitter（${submitter.id}）。`,
      );
    }
  }
}

/** Artifact schema matrix: every create producer is exactly the system producer. */
function assertArtifactSchema(frozen: FrozenTemplate): void {
  for (const file of frozen.artifactSchema.files) {
    if (file.phase === 'annotate') {
      pipelineInvalid('pipeline.yaml', 'v2 不存在 annotate 文件：系统 Seal 发布 artifact，无 Agent 注解面。');
    }
    if (typeof file.producer === 'string' || file.producer.kind !== 'system' || file.producer.systemId !== 'structured_seal') {
      pipelineInvalid(
        'pipeline.yaml',
        `artifactSchema 的 create producer 必须精确等于 { system: structured_seal }（文件 ${file.name}）。`,
      );
    }
  }
}

/** Final output: exactly the submitter binding (system delivery target). */
function assertFinalOutput(frozen: FrozenTemplate, lifecycle: AuthoritativeReviewLifecycleV1): void {
  const submitters = frozen.finalOutput.submitters;
  if (submitters.length !== 1 || submitters[0] !== lifecycle.roleBindings.submitter) {
    pipelineInvalid(
      'pipeline.yaml',
      `finalOutput.submitters 必须精确等于 submitter 绑定（${lifecycle.roleBindings.submitter}）。`,
    );
  }
}

/**
 * Validates one frozen v2 pipeline and returns nothing on success (throws a
 * `TemplateError` on any violation). Only meaningful for contract-v2
 * structured templates; the loader dispatches here (never on v1).
 */
export function validateAuthoritativeReviewPipeline(frozen: FrozenTemplate): void {
  if (frozen.productionMode !== 'structured_slots') {
    pipelineInvalid('pipeline.yaml', 'authoritative 流水线校验仅适用于 structured_slots 模板。');
  }
  const contract = contractV2Of(frozen);
  const lifecycle = lifecycleOf(frozen);
  const roles = assertRoleBindings(lifecycle, frozen);
  assertNoLegacyOrSealContracts(frozen);

  // Reviewer independence is structural: the reviewer agent may only carry
  // review session kinds, so it can never write Map/content (design §9).
  const writeAgents = frozen.agents.filter((agent) =>
    agent.turnContract !== null &&
    agent.turnContract.version === 4 &&
    agent.turnContract.authoritativeReview.allowedSessionKinds.some((kind) =>
      V2_WRITE_SESSION_KINDS.includes(kind),
    ),
  );
  assertReviewerIndependence(roles.reviewer, writeAgents);

  // Role floors + capability matrix per Agent.
  const roleAgents: Array<[string, readonly StructuredSessionKindV2[], FrozenAgentConfig]> = [
    ['orchestrator', V2_ROLE_REQUIRED_SESSION_KINDS.orchestrator, roles.orchestrator],
    ['generator', V2_ROLE_REQUIRED_SESSION_KINDS.generator, roles.generator],
    ['reviewer', V2_ROLE_REQUIRED_SESSION_KINDS.reviewer, roles.reviewer],
  ];
  for (const [role, kinds, agent] of roleAgents) {
    const v4 = v4Of(agent);
    for (const kind of kinds) {
      if (!v4.authoritativeReview.allowedSessionKinds.includes(kind)) {
        pipelineInvalid(
          agentFile(agent.id),
          `${role} 角色（${agent.id}）必须支持会话类型 ${kind}。`,
        );
      }
    }
    const extras = v4.authoritativeReview.allowedSessionKinds.filter((kind) => !kinds.includes(kind));
    if (extras.length > 0) {
      pipelineInvalid(
        agentFile(agent.id),
        `${role} 角色（${agent.id}）声明了角色外会话类型 ${extras.join(',')}。`,
      );
    }
    assertV4CapabilityMatrix(agent, contract, kinds);
  }
  assertSubmitterDeliveryOnly(roles.submitter);
  assertRouteMatrix(frozen, lifecycle, roles.reviewer, roles.submitter);
  assertArtifactSchema(frozen);
  assertFinalOutput(frozen, lifecycle);
}