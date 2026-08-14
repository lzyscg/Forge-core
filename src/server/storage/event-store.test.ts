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

/** Committed (non-temporary) event filenames as they exist on disk, sorted. */
async function committedFileNames(paths: CorePaths, taskId: string): Promise<string[]> {
  return (await readdir(paths.taskEventsRoot(taskId)))
    .filter((name) => !name.startsWith('.tmp-'))
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
      (name) => !name.startsWith('.tmp-'),
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

  it('commits a v2 member and mixed legacy/v2 batches as one atomic envelope', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const first = await store.append(taskId, started());
    const v2Batch = [v2WorkItemCreated(randomUUID()), v2AttemptStarted(randomUUID())];
    const mixed = v2Batch.concat(result());

    const committed = await store.appendBatch(taskId, 'commit-v2-a', mixed, {
      expectedLastSequence: 1,
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
    const badV2: Record<string, unknown> = JSON.parse(JSON.stringify(v2WorkItemCreated(randomUUID())));
    delete badV2.authorityBaseRef;
    await expect(
      store.appendBatch(taskId, 'commit-v2-bad', [started(), badV2 as unknown as TaskEvent], {
        expectedLastSequence: 0,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_INVALID' });
    await expect(readdir(paths.taskEventsRoot(taskId))).rejects.toThrow();
  });

  it('replays an identical v2 commit and rejects a conflicting one', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    const events = [v2WorkItemCreated('ev-v2-1')];

    const firstResult = await store.appendBatch(taskId, 'commit-v2-replay', events, {
      expectedLastSequence: 0,
    });
    const replay = await store.appendBatch(taskId, 'commit-v2-replay', events, {
      expectedLastSequence: 0,
    });
    expect(replay).toEqual(firstResult);

    await expect(
      store.appendBatch(taskId, 'commit-v2-replay', [v2AttemptStarted('ev-v2-1')], {
        expectedLastSequence: 0,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('fails loud as corruption when a v2 committed member no longer validates', async () => {
    const { paths } = makeTempCorePaths();
    const store = new EventStore(paths);
    const taskId = randomUUID();
    await store.appendBatch(taskId, 'commit-v2-c', [v2WorkItemCreated('ev-v2-c')], {
      expectedLastSequence: 0,
    });
    // Corrupt the committed bytes: drop the required payloadRef key while
    // keeping valid JSON, then read — the union validator fails loud.
    const names = (await readdir(paths.taskEventsRoot(taskId))).filter(
      (name) => !name.startsWith('.tmp-'),
    );
    const envelopePath = paths.taskBatchEventFile(taskId, names[0]);
    const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
    delete envelope.events[0].payloadRef;
    await writeFile(envelopePath, JSON.stringify(envelope), 'utf8');
    await expect(store.read(taskId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });
});
