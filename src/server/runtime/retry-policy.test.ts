// @vitest-environment node
/**
 * Retry policy tests (plan Phase C Task 5 Step 3, spec §7.1).
 *
 * `classifyRuntimeError` splits Turn failures into transient provider/network
 * problems (connection reset/timeout errnos, `fetch failed`, Provider HTTP
 * 408/429/500/502/503/504) that are eligible for bounded automatic retry and
 * permanent template/Skill/action/permission/format/model-not-found/final-
 * validation problems that never auto-retry. Typed `RuntimeFailure`s keep the
 * adapter's classification; aborts are neither retryable nor failures.
 * `autoRetryDelayMs` grows exponentially (1 s then 2 s) with bounded jitter;
 * tests pin both through injected deterministic inputs.
 *
 * Neutral vocabulary only (iron rule 1).
 */
import { describe, expect, it } from 'vitest';
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';
import { CommitFailure } from './action-committer';
import {
  autoRetryDelayMs,
  classifyRuntimeError,
  MAX_AUTO_RETRIES,
  RETRY_POLICY,
} from './retry-policy';

function errnoError(code: string): Error {
  return Object.assign(new Error('the connection failed'), { code });
}

function httpError(status: number): Error {
  return Object.assign(new Error('the provider answered with an error'), { status });
}

describe('classifyRuntimeError transient classification (spec §7.1)', () => {
  it.each([
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
  ])('classifies connection errno %s as retryable', (code) => {
    expect(classifyRuntimeError(errnoError(code))).toEqual({ retryable: true, code });
  });

  it.each(['fetch failed', 'socket hang up', 'network socket disconnected unexpectedly'])(
    'classifies the "%s" message as retryable',
    (message) => {
      expect(classifyRuntimeError(new TypeError(message))).toEqual({
        retryable: true,
        code: 'TRANSIENT_NETWORK',
      });
    },
  );

  it.each([408, 429, 500, 502, 503, 504])(
    'classifies Provider HTTP status %i as retryable',
    (status) => {
      expect(classifyRuntimeError(httpError(status))).toEqual({
        retryable: true,
        code: `HTTP_${status}`,
      });
    },
  );

  it('reads the status from statusCode-shaped provider errors too', () => {
    const error = Object.assign(new Error('provider error'), { statusCode: 503 });
    expect(classifyRuntimeError(error)).toEqual({ retryable: true, code: 'HTTP_503' });
  });
});

describe('classifyRuntimeError permanent classification (spec §7.1)', () => {
  it.each([400, 401, 403, 404, 409, 422])(
    'classifies Provider HTTP status %i as permanent',
    (status) => {
      expect(classifyRuntimeError(httpError(status))).toEqual({
        retryable: false,
        code: `HTTP_${status}`,
      });
    },
  );

  it.each([
    'TEMPLATE_NOT_FOUND',
    'SKILL_NOT_AUTHORIZED',
    'ROUTE_NOT_ALLOWED',
    'MODEL_NOT_FOUND',
    'INVALID_INPUT',
  ])('classifies platform code %s as permanent', (code) => {
    expect(classifyRuntimeError(errnoError(code))).toEqual({ retryable: false, code });
  });

  it('keeps typed permanent RuntimeFailure non-retryable', () => {
    expect(classifyRuntimeError(RuntimeFailure.permanent('MODEL_NOT_FOUND', 'no such model'))).toEqual({
      retryable: false,
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('keeps typed transient RuntimeFailure retryable', () => {
    expect(
      classifyRuntimeError(RuntimeFailure.transient('PROVIDER_REQUEST_FAILED', 'request failed')),
    ).toEqual({ retryable: true, code: 'PROVIDER_REQUEST_FAILED' });
  });

  it('never retries aborts', () => {
    expect(classifyRuntimeError(new RuntimeAbortedError())).toEqual({
      retryable: false,
      code: 'RUNTIME_ABORTED',
    });
  });

  it('never retries commit validation failures', () => {
    expect(classifyRuntimeError(new CommitFailure('ROUTE_NOT_ALLOWED', 'undeclared route'))).toEqual({
      retryable: false,
      code: 'ROUTE_NOT_ALLOWED',
    });
  });

  it('classifies null, primitives and shapeless values as permanent UNKNOWN', () => {
    expect(classifyRuntimeError(null)).toEqual({ retryable: false, code: 'UNKNOWN' });
    expect(classifyRuntimeError(undefined)).toEqual({ retryable: false, code: 'UNKNOWN' });
    expect(classifyRuntimeError('boom')).toEqual({ retryable: false, code: 'UNKNOWN' });
    expect(classifyRuntimeError(new Error('something else'))).toEqual({
      retryable: false,
      code: 'UNKNOWN',
    });
  });
});

describe('autoRetryDelayMs (plan Task 5 Step 3: deterministic clock, bounded jitter)', () => {
  it('grows exponentially 1 s then 2 s with zero jitter', () => {
    expect(autoRetryDelayMs(1, () => 0)).toBe(1000);
    expect(autoRetryDelayMs(2, () => 0)).toBe(2000);
  });

  it('keeps jitter bounded above the exponential base', () => {
    const first = autoRetryDelayMs(1, () => 0.999999);
    const second = autoRetryDelayMs(2, () => 0.999999);
    expect(first).toBeGreaterThan(1000);
    expect(first).toBeLessThanOrEqual(1000 + RETRY_POLICY.maxJitterMs);
    expect(second).toBeGreaterThan(2000);
    expect(second).toBeLessThanOrEqual(2000 + RETRY_POLICY.maxJitterMs);
  });

  it('allows at most two automatic retries', () => {
    expect(MAX_AUTO_RETRIES).toBe(2);
  });
});
