import type { ReviewSnapshot } from './structured-review-drawer';
import { refLabel } from './structured-review-drawer';

/**
 * Review overview (design §20 view 1): current candidate / active Map,
 * Map ReviewRound, content ReviewRound, coverage counts, blocking
 * finding count, system-derived generation and Seal readiness.
 *
 * Pure presentation: never calls a mutation gateway method and never
 * links to a fake node for a system-produced artifact.
 */
export function ReviewOverview({ snapshot }: { snapshot: ReviewSnapshot }) {
  const { map, candidate, mapRounds, contentRounds, summary, seal } = snapshot;

  const currentMapRound = mapRounds.items.at(0) ?? null;
  const currentContentRound = contentRounds.items.at(0) ?? null;

  return (
    <div className="fc-review-overview">
      <section aria-label="当前 Map" className="fc-review-overview__block">
        <h3 className="fc-review-heading">当前 Map</h3>
        <dl className="fc-review-overview__rows">
          <div className="fc-review-overview__row">
            <dt>Map id</dt>
            <dd>{map.mapId}</dd>
          </div>
          <div className="fc-review-overview__row">
            <dt>修订</dt>
            <dd>r{map.mapRevision}</dd>
          </div>
          <div className="fc-review-overview__row">
            <dt>节点数</dt>
            <dd>{map.nodeCount}</dd>
          </div>
          <div className="fc-review-overview__row">
            <dt>关系数</dt>
            <dd>{map.relationCount}</dd>
          </div>
          <div className="fc-review-overview__row">
            <dt>mapSemanticDigest</dt>
            <dd>{map.mapSemanticDigest.slice(0, 12)}…</dd>
          </div>
          <div className="fc-review-overview__row">
            <dt>MapSnapshotRef</dt>
            <dd>{refLabel(map.mapSnapshotRef)}</dd>
          </div>
        </dl>
      </section>

      {candidate !== null && candidate.candidateId !== null ? (
        <section aria-label="当前候选" className="fc-review-overview__block">
          <h3 className="fc-review-heading">当前候选</h3>
          <p className="fc-review-overview__line">{candidate.candidateId}</p>
        </section>
      ) : null}

      <section aria-label="当前轮次" className="fc-review-overview__block">
        <h3 className="fc-review-heading">当前轮次</h3>
        <p className="fc-review-overview__line">
          Map 预审轮次：
          {currentMapRound !== null ? currentMapRound.reviewRoundId : '—'}
        </p>
        <p className="fc-review-overview__line">
          内容审核轮次：
          {currentContentRound !== null ? currentContentRound.reviewRoundId : '—'}
        </p>
      </section>

      <section aria-label="审核覆盖" className="fc-review-overview__block">
        <h3 className="fc-review-heading">审核覆盖（系统派生）</h3>
        <ul className="fc-review-overview__coverage">
          <li>pending {summary.pendingCount}</li>
          <li>pass 18: pass {summary.passCount}</li>
          <li>reject {summary.rejectCount}</li>
          <li>stale {summary.staleCount}</li>
        </ul>
        <p className="fc-review-overview__line">
          blocking Finding：{summary.openBlockingFindingCount}
        </p>
      </section>

      <section aria-label="Seal readiness" className="fc-review-overview__block">
        <h3 className="fc-review-heading">Seal readiness（系统派生）</h3>
        <p className="fc-review-overview__line">readiness：{seal.readiness}</p>
        <p className="fc-review-overview__line">
          未满足条件数: {seal.unmetConditionCount}
        </p>
        <p className="fc-review-overview__line">
          {seal.sealed ? '已封存' : '未封存'}
        </p>
      </section>
    </div>
  );
}