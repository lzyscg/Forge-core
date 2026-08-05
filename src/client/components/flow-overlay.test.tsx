import { act, render } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRoute } from '../../shared/contracts';
import { workspaceWithReturnLoop } from '../test-support';
import { FlowOverlay } from './flow-overlay';

type Rect = { left: number; top: number; width: number; height: number };

/**
 * jsdom has no layout: each anchor element gets a controllable fake
 * rectangle. Since the turn-card refactor the canvas anchors are hidden
 * spans, so the stand-ins mirror that element type.
 */
function mountContent(rects: Record<string, Rect>): HTMLDivElement {
  const content = document.createElement('div');
  Object.defineProperty(content, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    configurable: true,
  });
  for (const [id, rect] of Object.entries(rects)) {
    const node = document.createElement('span');
    node.id = id;
    Object.defineProperty(node, 'getBoundingClientRect', {
      value: () => ({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height,
      }),
      configurable: true,
    });
    content.appendChild(node);
  }
  document.body.appendChild(content);
  return content;
}

const ZERO_RECTS: Record<string, Rect> = {
  'node-rl-writer-result-1': { left: 0, top: 0, width: 0, height: 0 },
  'node-rl-reviewer-input-1': { left: 0, top: 0, width: 0, height: 0 },
  'node-rl-reviewer-result-1': { left: 0, top: 0, width: 0, height: 0 },
  'node-rl-writer-input-2': { left: 0, top: 0, width: 0, height: 0 },
  'node-rl-writer-result-2': { left: 0, top: 0, width: 0, height: 0 },
  'node-rl-reviewer-input-2': { left: 0, top: 0, width: 0, height: 0 },
};

const REAL_RECTS: Record<string, Rect> = {
  'node-rl-writer-result-1': { left: 20, top: 100, width: 200, height: 60 },
  'node-rl-reviewer-input-1': { left: 320, top: 180, width: 200, height: 60 },
  'node-rl-reviewer-result-1': { left: 320, top: 280, width: 200, height: 60 },
  'node-rl-writer-input-2': { left: 20, top: 360, width: 200, height: 60 },
  'node-rl-writer-result-2': { left: 20, top: 460, width: 200, height: 60 },
  'node-rl-reviewer-input-2': { left: 320, top: 540, width: 200, height: 60 },
};

class CapturingResizeObserver {
  static instances: CapturingResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    CapturingResizeObserver.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function refOf(element: HTMLElement): RefObject<HTMLElement | null> {
  return { current: element };
}

describe('FlowOverlay', () => {
  beforeEach(() => {
    CapturingResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function renderOverlay(routes: WorkspaceRoute[], measureKey = 'k1', revision = 0) {
    const content = mountContent(ZERO_RECTS);
    return render(
      <FlowOverlay
        routes={routes}
        contentRef={refOf(content)}
        viewportRef={refOf(content)}
        measureKey={measureKey}
        revision={revision}
      />,
    );
  }

  it('draws one aria-hidden path per executed route with message/artifact classes', () => {
    const { container } = renderOverlay(workspaceWithReturnLoop().executedRoutes);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');

    const paths = container.querySelectorAll('path.fc-flow-path');
    expect(paths).toHaveLength(3);
    const kinds = [...paths].map((p) =>
      p.classList.contains('fc-flow-path--artifact')
        ? 'artifact'
        : p.classList.contains('fc-flow-path--message')
          ? 'message'
          : 'unknown',
    );
    expect(kinds).toEqual(['artifact', 'message', 'artifact']);
    // Arrow markers exist for both kinds.
    expect(container.querySelector('#fc-flow-arrow-artifact')).not.toBeNull();
    expect(container.querySelector('#fc-flow-arrow-message')).not.toBeNull();
  });

  it('never draws routes that have not executed', () => {
    const { container } = renderOverlay([]);
    expect(container.querySelectorAll('path.fc-flow-path')).toHaveLength(0);
  });

  it('recomputes geometry when the revision changes (drawer toggles)', () => {
    const routes = workspaceWithReturnLoop().executedRoutes;
    const content = mountContent(ZERO_RECTS);
    const { container, rerender } = render(
      <FlowOverlay
        routes={routes}
        contentRef={refOf(content)}
        viewportRef={refOf(content)}
        measureKey="k1"
        revision={0}
      />,
    );
    const initial = [...container.querySelectorAll('path.fc-flow-path')].map((p) =>
      p.getAttribute('d'),
    );

    // Simulate real layout appearing on the same nodes, then a drawer toggle.
    for (const [id, rect] of Object.entries(REAL_RECTS)) {
      const element = content.querySelector(`#${id}`)!;
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => ({
          left: rect.left,
          top: rect.top,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height,
          width: rect.width,
          height: rect.height,
        }),
        configurable: true,
      });
    }
    rerender(
      <FlowOverlay
        routes={routes}
        contentRef={refOf(content)}
        viewportRef={refOf(content)}
        measureKey="k1"
        revision={1}
      />,
    );
    const updated = [...container.querySelectorAll('path.fc-flow-path')].map((p) =>
      p.getAttribute('d'),
    );
    expect(updated).not.toEqual(initial);
    expect(updated[0]).toContain('220'); // source right edge of the first node
  });

  it('recomputes when ResizeObserver reports node size changes', () => {
    const routes = workspaceWithReturnLoop().executedRoutes.slice(0, 1);
    const content = mountContent(ZERO_RECTS);
    const { container } = render(
      <FlowOverlay
        routes={routes}
        contentRef={refOf(content)}
        viewportRef={refOf(content)}
        measureKey="k1"
        revision={0}
      />,
    );
    expect(CapturingResizeObserver.instances.length).toBeGreaterThan(0);
    const initial = container.querySelector('path.fc-flow-path')!.getAttribute('d');

    // Give the first node a real rectangle, then fire the observer callback.
    const firstNode = content.querySelector('#node-rl-writer-result-1')!;
    Object.defineProperty(firstNode, 'getBoundingClientRect', {
      value: () => ({ left: 20, top: 100, right: 220, bottom: 160, width: 200, height: 60 }),
      configurable: true,
    });
    const observer = CapturingResizeObserver.instances[CapturingResizeObserver.instances.length - 1];
    act(() => {
      observer.callback([], observer as unknown as ResizeObserver);
    });

    const updated = container.querySelector('path.fc-flow-path')!.getAttribute('d');
    expect(updated).not.toBe(initial);
  });

  it('drops paths for routes whose nodes no longer exist', () => {
    const routes = workspaceWithReturnLoop().executedRoutes;
    const content = mountContent(ZERO_RECTS);
    const { container, rerender } = render(
      <FlowOverlay
        routes={routes}
        contentRef={refOf(content)}
        viewportRef={refOf(content)}
        measureKey="k1"
        revision={0}
      />,
    );
    expect(container.querySelectorAll('path.fc-flow-path')).toHaveLength(3);

    rerender(
      <FlowOverlay
        routes={[routes[0]]}
        contentRef={refOf(content)}
        viewportRef={refOf(content)}
        measureKey="k2"
        revision={0}
      />,
    );
    expect(container.querySelectorAll('path.fc-flow-path')).toHaveLength(1);
  });
});
