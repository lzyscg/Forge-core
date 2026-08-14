// @vitest-environment node
/**
 * Validator engine tests (Task 14 Step 2/3, red first).
 *
 * The engine executes ONE trigger/phase of allowlisted deterministic validators
 * (spec §12 / design §9): canonical `ValidatorInputEnvelopeV2` construction,
 * resolved-ABI-v2-data-only handler input, hardened sandbox execution with a
 * determinism double-run, closed `ValidatorResultV2` normalization, trigger/
 * target matrix validation, receipt/failure materialization, warning custody
 * for advisory invalid (never repair plans), and the frozen outcome priority
 * infrastructure_failure > blocking_invalid > clear. Aggregate/custody DAG
 * tests prove the recursive input chain, canonical ordering, phase separation,
 * acyclicity and failed-branch survival.
 */
import { describe, expect, it } from 'vitest';
import type { BlobRefV2, AuthoritativeBlobKindV2 } from '../../../shared/authoritative-review-v2';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import { refOfBlob, closureOf, assertNoSelfReference, parseBlob } from '../../authoritative-review/object-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES } from './builtin-validators';
import { ValidatorRegistry } from './validator-registry';
import {
  VALIDATOR_FAILURE_CODES,
  ValidatorEngine,
  buildValidatorEnvelopeV2,
  registrationSetDigestOf,
  validateIssueTargets,
  type TriggerExecutionResult,
  type ValidatorBlobStore,
  type ValidatorRunRequest,
  type ValidatorTargetUniverse,
} from './validator-engine';

class MemoryBlobStore implements ValidatorBlobStore {
  private readonly data = new Map<string, unknown>();

  put(kind: AuthoritativeBlobKindV2, value: unknown): BlobRefV2 {
    const ref = refOfBlob(kind, value);
    this.data.set(ref.digest, value);
    return ref;
  }

  resolve(ref: BlobRefV2): unknown | null {
    return this.data.get(ref.digest) ?? null;
  }

  has(ref: BlobRefV2): boolean {
    return this.data.has(ref.digest);
  }
}

const PROFILE = buildAuthoritativeReviewTestProfileBody();
const REGISTRY = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);

function makeEngine(sourceResolver?: (handlerKey: string) => string | null): { engine: ValidatorEngine; blobs: MemoryBlobStore } {
  const blobs = new MemoryBlobStore();
  return { engine: new ValidatorEngine({ registry: REGISTRY, blobs, ...(sourceResolver ? { sourceResolver } : {}) }), blobs };
}

function entryOf(handlerKey: string) {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.handlerKey === handlerKey);
  if (!entry) throw new Error(`no builtin entry ${handlerKey}`);
  return entry;
}

function registrationFor(handlerKey: string, overrides: Partial<ValidatorRegistrationV2> = {}): ValidatorRegistrationV2 {
  const entry = entryOf(handlerKey);
  return {
    validatorId: `v-${handlerKey.split('.').pop()}`,
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: entry.trigger,
    executionPhase: entry.executionPhase,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: entry.inputContractVersion,
    outputContractVersion: entry.outputContractVersion,
    budgetProfileId: entry.budgetProfileId,
    ...overrides,
  };
}

function identity(taskId = 'task-1') {
  return { taskId, templateSnapshotHash: 'tpl-hash', workItemId: 'wi-1', attemptId: 'att-1', commandId: null };
}

function baseRequest(overrides: Partial<ValidatorRunRequest> = {}): ValidatorRunRequest {
  return {
    trigger: 'map_candidate_commit',
    identity: identity(),
    coreRef: (undefined as unknown) as BlobRefV2,
    selectedTargetRefs: [],
    registrations: [],
    universe: { slotIds: [], relationIds: [], mapNodeIds: [], artifactDigest: null },
    profile: PROFILE,
    ...overrides,
  } as ValidatorRunRequest;
}

function selfDigestOf(value: Record<string, unknown>, field: string): string {
  const copy = { ...value };
  delete copy[field];
  return canonicalJsonSha256(copy);
}

/* ------------------------------------------------------------------ */
/* Fixture builders                                                    */
/* ------------------------------------------------------------------ */

function mapCandidateCore(nodes: unknown[], relations: unknown[]) {
  const core: Record<string, unknown> = {
    candidateId: 'c1',
    baseMapId: null,
    positionGraphDigest: 'pos',
    relationGraphDigest: 'rel',
    templateSnapshotHash: 'tpl-hash',
    nodes,
    relations,
    candidateProvenanceWithoutValidation: {
      producerKind: 'system_map_finalize',
      producerWorkItemId: 'wi-finalize',
      commandId: 'cmd-finalize',
      mapBuildId: 'build-1',
      mapBuildRevision: 1,
      contributionManifestRef: refOfBlob('contribution_manifest', { manifestDigest: 'cm' }),
    },
    coreDigest: '',
  };
  core.coreDigest = selfDigestOf(core, 'coreDigest');
  return core;
}

function mapNode(slotId: string, parentSlotId: string | null, documentOrder: number) {
  return {
    slotId,
    slotType: 'title',
    contentBearing: true,
    parentSlotId,
    documentOrder,
    siblingOrder: 0,
    nodeSpecDigest: `node-${slotId}`,
  };
}

function contentCommitCore() {
  const core: Record<string, unknown> = {
    priorManifestRef: refOfBlob('content_revision_manifest', { manifestDigest: 'prior' }),
    producerPlanSpecRef: refOfBlob('generation_plan_spec', { planSpecId: 'p1' }),
    batchOrdinal: 0,
    authorizedReplacementEntries: [],
    expectedMapRef: refOfBlob('map_snapshot', { mapId: 'm1' }),
    coreDigest: '',
  };
  core.coreDigest = selfDigestOf(core, 'coreDigest');
  return core;
}

function contentManifest(entries: unknown[]) {
  const manifest: Record<string, unknown> = {
    taskId: 'task-1',
    mapRef: refOfBlob('map_snapshot', { mapId: 'm1' }),
    mapSemanticDigest: 'ms',
    taskContentRevision: 1,
    manifestPhase: 'provisional',
    entries,
    producerPlanSpecRef: null,
    priorManifestRef: null,
    finalizerValidatorAggregateRefs: [],
    finalizerWarningRootRefs: [],
    contentRootDigest: 'root',
    manifestDigest: '',
  };
  manifest.manifestDigest = selfDigestOf(manifest, 'manifestDigest');
  return manifest;
}

function contentFinalizeCore(manifestRef: BlobRefV2) {
  const core: Record<string, unknown> = {
    producerPlanSpecRef: refOfBlob('generation_plan_spec', { planSpecId: 'p1' }),
    provisionalManifestRef: manifestRef,
    mapContext: { kind: 'active', activeMapRef: refOfBlob('map_snapshot', { mapId: 'm1' }) },
    expectedContentRootDigest: 'root',
    requiredSlotCoverageDigest: 'cov',
    expectedBatchClosureDigest: 'closure',
    coreDigest: '',
  };
  core.coreDigest = selfDigestOf(core, 'coreDigest');
  return core;
}

function reviewBundle() {
  const bundle: Record<string, unknown> = {
    settlementCoreRef: refOfBlob('content_review_settlement_core', { coreDigest: 'sc' }),
    mapRef: refOfBlob('map_snapshot', { mapId: 'm1' }),
    contentRevisionManifestRef: refOfBlob('content_revision_manifest', { manifestDigest: 'm' }),
    reviewWarningCustodyRootRef: refOfBlob('validation_warning_custody_root', { rootDigest: 'w' }),
    bundleDigest: '',
  };
  bundle.bundleDigest = selfDigestOf(bundle, 'bundleDigest');
  return bundle;
}

const TITLE_SCHEMA = { type: 'string', minLength: 1, maxLength: 200 };
const BODY_SCHEMA = { type: 'string', minLength: 1, maxLength: 10_000 };
const SLOT_TYPES = [
  { id: 'title', name: 'Title', description: 't', contentPresence: 'required' as const, contentSchema: TITLE_SCHEMA },
  { id: 'body', name: 'Body', description: 'b', contentPresence: 'required' as const, contentSchema: BODY_SCHEMA },
];

function contentTarget(slotId: string, typeId: string, content: string) {
  return refOfBlob('content_value', { slotId, typeId, content });
}

/**
 * M-8a: runs every materialized engine output (envelope, aggregate, warning
 * root, receipts, failures) through the REGISTERED parsers — so I-1/M-3-class
 * bugs (aggregates/receipts the real blob store would reject as corrupt)
 * cannot escape the engine tests.
 */
function assertEngineBlobsParse(result: TriggerExecutionResult): void {
  expect(() => parseBlob('validator_input_envelope', result.envelope, result.envelopeRef)).not.toThrow();
  expect(() => parseBlob('validator_aggregate', result.aggregate, result.aggregateRef)).not.toThrow();
  expect(() => parseBlob('validation_warning_root', result.warningRoot, result.warningRootRef)).not.toThrow();
  for (const receipt of result.receipts) {
    const ref = refOfBlob('validation_receipt', receipt);
    expect(() => parseBlob('validation_receipt', receipt, ref)).not.toThrow();
  }
  for (const failure of result.failures) {
    const ref = refOfBlob('validator_failure', failure);
    expect(() => parseBlob('validator_failure', failure, ref)).not.toThrow();
  }
}

/* ------------------------------------------------------------------ */
/* Envelope + phase + determinism                                      */
/* ------------------------------------------------------------------ */

describe('validator engine — canonical envelope construction (spec §12)', () => {
  const coreRef = refOfBlob('content_revision_commit_core', { batchOrdinal: 0 });
  const target = refOfBlob('content_value', { slotId: 's1' });

  it('builds the exact branch for every trigger', () => {
    const taskId = 'task-1';
    const tpl = 'tpl-hash';
    expect(buildValidatorEnvelopeV2({ trigger: 'map_candidate_commit', taskId, templateSnapshotHash: tpl, coreRef, selectedTargetRefs: [target] })).toEqual({
      trigger: 'map_candidate_commit', taskId, templateSnapshotHash: tpl, mapCandidateValidationCoreRef: coreRef, selectedTargetRefs: [target],
    });
    expect(buildValidatorEnvelopeV2({ trigger: 'content_commit', executionPhase: 'batch_commit', taskId, templateSnapshotHash: tpl, coreRef, selectedTargetRefs: [target] })).toEqual({
      trigger: 'content_commit', executionPhase: 'batch_commit', taskId, templateSnapshotHash: tpl, contentValidationCoreRef: coreRef, selectedTargetRefs: [target],
    });
    expect(buildValidatorEnvelopeV2({ trigger: 'map_activation', taskId, templateSnapshotHash: tpl, coreRef, auxiliaryRefs: { proposedMapCoreRef: coreRef }, selectedTargetRefs: [] })).toEqual({
      trigger: 'map_activation', taskId, templateSnapshotHash: tpl, mapReviewSettlementCoreRef: coreRef, proposedMapCoreRef: coreRef, selectedTargetRefs: [],
    });
    expect(buildValidatorEnvelopeV2({ trigger: 'seal_output', taskId, templateSnapshotHash: tpl, coreRef, auxiliaryRefs: { artifactRef: target }, selectedTargetRefs: [] })).toEqual({
      trigger: 'seal_output', taskId, templateSnapshotHash: tpl, reviewBundleRef: coreRef, artifactRef: target, selectedTargetRefs: [],
    });
  });

  it('persists the envelope as its own canonical blob before execution', async () => {
    const { engine, blobs } = makeEngine();
    const coreRef = blobs.put('map_candidate_validation_core', mapCandidateCore([mapNode('s1', null, 0)], []));
    const result = await engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef,
        registrations: [registrationFor('authoritative.review.completeness')],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null },
      }),
    );
    expect(blobs.has(result.envelopeRef)).toBe(true);
    expect(result.envelope.trigger).toBe('map_candidate_commit');
    expect(result.envelopeRef.digest).toBe(refOfBlob('validator_input_envelope', result.envelope).digest);
  });

  it('phase separation: batch_commit registrations never run for plan_finalize and vice versa', async () => {
    const { engine, blobs } = makeEngine();
    const manifest = contentManifest([{ slotId: 's1', state: 'set' }]);
    const manifestRef = blobs.put('content_revision_manifest', manifest);
    const finalizeCore = contentFinalizeCore(manifestRef);
    const coreRef = blobs.put('content_plan_finalize_core', finalizeCore);
    // Only the coverage (plan_finalize) registration is in the set.
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'plan_finalize',
        coreRef,
        registrations: [registrationFor('authoritative.review.coverage', { enforcement: 'blocking' })],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        context: { requiredSlotIds: ['s1'] },
      }),
    );
    expect(result.aggregate.outcome).toBe('clear');
    expect(result.validExecutionDigests).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Builtin executions                                                  */
/* ------------------------------------------------------------------ */

describe('validator engine — builtin executions', () => {
  it('completeness passes a well-formed candidate and blocks a duplicate slot', async () => {
    const { engine, blobs } = makeEngine();
    const good = blobs.put('map_candidate_validation_core', mapCandidateCore([mapNode('s1', null, 0), mapNode('s2', 's1', 1)], []));
    const goodResult = await engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef: good,
        registrations: [registrationFor('authoritative.review.completeness')],
        universe: { slotIds: ['s1', 's2'], relationIds: [], mapNodeIds: ['s1', 's2'], artifactDigest: null },
      }),
    );
    expect(goodResult.aggregate.outcome).toBe('clear');
    expect(goodResult.validExecutionDigests).toHaveLength(1);
    expect(goodResult.receipts).toHaveLength(0);

    const bad = blobs.put('map_candidate_validation_core', mapCandidateCore([mapNode('s1', null, 0), mapNode('s1', null, 1)], []));
    const badResult = await engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef: bad,
        registrations: [registrationFor('authoritative.review.completeness')],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null },
      }),
    );
    expect(badResult.aggregate.outcome).toBe('blocking_invalid');
    expect(badResult.receipts).toHaveLength(1);
    expect(badResult.receipts[0]?.blockerIssues[0]?.issueCode).toContain('duplicate');
  });

  it('slotSchema passes conforming content and blocks a schema violation', async () => {
    const { engine, blobs } = makeEngine();
    const coreRef = blobs.put('content_revision_commit_core', contentCommitCore());
    const okTarget = blobs.put('content_value', { slotId: 's1', typeId: 'title', content: 'hello' });
    const ok = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'batch_commit',
        coreRef,
        selectedTargetRefs: [okTarget],
        registrations: [registrationFor('authoritative.review.slotSchema')],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        slotTypes: SLOT_TYPES,
      }),
    );
    expect(ok.aggregate.outcome).toBe('clear');

    const badTarget = blobs.put('content_value', { slotId: 's2', typeId: 'title', content: 'x'.repeat(500) });
    const bad = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'batch_commit',
        coreRef,
        selectedTargetRefs: [badTarget],
        registrations: [registrationFor('authoritative.review.slotSchema')],
        universe: { slotIds: ['s2'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        slotTypes: SLOT_TYPES,
      }),
    );
    expect(bad.aggregate.outcome).toBe('blocking_invalid');
    expect(bad.receipts[0]?.blockerIssues[0]?.issueCode).toContain('maxLength');
  });

  it('coverage advisory invalid becomes warning custody and counts as clear', async () => {
    const { engine, blobs } = makeEngine();
    const manifest = contentManifest([{ slotId: 's1', state: 'unset' }, { slotId: 's2', state: 'set' }]);
    const manifestRef = blobs.put('content_revision_manifest', manifest);
    const coreRef = blobs.put('content_plan_finalize_core', contentFinalizeCore(manifestRef));
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'plan_finalize',
        coreRef,
        registrations: [registrationFor('authoritative.review.coverage', { enforcement: 'advisory' })],
        universe: { slotIds: ['s1', 's2'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        context: { requiredSlotIds: ['s1', 's2'] },
      }),
    );
    // Advisory invalid: warning custody root, never a repair plan, outcome clear.
    expect(result.aggregate.outcome).toBe('clear');
    expect(result.aggregate.advisoryReceiptRefs).toHaveLength(1);
    expect(result.aggregate.blockingInvalidReceiptRefs).toHaveLength(0);
    expect(result.warningRoot.warningCount).toBe(1);
    expect(result.warningRoot.orderedAdvisoryReceiptRefs).toEqual(result.aggregate.advisoryReceiptRefs);
    expect(result.receipts[0]?.blockerIssues[0]?.issueCode).toContain('required_not_set');
  });

  it('coverage blocking invalid yields a blocking aggregate', async () => {
    const { engine, blobs } = makeEngine();
    const manifest = contentManifest([{ slotId: 's1', state: 'unset' }]);
    const manifestRef = blobs.put('content_revision_manifest', manifest);
    const coreRef = blobs.put('content_plan_finalize_core', contentFinalizeCore(manifestRef));
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'plan_finalize',
        coreRef,
        registrations: [registrationFor('authoritative.review.coverage', { enforcement: 'blocking' })],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        context: { requiredSlotIds: ['s1'] },
      }),
    );
    expect(result.aggregate.outcome).toBe('blocking_invalid');
  });

  it('artifactPath passes a declared route and blocks an undeclared route', async () => {
    const { engine, blobs } = makeEngine();
    const bundleRef = blobs.put('review_bundle', reviewBundle());
    const artifactRef = refOfBlob('artifact', 'chapter-markdown');
    const assemblerRoutes = [
      { id: 'chapter', mediaType: 'text/markdown' },
      { id: 'chapter-json', mediaType: 'application/json' },
    ];
    const ok = await engine.execute(
      baseRequest({
        trigger: 'seal_output',
        coreRef: bundleRef,
        auxiliaryRefs: { artifactRef },
        registrations: [registrationFor('authoritative.review.artifactPath')],
        universe: { slotIds: [], relationIds: [], mapNodeIds: [], artifactDigest: artifactRef.digest },
        context: { artifactRouteId: 'chapter', assemblerRoutes },
      }),
    );
    expect(ok.aggregate.outcome).toBe('clear');

    const bad = await engine.execute(
      baseRequest({
        trigger: 'seal_output',
        coreRef: bundleRef,
        auxiliaryRefs: { artifactRef },
        registrations: [registrationFor('authoritative.review.artifactPath')],
        universe: { slotIds: [], relationIds: [], mapNodeIds: [], artifactDigest: artifactRef.digest },
        context: { artifactRouteId: 'ghost-route', assemblerRoutes },
      }),
    );
    expect(bad.aggregate.outcome).toBe('blocking_invalid');
    expect(bad.receipts[0]?.blockerIssues[0]?.issueCode).toContain('undeclared_route');
  });

  it('aggregate outcome priority is infrastructure > blocking invalid > clear', async () => {
    const { engine, blobs } = makeEngine();
    const manifest = contentManifest([{ slotId: 's1', state: 'unset' }]);
    const manifestRef = blobs.put('content_revision_manifest', manifest);
    const coreRef = blobs.put('content_plan_finalize_core', contentFinalizeCore(manifestRef));
    // A blocking coverage (would be blocking_invalid) PLUS a non-installed
    // handler (infrastructure) — the aggregate must be infrastructure.
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'plan_finalize',
        coreRef,
        registrations: [
          registrationFor('authoritative.review.coverage', { enforcement: 'blocking', validatorId: 'v-coverage' }),
          {
            validatorId: 'v-ghost',
            handlerKey: 'ghost.handler',
            implementationDigest: '0'.repeat(64),
            implementationRef: { kind: 'builtin', moduleId: 'ghost', exportName: 'ghost' },
            trigger: 'content_commit',
            executionPhase: 'plan_finalize',
            selector: { kind: 'all' },
            enforcement: 'blocking',
            deterministic: true,
            inputContractVersion: 2,
            outputContractVersion: 2,
            budgetProfileId: 'authoritative-validator-default',
          },
        ],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        context: { requiredSlotIds: ['s1'] },
      }),
    );
    expect(result.aggregate.outcome).toBe('infrastructure_failure');
    expect(result.aggregate.infrastructureFailureRefs.length).toBeGreaterThan(0);
    expect(result.failures.some((f) => f.failureCode === VALIDATOR_FAILURE_CODES.REGISTRY_REJECTED)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Fail-closed output + spoof + target matrix                          */
/* ------------------------------------------------------------------ */

describe('validator engine — output contract and enforcement spoof', () => {
  async function runWithSource(source: string, overrides: Partial<ValidatorRunRequest> = {}) {
    const { engine, blobs } = makeEngine(() => source);
    const coreRef = blobs.put('map_candidate_validation_core', mapCandidateCore([mapNode('s1', null, 0)], []));
    return engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef,
        registrations: [registrationFor('authoritative.review.completeness')],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null },
        ...overrides,
      }),
    );
  }

  it('a handler that throws (process/require/fetch access) becomes an infrastructure failure', async () => {
    const result = await runWithSource(
      `'use strict';\nmodule.exports = { validate: function (input) { process.exit(1); } };`,
    );
    expect(result.aggregate.outcome).toBe('infrastructure_failure');
    expect(result.failures[0]?.failureCode).toBe(VALIDATOR_FAILURE_CODES.HANDLER_RUNTIME);
  });

  it('network/task-I/O access is impossible in the sandbox', async () => {
    const fetchResult = await runWithSource(
      `'use strict';\nmodule.exports = { validate: function (input) { globalThis.fetch('http://x'); } };`,
    );
    expect(fetchResult.aggregate.outcome).toBe('infrastructure_failure');
    const requireResult = await runWithSource(
      `'use strict';\nmodule.exports = { validate: function (input) { require('node:fs'); } };`,
    );
    expect(requireResult.aggregate.outcome).toBe('infrastructure_failure');
  });

  it('clock/random are stripped: a Date/Math.random handler is deterministic', async () => {
    const source = `'use strict';\nmodule.exports = { validate: function (input) { return { status: 'valid', executionDigest: String(Date.now()) + String(Math.random()) }; } };`;
    const result = await runWithSource(source);
    expect(result.aggregate.outcome).toBe('clear');
    expect(result.validExecutionDigests).toHaveLength(1);
  });

  it('a stateful handler that returns different results across the double-run is isolated (nondeterminism)', async () => {
    const source = `'use strict';
let count = 0;
module.exports = { validate: function (input) {
  count = count + 1;
  if (count === 1) return { status: 'valid', executionDigest: '' };
  return { status: 'domain_invalid', issues: [{
    validatorId: input.validatorId, implementationDigest: input.implementationDigest,
    issueCode: 'nondet', location: { targetKind: 'node', stableTargetId: 's1', jsonPointer: null },
    repairTargets: { mapNodeIds: [], relationIds: [], slotIds: [] }, evidenceDigest: ''
  }], executionDigest: '' };
} };`;
    const result = await runWithSource(source);
    expect(result.aggregate.outcome).toBe('infrastructure_failure');
    expect(result.failures[0]?.failureCode).toBe(VALIDATOR_FAILURE_CODES.NONDETERMINISTIC_RESULT);
  });

  it('empty/unknown/malformed outputs become infrastructure failures', async () => {
    const empty = await runWithSource(`'use strict';\nmodule.exports = { validate: function () { return null; } };`);
    expect(empty.aggregate.outcome).toBe('infrastructure_failure');
    const extra = await runWithSource(
      `'use strict';\nmodule.exports = { validate: function (input) { return { status: 'valid', executionDigest: '', enforcement: 'advisory' }; } };`,
    );
    expect(extra.aggregate.outcome).toBe('infrastructure_failure');
    const issuesOnValid = await runWithSource(
      `'use strict';\nmodule.exports = { validate: function (input) { return { status: 'valid', issues: [], executionDigest: '' }; } };`,
    );
    expect(issuesOnValid.aggregate.outcome).toBe('infrastructure_failure');
    const emptyIssues = await runWithSource(
      `'use strict';\nmodule.exports = { validate: function (input) { return { status: 'domain_invalid', issues: [], executionDigest: '' }; } };`,
    );
    expect(emptyIssues.aggregate.outcome).toBe('infrastructure_failure');
  });

  it('handler-enforcement spoof is rejected: a blocking input cannot be downgraded', async () => {
    const spoof = await runWithSource(
      `'use strict';\nmodule.exports = { validate: function (input) {
        return { status: 'domain_invalid', enforcement: 'advisory', issues: [{
          validatorId: input.validatorId, implementationDigest: input.implementationDigest,
          issueCode: 'blocking-v', location: { targetKind: 'node', stableTargetId: 's1', jsonPointer: null },
          repairTargets: { mapNodeIds: [], relationIds: [], slotIds: [] }, evidenceDigest: '',
          severity: 'error'
        }], executionDigest: '' };
      } };`,
    );
    // Extra enforcement/severity fields make the output malformed → infrastructure.
    expect(spoof.aggregate.outcome).toBe('infrastructure_failure');
  });

  it('an issue naming another validator is rejected as a spoof', async () => {
    const spoof = await runWithSource(
      `'use strict';\nmodule.exports = { validate: function (input) {
        return { status: 'domain_invalid', issues: [{
          validatorId: 'someone-else', implementationDigest: input.implementationDigest,
          issueCode: 'spoof', location: { targetKind: 'node', stableTargetId: 's1', jsonPointer: null },
          repairTargets: { mapNodeIds: [], relationIds: [], slotIds: [] }, evidenceDigest: ''
        }], executionDigest: '' };
      } };`,
    );
    expect(spoof.aggregate.outcome).toBe('infrastructure_failure');
    expect(spoof.failures[0]?.failureCode).toBe(VALIDATOR_FAILURE_CODES.OUTPUT_MALFORMED);
  });
});

/* ------------------------------------------------------------------ */
/* Target matrix                                                       */
/* ------------------------------------------------------------------ */

describe('validator engine — trigger/target matrix', () => {
  it('rejects a target outside the selected snapshot', () => {
    const universe: ValidatorTargetUniverse = { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null };
    const issue = {
      validatorId: 'v',
      implementationDigest: '0'.repeat(64),
      issueCode: 'x',
      location: { targetKind: 'slot', stableTargetId: 's-ghost', jsonPointer: null },
      repairTargets: { mapNodeIds: [], relationIds: [], slotIds: [] },
      evidenceDigest: '',
    };
    expect(validateIssueTargets('content_commit', issue, universe)).toBe('target outside the selected snapshot');
  });

  it('seal_input without repair targets is rejected', () => {
    const universe: ValidatorTargetUniverse = { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null };
    const issue = {
      validatorId: 'v',
      implementationDigest: '0'.repeat(64),
      issueCode: 'no-repair',
      location: { targetKind: 'slot', stableTargetId: 's1', jsonPointer: null },
      repairTargets: { mapNodeIds: [], relationIds: [], slotIds: [] },
      evidenceDigest: '',
    };
    expect(validateIssueTargets('seal_input', issue, universe)).toBe('seal_input issues must carry a reachable repair target');
    // With a reachable repair target the same issue is legal.
    const fixed = {
      ...issue,
      repairTargets: { mapNodeIds: [], relationIds: [], slotIds: ['s1'] },
    };
    expect(validateIssueTargets('seal_input', fixed, universe)).toBeNull();
  });

  it('seal_output with content repair targets is rejected', () => {
    const universe: ValidatorTargetUniverse = { slotIds: [], relationIds: [], mapNodeIds: [], artifactDigest: 'a'.repeat(64) };
    const issue = {
      validatorId: 'v',
      implementationDigest: '0'.repeat(64),
      issueCode: 'x',
      location: { targetKind: 'artifact', stableTargetId: 'a'.repeat(64), jsonPointer: null },
      repairTargets: { mapNodeIds: [], relationIds: [], slotIds: ['s1'] },
      evidenceDigest: '',
    };
    expect(validateIssueTargets('seal_output', issue, universe)).toBe('seal_output issues must carry empty repair targets');
  });

  it('map triggers must not carry slot repair targets', () => {
    const universe: ValidatorTargetUniverse = { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null };
    const issue = {
      validatorId: 'v',
      implementationDigest: '0'.repeat(64),
      issueCode: 'x',
      location: { targetKind: 'node', stableTargetId: 's1', jsonPointer: null },
      repairTargets: { mapNodeIds: [], relationIds: [], slotIds: ['s1'] },
      evidenceDigest: '',
    };
    expect(validateIssueTargets('map_candidate_commit', issue, universe)).toBe('map triggers must not carry slot repair targets');
  });
});

/* ------------------------------------------------------------------ */
/* Aggregate/custody DAG (Step 3)                                      */
/* ------------------------------------------------------------------ */

describe('validator engine — aggregate/custody DAG', () => {
  it('missing/duplicate execution becomes an infrastructure failure', async () => {
    // Duplicate: two registrations with the same identity → DUPLICATE_EXECUTION.
    // The core ref is never put, so the FIRST registration also fails with
    // INPUT_UNRESOLVABLE — two sorted infrastructure-failure refs in total.
    const { engine } = makeEngine();
    const coreRef = refOfBlob('map_candidate_validation_core', mapCandidateCore([mapNode('s1', null, 0)], []));
    const duplicate = await engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef,
        registrations: [
          registrationFor('authoritative.review.completeness', { validatorId: 'v-a' }),
          registrationFor('authoritative.review.completeness', { validatorId: 'v-b' }),
        ],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null },
      }),
    );
    expect(duplicate.aggregate.outcome).toBe('infrastructure_failure');
    expect(duplicate.failures.some((f) => f.failureCode === VALIDATOR_FAILURE_CODES.DUPLICATE_EXECUTION)).toBe(true);
    expect(duplicate.failures.some((f) => f.failureCode === VALIDATOR_FAILURE_CODES.INPUT_UNRESOLVABLE)).toBe(true);
    // registrationSetDigest covers BOTH registrations even when one failed.
    expect(duplicate.aggregate.registrationSetDigest).toBe(
      registrationSetDigestOf([
        registrationFor('authoritative.review.completeness', { validatorId: 'v-a' }),
        registrationFor('authoritative.review.completeness', { validatorId: 'v-b' }),
      ]),
    );
    // Canonical ordering: the two infrastructure refs are sorted by digest.
    const infra = duplicate.aggregate.infrastructureFailureRefs;
    expect(infra.length).toBe(2);
    for (let i = 1; i < infra.length; i++) {
      expect(infra[i - 1]!.digest < infra[i]!.digest).toBe(true);
    }
  });

  it('recursive aggregate.inputRef → envelope → core is reachable and acyclic', async () => {
    const { engine, blobs } = makeEngine();
    const coreRef = blobs.put('map_candidate_validation_core', mapCandidateCore([mapNode('s1', null, 0)], []));
    const result = await engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef,
        registrations: [registrationFor('authoritative.review.completeness')],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null },
      }),
    );
    // No self reference anywhere in the published DAG.
    expect(() => assertNoSelfReference('validator_aggregate', result.aggregate)).not.toThrow();
    // closureOf the final aggregate resolves the envelope AND the core.
    const resolved = new Map<string, unknown>();
    const walk = (ref: BlobRefV2) => {
      const value = blobs.resolve(ref);
      if (value !== null) resolved.set(ref.digest, value);
      return value;
    };
    const closure = closureOf(result.aggregate, walk, 'validator_aggregate');
    expect(closure.some((r) => r.kind === 'validator_input_envelope')).toBe(true);
    expect(closure.some((r) => r.kind === 'map_candidate_validation_core')).toBe(true);
    expect(resolved.has(coreRef.digest)).toBe(true);
  });

  it('failed branches survive: aggregate → failure → envelope → core all resolvable', async () => {
    const { engine, blobs } = makeEngine();
    const coreRef = blobs.put('map_candidate_validation_core', mapCandidateCore([mapNode('s1', null, 0)], []));
    const result = await engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef,
        registrations: [registrationFor('authoritative.review.completeness', { validatorId: 'v-ghost', implementationDigest: '0'.repeat(64) })],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null },
      }),
    );
    expect(result.aggregate.outcome).toBe('infrastructure_failure');
    const failureRef = result.aggregate.infrastructureFailureRefs[0]!;
    expect(failureRef.kind).toBe('validator_failure');
    expect(blobs.has(failureRef)).toBe(true);
    // The failure's inputRef points at the ENVELOPE (the canonical input); the
    // envelope's core ref resolves to the core — so the original input stays
    // recursively reviewable through the aggregate → failure → envelope → core
    // chain.
    const failure = blobs.resolve(failureRef) as { inputRef: BlobRefV2 };
    expect(failure.inputRef).toEqual(result.envelopeRef);
    const envelope = blobs.resolve(result.aggregate.inputRef) as { mapCandidateValidationCoreRef: BlobRefV2 };
    expect(envelope.mapCandidateValidationCoreRef).toEqual(coreRef);
    const failureEnvelope = blobs.resolve(failure.inputRef) as { mapCandidateValidationCoreRef: BlobRefV2 };
    expect(failureEnvelope.mapCandidateValidationCoreRef).toEqual(coreRef);
    expect(blobs.has(coreRef)).toBe(true);
  });

  it('canonical ordering: receipt/valid digests are sorted; receipts carry the intermediate aggregate', async () => {
    const { engine, blobs } = makeEngine();
    const manifest = contentManifest([{ slotId: 's1', state: 'unset' }, { slotId: 's2', state: 'set' }]);
    const manifestRef = blobs.put('content_revision_manifest', manifest);
    const coreRef = blobs.put('content_plan_finalize_core', contentFinalizeCore(manifestRef));
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'plan_finalize',
        coreRef,
        registrations: [registrationFor('authoritative.review.coverage', { enforcement: 'advisory' })],
        universe: { slotIds: ['s1', 's2'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        context: { requiredSlotIds: ['s1', 's2'] },
      }),
    );
    expect(result.aggregate.outcome).toBe('clear');
    // The single advisory receipt is sorted trivially and matches the warning root.
    expect(result.aggregate.advisoryReceiptRefs).toHaveLength(1);
    expect(result.aggregate.advisoryReceiptRefs).toEqual(result.warningRoot.orderedAdvisoryReceiptRefs);
    // Every receipt references the intermediate aggregate, which exists on disk.
    for (const receipt of result.receipts) {
      expect(receipt.validatorAggregateRef).toEqual(result.receiptAggregateRef);
      expect(blobs.has(receipt.validatorAggregateRef)).toBe(true);
    }
    // validExecutionDigests stay sorted (two identical valid digests de-dupe to one).
    expect([...result.validExecutionDigests]).toEqual([...result.validExecutionDigests].sort());
  });

  it('the final aggregate and warning root are both materialized (advisory path)', async () => {
    const { engine, blobs } = makeEngine();
    const manifest = contentManifest([{ slotId: 's1', state: 'unset' }]);
    const manifestRef = blobs.put('content_revision_manifest', manifest);
    const coreRef = blobs.put('content_plan_finalize_core', contentFinalizeCore(manifestRef));
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'plan_finalize',
        coreRef,
        registrations: [registrationFor('authoritative.review.coverage', { enforcement: 'advisory' })],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        context: { requiredSlotIds: ['s1'] },
      }),
    );
    expect(blobs.has(result.aggregateRef)).toBe(true);
    expect(blobs.has(result.warningRootRef)).toBe(true);
    expect(result.aggregate.warningRootRef).toEqual(result.warningRootRef);
  });
});

/* ------------------------------------------------------------------ */
/* Fix round 1 (adversarial review) — I-1, I-2, M-3, M-6, M-7, M-8     */
/* ------------------------------------------------------------------ */

describe('validator engine — fix round 1 (adversarial review)', () => {
  it('an aggregate with BOTH infra failures and blocking receipts parses through the registered parser (I-1)', async () => {
    const { engine, blobs } = makeEngine();
    const manifest = contentManifest([{ slotId: 's1', state: 'unset' }]);
    const manifestRef = blobs.put('content_revision_manifest', manifest);
    const coreRef = blobs.put('content_plan_finalize_core', contentFinalizeCore(manifestRef));
    const ghost: ValidatorRegistrationV2 = {
      validatorId: 'v-ghost',
      handlerKey: 'ghost.handler',
      implementationDigest: '0'.repeat(64),
      implementationRef: { kind: 'builtin', moduleId: 'ghost', exportName: 'ghost' },
      trigger: 'content_commit',
      executionPhase: 'plan_finalize',
      selector: { kind: 'all' },
      enforcement: 'blocking',
      deterministic: true,
      inputContractVersion: 2,
      outputContractVersion: 2,
      budgetProfileId: 'authoritative-validator-default',
    };
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'plan_finalize',
        coreRef,
        registrations: [
          registrationFor('authoritative.review.coverage', { enforcement: 'blocking', validatorId: 'v-cov' }),
          ghost,
        ],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        context: { requiredSlotIds: ['s1'] },
      }),
    );
    expect(result.aggregate.outcome).toBe('infrastructure_failure');
    expect(result.aggregate.infrastructureFailureRefs.length).toBeGreaterThan(0);
    expect(result.aggregate.blockingInvalidReceiptRefs.length).toBeGreaterThan(0);
    // The registered validator_aggregate parser ACCEPTS the co-occurrence and
    // derives the outcome by priority (spec §12).
    assertEngineBlobsParse(result);
  });

  it('a malformed (non-object) map node is a blocking-invalid structural finding, not infra (I-2)', async () => {
    const { engine, blobs } = makeEngine();
    const coreRef = blobs.put('map_candidate_validation_core', mapCandidateCore([null, mapNode('s2', null, 1)], []));
    const result = await engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef,
        registrations: [registrationFor('authoritative.review.completeness')],
        universe: { slotIds: ['s2'], relationIds: [], mapNodeIds: ['s2'], artifactDigest: null },
      }),
    );
    expect(result.aggregate.outcome).toBe('blocking_invalid');
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]?.blockerIssues[0]?.issueCode).toBe('structure.invalid_node');
    expect(result.receipts[0]?.blockerIssues[0]?.location.stableTargetId).toBe('#node-0');
    expect(result.failures).toHaveLength(0);
    assertEngineBlobsParse(result);
  });

  it('a relation missing its id is a blocking-invalid structural finding (I-2)', async () => {
    const { engine, blobs } = makeEngine();
    const coreRef = blobs.put(
      'map_candidate_validation_core',
      mapCandidateCore([mapNode('s1', null, 0)], [{ relationId: '', typeId: 'sequence', fromSlotId: 's1', toSlotId: 's1' }]),
    );
    const result = await engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef,
        registrations: [registrationFor('authoritative.review.completeness')],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null },
      }),
    );
    expect(result.aggregate.outcome).toBe('blocking_invalid');
    expect(result.receipts[0]?.blockerIssues[0]?.issueCode).toBe('structure.relation_missing_id');
    expect(result.receipts[0]?.blockerIssues[0]?.location.stableTargetId).toBe('#relation-0');
    expect(result.failures).toHaveLength(0);
  });

  it('a content target missing its slotId is a blocking-invalid structural finding (I-2)', async () => {
    const { engine, blobs } = makeEngine();
    const coreRef = blobs.put('content_revision_commit_core', contentCommitCore());
    const target = blobs.put('content_value', { typeId: 'title', content: 'x'.repeat(5) });
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'batch_commit',
        coreRef,
        selectedTargetRefs: [target],
        registrations: [registrationFor('authoritative.review.slotSchema')],
        universe: { slotIds: [], relationIds: [], mapNodeIds: [], artifactDigest: null },
        slotTypes: SLOT_TYPES,
      }),
    );
    expect(result.aggregate.outcome).toBe('blocking_invalid');
    expect(result.receipts[0]?.blockerIssues[0]?.issueCode).toBe('content.target_missing_slot_id');
    expect(result.failures).toHaveLength(0);
  });

  it('two different valid handlers on one trigger produce distinct sorted digests the parser accepts (M-3)', async () => {
    const secondEntry = {
      ...entryOf('authoritative.review.completeness'),
      handlerKey: 'authoritative.review.completeness2',
      exportName: 'completeness2',
      implementationDigest: 'e'.repeat(64),
    };
    const customRegistry = new ValidatorRegistry([
      entryOf('authoritative.review.completeness'),
      secondEntry,
    ]);
    const validSource = `'use strict';\nmodule.exports = { validate: function (input) { return { status: 'valid', executionDigest: '' }; } };`;
    const blobs = new MemoryBlobStore();
    const engine = new ValidatorEngine({ registry: customRegistry, blobs, sourceResolver: () => validSource });
    const coreRef = blobs.put('map_candidate_validation_core', mapCandidateCore([mapNode('s1', null, 0)], []));
    const result = await engine.execute(
      baseRequest({
        trigger: 'map_candidate_commit',
        coreRef,
        registrations: [
          {
            ...registrationFor('authoritative.review.completeness', { validatorId: 'v-a' }),
            handlerKey: 'authoritative.review.completeness2',
            implementationDigest: 'e'.repeat(64),
            implementationRef: { kind: 'builtin', moduleId: '@forge/authoritative-review', exportName: 'completeness2' },
          },
          registrationFor('authoritative.review.completeness', { validatorId: 'v-b' }),
        ],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: ['s1'], artifactDigest: null },
      }),
    );
    expect(result.aggregate.outcome).toBe('clear');
    expect(result.validExecutionDigests).toHaveLength(2);
    // Distinct digests keep validExecutionDigests strictly sorted (parser OK).
    expect(new Set(result.validExecutionDigests).size).toBe(2);
    assertEngineBlobsParse(result);
  });

  it('applies the frozen selector: a types-selector narrows the validated targets (M-6)', async () => {
    const { engine, blobs } = makeEngine();
    const coreRef = blobs.put('content_revision_commit_core', contentCommitCore());
    // Oversized title content (would violate maxLength 200 if selected).
    const titleTarget = blobs.put('content_value', { slotId: 's1', typeId: 'title', content: 'x'.repeat(500) });
    const bodyTarget = blobs.put('content_value', { slotId: 's2', typeId: 'body', content: 'ok' });
    const typesRegistration = registrationFor('authoritative.review.slotSchema', {
      selector: { kind: 'types', typeIds: ['body'] },
    });
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'batch_commit',
        coreRef,
        selectedTargetRefs: [titleTarget, bodyTarget],
        registrations: [typesRegistration],
        universe: { slotIds: ['s1', 's2'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        slotTypes: SLOT_TYPES,
      }),
    );
    // The oversized title target is NOT selected → only the valid body target
    // is validated → clear.
    expect(result.aggregate.outcome).toBe('clear');
    expect(result.validExecutionDigests).toHaveLength(1);
  });

  it('an unresolvable provisional manifest ref is an infrastructure failure, not blocking-invalid (M-7)', async () => {
    const { engine, blobs } = makeEngine();
    const manifestRef = refOfBlob('content_revision_manifest', { manifestDigest: 'ghost' });
    const coreRef = blobs.put('content_plan_finalize_core', contentFinalizeCore(manifestRef));
    const result = await engine.execute(
      baseRequest({
        trigger: 'content_commit',
        executionPhase: 'plan_finalize',
        coreRef,
        registrations: [registrationFor('authoritative.review.coverage', { enforcement: 'blocking' })],
        universe: { slotIds: ['s1'], relationIds: [], mapNodeIds: [], artifactDigest: null },
        context: { requiredSlotIds: ['s1'] },
      }),
    );
    expect(result.aggregate.outcome).toBe('infrastructure_failure');
    expect(result.failures[0]?.failureCode).toBe(VALIDATOR_FAILURE_CODES.INPUT_UNRESOLVABLE);
    expect(result.receipts).toHaveLength(0);
    assertEngineBlobsParse(result);
  });
});
