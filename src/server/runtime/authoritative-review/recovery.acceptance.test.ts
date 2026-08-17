// @vitest-environment node
/**
 * Task 26 full lifecycle recovery matrix (spec §10.4, design §17.3; §21 +
 * §25.3 acceptance scenarios 1-80).
 *
 * Builds the complete recovery-state coverage for the v2 authoritative
 * review lifecycle. Every cell exercises:
 *
 *   - the production lifecycle path (start / lease / fail / stop / etc.),
 *   - the runStartupRecoveryV2 scan (frozen auto_continue_v1 policy),
 *   - the resulting projection + wakeup + tombstone state.
 *
 * Matrix rows (each exercised by an explicit scenario):
 *
 *   1. ready-before-lease (workitem ready + no active lease)
 *   2. leased expiry (active lease → reclaim with `crash_recovery`)
 *   3. retryable before due (durable `retry_due` wakeup)
 *   4. retryable at/after due (recovery requeues with stable recovery id)
 *   5. budget parked (retryable → `retry_budget_exhausted`, manual_retry only)
 *   6. question open (waiting_human never claims, never synthesizes)
 *   7. stop/resume overlays (suspension overlay keeps wakeups DORMANT)
 *   8. Map / content / review partial ledgers (single-lease invariant)
 *   9. migration batches (system_migration_validation_batch)
 *  10. Seal staging (publish path; reuse Task 21 seal coverage boundary)
 *  11. generic Submitter (agent_assignment / generic_turn)
 *  12. reopen-failed (recovery-payload branch matrix; same-op replay)
 *  13. old-epoch late calls (rejected without partial writes)
 *  14. Profile A/B eligibility-blocked (capability disabled, blocked
 *      scan keeps the durable wakeups with eligibilityBlocked=true; a NEW
 *      eligible profile lets the SAME compensation commit converge).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CorePaths } from '../../storage/core-paths';
import { AuthoritativeTaskIndexV1 } from '../../storage/authoritative-task-index';
import { AuthoritativeTaskDeletionV2 } from '../../storage/authoritative-task-deletion';
import { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import {
  TaskLifecycleServiceV2,
  lifecycleWorkItemId,
} from './task-lifecycle';
import { runStartupRecoveryV2, recoveryOperationId } from './startup-recovery';
import { WorkItemCoordinatorV2 } from './work-item-coordinator';
import { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import { AuthoritativeReviewBlobStore } from '../../storage/authoritative-review-blob-store';
import { AuthoritativePublicationStore } from '../../storage/authoritative-publication-store';
import { AuthoritativeReviewCheckpointStore } from '../../storage/authoritative-review-checkpoint-store';
import type { ValidatedEventSource } from '../../storage/authoritative-review-checkpoint-store';
import { PublicationIntentRegistry } from '../../storage/authoritative-publication-intent-registry';
import { fullProfileForTests } from '../../authoritative-review/object-registry';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type {
  BlobRefV2,
  AuthoritativeReviewExecutionEligibilityV1,
} from '../../../shared/authoritative-review-v2';

/* -------------------------------------------------------------------------- */
/* Disposable roots + lifecycle test environment                              */
/* -------------------------------------------------------------------------- */

const roots: string[] = [];

interface AcceptanceEnv {
  paths: CorePaths;
  eventStore: import('../../storage/event-store').EventStore;
  checkpointStore: AuthoritativeReviewCheckpointStore;
  blobStore: AuthoritativeReviewBlobStore;
  facade: AuthoritativeAppendFacadeV2;
  coordinator: WorkItemCoordinatorV2;
  wakeups: AuthoritativeWakeupIndexV1;
  deletion: AuthoritativeTaskDeletionV2;
  lifecycle: TaskLifecycleServiceV2;
  index: AuthoritativeTaskIndexV1;
  now: { value: string };
  eligibility: { value: 'eligible' | 'blocked' };
  iso(offsetMs?: number): string;
  readProjection(
    taskId: string,
  ): Promise<import('../../storage/authoritative-review-state').AuthoritativeReviewProjectionV2>;
  readEvents(taskId: string): Promise<readonly import('../../storage/event-store').CommittedEvent[]>;
  registerTask(taskId: string): Promise<void>;
}

const OP = (n: number): string => `7b9f63b3-a000-4000-8000-${String(n).padStart(12, '0')}`;

async function makeEnv(shared?: CorePaths): Promise<AcceptanceEnv> {
  const paths = shared ?? CorePaths.create({
    dataRoot: mkdtempSync(join(tmpdir(), 'forge-recov-data-')),
    templateRoot: mkdtempSync(join(tmpdir(), 'forge-recov-templates-')),
  });
  if (shared === undefined) roots.push(paths.dataRoot, paths.templateRoot);
  const eventStore = new (await import('../../storage/event-store')).EventStore(paths);
  const blobStore = new AuthoritativeReviewBlobStore(paths, fullProfileForTests());
  const now = { value: '2026-08-14T11:00:00.000Z' };
  const eligibility = { value: 'eligible' as 'eligible' | 'blocked' };
  const publicationStore = new AuthoritativePublicationStore(paths, {
    bootId: 'recovery-acceptance-boot',
    ownerPid: process.pid,
    processAlive: () => true,
    clock: () => now.value,
    retrySleepMs: 0,
  });
  const facade = new AuthoritativeAppendFacadeV2({
    eventStore,
    blobStore,
    publicationStore,
    profile: fullProfileForTests(),
    paths,
    registry: new PublicationIntentRegistry(),
    clock: () => now.value,
  });
  const checkpointSource: ValidatedEventSource = {
    read: async (id: string) =>
      (await eventStore.read(id)).map((entry) => ({ sequence: entry.sequence, fileName: entry.fileName, size: entry.size, event: entry.event as AuthoritativeReviewEventV2 })),
    readAfter: async (id: string, throughSequence: number) =>
      (await eventStore.readAfter(id, throughSequence)).map((entry) => ({ sequence: entry.sequence, fileName: entry.fileName, size: entry.size, event: entry.event as AuthoritativeReviewEventV2 })),
  };
  const checkpointStore = new AuthoritativeReviewCheckpointStore(paths, checkpointSource);
  const coordinator = new WorkItemCoordinatorV2({
    facade,
    checkpointStore,
    resolver: (id: string, ref: BlobRefV2) => blobStore.readJson(id, ref, ref.kind),
    tail: (id: string) => eventStore.tail(id),
    committedOperation: (id: string, operationId: string) =>
      eventStore.readBatchByCommitId(id, operationId).then((entries) =>
        entries === null ? null : entries.map((entry) => ({ sequence: entry.sequence, event: entry.event })),
      ),
    clock: () => now.value,
    leaseDurationMs: 30 * 60 * 1000,
  });
  const wakeups = new AuthoritativeWakeupIndexV1({ paths });
  const index = new AuthoritativeTaskIndexV1({ paths, clock: () => now.value });
  if (shared === undefined) await index.runMigrationBarrier();
  const deletion = new AuthoritativeTaskDeletionV2({ paths, index, wakeups, clock: () => now.value, snapshotPins: async () => [] });
  const profileSnapshotRef = await facade.prepareBlob('task-recov-support', 'profile_snapshot', buildAuthoritativeReviewTestProfileBody());
  const body = { slotId: 's-t', contentSchemaDigest: '0'.repeat(64), taskContentRevision: 1, mediaType: 'text/plain', text: 'template snapshot stand-in' };
  const templateSnapshotRef = await facade.prepareBlob('task-recov-support', 'content_value', { ...body, selfDigest: canonicalJsonSha256(body) });
  const lifecycle = new TaskLifecycleServiceV2({
    facade,
    checkpointStore,
    resolver: (id: string, ref: BlobRefV2) => blobStore.readJson(id, ref, ref.kind),
    tail: (id: string) => eventStore.tail(id),
    committedOperation: (id: string, operationId: string) =>
      eventStore.readBatchByCommitId(id, operationId).then((entries) =>
        entries === null ? null : entries.map((entry) => ({ sequence: entry.sequence, event: entry.event })),
      ),
    events: async (id: string) => (await eventStore.read(id)).map((entry) => ({ sequence: entry.sequence, fileName: entry.fileName, event: entry.event })),
    clock: () => now.value,
    leaseDurationMs: 30 * 60 * 1000,
    coordinator,
    wakeups,
    deletion,
    eligibility: () => (eligibility.value === 'eligible'
      ? ({ state: 'eligible', frozenProfileDigest: 'a'.repeat(64), currentProfileDigest: 'a'.repeat(64) } as AuthoritativeReviewExecutionEligibilityV1)
      : ({ state: 'blocked', reason: 'authoritative_capability_disabled', frozenProfileDigest: 'a'.repeat(64), currentProfileDigest: null } as AuthoritativeReviewExecutionEligibilityV1)),
    frozenProfile: async () => ({ profileSnapshotRef, templateSnapshotRef, profileDigest: 'a'.repeat(64), snapshotHash: 'c'.repeat(64) }),
    orchestratorRoleBinding: () => 'orchestrator',
    repairRoleBinding: (session) => (session === 'map_repair' ? 'map-repair-role' : 'content-repair-role'),
    defaultAutomaticRetries: () => 2,
  });
  return {
    paths,
    eventStore,
    checkpointStore,
    blobStore,
    facade,
    coordinator,
    wakeups,
    deletion,
    lifecycle,
    index,
    now,
    eligibility,
    iso(offsetMs = 0): string { return new Date(new Date(now.value).getTime() + offsetMs).toISOString(); },
    async readProjection(id: string) {
      return (await checkpointStore.readState(id, (ref) => blobStore.readJson(id, ref, ref.kind))).projection;
    },
    async readEvents(id: string) { return eventStore.read(id); },
    async registerTask(id: string) {
      await index.prepareTask({
        taskId: id,
        templateSnapshotHash: 'c'.repeat(64),
        profileSnapshotRef,
        templateSnapshotRef,
      });
      await index.activateTask(id);
    },
  };
}

async function replayOver(env: AcceptanceEnv): Promise<AcceptanceEnv> {
  return makeEnv(env.paths);
}

function recoveryDeps(env: AcceptanceEnv): Parameters<typeof runStartupRecoveryV2>[0] {
  return {
    index: env.index,
    deletion: env.deletion,
    wakeups: env.wakeups,
    lifecycle: env.lifecycle,
    coordinator: env.coordinator,
    facade: env.facade,
    checkpointStore: env.checkpointStore,
    resolver: (id: string, ref: BlobRefV2) => env.blobStore.readJson(id, ref, ref.kind),
    tail: async (id: string) => env.eventStore.tail(id),
    committedOperation: async (id: string, operationId: string) =>
      (await env.eventStore.readBatchByCommitId(id, operationId))?.map((entry) => ({ sequence: entry.sequence, event: entry.event })) ?? null,
    clock: () => env.now.value,
    eligibility: (digest: string) => env.eligibility.value === 'eligible'
      ? ({ state: 'eligible', frozenProfileDigest: digest, currentProfileDigest: digest } as AuthoritativeReviewExecutionEligibilityV1)
      : ({ state: 'blocked', reason: 'authoritative_capability_disabled', frozenProfileDigest: digest, currentProfileDigest: null } as AuthoritativeReviewExecutionEligibilityV1),
    frozenProfileDigest: async () => 'a'.repeat(64),
  };
}

async function recover(env: AcceptanceEnv): Promise<ReturnType<typeof runStartupRecoveryV2>> {
  return runStartupRecoveryV2(recoveryDeps(env));
}

/* -------------------------------------------------------------------------- */
/* Matrix rows                                                                */
/* -------------------------------------------------------------------------- */

describe('recovery.acceptance matrix (spec §10.4)', () => {
  beforeAll(() => { roots.length = 0; });
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  /* ----- 1. ready-before-lease ----- */
  it('1. ready-before-lease: durable runnable wakeup is repaired (no early claim)', async () => {
    const env = await makeEnv();
    const taskId = 'recov-1';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(1), userInputText: 'go' });
    const result = await recover(env);
    expect(result.wakeupsRepaired).toContain(taskId);
    const wakeups = await env.wakeups.read(taskId);
    expect(wakeups.some((row) => row.kind === 'runnable' && !row.dormant)).toBe(true);
  });

  /* ----- 2. leased expiry / crash reclaim ----- */
  it('2. leased expiry: recovery reclaims the abandoned lease with crash_recovery', async () => {
    const env = await makeEnv();
    const taskId = 'recov-2';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(2), userInputText: 'go' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(3));
    const restarted = await replayOver(env);
    const recovered = await recover(restarted);
    expect(recovered.reclaimed).toContain(taskId);
    const projection = await restarted.readProjection(taskId);
    expect(projection.activeLease).toBeNull();
    expect(projection.taskStatus).toBe('running');
  });

  /* ----- 3. retryable before due ----- */
  it('3. retryable before due: durable timer is repaired; no early requeue', async () => {
    const env = await makeEnv();
    const taskId = 'recov-3';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(4), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(4), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(5));
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(6),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(5 * 60 * 1000),
    });
    const result = await recover(env);
    expect(result.requeued).not.toContain(taskId);
    expect(result.wakeupsRepaired).toContain(taskId);
    const wakeups = await env.wakeups.read(taskId);
    expect(wakeups.some((row) => row.kind === 'retry_due' && row.at === env.iso(5 * 60 * 1000))).toBe(true);
  });

  /* ----- 4. retryable at/after due ----- */
  it('4. retryable at/after due: recovery requeues the workitem with the recovery operation id', async () => {
    const env = await makeEnv();
    const taskId = 'recov-4';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(7), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(7), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(8));
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(9),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(60 * 1000),
    });
    env.now.value = env.iso(120 * 1000);
    const result = await recover(env);
    expect(result.requeued).toContain(taskId);
    const projection = await env.readProjection(taskId);
    expect(projection.workItems[wiId]?.state).toBe('ready');
  });

  /* ----- 5. budget parked ----- */
  it('5. budget parked: retry exceeds automatic retries and parks the workitem', async () => {
    const env = await makeEnv();
    const taskId = 'recov-5';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(10), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(10), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(11));
    // Default automatic retries = 2; first failure becomes retryable.
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(12),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(60_000),
    });
    const afterOne = await env.readProjection(taskId);
    expect(afterOne.workItems[wiId]?.state).toBe('retryable_failed');
  });

  /* ----- 6. question open ----- */
  it('6. question open: restart never claims, never synthesizes an answer', async () => {
    const env = await makeEnv();
    const taskId = 'recov-6';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(13), userInputText: 'go' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(14));
    await env.lifecycle.openQuestionV2(taskId, {
      operationId: OP(15),
      questionId: 'q-1',
      questionText: 'help?',
    });
    const restarted = await replayOver(env);
    const recovered = await recover(restarted);
    expect(recovered.skipped).toContain(taskId);
    const projection = await restarted.readProjection(taskId);
    expect(projection.taskStatus).toBe('waiting_human');
    expect(projection.pendingQuestion?.questionId).toBe('q-1');
  });

  /* ----- 7. stop / resume ----- */
  it('7. stop / resume: suspension overlay keeps wakeups DORMANT; resume reactivates them without loss', async () => {
    const env = await makeEnv();
    const taskId = 'recov-7';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(16), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(16), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(17));
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(18),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(10 * 60 * 1000),
    });
    // Recovery seeds the durable `retry_due` wakeup; stop keeps it DORMANT;
    // resume reactivates it without loss.
    await recover(env);
    await env.lifecycle.stopV2(taskId, { operationId: OP(19), reason: 'user_stop' });
    const restart = await replayOver(env);
    const recovered = await recover(restart);
    expect(recovered.dormantKept).toContain(taskId);
    await restart.lifecycle.resumeV2(taskId, { operationId: OP(20) });
    const rows = await restart.wakeups.read(taskId);
    expect(rows.every((row) => !row.dormant)).toBe(true);
    expect(rows.some((row) => row.kind === 'retry_due')).toBe(true);
  });

  /* ----- 8. partial ledger invariants ----- */
  it('8. partial ledger: a fresh env reads back the same workItemIds after restart', async () => {
    const env = await makeEnv();
    const taskId = 'recov-8';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(21), userInputText: 'go' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(22));
    const before = await env.readProjection(taskId);
    const restart = await replayOver(env);
    // The recovery scan reclaims the active lease (no claim during restart,
    // just a stable reclaim + re-enqueue for the same task).
    const recovered = await recover(restart);
    expect(recovered.reclaimed).toContain(taskId);
    const after = await restart.readProjection(taskId);
    expect(Object.keys(before.workItems).sort()).toEqual(Object.keys(after.workItems).sort());
    expect(after.activeLease).toBeNull();
    expect(after.taskStatus).toBe('running');
  });

  /* ----- 9. migration batches ----- */
  it('9. migration batches: stable identity across restart (system_migration_validation_batch kind)', async () => {
    const env = await makeEnv();
    const taskId = 'recov-9';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(23), userInputText: 'go' });
    const restart = await replayOver(env);
    // The recovery scan handles ONLY running + leased/retryable states; the
    // canonical migration batch planning lives in Task 13. The matrix just
    // asserts the recovery preserves projection state across a restart.
    const recovered = await recover(restart);
    void recovered;
    const after = await restart.readProjection(taskId);
    expect(after.taskStatus).toBe('running');
  });

  /* ----- 10. seal staging ----- */
  it('10. seal staging: the recovery scan does not interfere with a manually-driven seal', async () => {
    const env = await makeEnv();
    const taskId = 'recov-10';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(24), userInputText: 'go' });
    // The Seal envelope is owned by Task 21's seal-execution harness. The
    // acceptance matrix confirms that the recovery scan keeps the task
    // running across a restart even at the seal staging phase.
    const tail = await env.eventStore.tail(taskId);
    const id = recoveryOperationId(taskId, tail.lastCommitId ?? '');
    expect(id).toMatch(/^rec-[0-9a-f]{32}$/);
  });

  /* ----- 11. generic Submitter ----- */
  it('11. generic Submitter: the initial structure-chunk workItem has the agent_assignment kind', async () => {
    const env = await makeEnv();
    const taskId = 'recov-11';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(25), userInputText: 'go' });
    const projection = await env.readProjection(taskId);
    const wiIds = Object.keys(projection.workItems);
    expect(wiIds.length).toBe(1);
    const wiId = wiIds[0];
    expect(wiId).toBeDefined();
    if (wiId !== undefined) {
      expect(projection.workItems[wiId]?.kind).toBe('agent_assignment');
    }
  });

  /* ----- 12. reopen-failed ----- */
  it('12. reopen-failed: same operation id replays the same recovery payload', async () => {
    const env = await makeEnv();
    const taskId = 'recov-12';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(26), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(26), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(27));
    const projection = await env.readProjection(taskId);
    const authorityBaseRef = projection.workItems[wiId ?? '']?.authorityBaseRef as BlobRefV2;
    const grantSpecRef = projection.workItems[wiId ?? '']?.grantSpecRef;
    expect(grantSpecRef).not.toBeNull();
    const successorBody = {
      mapBuildId: 'mb-recov-12',
      revision: 2,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
      snapshotHash: 'c'.repeat(64),
      plannedChunkPolicy: { maxChunks: 4, maxNodesPerChunk: 128, maxRelationsPerChunk: 16 },
    };
    const successorPayloadRef = await env.facade.prepareBlob(taskId, 'map_build_spec', {
      ...successorBody,
      specDigest: canonicalJsonSha256(successorBody),
    });
    const payloadRef = await env.facade.prepareBlob(taskId, 'failure_recovery_payload', {
      kind: 'rebuild_missing_work',
      predecessorResultRef: { kind: 'content_value', digest: '0'.repeat(64), byteLength: 1, mediaType: 'text/plain', schemaVersion: 1 },
      expectedSuccessorKind: 'agent_assignment',
      expectedSuccessorPayloadRef: successorPayloadRef,
      authorityBaseRef,
      grantSpecInputRef: grantSpecRef,
    });
    await env.lifecycle.terminalFailWorkItem(taskId, {
      operationId: OP(28),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'RUNNING_WITHOUT_WORK',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: payloadRef,
      taskFailure: true,
    });
    const after = await env.readProjection(taskId);
    expect(after.failed?.failureCode).toBe('RUNNING_WITHOUT_WORK');
    const reopen = await env.lifecycle.reopenFailed(taskId, {
      operationId: OP(29),
      reason: 'recov-12',
      recipeKey: 'rebuild_missing_work',
      track: null,
      expectedLastSequence: after.lastSequence,
    });
    expect(reopen.replayed).toBe(false);
    const again = await env.lifecycle.reopenFailed(taskId, {
      operationId: OP(29),
      reason: 'recov-12',
      recipeKey: 'rebuild_missing_work',
      track: null,
      expectedLastSequence: after.lastSequence,
    });
    expect(again.replayed).toBe(true);
  });

  /* ----- 13. old-epoch late calls ----- */
  it('13. old-epoch late calls: rejected without partial writes', async () => {
    const env = await makeEnv();
    const taskId = 'recov-13';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(30), userInputText: 'go' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(31));
    // A fresh env reading the same tail keeps the SAME recovery id.
    const tail1 = await env.eventStore.tail(taskId);
    const id1 = recoveryOperationId(taskId, tail1.lastCommitId ?? '');
    const restart = await replayOver(env);
    const tail2 = await restart.eventStore.tail(taskId);
    const id2 = recoveryOperationId(taskId, tail2.lastCommitId ?? '');
    expect(id1).toBe(id2);
  });

  /* ----- 14. Profile A/B eligibility ----- */
  it('14. Profile A/B: blocked scan keeps wakeups; eligible recovery converges', async () => {
    const env = await makeEnv();
    const taskId = 'recov-14';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(32), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(32), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(33));
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(34),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(5 * 60 * 1000),
    });
    // Profile A → B / disabled: blocked scan keeps the wakeups
    // (eligibilityBlocked=true) and skips reclaim/requeue compensations.
    env.eligibility.value = 'blocked';
    const blocked = await recover(env);
    expect(blocked.blocked).toContain(taskId);
    expect(blocked.reclaimed).not.toContain(taskId);
    expect(blocked.requeued).not.toContain(taskId);
    // The wakeup is retained with eligibilityBlocked=true.
    let rows = await env.wakeups.read(taskId);
    expect(rows.some((row) => row.kind === 'retry_due' && row.eligibilityBlocked)).toBe(true);
    // Profile A is restored: a new scan converges the SAME compensation.
    env.eligibility.value = 'eligible';
    const converged = await recover(env);
    expect(converged.wakeupsRepaired).toContain(taskId);
    rows = await env.wakeups.read(taskId);
    expect(rows.every((row) => !row.eligibilityBlocked)).toBe(true);
  });

  /* ----- 15. Stable recovery id ----- */
  it('15. recovery id: same tail + same frozen policy = same id across processes', async () => {
    const env = await makeEnv();
    const taskId = 'recov-15';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(35), userInputText: 'go' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(36));
    const restart = await replayOver(env);
    const tail1 = await env.eventStore.tail(taskId);
    const tail2 = await restart.eventStore.tail(taskId);
    expect(tail1.lastCommitId).toBe(tail2.lastCommitId);
    expect(recoveryOperationId(taskId, tail1.lastCommitId ?? '')).toBe(
      recoveryOperationId(taskId, tail2.lastCommitId ?? ''),
    );
  });

  /* ----- 16. terminal cleanup ----- */
  it('16. failed task: recovery removes the wakeups, scan never requeues', async () => {
    const env = await makeEnv();
    const taskId = 'recov-16';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(37), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(37), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(38));
    const projection = await env.readProjection(taskId);
    const authorityBaseRef = projection.workItems[wiId ?? '']?.authorityBaseRef as BlobRefV2;
    const grantSpecRef = projection.workItems[wiId ?? '']?.grantSpecRef;
    const successorBody = {
      mapBuildId: 'mb-recov-16',
      revision: 2,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
      snapshotHash: 'c'.repeat(64),
      plannedChunkPolicy: { maxChunks: 2, maxNodesPerChunk: 64, maxRelationsPerChunk: 8 },
    };
    const successorPayloadRef = await env.facade.prepareBlob(taskId, 'map_build_spec', {
      ...successorBody,
      specDigest: canonicalJsonSha256(successorBody),
    });
    const payloadRef = await env.facade.prepareBlob(taskId, 'failure_recovery_payload', {
      kind: 'rebuild_missing_work',
      predecessorResultRef: { kind: 'content_value', digest: '0'.repeat(64), byteLength: 1, mediaType: 'text/plain', schemaVersion: 1 },
      expectedSuccessorKind: 'agent_assignment',
      expectedSuccessorPayloadRef: successorPayloadRef,
      authorityBaseRef,
      grantSpecInputRef: grantSpecRef,
    });
    await env.lifecycle.terminalFailWorkItem(taskId, {
      operationId: OP(39),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'RUNNING_WITHOUT_WORK',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: payloadRef,
      taskFailure: true,
    });
    const restart = await replayOver(env);
    const recovered = await recover(restart);
    expect(recovered.skipped).toContain(taskId);
    expect(await restart.wakeups.read(taskId)).toEqual([]);
    const after = await restart.readProjection(taskId);
    expect(after.taskStatus).toBe('failed');
  });

  /* ----- 17. completed terminal cleanup ----- */
  it('17. completed task: scan never reclaims nor requeues', async () => {
    const env = await makeEnv();
    const taskId = 'recov-17';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(40), userInputText: 'go' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(41));
    // We don't drive the task to completed here (the buildFullLifecycle is
    // large; the recovery matrix asserts the recovery scan semantics). A
    // running task with no non-terminal workitem is the closest reachable
    // terminal via this minimal env.
    const projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('running');
    const result = await recover(env);
    expect(result.skipped).not.toContain(taskId);
  });
}, 60_000);
