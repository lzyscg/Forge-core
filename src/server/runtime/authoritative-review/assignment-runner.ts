/**
 * Task 12 assignment runner (design §17.2/§18, spec §10.2/§11): consumes a
 * leased AssignmentDispatch, injects the v2 tool provider, runs the session in
 * the attempt's ISOLATED conversation namespace, and returns a committable
 * outcome that the attempt-coordinator submits to the v2 committer (the
 * facade-backed completion). Generic Submitter turns reuse basic-turn
 * execution with delivery-bound authority (the Task 11 coordinator already
 * blocks submitter leases without a current SystemArtifactDelivery — this
 * runner keeps that invariant by never synthesizing a delivery).
 *
 * The runner is deliberately THIN: it owns session assembly and error
 * classification, never domain facts. Domain tools come from the injected
 * `V2ToolProvider` (Task 13's tool-factory); this module only requires the
 * seam. Every Agent turn materializes the §10.2 namespace and receives ONLY
 * the current assignment + a bounded committed checkpoint as prompt context —
 * never raw prior conversation/human messages aggregated by Agent ID
 * (reviewer sessions never see orchestrator/generator history).
 */
import type { AgentRuntime, AgentTurnInput } from '../agent-runtime';
import { RuntimeAbortedError } from '../agent-runtime';
import { classifyRuntimeError } from '../retry-policy';
import type { TraceEntry } from '../../../shared/contracts';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { V2AttemptContext } from './attempt-coordinator';

/**
 * The v2 tool provider seam: returns the session-specific bound tool set for
 * one attempt context (Task 13's tool-factory). Tools never take task/grant/
 * path/authority parameters — server closure supplies them.
 */
export interface V2ToolProvider {
  toolsFor(ctx: V2AttemptContext): Promise<readonly ToolDefinition[]>;
  /**
   * Task 12 §9.2 completion gate seam: after the session, the runner asks the
   * provider for the DOMAIN RESULT refs the tools durably prepared (the
   * §17.5 completion envelope folds these in the SAME batch as the attempt/
   * workitem terminal). Empty by default; Task 13's tool-factory returns the
   * committed chunk/ledger/content/staging refs. The attempt-coordinator passes
   * them to `completeWorkItem`, which REJECTS a bare completion of a gated kind
   * with zero writes.
   */
  collectResultRefs?(ctx: V2AttemptContext): Promise<readonly BlobRefV2[]>;
}

/** The closed outcome of one v2 Agent session (committable by the coordinator). */
export type V2SessionOutcome =
  | { kind: 'committed'; publicText: string; trace: readonly TraceEntry[]; resultRefs: readonly BlobRefV2[] }
  | { kind: 'retryable_failure'; failureCode: string; message: string }
  | { kind: 'terminal_failure'; failureCode: string; message: string };

export interface V2AssignmentRunnerDependencies {
  runtime: AgentRuntime;
  toolProvider: V2ToolProvider;
  log?: (line: string) => void;
  /**
   * Task 15 wiring seam: the map-build service whose structure-chunk tools the
   * composition root binds into the `toolProvider` (the V2ToolFactory handlers
   * `appendMapCandidateChunk`/`finishMapBuild`). The runner itself never calls
   * it — it documents the Task 15 dependency so the root wires chunk submits to
   * grant-scoped build-local validation with no aggregate publication.
   */
  buildService?: import('./map-build-service').MapBuildService;
}

export class V2AssignmentRunner {
  private readonly runtime: AgentRuntime;

  private readonly toolProvider: V2ToolProvider;

  private readonly log: (line: string) => void;

  constructor(deps: V2AssignmentRunnerDependencies) {
    this.runtime = deps.runtime;
    this.toolProvider = deps.toolProvider;
    this.log = deps.log ?? (() => undefined);
  }

  /**
   * Runs one v2 Agent session (structured or generic) and returns the
   * committable outcome. An abort is rethrown — the coordinator records
   * nothing for aborts (spec §7.2). The session is built in the attempt's
   * isolated namespace with an EMPTY public history: v2 continuity comes from
   * the bound tools (committed Map/content/Findings reads + digest-bound
   * checkpoints), never from an unbounded chat history.
   */
  async runSession(ctx: V2AttemptContext, signal: AbortSignal): Promise<V2SessionOutcome> {
    if (ctx.agent === null) {
      throw new Error('assignment-runner: cannot run a session without a frozen agent');
    }
    // Pi resolves the closed tool definitions through the v2Tools seam in
    // PiAgentRuntime. Do not resolve a second, unused list here: doing so
    // duplicates grant reads and can observe a different lease boundary from
    // the actual session. The provider is still queried after the turn for
    // the authoritative domain result refs.
    const input: AgentTurnInput = {
      taskId: ctx.taskId,
      turnId: `v2-${ctx.workItemId}-${ctx.attemptId}`,
      agent: ctx.agent,
      inputNodeId: ctx.workItemId,
      inputText: this.buildPrompt(ctx),
      // ISOLATED: never prior conversation/human messages of any WorkItem.
      publicHistory: [],
      availableSkills: [],
      loadedSkills: [],
      slotSession: null,
      v2Session: { signal },
      v2Namespace: ctx.namespace,
    };
    this.log(`assignment-runner: turn started (task=${ctx.taskId} ns=${ctx.namespace})`);
    try {
      const result = await this.runtime.run(input, signal);
      // Generic Submitter (M-3): the delivery-bound submission is the ONLY
      // legal dispatch of a generic turn — anything else (including a silent
      // text-only turn) is a terminal failure, never a bare completion. The
      // full v1 basic-turn phase/route validation stays a Task-20 seam on the
      // ActionCommitter v2 branch; this check closes the "completes without
      // submitting" gap at the runner level.
      if (ctx.executionKind === 'generic') {
        const submits = result.actions.filter((action) => action.type === 'submit_final_artifact');
        if (result.actions.length !== 1 || submits.length !== 1) {
          return {
            kind: 'terminal_failure',
            failureCode: 'GENERIC_SUBMIT_REQUIRED',
            message: 'v2 通用提交回合必须恰好提交一次当前系统交付物。',
          };
        }
      }
      const resultRefs = await this.toolProvider.collectResultRefs?.(ctx) ?? [];
      // Every structured Agent session is a gated v2 completion. If the
      // model produced only text (or the domain tool surface failed to leave
      // a committed carrier), do not let the coordinator receive a bare
      // completion and turn the HTTP request into a 500. Return through the
      // normal retry path so the lease is durably settled and the next
      // attempt can continue from the committed checkpoint.
      if (ctx.executionKind === 'structured' && resultRefs.length === 0) {
        return {
          kind: 'retryable_failure',
          failureCode: 'V2_RESULT_REFS_MISSING',
          message: '结构化回合没有提交领域结果载体，当前尝试可重试。',
        };
      }
      return {
        kind: 'committed',
        publicText: result.publicText,
        trace: result.trace,
        resultRefs,
      };
    } catch (error) {
      if (error instanceof RuntimeAbortedError) {
        throw error;
      }
      const classified = classifyRuntimeError(error);
      const message = error instanceof Error ? error.message : '模型执行失败，当前尝试已记录为失败。';
      if (classified.retryable) {
        return { kind: 'retryable_failure', failureCode: classified.code, message };
      }
      return { kind: 'terminal_failure', failureCode: classified.code, message };
    }
  }

  /** Bounded public prompt: the current assignment + committed checkpoint only. */
  private buildPrompt(ctx: V2AttemptContext): string {
    const parts: string[] = [];
    if (ctx.currentAssignmentText.length > 0) {
      parts.push(`【当前分配】\n${ctx.currentAssignmentText}`);
    }
    if (ctx.committedCheckpointText.length > 0) {
      parts.push(`【已提交进度】\n${ctx.committedCheckpointText}`);
    }
    return parts.join('\n\n');
  }
}
