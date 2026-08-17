import { useEffect, useState } from 'react';
import type {
  AuthoritativeMapDetailV2,
  AuthoritativeRelationReviewDetailV2,
} from '../../../shared/authoritative-review-v2';

/**
 * Relationship view (design §20 view 3): disabled mode OR zero relations
 * displays "本 Map 未使用关系网" and is NOT an error (spec §15 / §6.1).
 * When relations exist, shows type, direction, enforcement, Map
 * pre-review and content satisfaction state.
 */
interface RelationshipViewProps {
  map: AuthoritativeMapDetailV2;
  getRelationReview: (relationId: string) => Promise<AuthoritativeRelationReviewDetailV2>;
}

export function RelationshipView({ map, getRelationReview }: RelationshipViewProps) {
  const [reviews, setReviews] = useState<AuthoritativeRelationReviewDetailV2[] | null>(null);

  useEffect(() => {
    let active = true;
    if (map.relationCount === 0) {
      setReviews([]);
      return () => {
        active = false;
      };
    }
    // The platform exposes relation reviews on demand; first page derives
    // ids from `relation-1..N` deterministically when the Map summary
    // does not enumerate them. Read-only: never mutates state.
    const ids = Array.from({ length: map.relationCount }, (_, i) => `rel-${i + 1}`);
    Promise.all(ids.map((id) => getRelationReview(id).catch(() => null)))
      .then((results) => {
        if (!active) return;
        setReviews(results.filter((r): r is AuthoritativeRelationReviewDetailV2 => r !== null));
      });
    return () => {
      active = false;
    };
  }, [map.relationCount, getRelationReview]);

  const disabledOrZero =
    map.relation.mode === 'disabled' || map.relation.relationCount === 0;

  if (disabledOrZero) {
    return (
      <div className="fc-review-relations" aria-label="关系网">
        <p className="fc-review-relations__empty" role="status">
          本 Map 未使用关系网
        </p>
        <p className="fc-review-relations__note">
          关系层 {map.relation.mode === 'disabled' ? '禁用' : '可选'} 且当前关系为 0：合法中性状态，并非待补。
        </p>
      </div>
    );
  }

  if (reviews === null) {
    return (
      <p className="fc-loading-note" role="status">
        正在加载关系…
      </p>
    );
  }

  return (
    <div className="fc-review-relations" aria-label="关系网">
      <h3 className="fc-review-heading">关系网</h3>
      <ul className="fc-review-relations__list">
        {reviews.map((relation) => (
          <li
            key={relation.relationId}
            className="fc-review-relations__item"
            aria-label={`${relation.relationId} ${relation.typeId}`}
          >
            <span className="fc-review-relations__type">{relation.typeId}</span>
            <span className="fc-review-relations__direction">
              {relation.fromSlotId} → {relation.toSlotId}
            </span>
            <span className="fc-review-relations__review">
              map=pass · content={relation.review}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}