// @vitest-environment node
/**
 * LiveStore tests (realtime streaming preview, plan C): the memory-only
 * buffer that merges per-Turn live patches into the workspace's
 * `activeTurn`. The store never persists anything — one entry per task,
 * cleared when the Turn ends (success, failure or abort).
 */
import { describe, expect, it } from 'vitest';
import type { LivePatch } from './agent-runtime';
import { LiveStore } from './live-store';

function clockAt(startIso: string) {
  let current = new Date(startIso).getTime();
  return {
    clock: () => new Date(current),
    advance(ms: number): void {
      current += ms;
    },
  };
}

function patch(partial: Partial<LivePatch> = {}): LivePatch {
  return { agentId: 'agent-alpha', turnId: 'turn-1', ...partial };
}

describe('LiveStore', () => {
  it('returns null for tasks without a live turn', () => {
    const store = new LiveStore();
    expect(store.get('task-1')).toBeNull();
  });

  it('merges the first patch into a running live turn', () => {
    const time = clockAt('2026-08-05T00:00:00.000Z');
    const store = new LiveStore({ clock: time.clock });
    store.merge('task-1', patch({ text: 'hello' }));
    expect(store.get('task-1')).toEqual({
      agentId: 'agent-alpha',
      turnId: 'turn-1',
      status: 'running',
      text: 'hello',
      tools: [],
      updatedAt: '2026-08-05T00:00:00.000Z',
    });
  });

  it('keeps earlier fields when later patches omit them and bumps updatedAt', () => {
    const time = clockAt('2026-08-05T00:00:00.000Z');
    const store = new LiveStore({ clock: time.clock });
    store.merge('task-1', patch({ text: 'hello' }));
    time.advance(250);
    store.merge('task-1', patch({ text: 'hello world' }));
    const live = store.get('task-1');
    expect(live?.text).toBe('hello world');
    expect(live?.updatedAt).toBe('2026-08-05T00:00:00.250Z');
  });

  it('tracks tool calls from start to done in event order', () => {
    const store = new LiveStore();
    store.merge('task-1', patch({ toolStarted: 'load_skill' }));
    store.merge('task-1', patch({ toolStarted: 'finish_production' }));
    store.merge('task-1', patch({ toolFinished: 'load_skill' }));
    expect(store.get('task-1')?.tools).toEqual([
      { name: 'load_skill', state: 'done' },
      { name: 'finish_production', state: 'running' },
    ]);
  });

  it('records a tool completion without a matching start as done', () => {
    const store = new LiveStore();
    store.merge('task-1', patch({ toolFinished: 'send_message' }));
    expect(store.get('task-1')?.tools).toEqual([{ name: 'send_message', state: 'done' }]);
  });

  it('drops the live turn when the patch marks the turn finished', () => {
    const store = new LiveStore();
    store.merge('task-1', patch({ text: 'streaming' }));
    expect(store.get('task-1')).not.toBeNull();
    store.merge('task-1', patch({ finished: true }));
    expect(store.get('task-1')).toBeNull();
  });

  it('clear removes the buffer explicitly', () => {
    const store = new LiveStore();
    store.merge('task-1', patch());
    store.merge('task-2', patch({ agentId: 'agent-beta' }));
    store.clear('task-1');
    expect(store.get('task-1')).toBeNull();
    expect(store.get('task-2')?.agentId).toBe('agent-beta');
  });

  it('keeps tasks isolated and returns defensive copies', () => {
    const store = new LiveStore();
    store.merge('task-1', patch({ toolStarted: 'load_skill' }));
    const first = store.get('task-1');
    expect(first).not.toBeNull();
    first?.tools.push({ name: 'injected', state: 'done' });
    expect(store.get('task-1')?.tools).toEqual([{ name: 'load_skill', state: 'running' }]);
  });
});
