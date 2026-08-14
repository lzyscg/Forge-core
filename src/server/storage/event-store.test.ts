// @vitest-environment node
/**
 * Append-only event store tests (plan Phase B Task 3; tightened to the
 * canonical task event union in plan Phase B Task 4).
 *
 * One committed event = one file `events/<six-digit-sequence>-<uuid>.json`
 * (spec §8.1). The store allocates sequences by scanning committed filenames
 * (ignoring `.tmp-*` residue and malformed names), serializes appends per
 * task within the single process, and validates every payload against the
 * canonical union in `task-events.ts` (the single authoritative source shared
 * with the projector and the Phase C committer) before writing. A duplicate
 * event id stays idempotent only when canonical JSON bytes match — otherwise
 * EVENT_ID_CONFLICT. Corrupt committed files (malformed JSON, unknown event
 * type, sequence gap) fail loud with TASK_CORRUPTED instead of being guessed
 * away; isolating them into a diagnostic summary is the list layer's job
 * (spec §8.3, plan Task 4).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  makeTempCorePaths,
} from '../test-support';
import type { CorePaths } from './core-paths';
import { formatBatchFileName, formatEventFileName } from './core-paths';
import { EventStore } from './event-store';
import type { TaskEvent } from './task-events';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import type { StoreFenceProof, StoreFenceRecord } from './authoritative-publication-store';

afterEach(() => {
  disposeAllTestRoots();
});

function started(): TaskEvent {
  return makeTaskEvent({ type: 'task_started' });
}

function input(sequence = 1): TaskEvent {
  return makeTaskEvent({ type: 'agent_input', node: makeEventNode({ kind: 'input', sequence }) });
}

function result(sequence = 2): TaskEvent {
  return makeTaskEvent({
    type: 'agent_result',
    node: makeEventNode({ kind: 'result', sequence }),
  });
}

/** Committed (non-temporary, non-dotfile) event filenames on disk, sorted. */
async function committedFileNames(paths: CorePaths, taskId: string): Promise<string[]> {
  return (await readdir(paths.taskEventsRoot(taskId)))
    .filter((name) => !name.startsWith('.tmp-') && !name.startsWith('.'))
    .sort();
}

describe('EventStore', () => {
  it('appends committed events with six-digit sequences and event-id filenames', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const first = started();
    const second = input();

    const committedFirst = await store.append(taskId, first);
    const committedSecond = await store.append(taskId, second);

    expect(committedFirst.sequence).toBe(1);
    expect(committedSecond.sequence).toBe(2);
    expect(committedFirst.fileName).toBe(formatEventFileName(1, first.id));
    expect(committedSecond.fileName).toBe(formatEventFileName(2, second.id));
    expect(await committedFileNames(paths, taskId)).toEqual(
      [committedFirst.fileName, committedSecond.fileName].sort(),
    );
    expect(committedFirst.size).toBeGreaterThan(0);
    const committed = await store.read(taskId);
    expect(committed.map((item) => item.event)).toEqual([first, second]);
    // Reported byte size matches the on-disk committed file.
    const onDisk = await stat(paths.taskEventFile(taskId, committedFirst.fileName));
    expect(committedFirst.size).toBe(onDisk.size);
  });

  it('reads committed events in sequence order, ignoring temporary and malformed files', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const first = await store.append(taskId, started());
    const second = await store.append(taskId, input());
    const eventsDir = paths.taskEventsRoot(taskId);
    await writeFile(`${eventsDir}/.tmp-000003-${randomUUID()}.json`, 'partial garbage', 'utf8');
    await writeFile(`${eventsDir}/not-an-event.txt`, 'irrelevant', 'utf8');
    await writeFile(`${eventsDir}/12-short-sequence.json`, '{}', 'utf8');

    const committed = await store.read(taskId);
    expect(committed.map((item) => item.fileName)).toEqual([first.fileName, second.fileName]);
    expect(committed.map((item) => item.sequence)).toEqual([1, 2]);
  });

  it('returns the prior committed event for a duplicate id with identical canonical bytes', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const eventId = randomUUID();
    const at = new Date().toISOString();
    const node = makeEventNode({ kind: 'result', sequence: 2 });

    const original = await store.append(taskId, { id: eventId, at, type: 'agent_result', node });
    // Different key order, same logical payload: canonical JSON bytes match.
    const replay = await store.append(taskId, { at, node, type: 'agent_result', id: eventId });

    expect(replay).toEqual(original);
    expect(await committedFileNames(paths, taskId)).toEqual([original.fileName]);
  });

  it('rejects a duplicate event id with different bytes as EVENT_ID_CONFLICT', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const eventId = randomUUID();

    const original = await store.append(taskId, makeTaskEvent({ id: eventId, type: 'task_started' }));
    await expect(
      store.append(taskId, makeTaskEvent({ id: eventId, type: 'task_stopped' })),
    ).rejects.toMatchObject({ code: 'EVENT_ID_CONFLICT' });
    expect(await committedFileNames(paths, taskId)).toEqual([original.fileName]);
  });

  it('validates canonical event payloads before writing anything', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const id = randomUUID();
    const at = new Date().toISOString();
    const node = makeEventNode();
    const route = { sequence: 1, fromNodeId: 'a', toNodeId: 'b', kind: 'message', label: 'l' };
    const artifact = {
      version: 1,
      title: '产物',
      sourceNodeId: 'a',
      format: 'markdown',
      contentHash: 'a'.repeat(64),
    };
    const invalid: unknown[] = [
      null,
      'not-an-object',
      [id, 'task_started'],
      { id, at, type: '' },
      { id: '../escape', at, type: 'task_started' },
      { id: 123, at, type: 'task_started' },
      { at, type: 'task_started' }, // missing id
      { id, type: 'task_started' }, // missing at
      { id, at: 'not-a-timestamp', type: 'task_started' },
      { id, at, type: 'has space' },
      { id, at, type: 'totally_unknown' }, // outside the canonical union
      { id, at, type: 'task_started', extra: 1 }, // unknown extra key
      { id, at, type: 'agent_input' }, // missing node
      { id, at, type: 'agent_input', node: { ...node, sequence: 0 } },
      { id, at, type: 'agent_input', node: { ...node, attemptCount: 0 } },
      { id, at, type: 'agent_input', node: { ...node, kind: 'banana' } },
      { id, at, type: 'agent_input', node: { ...node, inputVersion: 0 } },
      { id, at, type: 'agent_input', node: { ...node, title: 42 } },
      { id, at, type: 'agent_input', node: { ...node, extra: 1 } },
      { id, at, type: 'agent_input', node: null },
      { id, at, type: 'agent_attempt_failed', nodeId: 'n1', message: 'm' }, // missing retryable
      { id, at, type: 'agent_attempt_failed', nodeId: '', message: 'm', retryable: true },
      { id, at, type: 'route_executed' }, // missing route
      { id, at, type: 'route_executed', route: { ...route, kind: 'banana' } },
      { id, at, type: 'artifact_published' }, // missing artifact
      { id, at, type: 'artifact_published', artifact: { ...artifact, contentHash: 'zz' } },
      { id, at, type: 'artifact_published', artifact: { ...artifact, version: 0 } },
      { id, at, type: 'artifact_published', artifact: { ...artifact, format: 'pdf' } },
      { id, at, type: 'human_requested', node }, // missing question
      { id, at, type: 'human_answered', node, answer: '' },
      { id, at, type: 'final_submission_accepted', artifactId: 'a' }, // missing version
      { id, at, type: 'final_submission_accepted', artifactId: 'a', version: 0 },
      { id, at, type: 'skill_loaded' }, // missing skillId
      { id, at, type: 'task_started', count: Number.NaN },
      { id, at, type: 'task_started', when: new Date() },
      { id, at, type: 'task_started', nested: { fn: () => 1 } },
      { id, at, type: 'task_started', missing: undefined },
    ];
    for (const candidate of invalid) {
      await expect(
        store.append(taskId, candidate as TaskEvent),
      ).rejects.toMatchObject({ code: 'EVENT_INVALID' });
    }
    // Nothing was written and the sequence is still fresh.
    const eventsDir = paths.taskEventsRoot(taskId);
    await expect(readdir(eventsDir)).rejects.toThrow();
    const next = await store.append(taskId, started());
    expect(next.sequence).toBe(1);
  });

  it('serializes concurrent appends into one contiguous sequence', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const events = Array.from({ length: 20 }, (_, index) => input(index + 1));

    await Promise.all(events.map((event) => store.append(taskId, event)));

    const committed = await store.read(taskId);
    expect(committed.map((item) => item.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(new Set(committed.map((item) => item.event.id))).toEqual(
      new Set(events.map((event) => event.id)),
    );
  });

  it('continues the sequence after a simulated restart from disk', async () => {
    const { paths } = makeTempCorePaths();
    const taskId = randomUUID();
    const firstStore = new EventStore(paths);
    await firstStore.append(taskId, started());
    await firstStore.append(taskId, input());

    const restarted = new EventStore(paths);
    const third = await restarted.append(taskId, result(3));
    expect(third.sequence).toBe(3);
    expect(await restarted.read(taskId)).toHaveLength(3);
  });

  it('fails loud on a corrupt committed file instead of guessing', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());
    const eventsDir = paths.taskEventsRoot(taskId);
    await mkdir(eventsDir, { recursive: true });
    await writeFile(`${eventsDir}/000002-${randomUUID()}.json`, '{corrupt', 'utf8');

    await expect(store.read(taskId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await expect(store.append(taskId, input())).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
  });

  it('treats a committed event of unknown type as corruption', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());
    const alienId = randomUUID();
    await writeFile(
      paths.taskEventFile(taskId, formatEventFileName(2, alienId)),
      JSON.stringify({ id: alienId, at: new Date().toISOString(), type: 'totally_unknown' }),
      'utf8',
    );

    await expect(store.read(taskId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('treats a sequence gap as corruption', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());
    const second = await store.append(taskId, input());
    await store.append(taskId, result(3));

    await rm(paths.taskEventFile(taskId, second.fileName));

    await expect(store.read(taskId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('reads an unknown task as an empty history', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    expect(await store.read('no-such-task')).toEqual([]);
  });
});

describe('EventStore.appendBatch', () => {
  it('commits a batch as one atomic envelope file with contiguous sequences', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const legacy = await store.append(taskId, started());
    const events = [input(), result(), started()];

    const committed = await store.appendBatch(taskId, 'commit-a', events, {
      expectedLastSequence: 1,
    });

    expect(committed.map((entry) => entry.sequence)).toEqual([2, 3, 4]);
    expect(committed.map((entry) => entry.fileName)).toEqual([
      committed[0].fileName,
      committed[0].fileName,
      committed[0].fileName,
    ]);
    expect(committed[0].fileName).toBe(formatBatchFileName(2, 4, 'commit-a'));
    expect(committed[0].size).toBeGreaterThan(0);
    // Exactly one batch envelope file exists alongside the legacy file.
    const names = (await readdir(paths.taskEventsRoot(taskId))).filter(
      (name) => !name.startsWith('.tmp-') && !name.startsWith('.'),
    );
    expect(names.sort()).toEqual([legacy.fileName, formatBatchFileName(2, 4, 'commit-a')].sort());
    // The batch reads back flattened, no envelope visible to the projector.
    const all = await store.read(taskId);
    expect(all.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    expect(all.map((entry) => entry.event)).toEqual([legacy.event, ...events]);
  });

  it('rejects a batch with zero events before writing anything', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await expect(
      store.appendBatch(taskId, 'commit-a', [], { expectedLastSequence: 0 }),
    ).rejects.toMatchObject({ code: 'EVENT_INVALID' });
    await expect(readdir(paths.taskEventsRoot(taskId))).rejects.toThrow();
  });

  it('rejects an unsafe commitId before writing anything', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await expect(
      store.appendBatch(taskId, '../escape', [started()], { expectedLastSequence: 0 }),
    ).rejects.toMatchObject({ code: 'EVENT_INVALID' });
    await expect(readdir(paths.taskEventsRoot(taskId))).rejects.toThrow();
  });

  it('replays an identical commitId with identical payload as the original result', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const events = [started(), input()];

    const firstResult = await store.appendBatch(taskId, 'commit-a', events, {
      expectedLastSequence: 0,
    });
    expect(firstResult).toHaveLength(events.length);

    const replay = await store.appendBatch(taskId, 'commit-a', events, {
      expectedLastSequence: 0,
    });
    expect(replay).toEqual(firstResult);
    // Idempotent replay never duplicates the envelope on disk.
    expect((await committedFileNames(paths, taskId)).length).toBe(1);
  });

  it('rejects a different payload under the same commitId as IDEMPOTENCY_CONFLICT', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const events = [started(), input()];
    const changed = [started(), result()];

    await store.appendBatch(taskId, 'commit-a', events, { expectedLastSequence: 0 });
    await expect(
      store.appendBatch(taskId, 'commit-a', changed, { expectedLastSequence: 0 }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // The conflicting attempt wrote nothing new.
    expect((await committedFileNames(paths, taskId)).length).toBe(1);
    const all = await store.read(taskId);
    expect(all.map((entry) => entry.event)).toEqual(events);
  });

  it('rejects an expectedLastSequence mismatch as a CAS conflict', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());

    await expect(
      store.appendBatch(taskId, 'commit-a', [input()], { expectedLastSequence: 0 }),
    ).rejects.toMatchObject({ code: 'EXPECTED_SEQUENCE_MISMATCH' });
    // Nothing was written by the failed CAS.
    expect((await committedFileNames(paths, taskId)).length).toBe(1);
  });

  it('rejects a batch event id that already exists in the history', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const existing = await store.append(taskId, started());

    await expect(
      store.appendBatch(taskId, 'commit-a', [existing.event], { expectedLastSequence: 1 }),
    ).rejects.toMatchObject({ code: 'EVENT_ID_CONFLICT' });
    expect((await committedFileNames(paths, taskId)).length).toBe(1);
  });

  it('rejects an invalid member before any file is written (all-or-nothing)', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const invalid = [
      {
        id: randomUUID(),
        at: new Date().toISOString(),
        type: 'structured_slot_attempt_started',
        inputNodeId: 'input-1',
        agentId: 'agent-1',
        attemptEpoch: 0,
        turnId: 'turn-1',
        sessionKind: 'structure',
      },
      {
        id: randomUUID(),
        at: new Date().toISOString(),
        type: 'structured_slot_attempt_terminal',
        inputNodeId: 'input-1',
        attemptEpoch: 1,
        turnId: 'turn-1',
        status: 'teleported',
        reason: 'completion_dispatch',
      },
      {
        id: randomUUID(),
        at: new Date().toISOString(),
        type: 'structured_scaffold_generation_committed',
        scaffoldId: 's',
        generationId: 'g',
        supersedesGenerationId: null,
        rootSlotId: 'r',
        slotCount: 1,
        maxDepth: 1,
        structure: { version: 1, kind: 'generation', sha256: 'a'.repeat(64), byteLength: 1 },
        content: { version: 1, kind: 'content_revision', sha256: 'b'.repeat(64), byteLength: 2 },
        contentRevision: 0,
        proposalId: 'p',
        bogus: 1,
      },
    ];
    for (const candidate of invalid) {
      await expect(
        store.appendBatch(taskId, 'commit-a', [candidate as TaskEvent], {
          expectedLastSequence: 0,
        }),
      ).rejects.toMatchObject({ code: 'EVENT_INVALID' });
    }
    await expect(readdir(paths.taskEventsRoot(taskId))).rejects.toThrow();
  });
});

describe('EventStore.readBatchByCommitId and crash windows', () => {
  it('returns the fully validated flattened batch for a known commitId', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const events = [started(), input()];
    const committed = await store.appendBatch(taskId, 'commit-a', events, {
      expectedLastSequence: 0,
    });

    const read = await store.readBatchByCommitId(taskId, 'commit-a');
    expect(read).toEqual(committed);
  });

  it('returns null for an unknown commitId', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());
    await store.appendBatch(taskId, 'commit-a', [input()], { expectedLastSequence: 1 });

    expect(await store.readBatchByCommitId(taskId, 'no-such-commit')).toBeNull();
  });

  it('rejects a corrupt batch envelope as TASK_CORRUPTED', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const eventsRoot = paths.taskEventsRoot(taskId);
    await mkdir(eventsRoot, { recursive: true });
    const commitId = 'commit-a';
    const envelope = {
      version: 1,
      commitId,
      taskId,
      firstSequence: 1,
      eventCount: 1,
      events: [started()],
      canonicalPayloadSha256: '0'.repeat(64), // tampered digest
    };
    await writeFile(
      `${eventsRoot}/${formatBatchFileName(1, 1, commitId)}`,
      JSON.stringify(envelope),
      'utf8',
    );

    await expect(store.readBatchByCommitId(taskId, commitId)).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
    await expect(store.read(taskId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('never treats a legacy single-event file as a named batch', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const event = await store.append(taskId, started());

    expect(await store.readBatchByCommitId(taskId, 'anything')).toBeNull();
    expect(await store.readBatchByCommitId(taskId, event.event.id)).toBeNull();
  });

  it('survives a crash before the atomic rename by ignoring temp residue', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const eventsRoot = paths.taskEventsRoot(taskId);
    await mkdir(eventsRoot, { recursive: true });
    // writeNewAtomic stages a same-directory `.tmp-*` file before renaming; a
    // crash before the rename leaves only that residue, which must not be
    // readable and must not advance the logical tail.
    await writeFile(
      `${eventsRoot}/.tmp-${formatBatchFileName(1, 2, 'commit-a')}-${randomUUID()}`,
      'partial envelope',
      'utf8',
    );
    expect(await store.read(taskId)).toEqual([]);

    const result = await store.appendBatch(taskId, 'commit-a', [started(), input()], {
      expectedLastSequence: 0,
    });
    expect(result.map((entry) => entry.sequence)).toEqual([1, 2]);
    const all = await store.read(taskId);
    expect(all.map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it('reads every member of a batch after the envelope rename', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const events = [started(), input(), result()];

    const committed = await store.appendBatch(taskId, 'commit-a', events, {
      expectedLastSequence: 0,
    });

    const all = await store.read(taskId);
    expect(all.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(all.map((entry) => entry.event)).toEqual(events);
    expect(all.map((entry) => entry.fileName)).toEqual([
      committed[0].fileName,
      committed[0].fileName,
      committed[0].fileName,
    ]);
  });
});

describe('EventStore v2 protocol members (plan 2026-08-14 Task 7)', () => {
  const HASH64 = 'a'.repeat(64);

  function ref(kind: BlobRefV2['kind']): BlobRefV2 {
    return {
      kind,
      digest: HASH64,
      byteLength: 12,
      mediaType: 'application/json',
      schemaVersion: 1,
    };
  }

  function v2WorkItemCreated(id: string): TaskEvent {
    return {
      protocolVersion: 2,
      id,
      at: '2026-08-14T00:00:00.000Z',
      type: 'structured_work_item_created',
      workItemId: 'wi-1',
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      roundId: 'round-1',
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      grantSpecRef: ref('write_grant_spec'),
      inputArtifactDeliveryId: null,
      authorityBaseRef: ref('authority_base_set'),
      payloadRef: ref('map_build_spec'),
      initialLeaseEpoch: 0,
      maxAutomaticRetries: 3,
    };
  }

  function v2AttemptStarted(id: string): TaskEvent {
    return {
      protocolVersion: 2,
      id,
      at: '2026-08-14T00:01:00.000Z',
      type: 'structured_agent_attempt_started_v2',
      workItemId: 'wi-1',
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      attemptId: 'att-1',
      sessionKind: 'structure_chunk',
      leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set'),
    };
  }

  /**
   * Mints a valid facade-style fence proof: the durable fence record file is
   * written first, then a proof that exactly matches it. Only the (locked)
   * publication facade normally holds such a proof; Task 8 tests mint them
   * directly to exercise EventStore's fence validation in isolation.
   */
  async function mintFenceProof(paths: CorePaths): Promise<StoreFenceProof> {
    const record: StoreFenceRecord = {
      ownerPid: process.pid,
      processStartToken: 'test-session',
      processStartTime: null,
      bootId: 'test-boot',
      leaseEpoch: 1,
      acquisitionNonce: randomUUID(),
      durableGeneration: 0,
      acquiredAt: '2026-08-14T00:00:00.000Z',
    };
    await writeFile(paths.storeFenceRecordFile(), JSON.stringify(record), 'utf8');
    return {
      ownerPid: record.ownerPid,
      processStartToken: record.processStartToken,
      leaseEpoch: record.leaseEpoch,
      acquisitionNonce: record.acquisitionNonce,
      durableGeneration: record.durableGeneration,
    };
  }

  it('commits a v2 member and mixed legacy/v2 batches as one atomic envelope', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const fenceProof = await mintFenceProof(paths);
    const first = await store.append(taskId, started());
    const v2Batch = [v2WorkItemCreated(randomUUID()), v2AttemptStarted(randomUUID())];
    const mixed = v2Batch.concat(result());

    const committed = await store.appendBatch(taskId, 'commit-v2-a', mixed, {
      expectedLastSequence: 1,
      fenceProof,
    });

    expect(committed.map((entry) => entry.sequence)).toEqual([2, 3, 4]);
    expect(committed[0].fileName).toBe(formatBatchFileName(2, 4, 'commit-v2-a'));
    const all = await store.read(taskId);
    expect(all.map((entry) => entry.event)).toEqual([first.event, ...mixed]);
    // The v2 member keeps its protocolVersion through commit and replay.
    const replayed = all.map((entry) => entry.event)[1];
    expect(replayed).toMatchObject({ protocolVersion: 2, type: 'structured_work_item_created' });
    expect((replayed as Extract<TaskEvent, { type: 'structured_work_item_created' }>).kind).toBe(
      'agent_assignment',
    );
  });

  it('rejects an invalid v2 member before writing anything (all-or-nothing)', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const fenceProof = await mintFenceProof(paths);
    const badV2: Record<string, unknown> = JSON.parse(JSON.stringify(v2WorkItemCreated(randomUUID())));
    delete badV2.authorityBaseRef;
    await expect(
      store.appendBatch(taskId, 'commit-v2-bad', [started(), badV2 as unknown as TaskEvent], {
        expectedLastSequence: 0,
        fenceProof,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_INVALID' });
    await expect(readdir(paths.taskEventsRoot(taskId))).rejects.toThrow();
  });

  it('replays an identical v2 commit and rejects a conflicting one', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const fenceProof = await mintFenceProof(paths);
    const events = [v2WorkItemCreated('ev-v2-1')];

    const firstResult = await store.appendBatch(taskId, 'commit-v2-replay', events, {
      expectedLastSequence: 0,
      fenceProof,
    });
    const replay = await store.appendBatch(taskId, 'commit-v2-replay', events, {
      expectedLastSequence: 0,
      fenceProof,
    });
    expect(replay).toEqual(firstResult);

    await expect(
      store.appendBatch(taskId, 'commit-v2-replay', [v2AttemptStarted('ev-v2-1')], {
        expectedLastSequence: 0,
        fenceProof,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('fails loud as corruption when a v2 committed member no longer validates', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const fenceProof = await mintFenceProof(paths);
    await store.appendBatch(taskId, 'commit-v2-c', [v2WorkItemCreated('ev-v2-c')], {
      expectedLastSequence: 0,
      fenceProof,
    });
    // Corrupt the committed bytes: drop the required payloadRef key while
    // keeping valid JSON, then read — the union validator fails loud.
    const names = (await readdir(paths.taskEventsRoot(taskId))).filter(
      (name) => !name.startsWith('.tmp-') && !name.startsWith('.'),
    );
    const envelopePath = paths.taskBatchEventFile(taskId, names[0]);
    const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
    delete envelope.events[0].payloadRef;
    await writeFile(envelopePath, JSON.stringify(envelope), 'utf8');
    await expect(store.read(taskId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('rejects a v2 batch without a live fence proof and writes nothing', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const events = [v2WorkItemCreated('ev-v2-nofence')];
    await expect(
      store.appendBatch(taskId, 'commit-v2-nofence', events, { expectedLastSequence: 0 }),
    ).rejects.toMatchObject({ code: 'EVENT_INVALID' });
    await expect(readdir(paths.taskEventsRoot(taskId))).rejects.toThrow();
    // There is no fence record at all — even a well-formed proof cannot match.
    const forged = await mintFenceProof(paths);
    await rm(paths.storeFenceRecordFile());
    await expect(
      store.appendBatch(taskId, 'commit-v2-nofence', events, {
        expectedLastSequence: 0,
        fenceProof: forged,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_INVALID' });
  });

  it('maps a record/proof mismatch to the retryable LOCK_SUPERSEDED (taxed takeover, Finding 4)', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const proof = await mintFenceProof(paths);
    await expect(
      store.appendBatch(taskId, 'commit-v2-stale', [v2WorkItemCreated('ev-v2-stale')], {
        expectedLastSequence: 0,
        fenceProof: { ...proof, leaseEpoch: proof.leaseEpoch + 1 },
      }),
    ).rejects.toMatchObject({ code: 'LOCK_SUPERSEDED' });
    await expect(
      store.appendBatch(taskId, 'commit-v2-stale', [v2WorkItemCreated('ev-v2-stale-2')], {
        expectedLastSequence: 0,
        fenceProof: { ...proof, acquisitionNonce: 'other-nonce' },
      }),
    ).rejects.toMatchObject({ code: 'LOCK_SUPERSEDED' });
    await expect(
      store.appendBatch(taskId, 'commit-v2-stale', [v2WorkItemCreated('ev-v2-stale-3')], {
        expectedLastSequence: 0,
        fenceProof: { ...proof, durableGeneration: proof.durableGeneration + 9 },
      }),
    ).rejects.toMatchObject({ code: 'LOCK_SUPERSEDED' });
  });

  it('rejects a v2 event through the legacy single-event append (facade-only path)', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await expect(store.append(taskId, v2WorkItemCreated('ev-v2-single'))).rejects.toMatchObject({
      code: 'EVENT_INVALID',
    });
    await expect(readdir(paths.taskEventsRoot(taskId))).rejects.toThrow();
    // Legacy single-event appends keep working untouched.
    const legacy = await store.append(taskId, started());
    expect(legacy.sequence).toBe(1);
  });

  it('writes the optional publicationPinId audit field only into v2 envelopes', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const fenceProof = await mintFenceProof(paths);
    await store.append(taskId, started());
    const v2Committed = await store.appendBatch(
      taskId,
      'commit-v2-pin',
      [v2WorkItemCreated('ev-v2-pin')],
      { expectedLastSequence: 1, fenceProof, publicationPinId: 'pin-audit-1' },
    );
    // v1 batch: no audit field, byte-compatible envelope shape.
    await store.appendBatch(taskId, 'commit-v1-pin', [result(2)], {
      expectedLastSequence: 2,
    });
    const v2Envelope = JSON.parse(
      await readFile(paths.taskBatchEventFile(taskId, v2Committed[0].fileName), 'utf8'),
    );
    expect(v2Envelope.publicationPinId).toBe('pin-audit-1');
    expect(v2Envelope.canonicalPayloadSha256).toMatch(/^[0-9a-f]{64}$/);
    // readback tolerates both with and without the field.
    const readBack = await store.readBatchByCommitId(taskId, 'commit-v2-pin');
    expect(readBack).toHaveLength(1);
    const replayed = await store.appendBatch(taskId, 'commit-v2-pin', [v2WorkItemCreated('ev-v2-pin')], {
      expectedLastSequence: 2,
      fenceProof,
      publicationPinId: 'pin-other',
    });
    expect(replayed.map((entry) => entry.event)).toEqual(readBack?.map((entry) => entry.event));
  });

  it('reserves the sequence range cross-process: two instances at one tail never overlap', async () => {
    const { paths } = makeTempCorePaths();
    const a = new EventStore(paths);
    const b = new EventStore(paths);
    const taskId = randomUUID();
    const proofA = await mintFenceProof(paths);
    // B re-mints from the same record (two concurrent holders of one fence).
    const proofB = await mintFenceProof(paths);
    const outcomes = await Promise.allSettled([
      a.appendBatch(taskId, 'race-a', [v2WorkItemCreated('ev-race-a')], {
        expectedLastSequence: 0,
        fenceProof: proofA,
      }),
      b.appendBatch(taskId, 'race-b', [v2WorkItemCreated('ev-race-b')], {
        expectedLastSequence: 0,
        fenceProof: proofB,
      }),
    ]);
    const won = outcomes.filter((r) => r.status === 'fulfilled');
    const lost = outcomes.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // Exactly one commit; the loser fails CLOSED on the range reservation, the
    // tail CAS, or a superseded fence — never a silent overlapping double
    // write with both callers told success.
    expect(won).toHaveLength(1);
    if (lost.length === 1) {
      expect(['EXPECTED_SEQUENCE_MISMATCH', 'LOCK_SUPERSEDED']).toContain(
        (lost[0] as PromiseRejectedResult).reason.code,
      );
    }
    const committed = await a.read(taskId);
    expect(committed).toHaveLength(1);
    // No reservation residue is left behind.
    expect((await readdir(paths.taskEventsRoot(taskId))).some((n) => n.includes('.batch-reserved'))).toBe(false);
  });

  it('cleans a stale range reservation whose owner no longer matches the record', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const proof = await mintFenceProof(paths);
    // A crashed committer left a reservation stamped with an OLD era.
    await mkdir(paths.taskEventsRoot(taskId), { recursive: true });
    await writeFile(
      `${paths.taskEventsRoot(taskId)}/000001-000001.batch-reserved`,
      JSON.stringify({ ...proof, leaseEpoch: proof.leaseEpoch - 1, acquisitionNonce: 'stale-reservation' }),
      'utf8',
    );
    const committed = await store.appendBatch(taskId, 'commit-after-stale', [v2WorkItemCreated('ev-after-stale')], {
      expectedLastSequence: 0,
      fenceProof: proof,
    });
    expect(committed).toHaveLength(1);
    expect(
      (await readdir(paths.taskEventsRoot(taskId))).some((n) => n.includes('.batch-reserved')),
    ).toBe(false);
  });

  it('blocks a v2 append whose range is reserved by the CURRENT live record owner', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const proof = await mintFenceProof(paths);
    await mkdir(paths.taskEventsRoot(taskId), { recursive: true });
    await writeFile(
      `${paths.taskEventsRoot(taskId)}/000001-000001.batch-reserved`,
      JSON.stringify(proof),
      'utf8',
    );
    await expect(
      store.appendBatch(taskId, 'commit-blocked', [v2WorkItemCreated('ev-blocked')], {
        expectedLastSequence: 0,
        fenceProof: proof,
      }),
    ).rejects.toMatchObject({ code: 'EXPECTED_SEQUENCE_MISMATCH' });
  });

  it('reports the current tail as sequence plus the last batch commit id', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    expect(await store.tail(taskId)).toEqual({ lastSequence: 0, lastCommitId: null });
    await store.append(taskId, started());
    await store.append(taskId, input());
    expect(await store.tail(taskId)).toEqual({ lastSequence: 2, lastCommitId: null });
    await store.appendBatch(taskId, 'tail-commit', [result(3)], { expectedLastSequence: 2 });
    expect(await store.tail(taskId)).toEqual({ lastSequence: 3, lastCommitId: 'tail-commit' });
  });
});

describe('EventStore.append manifest and readAfter (Task 9, spec §9.4)', () => {
  /** A persistent append manifest is durable beside the events. */
  function manifestPath(paths: CorePaths, taskId: string): string {
    return join(paths.taskEventsRoot(taskId), '.append-manifest.json');
  }

  it('readAfter returns the validated tail strictly after throughSequence', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    for (let index = 1; index <= 4; index += 1) {
      await store.append(taskId, input(index));
    }
    const tail = await store.readAfter(taskId, 2);
    expect(tail.map((entry) => entry.sequence)).toEqual([3, 4]);
    expect(await store.readAfter(taskId, 0)).toHaveLength(4);
    expect(await store.readAfter(taskId, 4)).toHaveLength(0);
    expect(await store.readAfter(taskId, 9)).toHaveLength(0);
  });

  it('readAfter fails loud on a corrupt committed tail file (validated range access)', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());
    const first = await store.append(taskId, input());
    await writeFile(paths.taskEventFile(taskId, first.fileName), 'garbage', 'utf8');
    await expect(store.readAfter(taskId, 1)).rejects.toThrow(/TASK_CORRUPTED|已提交事件/);
  });

  it('writes a durable append manifest and keeps appends correct across rebuilds', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());
    await store.append(taskId, input());
    const manifest = JSON.parse(await readFile(manifestPath(paths, taskId), 'utf8')) as {
      version: number;
      tailSequence: number;
      eventIds: Record<string, number>;
      envelopes: Record<string, string>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.tailSequence).toBe(2);
    expect(Object.keys(manifest.eventIds)).toHaveLength(2);
    expect(Object.keys(manifest.envelopes)).toHaveLength(2);
    // Duplicate ids are detected through the manifest index: re-appending the
    // EXACT same event replays the committed entry without a full rescan.
    const firstEntry = (await store.read(taskId))[0];
    if (firstEntry !== undefined) {
      const replay = await store.append(taskId, firstEntry.event);
      expect(replay.sequence).toBe(firstEntry.sequence);
    }
    // A conflicting event id under a new id still appends a fresh sequence.
    const second = await store.read(taskId);
    expect(second).toHaveLength(2);
  });

  it('rebuilds the manifest from a full scan after corruption', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());
    await store.append(taskId, input());
    await writeFile(manifestPath(paths, taskId), '{ not json', 'utf8');
    const next = await store.append(taskId, result());
    expect(next.sequence).toBe(3);
    const manifest = JSON.parse(await readFile(manifestPath(paths, taskId), 'utf8')) as { tailSequence: number };
    expect(manifest.tailSequence).toBe(3);
    expect(await store.read(taskId)).toHaveLength(3);
  });

  it('detects manifest-vs-disk divergence and recovers with a full-scan rebuild', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());
    // Tamper: the manifest claims a tail the disk does not have.
    const tampered = {
      version: 1,
      taskId,
      tailSequence: 5,
      tailFileName: '999999-never-committed.json',
      envelopes: {},
      eventIds: {},
      commitIds: {},
    };
    await writeFile(manifestPath(paths, taskId), JSON.stringify(tampered), 'utf8');
    const next = await store.append(taskId, input());
    expect(next.sequence).toBe(2);
    // The rebuilt manifest reflects the true disk state.
    const manifest = JSON.parse(await readFile(manifestPath(paths, taskId), 'utf8')) as { tailSequence: number };
    expect(manifest.tailSequence).toBe(2);
    // And the committed history is untouched.
    expect(await store.read(taskId)).toHaveLength(2);
  });

  it('keeps v2 appendBatch CAS semantics with the manifest present (batch-reserved ranges intact)', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.append(taskId, started());
    // v2 batch under a live fence proof exercises the manifest + reservation path.
    const record: StoreFenceRecord = {
      ownerPid: 9999,
      processStartToken: 'token-1',
      processStartTime: null,
      bootId: 'boot-1',
      leaseEpoch: 1,
      acquisitionNonce: 'nonce-1',
      durableGeneration: 0,
      acquiredAt: new Date().toISOString(),
    };
    await writeFile(paths.storeFenceRecordFile(), JSON.stringify(record), 'utf8');
    const proof: StoreFenceProof = {
      ownerPid: 9999,
      processStartToken: 'token-1',
      leaseEpoch: 1,
      acquisitionNonce: 'nonce-1',
      durableGeneration: 0,
    };
    const v2: TaskEvent = {
      protocolVersion: 2,
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'structured_task_suspension_applied_v2',
      suspensionId: 'sus-1',
      reason: 'user_stop',
      operationId: 'op-1',
    };
    const committed = await store.appendBatch(taskId, 'commit-1', [v2], { expectedLastSequence: 1, fenceProof: proof });
    expect(committed[0]?.sequence).toBe(2);
    const manifest = JSON.parse(await readFile(manifestPath(paths, taskId), 'utf8')) as {
      tailSequence: number;
      commitIds: Record<string, string>;
    };
    expect(manifest.tailSequence).toBe(2);
    expect(manifest.commitIds['commit-1']).toBeTruthy();
    // Replay of the same commit id through the manifest remains idempotent.
    const replay = await store.appendBatch(taskId, 'commit-1', [v2], { expectedLastSequence: 1, fenceProof: proof });
    expect(replay[0]?.sequence).toBe(2);
  });
});

describe('EventStore manifest best-effort maintenance (Task 9 fix M7)', () => {
  it('a failing manifest writer never fails the already-committed append', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths, {
      manifestWriter: async () => {
        throw new Error('simulated manifest write failure');
      },
    });
    const taskId = randomUUID();
    // Appends succeed and commit durably even though the (disposable)
    // manifest can never be written.
    const first = await store.append(taskId, started());
    const second = await store.append(taskId, input());
    expect(second.sequence).toBe(first.sequence + 1);
    // The manifest file is never left behind in a half-written state.
    await expect(readFile(join(paths.taskEventsRoot(taskId), '.append-manifest.json'))).rejects.toThrow();
    // Reads rebuild from the full validated scan and stay correct.
    const committed = await store.read(taskId);
    expect(committed).toHaveLength(2);
    expect(await store.tail(taskId)).toEqual({ lastSequence: 2, lastCommitId: null });
    // Follow-up appends keep working (the full-scan path is authoritative).
    const third = await store.append(taskId, result());
    expect(third.sequence).toBe(3);
    expect((await store.read(taskId)).map((e) => e.sequence)).toEqual([1, 2, 3]);
  });
});
