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
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  makeTempCorePaths,
} from '../test-support';
import type { CorePaths } from './core-paths';
import { formatEventFileName } from './core-paths';
import { EventStore } from './event-store';
import type { TaskEvent } from './task-events';

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
      { id, at, type: 'agent_input', node: { ...node, artifactVersion: 0 } },
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
