// @vitest-environment node
/**
 * Structured Slot contract v2 compiler tests (Task 4).
 *
 * The v2 compiler is a PURE, STANDALONE Contract v2 compiler: exact
 * version-dispatch (`peekStructuredSlotContractVersion`), the exact §6.1
 * top-level shape (unknown and cross-version fields fail closed), slot types /
 * layout grammar (reusing the v1 tree compilers), static capability-ceiling
 * access profiles (closed SlotCapabilityV2 union), relation types with the
 * optional/disabled relationship policy, the normalized ReviewPolicyV2, strict
 * ValidatorRegistrationV2 (7 triggers, content-only execution phases, no
 * advisory seal_output), the single forge-assembler/v2 registration, closed
 * limits, and the canonical contract bytes / semantic digest /
 * implementation-identity closure. No loader, no FrozenTemplate, no
 * pipeline.yaml — the compiler is called directly.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { canonicalJsonBytes, canonicalJsonSha256 } from '../structured-slots/canonical-json';
import {
  compileStructuredSlotContractV2,
  peekStructuredSlotContractVersion,
  type FrozenStructuredSlotContractV2,
  type ImplementationIdentityClosureEntryV2,
} from './structured-slot-contract-v2';

const VALID_FIXTURE = fileURLToPath(new URL('__fixtures__/authoritative-valid', import.meta.url));
const INVALID_CROSS_VERSION = fileURLToPath(
  new URL('__fixtures__/authoritative-invalid-cross-version', import.meta.url),
);
const INVALID_ADVISORY_SEAL_OUTPUT = fileURLToPath(
  new URL('__fixtures__/authoritative-invalid-advisory-seal-output', import.meta.url),
);
const INVALID_BAD_PHASE = fileURLToPath(
  new URL('__fixtures__/authoritative-invalid-bad-phase', import.meta.url),
);

function compileAt(root: string): Promise<FrozenStructuredSlotContractV2> {
  return compileStructuredSlotContractV2(root);
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Compile a fresh copy of the valid fixture in a temp root. */
async function withTempFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'structured-slot-v2-fixture-'));
  const { cp } = await import('node:fs/promises');
  await cp(VALID_FIXTURE, root, { recursive: true });
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Compile a mutated YAML round-trip of the valid fixture. */
async function withVariant<T>(
  mutate: (doc: Record<string, unknown>) => void,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  return withTempFixture(async (root) => {
    const doc = parseYaml(await readFile(join(root, 'slots', 'contract.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    mutate(doc);
    await writeFile(join(root, 'slots', 'contract.yaml'), stringifyYaml(doc), 'utf8');
    return fn(root);
  });
}

/** Assert the mutated contract fails to compile with the given stable code. */
async function expectInvalid(mutate: (doc: Record<string, unknown>) => void, code: string): Promise<void> {
  await withVariant(mutate, async (root) => {
    await expect(compileAt(root)).rejects.toThrow(code);
  });
}

/** Rebuild plain JSON with every object's keys in reverse insertion order (values untouched). */
function reverseKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => reverseKeyOrder(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      out[key] = reverseKeyOrder((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

/** The exact normalized Contract v2 the compiler must freeze (digest pin for Task 5). */
const EXPECTED_CANONICAL_CONTRACT: Record<string, unknown> = {
  version: 2,
  slotTypes: [
    {
      id: 'document',
      name: 'Document',
      description: 'Root container slot whose children follow the layout grammar.',
      specSchema: { type: 'object', additionalProperties: false },
      content: { presence: 'forbidden' },
    },
    {
      id: 'title',
      name: 'Title',
      description: 'Leaf slot holding a short required title string.',
      specSchema: { type: 'object', additionalProperties: false },
      content: {
        presence: 'required',
        schema: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    {
      id: 'body',
      name: 'Body',
      description: 'Leaf slot holding a required length-bounded body string.',
      specSchema: { type: 'object', additionalProperties: false },
      content: {
        presence: 'required',
        schema: { type: 'string', minLength: 1, maxLength: 10000 },
      },
    },
  ],
  layoutGrammar: {
    rootType: 'document',
    productions: {
      document: {
        children: {
          kind: 'sequence',
          items: [
            { kind: 'slot', type: 'title' },
            { kind: 'repeat', min: 0, max: 64, item: { kind: 'slot', type: 'body' } },
          ],
        },
      },
      title: { children: { kind: 'empty' } },
      body: { children: { kind: 'empty' } },
    },
  },
  accessProfiles: [
    {
      id: 'builder',
      capabilities: [
        'read_structure_contract',
        'read_map_build_frontier',
        'append_map_candidate_chunk',
        'finish_map_build',
        'read_active_map',
        'read_slot_content',
        'read_related_context',
        'write_slot_content',
        'submit_content_draft',
        'read_map_repair_staging',
        'submit_map_patch',
        'write_map_patch',
        'request_scope_expansion',
      ],
    },
    {
      id: 'reviewer',
      capabilities: [
        'read_map_candidate',
        'read_active_map',
        'read_slot_content',
        'read_relation_context',
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
  ],
  relationTypes: [
    {
      id: 'sequence',
      direction: 'directed',
      fromSlotTypes: ['body'],
      toSlotTypes: ['body'],
      attributesSchema: {},
      semanticCriterion:
        'A later event must follow naturally from the earlier event in document order.',
      enforcement: 'blocking',
      invalidation: { direction: 'downstream', maxHops: 2 },
    },
    {
      id: 'causal',
      direction: 'directed',
      fromSlotTypes: ['body'],
      toSlotTypes: ['body'],
      attributesSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          explanation: { type: 'string', minLength: 1, maxLength: 2000 },
        },
        required: ['explanation'],
      },
      semanticCriterion: 'A later event must be sufficiently explained by the earlier event.',
      enforcement: 'advisory',
      invalidation: { direction: 'downstream', maxHops: 3 },
    },
  ],
  relationshipPolicy: { mode: 'optional' },
  reviewPolicy: {
    mapReview: 'required',
    contentSelector: 'content_bearing',
    mapBatchTargetSlots: 24,
    contentBatchTargetSlots: 24,
    assignmentSoftLimit: 64,
    wholeMapObservation: 'required',
    wholeContentTreeObservation: 'required',
    reviewAdvisoryRelations: true,
    maxRounds: 8,
  },
  validators: [
    {
      validatorId: 'structure-root-order',
      handlerKey: 'authoritative.review.completeness',
      implementationDigest: 'a'.repeat(64),
      implementationRef: {
        kind: 'builtin',
        moduleId: '@forge/authoritative-review',
        exportName: 'completeness',
      },
      trigger: 'map_candidate_commit',
      executionPhase: null,
      selector: { kind: 'all' },
      enforcement: 'blocking',
      deterministic: true,
      inputContractVersion: 2,
      outputContractVersion: 2,
      budgetProfileId: 'authoritative-validator-default',
    },
    {
      validatorId: 'content-batch-schema',
      handlerKey: 'authoritative.review.slotSchema',
      implementationDigest: 'b'.repeat(64),
      implementationRef: {
        kind: 'builtin',
        moduleId: '@forge/authoritative-review',
        exportName: 'slotSchema',
      },
      trigger: 'content_commit',
      executionPhase: 'batch_commit',
      selector: { kind: 'types', typeIds: ['title', 'body'] },
      enforcement: 'blocking',
      deterministic: true,
      inputContractVersion: 2,
      outputContractVersion: 2,
      budgetProfileId: 'authoritative-validator-default',
    },
    {
      validatorId: 'content-finalize-coverage',
      handlerKey: 'authoritative.review.coverage',
      implementationDigest: 'c'.repeat(64),
      implementationRef: {
        kind: 'builtin',
        moduleId: '@forge/authoritative-review',
        exportName: 'coverage',
      },
      trigger: 'content_commit',
      executionPhase: 'plan_finalize',
      selector: { kind: 'all' },
      enforcement: 'advisory',
      deterministic: true,
      inputContractVersion: 2,
      outputContractVersion: 2,
      budgetProfileId: 'authoritative-validator-default',
    },
  ],
  assembler: {
    abi: 'forge-assembler/v2',
    handlerKey: 'authoritative.seal.render',
    implementationDigest: 'd'.repeat(64),
    implementationRef: {
      kind: 'builtin',
      moduleId: '@forge/authoritative-review',
      exportName: 'renderSeal',
    },
    budget: { timeoutMs: 30000, maxInputBytes: 67108864, maxOutputBytes: 33554432 },
    routes: [
      { id: 'chapter', artifactFile: 'chapter.md', mediaType: 'text/markdown' },
      { id: 'chapter-json', artifactFile: 'chapter.json', mediaType: 'application/json' },
    ],
  },
  limits: {
    schema: { maxSchemaDepth: 4, maxSchemaNodes: 1024, maxEnumItems: 64, maxPatternLength: 128 },
    structure: { maxSlots: 2500, maxTreeDepth: 8, maxChildrenPerSlot: 250 },
    payload: { maxSpecBytesPerSlot: 16384, maxContentBytesPerSlot: 262144, maxScaffoldPayloadBytes: 16777216 },
    draft: { maxChangedSlots: 500, maxDraftBytes: 4194304 },
    attempt: {
      maxSlotToolCallsPerAttempt: 128,
      maxValidationRunsPerAttempt: 4,
      maxValidatorInvocationsPerAttempt: 10000,
      maxAggregateValidatorCpuMsPerAttempt: 60000,
      maxAggregateValidatorWallClockMsPerAttempt: 120000,
      maxValidatorOutputBytesPerAttempt: 4194304,
      maxAttemptWallClockMs: 150000,
    },
    validation: {
      maxValidators: 16,
      maxValidatorInvocationsPerGate: 2500,
      maxAggregateValidatorCpuMsPerGate: 15000,
      maxAggregateValidatorWallClockMsPerGate: 30000,
      maxValidatorOutputBytesPerGate: 1048576,
      maxIssuesPerRun: 125,
    },
    output: { maxArtifactFiles: 16, maxArtifactBytesPerFile: 4194304, maxTotalArtifactBytes: 16777216 },
    relations: {
      maxRelationsPerMap: 2000,
      maxRelationsPerSlot: 32,
      maxRelationImpactHops: 3,
      maxRelationClosureNodes: 256,
    },
    authoritative: {
      maxAssignmentsPerRound: 1000,
      maxPlannedWorkItemsPerRound: 4000,
      maxConsecutiveAttemptsWithoutProgress: 8,
      maxFindingsPerSlot: 16,
      maxFindingsPerRelation: 8,
      maxFindingsPerRound: 1000,
      maxEvidenceBytesPerItem: 4096,
      maxEvidenceBytesTotal: 1048576,
      maxWriteSlotsPerRepairGrant: 64,
      maxScopeExpansionsPerRound: 8,
    },
  },
};

const EXPECTED_IDENTITY_CLOSURE: ImplementationIdentityClosureEntryV2[] = [
  {
    kind: 'assembler',
    handlerKey: 'authoritative.seal.render',
    implementationDigest: 'd'.repeat(64),
    moduleId: '@forge/authoritative-review',
    exportName: 'renderSeal',
  },
  {
    kind: 'validator',
    validatorId: 'content-batch-schema',
    trigger: 'content_commit',
    executionPhase: 'batch_commit',
    handlerKey: 'authoritative.review.slotSchema',
    implementationDigest: 'b'.repeat(64),
    moduleId: '@forge/authoritative-review',
    exportName: 'slotSchema',
  },
  {
    kind: 'validator',
    validatorId: 'content-finalize-coverage',
    trigger: 'content_commit',
    executionPhase: 'plan_finalize',
    handlerKey: 'authoritative.review.coverage',
    implementationDigest: 'c'.repeat(64),
    moduleId: '@forge/authoritative-review',
    exportName: 'coverage',
  },
  {
    kind: 'validator',
    validatorId: 'structure-root-order',
    trigger: 'map_candidate_commit',
    executionPhase: null,
    handlerKey: 'authoritative.review.completeness',
    implementationDigest: 'a'.repeat(64),
    moduleId: '@forge/authoritative-review',
    exportName: 'completeness',
  },
];

describe('peekStructuredSlotContractVersion — strict raw version dispatch', () => {
  it('reads the version field only and returns 1 or 2', () => {
    expect(peekStructuredSlotContractVersion({ version: 1 })).toBe(1);
    expect(peekStructuredSlotContractVersion({ version: 2, relationTypes: [] })).toBe(2);
  });

  it('fails closed on anything that is not exactly version 1 or 2', () => {
    const throwsContractInvalid = (raw: unknown): void => {
      expect(() => peekStructuredSlotContractVersion(raw)).toThrow('SLOTS_CONTRACT_INVALID');
    };
    throwsContractInvalid(null);
    throwsContractInvalid(2);
    throwsContractInvalid([]);
    throwsContractInvalid({});
    throwsContractInvalid({ version: '2' });
    throwsContractInvalid({ version: 3 });
    throwsContractInvalid({ version: 0 });
    throwsContractInvalid({ version: 2.5 });
  });
});

describe('compileStructuredSlotContractV2 — valid fixture (spec §6.1/§6.2/§6.5, design §9)', () => {
  it('compiles the fixture into a fully frozen contract v2', async () => {
    const frozen = await compileAt(VALID_FIXTURE);
    expect(frozen.version).toBe(2);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.accessProfiles)).toBe(true);
    expect(Object.isFrozen(frozen.validators)).toBe(true);
    expect(Object.isFrozen(frozen.limits)).toBe(true);

    expect(frozen.slotTypes.map((s) => s.id)).toEqual(['document', 'title', 'body']);
    expect(frozen.slotTypes[0].content).toEqual({ presence: 'forbidden' });
    if (frozen.slotTypes[1].content.presence === 'required') {
      expect(frozen.slotTypes[1].content.schema.type).toBe('string');
      expect(frozen.slotTypes[1].content.schema.maxLength).toBe(200);
    }
    expect(frozen.layoutGrammar.rootType).toBe('document');
    expect(Object.keys(frozen.layoutGrammar.productions).sort()).toEqual(['body', 'document', 'title']);
  });

  it('freezes static capability-ceiling access profiles from the closed SlotCapabilityV2 union', async () => {
    const frozen = await compileAt(VALID_FIXTURE);
    expect(frozen.accessProfiles.map((p) => p.id)).toEqual(['builder', 'reviewer']);
    expect(frozen.accessProfiles[0].capabilities).toContain('append_map_candidate_chunk');
    expect(frozen.accessProfiles[1].capabilities).toContain('submit_slot_review');
    expect(frozen.accessProfiles.every((p) => p.capabilities.length > 0)).toBe(true);
  });

  it('freezes declared relation types with resolved cross-references', async () => {
    const frozen = await compileAt(VALID_FIXTURE);
    expect(frozen.relationTypes.map((r) => r.id)).toEqual(['sequence', 'causal']);
    expect(frozen.relationTypes[0]).toMatchObject({
      direction: 'directed',
      fromSlotTypes: ['body'],
      toSlotTypes: ['body'],
      enforcement: 'blocking',
      invalidation: { direction: 'downstream', maxHops: 2 },
    });
    expect(frozen.relationTypes[1].attributesSchema.presence).toBe('schema');
    expect(frozen.relationTypes[0].attributesSchema).toEqual({ presence: 'none' });
    expect(frozen.relationshipPolicy).toEqual({ mode: 'optional' });
  });

  it('normalizes the review policy exactly (spec §6.2)', async () => {
    const frozen = await compileAt(VALID_FIXTURE);
    expect(frozen.reviewPolicy).toEqual({
      mapReview: 'required',
      contentSelector: 'content_bearing',
      mapBatchTargetSlots: 24,
      contentBatchTargetSlots: 24,
      assignmentSoftLimit: 64,
      wholeMapObservation: 'required',
      wholeContentTreeObservation: 'required',
      reviewAdvisoryRelations: true,
      maxRounds: 8,
    });
  });

  it('freezes strict ValidatorRegistrationV2 entries across the trigger/phase matrix', async () => {
    const frozen = await compileAt(VALID_FIXTURE);
    expect(frozen.validators.map((v) => v.validatorId)).toEqual([
      'structure-root-order',
      'content-batch-schema',
      'content-finalize-coverage',
    ]);
    const mapValidator = frozen.validators[0];
    expect(mapValidator.trigger).toBe('map_candidate_commit');
    expect(mapValidator.executionPhase).toBeNull();
    expect(mapValidator.deterministic).toBe(true);
    const batchValidator = frozen.validators[1];
    expect(batchValidator.trigger).toBe('content_commit');
    expect(batchValidator.executionPhase).toBe('batch_commit');
    expect(batchValidator.selector).toEqual({ kind: 'types', typeIds: ['title', 'body'] });
    expect(frozen.validators[2]).toMatchObject({
      trigger: 'content_commit',
      executionPhase: 'plan_finalize',
      enforcement: 'advisory',
    });
  });

  it('freezes the single forge-assembler/v2 registration', async () => {
    const frozen = await compileAt(VALID_FIXTURE);
    expect(frozen.assembler).toEqual({
      abi: 'forge-assembler/v2',
      handlerKey: 'authoritative.seal.render',
      implementationDigest: 'd'.repeat(64),
      implementationRef: { kind: 'builtin', moduleId: '@forge/authoritative-review', exportName: 'renderSeal' },
      budget: { timeoutMs: 30000, maxInputBytes: 67108864, maxOutputBytes: 33554432 },
      routes: [
        { id: 'chapter', artifactFile: 'chapter.md', mediaType: 'text/markdown' },
        { id: 'chapter-json', artifactFile: 'chapter.json', mediaType: 'application/json' },
      ],
    });
  });

  it('freezes the complete closed limit set (42 positive fields across 9 groups)', async () => {
    const frozen = await compileAt(VALID_FIXTURE);
    expect(frozen.limits.relations).toEqual({
      maxRelationsPerMap: 2000,
      maxRelationsPerSlot: 32,
      maxRelationImpactHops: 3,
      maxRelationClosureNodes: 256,
    });
    expect(frozen.limits.authoritative.maxPlannedWorkItemsPerRound).toBe(4000);
    expect(frozen.limits.authoritative.maxConsecutiveAttemptsWithoutProgress).toBe(8);
    expect(frozen.limits.structure.maxSlots).toBe(2500);
  });

  it('emits exact canonical bytes, semantic digest and implementation identity closure', async () => {
    const frozen = await compileAt(VALID_FIXTURE);
    const expectedBytes = canonicalJsonBytes(EXPECTED_CANONICAL_CONTRACT);
    expect(Buffer.compare(Buffer.from(frozen.canonicalBytes), expectedBytes)).toBe(0);
    const digest = await sha256OfBytes(frozen.canonicalBytes);
    expect(frozen.semanticDigest).toBe(digest);
    expect(frozen.semanticDigest).toBe(canonicalJsonSha256(EXPECTED_CANONICAL_CONTRACT));
    expect(frozen.implementationIdentityClosure).toEqual(EXPECTED_IDENTITY_CLOSURE);
  });

  it('keeps the canonical digest invariant under YAML key reordering and cosmetic changes', async () => {
    const baseline = await compileAt(VALID_FIXTURE);
    await withVariant((doc) => reverseKeyOrder(doc), async (root) => {
      const reordered = await compileAt(root);
      expect(Buffer.compare(Buffer.from(reordered.canonicalBytes), baseline.canonicalBytes)).toBe(0);
      expect(reordered.semanticDigest).toBe(baseline.semanticDigest);
    });
  });

  it('changes the canonical digest when any normalized value changes', async () => {
    const baseline = await compileAt(VALID_FIXTURE);
    await withVariant((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['maxRounds'] = 9;
    }, async (root) => {
      const changed = await compileAt(root);
      expect(changed.semanticDigest).not.toBe(baseline.semanticDigest);
    });
  });
});

describe('relationshipPolicy — disabled/optional modes and relation cross-references', () => {
  it('accepts mode disabled with no relation types (zero relations stay legal)', async () => {
    await withVariant((doc) => {
      doc['relationTypes'] = [];
      doc['relationshipPolicy'] = { mode: 'disabled' };
    }, async (root) => {
      const frozen = await compileAt(root);
      expect(frozen.relationTypes).toEqual([]);
      expect(frozen.relationshipPolicy).toEqual({ mode: 'disabled' });
    });
  });

  it('defaults an absent relationshipPolicy to disabled when no relation types are declared', async () => {
    await withVariant((doc) => {
      delete doc['relationshipPolicy'];
      delete doc['relationTypes'];
    }, async (root) => {
      const frozen = await compileAt(root);
      expect(frozen.relationshipPolicy).toEqual({ mode: 'disabled' });
      expect(frozen.relationTypes).toEqual([]);
    });
  });

  it('requires at least one declared relation type for mode optional', async () => {
    await expectInvalid((doc) => {
      doc['relationTypes'] = [];
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects mode disabled together with declared relation types (no silent drop)', async () => {
    await expectInvalid((doc) => {
      doc['relationshipPolicy'] = { mode: 'disabled' };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      delete doc['relationshipPolicy'];
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects unknown modes and unknown relationshipPolicy fields', async () => {
    await expectInvalid((doc) => {
      doc['relationshipPolicy'] = { mode: 'required' };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      doc['relationshipPolicy'] = { mode: 'optional', policy: 1 };
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects invalid relation type declarations', async () => {
    await expectInvalid((doc) => {
      (doc['relationTypes'] as Array<Record<string, unknown>>)[0]['semanticCriterion'] = '';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['relationTypes'] as Array<Record<string, unknown>>)[0]['direction'] = 'bidirectional';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['relationTypes'] as Array<Record<string, unknown>>)[0]['enforcement'] = 'hard';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['relationTypes'] as Array<Record<string, unknown>>)[0]['fromSlotTypes'] = [];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['relationTypes'] as Array<Record<string, unknown>>)[0]['invalidation'] = {
        direction: 'both',
        maxHops: 2,
      };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['relationTypes'] as Array<Record<string, unknown>>)[0]['invalidation'] = {
        direction: 'downstream',
        maxHops: 0,
      };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['relationTypes'] as Array<Record<string, unknown>>)[0]['attributesSchema'] = 'none';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['relationTypes'] as Array<Record<string, unknown>>)[0]['bogus'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects relation endpoints referencing an undeclared slot type', async () => {
    await withVariant((doc) => {
      (doc['relationTypes'] as Array<Record<string, unknown>>)[0]['fromSlotTypes'] = ['nonexistent'];
    }, async (root) => {
      await expect(compileAt(root)).rejects.toThrow('SLOTS_REFERENCE_UNKNOWN');
    });
  });
});

describe('reviewPolicy — strict literals, defaults and required fields (spec §6.2)', () => {
  it('applies spec defaults mapBatchTargetSlots=24, contentBatchTargetSlots=24, assignmentSoftLimit=64', async () => {
    await withVariant((doc) => {
      const rp = doc['reviewPolicy'] as Record<string, unknown>;
      delete rp['mapBatchTargetSlots'];
      delete rp['contentBatchTargetSlots'];
      delete rp['assignmentSoftLimit'];
    }, async (root) => {
      const frozen = await compileAt(root);
      expect(frozen.reviewPolicy.mapBatchTargetSlots).toBe(24);
      expect(frozen.reviewPolicy.contentBatchTargetSlots).toBe(24);
      expect(frozen.reviewPolicy.assignmentSoftLimit).toBe(64);
    });
  });

  it('normalizes omitted literal fields to their frozen literals', async () => {
    await withVariant((doc) => {
      const rp = doc['reviewPolicy'] as Record<string, unknown>;
      delete rp['mapReview'];
      delete rp['contentSelector'];
      delete rp['wholeMapObservation'];
      delete rp['wholeContentTreeObservation'];
    }, async (root) => {
      const frozen = await compileAt(root);
      expect(frozen.reviewPolicy.mapReview).toBe('required');
      expect(frozen.reviewPolicy.contentSelector).toBe('content_bearing');
      expect(frozen.reviewPolicy.wholeMapObservation).toBe('required');
      expect(frozen.reviewPolicy.wholeContentTreeObservation).toBe('required');
    });
  });

  it('accepts only the frozen literals when the fields are present', async () => {
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['mapReview'] = 'optional';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['contentSelector'] = 'all';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['wholeMapObservation'] = false;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['wholeContentTreeObservation'] = 'advisory';
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('requires reviewAdvisoryRelations (boolean) and maxRounds (positive int)', async () => {
    await expectInvalid((doc) => {
      delete (doc['reviewPolicy'] as Record<string, unknown>)['reviewAdvisoryRelations'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['reviewAdvisoryRelations'] = 'true';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      delete (doc['reviewPolicy'] as Record<string, unknown>)['maxRounds'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['maxRounds'] = 0;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['maxRounds'] = 1.5;
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects malformed numeric defaults and unknown reviewPolicy fields', async () => {
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['mapBatchTargetSlots'] = 0;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['contentBatchTargetSlots'] = 24.5;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['assignmentSoftLimit'] = -1;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['reviewPolicy'] as Record<string, unknown>)['bogus'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('ValidatorRegistrationV2 — exact fields, phase matrix, closure rules (spec §6.5)', () => {
  it('rejects a content_commit registration without a non-null execution phase', async () => {
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[1]['executionPhase'] = null;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      delete (doc['validators'] as Array<Record<string, unknown>>)[1]['executionPhase'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[1]['executionPhase'] = 'seal';
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects a non-null execution phase on every non-content trigger', async () => {
    for (const trigger of [
      'map_candidate_commit',
      'map_review_settlement',
      'map_activation',
      'review_settlement',
      'seal_input',
      'seal_output',
    ]) {
      await expectInvalid((doc) => {
        (doc['validators'] as Array<Record<string, unknown>>)[0]['trigger'] = trigger;
        (doc['validators'] as Array<Record<string, unknown>>)[0]['executionPhase'] = 'batch_commit';
      }, 'SLOTS_CONTRACT_INVALID');
    }
  });

  it('accepts an explicit null phase on non-content triggers', async () => {
    await withVariant((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['executionPhase'] = null;
    }, async (root) => {
      await expect(compileAt(root)).resolves.toBeDefined();
    });
  });

  it('rejects advisory enforcement on seal_output but allows it elsewhere', async () => {
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['trigger'] = 'seal_output';
      (doc['validators'] as Array<Record<string, unknown>>)[0]['enforcement'] = 'advisory';
    }, 'SLOTS_CONTRACT_INVALID');
    await withVariant((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['enforcement'] = 'advisory';
    }, async (root) => {
      await expect(compileAt(root)).resolves.toBeDefined();
    });
  });

  it('requires the deterministic literal true, unique validatorIds, and unknown-field rejection', async () => {
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['deterministic'] = false;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['deterministic'] = 'true';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[1]['validatorId'] = 'structure-root-order';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['bogus'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['implementationRef'] = {
        kind: 'http',
        url: 'https://example.invalid/handler.js',
      };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['budgetProfileId'] = '';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['inputContractVersion'] = -1;
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects selector typeIds that are not declared slot types', async () => {
    await withVariant((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[1]['selector'] = {
        kind: 'types',
        typeIds: ['chapter'],
      };
    }, async (root) => {
      await expect(compileAt(root)).rejects.toThrow('SLOTS_REFERENCE_UNKNOWN');
    });
  });

  it('rejects unknown triggers and unknown execution phases', async () => {
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['trigger'] = 'merge';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['trigger'] = 'seal';
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('assembler — exact forge-assembler/v2 registration shape', () => {
  it('rejects unknown assembler fields and a bad ABI', async () => {
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['bogus'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['abi'] = 'forge-assembler/v1';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['handlerKey'] = '';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['implementationRef'] = {
        kind: 'builtin',
        moduleId: '',
        exportName: 'renderSeal',
      };
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects invalid budgets', async () => {
    await expectInvalid((doc) => {
      ((doc['assembler'] as Record<string, unknown>)['budget'] as Record<string, unknown>)['timeoutMs'] = 0;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['assembler'] as Record<string, unknown>)['budget'] as Record<string, unknown>)['maxInputBytes'] = 1.5;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['budget'] = { timeoutMs: 100 };
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('requires non-empty routes with unique ids, contained relative artifact files and closed media types', async () => {
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['routes'] = [];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['assembler'] as Record<string, unknown>)['routes'] as Array<Record<string, unknown>>)[1] = {
        id: 'chapter',
        artifactFile: 'chapter.json',
        mediaType: 'application/json',
      };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['assembler'] as Record<string, unknown>)['routes'] as Array<Record<string, unknown>>)[0]['artifactFile'] = '/etc/passwd';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['assembler'] as Record<string, unknown>)['routes'] as Array<Record<string, unknown>>)[0]['artifactFile'] = '../escape.md';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['assembler'] as Record<string, unknown>)['routes'] as Array<Record<string, unknown>>)[0]['artifactFile'] = 'a\\b.md';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['assembler'] as Record<string, unknown>)['routes'] as Array<Record<string, unknown>>)[0]['mediaType'] = 'image/png';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['assembler'] as Record<string, unknown>)['routes'] as Array<Record<string, unknown>>)[0]['bogus'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('accessProfiles — closed capability union', () => {
  it('rejects unknown capabilities and duplicate profile ids / capabilities', async () => {
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['capabilities'] = ['publish_map_candidate'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[1]['id'] = 'builder';
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['capabilities'] = [
        'append_map_candidate_chunk',
        'append_map_candidate_chunk',
      ];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['capabilities'] = [];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['bogus'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('limits — closed set of positive finite integers', () => {
  it('rejects unknown groups, unknown fields, non-integers, and non-positive values', async () => {
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, unknown>)['bogus'] = { n: 1 };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['limits'] as Record<string, unknown>)['relations'] as Record<string, unknown>)['maxBogus'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['limits'] as Record<string, unknown>)['authoritative'] as Record<string, unknown>)['maxAssignmentsPerRound'] = 0;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      ((doc['limits'] as Record<string, unknown>)['authoritative'] as Record<string, unknown>)['maxFindingsPerRelation'] = 0.5;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      delete ((doc['limits'] as Record<string, unknown>)['authoritative'] as Record<string, unknown>)['maxPlannedWorkItemsPerRound'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      delete (doc['limits'] as Record<string, unknown>)['relations'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, unknown>)['structure'] = { maxSlots: -5 };
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('exact top-level shape — unknown and cross-version fields fail closed', () => {
  it('rejects unknown top-level fields', async () => {
    await expectInvalid((doc) => {
      doc['bogus'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects v1-only top-level fields smuggled into contract v2 (cross-version)', async () => {
    await expectInvalid((doc) => {
      doc['resourceManifest'] = [];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      doc['abiProfileIdentity'] = { validatorAbi: 'forge-validator/v1' };
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects v1-shaped access profiles inside contract v2', async () => {
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['read'] = [
        { targets: { kind: 'all' }, targetLevel: 'content' },
      ];
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects missing required top-level fields and a non-v2 version literal', async () => {
    await expectInvalid((doc) => {
      delete doc['limits'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      delete doc['reviewPolicy'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['version'] as unknown) = 1;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['version'] as unknown) = 3;
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('committed invalid fixture variants', () => {
  it('rejects a v2 contract carrying the v1-only resourceManifest field', async () => {
    await expect(compileAt(INVALID_CROSS_VERSION)).rejects.toThrow('SLOTS_CONTRACT_INVALID');
  });

  it('rejects an advisory seal_output validator registration', async () => {
    await expect(compileAt(INVALID_ADVISORY_SEAL_OUTPUT)).rejects.toThrow('SLOTS_CONTRACT_INVALID');
  });

  it('rejects a non-content trigger with a non-null execution phase', async () => {
    await expect(compileAt(INVALID_BAD_PHASE)).rejects.toThrow('SLOTS_CONTRACT_INVALID');
  });
});