// @vitest-environment node
/**
 * Task 22 P1 integration: the PRODUCTION SystemArtifactDelivery handoff from
 * the seal publish to the generic Submitter's final commit. A delivery-bound
 * submitter WorkItem (created by the sealed publish) is leased and executed by
 * the REAL `V2AttemptCoordinator` + `V2AssignmentRunner` with the scripted
 * Submitter emitting exactly one `submit_final_artifact`; the coordinator's
 * final-submission path resolves the delivery through the REAL
 * `SystemArtifactDeliveryValidatorV2` and commits the atomic batch
 * [structured_generic_agent_attempt_completed, structured_work_item_completed]
 * in ONE appendBatch. Unreachable / non-submit outcomes are rejected with a
 * terminal failure and NO partial write.
 *
 * The fixture seeds the delivery chain DIRECTLY (map -> manifests -> system
 * Seal envelope -> delivery -> submitter WorkItem) so the test does not need
 * the full ten-condition seal gate; the delivery/SealRecord/custody blobs are
 * REAL content-addressed objects the validator resolves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { refOfBlob } from '../../authoritative-review/object-registry';
import type { BlobRefV2, SystemArtifactDeliveryV2, SealRecordV2 } from '../../../shared/authoritative-review-v2';
import type { FrozenTemplate } from '../../template/template-schema';
import { validateAuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import { createWorkItemCoordinatorEnvironment, disposeRuntimeTestRoots } from '../test-support';
import type { WorkItemCoordinatorEnvironment } from '../test-support';
import { ArtifactStore } from '../../storage/artifact-store';
import { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import { TraceStore } from '../../storage/trace-store';
import { FakeAgentRuntime } from '../fake-agent-runtime';
import { V2AssignmentRunner } from './assignment-runner';
import { buildAuthorityBaseSet } from './authority-base';
import { buildReviewObservationGrantSpec } from './review-coordinator';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { installAuthoritativeReviewRuntime } from './production-composition';
import { V2AttemptCoordinator, type TerminalFailInputV2, type V2AttemptOutcome } from './attempt-coordinator';
import type { FinalSubmissionReachabilityV2 } from './system-artifact-delivery';
import type { V2SchedulingPassResult } from '../task-scheduler';
import type { ArtifactCustodyV2 } from '../../authoritative-review/authority-types';

afterEach(() => disposeRuntimeTestRoots());

const H = (label: string) => canonicalJsonSha256({ label });
const TEMPLATE_HASH = 'a'.repeat(64);
const TASK = 'task-delivery-prod';
const SEAL_WORK_ITEM = 'wi-seal-prod';
const SUBMITTER_WORK_ITEM = 'wi-submit-prod';
const SUBMITTER_AGENT = 'submitter';
const DELIVERY_ID = 'del-prod';

function fakeAgent(id: string, role: string): FrozenTemplate['agents'][number] {
  return {
    id,
    name: role,
    description: `frozen ${role} agent`,
    systemPrompt: `You are the ${role} agent.`,
    model: 'configured/test-model',
    skills: [],
    gate: null,
    slotCapabilities: [],
    turnContract: null,
  } as never;
}

const frozenV2: FrozenTemplate = {
  id: 'delivery-integration',
  name: 'Delivery integration',
  description: 'v2',
  versionHash: '0'.repeat(64),
  productionMode: 'structured_slots',
  structuredSlots: { version: 2 },
  structuredPhases: null,
  structuredReviewLifecycle: {
    protocol: 'authoritative_review_v1',
    roleBindings: { orchestrator: 'orchestrator', generator: 'generator', reviewer: 'reviewer', submitter: SUBMITTER_AGENT },
    systemArtifactProducer: 'system:structured_seal',
  },
  authoritativeReviewProfile: {
    profileIdentity: 'forge-authoritative-review/v1',
    profileDigest: H('profile-digest'),
    profileSnapshotRef: refOfBlob('profile_snapshot', { label: 'placeholder' }),
  },
  inputFields: [],
  agents: [fakeAgent(SUBMITTER_AGENT, 'submitter')],
  routes: [],
  artifactSchema: { files: [] },
  finalOutput: { name: 'out', format: 'markdown', submitters: [SUBMITTER_AGENT] },
  budget: null,
  sourcePath: 'fixture:delivery-integration',
} as unknown as FrozenTemplate;

interface DeliveryFixture {
  env: WorkItemCoordinatorEnvironment;
  delivery: SystemArtifactDeliveryV2;
  deliveryRef: BlobRefV2;
  sealRecordRef: BlobRefV2;
  custodyRef: BlobRefV2;
  artifactRef: BlobRefV2;
  sealBaseRef: BlobRefV2;
  submitterBaseRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  templateSnapshotRef: BlobRefV2;
}

function selfDigest<T extends Record<string, unknown>>(body: T, field: keyof T & string): T {
  const { [field]: _omit, ...rest } = body;
  return { ...body, [field]: canonicalJsonSha256(rest) } as T;
}

/**
 * Seeds the delivery chain directly: map/manifest seed events, a real system
 * Seal WorkItem, the sealed publish envelope (scaffold + publish + delivery +
 * command/work-item completion) and the delivery-bound submitter WorkItem.
 */
async function prepareDeliveryFixture(): Promise<DeliveryFixture> {
  const env = await createWorkItemCoordinatorEnvironment();
  const templateSnapshotRef = env.templateSnapshotRef;
  const profileSnapshotRef = env.profileSnapshotRef;
  const put = <K extends Parameters<typeof refOfBlob>[0]>(kind: K, value: unknown): Promise<BlobRefV2> =>
    env.facade.prepareBlob(TASK, kind, value);
  const synth = <K extends Parameters<typeof refOfBlob>[0]>(kind: K, label: string): BlobRefV2 =>
    refOfBlob(kind, { label });

  /* ---- synthetic authority refs (never resolved by the projector) ---- */
  const mapBuildSpecRef = synth('map_build_spec', 'spec');
  const contributionRef = synth('contribution_manifest', 'cm');
  const candidateRef = synth('map_candidate', 'cand');
  const mapSnapshotRef = synth('map_snapshot', 'map');
  const mapReviewBundleRef = synth('map_review_bundle', 'mrb');
  const activationValidatorAggregateRef = synth('validator_aggregate', 'act-agg');
  const baselineRef = synth('content_revision_manifest', 'baseline');
  const finalizedManifestRef = synth('content_revision_manifest', 'finalized');
  const reviewBundleRef = synth('review_bundle', 'review');
  const sealValidationBundleRef = synth('seal_validation_bundle', 'svb');
  const contentSettlementCoreRef = synth('content_review_settlement_core', 'sc');
  const warningCustodyRootRef = synth('validation_warning_custody_root', 'warn');

  /* ---- REAL content-addressed delivery chain blobs ---- */
  const artifactBody = { artifactId: 'artifact-delivery-prod', mediaType: 'text/markdown' as const, text: '# sealed' };
  const artifactRef = await put('artifact', artifactBody);
  const sealRecord: SealRecordV2 = {
    taskId: TASK,
    mapRef: mapSnapshotRef,
    mapSemanticDigest: H('map-semantic'),
    mapReviewBundleRef,
    contentRevisionManifestRef: finalizedManifestRef,
    contentRootDigest: H('content-root'),
    reviewBundleRef,
    sealValidationBundleRef,
    templateSnapshotHash: TEMPLATE_HASH,
    assemblerDigest: H('assembler'),
    artifactRef,
    artifactDigest: artifactRef.digest,
  };
  const sealRecordRef = await put('seal_record', sealRecord);
  const custodyBody: Omit<ArtifactCustodyV2, 'custodyDigest'> = {
    taskId: TASK,
    sealWorkItemId: SEAL_WORK_ITEM,
    artifactRef,
    sealRecordRef,
    templateSnapshotHash: TEMPLATE_HASH,
    files: [{ name: 'chapter.md', hash: artifactRef.digest, byteLength: 16 }],
  };
  const custody: ArtifactCustodyV2 = {
    ...custodyBody,
    custodyDigest: canonicalJsonSha256(custodyBody),
  };
  const custodyRef = await put('artifact_custody', custody);
  const delivery: SystemArtifactDeliveryV2 = {
    deliveryId: DELIVERY_ID,
    producer: 'system:structured_seal',
    sealRecordRef,
    sealRecordDigest: sealRecordRef.digest,
    artifactId: 'artifact-delivery-prod',
    artifactRef,
    artifactDigest: artifactRef.digest,
    custodyRef,
    custodyDigest: custodyRef.digest,
    submitterWorkItemId: SUBMITTER_WORK_ITEM,
    submitterAgentId: SUBMITTER_AGENT,
    templateSnapshotHash: TEMPLATE_HASH,
  };
  const deliveryRef = await put('system_artifact_delivery', delivery);

  /* ---- seed events: map build -> candidate -> activation -> manifests ---- */
  const seedEvents = [
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_started' as const, mapBuildId: 'build-1', revision: 1,
      mapBuildSpecRef, supersedesMapBuildId: null, sourceValidationReceiptRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_finish_proposed' as const, mapBuildId: 'build-1',
      expectedChunkCount: 1, expectedFrontierDigest: H('frontier'), expectedRootCount: 1,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_finalized' as const, mapBuildId: 'build-1',
      manifestRef: contributionRef, contributionManifestRef: contributionRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_candidate_committed' as const, candidateId: 'candidate-1',
      candidateRef, candidateDigest: candidateRef.digest, baseMapId: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_activated' as const, mapId: 'map-1', mapRevision: 1,
      supersedesMapId: null, mapSnapshotRef, mapReviewBundleRef, mapSemanticDigest: H('map-semantic'),
      contentRevisionManifestRef: baselineRef, activationValidatorAggregateRef,
      migrationSettlementCoreRef: null, migrationActivationDecisionRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_content_revision_committed' as const,
      contentRevisionManifestRef: baselineRef, taskContentRevision: 1, manifestPhase: 'baseline_unset',
      producerPlanSpecRef: null, priorManifestRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_content_revision_committed' as const,
      contentRevisionManifestRef: finalizedManifestRef, taskContentRevision: 2, manifestPhase: 'finalized',
      producerPlanSpecRef: null, priorManifestRef: baselineRef,
    },
  ];
  const validatedSeed = seedEvents.map((event, index) => validateAuthoritativeReviewEventV2({ ...event, id: `evt-seed-${index}` }));
  const seedHold = await env.publicationStore.lock().acquire();
  try {
    await env.eventStore.appendBatch(TASK, 'seed-delivery-authority', validatedSeed, {
      expectedLastSequence: 0,
      fenceProof: await seedHold.proof(),
    });
  } finally {
    await seedHold.release();
  }

  /* ---- the system Seal WorkItem (real base + payload) ---- */
  const reviewBundleBody = selfDigest({
    settlementCoreRef: contentSettlementCoreRef,
    mapRef: mapSnapshotRef,
    contentRevisionManifestRef: finalizedManifestRef,
    reviewWarningCustodyRootRef: warningCustodyRootRef,
    bundleDigest: '',
  }, 'bundleDigest');
  const reviewBundleRefPrepared = await put('review_bundle', reviewBundleBody);
  const sealBase = buildAuthorityBaseSet({
    taskId: TASK,
    templateSnapshotRef,
    profileSnapshotRef,
    refs: { mapRef: mapSnapshotRef, mapReviewBundleRef, contentRevisionManifestRef: finalizedManifestRef, reviewBundleRef },
    kind: 'system_seal',
  });
  const sealCreated = await env.coordinator.createWorkItem({
    taskId: TASK,
    operationId: '22222222-2222-4222-8222-222222222222',
    workItemId: SEAL_WORK_ITEM,
    kind: 'system_seal',
    roleBinding: null,
    agentExecutionKind: null,
    sessionKind: null,
    logicalAssignmentId: null,
    reviewAssignmentId: null,
    inputArtifactDeliveryId: null,
    payload: { kind: 'review_bundle', value: reviewBundleBody },
    authorityBase: sealBase,
    maxAutomaticRetries: 3,
  });
  const sealBaseRef = sealCreated.authorityBaseRef;
  void reviewBundleRefPrepared;

  /* ---- the delivery-bound submitter WorkItem (created IN the sealed publish
   * envelope so the delivery obligation binds in the same atomic batch) ---- */
  const submitterBase = buildAuthorityBaseSet({
    taskId: TASK,
    templateSnapshotRef,
    profileSnapshotRef,
    refs: { sealRecordRef, artifactRef, artifactDeliveryRef: deliveryRef },
    kind: 'agent_assignment',
    agentExecutionKind: 'generic_turn',
    sessionKind: null,
  });
  const submitterBaseRef = await put('authority_base_set', submitterBase);
  const submitterGrantSpec = buildReviewObservationGrantSpec({
    grantSpecId: `grant-${SUBMITTER_WORK_ITEM}`,
    workItemId: SUBMITTER_WORK_ITEM,
    authorityBaseRef: submitterBaseRef,
    sessionKind: null,
    reviewAssignmentId: null,
    roundId: null,
    roundKind: null,
    snapshotHash: TEMPLATE_HASH,
    maxContextBytes: 1_024,
  });
  const submitterGrantSpecRef = await put('write_grant_spec', submitterGrantSpec);

  /* ---- the sealed publish envelope (lease -> seal -> publish -> delivery
   * -> submitter -> seal completion) ---- */
  const tailAfterCreate = await env.eventStore.tail(TASK);
  const sealLeaseEpoch = 1;
  const sealCommandId = 'cmd-seal-prod';
  const envelopeEvents = [
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_work_item_leased' as const, workItemId: SEAL_WORK_ITEM,
      leaseEpoch: sealLeaseEpoch, leaseOwner: 'task_owner', leaseExpiresAt: '2026-08-14T10:30:00.000Z',
      expectedLastSequence: tailAfterCreate.lastSequence, authorityBaseRef: sealBaseRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_system_command_started' as const, commandId: sealCommandId,
      workItemId: SEAL_WORK_ITEM, commandKind: 'seal' as const, leaseEpoch: sealLeaseEpoch, authorityBaseRef: sealBaseRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_scaffold_sealed_v2' as const, sealWorkItemId: SEAL_WORK_ITEM,
      sealRecordRef, sealValidationBundleRef, mapRef: mapSnapshotRef, contentRevisionManifestRef: finalizedManifestRef,
      reviewBundleRef, artifactRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'artifact_published_v2' as const, artifactId: 'artifact-delivery-prod',
      artifactVersion: 1, deliveryRef, files: [{ name: 'chapter.md', hash: artifactRef.digest }],
      mediaType: 'text/markdown' as const,
      provenance: { producerKind: 'system' as const, producerWorkItemId: SEAL_WORK_ITEM, sealRecordRef, artifactRef, custodyRef },
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_system_artifact_delivery_created' as const,
      deliveryId: DELIVERY_ID, deliveryRef, artifactId: 'artifact-delivery-prod', artifactRef, sealRecordRef,
      submitterWorkItemId: SUBMITTER_WORK_ITEM,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_work_item_created' as const, workItemId: SUBMITTER_WORK_ITEM,
      kind: 'agent_assignment', roleBinding: SUBMITTER_AGENT, agentExecutionKind: 'generic_turn', sessionKind: null,
      roundId: null, logicalAssignmentId: `la-${SUBMITTER_WORK_ITEM}`, reviewAssignmentId: null,
      grantSpecRef: submitterGrantSpecRef, inputArtifactDeliveryId: DELIVERY_ID, authorityBaseRef: submitterBaseRef,
      payloadRef: deliveryRef, initialLeaseEpoch: 1, maxAutomaticRetries: 3,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_system_command_completed' as const, commandId: sealCommandId,
      workItemId: SEAL_WORK_ITEM, commandKind: 'seal' as const, leaseEpoch: sealLeaseEpoch, authorityBaseRef: sealBaseRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_work_item_completed' as const, workItemId: SEAL_WORK_ITEM,
      leaseEpoch: sealLeaseEpoch, authorityBaseRef: sealBaseRef,
    },
  ];
  const validatedEnvelope = envelopeEvents.map((event, index) => validateAuthoritativeReviewEventV2({ ...event, id: `evt-envelope-${index}` }));
  const envelopeHold = await env.publicationStore.lock().acquire();
  try {
    await env.eventStore.appendBatch(TASK, 'seed-seal-envelope', validatedEnvelope, {
      expectedLastSequence: tailAfterCreate.lastSequence,
      fenceProof: await envelopeHold.proof(),
    });
  } finally {
    await envelopeHold.release();
  }

  return {
    env,
    delivery,
    deliveryRef,
    sealRecordRef,
    custodyRef,
    artifactRef,
    sealBaseRef,
    submitterBaseRef,
    profileSnapshotRef,
    templateSnapshotRef,
  };
}

function idleScheduling(): import('../task-scheduler').AuthoritativeV2SchedulingEngine {
  return {
    async runPass(): Promise<V2SchedulingPassResult> {
      return { scanned: 1, reclaimed: [], requeued: [], leased: [], blocked: [], skipped: [], wakeupRemoved: [], corrupt: [] };
    },
  } as unknown as import('../task-scheduler').AuthoritativeV2SchedulingEngine;
}

function submitterRunner(mode: 'submit' | 'empty' | 'double'): V2AssignmentRunner {
  const steps = mode === 'submit'
    ? [{ kind: 'result' as const, publicText: 'submitted', actions: [{ type: 'submit_final_artifact' as const }] }]
    : mode === 'double'
      ? [{ kind: 'result' as const, publicText: 'double', actions: [{ type: 'submit_final_artifact' as const }, { type: 'submit_final_artifact' as const }] }]
      : [{ kind: 'result' as const, publicText: 'noop', actions: [] }];
  const runtime = new FakeAgentRuntime({ scripts: { [SUBMITTER_AGENT]: steps } });
  return new V2AssignmentRunner({
    runtime,
    toolProvider: { async toolsFor() { return []; }, async collectResultRefs() { return []; } },
  });
}

function installComposition(fixture: DeliveryFixture, options: {
  runner?: V2AssignmentRunner;
  resolver?: (taskId: string, ref: BlobRefV2) => Promise<unknown>;
  terminalFail?: (taskId: string, input: TerminalFailInputV2) => Promise<void>;
} = {}) {
  const { env } = fixture;
  return installAuthoritativeReviewRuntime({
    coordinator: env.coordinator,
    facade: env.facade,
    blobStore: env.blobStore,
    wakeups: new AuthoritativeWakeupIndexV1({ paths: env.paths }),
    artifacts: new ArtifactStore(env.paths, env.eventStore, (taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind)),
    scheduling: idleScheduling(),
    readProjection: (taskId) => env.readProjection(taskId),
    resolver: options.resolver ?? ((taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind)),
    frozenProfile: async () => ({
      profileSnapshotRef: fixture.profileSnapshotRef,
      templateSnapshotRef: fixture.templateSnapshotRef,
      profileDigest: H('profile-digest'),
      snapshotHash: TEMPLATE_HASH,
    }),
    frozenTemplate: async () => frozenV2,
    profileBody: async () => buildAuthoritativeReviewTestProfileBody(),
    frozenAutomaticRetries: async () => 3,
    eligibility: () => ({ state: 'eligible', frozenProfileDigest: H('profile-digest'), currentProfileDigest: H('profile-digest') }),
    runner: options.runner ?? submitterRunner('submit'),
    clock: () => env.now.value,
    traces: new TraceStore(env.paths),
    eventStore: env.eventStore,
    publicationStore: env.publicationStore,
    terminalFail: options.terminalFail,
  });
}

async function committedEvents(env: WorkItemCoordinatorEnvironment): Promise<Array<Record<string, unknown> & { _fileName?: string }>> {
  return (await env.eventStore.read(TASK)).map((entry) => ({ ...(entry.event as unknown as Record<string, unknown>), _fileName: entry.fileName }));
}

describe('Task 22 P1 SystemArtifactDelivery -> generic Submitter final commit', () => {
  it('leases and completes the submitter through the REAL validator with one atomic final batch', async () => {
    const fixture = await prepareDeliveryFixture();
    const { env } = fixture;
    const composition = installComposition(fixture);

    const before = await env.readProjection(TASK);
    expect(before.workItems[SUBMITTER_WORK_ITEM]?.state).toBe('ready');
    expect(before.workItems[SUBMITTER_WORK_ITEM]?.inputArtifactDeliveryId).toBe(DELIVERY_ID);
    expect(before.delivery?.deliveryId).toBe(DELIVERY_ID);
    expect(before.workItems[SEAL_WORK_ITEM]?.state).toBe('completed');

    // Drive the submitter through the production coordinator + runner + validator.
    const outcome = await composition.attempts.runNext(TASK, SUBMITTER_AGENT);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'completed', workItemId: SUBMITTER_WORK_ITEM });

    const events = await committedEvents(env);
    const genericCompleted = events.find((event) => event.type === 'structured_generic_agent_attempt_completed'
      && event.workItemId === SUBMITTER_WORK_ITEM)!;
    const workItemCompleted = events.filter((event) => event.type === 'structured_work_item_completed'
      && event.workItemId === SUBMITTER_WORK_ITEM);
    expect(genericCompleted).toBeDefined();
    expect(workItemCompleted).toHaveLength(1);
    // The delivery identity is fixed in the completed attempt event.
    expect(genericCompleted.inputArtifactDeliveryId).toBe(DELIVERY_ID);
    expect(genericCompleted.agentId).toBe(SUBMITTER_AGENT);
    // The final submission + generic attempt + WorkItem completion are ONE batch.
    expect(workItemCompleted[0]!._fileName).toBe(genericCompleted._fileName);
    // No v1 event was ever written and no double terminal exists.
    expect(events.filter((event) => event.type === 'final_submission_accepted')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'structured_generic_agent_attempt_completed')).toHaveLength(1);

    const after = await env.readProjection(TASK);
    expect(after.workItems[SUBMITTER_WORK_ITEM]?.state).toBe('completed');
    expect(after.taskStatus).toBe('completed');
  }, 60_000);

  it('uses the frozen submitter Agent identity when the scheduler lease owner is task_owner', async () => {
    const fixture = await prepareDeliveryFixture();
    const { env } = fixture;
    const terminalFailCalls: TerminalFailInputV2[] = [];
    const composition = installComposition(fixture, {
      terminalFail: async (_taskId, input) => { terminalFailCalls.push(input); },
    });

    const leased = await env.coordinator.leaseNext(
      TASK,
      'task_owner',
      '33333333-3333-4333-8333-333333333333',
    );
    expect(leased).not.toBeNull();
    const outcome = await composition.attempts.executeLeased(TASK, undefined, {
      dispatchRef: leased!.dispatchRef,
      workItemId: leased!.workItemId,
      leaseEpoch: leased!.leaseEpoch,
      attemptId: leased!.attemptId,
      commandId: leased!.commandId,
    });

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      kind: 'completed',
      workItemId: SUBMITTER_WORK_ITEM,
    });
    expect(terminalFailCalls).toHaveLength(0);
    expect((await env.readProjection(TASK)).workItems[SUBMITTER_WORK_ITEM]?.state).toBe('completed');
  }, 60_000);

  it('rejects a turn that did not submit (GENERIC_SUBMIT_REQUIRED) with no final commit', async () => {
    const fixture = await prepareDeliveryFixture();
    const { env } = fixture;
    const terminalFailCalls: TerminalFailInputV2[] = [];
    const composition = installComposition(fixture, {
      runner: submitterRunner('empty'),
      terminalFail: async (_taskId, input) => { terminalFailCalls.push(input); },
    });

    const outcome = await composition.attempts.runNext(TASK, SUBMITTER_AGENT);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'terminal_failed', failureCode: 'GENERIC_SUBMIT_REQUIRED' });
    const events = await committedEvents(env);
    expect(events.filter((event) => event.type === 'structured_generic_agent_attempt_completed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'structured_work_item_completed' && event.workItemId === SUBMITTER_WORK_ITEM)).toHaveLength(0);
    expect(events.filter((event) => event.type === 'structured_work_item_completed')).toHaveLength(1); // only the seal's
    expect(terminalFailCalls).toHaveLength(1);
    expect(terminalFailCalls[0]!.attemptId).not.toBeNull();
  }, 60_000);

  it('rejects a turn with TWO submit actions (GENERIC_SUBMIT_REQUIRED) with no final commit', async () => {
    const fixture = await prepareDeliveryFixture();
    const { env } = fixture;
    const terminalFailCalls: TerminalFailInputV2[] = [];
    const composition = installComposition(fixture, {
      runner: submitterRunner('double'),
      terminalFail: async (_taskId, input) => { terminalFailCalls.push(input); },
    });

    const outcome = await composition.attempts.runNext(TASK, SUBMITTER_AGENT);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'terminal_failed', failureCode: 'GENERIC_SUBMIT_REQUIRED' });
    const events = await committedEvents(env);
    expect(events.filter((event) => event.type === 'structured_generic_agent_attempt_completed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'structured_work_item_completed')).toHaveLength(1); // only the seal's
  }, 60_000);

  it('rejects an unreachable delivery through the REAL validator (poisoned resolver) with NO partial write', async () => {
    const fixture = await prepareDeliveryFixture();
    const { env } = fixture;
    const terminalFailCalls: TerminalFailInputV2[] = [];
    const composition = installComposition(fixture, {
      // The delivery blob becomes unresolvable -> delivery_missing -> terminal.
      resolver: async (taskId, ref) => {
        if (ref.kind === 'system_artifact_delivery') return null;
        return env.blobStore.readJson(taskId, ref, ref.kind);
      },
      terminalFail: async (_taskId, input) => { terminalFailCalls.push(input); },
    });

    const outcome = await composition.attempts.runNext(TASK, SUBMITTER_AGENT);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      kind: 'terminal_failed',
      failureCode: 'FINAL_SUBMIT_UNREACHABLE:delivery_missing',
    });
    const events = await committedEvents(env);
    // The final commit + submitter completion never landed; the seal's own
    // completion is the only work_item_completed.
    expect(events.filter((event) => event.type === 'structured_generic_agent_attempt_completed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'structured_work_item_completed')).toHaveLength(1);
    expect(terminalFailCalls).toHaveLength(1);
    expect(terminalFailCalls[0]!.failureCode).toBe('FINAL_SUBMIT_UNREACHABLE:delivery_missing');
    expect(terminalFailCalls[0]!.attemptId).not.toBeNull();
  }, 60_000);

  it('rejects a stale/other-unreachable submission through the coordinator fail-closed routing', async () => {
    const fixture = await prepareDeliveryFixture();
    const { env } = fixture;
    const terminalFailCalls: TerminalFailInputV2[] = [];
    // A direct coordinator whose finalSubmission seam returns UNREACHABLE proves
    // the routing converts a rejected reachability into a terminal failure with
    // NO partial write (the seam itself is unit-tested per reason).
    const stubReachability: FinalSubmissionReachabilityV2 = { reachable: false, reason: 'delivery_stale' };
    const attempts = new V2AttemptCoordinator({
      coordinator: env.coordinator,
      runner: submitterRunner('submit'),
      agentForRole: async (_taskId, roleBinding) => (roleBinding === SUBMITTER_AGENT ? frozenV2.agents[0] ?? null : null),
      frozenFor: async () => frozenV2,
      wakeups: new AuthoritativeWakeupIndexV1({ paths: env.paths }),
      traces: new TraceStore(env.paths),
      clock: () => env.now.value,
      terminalFail: async (_taskId, input) => { terminalFailCalls.push(input); },
      finalSubmission: { async validateFinalSubmission() { return stubReachability; } },
    });

    const outcome: V2AttemptOutcome = await attempts.runNext(TASK, SUBMITTER_AGENT);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      kind: 'terminal_failed',
      failureCode: 'FINAL_SUBMIT_UNREACHABLE:delivery_stale',
    });
    const events = await committedEvents(env);
    expect(events.filter((event) => event.type === 'structured_generic_agent_attempt_completed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'structured_work_item_completed')).toHaveLength(1); // only the seal's
    expect(terminalFailCalls).toHaveLength(1);
    expect(terminalFailCalls[0]!.failureCode).toBe('FINAL_SUBMIT_UNREACHABLE:delivery_stale');
  }, 60_000);
});
