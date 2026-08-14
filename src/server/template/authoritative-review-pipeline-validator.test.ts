// @vitest-environment node
/**
 * Authoritative (v2) pipeline validator tests (Task 5 Steps 1-3, red first).
 *
 * Role bindings (spec §6.3): exactly one binding per role, reviewer differs
 * from orchestrator/generator and every Map/content write agent,
 * `system:structured_seal` is never an Agent or Route endpoint, structured
 * roles never Route completion to review/repair/Seal/publication/Submitter,
 * the Submitter accepts only SystemArtifactDelivery, the artifact create
 * producer is exactly `system:structured_seal`, and no v2 Agent exposes
 * `request_seal`. The v4 capability floor matrix (design §9 per-session table)
 * is enforced here too.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileStructuredSlotContractV2,
  type FrozenStructuredSlotContractV2,
  type SlotCapabilityV2,
  type StructuredSessionKindV2,
} from './structured-slot-contract-v2';
import { validateAuthoritativeReviewPipeline } from './authoritative-review-pipeline-validator';
import type { AuthoritativeReviewLifecycleV1, BasicTurnContractV2, SlotCapabilityV1 } from './template-schema';
import type { AuthoritativeStructuredTurnContractV4 } from './template-schema';
import type { FrozenAgentConfig, FrozenTemplate, TurnContract } from './template-schema';

const FIXTURE_ROOT = fileURLToPath(new URL('__fixtures__/authoritative-valid', import.meta.url));

/** A valid v4 contract for the orchestrator binding (structure_chunk + map_repair). */
function structureV4(overrides: Partial<AuthoritativeStructuredTurnContractV4> = {}): AuthoritativeStructuredTurnContractV4 {
  return {
    version: 4,
    authoritativeReview: {
      allowedSessionKinds: ['structure_chunk', 'map_repair'],
      accessProfiles: { structure_chunk: 'builder', map_repair: 'builder' },
      capabilities: [
        'read_structure_contract',
        'read_map_build_frontier',
        'append_map_candidate_chunk',
        'finish_map_build',
        'read_active_map',
        'read_slot_content',
        'read_map_repair_staging',
        'write_map_patch',
        'submit_map_patch',
        'request_scope_expansion',
      ],
    },
    dispatch: { allowedActions: [], targets: {} },
    ...overrides,
  };
}

/** A valid v4 contract for the generator binding (generation_batch + content_repair). */
function fillV4(overrides: Partial<AuthoritativeStructuredTurnContractV4> = {}): AuthoritativeStructuredTurnContractV4 {
  return {
    version: 4,
    authoritativeReview: {
      allowedSessionKinds: ['generation_batch', 'content_repair'],
      accessProfiles: { generation_batch: 'builder', content_repair: 'builder' },
      capabilities: [
        'read_active_map',
        'read_slot_content',
        'write_slot_content',
        'submit_content_draft',
        'request_scope_expansion',
      ],
    },
    dispatch: { allowedActions: [], targets: {} },
    ...overrides,
  };
}

/** A valid v4 contract for the reviewer binding (all four review session kinds). */
function reviewV4(overrides: Partial<AuthoritativeStructuredTurnContractV4> = {}): AuthoritativeStructuredTurnContractV4 {
  return {
    version: 4,
    authoritativeReview: {
      allowedSessionKinds: ['review_map_batch', 'review_map_whole', 'review_content_batch', 'review_content_whole'],
      accessProfiles: {
        review_map_batch: 'reviewer',
        review_map_whole: 'reviewer',
        review_content_batch: 'reviewer',
        review_content_whole: 'reviewer',
      },
      capabilities: [
        'read_map_candidate',
        'read_active_map',
        'read_slot_content',
        'submit_map_node_review',
        'submit_map_relation_review',
        'submit_slot_review',
        'submit_relation_review',
        'submit_map_whole_finding',
        'submit_whole_tree_finding',
        'submit_finding_verification',
        'complete_review_assignment',
      ],
    },
    dispatch: { allowedActions: [], targets: {} },
    ...overrides,
  };
}

/** The generic Submitter: a BasicTurnContractV2 that accepts only SystemArtifactDelivery. */
function submitterV2(overrides: Partial<BasicTurnContractV2> = {}): TurnContract {
  return {
    version: 2,
    dispatch: { allowedActions: ['submit_final_artifact'], targets: {} },
    ...overrides,
  };
}

const LIFECYCLE: AuthoritativeReviewLifecycleV1 = {
  protocol: 'authoritative_review_v1',
  roleBindings: { orchestrator: 'structure', generator: 'fill', reviewer: 'review', submitter: 'submitter' },
  systemArtifactProducer: 'system:structured_seal',
};

const SYSTEM_PRODUCER = { kind: 'system' as const, systemId: 'structured_seal' as const };

function agent(id: string, turnContract: TurnContract): FrozenAgentConfig {
  return {
    id,
    name: `${id} Agent`,
    description: `${id} test agent`,
    systemPrompt: `You are the ${id} agent.`,
    model: 'configured/test-model',
    skills: [],
    gate: null,
    slotCapabilities: [],
    turnContract,
  };
}

interface FrozenOverrides {
  lifecycle?: AuthoritativeReviewLifecycleV1 | null;
  agents?: FrozenAgentConfig[];
  routes?: FrozenTemplate['routes'];
  artifactSchema?: FrozenTemplate['artifactSchema'];
  submitters?: string[];
  contract?: FrozenStructuredSlotContractV2;
}

async function frozen(overrides: FrozenOverrides = {}): Promise<FrozenTemplate> {
  const contract = overrides.contract ?? (await compileStructuredSlotContractV2(FIXTURE_ROOT));
  return {
    id: 'authoritative-valid',
    name: 'Authoritative Output Template',
    description: 'neutral fixture',
    versionHash: '0'.repeat(64),
    inputFields: [],
    agents: overrides.agents ?? [
      agent('structure', structureV4()),
      agent('fill', fillV4()),
      agent('review', reviewV4()),
      agent('submitter', submitterV2()),
    ],
    routes: overrides.routes ?? [],
    artifactSchema:
      overrides.artifactSchema ?? {
        files: [{ name: 'chapter.md', required: true, producer: SYSTEM_PRODUCER, extract: 'content', phase: 'create' }],
      },
    finalOutput: {
      name: 'output',
      format: 'markdown',
      submitters: overrides.submitters ?? ['submitter'],
    },
    budget: null,
    productionMode: 'structured_slots',
    structuredSlots: contract,
    structuredPhases: null,
    structuredReviewLifecycle: overrides.lifecycle ?? LIFECYCLE,
    authoritativeReviewProfile: null,
    sourcePath: FIXTURE_ROOT,
  };
}

function expectInvalid(promise: Promise<unknown>, messagePart: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    code: 'TEMPLATE_INVALID',
    message: expect.stringContaining(messagePart),
  });
}

describe('authoritative pipeline role bindings (spec §6.3)', () => {
  it('accepts the canonical four-role binding with an independent reviewer', async () => {
    await expect(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen())),
    ).resolves.toBeUndefined();
  });

  it('rejects reviewer identity overlap with the orchestrator', async () => {
    const lifecycle: AuthoritativeReviewLifecycleV1 = {
      ...LIFECYCLE,
      roleBindings: { ...LIFECYCLE.roleBindings, reviewer: 'structure' },
    };
    await expectInvalid(Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ lifecycle }))), 'reviewer');
  });

  it('rejects reviewer identity overlap with the generator', async () => {
    const lifecycle: AuthoritativeReviewLifecycleV1 = {
      ...LIFECYCLE,
      roleBindings: { ...LIFECYCLE.roleBindings, reviewer: 'fill' },
    };
    await expectInvalid(Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ lifecycle }))), 'reviewer');
  });

  it('rejects two roles bound to the same agent (multiple bindings to one identity)', async () => {
    const lifecycle: AuthoritativeReviewLifecycleV1 = {
      ...LIFECYCLE,
      roleBindings: { ...LIFECYCLE.roleBindings, orchestrator: 'fill' },
    };
    await expectInvalid(Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ lifecycle }))), '恰好一个绑定');
  });

  it('rejects a declared agent that is not bound to any role (absent binding)', async () => {
    const agents = [
      agent('structure', structureV4()),
      agent('fill', fillV4()),
      agent('review', reviewV4()),
      agent('submitter', submitterV2()),
      agent('ghost', fillV4()),
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'ghost',
    );
  });

  it('rejects an agent bound to a role that is not declared in pipeline.agents', async () => {
    const lifecycle: AuthoritativeReviewLifecycleV1 = {
      ...LIFECYCLE,
      roleBindings: { ...LIFECYCLE.roleBindings, reviewer: 'ghost' },
    };
    await expectInvalid(Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ lifecycle }))), 'ghost');
  });

  it('rejects a reviewer that can write Map or content (reviewer independence)', async () => {
    const review = reviewV4({
      authoritativeReview: {
        allowedSessionKinds: ['review_map_batch', 'structure_chunk'],
        accessProfiles: { review_map_batch: 'reviewer', structure_chunk: 'builder' },
        capabilities: [
          'read_map_candidate',
          'submit_map_node_review',
          'submit_map_relation_review',
          'submit_finding_verification',
          'complete_review_assignment',
          'read_structure_contract',
          'read_map_build_frontier',
          'append_map_candidate_chunk',
          'finish_map_build',
        ],
      },
    });
    const agents = [agent('structure', structureV4()), agent('fill', fillV4()), agent('review', review), agent('submitter', submitterV2())];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'write',
    );
  });

  it('rejects the system producer identity as an Agent', async () => {
    const agents = [
      agent('structure', structureV4()),
      agent('fill', fillV4()),
      agent('review', reviewV4()),
      agent('submitter', submitterV2()),
      { ...agent('system:structured_seal', submitterV2()), id: 'system:structured_seal' },
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'system:structured_seal',
    );
  });

  it('rejects the system producer identity as a Route endpoint', async () => {
    const routes: FrozenTemplate['routes'] = [
      { from: 'structure', to: 'system:structured_seal', kind: 'message', label: 'smuggle' },
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ routes }))),
      'system:structured_seal',
    );
  });
});

describe('authoritative v2 Agents and turn contracts (spec §6.3/§6.4)', () => {
  it('rejects a v2 seal Agent (v3 contract carrying request_seal)', async () => {
    const seal: TurnContract = {
      version: 3,
      slotSession: {
        kind: 'seal',
        accessProfile: 'editor',
        capabilities: ['request_seal'],
        completion: 'seal_candidate_created',
        failureDispatch: { when: 'seal_gate_failed', action: 'send_message' },
      },
      dispatch: { allowedActions: ['send_message', 'publish_artifact'], targets: {} },
    };
    const agents = [agent('structure', structureV4()), agent('fill', fillV4()), agent('review', reviewV4()), agent('seal', seal)];
    const lifecycle: AuthoritativeReviewLifecycleV1 = {
      ...LIFECYCLE,
      roleBindings: { ...LIFECYCLE.roleBindings, submitter: 'seal' },
    };
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents, lifecycle }))),
      '版本',
    );
  });

  it('rejects any Agent exposing request_seal through slotCapabilities', async () => {
    const agents = [
      agent('structure', structureV4()),
      agent('fill', fillV4()),
      agent('review', reviewV4()),
      { ...agent('submitter', submitterV2()), slotCapabilities: ['request_seal'] as SlotCapabilityV1[] },
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'request_seal',
    );
  });

  it('rejects a structured role whose allowedSessionKinds miss the role session floor', async () => {
    const structure = structureV4({
      authoritativeReview: {
        allowedSessionKinds: ['map_repair'],
        accessProfiles: { map_repair: 'builder' },
        capabilities: ['read_active_map', 'read_slot_content', 'read_map_repair_staging', 'write_map_patch', 'submit_map_patch', 'request_scope_expansion'],
      },
    });
    const agents = [agent('structure', structure), agent('fill', fillV4()), agent('review', reviewV4()), agent('submitter', submitterV2())];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'structure_chunk',
    );
  });

  it('rejects a session kind lacking its required capability floor', async () => {
    const review = reviewV4({
      authoritativeReview: {
        allowedSessionKinds: ['review_map_batch', 'review_map_whole', 'review_content_batch', 'review_content_whole'],
        accessProfiles: {
          review_map_batch: 'reviewer',
          review_map_whole: 'reviewer',
          review_content_batch: 'reviewer',
          review_content_whole: 'reviewer',
        },
        capabilities: ['read_map_candidate', 'submit_map_node_review', 'submit_map_relation_review'],
      },
    });
    const agents = [agent('structure', structureV4()), agent('fill', fillV4()), agent('review', review), agent('submitter', submitterV2())];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'submit_finding_verification',
    );
  });

  it('rejects a capability above the bound access-profile ceiling', async () => {
    const structure = structureV4({
      authoritativeReview: {
        allowedSessionKinds: ['structure_chunk', 'map_repair'],
        accessProfiles: { structure_chunk: 'builder', map_repair: 'builder' },
        capabilities: [
          'read_structure_contract',
          'read_map_build_frontier',
          'append_map_candidate_chunk',
          'finish_map_build',
          'read_active_map',
          'read_slot_content',
          'read_map_repair_staging',
          'write_map_patch',
          'submit_map_patch',
          'request_scope_expansion',
          'submit_slot_review',
        ],
      },
    });
    const agents = [agent('structure', structure), agent('fill', fillV4()), agent('review', reviewV4()), agent('submitter', submitterV2())];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'builder',
    );
  });

  it('rejects an accessProfile reference to an undeclared contract profile', async () => {
    const structure = structureV4({
      authoritativeReview: {
        allowedSessionKinds: ['structure_chunk', 'map_repair'],
        accessProfiles: { structure_chunk: 'ghost-profile', map_repair: 'ghost-profile' },
        capabilities: [
          'read_structure_contract',
          'read_map_build_frontier',
          'append_map_candidate_chunk',
          'finish_map_build',
          'read_active_map',
          'read_slot_content',
          'read_map_repair_staging',
          'write_map_patch',
          'submit_map_patch',
          'request_scope_expansion',
        ],
      },
    });
    const agents = [agent('structure', structure), agent('fill', fillV4()), agent('review', reviewV4()), agent('submitter', submitterV2())];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'ghost-profile',
    );
  });

  it('rejects a session kind that is not covered by the accessProfiles map', async () => {
    const structure = structureV4({
      authoritativeReview: {
        allowedSessionKinds: ['structure_chunk', 'map_repair'],
        accessProfiles: { structure_chunk: 'builder' },
        capabilities: ['read_structure_contract', 'read_map_build_frontier', 'append_map_candidate_chunk', 'finish_map_build'],
      },
    });
    const agents = [agent('structure', structure), agent('fill', fillV4()), agent('review', reviewV4()), agent('submitter', submitterV2())];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'map_repair',
    );
  });

  it('rejects v4 capability members outside the closed SlotCapabilityV2 union', async () => {
    const bad = structureV4({
      authoritativeReview: {
        allowedSessionKinds: ['structure_chunk', 'map_repair'],
        accessProfiles: { structure_chunk: 'builder', map_repair: 'builder' },
        capabilities: [
          'read_structure_contract',
          'read_map_build_frontier',
          'append_map_candidate_chunk',
          'finish_map_build',
          'read_active_map',
          'read_slot_content',
          'read_map_repair_staging',
          'write_map_patch',
          'submit_map_patch',
          'request_scope_expansion',
          'request_seal',
        ] as SlotCapabilityV2[],
      },
    });
    const agents = [agent('structure', bad), agent('fill', fillV4()), agent('review', reviewV4()), agent('submitter', submitterV2())];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'request_seal',
    );
  });

  it('rejects the Submitter bound to a v4 structured contract', async () => {
    const agents = [agent('structure', structureV4()), agent('fill', fillV4()), agent('review', reviewV4()), agent('submitter', reviewV4())];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'submitter',
    );
  });

  it('rejects the Submitter publishing artifacts (not SystemArtifactDelivery-only)', async () => {
    const agents = [
      agent('structure', structureV4()),
      agent('fill', fillV4()),
      agent('review', reviewV4()),
      agent('submitter', submitterV2({ dispatch: { allowedActions: ['send_message', 'submit_final_artifact'], targets: { send_message: ['structure'] } } })),
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'submitter',
    );
  });

  it('rejects the Submitter declaring production or annotate files', async () => {
    const agents = [
      agent('structure', structureV4()),
      agent('fill', fillV4()),
      agent('review', reviewV4()),
      agent(
        'submitter',
        submitterV2({
          production: {
            completionAction: 'finish_production',
            output: { formats: ['markdown'], sources: ['inline'] },
          },
        }),
      ),
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ agents }))),
      'submitter',
    );
  });
});

describe('authoritative routes and artifact schema (spec §6.3)', () => {
  it('rejects any route starting from the reviewer (Agent-controlled completion edge)', async () => {
    const routes: FrozenTemplate['routes'] = [
      { from: 'review', to: 'fill', kind: 'message', label: 'review continues' },
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ routes }))),
      'reviewer',
    );
  });

  it('rejects routes whose target is the reviewer', async () => {
    const routes: FrozenTemplate['routes'] = [
      { from: 'structure', to: 'review', kind: 'message', label: 'to review' },
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ routes }))),
      'reviewer',
    );
  });

  it('rejects routes whose target is the Submitter', async () => {
    const routes: FrozenTemplate['routes'] = [
      { from: 'structure', to: 'submitter', kind: 'message', label: 'to submitter' },
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ routes }))),
      'submitter',
    );
  });

  it('rejects artifact-kind routes (structured roles cannot Route completion to publication)', async () => {
    const routes: FrozenTemplate['routes'] = [
      { from: 'fill', to: 'submitter', kind: 'artifact', label: 'publish' },
    ];
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ routes }))),
      'artifact',
    );
  });

  it('rejects a create producer that is not exactly the system producer', async () => {
    const agentProducer = { kind: 'agent' as const, agentId: 'fill' } as unknown as string | { kind: 'system'; systemId: 'structured_seal' };
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(
          await frozen({
            artifactSchema: {
              files: [{ name: 'chapter.md', required: true, producer: agentProducer, extract: 'content', phase: 'create' }],
            },
          }),
        ),
      ),
      'system',
    );
  });

  it('rejects annotate-phase artifact files in v2 (no Agent annotation surface)', async () => {
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(
          await frozen({
            artifactSchema: {
              files: [
                { name: 'chapter.md', required: true, producer: SYSTEM_PRODUCER, extract: 'content', phase: 'create' },
                { name: 'review.md', required: false, producer: SYSTEM_PRODUCER, extract: 'content', phase: 'annotate' },
              ],
            },
          }),
        ),
      ),
      'annotate',
    );
  });

  it('rejects finalOutput submitters that differ from the submitter binding', async () => {
    await expectInvalid(
      Promise.resolve().then(async () => validateAuthoritativeReviewPipeline(await frozen({ submitters: ['fill'] }))),
      'submitter',
    );
  });
});

describe('authoritative session kind matrix (design §9)', () => {
  it('freezes write session kinds and role floors', async () => {
    const v = await import('./authoritative-review-pipeline-validator');
    expect(v.V2_WRITE_SESSION_KINDS).toEqual(['structure_chunk', 'generation_batch', 'map_repair', 'content_repair']);
    expect(v.V2_ROLE_REQUIRED_SESSION_KINDS.orchestrator).toEqual(['structure_chunk', 'map_repair']);
    expect(v.V2_ROLE_REQUIRED_SESSION_KINDS.generator).toEqual(['generation_batch', 'content_repair']);
    expect(v.V2_ROLE_REQUIRED_SESSION_KINDS.reviewer).toEqual([
      'review_map_batch',
      'review_map_whole',
      'review_content_batch',
      'review_content_whole',
    ]);
  });

  it('covers exactly the eight closed session kinds across role floors', async () => {
    const v = await import('./authoritative-review-pipeline-validator');
    const covered = new Set<StructuredSessionKindV2>();
    for (const kinds of Object.values(v.V2_ROLE_REQUIRED_SESSION_KINDS)) {
      for (const kind of kinds) covered.add(kind);
    }
    expect([...covered].sort()).toEqual(
      [
        'structure_chunk',
        'review_map_batch',
        'review_map_whole',
        'generation_batch',
        'review_content_batch',
        'review_content_whole',
        'map_repair',
        'content_repair',
      ].sort(),
    );
  });

  it('requires the full per-kind capability floor for every session kind', async () => {
    const v = await import('./authoritative-review-pipeline-validator');
    for (const [kind, required] of Object.entries(v.V2_REQUIRED_CAPABILITIES_BY_SESSION) as Array<
      [StructuredSessionKindV2, readonly SlotCapabilityV2[]]
    >) {
      expect(required.length).toBeGreaterThan(0);
      for (const capability of required) {
        expect(capability).toMatch(/^[a-z_]+$/);
        expect(v.SLOT_CAPABILITIES_V2).toContain(capability);
      }
      expect(new Set(required).size).toBe(required.length);
    }
  });
});