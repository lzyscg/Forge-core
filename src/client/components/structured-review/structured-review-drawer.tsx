import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AuthoritativeCandidateDetailV2,
  AuthoritativeFindingSummaryV2,
  AuthoritativeLocateResultV2,
  AuthoritativeMapDetailV2,
  AuthoritativeRelationReviewDetailV2,
  AuthoritativeReviewRoundSummaryV2,
  AuthoritativeReviewSummaryV2,
  AuthoritativeSealReadinessDetailV2,
  AuthoritativeSlotReviewDetailV2,
  AuthoritativeTreePageV2,
  BlobRefV2,
  CollectionPageV2,
} from '../../../shared/authoritative-review-v2';
import type { PublicCoreError } from '../../../shared/errors';
import type { TaskWorkspace } from '../../../shared/contracts';
import { useForgeCoreGateway } from '../../gateway/gateway-context';
import { toPublicCoreError } from '../../hooks/use-gateway-query';
import { ReviewOverview } from './review-overview';
import { VirtualReviewTree } from './virtual-review-tree';
import { RelationshipView } from './relationship-view';
import { ReviewRoundsView } from './review-rounds-view';
import { FindingsView } from './findings-view';
import { SealReadinessView } from './seal-readiness-view';

export interface StructuredReviewDrawerProps {
  workspace: TaskWorkspace;
  /** Closes the overlay panel (mirrors the artifact drawer). */
  onClose: () => void;
}

/** Closed set of v2 tab ids (spec §15 / design §20). */
export type ReviewTabId = 'overview' | 'tree' | 'relations' | 'rounds' | 'findings' | 'seal';

interface TabDescriptor {
  id: ReviewTabId;
  label: string;
  /** Friendly description for screen-reader section announce. */
  aria: string;
}

const TABS: readonly TabDescriptor[] = [
  { id: 'overview', label: '总览', aria: '审核总览' },
  { id: 'tree', label: '槽位树', aria: '槽位树视图' },
  { id: 'relations', label: '关系网', aria: '关系网视图' },
  { id: 'rounds', label: '审核', aria: '审核轮次视图' },
  { id: 'findings', label: 'Findings', aria: 'Findings 视图' },
  { id: 'seal', label: 'Seal', aria: 'Seal readiness 视图' },
];

/** Snapshot-bound cross-section data shared by all six views (spec §15). */
export interface ReviewSnapshot {
  map: AuthoritativeMapDetailV2;
  candidate: AuthoritativeCandidateDetailV2 | null;
  mapRounds: CollectionPageV2<AuthoritativeReviewRoundSummaryV2>;
  contentRounds: CollectionPageV2<AuthoritativeReviewRoundSummaryV2>;
  summary: AuthoritativeReviewSummaryV2;
  findings: CollectionPageV2<AuthoritativeFindingSummaryV2>;
  seal: AuthoritativeSealReadinessDetailV2;
}

/** Display alias of a content-addressed ref (matches artifact-drawer style). */
export function refLabel(ref: BlobRefV2 | null): string {
  if (ref === null) return '—';
  return `${ref.kind}@${ref.digest.slice(0, 12)}…`;
}

/**
 * Read-only authoritative per-slot review drawer (spec §15, design §20).
 * Provides six tabs (overview, slot tree, relationship, review rounds,
 * findings, seal readiness) and NEVER calls a mutation gateway method —
 * there are no human-UI controls that edit verdicts, close Findings, grant
 * permissions, activate Maps or force Seal (spec §3.2/§15).
 */
export function StructuredReviewDrawer({
  workspace,
  onClose,
}: StructuredReviewDrawerProps) {
  const gateway = useForgeCoreGateway();
  const taskId = workspace.task.id;

  const [activeTab, setActiveTab] = useState<ReviewTabId>('overview');
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [loadError, setLoadError] = useState<PublicCoreError | null>(null);
  const [requestedLocate, setRequestedLocate] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setLoadError(null);

    Promise.all([
      gateway.getAuthoritativeMap(taskId),
      gateway.getAuthoritativeCandidate(taskId).catch(() => null),
      gateway.listAuthoritativeMapRounds(taskId, 50, null),
      gateway.listAuthoritativeRounds(taskId, 50, null),
      gateway.getAuthoritativeReviewSummary(taskId),
      gateway.listAuthoritativeFindings(taskId, 50, null),
      gateway.getAuthoritativeSealReadiness(taskId),
    ])
      .then(([map, candidate, mapRounds, contentRounds, summary, findings, seal]) => {
        if (!active) return;
        setSnapshot({ map, candidate, mapRounds, contentRounds, summary, findings, seal });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(toPublicCoreError(error));
      });

    return () => {
      active = false;
    };
  }, [gateway, taskId]);

  /**
   * Locates a slot by id — used by the tree view (jump) and the findings
   * view (locate the primary target). Always returns a structured result;
   * never throws to the caller.
   */
  const locateSlot = useCallback(
    async (slotId: string): Promise<AuthoritativeLocateResultV2 | null> => {
      try {
        return await gateway.locateAuthoritativeSlot(taskId, slotId);
      } catch (error) {
        setLoadError(toPublicCoreError(error));
        return null;
      }
    },
    [gateway, taskId],
  );

  /** Lazy-loaded children page for one parent in the tree view. */
  const listTree = useCallback(
    async (parentId: string | null, after: import('../../../shared/authoritative-review-v2').SnapshotCursorV2 | null) =>
      gateway.listAuthoritativeTree(taskId, parentId, 100, after),
    [gateway, taskId],
  );

  const getSlotReview = useCallback(
    async (slotId: string) => gateway.getAuthoritativeSlotReview(taskId, slotId),
    [gateway, taskId],
  );

  const getRelationReview = useCallback(
    async (relationId: string) => gateway.getAuthoritativeRelationReview(taskId, relationId),
    [gateway, taskId],
  );

  /** Stable tab list — memoized so tab keys don't re-render every cycle. */
  const tabs = useMemo(() => TABS, []);

  return (
    <aside className="fc-drawer fc-drawer--review" role="complementary" aria-label="结构">
      <div className="fc-drawer__header">
        <h2 className="fc-drawer__title">结构 · 审核 (v2)</h2>
        <button
          type="button"
          className="fc-drawer__close"
          aria-label="关闭审核抽屉"
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <div role="tablist" aria-label="结构抽屉视图" className="fc-review-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`fc-review-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`fc-review-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={
              activeTab === tab.id
                ? 'fc-review-tabs__tab fc-review-tabs__tab--active'
                : 'fc-review-tabs__tab'
            }
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loadError !== null ? (
        <p className="fc-review-error" role="alert">
          {loadError.message}
        </p>
      ) : null}

      {snapshot === null && loadError === null ? (
        <p className="fc-loading-note" role="status">
          正在加载审核…
        </p>
      ) : null}

      {snapshot !== null ? (
        <>
          <section
            role="tabpanel"
            id="fc-review-panel-overview"
            aria-labelledby="fc-review-tab-overview"
            hidden={activeTab !== 'overview'}
          >
            <ReviewOverview snapshot={snapshot} />
          </section>

          <section
            role="tabpanel"
            id="fc-review-panel-tree"
            aria-labelledby="fc-review-tab-tree"
            hidden={activeTab !== 'tree'}
          >
            <VirtualReviewTree
              map={snapshot}
              listTree={listTree}
              locateSlot={locateSlot}
              getSlotReview={getSlotReview}
              requestedLocate={requestedLocate}
              onLocateConsumed={() => setRequestedLocate(null)}
            />
          </section>

          <section
            role="tabpanel"
            id="fc-review-panel-relations"
            aria-labelledby="fc-review-tab-relations"
            hidden={activeTab !== 'relations'}
          >
            <RelationshipView map={snapshot.map} getRelationReview={getRelationReview} />
          </section>

          <section
            role="tabpanel"
            id="fc-review-panel-rounds"
            aria-labelledby="fc-review-tab-rounds"
            hidden={activeTab !== 'rounds'}
          >
            <ReviewRoundsView
              mapRounds={snapshot.mapRounds}
              contentRounds={snapshot.contentRounds}
              summary={snapshot.summary}
            />
          </section>

          <section
            role="tabpanel"
            id="fc-review-panel-findings"
            aria-labelledby="fc-review-tab-findings"
            hidden={activeTab !== 'findings'}
          >
            <FindingsView
              findings={snapshot.findings}
              onLocatePrimary={(primary) => {
                if (primary.kind === 'slot') {
                  setRequestedLocate(primary.id);
                  setActiveTab('tree');
                }
              }}
            />
          </section>

          <section
            role="tabpanel"
            id="fc-review-panel-seal"
            aria-labelledby="fc-review-tab-seal"
            hidden={activeTab !== 'seal'}
          >
            <SealReadinessView seal={snapshot.seal} />
          </section>
        </>
      ) : null}
    </aside>
  );
}

// Tree page type re-export for inline callers.
export type { AuthoritativeTreePageV2 };