import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import { toPublicCoreError, useGatewayQuery } from './use-gateway-query';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useGatewayQuery', () => {
  it('reports loading then success with the loaded data', async () => {
    const { result } = renderHook(() => useGatewayQuery(async () => 'payload', []));
    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe('payload');
    expect(result.current.error).toBeNull();
  });

  it('discards stale responses after dependencies change', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const loads = [first.promise, second.promise];
    let call = 0;
    const { result, rerender } = renderHook(
      ({ dep }) =>
        useGatewayQuery(() => {
          call += 1;
          return loads[call - 1] ?? second.promise;
        }, [dep]),
      { initialProps: { dep: 1 } },
    );

    expect(call).toBe(1);
    rerender({ dep: 2 });
    await waitFor(() => expect(call).toBe(2));

    // The first request resolves late; its value must be ignored.
    await act(async () => {
      first.resolve('stale');
    });
    expect(result.current.data).not.toBe('stale');
    expect(result.current.status).toBe('loading');

    await act(async () => {
      second.resolve('fresh');
    });
    await waitFor(() => expect(result.current.data).toBe('fresh'));
    expect(result.current.status).toBe('success');
  });

  it('maps unknown rejections to a presentable PublicCoreError', async () => {
    const { result } = renderHook(() =>
      useGatewayQuery<string>(() => Promise.reject(new Error('boom')), []),
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toEqual({
      code: 'UNKNOWN_ERROR',
      message: 'boom',
      location: null,
      action: '刷新页面后重试。',
    });
  });

  it('maps non-error rejections to a generic public message', async () => {
    const { result } = renderHook(() =>
      useGatewayQuery<string>(() => Promise.reject('raw-string-failure'), []),
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe('UNKNOWN_ERROR');
    expect(result.current.error?.message).toBe('发生未知错误。');
  });

  it('keeps CoreError fields intact when the gateway raises one', async () => {
    const core = new CoreError(
      CORE_ERROR_CODES.TEMPLATE_NOT_FOUND,
      '未找到模板 nope。',
      'MockGateway.getTemplate',
      '返回模板列表重新加载。',
    );
    const { result } = renderHook(() =>
      useGatewayQuery<string>(() => Promise.reject(core), []),
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
      message: '未找到模板 nope。',
      location: 'MockGateway.getTemplate',
      action: '返回模板列表重新加载。',
    });
  });

  it('reload refetches, keeps previous data and surfaces new errors', async () => {
    let count = 0;
    const { result } = renderHook(() =>
      useGatewayQuery(async () => {
        count += 1;
        if (count === 1) return 'v1';
        throw new CoreError(
          CORE_ERROR_CODES.TEMPLATE_NOT_FOUND,
          '模板源目录不可用。',
          'MockGateway.reloadTemplate',
          '恢复模板源目录后重试。',
        );
      }, []),
    );
    await waitFor(() => expect(result.current.data).toBe('v1'));

    act(() => {
      result.current.reload();
    });
    // Previous data stays visible while the reload is in flight.
    expect(result.current.data).toBe('v1');
    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(count).toBe(2);
    expect(result.current.data).toBe('v1');
    expect(result.current.error?.message).toBe('模板源目录不可用。');
  });

  it('reload can refresh data on success', async () => {
    let count = 0;
    const { result } = renderHook(() =>
      useGatewayQuery(async () => {
        count += 1;
        return `v${count}`;
      }, []),
    );
    await waitFor(() => expect(result.current.data).toBe('v1'));
    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.data).toBe('v2'));
    expect(result.current.error).toBeNull();
  });
});

describe('toPublicCoreError', () => {
  it('passes through values already shaped as PublicCoreError', () => {
    const error = { code: 'X', message: 'm', location: null, action: null };
    expect(toPublicCoreError(error)).toBe(error);
  });

  it('never leaks stack or internal detail from unknown errors', () => {
    const mapped = toPublicCoreError(new TypeError('internal cause'));
    expect(mapped.code).toBe('UNKNOWN_ERROR');
    expect(mapped.message).toBe('internal cause');
    expect(mapped.location).toBeNull();
    expect(JSON.stringify(mapped)).not.toContain('stack');
  });
});
