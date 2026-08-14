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
import type { FrozenStructuredSlotContractV1 } from './structured-slot-contract';
import type { FrozenStructuredSlotContractV2 } from './structured-slot-contract-v2';
import type { StructuredSessionKindV2, SlotCapabilityV2 } from './structured-slot-contract-v2';
import type { AuthoritativeReviewProfileBindingV1 } from '../structured-slots/authoritative-review-profile';

/**
 * Closed ten-value Slot capability enum v1 (spec §3.2 / design §10.2 D01).
 * The runtime never accepts template-custom capability names.
 */
export type SlotCapabilityV1 =
  | 'read_structure_contract'
  | 'write_structure_proposal'
  | 'validate_structure_proposal'
  | 'submit_structure_proposal'
  | 'read_slot_spec'
  | 'read_slot_content'
  | 'write_draft_content'
  | 'validate_draft'
  | 'submit_draft'
  | 'request_seal';

/** v3 slot session union (spec §3.2). structure binds no profile. */
export type StructuredSlotSessionV3 =
  | {
      kind: 'structure';
      accessProfile: null;
      capabilities: SlotCapabilityV1[];
      completion: 'structure_commit_candidate_created';
    }
  | {
      kind: 'fill';
      accessProfile: string;
      capabilities: SlotCapabilityV1[];
      completion: 'merge_candidate_created';
    }
  | {
      kind: 'seal';
      accessProfile: string;
      capabilities: SlotCapabilityV1[];
      completion: 'seal_candidate_created';
      failureDispatch: {
        when: 'seal_gate_failed';
        action: 'send_message';
      };
    };

/**
 * Structured TurnContract v3 (spec §3.2). A slot agent fixes exactly one
 * `slotSession.kind`; v2 `production`/`annotate` are mutually exclusive with
 * the slot session and never appear on v3 (design §11.4).
 */
export interface StructuredTurnContractV3 {
  version: 3;
  slotSession: StructuredSlotSessionV3;
  dispatch: {
    allowedActions: Array<
      'send_message' | 'publish_artifact' | 'submit_final_artifact' | 'request_human_input'
    >;
    targets: Partial<Record<'send_message' | 'publish_artifact', string[]>>;
  };
}

/**
 * Structured TurnContract v4 (spec §6.4): the v2 structured Agent contract.
 * `authoritativeReview` binds the closed v2 session kinds, per-kind access
 * profiles and the closed `SlotCapabilityV2` ceiling; `dispatch` carries NO
 * sending intents — v2 completion is system-coordinated, only the human
 * interrupt may be requested. V1 Agents retain `StructuredTurnContractV3`;
 * the Submitter stays a generic BasicTurnContractV2.
 */
export interface AuthoritativeStructuredTurnContractV4 {
  version: 4;
  authoritativeReview: {
    allowedSessionKinds: StructuredSessionKindV2[];
    accessProfiles: Partial<Record<StructuredSessionKindV2, string | null>>;
    capabilities: SlotCapabilityV2[];
  };
  dispatch: {
    allowedActions: Array<'request_human_input'>;
    targets: Record<string, never>;
  };
}

/**
 * Shared basic v1/v2 turn-contract fields (plan 2026-08-07, spec §15). A
 * production turn declares `production` and dispatches `publish_artifact`; an
 * operate turn declares `annotate` and dispatches
 * `forward_input_version`/`send_message`/`submit_final_artifact`; a coordinate
 * (dispatch-only) turn declares neither and only dispatches.
 * `request_human_input` may interrupt any turn.
 */
interface BasicTurnContractFields {
  production?: {
    completionAction?: 'finish_production';
    output: {
      formats: Array<'markdown' | 'text'>;
      sources: Array<'inline' | 'workspace_file' | 'current_input_artifact'>;
    };
    /** v2: the files a production turn seals. */
    files?: string[];
  };
  /** v2: present => the agent may annotate these files (operate turn). */
  annotate?: {
    files: string[];
  };
  dispatch: {
    /** Kept for v1 compatibility; v2 is always single. */
    cardinality?: 'single';
    /** The delivery intents this agent may choose from; exactly one per turn. */
    allowedActions: Array<
      | 'send_message'
      | 'publish_artifact'
      | 'submit_final_artifact'
      | 'forward_input_version'
      | 'request_human_input'
    >;
    /**
     * Candidate target set per intent: the turn's one dispatch may target any
     * agent in the declared set. Scalar template declarations normalize to
     * one-element sets at load time.
     */
    targets: Partial<
      Record<
        'send_message' | 'publish_artifact' | 'submit_final_artifact' | 'forward_input_version',
        string[]
      >
    >;
    /** Kept for v1 compatibility; v2 dispatch actions carry no package ref. */
    productionPackageRef?: 'current';
  };
}

/** Historical basic version-1 turn contract (kept unchanged). */
export interface BasicTurnContractV1 extends BasicTurnContractFields {
  version: 1;
}

/** Current basic version-2 turn contract (kept unchanged). */
export interface BasicTurnContractV2 extends BasicTurnContractFields {
  version: 2;
}

/** Every supported turn contract (spec §3.2 / design §11.4). */
export type TurnContract =
  | BasicTurnContractV1
  | BasicTurnContractV2
  | StructuredTurnContractV3
  | AuthoritativeStructuredTurnContractV4;

/** True when the contract is a v1/v2 basic contract (production/annotate shape). */
export function isBasicTurnContract(
  contract: TurnContract | null,
): contract is BasicTurnContractV1 | BasicTurnContractV2 {
  return contract !== null && (contract.version === 1 || contract.version === 2);
}

/** True when the contract is a structured v3 slot-session contract. */
export function isStructuredTurnContractV3(
  contract: TurnContract | null,
): contract is StructuredTurnContractV3 {
  return contract !== null && contract.version === 3;
}

/** True when the contract is the v2 structured Agent contract (spec §6.4). */
export function isAuthoritativeStructuredTurnContractV4(
  contract: TurnContract | null,
): contract is AuthoritativeStructuredTurnContractV4 {
  return contract !== null && contract.version === 4;
}

/**
 * Scaffold phase used by the structured pipeline typestate (spec §6 / design
 * §11.6): the compiled phase contract maps each agent id to the set of input
 * phases it may run under.
 */
export type ScaffoldPhase = 'no_scaffold' | 'active_unsealed' | 'sealed';

/** One frozen Skill: identity + content file plus optional section files. */
export interface FrozenSkill {
  id: string;
  name: string;
  description: string;
  contentPath: string;
  /** Optional: section-file directory (template-relative); null = no sections. */
  sectionsPath: string | null;
  /**
   * `.md` relative paths collected from `sectionsPath` at load time (relative
   * to the template directory, forward slashes, sorted); runtime read-only.
   */
  sections: string[];
}

/**
 * A template-declared JS validator gate (plan 2026-08-07 Phase 2, spec §4.1).
 * The validator file is a CommonJS module whose default export is
 * `validate(input)`. `self_check` exposes the read-only `validate_artifact`
 * tool for model self-checks; `commit` makes the platform run the validator as
 * a non-bypassable gate before any commit that lands a new artifact.
 */
export interface FrozenGate {
  /** JS validator file relative path (CommonJS default export `validate`). */
  validator: string;
  artifactType: string;
  mode: Array<'self_check' | 'commit'>;
}

export interface FrozenAgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  skills: FrozenSkill[];
  /** Optional JS validator gate; null when the agent declares none. */
  gate: FrozenGate | null;
  /**
   * Static capability ceiling declared by the agent YAML (v3 slot agents, spec
   * §3.2 / design D02). Basic agents carry an empty ceiling.
   */
  slotCapabilities: SlotCapabilityV1[];
  /**
   * The agent's turn contract. Every CURRENT template agent declares one
   * (enforced by the validator); historical frozen task snapshots loaded in
   * relaxed mode carry `null` here, which marks the whole snapshot
   * non-runnable (spec §7.3) without ever deleting or rewriting it.
   */
  turnContract: TurnContract | null;
}

export interface ArtifactSchemaFile {
  name: string;
  required: boolean;
  /**
   * Agent producers stay plain safe-id strings (basic/v1 normalize and hash
   * EXACTLY as before); v2 uses the explicit system branch frozen as
   * `{kind:'system', systemId:'structured_seal'}` (spec §6.3). The safe
   * Agent-ID regex is never relaxed to admit `system:structured_seal`.
   */
  producer: string | ArtifactSystemProducerRef;
  extract: string;
  phase: 'create' | 'annotate';
}

/** The discriminated system producer reference (spec §6.3). */
export interface ArtifactSystemProducerRef {
  kind: 'system';
  systemId: 'structured_seal';
}

export type ArtifactProducerRef = { kind: 'agent'; agentId: string } | ArtifactSystemProducerRef;

/** True when the producer is the frozen system producer reference. */
export function isArtifactSystemProducerRef(value: unknown): value is ArtifactSystemProducerRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['kind'] === 'system' &&
    (value as Record<string, unknown>)['systemId'] === 'structured_seal' &&
    Object.keys(value as Record<string, unknown>).length === 2
  );
}

export interface ArtifactSchema {
  files: ArtifactSchemaFile[];
}

/**
 * The authoritative v2 pipeline lifecycle (spec §6.3): exact protocol, the
 * four role bindings and the system artifact producer literal. Null on basic
 * and contract-v1 templates; required on contract-v2 templates.
 */
export interface AuthoritativeReviewLifecycleV1 {
  protocol: 'authoritative_review_v1';
  roleBindings: {
    orchestrator: string;
    generator: string;
    reviewer: string;
    submitter: string;
  };
  systemArtifactProducer: 'system:structured_seal';
}

export interface FrozenTemplate {
  id: string;
  name: string;
  description: string;
  versionHash: string;
  inputFields: InputField[];
  agents: FrozenAgentConfig[];
  routes: Array<{ from: string; to: string; kind: 'message' | 'artifact'; label: string; inject?: Array<{ version: 'input'; file: string; as: string }> }>;
  artifactSchema: ArtifactSchema;
  finalOutput: { name: string; format: 'markdown' | 'text'; submitters: string[] };
  /**
   * Optional per-template progress budget (plan 2026-08-06): overrides the
   * scheduler-injected progress policy for every task frozen from this
   * template; null when the pipeline declares none (platform default).
   */
  budget: ProgressPolicy | null;
  /**
   * Production mode (spec §3.2): `basic` for the existing v2 model,
   * `structured_slots` for the structured slot engine. Historical manifests
   * without the field normalize to `basic`.
   */
  productionMode: 'basic' | 'structured_slots';
  /**
   * The compiled structured-slot contract (spec §3.4/§6.1); null for basic
   * templates and historical manifests. The version discriminates the
   * protocol: v1 keeps the current semantics, v2 is the authoritative
   * per-slot review contract.
   */
  structuredSlots: FrozenStructuredSlotContractV1 | FrozenStructuredSlotContractV2 | null;
  /**
   * The compiled pipeline scaffold-phase contract (spec §6 / design §11.6):
   * each agent id maps to the set of input `ScaffoldPhase`s it may run under.
   * Null for basic templates.
   */
  structuredPhases: Record<string, readonly ScaffoldPhase[]> | null;
  /**
   * The v2 pipeline lifecycle block (spec §6.3); null on basic and v1
   * templates. Contract-v2 templates REQUIRE it.
   */
  structuredReviewLifecycle: AuthoritativeReviewLifecycleV1 | null;
  /**
   * The frozen profile binding of a v2 template (spec §4.3): exact profile
   * identity + the object-field digest + the byte-exact snapshot BlobRef.
   * Null on basic and v1 templates; bound into the v2 semantic template hash.
   */
  authoritativeReviewProfile: AuthoritativeReviewProfileBindingV1 | null;
  sourcePath: string;
}

/**
 * True when every frozen agent carries a supported (version 2) turn contract.
 * Historical task snapshots without one (or carrying the removed version-1
 * shape) stay readable but can never be executed — the scheduler gates them
 * into `incompatible` (spec §7.3/§9): contract-less snapshots get
 * `TURN_CONTRACT_REQUIRED`, version-1 snapshots get `SCHEMA_V2_REQUIRED`.
 */
export function isTurnContractSupported(frozen: FrozenTemplate): boolean {
  return frozen.agents.every(
    (agent) => agent.turnContract !== null && agent.turnContract.version === 2,
  );
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
  /** Structured template known but the host runtime cannot run it (spec §5). */
  TEMPLATE_RUNTIME_UNAVAILABLE: 'TEMPLATE_RUNTIME_UNAVAILABLE',
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
