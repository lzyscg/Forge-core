import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskWorkspace } from '../../shared/contracts';
import type { DevelopmentGateway } from '../gateway/development-gateway';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import type { ForgeCoreGateway } from '../gateway/forge-core-gateway';
import { GatewayProvider } from '../gateway/gateway-context';
import { stubGateway, workspaceWithReturnLoop } from '../test-support';
import { useTaskWatch } from './use-task-watch';

function workspaceNamed(id: string): TaskWorkspace {
  const base = workspaceWithReturnLoop();
  return { ...base, task: { ...base.task, id } };
}

function watchWrapper(gateway: ForgeCoreGateway & DevelopmentGateway) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <GatewayProvider core={gateway} development={gateway}>
        {children}
      </GatewayProvider>
    );
  };
}

describe('useTaskWatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the workspace once and subscribes for the current task', async () => {
    const ws = workspaceNamed('task-a');
    const unsubscribe = vi.fn();
    const watchTask = vi.fn((_taskId: string, _listener: () => void) => unsubscribe);
    const getWorkspace = vi.fn(async () => ws);
    const gateway = stubGateway({ getWorkspace, watchTask });

    const { result } = renderHook(() => useTaskWatch('task-a'), {
      wrapper: watchWrapper(gateway),
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.workspace?.task.id).toBe('task-a');
    expect(getWorkspace).toHaveBeenCalledTimes(1);
    expect(watchTask).toHaveBeenCalledTimes(1);
    expect(watchTask.mock.calls[0]?.[0]).toBe('task-a');
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('waits for the initial workspace load before subscribing on direct navigation', async () => {
    const ws = workspaceNamed('task-direct');
    let loaded = false;
    const unsubscribe = vi.fn();
    const getWorkspace = vi.fn(async () => {
      await Promise.resolve();
      loaded = true;
      return ws;
    });
    const watchTask = vi.fn(() => {
      if (!loaded) {
        throw new CoreError(
          CORE_ERROR_CODES.TASK_NOT_FOUND,
          '未找到任务 task-direct。',
          'MockGateway.watchTask',
          '返回任务列表刷新后重试。',
        );
      }
      return unsubscribe;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gateway = stubGateway({ getWorkspace, watchTask });

    const { result } = renderHook(() => useTaskWatch('task-direct'), {
      wrapper: watchWrapper(gateway),
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(watchTask).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('reloads after each watch notification', async () => {
    const ws1 = workspaceNamed('task-a');
    const ws2: TaskWorkspace = {
      ...ws1,
      nodes: ws1.nodes.slice(0, 4),
    };
    let listener: (() => void) | null = null;
    const watchTask = vi.fn((_taskId: string, fn: () => void) => {
      listener = fn;
      return () => {};
    });
    const getWorkspace = vi.fn().mockResolvedValueOnce(ws1).mockResolvedValueOnce(ws2);
    const gateway = stubGateway({ getWorkspace, watchTask });

    const { result } = renderHook(() => useTaskWatch('task-a'), {
      wrapper: watchWrapper(gateway),
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.workspace?.nodes).toHaveLength(8);

    act(() => {
      listener?.();
    });
    await waitFor(() => expect(result.current.workspace?.nodes).toHaveLength(4));
    expect(getWorkspace).toHaveBeenCalledTimes(2);
  });

  it('coalesces notifications that arrive while a load is pending', async () => {
    const ws1 = workspaceNamed('task-a');
    const ws2: TaskWorkspace = { ...ws1, nodes: ws1.nodes.slice(0, 5) };
    let listener: (() => void) | null = null;
    const watchTask = vi.fn((_taskId: string, fn: () => void) => {
      listener = fn;
      return () => {};
    });
    let resolvePending: (ws: TaskWorkspace) => void = () => {};
    const pending = new Promise<TaskWorkspace>((resolve) => {
      resolvePending = resolve;
    });
    const getWorkspace = vi
      .fn()
      .mockResolvedValueOnce(ws1)
      .mockReturnValueOnce(pending)
      .mockResolvedValue(ws2);
    const gateway = stubGateway({ getWorkspace, watchTask });

    const { result } = renderHook(() => useTaskWatch('task-a'), {
      wrapper: watchWrapper(gateway),
    });
    await waitFor(() => expect(result.current.status).toBe('success'));

    // First notification (idle) starts a reload; two more arrive while it is
    // pending and must merge into exactly one follow-up load.
    act(() => {
      listener?.();
    });
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));
    act(() => {
      listener?.();
      listener?.();
    });
    expect(getWorkspace).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvePending(ws2);
    });
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.workspace?.nodes).toHaveLength(5));
    // No extra loads beyond the coalesced one.
    expect(getWorkspace).toHaveBeenCalledTimes(3);
  });

  it('unsubscribes on unmount and ignores later notifications', async () => {
    const ws = workspaceNamed('task-a');
    let listener: (() => void) | null = null;
    const unsubscribe = vi.fn();
    const watchTask = vi.fn((_taskId: string, fn: () => void) => {
      listener = fn;
      return unsubscribe;
    });
    const getWorkspace = vi.fn(async () => ws);
    const gateway = stubGateway({ getWorkspace, watchTask });

    const { unmount } = renderHook(() => useTaskWatch('task-a'), {
      wrapper: watchWrapper(gateway),
    });
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(1));

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    act(() => {
      listener?.();
    });
    expect(getWorkspace).toHaveBeenCalledTimes(1);
  });

  it('switching task cancels the old subscription and clears stale workspace', async () => {
    const wsA = workspaceNamed('task-a');
    const wsB = workspaceNamed('task-b');
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    const watchTask = vi
      .fn()
      .mockImplementationOnce(() => unsubscribeA)
      .mockImplementationOnce(() => unsubscribeB);
    const getWorkspace = vi
      .fn()
      .mockImplementationOnce(async () => wsA)
      .mockImplementationOnce(async () => wsB);
    const gateway = stubGateway({ getWorkspace, watchTask });

    const { result, rerender } = renderHook(({ id }: { id: string }) => useTaskWatch(id), {
      wrapper: watchWrapper(gateway),
      initialProps: { id: 'task-a' },
    });
    await waitFor(() => expect(result.current.workspace?.task.id).toBe('task-a'));

    rerender({ id: 'task-b' });
    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    expect(result.current.workspace).toBeNull();
    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.workspace?.task.id).toBe('task-b'));
    expect(watchTask.mock.calls[1]?.[0]).toBe('task-b');
    expect(unsubscribeB).not.toHaveBeenCalled();
  });

  it('maps gateway rejections to PublicCoreError and supports manual reload', async () => {
    const ws = workspaceNamed('task-a');
    const watchTask = vi.fn(() => () => {});
    const getWorkspace = vi
      .fn()
      .mockRejectedValueOnce(
        new CoreError(
          CORE_ERROR_CODES.TASK_NOT_FOUND,
          '未找到任务 task-a。',
          'MockGateway.getWorkspace',
          '返回任务列表刷新后重试。',
        ),
      )
      .mockResolvedValueOnce(ws);
    const gateway = stubGateway({ getWorkspace, watchTask });

    const { result } = renderHook(() => useTaskWatch('task-a'), {
      wrapper: watchWrapper(gateway),
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe('TASK_NOT_FOUND');
    expect(result.current.error?.message).toBe('未找到任务 task-a。');

    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.workspace?.task.id).toBe('task-a');
  });

  it('keeps the previous workspace visible while a manual reload is pending', async () => {
    const ws1 = workspaceNamed('task-a');
    const ws2: TaskWorkspace = { ...ws1, nodes: ws1.nodes.slice(0, 2) };
    const watchTask = vi.fn(() => () => {});
    const getWorkspace = vi.fn().mockResolvedValueOnce(ws1).mockResolvedValueOnce(ws2);
    const gateway = stubGateway({ getWorkspace, watchTask });

    const { result } = renderHook(() => useTaskWatch('task-a'), {
      wrapper: watchWrapper(gateway),
    });
    await waitFor(() => expect(result.current.status).toBe('success'));

    act(() => {
      result.current.reload();
    });
    expect(result.current.status).toBe('loading');
    expect(result.current.workspace?.nodes).toHaveLength(8);

    await waitFor(() => expect(result.current.workspace?.nodes).toHaveLength(2));
  });

  it('survives a gateway whose watcher throws synchronously', async () => {
    const ws = workspaceNamed('task-a');
    const watchTask = vi.fn((): (() => void) => {
      throw new CoreError(
        CORE_ERROR_CODES.TASK_NOT_FOUND,
        '未找到任务 task-a。',
        'MockGateway.watchTask',
        '返回任务列表刷新后重试。',
      );
    });
    const getWorkspace = vi.fn(async () => ws);
    const gateway = stubGateway({ getWorkspace, watchTask });

    const { result } = renderHook(() => useTaskWatch('task-a'), {
      wrapper: watchWrapper(gateway),
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.workspace?.task.id).toBe('task-a');
  });
});

describe('useTaskWatch running-mode live polling (plan C realtime streaming)', () => {
  function runningWorkspace(): TaskWorkspace {
    const base = workspaceNamed('task-live');
    return { ...base, task: { ...base.task, status: 'running', currentAgentName: '写作' } };
  }

  function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('polls every ~500ms while the task is running and visible', async () => {
    const ws = runningWorkspace();
    const getWorkspace = vi.fn(async () => ws);
    const gateway = stubGateway({ getWorkspace });

    renderHook(() => useTaskWatch('task-live'), { wrapper: watchWrapper(gateway) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(3);
  });

  it('keeps the hidden cadence at 3000ms while running', async () => {
    setVisibility('hidden');
    const ws = runningWorkspace();
    const getWorkspace = vi.fn(async () => ws);
    const gateway = stubGateway({ getWorkspace });

    renderHook(() => useTaskWatch('task-live'), { wrapper: watchWrapper(gateway) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(2);
  });

  it('re-arms to the hidden cadence when the page becomes hidden mid-run', async () => {
    const ws = runningWorkspace();
    const getWorkspace = vi.fn(async () => ws);
    const gateway = stubGateway({ getWorkspace });

    renderHook(() => useTaskWatch('task-live'), { wrapper: watchWrapper(gateway) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // The 500ms visible timer was cleared; nothing fired yet.
    expect(getWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(2);
  });

  it('stops polling once the task is no longer running', async () => {
    const running = runningWorkspace();
    const completed: TaskWorkspace = { ...running, task: { ...running.task, status: 'completed' } };
    const getWorkspace = vi
      .fn()
      .mockResolvedValueOnce(running)
      .mockResolvedValue(completed);
    const gateway = stubGateway({ getWorkspace });

    renderHook(() => useTaskWatch('task-live'), { wrapper: watchWrapper(gateway) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(1);

    // One poll observes the completed status...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(2);
    // ...and no further polling happens afterwards.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(2);
  });

  it('never polls for tasks that are not running', async () => {
    const ws = workspaceNamed('task-idle');
    const getWorkspace = vi.fn(async () => ws);
    const gateway = stubGateway({ getWorkspace });

    renderHook(() => useTaskWatch('task-idle'), { wrapper: watchWrapper(gateway) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getWorkspace).toHaveBeenCalledTimes(1);
  });
});
