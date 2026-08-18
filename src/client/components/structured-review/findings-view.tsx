import type {
  AuthoritativeFindingSummaryV2,
  CollectionPageV2,
  FindingPrimaryLocationKindV2,
} from '../../../shared/authoritative-review-v2';

/**
 * Findings view (design §20 view 5): defect class, primary location, owner
 * (review context), RepairGrant and lifecycle status. Each row has a
 * locate target action that jumps the tree view to the primary location
 * (read-only — the drawer never edits verdicts or closes Findings).
 */
interface FindingsViewProps {
  findings: CollectionPageV2<AuthoritativeFindingSummaryV2>;
  onLocatePrimary: (
    primary: { kind: FindingPrimaryLocationKindV2; id: string },
  ) => void;
}

function locationLabel(primary: { kind: FindingPrimaryLocationKindV2; id: string }): string {
  switch (primary.kind) {
    case 'slot':
      return `槽位 ${primary.id}`;
    case 'relation':
      return `关系 ${primary.id}`;
    case 'map_node':
      return `Map 节点 ${primary.id}`;
    case 'map':
      return `Map ${primary.id}`;
  }
}

export function FindingsView({ findings, onLocatePrimary }: FindingsViewProps) {
  if (findings.items.length === 0) {
    return (
      <p className="fc-review-findings__empty" role="status">
        无 Findings。
      </p>
    );
  }

  return (
    <div className="fc-review-findings" aria-label="Findings">
      <ul className="fc-review-findings__list">
        {findings.items.map((finding) => (
          <li
            key={finding.findingId}
            className="fc-review-findings__item"
            aria-label={`finding ${finding.findingId}`}
          >
            <header className="fc-review-findings__header">
              <code className="fc-review-findings__id" title={finding.findingId}>
                {finding.findingId}
              </code>
              <div className="fc-review-findings__badges">
                <span className="fc-review-findings__severity">severity: {finding.severity}</span>
                <span className="fc-review-findings__status">status: {finding.status}</span>
              </div>
            </header>
            <dl className="fc-review-findings__details">
              <div>
                <dt>缺陷类型</dt>
                <dd className="fc-review-findings__defect">defect: {finding.defectClass}</dd>
              </div>
              <div>
                <dt>审核范围</dt>
                <dd>{finding.reviewContext.kind} · {finding.reviewContext.roundId}</dd>
              </div>
              <div>
                <dt>主位置</dt>
                <dd className="fc-review-findings__location">
                  {locationLabel(finding.primaryLocation)}
                </dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd className="fc-review-findings__owner">来源: {finding.source}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="fc-button fc-button--secondary fc-review-findings__locate"
              aria-label={`定位 finding 主体 ${finding.primaryLocation.id}`}
              onClick={() => onLocatePrimary(finding.primaryLocation)}
            >
              定位
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
