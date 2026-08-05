/**
 * Acceptance boundary hook (plan Phase D Task 4 Step 2).
 *
 * Process-harness seam ONLY — never part of the production HTTP API or the
 * UI. The recovery acceptance runner wires it into the scheduler through the
 * environment-only switch `FORGE_CORE_ACCEPTANCE_SIGNAL_DIR` (read by
 * `main.ts`); without that switch the production loop never sees it.
 *
 * Behavior: after every committed Turn the scheduler consults the hook. When
 * the Turn increased the task's confirmed artifact count or message-route
 * count, the hook has reached a CONFIRMED BOUNDARY: it writes one atomic
 * `boundary.json` record into the signal directory and waits — strictly
 * before the next Agent is scheduled — until the runner writes a `release`
 * file or the run's abort signal fires:
 *
 * - `release` content `once` resumes exactly one boundary and is consumed;
 * - `release` content `all` disables every future pause for this process;
 * - an aborted signal ends the wait and the hook returns `true`, so the
 *   scheduler loop stops at the confirmed boundary (graceful shutdown then
 *   owns the interruption marking).
 *
 * Turns that changed no boundary count return immediately and write nothing.
 * No business vocabulary lives here (iron rule 1).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The boundary-relevant confirmed counts one workspace projection carries. */
export interface BoundaryCounts {
  artifacts: number;
  messageRoutes: number;
}

/** One boundary record the hook publishes for the runner (sanitized facts). */
export interface BoundaryRecord {
  taskId: string;
  index: number;
  artifacts: number;
  messageRoutes: number;
  at: string;
}

export interface AcceptanceBoundaryHookOptions {
  /** Directory shared with the runner: boundary.json in, release file out. */
  signalDir: string;
  /** Reads the current confirmed counts for the task (workspace projection). */
  readCounts: (taskId: string) => Promise<BoundaryCounts>;
  /** Release/boundary poll cadence; defaults to 200 ms. */
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

/** The scheduler seam signature: true stops the loop at a confirmed rest point. */
export type AcceptanceStopHook = (
  taskId: string,
  signal: AbortSignal,
) => boolean | Promise<boolean>;

const BOUNDARY_FILE_NAME = 'boundary.json';
const RELEASE_FILE_NAME = 'release';
const DEFAULT_POLL_INTERVAL_MS = 200;

/** Release modes the runner may write into the signal directory. */
export const BOUNDARY_RELEASE_ONCE = 'once';
export const BOUNDARY_RELEASE_ALL = 'all';

/**
 * Graceful-shutdown coordination file (plan 2026-08-04): the runner writes
 * it into the signal directory instead of relying on POSIX signals, which
 * never reach detached child-process handlers on Windows. `main.ts` polls
 * for it (acceptance mode only) and runs the normal clean shutdown path.
 */
export const BOUNDARY_SHUTDOWN_FILE_NAME = 'shutdown';

/**
 * Builds the scheduler seam over one signal directory. State (last confirmed
 * counts, boundary index, release-all latch) lives in the returned closure —
 * one hook instance per server process, exactly like the acceptance run.
 */
export function createAcceptanceBoundaryHook(
  options: AcceptanceBoundaryHookOptions,
): AcceptanceStopHook {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = options.log ?? (() => undefined);
  mkdirSync(options.signalDir, { recursive: true });

  let lastCounts: BoundaryCounts | null = null;
  let boundaryIndex = 0;
  let disabled = false;

  function readReleaseMode(): string | null {
    try {
      return readFileSync(join(options.signalDir, RELEASE_FILE_NAME), 'utf8').trim();
    } catch {
      return null;
    }
  }

  async function waitAtBoundary(record: BoundaryRecord, signal: AbortSignal): Promise<boolean> {
    // A coordination signal, not a committed record: overwrite the previous
    // boundary through a temp file + atomic rename so the runner never reads
    // a partial write.
    const destination = join(options.signalDir, BOUNDARY_FILE_NAME);
    const staging = `${destination}.tmp-${record.index}`;
    writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    renameSync(staging, destination);
    log(`acceptance-boundary: paused at boundary ${record.index} (task ${record.taskId})`);
    for (;;) {
      if (signal.aborted) {
        return true; // Graceful shutdown wins: stop the loop at the boundary.
      }
      const mode = readReleaseMode();
      if (mode !== null) {
        if (mode === BOUNDARY_RELEASE_ALL) {
          disabled = true;
          log('acceptance-boundary: released for the rest of this process');
          return false;
        }
        // `once` (or any other content) releases exactly this boundary.
        rmSync(join(options.signalDir, RELEASE_FILE_NAME), { force: true });
        log(`acceptance-boundary: released boundary ${record.index}`);
        return false;
      }
      await new Promise((wait) => setTimeout(wait, pollIntervalMs));
    }
  }

  return async (taskId: string, signal: AbortSignal): Promise<boolean> => {
    if (disabled) {
      return false;
    }
    // A pre-existing `all` release means this process must never pause.
    const preRelease = readReleaseMode();
    if (preRelease === BOUNDARY_RELEASE_ALL) {
      disabled = true;
      return false;
    }
    if (preRelease !== null) {
      // A pre-existing `once` release skips exactly the next boundary.
      rmSync(join(options.signalDir, RELEASE_FILE_NAME), { force: true });
      lastCounts = await options.readCounts(taskId);
      return false;
    }
    const counts = await options.readCounts(taskId);
    // A null baseline (the first committed Turn) compares against zero, so a
    // Turn that already carries confirmed artifacts/routes is a boundary.
    const previous = lastCounts ?? { artifacts: 0, messageRoutes: 0 };
    const boundary =
      counts.artifacts > previous.artifacts || counts.messageRoutes > previous.messageRoutes;
    lastCounts = counts;
    if (!boundary) {
      return false;
    }
    boundaryIndex += 1;
    const record: BoundaryRecord = {
      taskId,
      index: boundaryIndex,
      artifacts: counts.artifacts,
      messageRoutes: counts.messageRoutes,
      at: new Date().toISOString(),
    };
    return waitAtBoundary(record, signal);
  };
}
