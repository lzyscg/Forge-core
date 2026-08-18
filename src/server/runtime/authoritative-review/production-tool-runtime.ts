/**
 * Production bridge for the authoritative v2 tool factory.
 *
 * A task snapshot owns its profile and its private journals, so one global
 * V2ToolFactory cannot be shared safely across tasks. This adapter creates a
 * task-scoped factory on demand and exposes the two existing seams used by the
 * AttemptCoordinator and PiAgentRuntime. Context reconstruction is delegated
 * to the coordinator, which derives the grant principal from the persisted
 * lease owner rather than from the frozen role Agent id.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AgentTurnInput } from '../agent-runtime';
import { RuntimeFailure } from '../agent-runtime';
import type { CorePaths } from '../../storage/core-paths';
import { AuthoritativeReviewPrivateStore } from '../../storage/authoritative-review-private-store';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import type { AuthoritativeReviewProfile } from '../../authoritative-review/authority-types';
import type { V2AttemptContext } from './attempt-coordinator';
import type { V2ToolProvider } from './assignment-runner';
import type { DispatchResolver } from './grant-service';
import { GrantService } from './grant-service';
import {
  V2ToolFactory,
  type FrozenReviewAssignmentV2,
  type V2DomainHandlers,
} from './tool-factory';
import type { ReviewPolicyParameters } from '../../authoritative-review/authority-types';

export interface ProductionV2ToolRuntimeDependencies {
  paths: CorePaths;
  profileBody(taskId: string): Promise<AuthoritativeReviewProfileSnapshotV1Body>;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
  /** Reconstructs the current attempt from the persisted lease envelope. */
  contextResolver(taskId: string, workItemId: string, attemptId: string): Promise<V2AttemptContext | null>;
  /** Resolves the committed dispatch when the scheduler path has no ref inline. */
  resolveDispatch?: DispatchResolver;
  handlersFor?(taskId: string): Promise<V2DomainHandlers | undefined>;
  resolveAssignmentTargets?(ctx: V2AttemptContext): Promise<readonly string[] | null>;
  freezeReviewAssignment?(taskId: string, freeze: FrozenReviewAssignmentV2): Promise<{ ledgerRef: BlobRefV2; eventId: string }>;
  reviewPolicyFor?(taskId: string): Promise<ReviewPolicyParameters | undefined>;
  log?(line: string): void;
}

export class ProductionV2ToolRuntime implements V2ToolProvider {
  private readonly deps: ProductionV2ToolRuntimeDependencies;

  private readonly factories = new Map<string, Promise<V2ToolFactory>>();

  constructor(deps: ProductionV2ToolRuntimeDependencies) {
    this.deps = deps;
  }

  async toolsFor(ctx: V2AttemptContext): Promise<readonly ToolDefinition[]> {
    return (await this.factoryFor(ctx.taskId)).toolsFor(ctx);
  }

  async collectResultRefs(ctx: V2AttemptContext): Promise<readonly BlobRefV2[]> {
    // Keep the pre-Task-15 installation fail-closed and retryable. The closed
    // tool surface can be exposed before domain services are composed, but a
    // structured Agent attempt must not turn an empty/fake result into a bare
    // completion rejection that escapes the mutation driver.
    if (ctx.sessionKind !== null && this.deps.handlersFor === undefined) {
      throw RuntimeFailure.transient(
        'V2_AGENT_TOOLS_NOT_WIRED',
        'authoritative v2 domain handlers are not installed for this runtime',
      );
    }
    return (await this.factoryFor(ctx.taskId)).collectResultRefs(ctx);
  }

  /** PiV2ToolRuntime seam. Basic/v3 turns never enter this branch. */
  async createContext(input: AgentTurnInput): Promise<{ toolDefinitions: ToolDefinition[] } | null> {
    if (input.v2Session === null || input.v2Session === undefined) return null;
    const attemptId = attemptIdFromNamespace(input.v2Namespace ?? '');
    if (attemptId === null) {
      throw RuntimeFailure.permanent(
        'V2_ATTEMPT_CONTEXT_INVALID',
        'authoritative v2 turn namespace does not carry an attempt identity',
      );
    }
    const context = await this.deps.contextResolver(input.taskId, input.inputNodeId, attemptId);
    if (context === null) {
      throw RuntimeFailure.permanent(
        'V2_ATTEMPT_CONTEXT_UNAVAILABLE',
        'the authoritative v2 attempt is no longer the current persisted lease',
      );
    }
    // The frozen Agent id selects the role/model. The lease owner remains in
    // context.agentId and is used by GrantService for the signed instance.
    if (context.agent === null || context.agent.id !== input.agent.id) {
      throw RuntimeFailure.permanent(
        'V2_AGENT_IDENTITY_MISMATCH',
        'the frozen role Agent does not match the persisted attempt context',
      );
    }
    return (await this.factoryFor(context.taskId)).createContext(input);
  }

  private async factoryFor(taskId: string): Promise<V2ToolFactory> {
    const existing = this.factories.get(taskId);
    if (existing !== undefined) return existing;
    const created = this.createFactory(taskId).catch((error: unknown) => {
      this.factories.delete(taskId);
      throw error;
    });
    this.factories.set(taskId, created);
    return created;
  }

  private async createFactory(taskId: string): Promise<V2ToolFactory> {
    const profileBody = await this.deps.profileBody(taskId);
    const profile = profileBody.runtime as AuthoritativeReviewProfile;
    const privateStore = new AuthoritativeReviewPrivateStore(this.deps.paths, taskId);
    const grants = new GrantService({
      resolver: this.deps.resolver,
      readProjection: this.deps.readProjection,
      profile,
      ...(this.deps.resolveDispatch === undefined ? {} : { resolveDispatch: this.deps.resolveDispatch }),
    });
    return new V2ToolFactory({
      grants,
      privateStore,
      profile,
      readProjection: this.deps.readProjection,
      resolver: this.deps.resolver,
      contextResolver: (currentTaskId, workItemId, attemptId) =>
        this.deps.contextResolver(currentTaskId, workItemId, attemptId),
      ...(this.deps.handlersFor === undefined ? {} : { handlers: await this.deps.handlersFor(taskId) }),
      ...(this.deps.resolveAssignmentTargets === undefined ? {} : { resolveAssignmentTargets: this.deps.resolveAssignmentTargets }),
      ...(this.deps.freezeReviewAssignment === undefined ? {} : { freezeReviewAssignment: this.deps.freezeReviewAssignment }),
      ...(this.deps.reviewPolicyFor === undefined ? {} : { reviewPolicy: await this.deps.reviewPolicyFor(taskId) }),
      ...(this.deps.log === undefined ? {} : { log: this.deps.log }),
    });
  }
}

function attemptIdFromNamespace(namespace: string): string | null {
  const segments = namespace.split('/');
  const attemptId = segments.at(-1);
  return segments.length >= 4 && attemptId !== undefined && attemptId.length > 0 ? attemptId : null;
}
