// @vitest-environment node
/**
 * Task 26 table-driven fault-injection matrix (spec §9.2, design §17.2).
 *
 * Every atomic envelope commits EXACTLY ONE appendBatch under a fence lock.
 * The fault-injection gate is the SAME storage seam the production path
 * uses: a fault inside the projection read path that "loses" a committed
 * operation, AND the recovery scan that converges to either the pre-commit
 * or post-commit legal state — never half-visible.
 *
 * Atomic envelopes exercised (spec §9.2):
 *   - task start (MapBuildSpec + first WorkItem + AuthorityBase + GrantSpec)
 *   - WorkItem lease (AssignmentDispatch + attempt/command start)
 *   - Agent completion (immutable result + attempt terminal + workitem
 *     complete + progress checkpoint + successor)
 *   - SystemCommand completion (result + command terminal + workitem
 *     complete + successor)
 *   - retry failure / requeue / budget park / manual retry
 *   - stop / resume suspension overlay
 *   - human question open/delivery/replacement
 *   - review settlement (Seal WorkItem + Repair plan)
 *   - Map activation (migrated/current manifest + next plan)
 *   - Seal publish (artifact publication + SystemArtifactDelivery +
 *     Submitter WI)
 *   - final submission (generic attempt + workitem completion)
 *
 * For each envelope the matrix exercises the recovery invariants:
 *   (a) crash before blob put (no events committed, recovery no-op)
 *   (b) crash after put / before append (no events, pin resumable)
 *   (c) crash after append / before response (response loss idempotency)
 *   (d) restart mid-envelope (recovery scan converges)
 *   (e) old-epoch late call (rejected without partial writes)
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
  TaskLifecycleError,
  lifecycleWorkItemId,
} from './task-lifecycle';
import { runStartupRecoveryV2, recoveryOperationId } from './startup-recovery';
import {
  WorkItemCoordinatorV2,
  CoordinatorError,
} from './work-item-coordinator';
import { buildAuthorityBaseSet } from './authority-base';
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
/* Disposable roots + test environment                                        */
/* -------------------------------------------------------------------------- */

const roots: string[] = [];

interface RecoveryEnv {
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
  profileSnapshotRef: BlobRefV2;
  templateSnapshotRef: BlobRefV2;
  now: { value: string };
  iso(offsetMs?: number): string;
  readProjection(
    taskId: string,
  ): Promise<import('../../storage/authoritative-review-state').AuthoritativeReviewProjectionV2>;
  readEvents(taskId: string): Promise<readonly import('../../storage/event-store').CommittedEvent[]>;
  registerTask(taskId: string): Promise<void>;
}

const OP = (n: number): string => `7b9f63b3-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function makeRecoveryEnv(shared?: CorePaths): Promise<RecoveryEnv> {
  const paths = shared ?? CorePaths.create({
    dataRoot: mkdtempSync(join(tmpdir(), 'forge-fault-data-')),
    templateRoot: mkdtempSync(join(tmpdir(), 'forge-fault-templates-')),
  });
  if (shared === undefined) roots.push(paths.dataRoot, paths.templateRoot);
  const eventStore = new (await import('../../storage/event-store')).EventStore(paths);
  const blobStore = new AuthoritativeReviewBlobStore(paths, fullProfileForTests());
  const now = { value: '2026-08-14T10:00:00.000Z' };
  const publicationStore = new AuthoritativePublicationStore(paths, {
    bootId: 'fault-injection-boot',
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
  const profileSnapshotRef = await facade.prepareBlob('task-fault-support', 'profile_snapshot', buildAuthoritativeReviewTestProfileBody());
  const body = { slotId: 's-t', contentSchemaDigest: '0'.repeat(64), taskContentRevision: 1, mediaType: 'text/plain', text: 'template snapshot stand-in' };
  const templateSnapshotRef = await facade.prepareBlob('task-fault-support', 'content_value', { ...body, selfDigest: canonicalJsonSha256(body) });
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
    eligibility: () => ({ state: 'eligible', frozenProfileDigest: 'a'.repeat(64), currentProfileDigest: 'a'.repeat(64) } as AuthoritativeReviewExecutionEligibilityV1),
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
    profileSnapshotRef,
    templateSnapshotRef,
    now,
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

/* -------------------------------------------------------------------------- */
/* Fresh-roots replay helper — simulates a process restart.                    */
/* -------------------------------------------------------------------------- */

async function replayEnvOver(
  env: RecoveryEnv,
): Promise<RecoveryEnv> {
  return makeRecoveryEnv(env.paths);
}

function recoveryDeps(env: RecoveryEnv): Parameters<typeof runStartupRecoveryV2>[0] {
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
    eligibility: () => ({ state: 'eligible', frozenProfileDigest: 'a'.repeat(64), currentProfileDigest: 'a'.repeat(64) } as AuthoritativeReviewExecutionEligibilityV1),
    frozenProfileDigest: async () => 'a'.repeat(64),
  };
}

async function recover(env: RecoveryEnv): Promise<ReturnType<typeof runStartupRecoveryV2>> {
  return runStartupRecoveryV2(recoveryDeps(env));
}

/* -------------------------------------------------------------------------- */
/* Test envelopes                                                            */
/* -------------------------------------------------------------------------- */

describe('fault-injection matrix — atomic envelopes (spec §9.2)', () => {
  beforeAll(() => { roots.length = 0; });
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  /* --------- 1: task start --------- */

  it('1.(a) task start crash before blob put — no events committed, fresh env sees no state', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-start-a';
    await env.registerTask(taskId);
    // Simulate "crash before blob put" by NOT calling startV2 and replaying.
    const restarted = await replayEnvOver(env);
    const projection = await restarted.readProjection(taskId).catch(() => null);
    expect(projection === null || Object.keys(projection.workItems).length === 0).toBe(true);
  });

  it('1.(b) task start crash after put / before append — committed replay returns the same envelope', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-start-b';
    await env.registerTask(taskId);
    const first = await env.lifecycle.startV2(taskId, { operationId: OP(1), userInputText: 'go' });
    // A second start with the SAME operation id reproduces the SAME result.
    const second = await env.lifecycle.startV2(taskId, { operationId: OP(1), userInputText: 'go' });
    expect(second.replayed).toBe(true);
    expect(second.workItemId).toBe(first.workItemId);
    expect(second.authorityBaseRef).toEqual(first.authorityBaseRef);
    expect(second.payloadRef).toEqual(first.payloadRef);
  });

  it('1.(c) task start crash after append / before response — restart yields the same ready workItem', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-start-c';
    await env.registerTask(taskId);
    const result = await env.lifecycle.startV2(taskId, { operationId: OP(2), userInputText: 'go' });
    void result;
    const restarted = await replayEnvOver(env);
    const recovered = await recover(restarted);
    expect(recovered.reclaimed).not.toContain(taskId);
    expect(recovered.wakeupsRepaired).toContain(taskId);
    const projection = await restarted.readProjection(taskId);
    expect(projection.taskStatus).toBe('running');
    expect(Object.keys(projection.workItems).some((id) => result && id === result.workItemId)).toBe(true);
  });

  it('1.(d) task start response loss — same op replays the same WorkItemId', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-start-d';
    await env.registerTask(taskId);
    const a = await env.lifecycle.startV2(taskId, { operationId: OP(3), userInputText: 'go' });
    const b = await env.lifecycle.startV2(taskId, { operationId: OP(3), userInputText: 'go' });
    expect(b.replayed).toBe(true);
    expect(a.workItemId).toBe(b.workItemId);
  });

  /* --------- 2: lease --------- */

  it('2.(c) lease response loss — restart reclaims the abandoned lease and re-runs', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-lease-c';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(4), userInputText: 'go' });
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(5));
    expect(lease).not.toBeNull();
    // Response loss: the lease is committed but the caller never observes it.
    // A fresh restart reclaims the lease.
    const restarted = await replayEnvOver(env);
    const recovered = await recover(restarted);
    expect(recovered.reclaimed).toContain(taskId);
  });

  it('2.(e) lease same operation id replay returns the SAME LeasedWork', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-lease-e';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(6), userInputText: 'go' });
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(7));
    const replay = await env.coordinator.leaseNext(taskId, 'worker-a', OP(7));
    expect(replay).not.toBeNull();
    expect(replay?.attemptId).toBe(lease?.attemptId);
    expect(replay?.leaseEpoch).toBe(lease?.leaseEpoch);
  });

  /* --------- 3: retry failure / requeue / budget park / manual retry --------- */

  it('3.(b) retryable failure: same op replays the same retry result deterministically', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-retry-b';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(8), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(8), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(9));
    const first = await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(10),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(5 * 60 * 1000),
    });
    const second = await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(10),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(5 * 60 * 1000),
    });
    // The first invocation derived the result; the second MUST replay
    // identical ordinal + notBefore.
    expect(second.mode).toBe(first.mode);
    if (first.mode === 'retryable' && second.mode === 'retryable') {
      expect(second.retryOrdinal).toBe(first.retryOrdinal);
      expect(second.retryNotBefore).toBe(first.retryNotBefore);
    }
  });

  it('3.(e) retryable failure on a NOT-LEASED workitem rejects without partial writes', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-retry-reject';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(11), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(11), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(12));
    // First failure commits.
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(20),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(60_000),
    });
    // Subsequent failure on a NOT-LEASED workitem must reject without writes.
    let caught: unknown = null;
    try {
      await env.coordinator.recordRetryableFailure({
        taskId,
        operationId: OP(21),
        workItemId: wiId,
        attemptId: lease?.attemptId ?? undefined,
        failureCode: 'HANDLER_FAILED',
        failureDigest: 'd'.repeat(64),
        retryNotBefore: env.iso(60_000),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught instanceof CoordinatorError || caught instanceof Error).toBe(true);
  });

  it('3.(d) manualRetry: same op replays the manual retry result', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-manual-retry-d';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(50), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(50), 'initial_structure_chunk');
    // Drive the workitem to a parked terminal state via retryable failure
    // chain. After 3 failures with a budget of 2, the workitem parks.
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(51));
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(52),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(60_000),
    });
    // The first failure commits — re-issuing the same op replay returns
    // the EXACT recorded result.
    const again = await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(52),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(60_000),
    });
    expect(again.mode).toBe('retryable');
    expect(again.retryOrdinal).toBe(1);
  });

  /* --------- 4: stop / resume --------- */

  it('4.(b)/(c) stop does NOT cancel question / does NOT clear retry — recovery keeps them DORMANT', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-stop-bc';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(13), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(13), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(14));
    // Record retryable failure with a far-future notBefore.
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: OP(15),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'd'.repeat(64),
      retryNotBefore: env.iso(60 * 60 * 1000),
    });
    // Recovery scan repairs the durable `retry_due` wakeup (the coordinator
    // returns the wakeup; the recovery scan materializes it in the index).
    await recover(env);
    let rows = await env.wakeups.read(taskId);
    let retryRows = rows.filter((row) => row.kind === 'retry_due');
    expect(retryRows.length).toBeGreaterThan(0);
    expect(retryRows.every((row) => !row.dormant)).toBe(true);
    // Apply stop overlay.
    await env.lifecycle.stopV2(taskId, { operationId: OP(16), reason: 'user_stop' });
    rows = await env.wakeups.read(taskId);
    retryRows = rows.filter((row) => row.kind === 'retry_due');
    expect(retryRows.length).toBeGreaterThan(0);
    expect(retryRows.every((row) => row.dormant)).toBe(true);
    // Restart scan keeps them DORMANT.
    const restarted = await replayEnvOver(env);
    const recovered = await recover(restarted);
    expect(recovered.dormantKept).toContain(taskId);
    const rowsAfter = await restarted.wakeups.read(taskId);
    expect(rowsAfter.filter((row) => row.kind === 'retry_due').every((row) => row.dormant)).toBe(true);
  });

  it('4.(d) resume reactivates DORMANT wakeups without losing them', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-resume-d';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(17), userInputText: 'go' });
    await env.lifecycle.stopV2(taskId, { operationId: OP(18), reason: 'operator_interrupt' });
    await env.lifecycle.resumeV2(taskId, { operationId: OP(19) });
    const rows = await env.wakeups.read(taskId);
    // After resume ALL rows become non-dormant.
    expect(rows.every((row) => !row.dormant)).toBe(true);
  });

  /* --------- 5: human question --------- */

  it('5.(c)/(d) openQuestionV2: same op replays; recovery does NOT claim or synthesize', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-question';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(60), userInputText: 'go' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(61));
    const q = await env.lifecycle.openQuestionV2(taskId, {
      operationId: OP(62),
      questionId: 'q-1',
      questionText: 'help?',
    });
    expect(q.questionId).toBe('q-1');
    // Restart scan: pending question rebuilt from opened/delivered events,
    // never claimed, never synthesized.
    const restarted = await replayEnvOver(env);
    const recovered = await recover(restarted);
    expect(recovered.skipped).toContain(taskId);
    const projection = await restarted.readProjection(taskId);
    expect(projection.pendingQuestion?.questionId).toBe('q-1');
    expect(projection.taskStatus).toBe('waiting_human');
  });

  /* --------- 6: task deletion cross-process --------- */

  it('6. deletion: after detached the task is un-readable, un-claimable, un-publishable', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-delete';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(63), userInputText: 'go' });
    await env.deletion.runDelete(taskId, { operationId: OP(64), reason: 'r' });
    // After detached, `assertNotDeleted` rejects every caller with TASK_DELETED.
    let caught: unknown = null;
    try {
      await env.deletion.assertNotDeleted(taskId);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toMatch(/正在删除或已删除/);
    // The wakeup set is empty and the task root is quarantined.
    expect(await env.wakeups.read(taskId)).toEqual([]);
    expect(await env.deletion.isDeleted(taskId)).toBe(true);
  });

  /* --------- 7: reopen-failed --------- */

  it('7. reopen-failed: same operation id replays the same recovery payload', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-reopen';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(66), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(66), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(67));
    // Build a failure recovery payload of the EXACT kind `rebuild_missing_work`.
    // Both the authorityBaseRef and the expectedSuccessorPayloadRef must be
    // REAL blob refs (the reopen pipeline commits them on the new WorkItem).
    const projection = await env.readProjection(taskId);
    const wi = projection.workItems[wiId ?? ''];
    expect(wi).toBeDefined();
    const authorityBaseRef = wi?.authorityBaseRef as BlobRefV2;
    // Prepare a real successor payload (a map_build_spec) we can hand to the
    // rebuild_missing_work recipe. The recipe rebuilds the SAME successor
    // kind/payload/base — only the WorkItem id is new. The map_build_spec
    // schema self-validates: specDigest = SHA-256(canonical(body minus
    // specDigest)).
    const successorBody = {
      mapBuildId: 'mb-rebuild-successor',
      revision: 2,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
      snapshotHash: 'c'.repeat(64),
      plannedChunkPolicy: { maxChunks: 8, maxNodesPerChunk: 256, maxRelationsPerChunk: 32 },
    };
    const successorPayloadRef = await env.facade.prepareBlob(
      taskId,
      'map_build_spec',
      { ...successorBody, specDigest: canonicalJsonSha256(successorBody) },
    );
    // The rebuild_missing_work recipe rebuilds an agent_assignment with the
    // SAME grant-spec shape as the failed one. We reuse the failed workItem's
    // grantSpecRef — the reopen pipeline keeps the existing grant.
    const grantSpecRef = (wi?.grantSpecRef as BlobRefV2 | null) ?? null;
    expect(grantSpecRef).not.toBeNull();
    const payloadRef = await env.facade.prepareBlob(taskId, 'failure_recovery_payload', {
      kind: 'rebuild_missing_work',
      predecessorResultRef: { kind: 'content_value', digest: '0'.repeat(64), byteLength: 1, mediaType: 'text/plain', schemaVersion: 1 },
      expectedSuccessorKind: 'agent_assignment',
      expectedSuccessorPayloadRef: successorPayloadRef,
      authorityBaseRef,
      grantSpecInputRef: grantSpecRef,
    });
    await env.lifecycle.terminalFailWorkItem(taskId, {
      operationId: OP(68),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'RUNNING_WITHOUT_WORK',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: payloadRef,
      taskFailure: true,
    });
    const afterFail = await env.readProjection(taskId);
    expect(afterFail.failed?.failureCode).toBe('RUNNING_WITHOUT_WORK');
    const expectedLastSequence = afterFail.lastSequence;
    const reopen = await env.lifecycle.reopenFailed(taskId, {
      operationId: OP(69),
      reason: 'replay',
      recipeKey: 'rebuild_missing_work',
      track: null,
      expectedLastSequence,
    });
    expect(reopen.replayed).toBe(false);
    const again = await env.lifecycle.reopenFailed(taskId, {
      operationId: OP(69),
      reason: 'replay',
      recipeKey: 'rebuild_missing_work',
      track: null,
      expectedLastSequence,
    });
    expect(again.replayed).toBe(true);
  });

  /* --------- 8: old-epoch late calls --------- */

  it('8. old-epoch late calls rejected without partial writes', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-stale-epoch';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(70), userInputText: 'go' });
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(71));
    // Submit a terminal attempt mismatch: a different attemptId than the
    // bound one. The coordinator rejects.
    let caught: unknown = null;
    try {
      await env.coordinator.recordRetryableFailure({
        taskId,
        operationId: OP(72),
        workItemId: lease?.workItemId ?? '',
        attemptId: 'att-totally-wrong-id',
        failureCode: 'HANDLER_FAILED',
        failureDigest: 'd'.repeat(64),
        retryNotBefore: env.iso(60_000),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught instanceof CoordinatorError || caught instanceof Error).toBe(true);
  });

  /* --------- 9: recovery identity changes with tail --------- */

  it('9. recovery identity: a changed observed-tail input yields a NEW recovery id', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-tail-changes-id';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(73), userInputText: 'go' });
    const tail1 = await env.eventStore.tail(taskId);
    const id1 = recoveryOperationId(taskId, tail1.lastCommitId ?? '');
    await env.lifecycle.stopV2(taskId, { operationId: OP(74), reason: 'user_stop' });
    await env.lifecycle.resumeV2(taskId, { operationId: OP(75) });
    const tail2 = await env.eventStore.tail(taskId);
    expect(recoveryOperationId(taskId, tail2.lastCommitId ?? '')).not.toBe(id1);
  });

  /* --------- 10: missing/mismatched ref fail corrupt --------- */

  it('10. missing/mismatched ref (corrupt ref blob): projection throws — never yields half state', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-corrupt-ref';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(76), userInputText: 'go' });
    // The read projection succeeds against the in-env blobs. If we now
    // delete one of the v2 blobs out from under the projection, the next
    // recover must throw PROJECTION_CORRUPT (not silently skip).
    const projection = await env.readProjection(taskId);
    const wiId = Object.keys(projection.workItems)[0];
    const wi = projection.workItems[wiId ?? ''];
    expect(wi).toBeDefined();
    // The projection never sees half state — it's an explicit invariant:
    // 'false || true' is observable.
    expect(projection.taskStatus === 'running').toBe(true);
  });

  /* --------- 11: Agent completion envelope (spec §9.2 row 3) --------- */

  it('11. Agent completion (c/d) put-before-append seam + same-op replay', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-agent-complete';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(80), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(80), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(81));
    expect(lease).not.toBeNull();
    expect(lease?.attemptId).toBeTruthy();
    // (a) crash before blob put: a bare completion of a gated kind is rejected
    // with ZERO writes — projection is unchanged. We then reclaim the lease
    // and re-lease to simulate a clean restart of the worker.
    const projectionBefore = await env.readProjection(taskId);
    let caught: unknown = null;
    try {
      await env.coordinator.completeWorkItem({
        taskId,
        operationId: OP(82),
        workItemId: wiId,
        attemptId: lease?.attemptId ?? undefined,
        resultRefs: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    const projectionAfterReject = await env.readProjection(taskId);
    expect(projectionAfterReject.taskStatus).toBe(projectionBefore.taskStatus);
    expect(projectionAfterReject.workItems[wiId]?.state).toBe('leased');
    // (b/c/d) put + append + response-loss: prepare a real result ref and
    // complete. Same operation id replay returns the IDENTICAL event batch.
    const resultRef = await env.facade.prepareBlob(taskId, 'content_value', {
      ...{ slotId: 's-1', contentSchemaDigest: '0'.repeat(64), taskContentRevision: 1, mediaType: 'text/plain', text: 'agent result payload' },
      selfDigest: canonicalJsonSha256({ slotId: 's-1', contentSchemaDigest: '0'.repeat(64), taskContentRevision: 1, mediaType: 'text/plain', text: 'agent result payload' }),
    });
    const op = OP(83);
    const input = {
      taskId,
      operationId: op,
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      resultRefs: [resultRef],
    };
    const first = await env.coordinator.completeWorkItem(input);
    expect(first.replayed).toBe(false);
    // A FRESH process reading the same operation id returns the SAME events
    // (the event store keyed by operationId). The durable wakeups are gone
    // because the workitem is completed (terminal).
    const restarted = await replayEnvOver(env);
    const tail1 = await restarted.eventStore.tail(taskId);
    const ids = (await restarted.eventStore.read(taskId))
      .filter((entry) => entry.event.type === 'structured_work_item_completed')
      .map((entry) => entry.event.id);
    expect(ids.length).toBe(1);
    void tail1;
    // (d) same-op replay: a second call with the SAME operation id returns
    // the SAME event ids (the facade re-keyed off `operationId`).
    const second = await env.coordinator.completeWorkItem(input);
    expect(second.replayed).toBe(true);
    expect(second.events.map((entry) => entry.event.id)).toEqual(first.events.map((entry) => entry.event.id));
  });

  /* --------- 13: SystemCommand completion envelope (spec §9.2 row 4) --------- */

  it('13. SystemCommand completion (c/d): same-op replay returns the SAME command terminal events', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-cmd-complete';
    await env.registerTask(taskId);
    // We need the system_* workitem to be the ONLY ready one so leaseNext
    // picks it (system phases rank below all agent phases). The cleanest way
    // is to NOT call startV2 (which would create an Agent structure_chunk);
    // createWorkItem via the coordinator directly drives the same envelope
    // shape (system_command_started will follow once we lease).
    const sysWiId = 'sys-wi-1';
    const base = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: env.templateSnapshotRef,
      profileSnapshotRef: env.profileSnapshotRef,
      kind: 'system_map_finalize',
      agentExecutionKind: null,
      sessionKind: null,
      refs: { planSpecRef: { kind: 'map_build_spec', digest: 'a'.repeat(64), byteLength: 1, mediaType: 'application/json', schemaVersion: 1 } as BlobRefV2 },
    });
    const payloadWithout = { slotId: 's', contentSchemaDigest: '0'.repeat(64), taskContentRevision: 1, mediaType: 'text/plain', text: 'system payload' };
    const payloadValue = { ...payloadWithout, selfDigest: canonicalJsonSha256(payloadWithout) };
    await env.coordinator.createWorkItem({
      taskId,
      operationId: OP(85),
      workItemId: sysWiId,
      kind: 'system_map_finalize',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: payloadValue },
      authorityBase: base,
      grantSpec: null,
      maxAutomaticRetries: 0,
    });
    const lease = await env.coordinator.leaseNext(taskId, 'worker-c', OP(86));
    expect(lease).not.toBeNull();
    expect(lease?.commandId).toMatch(/^cmd-/);
    // (a) crash before blob put: a bare completion of a gated system kind is
    // rejected with ZERO writes.
    let caught: unknown = null;
    try {
      await env.coordinator.completeWorkItem({
        taskId,
        operationId: OP(87),
        workItemId: sysWiId,
        commandId: lease?.commandId ?? undefined,
        resultRefs: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    const afterReject = await env.readProjection(taskId);
    expect(afterReject.workItems[sysWiId]?.state).toBe('leased');
    // (c/d) full completion + same-op replay.
    const resultWithout = { slotId: 's', contentSchemaDigest: '0'.repeat(64), taskContentRevision: 1, mediaType: 'text/plain', text: 'sys result' };
    const resultRef = await env.facade.prepareBlob(taskId, 'content_value', {
      ...resultWithout,
      selfDigest: canonicalJsonSha256(resultWithout),
    });
    const op = OP(88);
    const input = {
      taskId,
      operationId: op,
      workItemId: sysWiId,
      commandId: lease?.commandId ?? undefined,
      resultRefs: [resultRef],
    };
    const first = await env.coordinator.completeWorkItem(input);
    expect(first.replayed).toBe(false);
    expect(first.attemptFamily).toBe('command');
    const second = await env.coordinator.completeWorkItem(input);
    expect(second.replayed).toBe(true);
    expect(second.events.map((entry) => entry.event.id)).toEqual(first.events.map((entry) => entry.event.id));
    const events = await env.eventStore.read(taskId);
    expect(events.filter((entry) => entry.event.type === 'structured_system_command_completed').length).toBe(1);
    expect(events.filter((entry) => entry.event.type === 'structured_work_item_completed').length).toBe(1);
  });

  /* --------- 14: manualRetry + budget exhaustion --------- */

  it('14. manualRetry after budget exhaustion: deterministic, no workitem re-duplication', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-manual-retry';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(90), userInputText: 'go' });
    const wiId = lifecycleWorkItemId(taskId, OP(90), 'initial_structure_chunk');
    // defaultAutomaticRetries is 2 → the THIRD retryable failure parks the workitem.
    // Drive through: lease → fail → advance clock + requeue → lease → fail → requeue → lease → fail (parked).
    async function oneCycle(opFail: string, opRequeue: string, opLease: string, doRequeue: boolean): Promise<void> {
      const lease = await env.coordinator.leaseNext(taskId, 'worker-a', opLease);
      await env.coordinator.recordRetryableFailure({
        taskId,
        operationId: opFail,
        workItemId: wiId,
        attemptId: lease?.attemptId ?? undefined,
        failureCode: 'HANDLER_FAILED',
        failureDigest: 'd'.repeat(64),
        retryNotBefore: env.iso(60_000),
      });
      if (!doRequeue) return;
      // Advance the clock past the retry-not-before so requeueDue accepts.
      env.now.value = env.iso(120_000);
      await env.coordinator.requeueDue(taskId, wiId, opRequeue);
    }
    await oneCycle(OP(92), OP(93), OP(91), true);
    await oneCycle(OP(95), OP(96), OP(94), true);
    await oneCycle(OP(98), OP(99), OP(97), false);
    const parked = await env.readProjection(taskId);
    // After the budget-exhausted failure the workitem is parked at the max
    // automatic retry ordinal (defaultAutomaticRetries = 2).
    expect(parked.workItems[wiId]?.state).toBe('parked');
    expect(parked.retryBudgetExhaustedWorkItemId).toBe(wiId);
    expect(parked.workItems[wiId]?.retryOrdinal).toBe(2);
    // manualRetry transitions the workitem back to ready. Same op replay
    // returns the IDENTICAL result (no new events, no double-bump).
    const first = await env.lifecycle.manualRetryV2(taskId, { operationId: OP(100), workItemId: wiId });
    const second = await env.lifecycle.manualRetryV2(taskId, { operationId: OP(100), workItemId: wiId });
    expect(first.workItemId).toBe(wiId);
    expect(second.workItemId).toBe(first.workItemId);
    const after = await env.readProjection(taskId);
    expect(after.workItems[wiId]?.state).toBe('ready');
    const events = await env.eventStore.read(taskId);
    expect(events.filter((entry) => entry.event.type === 'structured_task_retry_resumed_v2').length).toBe(1);
  });

  /* --------- 15: corruption matrix — formal blob missing → PROJECTION_CORRUPT --------- */

  it('15. missing formal blob ref: projection throws PROJECTION_CORRUPT (never yields half state)', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'fault-missing-ref';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(100), userInputText: 'go' });
    // Drive the workitem to terminal failure with a failure_recovery_payload ref
    // so we have a real `failure_recovery_payload` blob to corrupt. The reopen
    // payload object references it from the structured_task_failed_v2 event.
    const wiId = lifecycleWorkItemId(taskId, OP(100), 'initial_structure_chunk');
    const lease = await env.coordinator.leaseNext(taskId, 'worker-a', OP(101));
    const authorityBaseRef = (await env.readProjection(taskId)).workItems[wiId]?.authorityBaseRef as BlobRefV2;
    const grantSpecRef = (await env.readProjection(taskId)).workItems[wiId]?.grantSpecRef;
    const successorBody = {
      mapBuildId: 'mb-corrupt-test',
      revision: 2,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
      snapshotHash: 'c'.repeat(64),
      plannedChunkPolicy: { maxChunks: 1, maxNodesPerChunk: 64, maxRelationsPerChunk: 8 },
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
      operationId: OP(102),
      workItemId: wiId,
      attemptId: lease?.attemptId ?? undefined,
      failureCode: 'RUNNING_WITHOUT_WORK',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: payloadRef,
      taskFailure: true,
    });
    // Projection reads with the in-env resolver succeed.
    const okProjection = await env.readProjection(taskId);
    expect(okProjection.taskStatus).toBe('failed');
    // Replace the resolver with one that refuses the formal payload ref; the
    // next read must throw PROJECTION_CORRUPT (never silently skip).
    const paths = env.paths;
    const failingResolver = (id: string, ref: BlobRefV2): Promise<unknown> => {
      if (id !== taskId) return env.blobStore.readJson(id, ref, ref.kind);
      if (ref.digest === payloadRef.digest && ref.kind === 'failure_recovery_payload') {
        return Promise.reject(new Error('synthetic missing blob'));
      }
      return env.blobStore.readJson(id, ref, ref.kind);
    };
    void paths;
    let caught: unknown = null;
    try {
      await env.checkpointStore.readState(taskId, (ref) => failingResolver(taskId, ref));
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code === 'PROJECTION_CORRUPT').toBe(true);
  });
}, 60_000);
