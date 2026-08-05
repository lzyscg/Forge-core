// @vitest-environment node
/**
 * Acceptance boundary hook protocol (plan Phase D Task 4 Step 2).
 *
 * The hook is the process-harness seam the recovery runner uses to stop a
 * server strictly after a confirmed artifact/message boundary and before the
 * next Agent is scheduled. It is exercised here WITHOUT any server: a
 * programmed counts reader drives boundary detection, and the signal
 * directory carries the boundary record plus the release file.
 *
 * Contract pinned by these tests:
 * - a committed Turn that increased the artifact count or the message-route
 *   count writes `boundary.json` (atomic, counts + task identity) and waits;
 * - a release file containing `once` resumes exactly one boundary and is
 *   consumed; `all` disables every future pause for the hook's lifetime;
 * - an aborted signal ends the wait and the hook reports `true` (stop the
 *   loop) instead of continuing;
 * - Turns that changed no boundary count never pause.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAcceptanceBoundaryHook,
  type BoundaryCounts,
} from './acceptance-boundary';

const createdRoots: string[] = [];

function freshSignalDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-boundary-signal-'));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function countsReader(states: BoundaryCounts[]): (taskId: string) => Promise<BoundaryCounts> {
  let index = 0;
  return async () => {
    const current = states[Math.min(index, states.length - 1)];
    index += 1;
    return current;
  };
}

async function waitForBoundaryFile(signalDir: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(join(signalDir, 'boundary.json'))) {
    if (Date.now() > deadline) {
      throw new Error('boundary.json did not appear in time');
    }
    await new Promise((wait) => setTimeout(wait, 2));
  }
}

describe('acceptance boundary hook protocol', () => {
  it('pauses at a confirmed boundary, writes boundary.json and resumes on release once', async () => {
    const signalDir = freshSignalDir();
    const hook = createAcceptanceBoundaryHook({
      signalDir,
      readCounts: countsReader([
        { artifacts: 1, messageRoutes: 0 },
        { artifacts: 1, messageRoutes: 1 },
      ]),
      pollIntervalMs: 2,
    });
    const controller = new AbortController();

    // First committed boundary turn: artifacts 0 -> 1 pauses the loop.
    const pending = Promise.resolve(hook('task-1', controller.signal));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await waitForBoundaryFile(signalDir);
    await new Promise((wait) => setTimeout(wait, 10));
    expect(settled).toBe(false);

    const boundary = JSON.parse(readFileSync(join(signalDir, 'boundary.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(boundary.taskId).toBe('task-1');
    expect(boundary.artifacts).toBe(1);
    expect(boundary.messageRoutes).toBe(0);

    writeFileSync(join(signalDir, 'release'), 'once', 'utf8');
    await expect(pending).resolves.toBe(false);
    // `once` is consumed: the file never survives the release.
    expect(existsSync(join(signalDir, 'release'))).toBe(false);

    // Next boundary (a committed message route) pauses again.
    const second = Promise.resolve(hook('task-1', controller.signal));
    await waitForBoundaryFile(signalDir);
    writeFileSync(join(signalDir, 'release'), 'once', 'utf8');
    await expect(second).resolves.toBe(false);
  });

  it('release-all disables every future pause for the hook lifetime', async () => {
    const signalDir = freshSignalDir();
    mkdirSync(signalDir, { recursive: true });
    writeFileSync(join(signalDir, 'release'), 'all', 'utf8');
    const hook = createAcceptanceBoundaryHook({
      signalDir,
      readCounts: countsReader([{ artifacts: 1, messageRoutes: 0 }]),
      pollIntervalMs: 2,
    });
    const controller = new AbortController();

    // A pre-existing `all` release means the run must never pause.
    await expect(hook('task-1', controller.signal)).resolves.toBe(false);
    expect(existsSync(join(signalDir, 'boundary.json'))).toBe(false);
    // The disable is sticky: later boundary turns also run through.
    await expect(hook('task-1', controller.signal)).resolves.toBe(false);
    expect(existsSync(join(signalDir, 'boundary.json'))).toBe(false);
  });

  it('returns true (stop the loop) when aborted while paused', async () => {
    const signalDir = freshSignalDir();
    const hook = createAcceptanceBoundaryHook({
      signalDir,
      readCounts: countsReader([{ artifacts: 1, messageRoutes: 0 }]),
      pollIntervalMs: 2,
    });
    const controller = new AbortController();
    const pending = hook('task-1', controller.signal);
    await waitForBoundaryFile(signalDir);
    controller.abort();
    await expect(pending).resolves.toBe(true);
    // No release was ever written.
    expect(existsSync(join(signalDir, 'release'))).toBe(false);
  });

  it('never pauses when the committed Turn changed no boundary count', async () => {
    const signalDir = freshSignalDir();
    const hook = createAcceptanceBoundaryHook({
      signalDir,
      // Same counts twice: the second call observes no boundary increase.
      readCounts: countsReader([
        { artifacts: 1, messageRoutes: 0 },
        { artifacts: 1, messageRoutes: 0 },
      ]),
      pollIntervalMs: 2,
    });
    const controller = new AbortController();
    // First call pauses (0 -> 1 artifact) until released...
    const first = hook('task-1', controller.signal);
    await waitForBoundaryFile(signalDir);
    writeFileSync(join(signalDir, 'release'), 'once', 'utf8');
    await expect(first).resolves.toBe(false);
    // ...the unchanged-count call returns immediately without a boundary file.
    rmSync(join(signalDir, 'boundary.json'));
    await expect(hook('task-1', controller.signal)).resolves.toBe(false);
    expect(existsSync(join(signalDir, 'boundary.json'))).toBe(false);
  });
});
