// @vitest-environment node
/**
 * Task 13 tool-factory tests (spec §11.1/§11.2/§11.3, design §9/§11.9/§12.4):
 * exact per-session closed tool lists; verification-tool conditionality;
 * reviewer has NO write/Seal/Grant/finding-close tools; batch verdict tools
 * accept ordinary + constrained cross-scope finding drafts; whole sessions
 * alone get the whole-finding tool; every mutating schema requires
 * clientOperationId and forbids authority fields; mapPassed/treePassed/
 * sealApproved rejected; response-loss replay + same-ID/different-body conflict
 * per write family; the verification flow writes ONLY the attempt journal and
 * complete_review_assignment freezes facts + verifications atomically.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { disposeAllTestRoots, makeTempCorePaths } from '../../test-support';
import type { CorePaths } from '../../storage/core-paths';
import { AuthoritativeReviewPrivateStore } from '../../storage/authoritative-review-private-store';
import { fullProfileForTests } from '../../authoritative-review/object-schemas';
import { refOfBlob, parseBlob } from '../../authoritative-review/object-registry';
import type { AuthorityBaseSetV2, MapReviewRoundV2, ReviewRoundV2, WriteGrantSpecV2 } from '../../authoritative-review/authority-types';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { GrantService, signGrantInstance } from './grant-service';
import {
  V2ToolFactory,
  REVIEWER_FORBIDDEN_TOOLS,
  attemptIdFromNamespace,
  toolsForSessionKind,
  type FrozenReviewAssignmentV2,
} from './tool-factory';
import type { V2AttemptContext } from './attempt-coordinator';

afterEach(() => {
  disposeAllTestRoots();
});

const PROFILE = fullProfileForTests();

function ref(kind: string, salt: string): BlobRefV2 {
  const digest = canonicalJsonSha256({ kind, salt });
  return { kind: kind as BlobRefV2['kind'], digest, byteLength: digest.length, mediaType: 'application/json', schemaVersion: 1 };
}

function reviewSpec(roundKind: 'map' | 'content', sessionKind: string): WriteGrantSpecV2 {
  const body: Record<string, unknown> = {
    grantSpecId: 'gs-review',
    workItemId: 'wi-review',
    kind: 'review_observation',
    snapshotHash: '0'.repeat(64),
    authorityBaseRef: ref('authority_base_set', `base-${sessionKind}`),
    sessionKind,
    reviewAssignmentId: 'ra-1',
    roundId: 'round-1',
    roundKind,
    readScope: { maxContextBytes: 1_048_576 },
  };
  delete body.specDigest;
  return { ...body, specDigest: canonicalJsonSha256(body) } as WriteGrantSpecV2;
}

function generationSpec(): WriteGrantSpecV2 {
  const body: Record<string, unknown> = {
    grantSpecId: 'gs-gen',
    workItemId: 'wi-gen',
    kind: 'initial_generation_batch',
    snapshotHash: '0'.repeat(64),
    authorityBaseRef: ref('authority_base_set', 'base-gen'),
    generationPlanSpecRef: ref('generation_plan_spec', 'plan'),
    activeMapRef: ref('map_snapshot', 'map'),
    expectedContentRevisionManifestRef: ref('content_revision_manifest', 'manifest'),
    writeSlotIds: ['s-1', 's-2'],
    readScope: { maxContextBytes: 1_048_576 },
  };
  delete body.specDigest;
  return { ...body, specDigest: canonicalJsonSha256(body) } as WriteGrantSpecV2;
}

function structureSpec(): WriteGrantSpecV2 {
  const body: Record<string, unknown> = {
    grantSpecId: 'gs-structure',
    workItemId: 'wi-structure',
    kind: 'initial_structure_chunk',
    snapshotHash: '0'.repeat(64),
    authorityBaseRef: ref('authority_base_set', 'base-structure'),
    mapBuildSpecRef: ref('map_build_spec', 'plan'),
    expectedFrontierDigest: 'a'.repeat(64),
    structureChunkScope: { chunkOrdinal: 1, parentFrontierDigest: 'a'.repeat(64), maxNodes: 512, maxRelations: 64 },
  };
  delete body.specDigest;
  return { ...body, specDigest: canonicalJsonSha256(body) } as WriteGrantSpecV2;
}

function contentRound(verificationStages: string[], coverageSlotIds: string[] = ['s-1'], assignmentSlotIds?: string[], coverageRelationIds: string[] = []): ReviewRoundV2 {
  return {
    reviewRoundId: 'round-1',
    mapRef: ref('map_snapshot', 'map'),
    mapSemanticDigest: 'a'.repeat(64),
    contentRevisionManifestRef: ref('content_revision_manifest', 'manifest'),
    contentRootDigest: 'a'.repeat(64),
    reviewPolicyDigest: canonicalJsonSha256({ policy: 'test' }),
    coverageSlotIds,
    coverageRelationIds,
    assignmentSlotIds: assignmentSlotIds ?? coverageSlotIds,
    assignmentRelationIds: [],
    verificationFindingIds: verificationStages.map((s) => s.split(':')[0]),
    verificationFindingStages: verificationStages,
    assignmentIds: [],
    inheritedRecordRefs: [],
    wholeTreeObservationRefs: [],
    state: 'reviewing_batches',
    settlementRef: null,
  };
}

function mapRound(verificationStages: string[], coverageNodeIds: string[] = ['n-1']): MapReviewRoundV2 {
  return {
    mapReviewRoundId: 'round-1',
    candidateId: 'cand-1',
    candidateDigest: 'a'.repeat(64),
    contentRevisionManifestRef: null,
    contentRootDigest: null,
    reviewPolicyDigest: canonicalJsonSha256({ policy: 'test' }),
    coverageNodeIds,
    coverageRelationIds: [],
    assignmentIds: [],
    inheritedRecordRefs: [],
    wholeMapObservationRefs: [],
    verificationFindingStages: verificationStages,
    state: 'reviewing_batches',
    settlementRef: null,
  };
}

type Round = ReviewRoundV2 | MapReviewRoundV2;

interface Env {
  paths: CorePaths;
  taskId: string;
  store: AuthoritativeReviewPrivateStore;
  factory: V2ToolFactory;
  ctx: V2AttemptContext;
  published: Array<{ ledgerRef: BlobRefV2; eventId: string }>;
  frozen: FrozenReviewAssignmentV2[];
  refs: Map<string, unknown>;
  grantSpecRef: BlobRefV2;
}

function makeEnv(opts: {
  sessionKind: string;
  verificationStages?: string[];
  roundKind?: 'map' | 'content';
  findings?: Record<string, unknown>;
  workItemId?: string;
  dispatchRef?: BlobRefV2 | null;
  leaseEpoch?: number;
  coverageSlotIds?: string[];
  coverageNodeIds?: string[];
  assignmentSlotIds?: string[];
  coverageRelationIds?: string[];
  assignmentIds?: string[];
  resolveAssignmentTargets?: (ctx: V2AttemptContext) => Promise<readonly string[] | null>;
}): Env {
  const { paths } = makeTempCorePaths('forge-core-tool-factory-');
  const taskId = 'task-v2-tools';
  mkdirSync(paths.taskRoot(taskId), { recursive: true });
  const store = new AuthoritativeReviewPrivateStore(paths, taskId);
  const sessionKind = opts.sessionKind;
  const isReview = sessionKind.startsWith('review_');
  const roundKind = opts.roundKind ?? 'content';
  const workItemId = opts.workItemId ?? 'wi-review';
  const leaseEpoch = opts.leaseEpoch ?? 1;

  let spec: WriteGrantSpecV2;
  if (isReview) {
    spec = reviewSpec(roundKind, sessionKind);
  } else if (sessionKind === 'generation_batch' || sessionKind === 'content_repair') {
    spec = generationSpec();
  } else {
    spec = structureSpec();
  }

  const round: Round | null = roundKind === 'content'
    ? contentRound(opts.verificationStages ?? [], opts.coverageSlotIds, opts.assignmentSlotIds, opts.coverageRelationIds)
    : mapRound(opts.verificationStages ?? [], opts.coverageNodeIds);
  if (opts.assignmentIds !== undefined && round !== null) {
    (round as unknown as { assignmentIds: readonly string[] }).assignmentIds = [...opts.assignmentIds];
  }
  const planSpecRef = sessionKind === 'generation_batch' || sessionKind === 'content_repair'
    ? ref('generation_plan_spec', 'plan')
    : ref('map_build_spec', 'plan');
  const baseSet: AuthorityBaseSetV2 = {
    taskId,
    templateSnapshotRef: ref('profile_snapshot', 'tpl'),
    profileSnapshotRef: ref('profile_snapshot', 'profile'),
    mapRef: roundKind === 'content' ? ref('map_snapshot', 'map') : null,
    mapCandidateRef: roundKind === 'map' ? ref('map_candidate', 'cand') : null,
    mapReviewBundleRef: null,
    contentRevisionManifestRef: roundKind === 'content' ? ref('content_revision_manifest', 'manifest') : null,
    planSpecRef,
    stagingManifestRef: null,
    reviewCoverageCoreRef: null,
    reviewRoundRef: round !== null ? ref('review_bundle', 'round-blob') : null,
    reviewBundleRef: null,
    sealRecordRef: null,
    artifactRef: null,
    findingSetRef: null,
    artifactDeliveryRef: null,
    displayDigests: {},
    baseSetDigest: '',
  };

  const grantSpecRef = ref('write_grant_spec', `spec-${sessionKind}`);
  const baseRef = spec.authorityBaseRef;
  const roundBlobRef = ref('review_bundle', 'round-blob');

  const refs = new Map<string, unknown>();
  refs.set(grantSpecRef.digest, spec);
  refs.set(baseRef.digest, baseSet);
  if (round !== null) refs.set(roundBlobRef.digest, round);

  // Write sessions need a lease-bound GrantInstance in the dispatch.
  let dispatchRef = opts.dispatchRef ?? null;
  if (!isReview && dispatchRef === null) {
    const instance = signGrantInstance({
      grantSpecRef,
      workItemId,
      leaseEpoch,
      boundAttemptId: 'att-1',
      agentId: 'agent-a',
      grantInstanceId: 'gi-1',
    });
    const instanceRef = ref('grant_instance', 'gi-1');
    refs.set(instanceRef.digest, instance);
    const dispatch = { dispatchId: 'd-1', workItemId, grantInstanceRef: instanceRef };
    dispatchRef = ref('assignment_dispatch', 'dispatch-1');
    refs.set(dispatchRef.digest, dispatch);
  }

  const projection = {
    workItems: { [workItemId]: { grantSpecRef, authorityBaseRef: baseRef, state: 'leased' } },
    activeLease: { workItemId, leaseEpoch, attemptId: 'att-1', commandId: null, leaseOwner: 'agent-a' },
    findings: opts.findings ?? {},
  };

  const grants = new GrantService({
    resolver: (_task, r) => refs.get(r.digest) ?? null,
    readProjection: async () => projection as never,
    profile: PROFILE,
  });

  const published: Env['published'] = [];
  const frozen: FrozenReviewAssignmentV2[] = [];
  let ctxRef: V2AttemptContext | null = null;
  const factory = new V2ToolFactory({
    grants,
    privateStore: store,
    profile: PROFILE,
    readProjection: async () => projection as never,
    resolver: (_task, r) => refs.get(r.digest) ?? null,
    contextResolver: async (_task, wi, attemptId, agentId) => {
      if (ctxRef !== null && ctxRef.workItemId === wi && ctxRef.attemptId === attemptId && ctxRef.agentId === agentId) return ctxRef;
      return null;
    },
    resolveAssignmentTargets: opts.resolveAssignmentTargets,
    handlers: {
      read: async () => ({ ok: true, tool: 'read' }),
      appendMapCandidateChunk: async () => ({ accepted: true }),
      finishMapBuild: async () => ({ proposed: true }),
      submitMapPatch: async () => ({ stagingRoot: 'root-1' }),
      writeSlotContent: async () => ({ written: true }),
      submitContentDraft: async () => ({ committed: true }),
      requestScopeExpansion: async () => ({ successor: 'plan-r2' }),
    },
    freezeReviewAssignment: async (taskId, freeze) => {
      // I-4: the seam is IDEMPOTENT — the ledger ref is the content address of
      // the frozen ledger, so re-invocation (crash-window replay) is a no-op
      // for the same freeze and never produces a second distinct ledger.
      const ledgerRef = refOfBlob('review_assignment_ledger', freeze.ledger);
      if (!published.some((p) => p.ledgerRef.digest === ledgerRef.digest)) {
        published.push({ ledgerRef, eventId: `evt-${published.length}` });
        frozen.push(freeze);
      }
      return { ledgerRef, eventId: `evt-${published.length - 1}` };
    },
  });

  const ctx: V2AttemptContext = {
    taskId,
    workItemId,
    attemptId: 'att-1',
    leaseEpoch,
    namespace: `structured/${sessionKind}/${workItemId}/att-1`,
    agentId: 'agent-a',
    roleBinding: isReview ? 'reviewer' : 'orchestrator',
    executionKind: 'structured',
    sessionKind,
    dispatchRef,
    authorityBaseRef: baseRef,
    grantInstanceRef: null,
    inputArtifactDeliveryId: null,
    agent: null,
    currentAssignmentText: '',
    committedCheckpointText: '',
  };
  ctxRef = ctx;

  return { paths, taskId, store, factory, ctx, published, frozen, refs, grantSpecRef };
}

function toolNames(tools: readonly { name: string }[]): string[] {
  return tools.map((t) => t.name);
}

/** Runs a tool and returns its structured details (typed for assertions). */
async function runTool(
  tool: { execute: (...args: any[]) => Promise<{ details: unknown }> },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; code: string | null; data: unknown }> {
  const result = await tool.execute('tc-1', params, new AbortController().signal, undefined, undefined);
  return result.details as { ok: boolean; code: string | null; data: unknown };
}

describe('per-session closed tool lists (spec §11.1/§11.2/§11.3)', () => {
  it('structure_chunk gets ONLY the build tools; map_repair gets the repair tools', async () => {
    const structure = await makeEnv({ sessionKind: 'structure_chunk' }).factory.toolsFor(makeEnv({ sessionKind: 'structure_chunk' }).ctx);
    expect(toolNames(structure)).toEqual(['read_structure_contract', 'read_map_build_frontier', 'append_map_candidate_chunk', 'finish_map_build']);
    const repair = makeEnv({ sessionKind: 'map_repair' });
    const repairTools = await repair.factory.toolsFor(repair.ctx);
    expect(toolNames(repairTools)).toEqual(['read_active_map', 'read_slot_content', 'read_map_repair_staging', 'submit_map_patch', 'request_scope_expansion']);
  });

  it('generation_batch/content_repair get exactly the generator tools', async () => {
    for (const sessionKind of ['generation_batch', 'content_repair'] as const) {
      const env = makeEnv({ sessionKind });
      const tools = await env.factory.toolsFor(env.ctx);
      expect(toolNames(tools)).toEqual(['read_active_map', 'read_slot_content', 'read_related_context', 'write_slot_content', 'submit_content_draft', 'request_scope_expansion']);
    }
  });

  it('review_map_batch gets node/relation verdicts + conditional verification + complete', async () => {
    const env = makeEnv({ sessionKind: 'review_map_batch', roundKind: 'map', verificationStages: ['f-1:map'] });
    const tools = await env.factory.toolsFor(env.ctx);
    expect(toolNames(tools)).toEqual(['read_map_candidate', 'submit_map_node_review', 'submit_map_relation_review', 'submit_finding_verification', 'complete_review_assignment']);
  });

  it('review_map_whole gets the whole-map finding tool, NOT the batch verdict tools', async () => {
    const env = makeEnv({ sessionKind: 'review_map_whole', roundKind: 'map', verificationStages: ['f-1:map'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const names = toolNames(tools);
    expect(names).toContain('submit_map_whole_finding');
    expect(names).not.toContain('submit_map_node_review');
    expect(names).not.toContain('submit_map_relation_review');
    expect(names).not.toContain('submit_slot_review');
  });

  it('review_content_batch and review_content_whole get the content reviewer surface; whole alone gets the whole-tree tool', async () => {
    const batch = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: ['f-1:content'] });
    const batchNames = toolNames(await batch.factory.toolsFor(batch.ctx));
    expect(batchNames).toEqual(['read_active_map', 'read_slot_content', 'read_relation_context', 'submit_slot_review', 'submit_relation_review', 'submit_finding_verification', 'complete_review_assignment']);
    expect(batchNames).not.toContain('submit_whole_tree_finding');

    const whole = await makeEnv({ sessionKind: 'review_content_whole', verificationStages: ['f-1:content'] });
    const wholeNames = toolNames(await whole.factory.toolsFor(whole.ctx));
    expect(wholeNames).toContain('submit_whole_tree_finding');
    expect(wholeNames).not.toContain('submit_slot_review');
    expect(wholeNames).not.toContain('submit_relation_review');
  });

  it('submit_finding_verification is present ONLY when the frozen assignment contains verification targets', async () => {
    const withTargets = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: ['f-1:content'] });
    expect(toolNames(await withTargets.factory.toolsFor(withTargets.ctx))).toContain('submit_finding_verification');
    const withoutTargets = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: [] });
    expect(toolNames(await withoutTargets.factory.toolsFor(withoutTargets.ctx))).not.toContain('submit_finding_verification');
  });

  it('reviewers NEVER receive Map/content write, Seal, Grant, free-standing submit_finding, or Finding-close tools', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_whole', verificationStages: ['f-1:content'] });
    const names = toolNames(await env.factory.toolsFor(env.ctx));
    for (const forbidden of [...REVIEWER_FORBIDDEN_TOOLS]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('the generic submitter receives NO structured tools', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: [] });
    const tools = await env.factory.toolsFor({ ...env.ctx, sessionKind: null });
    expect(tools).toEqual([]);
  });

  it('tool paging budgets bound read limits by the profile', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: [] });
    const tools = await env.factory.toolsFor(env.ctx);
    const read = tools.find((t) => t.name === 'read_active_map');
    expect(read).toBeDefined();
    // The factory clamps limit to assignmentMaxPrimaryTargets (256).
    expect(read?.parameters).toBeDefined();
  });
});

describe('mutating tool schemas (exact body, authority-free, idempotent)', () => {
  it('every mutating schema requires clientOperationId and FORBIDS task/path/grant/lease/attempt/authority fields', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: ['f-1:content'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const mutating = tools.filter((t) => !t.name.startsWith('read_') && t.name !== 'complete_review_assignment' || t.name === 'complete_review_assignment');
    for (const tool of mutating) {
      const schema = tool.parameters;
      // Legal body passes.
      const body = legalBody(tool.name);
      expect(Value.Check(schema, body), `schema of ${tool.name} should accept ${JSON.stringify(body)}`).toBe(true);
      // Missing clientOperationId fails.
      const noCoId = { ...body };
      delete noCoId.clientOperationId;
      expect(Value.Check(schema, noCoId), `schema of ${tool.name} should require clientOperationId`).toBe(false);
      // Authority fields are unknown → rejected.
      const withAuthority = { ...body, taskId: 'task-1', attemptId: 'att-1', leaseEpoch: 1, authorityBaseRef: 'x', grantInstanceRef: 'y', path: '/x' };
      expect(Value.Check(schema, withAuthority), `schema of ${tool.name} should reject authority fields`).toBe(false);
    }
  });

  it('rejects mapPassed / treePassed / sealApproved outputs on verdict tools', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: [] });
    const tools = await env.factory.toolsFor(env.ctx);
    const verdict = tools.find((t) => t.name === 'submit_slot_review');
    expect(verdict).toBeDefined();
    for (const bad of ['mapPassed', 'treePassed', 'sealApproved']) {
      expect(Value.Check(verdict!.parameters, { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'op-1', [bad]: true })).toBe(false);
    }
  });

  it('batch verdict tools accept ordinary anchored findingDrafts AND constrained crossScopeFindingDrafts', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: [] });
    const tools = await env.factory.toolsFor(env.ctx);
    const verdict = tools.find((t) => t.name === 'submit_slot_review');
    expect(verdict).toBeDefined();
    const body = {
      targetId: 's-1',
      verdict: 'reject',
      evidence: ['public evidence'],
      findingDrafts: [
        { clientFindingKey: 'k-1', defectClass: 'content', severity: 'blocking', primaryLocation: { kind: 'slot', id: 's-1' }, evidence: ['e'] },
      ],
      crossScopeFindingDrafts: [
        { clientFindingKey: 'k-2', primaryTarget: 's-9', defectClass: 'content', severity: 'blocking', evidence: ['e'] },
      ],
      clientOperationId: 'op-1',
    };
    expect(Value.Check(verdict!.parameters, body)).toBe(true);
  });

  it('submit_finding_verification exact body is only findingId/repairStage/verdict/evidence/clientOperationId', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: ['f-1:content'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const verify = tools.find((t) => t.name === 'submit_finding_verification');
    expect(verify).toBeDefined();
    expect(Value.Check(verify!.parameters, { findingId: 'f-1', repairStage: 'content', verdict: 'resolved', evidence: ['e'], clientOperationId: 'op-1' })).toBe(true);
    expect(Value.Check(verify!.parameters, { findingId: 'f-1', repairStage: 'content', verdict: 'approved', evidence: [], clientOperationId: 'op-1' })).toBe(false);
    expect(Value.Check(verify!.parameters, { findingId: 'f-1', repairStage: 'content', verdict: 'resolved', evidence: [], clientOperationId: 'op-1', taskId: 't' })).toBe(false);
  });

  it('complete_review_assignment schema is only clientOperationId', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: ['f-1:content'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const complete = tools.find((t) => t.name === 'complete_review_assignment');
    expect(complete).toBeDefined();
    expect(Value.Check(complete!.parameters, { clientOperationId: 'op-1' })).toBe(true);
    expect(Value.Check(complete!.parameters, {})).toBe(false);
  });
});

function legalBody(name: string): Record<string, unknown> {
  switch (name) {
    case 'submit_map_node_review':
      return { targetId: 'n-1', verdict: 'pass', evidence: [], clientOperationId: 'op-1' };
    case 'submit_map_relation_review':
      return { targetId: 'r-1', verdict: 'satisfied', evidence: [], clientOperationId: 'op-1' };
    case 'submit_slot_review':
      return { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'op-1' };
    case 'submit_relation_review':
      return { targetId: 'r-1', verdict: 'satisfied', evidence: [], clientOperationId: 'op-1' };
    case 'submit_map_whole_finding':
      return { findingDraft: { clientFindingKey: 'k', defectClass: 'map', severity: 'blocking', primaryLocation: { kind: 'map_node', id: 'n-1' }, evidence: [] }, clientOperationId: 'op-1' };
    case 'submit_whole_tree_finding':
      return { findingDraft: { clientFindingKey: 'k', defectClass: 'content', severity: 'blocking', primaryLocation: { kind: 'slot', id: 's-1' }, evidence: [] }, clientOperationId: 'op-1' };
    case 'submit_finding_verification':
      return { findingId: 'f-1', repairStage: 'content', verdict: 'resolved', evidence: [], clientOperationId: 'op-1' };
    case 'complete_review_assignment':
      return { clientOperationId: 'op-1' };
    case 'append_map_candidate_chunk':
      return { ordinal: 0, expectedFrontierDigest: 'a'.repeat(64), nodes: [{ slotId: 'n-1', slotType: 'doc', contentBearing: false }], relations: [], clientOperationId: 'op-1' };
    case 'finish_map_build':
      return { expectedChunkCount: 1, expectedFrontierDigest: 'a'.repeat(64), expectedRootCount: 1, clientOperationId: 'op-1' };
    case 'submit_map_patch':
      return { expectedStagingDigest: 'a'.repeat(64), operations: [], clientOperationId: 'op-1' };
    case 'write_slot_content':
      return { slotId: 's-1', value: 'content', clientOperationId: 'op-1' };
    case 'submit_content_draft':
      return { expectedManifestDigest: 'a'.repeat(64), clientOperationId: 'op-1' };
    case 'request_scope_expansion':
      return { findingIds: [], requestedNodeIds: [], requestedRelationIds: [], reason: 'why', clientOperationId: 'op-1' };
    default:
      return { clientOperationId: 'op-1' };
  }
}

describe('response-loss replay and conflict (per write family)', () => {
  it('review submission replays on same operation+body and conflicts on different body', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: [] });
    const tools = await env.factory.toolsFor(env.ctx);
    const submit = tools.find((t) => t.name === 'submit_slot_review')!;
    const params = { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'op-1' };
    expect((await runTool(submit, params)).ok).toBe(true);
    expect((await runTool(submit, params)).ok).toBe(true);
    const conflict = await runTool(submit, { ...params, verdict: 'reject' });
    expect(conflict.ok).toBe(false);
    expect(conflict.code).toBe('OPERATION_CONFLICT');
  });

  it('a domain write (write_slot_content) replays and conflicts identically', async () => {
    const env = await makeEnv({ sessionKind: 'generation_batch' });
    const tools = await env.factory.toolsFor(env.ctx);
    const write = tools.find((t) => t.name === 'write_slot_content')!;
    const params = { slotId: 's-1', value: 'hello', clientOperationId: 'op-w1' };
    expect((await runTool(write, params)).ok).toBe(true);
    expect((await runTool(write, params)).ok).toBe(true);
    const conflict = await runTool(write, { slotId: 's-1', value: 'different', clientOperationId: 'op-w1' });
    expect(conflict.code).toBe('OPERATION_CONFLICT');
  });

  it('a chunk write replays and conflicts per clientOperationId', async () => {
    const env = await makeEnv({ sessionKind: 'structure_chunk' });
    const tools = await env.factory.toolsFor(env.ctx);
    const chunk = tools.find((t) => t.name === 'append_map_candidate_chunk')!;
    const body = { ordinal: 0, expectedFrontierDigest: 'a'.repeat(64), nodes: [{ slotId: 'n-1', slotType: 'doc', contentBearing: false }], relations: [], clientOperationId: 'op-c1' };
    expect((await runTool(chunk, body)).ok).toBe(true);
    expect((await runTool(chunk, body)).ok).toBe(true);
    const conflict = await runTool(chunk, { ...body, ordinal: 1 });
    expect(conflict.code).toBe('OPERATION_CONFLICT');
  });

  it('complete_review_assignment replays the SAME freeze on response loss', async () => {
    const env = await makeEnv({
      sessionKind: 'review_content_batch',
      verificationStages: ['f-1:content'],
      findings: {
        'f-1': { findingId: 'f-1', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-1' }, defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
      },
    });
    const tools = await env.factory.toolsFor(env.ctx);
    await runTool(tools.find((t) => t.name === 'submit_slot_review')!, { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'v-1' });
    await runTool(tools.find((t) => t.name === 'submit_finding_verification')!, { findingId: 'f-1', repairStage: 'content', verdict: 'resolved', evidence: ['e'], clientOperationId: 'v-2' });
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    const done = await runTool(complete, { clientOperationId: 'v-3' });
    expect(done.ok).toBe(true);
    expect(env.published).toHaveLength(1);
    const replay = await runTool(complete, { clientOperationId: 'v-3' });
    expect(replay.ok).toBe(true);
    expect(env.published).toHaveLength(1); // no second publication
  });

  it('collectResultRefs folds the completed ledger ref (gated review completion is not bare)', async () => {
    const env = await makeEnv({
      sessionKind: 'review_content_batch',
      verificationStages: ['f-1:content'],
      findings: {
        'f-1': { findingId: 'f-1', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-1' }, defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
      },
    });
    const tools = await env.factory.toolsFor(env.ctx);
    await runTool(tools.find((t) => t.name === 'submit_slot_review')!, { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'v-1' });
    await runTool(tools.find((t) => t.name === 'submit_finding_verification')!, { findingId: 'f-1', repairStage: 'content', verdict: 'resolved', evidence: ['e'], clientOperationId: 'v-2' });
    await runTool(tools.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'v-3' });
    const resultRefs = await env.factory.collectResultRefs(env.ctx);
    expect(resultRefs).toHaveLength(1);
    expect(resultRefs[0].kind).toBe('review_assignment_ledger');
    expect(resultRefs[0].digest).toBe(env.published[0].ledgerRef.digest);
  });
});

describe('verification flow (spec §11.3, design §11.9)', () => {
  function reviewEnv(verificationStages: string[], findings: Record<string, unknown>) {
    return makeEnv({ sessionKind: 'review_content_batch', verificationStages, findings });
  }

  it('submit_finding_verification writes ONLY the current attempt private review journal', async () => {
    const env = reviewEnv(['f-1:content'], {
      'f-1': { findingId: 'f-1', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-1' }, defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
    });
    const tools = await env.factory.toolsFor(env.ctx);
    const verify = tools.find((t) => t.name === 'submit_finding_verification')!;
    const result = await runTool(verify, { findingId: 'f-1', repairStage: 'content', verdict: 'resolved', evidence: ['e'], clientOperationId: 'op-v1' });
    expect(result.ok).toBe(true);
    // The journal now contains the verification record and NO published ledger.
    const journal = await env.store.readAllReviewDraft({
      workItemId: env.ctx.workItemId,
      leaseEpoch: 1,
      attemptId: 'att-1',
      authorityBaseRef: env.ctx.authorityBaseRef,
      grantSpecRef: env.grantSpecRef,
    });
    expect(journal.committed.some((e) => e.op === 'submit_finding_verification')).toBe(true);
    expect(env.published).toHaveLength(0);
  });

  it('MAP session: one reachable and one forbidden verification case (map stage)', async () => {
    const env = makeEnv({
      sessionKind: 'review_map_batch',
      roundKind: 'map',
      verificationStages: ['f-map:map'],
      findings: {
        'f-map': { findingId: 'f-map', reviewContext: { kind: 'map', roundId: 'round-1' }, primaryLocation: { kind: 'map_node', id: 'n-1' }, defectClass: 'map', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['map'], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
        'f-map-sys': { findingId: 'f-map-sys', reviewContext: { kind: 'map', roundId: 'round-1' }, primaryLocation: { kind: 'map_node', id: 'n-2' }, defectClass: 'map', severity: 'blocking', source: 'system_validator', state: 'addressed', addressStages: ['map'], verifiedStages: [], openedBy: { kind: 'system_validator', validatorExecutionId: 'v-9' } },
      },
    });
    const tools = await env.factory.toolsFor(env.ctx);
    const verify = tools.find((t) => t.name === 'submit_finding_verification')!;
    expect(verify).toBeDefined();
    // Reachable: reviewer-sourced addressed map finding at the frozen map stage.
    const reachable = await runTool(verify, { findingId: 'f-map', repairStage: 'map', verdict: 'resolved', evidence: ['e'], clientOperationId: 'op-map-1' });
    expect(reachable.ok).toBe(true);
    // Forbidden: system-validator source.
    const forbidden = await runTool(verify, { findingId: 'f-map-sys', repairStage: 'map', verdict: 'resolved', evidence: [], clientOperationId: 'op-map-2' });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.code).toBe('VERIFICATION_REJECTED');
  });

  it('WHOLE content session: one reachable and one forbidden verification case', async () => {
    const env = makeEnv({
      sessionKind: 'review_content_whole',
      verificationStages: ['f-1:content'],
      coverageSlotIds: ['s-1'],
      findings: {
        'f-1': { findingId: 'f-1', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-1' }, defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
        'f-open': { findingId: 'f-open', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-2' }, defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'open', addressStages: [], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
      },
    });
    const tools = await env.factory.toolsFor(env.ctx);
    const verify = tools.find((t) => t.name === 'submit_finding_verification')!;
    expect(verify).toBeDefined();
    // Reachable: the frozen addressed stage of a reviewer finding.
    const reachable = await runTool(verify, { findingId: 'f-1', repairStage: 'content', verdict: 'resolved', evidence: ['e'], clientOperationId: 'op-w1' });
    expect(reachable.ok).toBe(true);
    // Forbidden: non-addressed finding.
    const forbidden = await runTool(verify, { findingId: 'f-open', repairStage: 'content', verdict: 'resolved', evidence: [], clientOperationId: 'op-w2' });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.code).toBe('VERIFICATION_REJECTED');
  });

  it('WHOLE map session: one reachable and one forbidden verification case', async () => {
    const env = makeEnv({
      sessionKind: 'review_map_whole',
      roundKind: 'map',
      verificationStages: ['f-map:map'],
      coverageNodeIds: ['n-1'],
      findings: {
        'f-map': { findingId: 'f-map', reviewContext: { kind: 'map', roundId: 'round-1' }, primaryLocation: { kind: 'map_node', id: 'n-1' }, defectClass: 'map', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['map'], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
        'f-sys': { findingId: 'f-sys', reviewContext: { kind: 'map', roundId: 'round-1' }, primaryLocation: { kind: 'map_node', id: 'n-2' }, defectClass: 'map', severity: 'blocking', source: 'system_validator', state: 'addressed', addressStages: ['map'], verifiedStages: [], openedBy: { kind: 'system_validator', validatorExecutionId: 'v-9' } },
      },
    });
    const tools = await env.factory.toolsFor(env.ctx);
    const verify = tools.find((t) => t.name === 'submit_finding_verification')!;
    expect(verify).toBeDefined();
    const reachable = await runTool(verify, { findingId: 'f-map', repairStage: 'map', verdict: 'still_present', evidence: ['e'], clientOperationId: 'op-w3' });
    expect(reachable.ok).toBe(true);
    const forbidden = await runTool(verify, { findingId: 'f-sys', repairStage: 'map', verdict: 'resolved', evidence: [], clientOperationId: 'op-w4' });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.code).toBe('VERIFICATION_REJECTED');
  });

  it('rejects oversized evidence payloads against the profile evidence byte caps', async () => {
    const env = reviewEnv([], {});
    const tools = await env.factory.toolsFor(env.ctx);
    const submit = tools.find((t) => t.name === 'submit_slot_review')!;
    const oversizeItem = await runTool(submit, { targetId: 's-1', verdict: 'pass', evidence: ['x'.repeat(PROFILE.evidenceMaxBytesPerItem + 1)], clientOperationId: 'op-e1' });
    expect(oversizeItem.ok).toBe(false);
    expect(oversizeItem.code).toBe('PAYLOAD_LIMIT_EXCEEDED');
    const manyItems = await runTool(submit, { targetId: 's-2', verdict: 'pass', evidence: Array.from({ length: 3 }, () => 'y'.repeat(PROFILE.evidenceMaxBytesTotal / 2 + 1)), clientOperationId: 'op-e2' });
    expect(manyItems.ok).toBe(false);
    expect(manyItems.code).toBe('PAYLOAD_LIMIT_EXCEEDED');
  });

  it('rejects stale/non-addressed/system-validator/wrong-stage/non-target verification without any journal write', async () => {
    const env = reviewEnv(['f-1:content'], {
      'f-1': { findingId: 'f-1', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-1' }, defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
      'f-sys': { findingId: 'f-sys', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-2' }, defectClass: 'content', severity: 'blocking', source: 'system_validator', state: 'addressed', addressStages: ['content'], verifiedStages: [], openedBy: { kind: 'system_validator', validatorExecutionId: 'v-9' } },
      'f-open': { findingId: 'f-open', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-3' }, defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'open', addressStages: [], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
      'f-other': { findingId: 'f-other', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-4' }, defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
    });
    const tools = await env.factory.toolsFor(env.ctx);
    const verify = tools.find((t) => t.name === 'submit_finding_verification')!;
    // system-validator source → rejected.
    const sysResult = await runTool(verify, { findingId: 'f-sys', repairStage: 'content', verdict: 'resolved', evidence: [], clientOperationId: 'op-sys' });
    expect(sysResult.ok).toBe(false);
    expect(sysResult.code).toBe('VERIFICATION_REJECTED');
    // non-addressed (open) → rejected.
    const openResult = await runTool(verify, { findingId: 'f-open', repairStage: 'content', verdict: 'resolved', evidence: [], clientOperationId: 'op-open' });
    expect(openResult.ok).toBe(false);
    // wrong stage (map while content is the addressed stage) → rejected.
    const wrongStage = await runTool(verify, { findingId: 'f-1', repairStage: 'map', verdict: 'resolved', evidence: [], clientOperationId: 'op-ws' });
    expect(wrongStage.ok).toBe(false);
    // not a frozen verification target of this round → rejected.
    const notTarget = await runTool(verify, { findingId: 'f-other', repairStage: 'content', verdict: 'resolved', evidence: [], clientOperationId: 'op-nt' });
    expect(notTarget.ok).toBe(false);
    // ZERO ledger publications and ZERO journal records happened for rejections.
    expect(env.published).toHaveLength(0);
    const journal = await env.store.readAllReviewDraft({
      workItemId: env.ctx.workItemId,
      leaseEpoch: 1,
      attemptId: 'att-1',
      authorityBaseRef: env.ctx.authorityBaseRef,
      grantSpecRef: env.grantSpecRef,
    });
    expect(journal.committed).toEqual([]);
  });

  it('complete_review_assignment freezes facts + verifications together and rejects incomplete without partial publication', async () => {
    const env = reviewEnv(['f-1:content'], {
      'f-1': { findingId: 'f-1', reviewContext: { kind: 'content', roundId: 'round-1' }, primaryLocation: { kind: 'slot', id: 's-1' }, defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [], openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-1' } },
    });
    const tools = await env.factory.toolsFor(env.ctx);
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    // Missing the ordinary target verdict → completion rejects.
    const missing = await runTool(complete, { clientOperationId: 'op-c1' });
    expect(missing.ok).toBe(false);
    expect(env.published).toHaveLength(0);
    // Submit the ordinary verdict.
    const submit = tools.find((t) => t.name === 'submit_slot_review')!;
    await runTool(submit, { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'op-v1' });
    // Missing the verification target → still incomplete.
    const missingVerification = await runTool(complete, { clientOperationId: 'op-c2' });
    expect(missingVerification.ok).toBe(false);
    expect(env.published).toHaveLength(0);
    // Submit the verification.
    const verify = tools.find((t) => t.name === 'submit_finding_verification')!;
    await runTool(verify, { findingId: 'f-1', repairStage: 'content', verdict: 'resolved', evidence: ['e'], clientOperationId: 'op-v2' });
    // Now completion freezes facts + verifications in ONE ledger.
    const done = await runTool(complete, { clientOperationId: 'op-c3' });
    expect(done.ok).toBe(true);
    expect(env.published).toHaveLength(1);
    expect(env.published[0].ledgerRef.kind).toBe('review_assignment_ledger');
    const journal = await env.store.readAllReviewDraft({
      workItemId: env.ctx.workItemId,
      leaseEpoch: 1,
      attemptId: 'att-1',
      authorityBaseRef: env.ctx.authorityBaseRef,
      grantSpecRef: env.grantSpecRef,
    });
    expect(journal.complete).toBe(true);
  });
});

describe('fix round 1 regression tests (I-1..I-4, M-5, M-6)', () => {
  it('I-1: review_content_whole completes via its whole-finding record (no ordinary verdicts required)', async () => {
    const env = makeEnv({
      sessionKind: 'review_content_whole',
      verificationStages: [],
      coverageSlotIds: ['s-1', 's-2', 's-3'],
    });
    const tools = await env.factory.toolsFor(env.ctx);
    const whole = tools.find((t) => t.name === 'submit_whole_tree_finding')!;
    const done = await runTool(whole, {
      findingDraft: { clientFindingKey: 'wk-1', defectClass: 'content', severity: 'blocking', primaryLocation: { kind: 'slot', id: 's-3' }, evidence: ['whole-tree issue'] },
      anchoredVerdict: { targetId: 's-3', verdict: 'reject', evidence: ['e'] },
      clientOperationId: 'w-1',
    });
    expect(done.ok).toBe(true);
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    const finished = await runTool(complete, { clientOperationId: 'w-2' });
    expect(finished.ok).toBe(true);
    expect(env.published).toHaveLength(1);
    const journal = await env.store.readAllReviewDraft({ workItemId: env.ctx.workItemId, leaseEpoch: 1, attemptId: 'att-1', authorityBaseRef: env.ctx.authorityBaseRef, grantSpecRef: env.grantSpecRef });
    expect(journal.complete).toBe(true);
  });

  it('I-1: review_map_whole completes via submit_map_whole_finding (never the batch verdict path)', async () => {
    const env = makeEnv({ sessionKind: 'review_map_whole', roundKind: 'map', verificationStages: [], coverageNodeIds: ['n-1', 'n-2'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const whole = tools.find((t) => t.name === 'submit_map_whole_finding')!;
    await runTool(whole, {
      findingDraft: { clientFindingKey: 'wk-1', defectClass: 'map', severity: 'blocking', primaryLocation: { kind: 'map_node', id: 'n-3' }, evidence: ['map issue'] },
      clientOperationId: 'w-1',
    });
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    const finished = await runTool(complete, { clientOperationId: 'w-2' });
    expect(finished.ok).toBe(true);
    expect(env.published).toHaveLength(1);
  });

  it('I-2: partial ordinary coverage cannot complete — EXACT round coverage is required', async () => {
    const env = makeEnv({ sessionKind: 'review_content_batch', verificationStages: [], coverageSlotIds: ['s-1', 's-2'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const submit = tools.find((t) => t.name === 'submit_slot_review')!;
    await runTool(submit, { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'v-1' });
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    const result = await runTool(complete, { clientOperationId: 'v-2' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REVIEW_ASSIGNMENT_INCOMPLETE');
    expect(env.published).toHaveLength(0);
    // Complete the second target → freeze succeeds.
    await runTool(submit, { targetId: 's-2', verdict: 'pass', evidence: [], clientOperationId: 'v-3' });
    const done = await runTool(complete, { clientOperationId: 'v-4' });
    expect(done.ok).toBe(true);
    expect(env.published).toHaveLength(1);
  });

  it('I-2: an unassigned target verdict cannot freeze (server proves the source target is assigned)', async () => {
    const env = makeEnv({ sessionKind: 'review_content_batch', verificationStages: [], coverageSlotIds: ['s-1'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const submit = tools.find((t) => t.name === 'submit_slot_review')!;
    // s-9 is NOT in the round's frozen ordinary coverage.
    await runTool(submit, { targetId: 's-9', verdict: 'pass', evidence: [], clientOperationId: 'v-1' });
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    const result = await runTool(complete, { clientOperationId: 'v-2' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REVIEW_ASSIGNMENT_INCOMPLETE');
    expect(env.published).toHaveLength(0);
  });

  it('I-3: finding drafts + evidence + cross-scope routing obligations are frozen', async () => {
    const env = makeEnv({ sessionKind: 'review_content_batch', verificationStages: [], coverageSlotIds: ['s-1', 's-2', 's-3'], assignmentSlotIds: ['s-1', 's-2'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const submit = tools.find((t) => t.name === 'submit_slot_review')!;
    await runTool(submit, {
      targetId: 's-1',
      verdict: 'reject',
      evidence: ['public evidence'],
      findingDrafts: [
        { clientFindingKey: 'k-1', defectClass: 'content', severity: 'blocking', primaryLocation: { kind: 'slot', id: 's-1' }, evidence: ['draft evidence'] },
      ],
      crossScopeFindingDrafts: [
        { clientFindingKey: 'k-2', primaryTarget: 's-2', primaryTargetKind: 'slot', defectClass: 'content', severity: 'blocking', evidence: ['cross evidence'] },
        { clientFindingKey: 'k-3', primaryTarget: 's-3', primaryTargetKind: 'slot', defectClass: 'content', severity: 'blocking', evidence: ['cross unreviewed'] },
      ],
      clientOperationId: 'v-1',
    });
    await runTool(submit, { targetId: 's-2', verdict: 'pass', evidence: [], clientOperationId: 'v-2' });
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    const done = await runTool(complete, { clientOperationId: 'v-3' });
    expect(done.ok).toBe(true);
    expect(env.published).toHaveLength(1);
    const freeze = env.frozen[0];
    expect(freeze.findingDraftRefs.length).toBe(3); // k-1 ordinary + k-2 + k-3 cross-scope
    // The s-1 fact carries its finding id + the public evidence.
    const s1Fact = freeze.facts.find((f) => f.targetStableId === 's-1')!;
    expect(s1Fact.findingIds).toHaveLength(1);
    expect(s1Fact.evidence).toHaveLength(1);
    expect(s1Fact.evidence[0].text).toBe('public evidence');
    expect(s1Fact.localSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(s1Fact.localContextDigest).toMatch(/^[0-9a-f]{64}$/);
    // Cross-scope routing obligations: s-2 is reviewed-here (whole-decision);
    // s-3 is in the baseline but NOT reviewed by this assignment → deterministic
    // successor. The materialized cross-scope findings carry the correct
    // primaryLocation kind (FIX-M1): both are slots.
    const obligations = freeze.routingObligations;
    expect(obligations.map((o) => `${o.primaryTarget}:${o.routing}`).sort()).toEqual([
      's-2:reviewed_primary_whole_decision',
      's-3:unreviewed_primary',
    ]);
    const crossFindings = freeze.findings.filter((f) => f.primaryLocation.id === 's-2' || f.primaryLocation.id === 's-3');
    for (const f of crossFindings) {
      expect(f.primaryLocation.kind).toBe('slot');
    }
    // The ledger carries its self-digest (M-2) and the materialized refs.
    expect(freeze.ledger.ledgerDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(freeze.ledger.findingDraftRefs).toHaveLength(3);
  });

  it('I-4: crash between journal-append and the seam is covered — replay re-invokes the idempotent seam and never double-publishes', async () => {
    // Custom factory whose seam records distinct publications per freeze digest.
    const { paths } = makeTempCorePaths('forge-core-crash-');
    const taskId = 'task-crash';
    mkdirSync(paths.taskRoot(taskId), { recursive: true });
    const store = new AuthoritativeReviewPrivateStore(paths, taskId);
    const spec = reviewSpec('content', 'review_content_batch');
    const grantSpecRef = ref('write_grant_spec', 'spec-review_content_batch');
    const baseRef = spec.authorityBaseRef;
    const round = contentRound([], ['s-1']);
    const roundBlobRef = ref('review_bundle', 'round-blob');
    const baseSet = {
      taskId,
      templateSnapshotRef: ref('profile_snapshot', 'tpl'),
      profileSnapshotRef: ref('profile_snapshot', 'profile'),
      mapRef: ref('map_snapshot', 'map'),
      mapCandidateRef: null,
      mapReviewBundleRef: null,
      contentRevisionManifestRef: ref('content_revision_manifest', 'manifest'),
      planSpecRef: ref('map_build_spec', 'plan'),
      stagingManifestRef: null,
      reviewCoverageCoreRef: null,
      reviewRoundRef: roundBlobRef,
      reviewBundleRef: null,
      sealRecordRef: null,
      artifactRef: null,
      findingSetRef: null,
      artifactDeliveryRef: null,
      displayDigests: {},
      baseSetDigest: '',
    } as unknown as AuthorityBaseSetV2;
    const refs = new Map<string, unknown>();
    refs.set(grantSpecRef.digest, spec);
    refs.set(baseRef.digest, baseSet);
    refs.set(roundBlobRef.digest, round);
    const projection = {
      workItems: { 'wi-review': { grantSpecRef, authorityBaseRef: baseRef, state: 'leased' } },
      activeLease: { workItemId: 'wi-review', leaseEpoch: 1, attemptId: 'att-1', commandId: null, leaseOwner: 'agent-a' },
      findings: {},
    };
    const grants = new GrantService({ resolver: (_t, r) => refs.get(r.digest) ?? null, readProjection: async () => projection as never, profile: PROFILE });
    const published: string[] = [];
    let seamThrows = true;
    const factory = new V2ToolFactory({
      grants,
      privateStore: store,
      profile: PROFILE,
      readProjection: async () => projection as never,
      resolver: (_t, r) => refs.get(r.digest) ?? null,
      handlers: {},
      freezeReviewAssignment: async (_task, freeze) => {
        // FIX-M3a: a REAL crash between the journal append and the publication —
        // the seam throws on the FIRST attempt (the journal record + marker are
        // already committed by then).
        if (seamThrows) {
          seamThrows = false;
          throw new Error('simulated seam crash');
        }
        const digest = refOfBlob('review_assignment_ledger', freeze.ledger).digest;
        if (!published.includes(digest)) published.push(digest);
        return { ledgerRef: refOfBlob('review_assignment_ledger', freeze.ledger), eventId: 'evt-x' };
      },
    });
    const ctx = {
      taskId,
      workItemId: 'wi-review',
      attemptId: 'att-1',
      leaseEpoch: 1,
      namespace: 'structured/review_content_batch/wi-review/att-1',
      agentId: 'agent-a',
      roleBinding: 'reviewer',
      executionKind: 'structured' as const,
      sessionKind: 'review_content_batch',
      dispatchRef: null,
      authorityBaseRef: baseRef,
      grantInstanceRef: null,
      inputArtifactDeliveryId: null,
      agent: null,
      currentAssignmentText: '',
      committedCheckpointText: '',
    } as V2AttemptContext;
    const tools = await factory.toolsFor(ctx);
    await runTool(tools.find((t) => t.name === 'submit_slot_review')!, { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'v-1' });
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    // First attempt: the journal record + marker are committed BEFORE the seam,
    // so the seam crash leaves the journal committed but the ledger unpublished.
    await expect(runTool(complete, { clientOperationId: 'v-2' })).rejects.toThrow('simulated seam crash');
    // FIX-M3b: the marker WAS applied before the seam in the new path; simulate
    // the rarer crash BETWEEN append and marker by deleting the marker file.
    const markerPath = paths.taskStructuredV2PrivateRoot(taskId) + '/review/wi-review/att-1/complete.json';
    rmSync(markerPath, { force: true });
    // Retry: same clientOperationId → replay branch re-applies the marker,
    // re-invokes the idempotent seam (same ledger digest → no second distinct
    // publication) and returns the committed result.
    const replay = await runTool(complete, { clientOperationId: 'v-2' });
    expect(replay.ok).toBe(true);
    expect(published).toHaveLength(1);
    expect(replay.data).toMatchObject({ published: true });
    const journalAfter = await store.readAllReviewDraft({ workItemId: ctx.workItemId, leaseEpoch: 1, attemptId: 'att-1', authorityBaseRef: ctx.authorityBaseRef, grantSpecRef });
    expect(journalAfter.complete).toBe(true);
  });

  it('M-6e: read tool pagination is clamped to the profile bound, not the raw request', async () => {
    const { paths } = makeTempCorePaths('forge-core-clamp-');
    const taskId = 'task-clamp';
    mkdirSync(paths.taskRoot(taskId), { recursive: true });
    const store = new AuthoritativeReviewPrivateStore(paths, taskId);
    const spec = reviewSpec('content', 'review_content_batch');
    const grantSpecRef = ref('write_grant_spec', 'spec-review_content_batch');
    const baseRef = spec.authorityBaseRef;
    const round = contentRound([]);
    const roundBlobRef = ref('review_bundle', 'round-blob');
    const baseSet = {
      taskId,
      templateSnapshotRef: ref('profile_snapshot', 'tpl'),
      profileSnapshotRef: ref('profile_snapshot', 'profile'),
      mapRef: ref('map_snapshot', 'map'),
      mapCandidateRef: null,
      mapReviewBundleRef: null,
      contentRevisionManifestRef: ref('content_revision_manifest', 'manifest'),
      planSpecRef: ref('map_build_spec', 'plan'),
      stagingManifestRef: null,
      reviewCoverageCoreRef: null,
      reviewRoundRef: roundBlobRef,
      reviewBundleRef: null,
      sealRecordRef: null,
      artifactRef: null,
      findingSetRef: null,
      artifactDeliveryRef: null,
      displayDigests: {},
      baseSetDigest: '',
    } as unknown as AuthorityBaseSetV2;
    const refs = new Map<string, unknown>();
    refs.set(grantSpecRef.digest, spec);
    refs.set(baseRef.digest, baseSet);
    refs.set(roundBlobRef.digest, round);
    const projection = {
      workItems: { 'wi-review': { grantSpecRef, authorityBaseRef: baseRef, state: 'leased' } },
      activeLease: { workItemId: 'wi-review', leaseEpoch: 1, attemptId: 'att-1', commandId: null, leaseOwner: 'agent-a' },
      findings: {},
    };
    const grants = new GrantService({ resolver: (_t, r) => refs.get(r.digest) ?? null, readProjection: async () => projection as never, profile: PROFILE });
    let seenLimit = 0;
    const factory = new V2ToolFactory({
      grants,
      privateStore: store,
      profile: PROFILE,
      readProjection: async () => projection as never,
      resolver: (_t, r) => refs.get(r.digest) ?? null,
      handlers: {
        read: async (_ctx, _name, params) => {
          seenLimit = Number(params.limit);
          return { ok: true };
        },
      },
    });
    const ctx = {
      taskId,
      workItemId: 'wi-review',
      attemptId: 'att-1',
      leaseEpoch: 1,
      namespace: 'structured/review_content_batch/wi-review/att-1',
      agentId: 'agent-a',
      roleBinding: 'reviewer',
      executionKind: 'structured' as const,
      sessionKind: 'review_content_batch',
      dispatchRef: null,
      authorityBaseRef: baseRef,
      grantInstanceRef: null,
      inputArtifactDeliveryId: null,
      agent: null,
      currentAssignmentText: '',
      committedCheckpointText: '',
    } as V2AttemptContext;
    const tools = await factory.toolsFor(ctx);
    const read = tools.find((t) => t.name === 'read_active_map')!;
    await runTool(read, { parentId: 'p-1', limit: 9999 });
    expect(seenLimit).toBeLessThanOrEqual(PROFILE.assignmentMaxPrimaryTargets);
    // The default limit (no limit param) is 50 — also within the profile bound.
    await runTool(read, { parentId: 'p-2' });
    expect(seenLimit).toBeLessThanOrEqual(PROFILE.assignmentMaxPrimaryTargets);
  });

  it('M-5: a reviewer session via the Pi seam receives ONLY its closed tools — no publish/artifact/human-input/finish tool', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_whole', verificationStages: [] });
    const ctx = await env.factory.createContext({
      taskId: env.ctx.taskId,
      turnId: `v2-${env.ctx.workItemId}-${env.ctx.attemptId}`,
      agent: { id: 'agent-a', name: 'a', description: '', systemPrompt: '', model: 'm/x', skills: [], gate: null, slotCapabilities: [], turnContract: null } as never,
      inputNodeId: env.ctx.workItemId,
      inputText: '',
      publicHistory: [],
      availableSkills: [],
      loadedSkills: [],
      slotSession: null,
      v2Session: { signal: new AbortController().signal },
      v2Namespace: env.ctx.namespace,
    });
    expect(ctx).not.toBeNull();
    const names = ctx!.toolDefinitions.map((t) => t.name);
    for (const forbidden of ['publish_artifact', 'submit_final_artifact', 'send_message', 'request_human_input', 'finish_production', 'write_slot_content', 'seal']) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain('submit_whole_tree_finding');
    expect(names).toContain('complete_review_assignment');
  });
});

describe('fix round 2 regression tests (FIX-1, FIX-M1, FIX-M2)', () => {
  it('FIX-1: a round with coverage ⊃ assignment completes — the inherited difference is NOT demanded', async () => {
    const env = makeEnv({ sessionKind: 'review_content_batch', verificationStages: [], coverageSlotIds: ['s-1', 's-2', 's-3'], assignmentSlotIds: ['s-1', 's-2'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const submit = tools.find((t) => t.name === 'submit_slot_review')!;
    await runTool(submit, { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'v-1' });
    await runTool(submit, { targetId: 's-2', verdict: 'pass', evidence: [], clientOperationId: 'v-2' });
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    const done = await runTool(complete, { clientOperationId: 'v-3' });
    expect(done.ok).toBe(true);
    expect(env.published).toHaveLength(1);
    // The inherited target s-3 is NOT in the assignment set → not demanded.
    const freeze = env.frozen[0];
    expect(freeze.ledger.coverageTargetIds).toEqual(['s-1', 's-2']);
  });

  it('FIX-1: a partial-assignment round completes independently of the OTHER assignment on the same round', async () => {
    // Assignment A covers only s-1 of a round whose coverage is [s-1, s-2, s-3].
    const envA = makeEnv({ sessionKind: 'review_content_batch', verificationStages: [], coverageSlotIds: ['s-1', 's-2', 's-3'], assignmentSlotIds: ['s-1'] });
    const toolsA = await envA.factory.toolsFor(envA.ctx);
    await runTool(toolsA.find((t) => t.name === 'submit_slot_review')!, { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'a-1' });
    const doneA = await runTool(toolsA.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'a-2' });
    expect(doneA.ok).toBe(true);
    // Assignment B covers only s-2 of the SAME round coverage — completes
    // independently; s-1 and s-3 are not its concern.
    const envB = makeEnv({ sessionKind: 'review_content_batch', verificationStages: [], coverageSlotIds: ['s-1', 's-2', 's-3'], assignmentSlotIds: ['s-2'] });
    const toolsB = await envB.factory.toolsFor(envB.ctx);
    await runTool(toolsB.find((t) => t.name === 'submit_slot_review')!, { targetId: 's-2', verdict: 'pass', evidence: [], clientOperationId: 'b-1' });
    const doneB = await runTool(toolsB.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'b-2' });
    expect(doneB.ok).toBe(true);
  });

  it('FIX-1: a map batch completion with no assignment* fields and no seam FAILS CLOSED (never the full round coverage)', async () => {
    const env = makeEnv({ sessionKind: 'review_map_batch', roundKind: 'map', verificationStages: [], coverageNodeIds: ['n-1', 'n-2'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const submit = tools.find((t) => t.name === 'submit_map_node_review')!;
    await runTool(submit, { targetId: 'n-1', verdict: 'pass', evidence: [], clientOperationId: 'v-1' });
    const complete = tools.find((t) => t.name === 'complete_review_assignment')!;
    const result = await runTool(complete, { clientOperationId: 'v-2' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ASSIGNMENT_TARGETS_UNRESOLVED');
    expect(env.published).toHaveLength(0);
  });

  it('FIX-M2: legal + illegal anchored verdict per round kind (the frozen fact must pass parseReviewFact)', async () => {
    const legal = makeEnv({ sessionKind: 'review_content_whole', verificationStages: [], coverageSlotIds: ['s-1'] });
    const legalTools = await legal.factory.toolsFor(legal.ctx);
    // Legal: a slot-anchored content whole verdict must be pass|reject.
    await runTool(legalTools.find((t) => t.name === 'submit_whole_tree_finding')!, {
      findingDraft: { clientFindingKey: 'wk-1', defectClass: 'content', severity: 'blocking', primaryLocation: { kind: 'slot', id: 's-1' }, evidence: ['e'] },
      anchoredVerdict: { targetId: 's-1', verdict: 'reject', evidence: ['e'] },
      clientOperationId: 'w-1',
    });
    const legalDone = await runTool(legalTools.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'w-2' });
    expect(legalDone.ok).toBe(true);
    // Every frozen fact parses through the review_fact registry parser.
    for (const fact of legal.frozen[0].facts) {
      parseBlob('review_fact', fact);
    }
    // Illegal: a content whole session anchored verdict 'satisfied' on a slot
    // would freeze a parse-invalid content_slot fact → the completion rejects.
    const illegal = makeEnv({ sessionKind: 'review_content_whole', verificationStages: [], coverageSlotIds: ['s-1'] });
    const illegalTools = await illegal.factory.toolsFor(illegal.ctx);
    await runTool(illegalTools.find((t) => t.name === 'submit_whole_tree_finding')!, {
      findingDraft: { clientFindingKey: 'wk-2', defectClass: 'content', severity: 'blocking', primaryLocation: { kind: 'slot', id: 's-1' }, evidence: ['e'] },
      anchoredVerdict: { targetId: 's-1', verdict: 'satisfied', evidence: ['e'] },
      clientOperationId: 'w-3',
    });
    const illegalDone = await runTool(illegalTools.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'w-4' });
    expect(illegalDone.ok).toBe(false);
    expect(illegalDone.code).toBe('REVIEW_ASSIGNMENT_INCOMPLETE');
    expect(illegal.published).toHaveLength(0);
  });

  it('FIX-M2: a relation-anchored whole verdict uses satisfied|violated and freezes a parse-valid relation fact', async () => {
    const env2 = makeEnv({ sessionKind: 'review_content_whole', verificationStages: [], coverageSlotIds: ['s-1'], coverageRelationIds: ['r-9'] });
    const tools = await env2.factory.toolsFor(env2.ctx);
    await runTool(tools.find((t) => t.name === 'submit_whole_tree_finding')!, {
      findingDraft: { clientFindingKey: 'wk-3', defectClass: 'content', severity: 'blocking', primaryLocation: { kind: 'relation', id: 'r-9' }, evidence: ['e'] },
      anchoredVerdict: { targetId: 'r-9', verdict: 'violated', evidence: ['e'] },
      clientOperationId: 'w-5',
    });
    const done = await runTool(tools.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'w-6' });
    expect(done.ok).toBe(true);
    const relationFact = env2.frozen[0].facts.find((f) => f.targetStableId === 'r-9')!;
    expect(relationFact.targetKind).toBe('content_relation');
    expect(relationFact.verdict).toBe('violated');
    parseBlob('review_fact', relationFact); // must be parse-valid
  });
});

describe('fix round 3 regression tests (FIX-1 precedence, M-a, M-b)', () => {
  it('FIX-1 precedence: a shared two-assignment round — B completes with ONLY B\'s target via the seam; A\'s target is unassigned for B', async () => {
    // Shared round: coverage [s-1,s-2,s-3], round-level assignment* [s-1,s-2],
    // TWO assignments (A→s-1, B→s-2) → NOT provably single-assignment.
    const { paths } = makeTempCorePaths('forge-core-shared-round-');
    const taskId = 'task-shared';
    mkdirSync(paths.taskRoot(taskId), { recursive: true });
    const store = new AuthoritativeReviewPrivateStore(paths, taskId);
    const spec = reviewSpec('content', 'review_content_batch');
    const grantSpecRef = ref('write_grant_spec', 'spec-review_content_batch');
    const baseRef = spec.authorityBaseRef;
    const round = contentRound([], ['s-1', 's-2', 's-3'], ['s-1', 's-2']);
    round.assignmentIds = ['A', 'B'];
    const roundBlobRef = ref('review_bundle', 'round-blob');
    const baseSet = {
      taskId,
      templateSnapshotRef: ref('profile_snapshot', 'tpl'),
      profileSnapshotRef: ref('profile_snapshot', 'profile'),
      mapRef: ref('map_snapshot', 'map'),
      mapCandidateRef: null,
      mapReviewBundleRef: null,
      contentRevisionManifestRef: ref('content_revision_manifest', 'manifest'),
      planSpecRef: ref('map_build_spec', 'plan'),
      stagingManifestRef: null,
      reviewCoverageCoreRef: null,
      reviewRoundRef: roundBlobRef,
      reviewBundleRef: null,
      sealRecordRef: null,
      artifactRef: null,
      findingSetRef: null,
      artifactDeliveryRef: null,
      displayDigests: {},
      baseSetDigest: '',
    } as unknown as AuthorityBaseSetV2;
    const refs = new Map<string, unknown>();
    refs.set(grantSpecRef.digest, spec);
    refs.set(baseRef.digest, baseSet);
    refs.set(roundBlobRef.digest, round);

    async function makeAssignmentFactory(workItemId: string, attemptId: string, targets: readonly string[]) {
      const projection = {
        workItems: { [workItemId]: { grantSpecRef, authorityBaseRef: baseRef, state: 'leased' } },
        activeLease: { workItemId, leaseEpoch: 1, attemptId, commandId: null, leaseOwner: 'agent-a' },
        findings: {},
      };
      const grants = new GrantService({ resolver: (_t, r) => refs.get(r.digest) ?? null, readProjection: async () => projection as never, profile: PROFILE });
      const factory = new V2ToolFactory({
        grants,
        privateStore: store,
        profile: PROFILE,
        readProjection: async () => projection as never,
        resolver: (_t, r) => refs.get(r.digest) ?? null,
        handlers: {},
        resolveAssignmentTargets: async () => targets,
        freezeReviewAssignment: async (_task, freeze) => {
          const ledgerRef = refOfBlob('review_assignment_ledger', freeze.ledger);
          return { ledgerRef, eventId: `evt-${workItemId}` };
        },
      });
      const ctx = {
        taskId,
        workItemId,
        attemptId,
        leaseEpoch: 1,
        namespace: `structured/review_content_batch/${workItemId}/${attemptId}`,
        agentId: 'agent-a',
        roleBinding: 'reviewer',
        executionKind: 'structured' as const,
        sessionKind: 'review_content_batch',
        dispatchRef: null,
        authorityBaseRef: baseRef,
        grantInstanceRef: null,
        inputArtifactDeliveryId: null,
        agent: null,
        currentAssignmentText: '',
        committedCheckpointText: '',
      } as V2AttemptContext;
      return { factory, ctx, workItemId };
    }

    const b = await makeAssignmentFactory('wi-B', 'att-B', ['s-2']);
    const toolsB = await b.factory.toolsFor(b.ctx);
    await runTool(toolsB.find((t) => t.name === 'submit_slot_review')!, { targetId: 's-2', verdict: 'pass', evidence: [], clientOperationId: 'b-1' });
    // B completes with ONLY B's target → succeeds (A's target is not demanded).
    const doneB = await runTool(toolsB.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'b-2' });
    expect(doneB.ok).toBe(true);
    // B attempting A's target (s-1) is an unassigned target → rejected.
    const toolsB2 = await b.factory.toolsFor(b.ctx);
    const b2submit = toolsB2.find((t) => t.name === 'submit_slot_review')!;
    await runTool(b2submit, { targetId: 's-1', verdict: 'pass', evidence: [], clientOperationId: 'b-3' });
    const doneB2 = await runTool(toolsB2.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'b-4' });
    expect(doneB2.ok).toBe(false);
    expect(doneB2.code).toBe('REVIEW_ASSIGNMENT_INCOMPLETE');
  });

  it('M-a: an anchored verdict on a DIFFERENT-kind target is typed by the baseline, never mis-typed; an unknown target rejects', async () => {
    // Slot s-1 finding anchored on relation r-9 (both in the baseline).
    const env = makeEnv({ sessionKind: 'review_content_whole', verificationStages: [], coverageSlotIds: ['s-1'], coverageRelationIds: ['r-9'] });
    const tools = await env.factory.toolsFor(env.ctx);
    await runTool(tools.find((t) => t.name === 'submit_whole_tree_finding')!, {
      findingDraft: { clientFindingKey: 'wk-a', defectClass: 'content', severity: 'blocking', primaryLocation: { kind: 'slot', id: 's-1' }, evidence: ['e'] },
      anchoredVerdict: { targetId: 'r-9', verdict: 'violated', evidence: ['e'] },
      clientOperationId: 'w-1',
    });
    const done = await runTool(tools.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'w-2' });
    expect(done.ok).toBe(true);
    const relationFact = env.frozen[0].facts.find((f) => f.targetStableId === 'r-9')!;
    expect(relationFact.targetKind).toBe('content_relation'); // typed by r-9's baseline kind
    expect(relationFact.verdict).toBe('violated');
    parseBlob('review_fact', relationFact);
    // Unknown anchored target (not in the baseline) → the freeze rejects.
    const env2 = makeEnv({ sessionKind: 'review_content_whole', verificationStages: [], coverageSlotIds: ['s-1'] });
    const tools2 = await env2.factory.toolsFor(env2.ctx);
    await runTool(tools2.find((t) => t.name === 'submit_whole_tree_finding')!, {
      findingDraft: { clientFindingKey: 'wk-b', defectClass: 'content', severity: 'blocking', primaryLocation: { kind: 'slot', id: 's-1' }, evidence: ['e'] },
      anchoredVerdict: { targetId: 's-99', verdict: 'pass', evidence: ['e'] },
      clientOperationId: 'w-3',
    });
    const done2 = await runTool(tools2.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'w-4' });
    expect(done2.ok).toBe(false);
    expect(done2.code).toBe('REVIEW_ASSIGNMENT_INCOMPLETE');
    expect(done2.data).toMatchObject({ message: expect.stringContaining('cannot type the anchored fact') });
  });

  it('M-b(a): a cross-scope draft WITHOUT primaryTargetKind resolves its kind via the round baseline', async () => {
    const env = makeEnv({ sessionKind: 'review_content_batch', verificationStages: [], coverageSlotIds: ['s-1', 's-2'], assignmentSlotIds: ['s-1'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const submit = tools.find((t) => t.name === 'submit_slot_review')!;
    await runTool(submit, {
      targetId: 's-1',
      verdict: 'pass',
      evidence: [],
      crossScopeFindingDrafts: [
        // s-2 is in the baseline but NOT declared → derived kind 'slot'.
        { clientFindingKey: 'k-x', primaryTarget: 's-2', defectClass: 'content', severity: 'blocking', evidence: ['e'] },
      ],
      clientOperationId: 'v-1',
    });
    const done = await runTool(tools.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'v-2' });
    expect(done.ok).toBe(true);
    const cross = env.frozen[0].findings.find((f) => f.primaryLocation.id === 's-2')!;
    expect(cross.primaryLocation.kind).toBe('slot');
  });

  it('M-b(b): a cross-scope target with no declared/baseline kind rejects the freeze', async () => {
    const env = makeEnv({ sessionKind: 'review_content_batch', verificationStages: [], coverageSlotIds: ['s-1'], assignmentSlotIds: ['s-1'] });
    const tools = await env.factory.toolsFor(env.ctx);
    const submit = tools.find((t) => t.name === 'submit_slot_review')!;
    await runTool(submit, {
      targetId: 's-1',
      verdict: 'pass',
      evidence: [],
      crossScopeFindingDrafts: [
        // s-99 is in NEITHER the declared kind NOR the round baseline.
        { clientFindingKey: 'k-y', primaryTarget: 's-99', defectClass: 'content', severity: 'blocking', evidence: ['e'] },
      ],
      clientOperationId: 'v-1',
    });
    const done = await runTool(tools.find((t) => t.name === 'complete_review_assignment')!, { clientOperationId: 'v-2' });
    expect(done.ok).toBe(false);
    expect(done.code).toBe('REVIEW_ASSIGNMENT_INCOMPLETE');
    expect(done.data).toMatchObject({ message: expect.stringContaining('cannot determine the primary target kind') });
  });
});

describe('Pi seam wiring (createContext)', () => {
  it('attemptIdFromNamespace parses the last segment', () => {
    expect(attemptIdFromNamespace('structured/reviewer/wi-1/att-9')).toBe('att-9');
    expect(attemptIdFromNamespace('no-slash')).toBeNull();
  });

  it('the V2ToolFactory implements the PiV2ToolRuntime createContext shape', async () => {
    const env = await makeEnv({ sessionKind: 'review_content_batch', verificationStages: [] });
    const toolDefinitions = await env.factory.createContext({
      taskId: env.ctx.taskId,
      turnId: `v2-${env.ctx.workItemId}-${env.ctx.attemptId}`,
      agent: { id: 'agent-a', name: 'a', description: '', systemPrompt: '', model: 'm/x', skills: [], gate: null, slotCapabilities: [], turnContract: null } as never,
      inputNodeId: env.ctx.workItemId,
      inputText: '',
      publicHistory: [],
      availableSkills: [],
      loadedSkills: [],
      slotSession: null,
      v2Session: { signal: new AbortController().signal },
      v2Namespace: env.ctx.namespace,
    });
    expect(toolDefinitions).not.toBeNull();
    expect(toolDefinitions!.toolDefinitions.map((t) => t.name)).toEqual(toolNames(await env.factory.toolsFor(env.ctx)));
  });
});
