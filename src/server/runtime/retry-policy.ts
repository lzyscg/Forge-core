/**
 * Runtime error retry policy (plan Phase C Task 5 Step 3, spec §7.1).
 *
 * `classifyRuntimeError` splits one Turn failure into the two classes the
 * scheduler acts on:
 * - TRANSIENT — connection reset/timeout errnos, `fetch failed`-style socket
 *   losses and Provider HTTP statuses 408/429/500/502/503/504: eligible for
 *   bounded automatic retry;
 * - PERMANENT — template, Skill, action, permission, format,
 *   model-not-found and final-validation problems (plus any unrecognized
 *   shape): never automatically retried; the failure parks the node for a
 *   manual decision.
 * Typed `RuntimeFailure`s keep the adapter's own classification (the Pi
 * adapter decides transient/permanent where it wraps the provider); aborts
 * are neither class. Messages stay presentable — classification never leaks
 * raw causes (iron rule 6). No business vocabulary lives here (iron rule 1).
 *
 * Automatic retries happen at most `MAX_AUTO_RETRIES` times with exponential
 * delays (1 s then 2 s) plus bounded jitter; tests inject a deterministic
 * `random` source.
 */
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';

/** Policy constants shared by the scheduler and the delay calculator. */
export const RETRY_POLICY = {
  /** At most two automatic retries after the first attempt (spec §7.1). */
  maxAutoRetries: 2,
  /** Exponential base delay: retry 1 waits 1 s, retry 2 waits 2 s. */
  baseDelayMs: 1000,
  /** Jitter upper bound (exclusive) added on top of the base delay. */
  maxJitterMs: 250,
} as const;

/** Automatic retries allowed for one input node before manual action. */
export const MAX_AUTO_RETRIES: number = RETRY_POLICY.maxAutoRetries;

/** Classification the scheduler and runner consume. */
export interface RetryClassification {
  retryable: boolean;
  code: string;
}

/** Connection-level errnos treated as transient (reset/timeout family). */
const TRANSIENT_ERRNOS: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Provider HTTP statuses eligible for automatic retry (spec §7.1). */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** Public message patterns that identify a lost connection/socket. */
const TRANSIENT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /fetch failed/i,
  /socket hang up/i,
  /network socket disconnected/i,
  /connection reset/i,
  /timed ?out/i,
];

/** Code reported for message-pattern matches without a structured code. */
const TRANSIENT_NETWORK_CODE = 'TRANSIENT_NETWORK';

const UNKNOWN_CODE = 'UNKNOWN';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The structured error code when the failure carries a string `code`. */
function errorCodeOf(error: unknown): string | null {
  if (isRecord(error) && typeof error.code === 'string' && error.code.length > 0) {
    return error.code;
  }
  return null;
}

/** A numeric HTTP status from `status`/`statusCode` shapes, if present. */
function httpStatusOf(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  for (const candidate of [error.status, error.statusCode]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100) {
      return candidate;
    }
  }
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : '';
}

/**
 * Classifies one Turn failure for the retry policy. Typed `RuntimeFailure`s
 * keep the adapter's classification; aborts never retry; everything else is
 * classified by errno, HTTP status or connection-loss message patterns.
 */
export function classifyRuntimeError(error: unknown): RetryClassification {
  if (error instanceof RuntimeAbortedError) {
    return { retryable: false, code: error.code };
  }
  if (error instanceof RuntimeFailure) {
    return { retryable: error.retryable, code: error.code };
  }
  const errno = errorCodeOf(error);
  if (errno !== null && TRANSIENT_ERRNOS.has(errno)) {
    return { retryable: true, code: errno };
  }
  const status = httpStatusOf(error);
  if (status !== null) {
    return { retryable: RETRYABLE_HTTP_STATUSES.has(status), code: `HTTP_${status}` };
  }
  const message = messageOf(error);
  if (TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return { retryable: true, code: TRANSIENT_NETWORK_CODE };
  }
  return { retryable: false, code: errno ?? UNKNOWN_CODE };
}

/**
 * The delay before automatic retry number `retryNumber` (1-indexed): an
 * exponential 1 s → 2 s base plus bounded jitter from the injected `random`
 * source (production `Math.random`; tests pin it deterministically).
 */
export function autoRetryDelayMs(retryNumber: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, Math.floor(retryNumber));
  const base = RETRY_POLICY.baseDelayMs * 2 ** (safeAttempt - 1);
  const sample = random();
  const bounded = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return base + Math.floor(bounded * RETRY_POLICY.maxJitterMs);
}
