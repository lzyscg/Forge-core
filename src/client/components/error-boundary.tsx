import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Page-level error boundary. Catches render failures below it and shows a
 * recovery panel while the surrounding shell (header navigation) stays
 * mounted and usable.
 *
 * The fallback uses plain anchors instead of router <Link> components on
 * purpose: after a render crash a full page load is the most robust way to
 * clear corrupted client-side state, and the boundary stays testable outside
 * any router context.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Phase A has no telemetry sink; keep a loud local trace.
    console.error('[forge-core] page render failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="fc-error-panel" role="alert">
          <h2 className="fc-error-panel__title">这个页面暂时无法显示</h2>
          <p className="fc-error-panel__hint">
            当前页面渲染出现问题，应用其余部分仍可继续使用。你可以
            <a className="fc-inline-link" href="/tasks">
              返回生产任务列表
            </a>
            、
            <a className="fc-inline-link" href="/templates">
              返回模板列表
            </a>
            ，或刷新浏览器后重试。
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
