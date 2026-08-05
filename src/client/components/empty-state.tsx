import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Optional call-to-action slot, e.g. a link to another section. */
  action?: ReactNode;
}

/**
 * Generic empty-list placeholder. Fully props driven and free of product
 * vocabulary so every page can reuse it with its own copy.
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="fc-empty-state">
      <p className="fc-empty-state__title">{title}</p>
      {description !== undefined ? (
        <p className="fc-empty-state__description">{description}</p>
      ) : null}
      {action !== undefined ? <div className="fc-empty-state__action">{action}</div> : null}
    </div>
  );
}
