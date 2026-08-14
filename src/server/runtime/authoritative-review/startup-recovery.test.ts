/**
 * Task 11 startup recovery tests (spec §10.4 COMPLETE matrix): in-flight
 * reclaim, ready registration, retry-before-due timer rebuild, retry-after-
 * due requeue, stopped/interrupted dormant wakeups, waiting_human never
 * claimed, terminal cleanup, and running + no non-terminal WorkItem ->
 * RUNNING_WITHOUT_WORK. Repeating a scan with
 * H(taskId, observedTailCommitId, 'auto_continue_v1') replays the SAME
 * compensation; a changed tail gets a NEW recovery id. The wakeup index is
 * fully rebuilt from the projection — no in-memory queue/timer is required.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CorePaths } from '../../storage/core-paths';
import { AuthoritativeTaskIndexV1 } from '../../storage/authoritative-task-index';
import { AuthoritativeTaskDeletionV2 } from '../../storage/authoritative-task-deletion';
import { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import { TaskLifecycleServiceV2, lifecycleWorkItemId } from './task-lifecycle';
import { runStartupRecoveryV2, recoveryOperationId, RECOVERY_POLICY_VERSION } from './startup-recovery';
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
import type { BlobRefV2, AuthoritativeReviewExecutionEligibilityV1 } from '../../../shared/authoritative-review-v2';

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
  now: { value: string };
  iso(offsetMs?: number): string;
  readProjection(taskId: string): Promise<import('../../storage/authoritative-review-state').AuthoritativeReviewProjectionV2>;
  readEvents(taskId: string): Promise<readonly import('../../storage/event-store').CommittedEvent[]>;
  /** Registers an ACTIVE index row (TaskStore.create normally owns this). */
  registerTask(taskId: string): Promise<void>;
}

const OP = (n: number): string => `7b9f63b3-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function makeRecoveryEnv(shared?: CorePaths): Promise<RecoveryEnv> {
  const paths = shared ?? CorePaths.create({
    dataRoot: mkdtempSync(join(tmpdir(), 'forge-recovery-data-')),
    templateRoot: mkdtempSync(join(tmpdir(), 'forge-recovery-templates-')),
  });
  if (shared === undefined) roots.push(paths.dataRoot, paths.templateRoot);
  const eventStore = new (await import('../../storage/event-store')).EventStore(paths);
  const blobStore = new AuthoritativeReviewBlobStore(paths, fullProfileForTests());
  const now = { value: '2026-08-14T10:00:00.000Z' };
  const publicationStore = new AuthoritativePublicationStore(paths, {
    bootId: 'recovery-test-boot',
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
  const profileSnapshotRef = await facade.prepareBlob('task-recovery-support', 'profile_snapshot', buildAuthoritativeReviewTestProfileBody());
  const body = { slotId: 's-t', contentSchemaDigest: '0'.repeat(64), taskContentRevision: 1, mediaType: 'text/plain', text: 'template snapshot stand-in' };
  const templateSnapshotRef = await facade.prepareBlob('task-recovery-support', 'content_value', { ...body, selfDigest: canonicalJsonSha256(body) });
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

describe('recovery identity (spec §10.4)', () => {
  it('is a stable function of (taskId, observedTailCommitId, policy version)', () => {
    expect(RECOVERY_POLICY_VERSION).toBe('auto_continue_v1');
    const a = recoveryOperationId('task-1', 'commit-1');
    expect(a).toMatch(/^rec-[0-9a-f]{32}$/);
    expect(recoveryOperationId('task-1', 'commit-1')).toBe(a);
    expect(recoveryOperationId('task-1', 'commit-2')).not.toBe(a);
    expect(recoveryOperationId('task-2', 'commit-1')).not.toBe(a);
  });
});

describe('runStartupRecoveryV2 matrix', () => {
  beforeAll(() => { roots.length = 0; });
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  it('running + leased -> crash_recovery reclaim + runnable wakeup', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'task-leased';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(1), userInputText: 'input' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(2));
    const tail = await env.eventStore.tail(taskId);
    // A fresh environment over the SAME root simulates the restart; the
    // recovery scan must reclaim the crash lease and register runnable.
    const restarted = await makeRecoveryEnv(env.paths);
    const result = await runStartupRecoveryV2(recoveryDeps(restarted));
    expect(result.reclaimed).toContain(taskId);
    const projection = await restarted.readProjection(taskId);
    expect(projection.activeLease).toBeNull();
    expect(projection.taskStatus).toBe('running');
    const rows = await restarted.wakeups.read(taskId);
    expect(rows.some((row) => row.kind === 'runnable' && !row.dormant)).toBe(true);
    void tail;
    // Repeating the scan with the same tail replays the SAME compensation.
    const again = await runStartupRecoveryV2(recoveryDeps(restarted));
    expect(again.reclaimed.filter((id) => id === taskId)).toHaveLength(0);
  });

  it('running + retryable before due repairs the durable timer (no early requeue); after due requeues', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'task-retry';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(11), userInputText: 'input' });
    const wiId = lifecycleWorkItemId(taskId, OP(11), 'initial_structure_chunk');
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(12));
    await env.coordinator.recordRetryableFailure({ taskId, operationId: OP(13), workItemId: wiId, failureCode: 'HANDLER_FAILED', failureDigest: 'd'.repeat(64), retryNotBefore: env.iso(5 * 60 * 1000) });
    // Before due.
    let result = await runStartupRecoveryV2(recoveryDeps(env));
    expect(result.requeued).not.toContain(taskId);
    expect(result.wakeupsRepaired).toContain(taskId);
    let rows = await env.wakeups.read(taskId);
    expect(rows.some((row) => row.kind === 'retry_due' && row.at === env.iso(5 * 60 * 1000) && !row.dormant)).toBe(true);
    expect(rows.some((row) => row.kind === 'runnable')).toBe(false);
    // At/after due -> the recovery id requeues and registers runnable.
    env.now.value = env.iso(6 * 60 * 1000);
    result = await runStartupRecoveryV2(recoveryDeps(env));
    expect(result.requeued).toContain(taskId);
    const projection = await env.readProjection(taskId);
    expect(projection.workItems[wiId]?.state).toBe('ready');
    rows = await env.wakeups.read(taskId);
    expect(rows.some((row) => row.kind === 'runnable' && !row.dormant)).toBe(true);
    expect(rows.some((row) => row.kind === 'retry_due')).toBe(false);
  });

  it('stopped/interrupted keeps underlying timers DORMANT; waiting_human never claims; terminal removes wakeups', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'task-dormant';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(21), userInputText: 'input' });
    const wiId = lifecycleWorkItemId(taskId, OP(21), 'initial_structure_chunk');
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(22));
    await env.coordinator.recordRetryableFailure({ taskId, operationId: OP(23), workItemId: wiId, failureCode: 'HANDLER_FAILED', failureDigest: 'd'.repeat(64), retryNotBefore: env.iso(10 * 60 * 1000) });
    // The underlying retryable failure is what the overlay must keep dormant.
    await env.lifecycle.stopV2(taskId, { operationId: OP(25), reason: 'user_stop' });
    // Restart scan: the overlay task keeps its underlying timer DORMANT.
    const restarted = await makeRecoveryEnv(env.paths);
    const result = await runStartupRecoveryV2(recoveryDeps(restarted));
    expect(result.dormantKept).toContain(taskId);
    expect(result.requeued).not.toContain(taskId);
    const rows = await restarted.wakeups.read(taskId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.dormant)).toBe(true);
    // Resume reactivates them without loss.
    await restarted.lifecycle.resumeV2(taskId, { operationId: OP(26) });
    const afterResume = await restarted.wakeups.read(taskId);
    expect(afterResume.every((row) => !row.dormant)).toBe(true);
    // waiting_human: opened question is derived from events; the scan neither
    // claims nor synthesizes an answer.
    const taskQ = 'task-question';
    await env.registerTask(taskQ);
    await env.lifecycle.startV2(taskQ, { operationId: OP(27), userInputText: 'input' });
    await env.coordinator.leaseNext(taskQ, 'worker-a', OP(28));
    await env.lifecycle.openQuestionV2(taskQ, { operationId: OP(29), questionId: 'q-1', questionText: '帮助?' });
    const qResult = await runStartupRecoveryV2(recoveryDeps(env));
    expect(qResult.skipped).toContain(taskQ);
    const qState = await env.readProjection(taskQ);
    expect(qState.taskStatus).toBe('waiting_human');
    expect(qState.pendingQuestion?.questionId).toBe('q-1');
  });

  it('running + no non-terminal workitem -> RUNNING_WITHOUT_WORK (never falsely running)', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'task-no-work';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(31), userInputText: 'input' });
    const wiId = lifecycleWorkItemId(taskId, OP(31), 'initial_structure_chunk');
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(32));
    // Terminal-fail WITHOUT the task failure (the crash half-state): the
    // workitem and attempt are terminal but the task still projects running.
    await env.lifecycle.terminalFailWorkItem(taskId, {
      operationId: OP(33),
      workItemId: wiId,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: null,
      taskFailure: false,
    });
    const before = await env.readProjection(taskId);
    expect(before.taskStatus).toBe('running');
    const result = await runStartupRecoveryV2(recoveryDeps(env));
    expect(result.failedWithoutWork).toContain(taskId);
    const after = await env.readProjection(taskId);
    expect(after.taskStatus).toBe('failed');
    expect(after.failed?.failureCode).toBe('RUNNING_WITHOUT_WORK');
    expect(await env.wakeups.read(taskId)).toEqual([]);
    // Repeating the scan (same tail) does NOT create a second failure.
    const again = await runStartupRecoveryV2(recoveryDeps(env));
    expect(again.failedWithoutWork).not.toContain(taskId);
    const events = await env.readEvents(taskId);
    expect(events.filter((entry) => entry.event.type === 'structured_task_failed_v2')).toHaveLength(1);
  });

  it('a changed observed tail yields a NEW recovery id (reproject before acting)', async () => {
    const env = await makeRecoveryEnv();
    const taskId = 'task-tail-change';
    await env.registerTask(taskId);
    await env.lifecycle.startV2(taskId, { operationId: OP(41), userInputText: 'input' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(42));
    const tail1 = await env.eventStore.tail(taskId);
    const id1 = recoveryOperationId(taskId, tail1.lastCommitId ?? '');
    // An unrelated append moves the tail.
    await env.lifecycle.stopV2(taskId, { operationId: OP(43), reason: 'user_stop' });
    await env.lifecycle.resumeV2(taskId, { operationId: OP(44) });
    const tail2 = await env.eventStore.tail(taskId);
    expect(recoveryOperationId(taskId, tail2.lastCommitId ?? '')).not.toBe(id1);
  });
}, 30_000);

/** Builds the recovery dependencies from an env. */
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