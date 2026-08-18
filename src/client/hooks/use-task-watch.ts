import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskWorkspace } from '../../shared/contracts';
import type { PublicCoreError } from '../../shared/errors';
import { useForgeCoreGateway } from '../gateway/gateway-context';
import { toPublicCoreError } from './use-gateway-query';

export interface TaskWatchState {
  status: 'loading' | 'success' | 'error';
  workspace: TaskWorkspace | null;
  error: PublicCoreError | null;
  /** Refetch while keeping the previous workspace visible. */
  reload(): void;
}

interface InternalState {
  status: 'loading' | 'success' | 'error';
  workspace: TaskWorkspace | null;
  error: PublicCoreError | null;
}

/**
 * Live-poll cadence while the task is running (plan C realtime streaming):
 * ~500 ms keeps the turn-card stream preview near-realtime while visible;
 * hidden tabs fall back to the normal 3000 ms. High-frequency polling is the
 * frozen transport — no SSE/WebSocket (spec constraint).
 */
const RUNNING_VISIBLE_POLL_MS = 500;

const RUNNING_HIDDEN_POLL_MS = 3000;

function runningPollIntervalMs(): number {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return RUNNING_HIDDEN_POLL_MS;
  }
  return RUNNING_VISIBLE_POLL_MS;
}

/**
 * Live view of one task workspace: loads once, subscribes through
 * gateway.watchTask and reloads after each notification. Notifications that
 * arrive while a load is pending are coalesced into a single follow-up load,
 * and the subscription is cancelled on task change or unmount. A stale
 * resolution (dependency change / unmount) is discarded via a request token.
 *
 * A watcher that throws synchronously (e.g. the task vanished) must never
 * crash the page: the load error path stays authoritative.
 */
export function useTaskWatch(taskId: string): TaskWatchState {
  const gateway = useForgeCoreGateway();
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;

  const [state, setState] = useState<InternalState>({
    status: 'loading',
    workspace: null,
    error: null,
  });
  const tokenRef = useRef(0);
  const pendingRef = useRef(false);
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);

  const load = useCallback(
    (keepWorkspace: boolean): Promise<boolean> => {
      if (!mountedRef.current) return Promise.resolve(false);
      tokenRef.current += 1;
      const token = tokenRef.current;
      pendingRef.current = true;
      dirtyRef.current = false;
      setState((previous) => ({
        status: 'loading',
        workspace: keepWorkspace ? previous.workspace : null,
        error: null,
      }));
      return gatewayRef.current.getWorkspace(taskId).then(
        (workspace) => {
          if (tokenRef.current !== token) return false;
          pendingRef.current = false;
          setState({ status: 'success', workspace, error: null });
          if (dirtyRef.current) void load(true);
          return true;
        },
        (error: unknown) => {
          if (tokenRef.current !== token) return false;
          pendingRef.current = false;
          setState((previous) => ({
            status: 'error',
            workspace: keepWorkspace ? previous.workspace : null,
            error: toPublicCoreError(error),
          }));
          if (dirtyRef.current) void load(true);
          return false;
        },
      );
    },
    [taskId],
  );

  const loadRef = useRef(load);
  loadRef.current = load;

  const onNotifyRef = useRef<() => void>(() => {});
  onNotifyRef.current = () => {
    if (pendingRef.current) {
      // Merge: one extra reload after the in-flight one settles.
      dirtyRef.current = true;
      return;
    }
    loadRef.current(true);
  };

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void loadRef.current(false).then((loaded) => {
      // Direct navigation must hydrate the gateway before watchTask is
      // allowed to subscribe. The HTTP gateway uses that hydration as its
      // known-task guard, so subscribing in the same effect as the first
      // request races the initial workspace load.
      if (!loaded || disposed || !mountedRef.current) return;
      try {
        unsubscribe = gatewayRef.current.watchTask(taskId, () => onNotifyRef.current());
      } catch (error) {
        // Watching failed; the page still works from the initial load and its
        // public error path. Keep a loud local trace (phase A has no telemetry).
        console.error('[forge-core] watchTask subscription failed', error);
      }
    });
    return () => {
      disposed = true;
      mountedRef.current = false;
      tokenRef.current += 1;
      pendingRef.current = false;
      dirtyRef.current = false;
      if (unsubscribe) unsubscribe();
    };
  }, [taskId, load]);

  // Running-mode live polling (plan C realtime streaming): the live buffer
  // changes without any committed event, so event notifications alone cannot
  // refresh the stream preview. While the task is running, refetch on a
  // short interval (500 ms visible / 3000 ms hidden); re-arm on visibility
  // changes and stop as soon as the task leaves `running`.
  const running = state.workspace !== null && state.workspace.task.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      timer = setTimeout(() => {
        if (mountedRef.current && !pendingRef.current) {
          loadRef.current(true);
        }
        arm();
      }, runningPollIntervalMs());
    };
    arm();
    const onVisibilityChange = (): void => {
      if (timer !== null) clearTimeout(timer);
      arm();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [running, taskId]);

  const reload = useCallback(() => {
    loadRef.current(true);
  }, []);

  return {
    status: state.status,
    workspace: state.workspace,
    error: state.error,
    reload,
  };
}
