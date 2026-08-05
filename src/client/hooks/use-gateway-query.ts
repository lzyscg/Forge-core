import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicCoreError } from '../../shared/errors';

/**
 * Presentability guard for page-facing errors: only values that already carry
 * the full public contract (code / message / location / action) pass through;
 * everything else is replaced by a generic public error so stacks, causes and
 * storage internals never reach page state (iron rule 6).
 */
export function toPublicCoreError(error: unknown): PublicCoreError {
  if (isPublicCoreError(error)) return error;
  const message =
    error instanceof Error && error.message.length > 0 ? error.message : '发生未知错误。';
  return {
    code: 'UNKNOWN_ERROR',
    message,
    location: null,
    action: '刷新页面后重试。',
  };
}

function isPublicCoreError(error: unknown): error is PublicCoreError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    (candidate.location === null || typeof candidate.location === 'string') &&
    (candidate.action === null || typeof candidate.action === 'string')
  );
}

export interface QueryState<T> {
  status: 'loading' | 'success' | 'error';
  data: T | null;
  error: PublicCoreError | null;
  reload(): void;
}

interface InternalState<T> {
  status: 'loading' | 'success' | 'error';
  data: T | null;
  error: PublicCoreError | null;
}

/**
 * Loads data through the Gateway with no hidden global state: every call site
 * owns its request, an incrementing token discards stale resolutions after a
 * dependency change or unmount, unknown errors are mapped to PublicCoreError,
 * and nothing is cached across pages.
 *
 * `reload()` refetches while keeping the previous data visible, so detail
 * pages can show an inline pending state and survive reload failures;
 * dependency changes start a fresh load and clear previous data.
 */
export function useGatewayQuery<T>(
  load: () => Promise<T>,
  dependencies: readonly unknown[],
): QueryState<T> {
  const [state, setState] = useState<InternalState<T>>({
    status: 'loading',
    data: null,
    error: null,
  });
  const tokenRef = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const execute = useCallback((keepData: boolean) => {
    tokenRef.current += 1;
    const token = tokenRef.current;
    setState((previous) => ({
      status: 'loading',
      data: keepData ? previous.data : null,
      error: null,
    }));
    loadRef.current().then(
      (data) => {
        if (tokenRef.current !== token) return;
        setState({ status: 'success', data, error: null });
      },
      (error: unknown) => {
        if (tokenRef.current !== token) return;
        setState((previous) => ({
          status: 'error',
          data: keepData ? previous.data : null,
          error: toPublicCoreError(error),
        }));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    execute(false);
    return () => {
      // Invalidate any in-flight request on dependency change or unmount.
      tokenRef.current += 1;
    };
    // Dependencies are a caller-controlled array by design (plan signature).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execute, ...dependencies]);

  const reload = useCallback(() => {
    execute(true);
  }, [execute]);

  return { status: state.status, data: state.data, error: state.error, reload };
}
