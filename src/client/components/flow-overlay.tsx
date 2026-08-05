import { useEffect, useState, type RefObject } from 'react';
import type { WorkspaceRoute } from '../../shared/contracts';

export interface FlowOverlayProps {
  /** Executed routes only; declared-but-unexecuted edges are never passed. */
  routes: WorkspaceRoute[];
  /** Scroll content that hosts the lanes; paths use its coordinate space. */
  contentRef: RefObject<HTMLElement | null>;
  /** Scroll viewport; scrolling triggers a recompute. */
  viewportRef: RefObject<HTMLElement | null>;
  /** Changes whenever the node set/geometry may have changed. */
  measureKey: string;
  /** Bumped by drawer toggles / dialog changes so paths re-fit the layout. */
  revision: number;
}

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FlowPath {
  id: string;
  kind: WorkspaceRoute['kind'];
  d: string;
}

interface Geometry {
  paths: FlowPath[];
  width: number;
  height: number;
}

const EMPTY_GEOMETRY: Geometry = { paths: [], width: 0, height: 0 };

function relativeRect(element: Element, origin: DOMRect): RectLike {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  };
}

/** Smooth cubic connector; direction follows the relative lane positions. */
function buildPath(source: RectLike, target: RectLike): string {
  const sourceCenterX = source.left + source.width / 2;
  const targetCenterX = target.left + target.width / 2;
  const forward = targetCenterX >= sourceCenterX;
  const sx = forward ? source.left + source.width : source.left;
  const tx = forward ? target.left : target.left + target.width;
  const sy = source.top + source.height / 2;
  const ty = target.top + target.height / 2;
  const mx = (sx + tx) / 2;
  return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
}

function measureGeometry(routes: WorkspaceRoute[], content: HTMLElement | null): Geometry {
  if (!content) return EMPTY_GEOMETRY;
  const origin = content.getBoundingClientRect();
  const paths: FlowPath[] = [];
  for (const route of routes) {
    const from = document.getElementById(`node-${route.fromNodeId}`);
    const to = document.getElementById(`node-${route.toNodeId}`);
    // Routes whose nodes vanished (workspace reload) simply drop out.
    if (!from || !to) continue;
    paths.push({
      id: route.id,
      kind: route.kind,
      d: buildPath(relativeRect(from, origin), relativeRect(to, origin)),
    });
  }
  return { paths, width: content.scrollWidth, height: content.scrollHeight };
}

/**
 * SVG layer visualizing executed routes. Decorative by contract: route
 * semantics stay readable in node details, so the SVG is aria-hidden and the
 * text alternative lives outside it. Capability-probes ResizeObserver so
 * environments without it degrade to change-driven recomputation.
 */
export function FlowOverlay({
  routes,
  contentRef,
  viewportRef,
  measureKey,
  revision,
}: FlowOverlayProps) {
  const [geometry, setGeometry] = useState<Geometry>(EMPTY_GEOMETRY);

  useEffect(() => {
    const measure = (): void => {
      setGeometry(measureGeometry(routes, contentRef.current));
    };
    measure();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => measure());
      if (contentRef.current) observer.observe(contentRef.current);
      for (const route of routes) {
        for (const nodeId of [route.fromNodeId, route.toNodeId]) {
          const element = document.getElementById(`node-${nodeId}`);
          if (element) observer.observe(element);
        }
      }
    }

    const viewport = viewportRef.current;
    viewport?.addEventListener('scroll', measure, { passive: true });
    return () => {
      if (observer) observer.disconnect();
      viewport?.removeEventListener('scroll', measure);
    };
  }, [routes, measureKey, revision, contentRef, viewportRef]);

  return (
    <>
      <svg
        className="fc-flow-overlay"
        aria-hidden="true"
        focusable="false"
        width={geometry.width}
        height={geometry.height}
      >
        <defs>
          <marker
            id="fc-flow-arrow-artifact"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="fc-flow-arrow fc-flow-arrow--artifact" />
          </marker>
          <marker
            id="fc-flow-arrow-message"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="fc-flow-arrow fc-flow-arrow--message" />
          </marker>
        </defs>
        {geometry.paths.map((path) => (
          <path
            key={path.id}
            className={`fc-flow-path fc-flow-path--${path.kind}`}
            d={path.d}
            fill="none"
            markerEnd={`url(#fc-flow-arrow-${path.kind})`}
          />
        ))}
      </svg>
      <p className="fc-sr-only">
        连线仅展示实际发生的路由；每条路由的含义可在节点详情中查看。
      </p>
    </>
  );
}
