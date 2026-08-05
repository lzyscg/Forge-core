import { Link, Navigate, type RouteObject } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { DevelopmentProgressPage } from './pages/development-progress-page';
import { NewTaskPage } from './pages/new-task-page';
import { ProductionPage } from './pages/production-page';
import { TaskListPage } from './pages/task-list-page';
import { TemplateDetailPage } from './pages/template-detail-page';
import { TemplateListPage } from './pages/template-list-page';

function NotFoundPage() {
  return (
    <section className="fc-not-found-page">
      <h1 className="fc-page-title">页面不存在</h1>
      <p className="fc-not-found-page__hint">
        你访问的地址不存在。你可以返回
        <Link className="fc-inline-link" to="/tasks">
          生产任务
        </Link>
        或浏览
        <Link className="fc-inline-link" to="/templates">
          模板
        </Link>
        。
      </p>
    </section>
  );
}

/**
 * Single source of route truth, consumed by createBrowserRouter in
 * production and createMemoryRouter in tests. `/dev/progress` is routable
 * but never linked from the production shell.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },
      { path: 'tasks', element: <TaskListPage /> },
      { path: 'tasks/new', element: <NewTaskPage /> },
      { path: 'tasks/:taskId', element: <ProductionPage /> },
      { path: 'templates', element: <TemplateListPage /> },
      { path: 'templates/:templateId', element: <TemplateDetailPage /> },
      { path: 'dev/progress', element: <DevelopmentProgressPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
