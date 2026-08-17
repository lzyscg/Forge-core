import type {
  AuthoritativeReviewRoundSummaryV2,
  AuthoritativeReviewSummaryV2,
  CollectionPageV2,
} from '../../../shared/authoritative-review-v2';

/**
 * Review rounds view (design §20 view 4): Map pre-review, content review
 * and layered whole-tree observation rows. Each row exposes the round id,
 * state and the inheritance source of its facts (whole-tree observations
 * are never adopted into a new round — design §7.4/§11.5).
 */
interface ReviewRoundsViewProps {
  mapRounds: CollectionPageV2<AuthoritativeReviewRoundSummaryV2>;
  contentRounds: CollectionPageV2<AuthoritativeReviewRoundSummaryV2>;
  summary: AuthoritativeReviewSummaryV2;
}

export function ReviewRoundsView({
  mapRounds,
  contentRounds,
  summary,
}: ReviewRoundsViewProps) {
  return (
    <div className="fc-review-rounds" aria-label="审核">
      <section aria-label="Map 预审轮次" className="fc-review-rounds__block">
        <h3 className="fc-review-heading">Map 预审</h3>
        {mapRounds.items.length === 0 ? (
          <p className="fc-review-rounds__empty">无 Map 预审轮次。</p>
        ) : (
          <ul className="fc-review-rounds__list">
            {mapRounds.items.map((round) => (
              <li key={round.reviewRoundId} className="fc-review-rounds__item">
                <span className="fc-review-rounds__id">{round.reviewRoundId}</span>
                <span className="fc-review-rounds__state">state: {round.state}</span>
                <span className="fc-review-rounds__layer">整体观察：分层整图（map_whole）</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="内容审核轮次" className="fc-review-rounds__block">
        <h3 className="fc-review-heading">内容审核</h3>
        {contentRounds.items.length === 0 ? (
          <p className="fc-review-rounds__empty">无内容审核轮次。</p>
        ) : (
          <ul className="fc-review-rounds__list">
            {contentRounds.items.map((round) => (
              <li key={round.reviewRoundId} className="fc-review-rounds__item">
                <span className="fc-review-rounds__id">{round.reviewRoundId}</span>
                <span className="fc-review-rounds__state">state: {round.state}</span>
                <span className="fc-review-rounds__layer">整体观察：分层整树（tree_whole）</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="覆盖与失效" className="fc-review-rounds__block">
        <h3 className="fc-review-heading">覆盖与失效</h3>
        <p className="fc-review-rounds__line">mapCycleOrdinal: {summary.mapCycleOrdinal}</p>
        <p className="fc-review-rounds__line">contentCycleOrdinal: {summary.contentCycleOrdinal}</p>
        <p className="fc-review-rounds__line">stale: {summary.staleCount}</p>
      </section>
    </div>
  );
}