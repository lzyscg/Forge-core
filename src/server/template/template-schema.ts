/**
 * Platform-generic frozen template types and stable public error codes
 * (plan Phase B Task 2 Step 3).
 *
 * A frozen template is the validated, hash-identified recipe copied into the
 * managed cache and later into task snapshots. The module carries no business
 * vocabulary (iron rule 1): concrete template content lives only in source
 * directories and test fixtures. Errors satisfy the public page-facing
 * contract: stable code, presentable message, relative file location and an
 * actionable hint — never raw causes or absolute paths (iron rule 6).
 */
import type { InputField } from '../../shared/contracts';
import type { ProgressPolicy } from '../runtime/progress-guard';
import type { PublicCoreError } from '../../shared/errors';

/**
 * The per-agent turn contract of the production/dispatch model (plan
 * 2026-08-04, spec §6). Every current template agent declares one: the
 * production phase must end with `finish_production` sealing a package from
 * an allowed source/format, then exactly one allowed dispatch action
 * delivers that sealed package (`productionPackageRef: current`). Historical
 * frozen snapshots without a supported contract are non-runnable (spec §7.3).
 */
export interface TurnContract {
  version: 1;
  production: {
    completionAction: 'finish_production';
    output: {
      formats: Array<'markdown' | 'text'>;
      sources: Array<'inline' | 'workspace_file' | 'current_input_artifact'>;
    };
  };
  dispatch: {
    cardinality: 'single';
    /** The delivery intents this agent may choose from; exactly one per turn. */
    allowedActions: Array<'send_message' | 'publish_artifact' | 'submit_final_artifact'>;
    /**
     * Candidate target set per intent (plan 2026-08-06): the turn's one
     * dispatch may target any agent in the declared set. Scalar template
     * declarations normalize to one-element sets at load time (final
     * submission targets the system).
     */
    targets: Partial<
      Record<'send_message' | 'publish_artifact' | 'submit_final_artifact', string[]>
    >;
    productionPackageRef: 'current';
  };
}

export interface FrozenAgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  skills: Array<{ id: string; name: string; description: string; contentPath: string }>;
  /**
   * The agent's turn contract. Every CURRENT template agent declares one
   * (enforced by the validator); historical frozen task snapshots loaded in
   * relaxed mode carry `null` here, which marks the whole snapshot
   * non-runnable (spec §7.3) without ever deleting or rewriting it.
   */
  turnContract: TurnContract | null;
}

export interface FrozenTemplate {
  id: string;
  name: string;
  description: string;
  versionHash: string;
  inputFields: InputField[];
  agents: FrozenAgentConfig[];
  routes: Array<{ from: string; to: string; kind: 'message' | 'artifact'; label: string }>;
  finalOutput: { name: string; format: 'markdown' | 'text'; submitters: string[] };
  /**
   * Optional per-template progress budget (plan 2026-08-06): overrides the
   * scheduler-injected progress policy for every task frozen from this
   * template; null when the pipeline declares none (platform default).
   */
  budget: ProgressPolicy | null;
  sourcePath: string;
}

/**
 * True when every frozen agent carries a supported (version 1) turn contract.
 * Historical task snapshots without one stay readable but can never be
 * executed — the scheduler gates them into `incompatible` (spec §7.3).
 */
export function isTurnContractSupported(frozen: FrozenTemplate): boolean {
  return frozen.agents.every((agent) => agent.turnContract !== null && agent.turnContract.version === 1);
}

/**
 * Stable public template error codes. `TEMPLATE_NOT_FOUND` intentionally
 * matches the frozen Phase A client code list so both Gateway implementations
 * surface the same code for an unknown template.
 */
export const TEMPLATE_ERROR_CODES = {
  TEMPLATE_INVALID: 'TEMPLATE_INVALID',
  TEMPLATE_DUPLICATE_KEY: 'TEMPLATE_DUPLICATE_KEY',
  TEMPLATE_ROUTE_SOURCE_UNKNOWN: 'TEMPLATE_ROUTE_SOURCE_UNKNOWN',
  TEMPLATE_ROUTE_TARGET_UNKNOWN: 'TEMPLATE_ROUTE_TARGET_UNKNOWN',
  TEMPLATE_FINAL_SUBMITTER_UNKNOWN: 'TEMPLATE_FINAL_SUBMITTER_UNKNOWN',
  TEMPLATE_SKILL_MISSING: 'TEMPLATE_SKILL_MISSING',
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
} as const;

export type TemplateErrorCode = (typeof TEMPLATE_ERROR_CODES)[keyof typeof TEMPLATE_ERROR_CODES];

/** Public error type thrown by every template module failure path. */
export class TemplateError extends Error implements PublicCoreError {
  readonly code: string;

  readonly location: string | null;

  readonly action: string | null;

  constructor(
    code: TemplateErrorCode,
    message: string,
    location: string | null = null,
    action: string | null = null,
  ) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.location = location;
    this.action = action;
  }
}
