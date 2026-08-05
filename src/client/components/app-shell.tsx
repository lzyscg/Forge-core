import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { ErrorBoundary } from './error-boundary';

export interface AppShellProps {
  /**
   * Optional override for the routed outlet; tests inject page elements
   * directly while production renders the router <Outlet />.
   */
  outlet?: ReactNode;
}

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? 'fc-nav-link fc-nav-link--active' : 'fc-nav-link';
}

/**
 * Product shell: warm-white header with the Forge wordmark and the two
 * production navigation entries, plus a main region wrapped in an
 * ErrorBoundary. `/dev/progress` is intentionally NOT linked here — it stays
 * addressable by URL only.
 */
export function AppShell({ outlet }: AppShellProps) {
  return (
    <div className="fc-shell">
      <header className="fc-shell__header">
        <div className="fc-shell__header-inner">
          <span className="fc-shell__wordmark">Forge</span>
          <nav className="fc-shell__nav" aria-label="主导航">
            <NavLink to="/tasks" className={navLinkClassName}>
              生产任务
            </NavLink>
            <NavLink to="/templates" className={navLinkClassName}>
              模板
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="fc-shell__main">
        <ErrorBoundary>{outlet ?? <Outlet />}</ErrorBoundary>
      </main>
    </div>
  );
}
