import { useEffect, useRef } from 'react';
import type { PublicCoreError } from '../../shared/errors';

export interface PublicErrorNoticeProps {
  /** Heading naming the failed operation, e.g. 加载模板详情失败. */
  title: string;
  error: PublicCoreError;
  /** Focus the notice after render (used for submit/action failures). */
  focusOnMount?: boolean;
}

/**
 * Canonical rendering of a PublicCoreError: every notice answers where the
 * failure happened, why, and what the user can do now. Internal stacks and
 * storage details never appear because the contract itself excludes them.
 */
export function PublicErrorNotice({ title, error, focusOnMount = false }: PublicErrorNoticeProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusOnMount) {
      ref.current?.focus();
    }
  }, [focusOnMount, error]);

  return (
    <div
      className="fc-error-notice"
      role="alert"
      tabIndex={focusOnMount ? -1 : undefined}
      ref={ref}
    >
      <p className="fc-error-notice__title">{title}</p>
      {error.location !== null ? (
        <p className="fc-error-notice__line">
          失败位置：<span className="fc-error-notice__value">{error.location}</span>
        </p>
      ) : null}
      <p className="fc-error-notice__line">
        原因：<span className="fc-error-notice__value">{error.message}</span>
      </p>
      {error.action !== null ? (
        <p className="fc-error-notice__line">
          现在可以：<span className="fc-error-notice__value">{error.action}</span>
        </p>
      ) : null}
    </div>
  );
}
