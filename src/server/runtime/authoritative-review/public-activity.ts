import type {
  AuthoritativeActivityAttemptStateV2,
  AuthoritativeActivityStepStateV2,
  AuthoritativeReviewActivityV2,
  WorkItemKindV2,
} from '../../../shared/authoritative-review-v2';
import type {
  AttemptProjectionV2,
  AuthoritativeReviewProjectionV2,
  WorkItemProjectionV2,
} from '../../storage/authoritative-review-state';

type ActivityProjectionInput = Pick<
  AuthoritativeReviewProjectionV2,
  'workItems' | 'attempts' | 'activeLease'
>;

const WORK_ITEM_KINDS = new Set<WorkItemKindV2>([
  'agent_assignment',
  'system_map_finalize',
  'system_generation_finalize',
  'system_repair_finalize',
  'system_migration_validation_batch',
  'system_review_settlement',
  'system_seal',
]);

function displayState(state: WorkItemProjectionV2['state']): AuthoritativeActivityStepStateV2 {
  switch (state) {
    case 'ready':
      return 'queued';
    case 'leased':
      return 'running';
    case 'retryable_failed':
      return 'retrying';
    case 'terminal_failed':
      return 'failed';
    case 'parked':
      return 'parked';
    case 'superseded':
      return 'superseded';
    case 'completed':
      return 'completed';
  }
}

function latestAttemptFor(
  attempts: Record<string, AttemptProjectionV2>,
  workItemId: string,
): AttemptProjectionV2 | null {
  let latest: AttemptProjectionV2 | null = null;
  for (const attempt of Object.values(attempts)) {
    if (attempt.workItemId !== workItemId) continue;
    if (
      latest === null ||
      attempt.leaseEpoch > latest.leaseEpoch ||
      (attempt.leaseEpoch === latest.leaseEpoch && attempt.attemptId > latest.attemptId)
    ) {
      latest = attempt;
    }
  }
  return latest;
}

function attemptStateOf(attempt: AttemptProjectionV2 | null): AuthoritativeActivityAttemptStateV2 | null {
  return attempt?.state ?? null;
}

/**
 * Projects only public lifecycle facts for the production page. The source is
 * the replayed v2 projection; private leases, authority refs and provider
 * output are deliberately not copied into the DTO.
 */
export function projectAuthoritativeReviewActivity(
  projection: ActivityProjectionInput,
): AuthoritativeReviewActivityV2 {
  const steps = Object.values(projection.workItems).map((workItem) => {
    const attempt = latestAttemptFor(projection.attempts, workItem.workItemId);
    const kind = workItem.kind as WorkItemKindV2;
    if (!WORK_ITEM_KINDS.has(kind)) {
      throw new Error(`unknown authoritative WorkItem kind: ${workItem.kind}`);
    }
    return {
      workItemId: workItem.workItemId,
      kind,
      roleBinding: workItem.roleBinding,
      agentExecutionKind: workItem.agentExecutionKind,
      sessionKind: workItem.sessionKind,
      state: displayState(workItem.state),
      attemptCount: workItem.attemptCount,
      latestAttemptState: attemptStateOf(attempt),
      failureCode: attempt?.failureCode ?? null,
      retryNotBefore: workItem.retryNotBefore,
    };
  });

  return {
    totalWorkItems: steps.length,
    completedWorkItems: steps.filter((step) => step.state === 'completed').length,
    activeWorkItemId: projection.activeLease?.workItemId ?? null,
    steps,
  };
}
