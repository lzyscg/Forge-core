/**
 * Process-local accelerator for the durable v2 wakeup index.
 *
 * The wakeup index remains the authority. This driver only decides when to
 * invoke a deterministic scheduling tick while the service is alive; a
 * restart still converges from the same durable rows through startup
 * recovery. It deliberately does not keep a separate in-memory queue.
 */
import type { V2SchedulingTickResult } from './attempt-coordinator';
import type { AuthoritativeWakeupIndexV1, WakeupRowV2 } from './wakeup-index';

const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface V2SchedulingDriverOptions {
  wakeups: Pick<AuthoritativeWakeupIndexV1, 'all'>;
  tick(now?: string): Promise<V2SchedulingTickResult>;
  clock(): string;
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

function actionableRows(rows: readonly WakeupRowV2[]): WakeupRowV2[] {
  return rows.filter((row) => !row.dormant && !row.eligibilityBlocked);
}

function delayUntilNextWakeup(rows: readonly WakeupRowV2[], now: string, pollIntervalMs: number): number | null {
  const actionable = actionableRows(rows);
  if (actionable.length === 0) return null;

  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return pollIntervalMs;

  let earliestAtMs: number | null = null;
  for (const row of actionable) {
    if (row.at === null) return pollIntervalMs;
    const atMs = Date.parse(row.at);
    if (!Number.isFinite(atMs)) return pollIntervalMs;
    earliestAtMs = earliestAtMs === null ? atMs : Math.min(earliestAtMs, atMs);
  }
  if (earliestAtMs === null) return pollIntervalMs;
  const until = earliestAtMs - nowMs;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(pollIntervalMs, until));
}

/**
 * Drives due durable wakeups without overlapping scheduling ticks.
 *
 * `start()` always performs one immediate scan (needed after startup
 * recovery). Once a tick settles, the next timer is derived from the durable
 * rows: blocked/dormant rows do not create a busy loop, future retry timers
 * sleep until due, and due/runnable rows are polled at a bounded cadence.
 */
export class V2SchedulingDriver {
  private readonly wakeups: Pick<AuthoritativeWakeupIndexV1, 'all'>;

  private readonly tick: (now?: string) => Promise<V2SchedulingTickResult>;

  private readonly clock: () => string;

  private readonly pollIntervalMs: number;

  private readonly log: (line: string) => void;

  private started = false;

  private timer: ReturnType<typeof setTimeout> | null = null;

  private inFlight: Promise<void> | null = null;

  constructor(options: V2SchedulingDriverOptions) {
    this.wakeups = options.wakeups;
    this.tick = options.tick;
    this.clock = options.clock;
    this.pollIntervalMs = Math.max(1, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.log = options.log ?? (() => undefined);
  }

  /** Starts the driver idempotently and schedules the startup scan. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0, true);
  }

  /**
   * Requests a prompt scan after an external lifecycle mutation. If a tick is
   * already running, its completion will derive the next scan from disk.
   */
  poke(): void {
    if (!this.started || this.inFlight !== null) return;
    this.schedule(0, true);
  }

  /**
   * Runs a lifecycle-triggered tick through the same in-flight gate as the
   * timer. A start/resume/retry request can arrive while the startup scan is
   * executing; waiting for that scan before running the request's tick keeps
   * the scheduler single-writer and ensures the newly durable wakeup is seen.
   */
  async runNow(now?: string): Promise<V2SchedulingTickResult> {
    if (!this.started) return this.tick(now);

    while (this.inFlight !== null) {
      const current = this.inFlight;
      await current;
    }
    if (!this.started) return this.tick(now);

    this.clearTimer();
    try {
      return await this.executeTick(now ?? this.clock());
    } finally {
      if (this.started) await this.scheduleFromWakeups();
    }
  }

  /** Stops future scans and returns a promise for the current tick, if any. */
  stop(): Promise<void> {
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.inFlight ?? Promise.resolve();
  }

  private schedule(delayMs: number, replace: boolean): void {
    if (!this.started) return;
    if (this.timer !== null) {
      if (!replace) return;
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce();
    }, Math.max(0, Math.min(MAX_TIMER_DELAY_MS, delayMs)));
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async runOnce(): Promise<void> {
    if (!this.started || this.inFlight !== null) return;

    try {
      await this.executeTick(this.clock());
    } catch (error: unknown) {
      // The durable wakeup remains in place on an unexpected driver error;
      // keep the process alive and try again on the bounded polling cadence.
      this.log(`authoritative-v2-scheduler: tick failed (${error instanceof Error ? error.name : 'unknown'})`);
    }

    if (!this.started) return;
    await this.scheduleFromWakeups();
  }

  private async executeTick(now: string): Promise<V2SchedulingTickResult> {
    const operation = Promise.resolve().then(() => this.tick(now));
    const settled = operation.then(() => undefined, () => undefined);
    this.inFlight = settled;
    try {
      return await operation;
    } finally {
      if (this.inFlight === settled) this.inFlight = null;
    }
  }

  private async scheduleFromWakeups(): Promise<void> {
    let rows: WakeupRowV2[];
    try {
      rows = await this.wakeups.all();
    } catch (error: unknown) {
      this.log(`authoritative-v2-scheduler: wakeup scan failed (${error instanceof Error ? error.name : 'unknown'})`);
      this.schedule(this.pollIntervalMs, false);
      return;
    }
    const delay = delayUntilNextWakeup(rows, this.clock(), this.pollIntervalMs);
    if (delay !== null) this.schedule(delay, false);
  }
}

export { delayUntilNextWakeup };
