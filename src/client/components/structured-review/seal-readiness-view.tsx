import type { AuthoritativeSealReadinessDetailV2 } from '../../../shared/authoritative-review-v2';
import { refLabel } from './structured-review-drawer';

/**
 * Seal readiness view (design §20 view 6): per-condition system-derived
 * Gate rows, sealed artifact custody when sealed. NEVER invents a node
 * link for a system-produced artifact (spec §15 / §13.5.1): a sealed
 * artifact's custody is shown via Seal/artifact/custody refs only.
 */
export function SealReadinessView({ seal }: { seal: AuthoritativeSealReadinessDetailV2 }) {
  return (
    <div className="fc-review-seal" aria-label="Seal readiness">
      <section aria-label="Gate 状态" className="fc-review-seal__block">
        <h3 className="fc-review-heading">系统 Gate（系统派生 readiness）</h3>
        <ul className="fc-review-seal__conditions">
          {seal.conditions.map((condition) => (
            <li
              key={condition.code}
              className={
                condition.satisfied
                  ? 'fc-review-seal__condition fc-review-seal__condition--met'
                  : 'fc-review-seal__condition fc-review-seal__condition--unmet'
              }
            >
              <div className="fc-review-seal__condition-header">
                <code className="fc-review-seal__condition-code">{condition.code}</code>
                <span className="fc-review-seal__condition-state">
                  {condition.satisfied ? '通过' : '未满足'}
                </span>
              </div>
              <p className="fc-review-seal__condition-detail">{condition.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="封存状态" className="fc-review-seal__block">
        <h3 className="fc-review-heading">封存状态</h3>
        <dl className="fc-review-seal__summary">
          <div>
            <dt>readiness</dt>
            <dd>{seal.readiness}</dd>
          </div>
          <div>
            <dt>未满足条件数</dt>
            <dd>{seal.unmetConditionCount}</dd>
          </div>
          <div>
            <dt>sealed</dt>
            <dd>{seal.sealed ? '已封存' : '未封存'}</dd>
          </div>
        </dl>
        {seal.sealed ? (
          <dl className="fc-review-seal__custody">
            <div className="fc-review-seal__custody-row">
              <dt>SealRecord</dt>
              <dd>
                <code title={seal.sealRecordRef?.digest ?? undefined}>{refLabel(seal.sealRecordRef)}</code>
              </dd>
            </div>
            <p className="fc-review-seal__custody-note">系统 Seal 产物，无源节点定位。</p>
          </dl>
        ) : null}
      </section>
    </div>
  );
}
