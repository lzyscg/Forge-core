// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import { projectAuthoritativeReviewActivity } from './public-activity';

describe('projectAuthoritativeReviewActivity', () => {
  it('projects real WorkItem and Attempt state into a safe process timeline', () => {
    const projection = {
      workItems: {
        'wi-1': {
          workItemId: 'wi-1',
          kind: 'agent_assignment',
          roleBinding: 'writer',
          agentExecutionKind: 'structured_session',
          sessionKind: 'generation_batch',
          attemptCount: 1,
          state: 'completed',
          retryNotBefore: null,
        },
        'wi-2': {
          workItemId: 'wi-2',
          kind: 'system_seal',
          roleBinding: null,
          agentExecutionKind: null,
          sessionKind: null,
          attemptCount: 1,
          state: 'leased',
          retryNotBefore: null,
        },
      },
      attempts: {
        'attempt-1': {
          attemptId: 'attempt-1',
          workItemId: 'wi-1',
          leaseEpoch: 1,
          state: 'completed',
          failureCode: null,
        },
        'attempt-2': {
          attemptId: 'attempt-2',
          workItemId: 'wi-2',
          leaseEpoch: 1,
          state: 'started',
          failureCode: null,
        },
      },
      activeLease: { workItemId: 'wi-2' },
    } as unknown as Pick<AuthoritativeReviewProjectionV2, 'workItems' | 'attempts' | 'activeLease'>;

    expect(projectAuthoritativeReviewActivity(projection)).toEqual({
      totalWorkItems: 2,
      completedWorkItems: 1,
      activeWorkItemId: 'wi-2',
      steps: [
        expect.objectContaining({
          workItemId: 'wi-1',
          state: 'completed',
          latestAttemptState: 'completed',
        }),
        expect.objectContaining({
          workItemId: 'wi-2',
          state: 'running',
          latestAttemptState: 'started',
        }),
      ],
    });
  });
});
