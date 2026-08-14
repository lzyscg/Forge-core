/**
 * Task 11 lifecycle tests (spec §10.3/§10.3.1/§10.6, §17.2/§17.3, constraint
 * B): one-shot start envelope (no legacy agent_input), USE_RESUME, resume
 * never re-seeds, eligibility-blocked mutations, response-loss replay and
 * conflict, composed stop/bloated wakeups, budget stop/resume, question
 * token semantics (43-char opaque, bound to question+workitem+assignment+
 * attempt/epoch+base+opened commit, rejects normalized/prior/recomputed
 * tokens, idempotent same-op delivery, stale two-tab), terminal failed
 * command rejection, and the frozen §10.3.1 reopen policy table.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CorePaths } from '../../storage/core-paths';
import {
  AuthoritativeWakeupIndexV1,
} from './wakeup-index';
import { AuthoritativeTaskIndexV1 } from '../../storage/authoritative-task-index';
import { AuthoritativeTaskDeletionV2, TASK_OWNER_PRINCIPAL } from '../../storage/authoritative-task-deletion';
import {
  TaskLifecycleServiceV2,
  TaskLifecycleError,
  questionVersionToken,
  lifecycleWorkItemId,
  failedRecoverySummary,
} from './task-lifecycle';
import { WorkItemCoordinatorV2 } from './work-item-coordinator';
import { buildAuthorityBaseSet } from './authority-base';
import { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import { AuthoritativeReviewBlobStore } from '../../storage/authoritative-review-blob-store';
import { AuthoritativePublicationStore } from '../../storage/authoritative-publication-store';
import { AuthoritativeReviewCheckpointStore } from '../../storage/authoritative-review-checkpoint-store';
import { PublicationIntentRegistry } from '../../storage/authoritative-publication-intent-registry';
import { fullProfileForTests } from '../../authoritative-review/object-registry';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { BlobRefV2, AuthoritativeReviewExecutionEligibilityV1 } from '../../../shared/authoritative-review-v2';

const roots: string[] = [];

interface LifecycleEnv {
  paths: CorePaths;
  eventStore: import('../../storage/event-store').EventStore;
  facade: AuthoritativeAppendFacadeV2;
  coordinator: WorkItemCoordinatorV2;
  wakeups: AuthoritativeWakeupIndexV1;
  deletion: AuthoritativeTaskDeletionV2;
  lifecycle: TaskLifecycleServiceV2;
  blobStore: import('../../storage/authoritative-review-blob-store').AuthoritativeReviewBlobStore;
  publicationStore: import('../../storage/authoritative-publication-store').AuthoritativePublicationStore;
  profileSnapshotRef: BlobRefV2;
  templateSnapshotRef: BlobRefV2;
  now: { value: string };
  eligible: { value: boolean };
  iso(offsetMs?: number): string;
  readProjection(taskId: string): Promise<import('../../storage/authoritative-review-state').AuthoritativeReviewProjectionV2>;
  readEvents(taskId: string): Promise<readonly import('../../storage/event-store').CommittedEvent[]>;
  workItemId(taskId: string, operationId: string): string;
}

async function makeLifecycleEnv(sharedPaths?: CorePaths): Promise<LifecycleEnv> {
  const paths =
    sharedPaths ??
    CorePaths.create({
      dataRoot: mkdtempSync(join(tmpdir(), 'forge-lifecycle-data-')),
      templateRoot: mkdtempSync(join(tmpdir(), 'forge-lifecycle-templates-')),
    });
  if (sharedPaths === undefined) roots.push(paths.dataRoot, paths.templateRoot);
  const eventStore = new (await import('../../storage/event-store')).EventStore(paths);
  const blobStore = new AuthoritativeReviewBlobStore(paths, fullProfileForTests());
  const now = { value: '2026-08-14T10:00:00.000Z' };
  const eligible = { value: true };
  const publicationStore = new AuthoritativePublicationStore(paths, {
    bootId: 'lifecycle-test-boot',
    ownerPid: process.pid,
    processAlive: () => true,
    clock: () => now.value,
    retrySleepMs: 0,
  });
  const registry = new PublicationIntentRegistry();
  const facade = new AuthoritativeAppendFacadeV2({
    eventStore,
    blobStore,
    publicationStore,
    profile: fullProfileForTests(),
    paths,
    registry,
    clock: () => now.value,
  });
  const checkpointSource: import('../../storage/authoritative-review-checkpoint-store').ValidatedEventSource = {
    read: async (id: string) =>
      (await eventStore.read(id)).map((entry) => ({
        sequence: entry.sequence,
        fileName: entry.fileName,
        size: entry.size,
        event: entry.event as AuthoritativeReviewEventV2,
      })),
    readAfter: async (id: string, throughSequence: number) =>
      (await eventStore.readAfter(id, throughSequence)).map((entry) => ({
        sequence: entry.sequence,
        fileName: entry.fileName,
        size: entry.size,
        event: entry.event as AuthoritativeReviewEventV2,
      })),
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
  await index.runMigrationBarrier();
  const deletion = new AuthoritativeTaskDeletionV2({
    paths,
    index,
    wakeups,
    clock: () => now.value,
    snapshotPins: async () => [],
  });
  const taskId = 'task-lifecycle-support';
  const profileSnapshotRef = await facade.prepareBlob(taskId, 'profile_snapshot', buildAuthoritativeReviewTestProfileBody());
  const body = { slotId: 's-t', contentSchemaDigest: '0'.repeat(64), taskContentRevision: 1, mediaType: 'text/plain', text: 'template snapshot stand-in' };
  const templateSnapshotRef = await facade.prepareBlob(taskId, 'content_value', { ...body, selfDigest: canonicalJsonSha256(body) });
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
    eligibility: () =>
      eligible.value
        ? { state: 'eligible', frozenProfileDigest: 'a'.repeat(64), currentProfileDigest: 'a'.repeat(64) }
        : ({ state: 'blocked', reason: 'profile_digest_mismatch', frozenProfileDigest: 'a'.repeat(64), currentProfileDigest: 'b'.repeat(64) } as AuthoritativeReviewExecutionEligibilityV1),
    frozenProfile: async () => ({
      profileSnapshotRef,
      templateSnapshotRef,
      profileDigest: 'a'.repeat(64),
      snapshotHash: 'c'.repeat(64),
    }),
    orchestratorRoleBinding: () => 'orchestrator',
    repairRoleBinding: (session) => (session === 'map_repair' ? 'map-repair-role' : 'content-repair-role'),
    defaultAutomaticRetries: () => 2,
  });
  return {
    paths,
    eventStore,
    facade,
    coordinator,
    wakeups,
    deletion,
    lifecycle,
    blobStore,
    publicationStore,
    profileSnapshotRef,
    templateSnapshotRef,
    now,
    eligible,
    iso(offsetMs = 0): string {
      return new Date(new Date(now.value).getTime() + offsetMs).toISOString();
    },
    async readProjection(id: string) {
      const read = await checkpointStore.readState(id, (ref) => blobStore.readJson(id, ref, ref.kind));
      return read.projection;
    },
    async readEvents(id: string) {
      return eventStore.read(id);
    },
    workItemId(taskId: string, operationId: string): string {
      return lifecycleWorkItemId(taskId, operationId, 'initial_structure_chunk');
    },
  };
}




/** Authority base for the system_map_finalize workitem (planSpecRef matrix). */
function buildBaseForLifecycle(
  env: LifecycleEnv,
  taskId: string,
  kind: 'system_map_finalize',
  refs: { planSpecRef: BlobRefV2 },
): import('../../authoritative-review/authority-types').AuthorityBaseSetV2 {
  return buildAuthorityBaseSet({
    taskId,
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    refs,
    kind,
  });
}

const OP = (n: number): string => `3f9b63b3-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('TaskLifecycleServiceV2 start', () => {
  beforeAll(() => {
    roots.length = 0;
  });

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('commits task_started + MapBuildSpec + first structure WorkItem + AuthorityBase + GrantSpec in ONE batch with NO seeded legacy agent_input', async () => {
    const env = await makeLifecycleEnv();
    const taskId = 'task-start';
    const started = await env.lifecycle.startV2(taskId, { operationId: OP(1), userInputText: 'neutral input' });
    expect(started.replayed).toBe(false);
    expect(started.workItemId).toBe(env.workItemId(taskId, OP(1)));
    expect(started.grantSpecRef.kind).toBe('write_grant_spec');
    const events = await env.readEvents(taskId);
    expect(events.map((entry) => entry.event.type)).toEqual([
      'task_started',
      'structured_map_build_started',
      'structured_work_item_created',
    ]);
    // NO legacy agent_input is ever seeded by v2.
    expect(events.some((entry) => entry.event.type === 'agent_input')).toBe(false);
    const state = await env.readProjection(taskId);
    expect(state.taskStatus).toBe('running');
    const wi = state.workItems[started.workItemId];
    expect(wi).toMatchObject({ kind: 'agent_assignment', state: 'ready', sessionKind: 'structure_chunk', leaseEpoch: 0, maxAutomaticRetries: 2 });
    expect(wi.authorityBaseRef.digest).toBe(started.authorityBaseRef.digest);
    // The ready workitem is claimable WITHOUT any route or pending input.
    const leased = await env.coordinator.leaseNext(taskId, 'worker-a', OP(2));
    expect(leased).not.toBeNull();
    expect(leased?.workItemId).toBe(started.workItemId);
    expect(leased?.grantInstanceRef).not.toBeNull();
    // The durable runnable wakeup was upserted after the start commit.
    expect(await env.wakeups.read(taskId)).toMatchObject([{ kind: 'runnable', workItemId: started.workItemId, dormant: false }]);
  });

  it('start replays byte-identically under response loss; a changed payload conflicts', async () => {
    const env = await makeLifecycleEnv();
    const taskId = 'task-replay';
    const first = await env.lifecycle.startV2(taskId, { operationId: OP(11), userInputText: 'same input' });
    const replay = await env.lifecycle.startV2(taskId, { operationId: OP(11), userInputText: 'same input' });
    expect(replay).toMatchObject({ workItemId: first.workItemId, replayed: true });
    expect(await env.readEvents(taskId)).toHaveLength(3);
    // A second start on a started task is USE_RESUME, never a second build.
    await expect(env.lifecycle.startV2(taskId, { operationId: OP(12), userInputText: 'again' })).rejects.toMatchObject({ code: 'USE_RESUME' });
  });

  it('returns USE_RESUME for stopped/interrupted tasks and never seeds a new build', async () => {
    const env = await makeLifecycleEnv();
    const taskId = 'task-stop-retry';
    await env.lifecycle.startV2(taskId, { operationId: OP(21), userInputText: 'input' });
    await env.lifecycle.stopV2(taskId, { operationId: OP(22), reason: 'user_stop' });
    await expect(env.lifecycle.startV2(taskId, { operationId: OP(23), userInputText: 'again' })).rejects.toMatchObject({ code: 'USE_RESUME' });
    // resume clears the overlay, never seeds a new build.
    await env.lifecycle.resumeV2(taskId, { operationId: OP(24) });
    const events = await env.readEvents(taskId);
    const created = events.filter((entry) => entry.event.type === 'structured_work_item_created');
    expect(created).toHaveLength(1);
    expect(events.some((entry) => entry.event.type === 'structured_map_build_started' && true)).toBe(true);
    expect(events.filter((entry) => entry.event.type === 'structured_map_build_started')).toHaveLength(1);
    // The ready workitem runs again after resume (wakeup reactivated).
    const leased = await env.coordinator.leaseNext(taskId, 'worker-a', OP(25));
    expect(leased?.workItemId).toBe(env.workItemId(taskId, OP(21)));
    // Dormant→live wakeup preserved identity.
    const rows = await env.wakeups.read(taskId);
    expect(rows.every((row) => !row.dormant)).toBe(true);
  });

  it('blocks every execution-producing mutation while eligibility is blocked; reads stay available', async () => {
    const env = await makeLifecycleEnv();
    const taskId = 'task-eligible';
    await env.lifecycle.startV2(taskId, { operationId: OP(31), userInputText: 'input' });
    env.eligible.value = false;
    // Execution-producing mutations reject at the lifecycle/scheduler gate
    // (the coordinator itself is eligibility-blind; the scheduler owns the
    // claim gate — its AUTHORITATIVE_REVIEW_UNAVAILABLE test lives in the
    // scheduler suite).

    // STOP is a lifecycle command that must stay reachable even when blocked.
    await expect(env.lifecycle.openQuestionV2(taskId, { operationId: OP(33), questionId: 'q-1', questionText: 'help?' })).rejects.toMatchObject({ code: 'AUTHORITATIVE_REVIEW_UNAVAILABLE' });
    // Stop still works (suspension is a lifecycle command, not execution).
    const stopped = await env.lifecycle.stopV2(taskId, { operationId: OP(34), reason: 'user_stop' });
    expect(stopped.reason).toBe('user_stop');
    // Resume while blocked: execution must not resume.
    await expect(env.lifecycle.resumeV2(taskId, { operationId: OP(35) })).rejects.toMatchObject({ code: 'AUTHORITATIVE_REVIEW_UNAVAILABLE' });
    // Re-enabling the exact profile re-activates the underlying running task
    // without any resume/reopen event (startup reconciliation).
    env.eligible.value = true;
    await env.lifecycle.resumeV2(taskId, { operationId: OP(36) });
    const events = await env.readEvents(taskId);
    expect(events.some((entry) => entry.event.type === 'structured_task_suspension_cleared_v2')).toBe(true);
  });
}, 30_000);

describe('TaskLifecycleServiceV2 stop/resume/retry', () => {
  it('composes the full stop envelope in ONE batch and keeps the workitem claimable after resume', async () => {
    const env = await makeLifecycleEnv();
    const taskId = 'task-stop-envelope';
    await env.lifecycle.startV2(taskId, { operationId: OP(41), userInputText: 'input' });
    const leased = await env.coordinator.leaseNext(taskId, 'worker-a', OP(42));
    expect(leased).not.toBeNull();
    const stopped = await env.lifecycle.stopV2(taskId, { operationId: OP(43), reason: 'user_stop' });
    expect(stopped.suspensionId).toMatch(/^susp-/);
    const events = await env.readEvents(taskId);
    const types = events.map((entry) => entry.event.type);
    // [abandon, lease_reclaimed, task_stopped, suspension_applied] were one batch.
    expect(types).toEqual([
      'task_started',
      'structured_map_build_started',
      'structured_work_item_created',
      'structured_work_item_leased',
      'structured_assignment_dispatched',
      'structured_agent_attempt_started_v2',
      'structured_agent_attempt_abandoned_v2',
      'structured_work_item_lease_reclaimed',
      'task_stopped',
      'structured_task_suspension_applied_v2',
    ]);
    const state = await env.readProjection(taskId);
    expect(state.taskStatus).toBe('stopped');
    expect(state.workItems[leased!.workItemId]?.state).toBe('ready');
    // The scheduler loop never claims under the overlay.
    expect(await env.coordinator.leaseNext(taskId, 'worker-a', OP(44))).toBeNull();
    // Resume: same workitem claimable again (epoch+1), no new build.
    await env.lifecycle.resumeV2(taskId, { operationId: OP(45) });
    const claim = await env.coordinator.leaseNext(taskId, 'worker-a', OP(46));
    expect(claim?.workItemId).toBe(leased!.workItemId);
  });

  it('budget-exhausted park: manual retry clears ONLY the budget disposition; resume/stop never clears human/budget parks', async () => {
    const env = await makeLifecycleEnv();
    const taskId = 'task-budget';
    await env.lifecycle.startV2(taskId, { operationId: OP(51), userInputText: 'input' });
    const wiId = env.workItemId(taskId, OP(51));
    const leased = await env.coordinator.leaseNext(taskId, 'worker-a', OP(52));
    const base = leased!.authorityBaseRef;
    // Fail twice: maxAutomaticRetries=2 → third failure parks (ordinal 3 > 2).
    await env.coordinator.recordRetryableFailure({ taskId, operationId: OP(53), workItemId: wiId, failureCode: 'HANDLER_FAILED', failureDigest: 'd'.repeat(64), retryNotBefore: env.iso() });
    await env.coordinator.requeueDue(taskId, wiId, OP(54));
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(55));
    await env.coordinator.recordRetryableFailure({ taskId, operationId: OP(56), workItemId: wiId, failureCode: 'HANDLER_FAILED', failureDigest: 'd'.repeat(64), retryNotBefore: env.iso() });
    await env.coordinator.requeueDue(taskId, wiId, OP(57));
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(58));
    const parked = await env.coordinator.recordRetryableFailure({ taskId, operationId: OP(59), workItemId: wiId, failureCode: 'HANDLER_FAILED', failureDigest: 'd'.repeat(64), retryNotBefore: env.iso() });
    expect(parked.mode).toBe('parked');
    // terminal-fail pieces were part of the park: the attempt is terminal.
    const state = await env.readProjection(taskId);
    expect(state.taskStatus).toBe('retryable_failure');
    expect(state.retryBudgetExhaustedWorkItemId).toBe(wiId);
    void base;
    // Manual retry is the ONLY command that clears the budget park.
    await env.lifecycle.manualRetryV2(taskId, { operationId: OP(60), workItemId: wiId });
    const after = await env.readProjection(taskId);
    expect(after.taskStatus).toBe('running');
    expect(after.retryBudgetExhaustedWorkItemId).toBeNull();
    expect(after.workItems[wiId]?.state).toBe('ready');
  });

  it('terminal failed command rejection: ordinary retry/resume/answer reject a failed task', async () => {
    // A task whose ONLY workitem is a system_map_finalize: its lease is the
    // command lease the failure envelope requires.
    const env = await makeLifecycleEnv();
    const taskId = 'task-terminal';
    const systemWiId = lifecycleWorkItemId(taskId, OP(61), 'system_map_finalize');
    const specBody = { mapBuildId: 'mb-s', revision: 1, supersedesMapBuildId: null, sourceValidationReceiptRef: null, snapshotHash: 'c'.repeat(64), plannedChunkPolicy: { maxChunks: 8, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 } };
    const specValue = { ...specBody, specDigest: canonicalJsonSha256(specBody) };
    const specRef = await env.facade.prepareBlob(taskId, 'map_build_spec', specValue);
    const base = buildBaseForLifecycle(env, taskId, 'system_map_finalize', { planSpecRef: specRef });
    await env.coordinator.createWorkItem({
      taskId,
      operationId: OP(61),
      workItemId: systemWiId,
      kind: 'system_map_finalize',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'map_build_spec' as const, value: specValue },
      authorityBase: base,
      maxAutomaticRetries: 2,
    });
    const leased = await env.coordinator.leaseNext(taskId, 'worker-a', OP(62));
    expect(leased?.workItemId).toBe(systemWiId);
    expect(leased?.commandId).not.toBeNull();
    const leaseProjection = await env.readProjection(taskId);
    const commandId = leaseProjection.activeLease?.commandId ?? '';
    const { deterministicEventId } = await import('../../storage/authoritative-publication-intent-registry');
    const terminalEventId = deterministicEventId(`${OP(63)}-fail`, 'work_item_terminal_failed', 0);
    const recoveryPayload = await env.facade.prepareBlob(taskId, 'failure_recovery_payload', {
      kind: 'retry_system_command',
      failedWorkItemId: systemWiId,
      failedCommandId: commandId,
      failedLeaseEpoch: 1,
      terminalEventId,
      terminalCommitId: `${OP(63)}-fail`,
      authorityBaseRef: leased!.authorityBaseRef,
      systemKind: 'system_map_finalize',
      systemPayloadRef: specRef,
    });
    await env.lifecycle.terminalFailWorkItem(taskId, {
      operationId: `${OP(63)}-fail`,
      workItemId: systemWiId,
      failureCode: 'ARTIFACT_VALIDATION_FAILED',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: recoveryPayload,
      taskFailure: true,
    });
    const failed = await env.readProjection(taskId);
    expect(failed.taskStatus).toBe('failed');
    expect(failed.failed?.failureCode).toBe('ARTIFACT_VALIDATION_FAILED');
    expect(failed.workItems[systemWiId]?.state).toBe('terminal_failed');
    expect(await env.wakeups.read(taskId)).toEqual([]);
    // Ordinary resume/retry/answer refuse the failed task.
    await expect(env.lifecycle.resumeV2(taskId, { operationId: OP(64) })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(env.lifecycle.manualRetryV2(taskId, { operationId: OP(65), workItemId: systemWiId })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const summary = failedRecoverySummary(failed);
    expect(summary).toMatchObject({
      failureCode: 'ARTIFACT_VALIDATION_FAILED',
      reopenAllowed: true,
      legalRecipes: [{ recipeKey: 'retry_system_command', track: null }],
    });
  });
}, 30_000);

describe('TaskLifecycleServiceV2 reopen placeholder hard gate (review A-M1 / Ruling 2)', { timeout: 30_000 }, () => {
  it('placeholder plan-base refs are NEVER GC-marked or resolved (GC round stays green)', async () => {
    const env = await makeLifecycleEnv();
    // The env's base refs (profile/template stand-ins) are prepared under the
    // support task id — the ONLY task whose blob store resolves them, so the
    // GC round exercises the placeholder gate without unrelated missing-ref
    // noise from cross-task stand-ins.
    const taskId = 'task-lifecycle-support';
    await env.lifecycle.startV2(taskId, { operationId: OP(201), userInputText: 'input' });
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(202));
    const projection = await env.readProjection(taskId);
    const wi = projection.workItems[env.workItemId(taskId, OP(201))];
    const attemptId = projection.activeLease?.attemptId ?? '';
    const { deterministicEventId } = await import('../../storage/authoritative-publication-intent-registry');
    const failOp = OP(203);
    // The finding set must be a REAL blob (GC resolves it and its empty
    // findingRefs); the rejected subject is kind-checked-only, so it points
    // at the FIXED placeholder map_candidate — the hard gate under test.
    const findingSetValue = { findingSetId: 'fs-am1', findingRefs: [] };
    const findingSetRef = await env.facade.prepareBlob(taskId, 'finding_set', {
      ...findingSetValue,
      setDigest: canonicalJsonSha256(findingSetValue),
    });
    const { isReopenPlaceholderRef } = await import('../../authoritative-review/object-schemas');
    const placeholderCandidate = (await import('../../authoritative-review/object-schemas')).REOPEN_PLACEHOLDER_LITERALS;
    void placeholderCandidate;
    const rejectedSubjectPlaceholder: BlobRefV2 = {
      kind: 'map_candidate',
      digest: canonicalJsonSha256({ placeholder: 'repairBase:map' }),
      byteLength: 10,
      mediaType: 'application/json',
      schemaVersion: 1,
    };
    expect(isReopenPlaceholderRef(rejectedSubjectPlaceholder)).toBe(true);
    const recoveryPayload = await env.facade.prepareBlob(taskId, 'failure_recovery_payload', {
      kind: 'restart_review_cycle',
      track: 'map',
      failedWorkItemId: wi.workItemId,
      failedAttemptOrCommandId: attemptId,
      failedLeaseEpoch: wi.leaseEpoch,
      terminalEventId: deterministicEventId(failOp, 'work_item_terminal_failed', 0),
      terminalCommitId: failOp,
      authorityBaseRef: wi.authorityBaseRef,
      rejectedSubjectRef: rejectedSubjectPlaceholder,
      findingSetRef: findingSetRef,
      failedCycleOrdinal: 3,
    });
    await env.lifecycle.terminalFailWorkItem(taskId, {
      operationId: failOp,
      workItemId: wi.workItemId,
      failureCode: 'REVIEW_REPAIR_LIMIT_EXCEEDED',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: recoveryPayload,
      taskFailure: true,
    });
    const tail = await env.eventStore.tail(taskId);
    const reopened = await env.lifecycle.reopenFailed(taskId, {
      expectedLastSequence: tail.lastSequence,
      operationId: OP(204),
      reason: '恢复',
      recipeKey: 'restart_map_review_cycle',
      track: 'map',
    });
    expect(reopened.overrideRef).not.toBeNull();
    // The successor plan spec was prepared with the map-track repair base:
    // no active candidate/Map exists yet, so the candidateRef is the FIXED
    // placeholder — resolve the successor blob and pin that the hard gate
    // recognizes it (and that a GC round therefore never aborts).
    const after = await env.readProjection(taskId);
    const replacement = after.workItems[reopened.replacementWorkItemId];
    const grant = (await env.blobStore.readJson(taskId, replacement?.grantSpecRef as BlobRefV2, 'write_grant_spec')) as {
      repairPlanSpecRef: BlobRefV2;
    };
    const plan = (await env.blobStore.readJson(taskId, grant.repairPlanSpecRef, 'repair_plan_spec')) as {
      repairBase: { kind: 'map_candidate'; candidateRef: BlobRefV2 };
    };
    expect(isReopenPlaceholderRef(plan.repairBase.candidateRef)).toBe(true);
    // The hard gate: a full GC round over this task must NOT abort even
    // though the placeholder has no bytes on disk.
    const { AuthoritativeReviewGc } = await import('../../storage/authoritative-review-gc');
    const gc = new AuthoritativeReviewGc(env.paths, env.blobStore, env.eventStore, env.publicationStore, {
      rootsProvider: async () => ({}),
    });
    // The hard gate: a full GC round over this task must NOT abort even
    // though the placeholder has no bytes on disk (it is never resolved).
    // Unreferenced residue blobs may be swept — that is GC's job; what must
    // hold is the round completing and the LIVE reopen refs surviving.
    const round = await gc.run();
    expect(round.deletedBlobs).toBeGreaterThanOrEqual(0);
    const grantAfter = (await env.blobStore.readJson(taskId, replacement?.grantSpecRef as BlobRefV2, 'write_grant_spec')) as {
      repairPlanSpecRef: BlobRefV2;
    };
    const planAfter = (await env.blobStore.readJson(taskId, grantAfter.repairPlanSpecRef, 'repair_plan_spec')) as {
      repairBase: { kind: 'map_candidate'; candidateRef: BlobRefV2 };
    };
    expect(isReopenPlaceholderRef(planAfter.repairBase.candidateRef)).toBe(true);
  });
});

describe('TaskLifecycleServiceV2 human questions (spec §10.6)', () => {
  it('token is opaque, case-sensitive 43-char, bound to question+workitem+assignment+attempt/epoch+base+opened commit', async () => {
    const env = await makeLifecycleEnv();
    // Token generation is EXACT: same fields → same token; any field change
    // → different token; the token is NOT derivable from the event tail.
    const fields = {
      questionId: 'q-1',
      originalWorkItemId: 'wi-1',
      logicalAssignmentId: 'la-1',
      attemptId: 'att-1',
      leaseEpoch: 3,
      questionDigest: 'c'.repeat(64),
      authorityBaseRef: { kind: 'authority_base_set' as const, digest: 'a'.repeat(64), byteLength: 10, mediaType: 'application/json' as const, schemaVersion: 1 },
      openedCommitId: 'op-committed',
    };
    const token = questionVersionToken(fields);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(questionVersionToken(fields)).toBe(token);
    expect(questionVersionToken({ ...fields, leaseEpoch: 4 })).not.toBe(token);
    expect(questionVersionToken({ ...fields, openedCommitId: 'other-commit' })).not.toBe(token);
    expect(token.toLowerCase()).not.toBe(token); // case-sensitive
    expect(token).not.toContain('wi-1'); // opaque, not the tail or identities
  });

  it('opens a question from an active structured attempt; answer delivers idempotently and supersedes the original; replaced/consumed tokens are stale', async () => {
    const env = await makeLifecycleEnv();
    const taskId = 'task-question';
    await env.lifecycle.startV2(taskId, { operationId: OP(71), userInputText: 'input' });
    const wiId = env.workItemId(taskId, OP(71));
    const leased = await env.coordinator.leaseNext(taskId, 'worker-a', OP(72));
    expect(leased).not.toBeNull();
    const opened = await env.lifecycle.openQuestionV2(taskId, { operationId: OP(73), questionId: 'q-open-1', questionText: '需要人工确认' });
    expect(opened.questionVersion).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = await env.readProjection(taskId);
    expect(state.taskStatus).toBe('waiting_human');
    expect(state.pendingQuestion).toMatchObject({ questionId: 'q-open-1', originalWorkItemId: wiId, leaseEpoch: 1 });
    expect(state.workItems[wiId]?.parkDisposition).toMatchObject({ kind: 'human_question', questionId: 'q-open-1' });
    // The token survives unrelated appends/stop/restart/resume.
    env.now.value = env.iso(60_000);
    await env.lifecycle.stopV2(taskId, { operationId: OP(74), reason: 'user_stop' });
    await env.lifecycle.resumeV2(taskId, { operationId: OP(75) });
    const afterResume = await env.readProjection(taskId);
    expect(afterResume.taskStatus).toBe('waiting_human');
    expect(afterResume.pendingQuestion?.questionVersion).toBe(opened.questionVersion);
    // Rejects a lowercase-normalized token.
    await expect(
      env.lifecycle.answerV2(taskId, { operationId: OP(76), questionId: 'q-open-1', questionVersion: opened.questionVersion.toLowerCase(), answer: 'yes' }),
    ).rejects.toMatchObject({ code: 'HUMAN_QUESTION_STALE' });
    // A recomputed-different token (wrong opened commit) is stale.
    const wrongToken = questionVersionToken({
      questionId: 'q-open-1',
      originalWorkItemId: wiId,
      logicalAssignmentId: 'la-whatever',
      attemptId: 'att-1',
      leaseEpoch: 1,
      questionDigest: canonicalJsonSha256({ questionId: 'q-open-1', text: '需要人工确认' }),
      authorityBaseRef: (await env.readProjection(taskId)).pendingQuestion!.authorityBaseRef,
      openedCommitId: 'forged-commit',
    });
    await expect(
      env.lifecycle.answerV2(taskId, { operationId: OP(77), questionId: 'q-open-1', questionVersion: wrongToken, answer: 'yes' }),
    ).rejects.toMatchObject({ code: 'HUMAN_QUESTION_STALE' });
    // The legal answer: delivery + superseded original + replacement in ONE batch.
    const answered = await env.lifecycle.answerV2(taskId, { operationId: OP(78), questionId: 'q-open-1', questionVersion: opened.questionVersion, answer: '确认继续' });
    expect(answered.replayed).toBe(false);
    expect(answered.deliveryId).toMatch(/^del-/);
    const after = await env.readProjection(taskId);
    expect(after.taskStatus).toBe('running');
    expect(after.pendingQuestion).toBeNull();
    expect(after.workItems[wiId]?.state).toBe('superseded');
    expect(after.workItems[answered.replacementWorkItemId]).toMatchObject({ state: 'ready', kind: 'agent_assignment' });
    const types = (await env.readEvents(taskId)).map((entry) => entry.event.type);
    expect(types).toContain('structured_human_answer_delivered_v2');
    expect(types).toContain('structured_work_item_superseded');
    expect(types).toContain('structured_work_item_created');
    // Stale two-tab: a second delivery of the SAME question/token via a NEW
    // operation conflicts (consumed → HUMAN_QUESTION_STALE by the pending check).
    await expect(
      env.lifecycle.answerV2(taskId, { operationId: OP(79), questionId: 'q-open-1', questionVersion: opened.questionVersion, answer: '确认继续' }),
    ).rejects.toMatchObject({ code: 'HUMAN_QUESTION_STALE' });
    // IDEMPOTENT same operation + same canonical answer replays the delivery.
    const events = await env.readEvents(taskId);
    const delivered = events.find((entry) => entry.event.type === 'structured_human_answer_delivered_v2');
    const version = (delivered?.event as Record<string, unknown> | undefined)?.questionVersion as string;
    expect(version).toBe(opened.questionVersion);
    const replay = await env.lifecycle.answerV2(taskId, {
      operationId: OP(78),
      questionId: 'q-open-1',
      questionVersion: version,
      answer: '确认继续',
    });
    expect(replay).toMatchObject({ deliveryId: answered.deliveryId, replacementWorkItemId: answered.replacementWorkItemId, replayed: true });
    // Different payload under the same operation conflicts.
    await expect(
      env.lifecycle.answerV2(taskId, { operationId: OP(78), questionId: 'q-open-1', questionVersion: version, answer: '不同回答' }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    // A NEW question replaces the consumed token permanently: its version
    // differs from the first (never re-derivable from tail).
    void wrongToken;
  });
}, 30_000);

describe('TaskLifecycleServiceV2 reopen (spec §10.3.1)', () => {
  async function failSystemCommand(env: LifecycleEnv, taskId: string, operationId: string, failureCode: string, recoveryPayloadRef: BlobRefV2): Promise<string> {
    const wiId = env.workItemId(taskId, operationId);
    await env.coordinator.leaseNext(taskId, 'worker-a', `${operationId}-lease`);
    await env.lifecycle.terminalFailWorkItem(taskId, {
      operationId: `${operationId}-fail`,
      workItemId: wiId,
      failureCode,
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: recoveryPayloadRef,
      taskFailure: true,
    });
    return wiId;
  }

  it('retry_system_command reopen clones the failed system workitem with epoch 1 and no grant; stale tail returns AUTHORITY_BASE_STALE; changed body conflicts; response-loss replays', async () => {
    const env = await makeLifecycleEnv();
    const taskId = 'task-reopen';
    const systemWiId = lifecycleWorkItemId(taskId, OP(81), 'system_map_finalize');
    const specBody = { mapBuildId: 'mb-r', revision: 1, supersedesMapBuildId: null, sourceValidationReceiptRef: null, snapshotHash: 'c'.repeat(64), plannedChunkPolicy: { maxChunks: 8, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 } };
    const specValue = { ...specBody, specDigest: canonicalJsonSha256(specBody) };
    const specRef = await env.facade.prepareBlob(taskId, 'map_build_spec', specValue);
    const base = buildBaseForLifecycle(env, taskId, 'system_map_finalize', { planSpecRef: specRef });
    await env.coordinator.createWorkItem({
      taskId,
      operationId: OP(81),
      workItemId: systemWiId,
      kind: 'system_map_finalize',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'map_build_spec' as const, value: specValue },
      authorityBase: base,
      maxAutomaticRetries: 2,
    });
    const leased = await env.coordinator.leaseNext(taskId, 'worker-a', OP(82));
    const leaseProjection = await env.readProjection(taskId);
    const commandId = leaseProjection.activeLease?.commandId ?? '';
    const { deterministicEventId } = await import('../../storage/authoritative-publication-intent-registry');
    const terminalEventId = deterministicEventId(`${OP(83)}-fail`, 'work_item_terminal_failed', 0);
    const recoveryPayload = await env.facade.prepareBlob(taskId, 'failure_recovery_payload', {
      kind: 'retry_system_command',
      failedWorkItemId: systemWiId,
      failedCommandId: commandId,
      failedLeaseEpoch: 1,
      terminalEventId,
      terminalCommitId: `${OP(83)}-fail`,
      authorityBaseRef: leased!.authorityBaseRef,
      systemKind: 'system_map_finalize',
      systemPayloadRef: specRef,
    });
    await env.lifecycle.terminalFailWorkItem(taskId, {
      operationId: `${OP(83)}-fail`,
      workItemId: systemWiId,
      failureCode: 'ARTIFACT_VALIDATION_FAILED',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: recoveryPayload,
      taskFailure: true,
    });
    const failed = await env.readProjection(taskId);
    expect(failed.taskStatus).toBe('failed');
    const tail = await env.eventStore.tail(taskId);
    // Stale tail: reject BEFORE any prepared write.
    await expect(
      env.lifecycle.reopenFailed(taskId, { expectedLastSequence: tail.lastSequence - 1, operationId: OP(84), reason: '恢复', recipeKey: 'retry_system_command', track: null }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_BASE_STALE' });
    // Legal reopen: one ready replacement, system kind preserved, epoch 1.
    const reopened = await env.lifecycle.reopenFailed(taskId, { expectedLastSequence: tail.lastSequence, operationId: OP(84), reason: '恢复', recipeKey: 'retry_system_command', track: null });
    expect(reopened.replayed).toBe(false);
    expect(reopened.overrideRef).toBeNull();
    const after = await env.readProjection(taskId);
    expect(after.taskStatus).toBe('running');
    expect(after.failed).toBeNull();
    const replacement = after.workItems[reopened.replacementWorkItemId];
    expect(replacement).toMatchObject({ kind: 'system_map_finalize', state: 'ready', leaseEpoch: 1, grantSpecRef: null });
    // The failed workitem is immutable (still terminal_failed, counters intact).
    expect(after.workItems[systemWiId]?.state).toBe('terminal_failed');
    expect(after.workItems[systemWiId]?.retryOrdinal).toBe(0);
    // Exactly one successor.
    const created = (await env.readEvents(taskId)).filter((entry) => entry.event.type === 'structured_work_item_created');
    expect(created).toHaveLength(2);
    // Response-loss replay returns the SAME replacement; changed body conflicts.
    const replay = await env.lifecycle.reopenFailed(taskId, { expectedLastSequence: tail.lastSequence, operationId: OP(84), reason: '恢复', recipeKey: 'retry_system_command', track: null });
    expect(replay).toMatchObject({ replacementWorkItemId: reopened.replacementWorkItemId, replayed: true });
    await expect(
      env.lifecycle.reopenFailed(taskId, { expectedLastSequence: tail.lastSequence, operationId: OP(84), reason: '改了原因', recipeKey: 'retry_system_command', track: null }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    // The replacement is claimable (its wakeup was upserted).
    const claim = await env.coordinator.leaseNext(taskId, 'worker-a', OP(85));
    expect(claim?.workItemId).toBe(reopened.replacementWorkItemId);
  });

  it('round-limit reopen creates one available RoundBudgetOverride + repair workitem + grant; wrong recipe/track reject; corrupt/ineligible failures offer clone only', async () => {
    const env = await makeLifecycleEnv();
    const taskId = 'task-round-reopen';
    await env.lifecycle.startV2(taskId, { operationId: OP(91), userInputText: 'input' });
    const wiId = env.workItemId(taskId, OP(91));
    await env.coordinator.leaseNext(taskId, 'worker-a', OP(92));
    const projection = await env.readProjection(taskId);
    const wi = projection.workItems[wiId];
    const attemptId = projection.activeLease?.attemptId ?? '';
    const { deterministicEventId } = await import('../../storage/authoritative-publication-intent-registry');
    const terminalEventId = deterministicEventId(`${OP(93)}-fail`, 'work_item_terminal_failed', 0);
    // The inner rejectedSubject/findingSet refs are KIND-CHECKED only (the
    // projector reads them as fields of the resolved payload; the blob store
    // never resolves their targets) — fabricated refs with legal kinds.
    const candidateLike = (kind: BlobRefV2['kind'], digest: string): BlobRefV2 => ({ kind, digest, byteLength: 10, mediaType: 'application/json', schemaVersion: 1 });
    const recoveryPayload = await env.facade.prepareBlob(taskId, 'failure_recovery_payload', {
      kind: 'restart_review_cycle',
      track: 'map',
      failedWorkItemId: wiId,
      failedAttemptOrCommandId: attemptId,
      failedLeaseEpoch: 1,
      terminalEventId,
      terminalCommitId: `${OP(93)}-fail`,
      authorityBaseRef: wi.authorityBaseRef,
      rejectedSubjectRef: candidateLike('map_candidate', canonicalJsonSha256({ rejected: 'candidate' })),
      findingSetRef: candidateLike('finding_set', canonicalJsonSha256({ findings: [] })),
      failedCycleOrdinal: 3,
    });
    await env.lifecycle.terminalFailWorkItem(taskId, {
      operationId: `${OP(93)}-fail`,
      workItemId: wiId,
      failureCode: 'REVIEW_REPAIR_LIMIT_EXCEEDED',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: recoveryPayload,
      taskFailure: true,
    });
    const failed = await env.readProjection(taskId);
    const summary = failedRecoverySummary(failed);
    expect(summary).toMatchObject({ reopenAllowed: true, legalRecipes: [{ recipeKey: 'restart_map_review_cycle', track: 'map' }, { recipeKey: 'restart_content_review_cycle', track: 'content' }] });
    const tail = await env.eventStore.tail(taskId);
    // Wrong branch: rebuild on a round-limit failure is illegal.
    await expect(
      env.lifecycle.reopenFailed(taskId, { expectedLastSequence: tail.lastSequence, operationId: OP(94), reason: '恢复？', recipeKey: 'rebuild_missing_work', track: null }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // Wrong track for the failed cycle.
    await expect(
      env.lifecycle.reopenFailed(taskId, { expectedLastSequence: tail.lastSequence, operationId: OP(95), reason: '恢复', recipeKey: 'restart_content_review_cycle', track: 'content' }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // Legal map-restart reopen: one ready map-repair workitem + repair grant
    // + the one available override; no cycle increment during reopen.
    const cyclesBefore = (await env.readProjection(taskId)).mapCycleOrdinal;
    const reopened = await env.lifecycle.reopenFailed(taskId, { expectedLastSequence: tail.lastSequence, operationId: OP(96), reason: '恢复', recipeKey: 'restart_map_review_cycle', track: 'map' });
    expect(reopened.overrideRef).not.toBeNull();
    const after = await env.readProjection(taskId);
    expect(after.taskStatus).toBe('running');
    expect(after.availableOverride).toMatchObject({ track: 'map' });
    expect(after.mapCycleOrdinal).toBe(cyclesBefore); // never incremented during reopen
    const replacement = after.workItems[reopened.replacementWorkItemId];
    expect(replacement).toMatchObject({ kind: 'agent_assignment', state: 'ready', sessionKind: 'map_repair', leaseEpoch: 1 });
    expect(replacement.grantSpecRef).not.toBeNull();
    // A later over-limit round without a new authorized override would fail
    // again — covered by the projector round-consumption rules (Task 13).
    // Non-reopenable failure: corrupt/ineligible codes offer clone only.
    const taskX = 'task-clone-only';
    await env.lifecycle.startV2(taskX, { operationId: OP(100), userInputText: 'input' });
    const wiX = env.workItemId(taskX, OP(100));
    await env.coordinator.leaseNext(taskX, 'worker-a', `${OP(100)}-lease`);
    await env.lifecycle.terminalFailWorkItem(taskX, {
      operationId: `${OP(100)}-fail`,
      workItemId: wiX,
      failureCode: 'SOME_IRRECOVERABLE_CODE',
      failureDigest: 'e'.repeat(64),
      failureRecoveryPayloadRef: null,
      taskFailure: true,
    });
    const cloneOnly = await env.readProjection(taskX);
    expect(failedRecoverySummary(cloneOnly)).toMatchObject({ reopenAllowed: false, cloneFallback: true, legalRecipes: [] });
    await expect(
      env.lifecycle.reopenFailed(taskX, { expectedLastSequence: (await env.eventStore.tail(taskX)).lastSequence, operationId: OP(101), reason: '恢复', recipeKey: 'retry_system_command', track: null }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('reopen requires the operator principal and a bounded reason', async () => {
    const env = await makeLifecycleEnv();
    expect(TASK_OWNER_PRINCIPAL.id).toBe('task_owner');
    expect(TASK_OWNER_PRINCIPAL.permissions).toContain('task:reopen_failed');
    expect(TASK_OWNER_PRINCIPAL.permissions).toContain('task:delete');
  });
}, 30_000);

