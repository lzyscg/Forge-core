// @vitest-environment node
/**
 * Structured pipeline validator tests (Task 5 Steps 1-3, red first).
 *
 * Step 1 (capability matrix): structure without read/write/submit, fill
 * without read-spec/read-content/write/submit, or seal without request-seal
 * fails; capabilities outside the kind allowlist and above the Agent
 * slotCapabilities ceiling fail.
 *
 * Step 2 (dispatch matrix): structure/fill cannot publish; seal must declare
 * send_message plus publish/final; rework send targets only v3 fill/structure;
 * v2 post-Seal nodes cannot declare production or send back to v3.
 *
 * Step 3 (typestate graph): fill/seal as first node, a route that bypasses
 * structure, an invalid join, v2 before Seal, Seal rework staying
 * active_unsealed and sealed back-edges.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StructuredSlotLimitsV1 } from '../../shared/structured-slots';
import {
  loadStructuredSlotContract,
  type FrozenStructuredSlotContractV1,
} from './structured-slot-contract';
import { validateStructuredPipeline } from './structured-pipeline-validator';
import type {
  FrozenAgentConfig,
  FrozenTemplate,
  StructuredTurnContractV3,
  TurnContract,
} from './template-schema';

const FIXTURE_ROOT = fileURLToPath(new URL('__fixtures__/structured-valid', import.meta.url));

/** Design §25.13 candidate profile — the platform hard ceiling for tests. */
const CANDIDATE_PROFILE: StructuredSlotLimitsV1 = {
  schema: { maxSchemaDepth: 16, maxSchemaNodes: 4096, maxEnumItems: 256, maxPatternLength: 512 },
  structure: { maxSlots: 10_000, maxTreeDepth: 32, maxChildrenPerSlot: 1_000 },
  payload: { maxSpecBytesPerSlot: 65_536, maxContentBytesPerSlot: 1_048_576, maxScaffoldPayloadBytes: 67_108_864 },
  draft: { maxChangedSlots: 2_000, maxDraftBytes: 16_777_216 },
  attempt: {
    maxSlotToolCallsPerAttempt: 512,
    maxValidationRunsPerAttempt: 16,
    maxValidatorInvocationsPerAttempt: 40_000,
    maxAggregateValidatorCpuMsPerAttempt: 240_000,
    maxAggregateValidatorWallClockMsPerAttempt: 480_000,
    maxValidatorOutputBytesPerAttempt: 16_777_216,
    maxAttemptWallClockMs: 600_000,
  },
  validation: {
    maxValidators: 64,
    maxValidatorInvocationsPerGate: 10_000,
    maxAggregateValidatorCpuMsPerGate: 60_000,
    maxAggregateValidatorWallClockMsPerGate: 120_000,
    maxValidatorOutputBytesPerGate: 4_194_304,
    maxIssuesPerRun: 500,
  },
  output: { maxArtifactFiles: 64, maxArtifactBytesPerFile: 16_777_216, maxTotalArtifactBytes: 67_108_864 },
};

/** A valid v3 structure contract for the fixture's first agent. */
function structureContract(overrides: Partial<StructuredTurnContractV3> = {}): StructuredTurnContractV3 {
  return {
    version: 3,
    slotSession: {
      kind: 'structure',
      accessProfile: null,
      capabilities: [
        'read_structure_contract',
        'write_structure_proposal',
        'submit_structure_proposal',
      ],
      completion: 'structure_commit_candidate_created',
    },
    dispatch: {
      allowedActions: ['send_message'],
      targets: { send_message: ['fill'] },
    },
    ...overrides,
  };
}

/** A valid v3 fill contract for the fixture's second agent. */
function fillContract(overrides: Partial<StructuredTurnContractV3> = {}): StructuredTurnContractV3 {
  return {
    version: 3,
    slotSession: {
      kind: 'fill',
      accessProfile: 'editor',
      capabilities: ['read_slot_spec', 'read_slot_content', 'write_draft_content', 'submit_draft'],
      completion: 'merge_candidate_created',
    },
    dispatch: {
      allowedActions: ['send_message'],
      targets: { send_message: ['seal'] },
    },
    ...overrides,
  };
}

/** A valid v3 seal contract for the fixture's third agent. */
function sealContract(overrides: Partial<StructuredTurnContractV3> = {}): StructuredTurnContractV3 {
  return {
    version: 3,
    slotSession: {
      kind: 'seal',
      accessProfile: 'editor',
      capabilities: ['request_seal'],
      completion: 'seal_candidate_created',
      failureDispatch: { when: 'seal_gate_failed', action: 'send_message' },
    },
    dispatch: {
      allowedActions: ['send_message', 'publish_artifact'],
      targets: { send_message: ['fill'], publish_artifact: ['submitter'] },
    },
    ...overrides,
  };
}

/** The v2 post-Seal submitter contract for the fixture's fourth agent. */
function submitterContract(): TurnContract {
  return {
    version: 2,
    annotate: { files: ['document.md'] },
    dispatch: {
      allowedActions: ['submit_final_artifact'],
      targets: {},
    },
  };
}

function agent(
  id: string,
  name: string,
  contract: TurnContract,
  slotCapabilities: string[],
): FrozenAgentConfig {
  return {
    id,
    name,
    description: `Neutral agent ${id}.`,
    systemPrompt: `You are ${id}, a neutral platform test agent.`,
    model: 'configured/test-model',
    skills: [],
    gate: null,
    slotCapabilities: slotCapabilities as FrozenAgentConfig['slotCapabilities'],
    turnContract: contract,
  };
}

let contractCache: FrozenStructuredSlotContractV1 | null = null;

async function structuredContract(): Promise<FrozenStructuredSlotContractV1> {
  contractCache ??= await loadStructuredSlotContract(FIXTURE_ROOT, CANDIDATE_PROFILE);
  return contractCache;
}

/** Builds the valid structured frozen fixture from scratch. */
async function validFrozen(overrides: {
  agents?: FrozenAgentConfig[];
  routes?: FrozenTemplate['routes'];
} = {}): Promise<FrozenTemplate> {
  const contract = await structuredContract();
  return {
    id: 'structured-fixture',
    name: 'Structured Fixture',
    description: 'Neutral structured pipeline for validator tests.',
    versionHash: 'a'.repeat(64),
    productionMode: 'structured_slots',
    structuredSlots: contract,
    structuredPhases: null,
    budget: null,
    inputFields: [],
    agents: overrides.agents ?? [
      agent('structure', 'Structure Agent', structureContract(), [
        'read_structure_contract',
        'write_structure_proposal',
        'submit_structure_proposal',
      ]),
      agent('fill', 'Fill Agent', fillContract(), [
        'read_slot_spec',
        'read_slot_content',
        'write_draft_content',
        'submit_draft',
      ]),
      agent('seal', 'Seal Agent', sealContract(), ['request_seal']),
      agent('submitter', 'Submitter Agent', submitterContract(), []),
    ],
    routes: overrides.routes ?? [
      { from: 'structure', to: 'fill', kind: 'message', label: 'propose structure' },
      { from: 'fill', to: 'seal', kind: 'message', label: 'submit draft' },
      { from: 'seal', to: 'submitter', kind: 'artifact', label: 'publish output' },
      { from: 'seal', to: 'fill', kind: 'message', label: 'seal rework' },
    ],
    artifactSchema: {
      files: [
        { name: 'document.md', required: true, producer: 'seal', extract: 'content', phase: 'create' },
      ],
    },
    finalOutput: { name: 'output', format: 'markdown', submitters: ['submitter'] },
    sourcePath: 'fixture:structured',
  };
}

/** Replaces one agent by id; returns a new frozen. */
function withAgent(frozen: FrozenTemplate, agentId: string, next: FrozenAgentConfig): FrozenTemplate {
  return {
    ...frozen,
    agents: frozen.agents.map((candidate) => (candidate.id === agentId ? next : candidate)),
  };
}

/** Replaces the routes list. */
function withRoutes(frozen: FrozenTemplate, routes: FrozenTemplate['routes']): FrozenTemplate {
  return { ...frozen, routes };
}

describe('validateStructuredPipeline — Step 1 capability matrix', () => {
  it('accepts the valid structured fixture and returns the compiled phase contract', async () => {
    const frozen = await validFrozen();
    const phases = validateStructuredPipeline(frozen);
    expect([...phases.keys()].sort()).toEqual(['fill', 'seal', 'structure', 'submitter']);
    expect([...phases.get('structure') ?? []]).toEqual(['no_scaffold']);
    expect([...phases.get('fill') ?? []]).toEqual(['active_unsealed']);
    expect([...phases.get('seal') ?? []]).toEqual(['active_unsealed']);
    expect([...phases.get('submitter') ?? []]).toEqual(['sealed']);
  });

  it('rejects a structure agent without the complete read/write/submit set', async () => {
    const frozen = await validFrozen();
    const missing = (contract: StructuredTurnContractV3, capability: string): StructuredTurnContractV3 => ({
      ...contract,
      slotSession: {
        ...contract.slotSession,
        capabilities: contract.slotSession.capabilities.filter((c) => c !== capability),
      },
    });
    for (const capability of [
      'read_structure_contract',
      'write_structure_proposal',
      'submit_structure_proposal',
    ]) {
      const broken = withAgent(
        frozen,
        'structure',
        agent('structure', 'Structure Agent', missing(structureContract(), capability), [
          'read_structure_contract',
          'write_structure_proposal',
          'submit_structure_proposal',
        ]),
      );
      expect(() => validateStructuredPipeline(broken)).toThrow(new RegExp(capability));
    }
  });

  it('rejects a fill agent missing any of read-spec/read-content/write/submit', async () => {
    const frozen = await validFrozen();
    for (const capability of [
      'read_slot_spec',
      'read_slot_content',
      'write_draft_content',
      'submit_draft',
    ]) {
      const session = fillContract().slotSession;
      const broken = withAgent(
        frozen,
        'fill',
        agent(
          'fill',
          'Fill Agent',
          {
            ...fillContract(),
            slotSession: {
              ...session,
              capabilities: session.capabilities.filter((c) => c !== capability),
            },
          },
          ['read_slot_spec', 'read_slot_content', 'write_draft_content', 'submit_draft'],
        ),
      );
      expect(() => validateStructuredPipeline(broken)).toThrow(new RegExp(capability));
    }
  });

  it('rejects a seal agent without request_seal', async () => {
    const frozen = await validFrozen();
    const broken = withAgent(
      frozen,
      'seal',
      agent(
        'seal',
        'Seal Agent',
        { ...sealContract(), slotSession: { ...sealContract().slotSession, capabilities: [] } },
        ['request_seal'],
      ),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/request_seal/);
  });

  it('rejects a capability outside the kind allowlist', async () => {
    const frozen = await validFrozen();
    // structure declares request_seal, which belongs to the seal allowlist only.
    const session = structureContract().slotSession;
    const broken = withAgent(
      frozen,
      'structure',
      agent(
        'structure',
        'Structure Agent',
        {
          ...structureContract(),
          slotSession: { ...session, capabilities: [...session.capabilities, 'request_seal'] },
        },
        ['read_structure_contract', 'write_structure_proposal', 'submit_structure_proposal', 'request_seal'],
      ),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/request_seal/);
  });

  it('rejects a session capability above the Agent slotCapabilities ceiling', async () => {
    const frozen = await validFrozen();
    const session = fillContract().slotSession;
    const broken = withAgent(
      frozen,
      'fill',
      agent(
        'fill',
        'Fill Agent',
        { ...fillContract(), slotSession: { ...session, capabilities: [...session.capabilities] } },
        // The ceiling omits submit_draft, so the session capability exceeds it.
        ['read_slot_spec', 'read_slot_content', 'write_draft_content'],
      ),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/slotCapabilities/);
  });
});

describe('validateStructuredPipeline — Step 2 dispatch matrix', () => {
  it('rejects a structure agent that declares publish_artifact', async () => {
    const frozen = await validFrozen();
    const broken = withAgent(
      frozen,
      'structure',
      agent(
        'structure',
        'Structure Agent',
        {
          ...structureContract(),
          dispatch: { allowedActions: ['publish_artifact'], targets: {} },
        },
        ['read_structure_contract', 'write_structure_proposal', 'submit_structure_proposal'],
      ),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/send_message/);
  });

  it('rejects a fill agent that declares publish_artifact', async () => {
    const frozen = await validFrozen();
    const broken = withAgent(
      frozen,
      'fill',
      agent(
        'fill',
        'Fill Agent',
        { ...fillContract(), dispatch: { allowedActions: ['publish_artifact'], targets: {} } },
        ['read_slot_spec', 'read_slot_content', 'write_draft_content', 'submit_draft'],
      ),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/send_message/);
  });

  it('rejects a seal agent without send_message', async () => {
    const frozen = await validFrozen();
    const broken = withAgent(
      frozen,
      'seal',
      agent(
        'seal',
        'Seal Agent',
        { ...sealContract(), dispatch: { allowedActions: ['publish_artifact'], targets: { publish_artifact: ['submitter'] } } },
        ['request_seal'],
      ),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/seal/);
  });

  it('rejects a seal agent without a success action (publish/final)', async () => {
    const frozen = await validFrozen();
    const broken = withAgent(
      frozen,
      'seal',
      agent(
        'seal',
        'Seal Agent',
        { ...sealContract(), dispatch: { allowedActions: ['send_message'], targets: { send_message: ['fill'] } } },
        ['request_seal'],
      ),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/seal/);
  });

  it('rejects a seal rework send target that is not v3 fill/structure', async () => {
    const frozen = await validFrozen();
    // The rework send_message target points at the v2 submitter.
    const broken = withAgent(
      frozen,
      'seal',
      agent(
        'seal',
        'Seal Agent',
        {
          ...sealContract(),
          dispatch: { allowedActions: ['send_message', 'publish_artifact'], targets: { send_message: ['submitter'], publish_artifact: ['submitter'] } },
        },
        ['request_seal'],
      ),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/rework|send/);
  });

  it('rejects a v2 post-Seal agent that declares production', async () => {
    const frozen = await validFrozen();
    const productionSubmitter: TurnContract = {
      version: 2,
      production: {
        files: ['document.md'],
        output: { formats: ['markdown'], sources: ['inline'] },
      },
      dispatch: { allowedActions: ['submit_final_artifact'], targets: {} },
    };
    const broken = withAgent(
      frozen,
      'submitter',
      agent('submitter', 'Submitter Agent', productionSubmitter, []),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/v2|production/);
  });

  it('rejects a v2 post-Seal agent that sends a message back to v3', async () => {
    const frozen = await validFrozen();
    const sendingSubmitter: TurnContract = {
      version: 2,
      dispatch: {
        allowedActions: ['send_message', 'submit_final_artifact'],
        targets: { send_message: ['fill'] },
      },
    };
    const broken = withAgent(
      frozen,
      'submitter',
      agent('submitter', 'Submitter Agent', sendingSubmitter, []),
    );
    expect(() => validateStructuredPipeline(broken)).toThrow(/v2|send/);
  });
});

describe('validateStructuredPipeline — Step 3 typestate graph', () => {
  it('rejects fill as the first node', async () => {
    const frozen = await validFrozen();
    const reordered = [...frozen.agents];
    const fillAgent = reordered.splice(1, 1)[0];
    expect(fillAgent).toBeDefined();
    reordered.unshift(fillAgent!);
    expect(() => validateStructuredPipeline({ ...frozen, agents: reordered })).toThrow(/structure/);
  });

  it('rejects seal as the first node', async () => {
    const frozen = await validFrozen();
    const reordered = [...frozen.agents];
    const sealAgent = reordered.splice(2, 1)[0];
    expect(sealAgent).toBeDefined();
    reordered.unshift(sealAgent!);
    expect(() => validateStructuredPipeline({ ...frozen, agents: reordered })).toThrow(/structure/);
  });

  it('rejects a route that reaches a v3 node while bypassing structure dominance', async () => {
    const frozen = await validFrozen();
    // submitter (v2, sealed) routes straight to fill: the fill is reached with
    // a sealed input phase, bypassing structure's active_unsealed dominance.
    const routes = [...frozen.routes, { from: 'submitter', to: 'fill', kind: 'message', label: 'illegal back edge' } as const];
    expect(() => validateStructuredPipeline(withRoutes(frozen, routes))).toThrow();
  });

  it('rejects an invalid join where one incoming edge violates the precondition', async () => {
    const frozen = await validFrozen();
    // fill gains a second incoming edge from submitter (sealed), which cannot
    // satisfy the active_unsealed precondition of a fill node.
    const routes = [...frozen.routes, { from: 'submitter', to: 'fill', kind: 'message', label: 'illegal join' } as const];
    expect(() => validateStructuredPipeline(withRoutes(frozen, routes))).toThrow();
  });

  it('rejects a v2 node reached before Seal', async () => {
    const frozen = await validFrozen();
    // structure routes directly to the v2 submitter: active_unsealed cannot
    // satisfy the sealed precondition of the post-Seal v2 node.
    const routes = [...frozen.routes, { from: 'structure', to: 'submitter', kind: 'message', label: 'v2 before seal' } as const];
    expect(() => validateStructuredPipeline(withRoutes(frozen, routes))).toThrow();
  });

  it('keeps the seal rework edge at active_unsealed', async () => {
    const frozen = await validFrozen();
    const phases = validateStructuredPipeline(frozen);
    // The seal -> fill rework edge must not promote fill to sealed.
    expect([...phases.get('fill') ?? []]).toEqual(['active_unsealed']);
  });

  it('rejects a sealed back-edge into a v3 node', async () => {
    const frozen = await validFrozen();
    const routes = [...frozen.routes, { from: 'submitter', to: 'structure', kind: 'message', label: 'sealed back edge' } as const];
    expect(() => validateStructuredPipeline(withRoutes(frozen, routes))).toThrow();
  });

  it('rejects a non-structured template', async () => {
    const frozen = await validFrozen();
    const basic = { ...frozen, productionMode: 'basic' as const, structuredSlots: null };
    expect(() => validateStructuredPipeline(basic)).toThrow();
  });
});
