import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { WorkspaceNode } from '../../shared/contracts';
import { nodeKindLabel, nodeStatusLabel } from '../pages/display';

export interface NodeDetailDialogProps {
  node: WorkspaceNode;
  agentName: string;
  onClose: () => void;
}

/**
 * Full read-only node detail: complete body, attempt count, associated
 * artifact version and public status. Focus moves in on open and returns to
 * the invoking element on close; Escape dismisses.
 */
export function NodeDetailDialog({ node, agentName, onClose }: NodeDetailDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (previous !== null && document.contains(previous)) previous.focus();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="fc-node-detail__backdrop" onKeyDown={handleKeyDown}>
      <div
        className="fc-node-detail"
        role="dialog"
        aria-modal="true"
        aria-label={node.title}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="fc-node-detail__header">
          <h2 className="fc-node-detail__title">{node.title}</h2>
          <button
            type="button"
            className="fc-drawer__close"
            aria-label="关闭节点详情"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
        <dl className="fc-node-detail__meta">
          <div className="fc-node-detail__meta-row">
            <dt>Agent</dt>
            <dd className="fc-node-detail__value">{agentName}</dd>
          </div>
          <div className="fc-node-detail__meta-row">
            <dt>类型</dt>
            <dd className="fc-node-detail__value">{nodeKindLabel(node.kind)}</dd>
          </div>
          <div className="fc-node-detail__meta-row">
            <dt>状态</dt>
            <dd className="fc-node-detail__value">{nodeStatusLabel(node.status)}</dd>
          </div>
          <div className="fc-node-detail__meta-row">
            <dt>尝试次数</dt>
            <dd className="fc-node-detail__value">{node.attemptCount}</dd>
          </div>
          <div className="fc-node-detail__meta-row">
            <dt>关联版本</dt>
            <dd className="fc-node-detail__value">
              {node.artifactVersion !== null ? `V${node.artifactVersion}` : '无'}
            </dd>
          </div>
        </dl>
        <div className="fc-node-detail__body">
          <h3 className="fc-node-detail__body-title">完整内容</h3>
          <p className="fc-node-detail__content">{node.body}</p>
        </div>
      </div>
    </div>
  );
}
