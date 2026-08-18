import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AuthoritativeReviewActivityV2 } from '../../shared/authoritative-review-v2';
import { workspaceWithReturnLoop } from '../test-support';
import { AuthoritativeProcessPanel } from './authoritative-process-panel';

describe('AuthoritativeProcessPanel', () => {
  it('renders the real v2 WorkItem timeline with Agent labels and lifecycle states', () => {
    const workspace = workspaceWithReturnLoop();
    const activity: AuthoritativeReviewActivityV2 = {
      totalWorkItems: 2,
      completedWorkItems: 1,
      activeWorkItemId: 'wi-2',
      steps: [
        {
          workItemId: 'wi-1',
          kind: 'agent_assignment',
          roleBinding: workspace.agents[0]?.id ?? 'writer',
          agentExecutionKind: 'structured_session',
          sessionKind: 'generation_batch',
          state: 'completed',
          attemptCount: 1,
          latestAttemptState: 'completed',
          failureCode: null,
          retryNotBefore: null,
        },
        {
          workItemId: 'wi-2',
          kind: 'system_seal',
          roleBinding: null,
          agentExecutionKind: null,
          sessionKind: null,
          state: 'running',
          attemptCount: 1,
          latestAttemptState: 'started',
          failureCode: null,
          retryNotBefore: null,
        },
      ],
    };

    render(<AuthoritativeProcessPanel activity={activity} agents={workspace.agents} />);

    expect(screen.getByRole('heading', { name: '权威生产过程' })).toBeVisible();
    expect(screen.getByText('已完成 1 / 2')).toBeVisible();
    expect(screen.getByText(workspace.agents[0]!.name)).toBeVisible();
    expect(screen.getByText('系统')).toBeVisible();
    expect(screen.getByText('已完成')).toBeVisible();
    expect(screen.getByText('进行中')).toBeVisible();
    const runningStep = screen.getByTestId('authoritative-process-step-wi-2');
    expect(within(runningStep).getByText('wi-2')).toBeVisible();
  });
});
