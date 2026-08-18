import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuthoritativeLocateResultV2,
  AuthoritativeSlotReviewDetailV2,
  AuthoritativeTreePageV2,
  SnapshotCursorV2,
} from '../../../shared/authoritative-review-v2';
import type { ReviewSnapshot } from './structured-review-drawer';

/**
 * Virtual slot tree (design §20 view 2): per-parent lazy-load, fixed
 * snapshot traversal, windowed visible rows (no third-party dependency,
 * pure-React). Expands one parent at a time, fetches children on demand,
 * and never silently re-fetches the current page after new events
 * arrive — newer events surface as a "新事件" prompt the user must
 * accept (spec §15). Locate by slotId is exposed for >1000 trees.
 */

interface VirtualReviewTreeProps {
  map: ReviewSnapshot;
  listTree: (
    parentId: string | null,
    after: SnapshotCursorV2 | null,
  ) => Promise<AuthoritativeTreePageV2>;
  locateSlot: (slotId: string) => Promise<AuthoritativeLocateResultV2 | null>;
  getSlotReview: (slotId: string) => Promise<AuthoritativeSlotReviewDetailV2>;
  /** Slot id requested from outside (findings → locate primary). */
  requestedLocate?: string | null;
  /** Notifies parent that a requested locate has been consumed. */
  onLocateConsumed?: () => void;
}

interface FlatRow {
  slotId: string;
  parentSlotId: string | null;
  typeId: string;
  depth: number;
  contentBearing: boolean;
  childCount: number;
  mapPreReview: string;
  contentState: string;
}

const ROW_HEIGHT_PX = 32;
const VIEWPORT_HEIGHT_PX = 320;

function flatten(
  page: AuthoritativeTreePageV2,
  parentSlotId: string | null,
  depth: number,
  expanded: Set<string>,
): FlatRow[] {
  return page.items.map((item) => ({
    slotId: item.slotId,
    parentSlotId,
    typeId: item.slotType,
    depth,
    contentBearing: item.contentBearing,
    childCount: item.childCount,
    mapPreReview: item.review.mapPreReview,
    contentState: item.review.content,
  }));
}

export function VirtualReviewTree({
  map,
  listTree,
  locateSlot,
  getSlotReview,
  requestedLocate = null,
  onLocateConsumed = () => {},
}: VirtualReviewTreeProps) {
  const rootSlot = map.map.rootSlotId;
  const [rootPage, setRootPage] = useState<AuthoritativeTreePageV2 | null>(null);
  const [childrenPages, setChildrenPages] = useState<Record<string, AuthoritativeTreePageV2>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadedSnapshotCursor] = useState<SnapshotCursorV2 | null>(null);
  const [locateValue, setLocateValue] = useState('');
  const [locateStatus, setLocateStatus] = useState<{ kind: 'idle' | 'located'; slotId: string }>({
    kind: 'idle',
    slotId: '',
  });
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [slotReview, setSlotReview] = useState<AuthoritativeSlotReviewDetailV2 | null>(null);
  const reviewRequestRef = useRef(0);
  const consumedLocateRequestRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  /** Root page loaded once and frozen until user accepts "newer events". */
  useEffect(() => {
    let active = true;
    listTree(rootSlot, loadedSnapshotCursor).then((page) => {
      if (active) setRootPage(page);
    });
    return () => {
      active = false;
    };
  }, [listTree, rootSlot, loadedSnapshotCursor]);

  const toggleExpand = useCallback(
    async (slotId: string) => {
      const next = new Set(expanded);
      if (next.has(slotId)) {
        next.delete(slotId);
        setExpanded(next);
        return;
      }
      next.add(slotId);
      setExpanded(next);
      if (childrenPages[slotId] === undefined) {
        const page = await listTree(slotId, null);
        setChildrenPages((prev) => ({ ...prev, [slotId]: page }));
      }
    },
    [childrenPages, expanded, listTree],
  );

  /** Flatten the visible window in fixed snapshot order (spec §15). */
  const flatRows = useMemo<FlatRow[]>(() => {
    if (rootPage === null) return [];
    const rows: FlatRow[] = [];
    for (const item of rootPage.items) {
      rows.push({
        slotId: item.slotId,
        parentSlotId: null,
        typeId: item.slotType,
        depth: 0,
        contentBearing: item.contentBearing,
        childCount: item.childCount,
        mapPreReview: item.review.mapPreReview,
        contentState: item.review.content,
      });
      if (expanded.has(item.slotId)) {
        const childPage = childrenPages[item.slotId];
        if (childPage !== undefined) {
          rows.push(...flatten(childPage, item.slotId, 1, expanded));
        }
      }
    }
    return rows;
  }, [childrenPages, expanded, rootPage]);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - 4);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX) + 8;
  const visibleRows = flatRows.slice(startIndex, startIndex + visibleCount);
  const topPadding = startIndex * ROW_HEIGHT_PX;
  const bottomPadding = Math.max(0, (flatRows.length - startIndex - visibleCount) * ROW_HEIGHT_PX);

  const selectSlot = useCallback(async (slotId: string) => {
    const requestId = reviewRequestRef.current + 1;
    reviewRequestRef.current = requestId;
    setSelectedSlotId(slotId);
    const review = await getSlotReview(slotId);
    if (reviewRequestRef.current === requestId) {
      setSlotReview(review);
    }
  }, [getSlotReview]);

  const handleLocate = useCallback(async () => {
    if (locateValue.trim() === '') return;
    const result = await locateSlot(locateValue.trim());
    if (result === null) return;
    const next = new Set(expanded);
    for (const ancestor of result.ancestors) {
      if (ancestor.slotId !== result.target.slotId) next.add(ancestor.slotId);
    }
    setExpanded(next);
    setLocateStatus({ kind: 'located', slotId: result.target.slotId });
    await selectSlot(result.target.slotId);
  }, [expanded, locateSlot, locateValue, selectSlot]);

  /** React to a locate request coming from outside the tree (findings → locate primary). */
  useEffect(() => {
    if (requestedLocate === null) {
      consumedLocateRequestRef.current = null;
      return;
    }
    if (consumedLocateRequestRef.current === requestedLocate) return;
    consumedLocateRequestRef.current = requestedLocate;
    let active = true;
    void (async () => {
      const result = await locateSlot(requestedLocate);
      if (!active || result === null) return;
      setExpanded((previous) => {
        const next = new Set(previous);
        for (const ancestor of result.ancestors) {
          if (ancestor.slotId !== result.target.slotId) next.add(ancestor.slotId);
        }
        return next.size === previous.size ? previous : next;
      });
      setLocateStatus({ kind: 'located', slotId: result.target.slotId });
      await selectSlot(result.target.slotId);
      if (active) {
        onLocateConsumed();
      }
    })();
    return () => {
      active = false;
    };
  }, [requestedLocate, locateSlot, onLocateConsumed, selectSlot]);

  return (
    <div className="fc-review-tree" aria-label="槽位树">
      <div className="fc-review-tree__locate">
        <label htmlFor="fc-review-tree-locate" className="fc-review-tree__locate-label">
          定位 slotId
        </label>
        <input
          id="fc-review-tree-locate"
          type="text"
          className="fc-review-tree__locate-input"
          value={locateValue}
          onChange={(event) => setLocateValue(event.target.value)}
          aria-label="定位 slotId"
          placeholder="如 slot-1500"
        />
        <button
          type="button"
          className="fc-button fc-button--secondary"
          onClick={() => void handleLocate()}
        >
          定位
        </button>
      </div>

      {locateStatus.kind === 'located' ? (
        <p className="fc-review-tree__locate-status" role="status" aria-label={`已定位 ${locateStatus.slotId}`}>
          已定位 {locateStatus.slotId}
        </p>
      ) : null}

      <p className="fc-review-tree__snapshot-note" role="note">
        当前遍历：固定 snapshot（throughSequence 锁定）。后台事件已刷新但未替换当前视图。
      </p>

      <div
        className="fc-review-tree__viewport"
        ref={viewportRef}
        onScroll={onScroll}
        role="tree"
        aria-label="槽位树"
      >
        <div style={{ height: topPadding }} aria-hidden="true" />
        <ul className="fc-review-tree__list" role="presentation">
          {visibleRows.map((row) => {
            const expandedHere = expanded.has(row.slotId);
            return (
              <li
                key={row.slotId}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.childCount > 0 ? expandedHere : undefined}
                aria-selected={selectedSlotId === row.slotId}
                tabIndex={0}
                className={`fc-review-tree__row${selectedSlotId === row.slotId ? ' fc-review-tree__row--selected' : ''}`}
                style={{ paddingLeft: `${row.depth * 1.25}rem` }}
                aria-label={`${row.slotId} ${row.typeId} map=${row.mapPreReview} content=${row.contentState}`}
                onClick={() => void selectSlot(row.slotId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void selectSlot(row.slotId);
                  }
                }}
              >
                {row.childCount > 0 ? (
                  <button
                    type="button"
                    className="fc-review-tree__toggle"
                    aria-label={`展开 ${row.slotId}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleExpand(row.slotId);
                    }}
                  >
                    {expandedHere ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="fc-review-tree__leaf" aria-hidden="true">
                    ·
                  </span>
                )}
                <span className="fc-review-tree__slotid">{row.slotId}</span>
                <span className="fc-review-tree__type">{row.typeId}</span>
                <span className="fc-review-tree__map">map: {row.mapPreReview}</span>
                <span className="fc-review-tree__content">content: {row.contentState}</span>
              </li>
            );
          })}
        </ul>
        <div style={{ height: bottomPadding }} aria-hidden="true" />
      </div>

      {slotReview !== null ? (
        <section className="fc-review-tree__detail" aria-label={`槽位 ${slotReview.slotId}`}>
          <h4 className="fc-review-heading">槽位 {slotReview.slotId} 详情</h4>
          <dl className="fc-review-tree__detail-meta">
            <div>
              <dt>槽位类型</dt>
              <dd>{slotReview.slotType}</dd>
            </div>
            <div>
              <dt>父槽位</dt>
              <dd>{slotReview.parentSlotId ?? '—'}</dd>
            </div>
            <div>
              <dt>文档顺序</dt>
              <dd>{slotReview.documentOrder}</dd>
            </div>
            <div>
              <dt>可承载内容</dt>
              <dd>{slotReview.contentBearing ? '是' : '否'}</dd>
            </div>
          </dl>
          <div className="fc-review-tree__detail-review">
            <p className="fc-review-tree__detail-line">
              map pre-review: {slotReview.review.mapPreReview}
            </p>
            <p className="fc-review-tree__detail-line">
              content review: {slotReview.review.content}
            </p>
            <p className="fc-review-tree__detail-line">
              blocking Finding：{slotReview.openBlockingFindingIds.length}
            </p>
            {slotReview.openBlockingFindingIds.length > 0 ? (
              <p className="fc-review-tree__detail-line fc-review-tree__detail-line--muted">
                Finding：{slotReview.openBlockingFindingIds.join('、')}
              </p>
            ) : null}
          </div>
          <section className="fc-review-tree__content-detail" aria-label="内容版本">
            <h5 className="fc-review-heading">内容版本</h5>
            {slotReview.contentDetail === null || slotReview.contentDetail === undefined ? (
              <p className="fc-review-tree__detail-line fc-review-tree__detail-line--muted">
                当前没有可读内容版本。
              </p>
            ) : (
              <>
                <dl className="fc-review-tree__detail-meta">
                  <div>
                    <dt>状态</dt>
                    <dd>{slotReview.contentDetail.state}</dd>
                  </div>
                  <div>
                    <dt>内容修订</dt>
                    <dd>{slotReview.contentDetail.taskContentRevision}</dd>
                  </div>
                  <div>
                    <dt>槽位修订</dt>
                    <dd>{slotReview.contentDetail.slotRevision}</dd>
                  </div>
                  <div>
                    <dt>Manifest</dt>
                    <dd>{slotReview.contentDetail.manifestPhase}</dd>
                  </div>
                </dl>
                {slotReview.contentDetail.contentDigest !== null ? (
                  <p className="fc-review-tree__detail-line fc-review-tree__detail-line--muted">
                    contentDigest: {slotReview.contentDetail.contentDigest.slice(0, 16)}…
                  </p>
                ) : null}
                {slotReview.contentDetail.text !== null ? (
                  <pre className="fc-review-tree__content-preview" data-testid="slot-content-preview">
                    {slotReview.contentDetail.text.split('\n').map((line, index, lines) => (
                      <span key={`${index}-${line}`}>
                        {line}
                        {index < lines.length - 1 ? '\n' : null}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <p className="fc-review-tree__detail-line fc-review-tree__detail-line--muted">
                    当前版本没有可预览文本。
                  </p>
                )}
                {slotReview.contentDetail.truncated ? (
                  <p className="fc-review-tree__detail-line fc-review-tree__detail-line--muted">
                    内容过长，仅展示前 20,000 个字符。
                  </p>
                ) : null}
              </>
            )}
          </section>
        </section>
      ) : null}

      <p className="fc-review-tree__newer-events" role="status" aria-label="新事件">
        新事件：后台有更新；点击"刷新到最新"前视图不会变化。
      </p>
    </div>
  );
}
