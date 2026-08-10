/**
 * Public contract types for the structured-slot engine v1.
 *
 * This module is zero-dependency contract land (types only, no imports, no
 * runtime code). Shapes are frozen by the approved spec and upstream design:
 *
 * - JSON data model         spec §4.1
 * - IssuePhase / IssueSource / StructuredIssueV1 / StructuredVerdictV1
 *                           design §19.1
 * - IssueLocation union     design §19.2
 * - StructuredBlobRefV1     spec §7.2
 * - SealRecord              design §17.2
 * - StructuredSlotsSummaryV1 spec §14
 * - SlotCapabilityV1        spec §3.2 / design §10.2
 * - SlotSessionGrantV1      design §10.3 / spec §8.2
 * - ProjectionSubjectV1     spec §14
 * - StructuredSlotTreeCursorV1 spec §14 / design §25.13
 *
 * Where the plan and spec conflict, the plan's Global Constraints and the
 * upstream design §25-26 win; these types reproduce the spec/design verbatim.
 */

/** JSON data model (spec §4.1 / forge-canonical-json/v1). */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

/** JSON object; the only type with an index signature. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * One committed slot instance of a scaffold generation (spec §4.1). `spec` is
 * always an object; `content` may be any JSON value the schema allows. `unset`
 * is distinct from a `set` value of `null`, empty string, empty array or empty
 * object — presence is an explicit field.
 */
export interface SlotInstance {
  slotId: string;
  scaffoldId: string;
  parentSlotId: string | null;
  order: number;
  typeId: string;
  spec: JsonObject;
  contentPresence: 'unset' | 'set';
  content?: JsonValue;
}

/**
 * Eight-value closed phase enum (design §19.1): which runtime check point
 * discovered the problem. Both template and Agent are closed off from
 * extending it.
 */
export type IssuePhase =
  | 'template_load'
  | 'structure'
  | 'draft'
  | 'merge'
  | 'seal_input'
  | 'assemble'
  | 'seal_output'
  | 'publish';

/**
 * Ten-value closed source enum (design §19.1): which class of platform rule,
 * subsystem or trusted adapter discovered the problem. Orthogonal to phase;
 * neither templates nor Agents can extend it.
 */
export type IssueSource =
  | 'template_loader'
  | 'slot_schema'
  | 'layout_grammar'
  | 'access_control'
  | 'resource_limits'
  | 'lifecycle'
  | 'validator'
  | 'assembler'
  | 'artifact_validator'
  | 'publisher';

/**
 * Versioned issue envelope shared by every model tool and platform commit
 * (design §19.1). `code` is the stable machine contract; `message` is only a
 * readable rendering and is never parsed for decisions.
 */
export interface StructuredIssueV1 {
  version: 1;
  code: string;
  severity: 'error' | 'warning';
  phase: IssuePhase;
  source: IssueSource;
  message: string;
  primaryLocation: IssueLocation;
  relatedLocations: IssueLocation[];
  details: JsonObject;
}

/**
 * Verdict envelope (design §19.1 / F05). `incomplete` fails closed like
 * `failed`; `passed` requires no error and every required evaluator to have
 * completed. `truncated` belongs to the verdict wrapper, never an issue.
 */
export interface StructuredVerdictV1 {
  version: 1;
  status: 'passed' | 'failed' | 'incomplete';
  issues: StructuredIssueV1[];
  truncated: boolean;
  summary: { errors: number; warnings: number };
}

/** RFC 6901 JSON pointer; the empty string denotes the root of a value. */
export type JsonPointer = string;

/**
 * Text range with 0-based, end-exclusive line/column coordinates; column is
 * counted in UTF-16 code units. `end` must not precede `start`.
 */
export interface TextSpan {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

/**
 * Fixed six-variant discriminated union (design §19.2). Every variant is a
 * closed exact object — unknown kinds, missing fields and extra fields must
 * not enter a public issue projection.
 */
export type IssueLocation =
  | {
      kind: 'contract';
      pointer: JsonPointer;
    }
  | {
      kind: 'template_resource';
      resourcePath: string;
      span: TextSpan | null;
    }
  | {
      kind: 'proposal';
      clientKey: string;
      instancePath: JsonPointer;
      field: 'node' | 'typeId' | 'spec' | 'children';
      valuePointer: JsonPointer;
    }
  | {
      kind: 'slot';
      slotId: string;
      field: 'node' | 'spec' | 'content' | 'children';
      valuePointer: JsonPointer;
    }
  | {
      kind: 'artifact';
      routeId: string;
      artifactPath: string;
      valuePointer: JsonPointer;
    }
  | {
      kind: 'operation';
    };

/**
 * Task-local immutable blob reference (spec §7.2). Blobs are content-addressed
 * by canonical bytes, task-local, never deduplicated across tasks.
 */
export interface StructuredBlobRefV1 {
  version: 1;
  kind: 'generation' | 'content_revision' | 'seal_record' | 'validation';
  sha256: string;
  byteLength: number;
}

/**
 * Immutable seal delivery fact (design §17.2). References the committed
 * `{ artifactId, version }` and the `phase: create` outputs proven at Seal
 * time; never stores staging paths or annotations.
 */
export interface SealRecord {
  sealId: string;
  caseId: string;
  scaffoldId: string;
  scaffoldRevision: number;
  scaffoldTreeHash: string;
  templateId: string;
  templateVersion: string;
  snapshotHash: string;
  assemblerId: string;
  assemblerVersion: string;
  artifactVersionRef: {
    artifactId: string;
    version: number;
  };
  outputs: Array<{
    routeId: string;
    path: string;
    mediaType: string;
    byteLength: number;
    sha256: string;
  }>;
  sealedAt: string;
}

/**
 * Platform limits profile (spec §5). Seven groups of twenty-eight
 * positive-integer fields; field names and units are frozen and must not
 * change. The exact shape is reproduced verbatim from the spec. Task 2 only
 * consumes the `schema` group; later tasks consume the rest.
 */
export interface StructuredSlotLimitsV1 {
  schema: {
    maxSchemaDepth: number;
    maxSchemaNodes: number;
    maxEnumItems: number;
    maxPatternLength: number;
  };
  structure: {
    maxSlots: number;
    maxTreeDepth: number;
    maxChildrenPerSlot: number;
  };
  payload: {
    maxSpecBytesPerSlot: number;
    maxContentBytesPerSlot: number;
    maxScaffoldPayloadBytes: number;
  };
  draft: {
    maxChangedSlots: number;
    maxDraftBytes: number;
  };
  attempt: {
    maxSlotToolCallsPerAttempt: number;
    maxValidationRunsPerAttempt: number;
    maxValidatorInvocationsPerAttempt: number;
    maxAggregateValidatorCpuMsPerAttempt: number;
    maxAggregateValidatorWallClockMsPerAttempt: number;
    maxValidatorOutputBytesPerAttempt: number;
    maxAttemptWallClockMs: number;
  };
  validation: {
    maxValidators: number;
    maxValidatorInvocationsPerGate: number;
    maxAggregateValidatorCpuMsPerGate: number;
    maxAggregateValidatorWallClockMsPerGate: number;
    maxValidatorOutputBytesPerGate: number;
    maxIssuesPerRun: number;
  };
  output: {
    maxArtifactFiles: number;
    maxArtifactBytesPerFile: number;
    maxTotalArtifactBytes: number;
  };
}

/**
 * Optional TaskWorkspace structured-slots summary (spec §14 / design I01).
 * Absent for basic tasks; never embeds content, the full tree, Grants or
 * private Drafts.
 */
export interface StructuredSlotsSummaryV1 {
  version: 1;
  mode: 'structured_slots';
  scaffoldId: string | null;
  generationId: string | null;
  contentRevision: number | null;
  structureStatus: 'none' | 'active';
  sealStatus: 'unsealed' | 'sealed';
  visibleSlotCount: number;
  filledSlotCount: number;
  issueSummary: { errors: number; warnings: number };
}

/**
 * Closed ten-value slot capability enum v1 (spec §3.2 / design §10.2 D01).
 * The runtime never accepts template-custom capability names. Reproduced here
 * (shared, type-only) so Grants carry a stable, versioned capability type.
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

/** Base of every slot session grant (design §10.3). */
export interface SlotSessionGrantBaseV1 {
  grantId: string;
  kind: 'structure' | 'fill' | 'seal';
  /** Production case identity; in Forge Core this is the Task id (design §2.5). */
  caseId: string;
  turnId: string;
  agentId: string;
  snapshotHash: string;
  capabilities: SlotCapabilityV1[];
}

/** Structure grant binds only the frozen snapshot + its private Proposal. */
export interface StructureSessionGrantV1 extends SlotSessionGrantBaseV1 {
  kind: 'structure';
  proposalId: string;
}

/** Fill grant binds the active scaffold/revision + resolved slot scope + Draft. */
export interface FillSessionGrantV1 extends SlotSessionGrantBaseV1 {
  kind: 'fill';
  accessProfileId: string;
  scaffoldId: string;
  baseRevision: number;
  readableSlotIds: string[];
  writableSlotIds: string[];
  draftId: string;
}

/** Seal grant binds the scaffold/revision; writes are always empty. */
export interface SealSessionGrantV1 extends SlotSessionGrantBaseV1 {
  kind: 'seal';
  accessProfileId: string;
  scaffoldId: string;
  baseRevision: number;
  readableSlotIds: string[];
  writableSlotIds: [];
  draftId: null;
}

/** Discriminated slot session grant (design §10.3 / spec §8.2). */
export type SlotSessionGrantV1 =
  | StructureSessionGrantV1
  | FillSessionGrantV1
  | SealSessionGrantV1;

/**
 * Authorized projection subject (spec §14). The Agent branch carries its own
 * Grant; the local single-user UI/API branch is the built-in `task_owner` full
 * read-only audit view. `task_owner` is not a template AccessProfile and is
 * never inferred by unioning Agent profiles.
 */
export type ProjectionSubjectV1 =
  | { kind: 'agent'; grant: SlotSessionGrantV1 }
  | { kind: 'task_owner' };

/**
 * Signed, bound pagination cursor for the slot tree outline (spec §14 /
 * design §25.13). The payload binds the scaffold generation, content revision,
 * the authorized projection identity and the last emitted document-order key.
 * `signature` is an HMAC over the canonical payload using a task-local,
 * in-memory secret that is never written to a snapshot or event.
 */
export interface StructuredSlotTreeCursorV1 {
  version: 1;
  generationId: string;
  revision: number;
  projectionHash: string;
  lastDocumentKey: string | null;
  orderingVersion: number;
  signature: string;
}
