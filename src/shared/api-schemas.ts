/**
 * Read-only TypeBox schemas for the Phase B JSON API payloads (plan Phase B
 * Task 5). The frozen interfaces in `contracts.ts` stay the source of truth;
 * these schemas mirror them so the server can reject request bodies that fall
 * outside the declared shape (unknown fields included) and the HttpGateway
 * can decode success/error payloads before handing them to pages.
 *
 * Platform-generic: no business vocabulary (iron rule 1).
 */
import { Type, type TSchema } from 'typebox';
import {
  AUTHORITATIVE_BLOB_KINDS_V2,
  QUESTION_VERSION_TOKEN_PATTERN,
  UUID_V4_PATTERN,
} from './authoritative-review-v2';

/* ------------------------------ request bodies ------------------------------ */

export const createTaskBodySchema = Type.Object(
  {
    templateId: Type.String({ minLength: 1 }),
    name: Type.String(),
    input: Type.Record(Type.String(), Type.String()),
  },
  { additionalProperties: false },
);

export const answerBodySchema = Type.Union(
  [
    // Legacy plain answer (agent_request source) or a text-only reply.
    Type.Object({ answer: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    // Structured decision for a progress_guard request (spec §11.5):
    // `continue`/`accept` carry guidance text; `stop` needs none.
    Type.Object(
      {
        decision: Type.Union([
          Type.Literal('continue'),
          Type.Literal('accept'),
          Type.Literal('stop'),
        ]),
        text: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  ],
  // `text` defaults to '' when omitted; the scheduler rejects empty guidance
  // for continue/accept as a public INVALID_TRANSITION.
);

/* ------------------------------ error envelope ------------------------------ */

export const publicErrorSchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  location: Type.Union([Type.String(), Type.Null()]),
  action: Type.Union([Type.String(), Type.Null()]),
});

export const errorBodySchema = Type.Object({
  error: publicErrorSchema,
});

/* ----------------------------- shared sub-shapes ---------------------------- */

const inputFieldSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  kind: Type.Union([Type.Literal('text'), Type.Literal('textarea')]),
  required: Type.Boolean(),
  description: Type.String(),
});

const skillSummarySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
});

const agentSummarySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  model: Type.String(),
  skills: Type.Array(skillSummarySchema),
});

const templateRouteSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
  kind: Type.Union([Type.Literal('message'), Type.Literal('artifact')]),
  label: Type.String(),
});

/* ------------------------------ response shapes ----------------------------- */

export const templateSummarySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  version: Type.String(),
  agentCount: Type.Number(),
  status: Type.Union([Type.Literal('valid'), Type.Literal('invalid_using_cache')]),
  updatedAt: Type.String(),
});

export const templateSummaryListSchema = Type.Array(templateSummarySchema);

export const templateDetailSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  version: Type.String(),
  agentCount: Type.Number(),
  status: Type.Union([Type.Literal('valid'), Type.Literal('invalid_using_cache')]),
  updatedAt: Type.String(),
  inputFields: Type.Array(inputFieldSchema),
  agents: Type.Array(agentSummarySchema),
  routes: Type.Array(templateRouteSchema),
  finalOutput: Type.Object({
    name: Type.String(),
    format: Type.Union([Type.Literal('markdown'), Type.Literal('text')]),
    submitters: Type.Array(Type.String()),
  }),
});

export const recoveryRecipeKeyV2Schema = Type.Union([
  Type.Literal('retry_system_command'),
  Type.Literal('restart_map_review_cycle'),
  Type.Literal('restart_content_review_cycle'),
  Type.Literal('rebuild_missing_work'),
]);

export const taskSummarySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  templateId: Type.String(),
  templateName: Type.String(),
  status: Type.Union([
    Type.Literal('draft'),
    Type.Literal('ready'),
    Type.Literal('running'),
    Type.Literal('waiting_human'),
    Type.Literal('retryable_failure'),
    Type.Literal('interrupted'),
    Type.Literal('completed'),
    Type.Literal('stopped'),
    Type.Literal('corrupt'),
    Type.Literal('incompatible'),
    // v2 permanent failure (spec §10.3): projected only by
    // `structured_task_failed_v2`; v1 events never produce it.
    Type.Literal('failed'),
  ]),
  currentAgentName: Type.Union([Type.String(), Type.Null()]),
  latestVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  updatedAt: Type.String(),
  diagnostic: Type.Union([Type.String(), Type.Null()]),
  // Frozen-snapshot protocol discriminator (spec §4.1/§10.5): required on
  // every summary so the client never guesses from status/template/events.
  structuredProtocol: Type.Union([
    Type.Literal('none'),
    Type.Literal('v1'),
    Type.Literal('v2'),
  ]),
  // B-M6: the bounded failed-task recovery summary (spec §10.3.1), present
  // ONLY on v2 tasks projected `failed` (optional on the wire so v1/basic
  // summaries decode unchanged; the schema fails loud on drift). The member
  // shape mirrors failedTaskRecoverySummaryV2Schema exactly.
  failedRecovery: Type.Optional(
    Type.Object(
      {
        failureCode: Type.String({ minLength: 1 }),
        failedSequence: Type.Integer({ minimum: 0 }),
        legalRecipes: Type.Array(
          Type.Object(
            {
              recipeKey: recoveryRecipeKeyV2Schema,
              track: Type.Union([Type.Literal('map'), Type.Literal('content'), Type.Null()]),
            },
            { additionalProperties: false },
          ),
        ),
        reopenAllowed: Type.Boolean(),
        cloneFallback: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
});

export const taskSummaryListSchema = Type.Array(taskSummarySchema);

const workspaceNodeSchema = Type.Object({
  id: Type.String(),
  sequence: Type.Integer(),
  agentId: Type.String(),
  kind: Type.Union([
    Type.Literal('input'),
    Type.Literal('result'),
    Type.Literal('human_request'),
    Type.Literal('human_answer'),
    Type.Literal('skill'),
  ]),
  title: Type.String(),
  body: Type.String(),
  status: Type.Union([
    Type.Literal('confirmed'),
    Type.Literal('active'),
    Type.Literal('failed'),
  ]),
  attemptCount: Type.Integer({ minimum: 1 }),
  inputVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  // Optional: projections from before Phase E never carried the field.
  turnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // True when `pending_inputs_superseded` voided this input (spec §11.2).
  superseded: Type.Optional(Type.Boolean()),
});

const workspaceRouteSchema = Type.Object({
  id: Type.String(),
  sequence: Type.Integer(),
  fromNodeId: Type.String(),
  toNodeId: Type.String(),
  kind: Type.Union([Type.Literal('message'), Type.Literal('artifact')]),
  label: Type.String(),
});

/**
 * Memory-only live preview of the running Turn (plan C realtime
 * streaming). Optional AND nullable on the wire: workspaces without a Turn
 * in flight carry no buffer, and older servers never send the field.
 */
const liveToolCallSchema = Type.Object({
  name: Type.String(),
  state: Type.Union([Type.Literal('running'), Type.Literal('done')]),
});

const liveTurnSchema = Type.Object({
  agentId: Type.String(),
  turnId: Type.String(),
  status: Type.Literal('running'),
  text: Type.String(),
  tools: Type.Array(liveToolCallSchema),
  updatedAt: Type.String(),
});

/** Optional TaskWorkspace structured summary (spec §14 / I01). */
export const structuredSlotsSummarySchema = Type.Object(
  {
    version: Type.Literal(1),
    mode: Type.Literal('structured_slots'),
    scaffoldId: Type.Union([Type.String(), Type.Null()]),
    generationId: Type.Union([Type.String(), Type.Null()]),
    contentRevision: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    structureStatus: Type.Union([Type.Literal('none'), Type.Literal('active')]),
    sealStatus: Type.Union([Type.Literal('unsealed'), Type.Literal('sealed')]),
    visibleSlotCount: Type.Integer({ minimum: 0 }),
    filledSlotCount: Type.Integer({ minimum: 0 }),
    issueSummary: Type.Object(
      {
        errors: Type.Integer({ minimum: 0 }),
        warnings: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/* ------------------- authoritative per-slot review v2 (spec 2026-08-14) ------------------- */

/** Closed v2 blob-kind registry (spec §7.1) — explicit literal union. */
export const authoritativeBlobKindV2Schema = Type.Union(
  AUTHORITATIVE_BLOB_KINDS_V2.map((kind) => Type.Literal(kind)),
);

/** Lowercase SHA-256 digest (`digest` is never case-normalized, spec §7.1). */
export const sha256HexSchema = Type.String({ pattern: '^[0-9a-f]{64}$' });

/** UUID v4 operation id (spec §10.5/§10.3.1). */
export const uuidV4Schema = Type.String({ pattern: UUID_V4_PATTERN });

/** Opaque unpadded base64url question-version token, case-sensitive (§10.6). */
export const questionVersionTokenSchema = Type.String({ pattern: QUESTION_VERSION_TOKEN_PATTERN });

export const blobRefV2Schema = Type.Object(
  {
    kind: authoritativeBlobKindV2Schema,
    digest: sha256HexSchema,
    byteLength: Type.Integer({ minimum: 0 }),
    mediaType: Type.Union([
      Type.Literal('application/json'),
      Type.Literal('text/markdown'),
      Type.Literal('text/plain'),
    ]),
    schemaVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const artifactFileSchema = Type.Object(
  { name: Type.String(), extract: Type.String(), content: Type.String() },
  { additionalProperties: false },
);

const artifactVersionCommon = {
  id: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  files: Type.Array(artifactFileSchema),
  createdAt: Type.String(),
  final: Type.Boolean(),
};

/** Exact public authority union: legacy v1 bytes or System-Seal v2 refs. */
export const artifactVersionSchema = Type.Union([
  Type.Object(
    { ...artifactVersionCommon, protocolVersion: Type.Optional(Type.Literal(1)), sourceNodeId: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...artifactVersionCommon,
      protocolVersion: Type.Literal(2),
      producerWorkItemId: Type.String({ minLength: 1 }),
      sealRecordRef: blobRefV2Schema,
      artifactRef: blobRefV2Schema,
      custodyRef: blobRefV2Schema,
      templateSnapshotHash: sha256HexSchema,
      deliveryRef: blobRefV2Schema,
    },
    { additionalProperties: false },
  ),
]);

/** Discriminated artifact provenance (spec §13.5.1). */
export const artifactProvenanceV2Schema = Type.Union([
  Type.Object(
    {
      producerKind: Type.Literal('agent'),
      sourceNodeId: Type.String({ minLength: 1 }),
      producerAgentId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      producerKind: Type.Literal('system'),
      producerWorkItemId: Type.String({ minLength: 1 }),
      sealRecordRef: blobRefV2Schema,
      artifactRef: blobRefV2Schema,
      custodyRef: blobRefV2Schema,
    },
    { additionalProperties: false },
  ),
]);

/** Profile snapshot bootstrap identity (spec §4.3). */
export const authoritativeReviewProfileSnapshotV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    profileIdentity: Type.String({ minLength: 1 }),
    profileVersion: Type.Integer({ minimum: 1 }),
    qualificationState: Type.Union([
      Type.Literal('test_only'),
      Type.Literal('provisional'),
      Type.Literal('final'),
    ]),
    profileDigest: sha256HexSchema,
    abi: Type.Object(
      {
        validatorAbi: Type.Literal('forge-validator/v2'),
        assemblerAbi: Type.Literal('forge-assembler/v2'),
        profileAbi: Type.Literal('forge-authoritative-review/v1'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Reversible, non-event execution eligibility (spec §4.3). */
export const authoritativeReviewExecutionEligibilityV1Schema = Type.Union([
  Type.Object(
    {
      state: Type.Literal('eligible'),
      frozenProfileDigest: sha256HexSchema,
      currentProfileDigest: sha256HexSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('blocked'),
      reason: Type.Union([
        Type.Literal('base_capability_disabled'),
        Type.Literal('authoritative_capability_disabled'),
        Type.Literal('profile_digest_mismatch'),
        Type.Literal('required_abi_unavailable'),
      ]),
      frozenProfileDigest: sha256HexSchema,
      currentProfileDigest: Type.Union([sha256HexSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
]);

/** Closed WorkItem execution kinds (spec §10.1). */
export const workItemKindV2Schema = Type.Union([
  Type.Literal('agent_assignment'),
  Type.Literal('system_map_finalize'),
  Type.Literal('system_generation_finalize'),
  Type.Literal('system_repair_finalize'),
  Type.Literal('system_migration_validation_batch'),
  Type.Literal('system_review_settlement'),
  Type.Literal('system_seal'),
]);

/** The pending v2 human question (spec §10.6). */
export const pendingQuestionV2Schema = Type.Object(
  {
    questionId: Type.String({ minLength: 1 }),
    questionDigest: sha256HexSchema,
    questionVersion: questionVersionTokenSchema,
    source: Type.Union([Type.Literal('agent_request'), Type.Literal('progress_guard')]),
    text: Type.String(),
  },
  { additionalProperties: false },
);

/** Answer mutation v2 (spec §10.6): question identity + operation on EVERY branch. */
const answerIdentityV2Fields = {
  questionId: Type.String({ minLength: 1 }),
  questionVersion: questionVersionTokenSchema,
  operationId: Type.String({ minLength: 1 }),
};
export const answerBodyV2Schema = Type.Union([
  Type.Object(
    { ...answerIdentityV2Fields, answer: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...answerIdentityV2Fields, decision: Type.Literal('continue'), text: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...answerIdentityV2Fields, decision: Type.Literal('accept'), text: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object({ ...answerIdentityV2Fields, decision: Type.Literal('stop') }, { additionalProperties: false }),
]);

/** Fenced delete mutation (spec §10.5): UUID operation + 1..500 CODE-POINT reason. */
export const deleteTaskBodyV2Schema = Type.Object(
  {
    operationId: uuidV4Schema,
    // maxLength is a UTF-16 backstop ONLY (1000 units cover 500 astral code
    // points); the route enforces the authoritative 1..500 CODE-POINT bound
    // and trims whitespace-only reasons (B-M5 closes the Task 2 minor).
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

export const deleteTaskResultV2Schema = Type.Object(
  {
    operationId: uuidV4Schema,
    state: Type.Union([Type.Literal('detached'), Type.Literal('purged')]),
  },
  { additionalProperties: false },
);


const reopenIdentityV2Fields = {
  expectedLastSequence: Type.Integer({ minimum: 0 }),
  operationId: uuidV4Schema,
  // maxLength is a UTF-16 backstop (2000 units cover 1000 astral code
  // points); the route enforces the authoritative 1..1000 CODE-POINT bound
  // and trims whitespace-only reasons (B-M5).
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
};

/**
 * Reopen mutation (spec §10.3.1). The wire schema is STRICTLY narrower than
 * the flat spec interface: it enforces the exact recipe/track pairing of the
 * §10.3.1 policy table (retry_system_command keeps track null; each restart
 * cycle names its own track; rebuild_missing_work accepts the stored track
 * or null). Cross-recipe bodies fail before reaching the service.
 */
export const reopenFailedRequestV2Schema = Type.Union([
  Type.Object(
    { ...reopenIdentityV2Fields, recipeKey: Type.Literal('retry_system_command'), track: Type.Null() },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...reopenIdentityV2Fields, recipeKey: Type.Literal('restart_map_review_cycle'), track: Type.Literal('map') },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...reopenIdentityV2Fields, recipeKey: Type.Literal('restart_content_review_cycle'), track: Type.Literal('content') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...reopenIdentityV2Fields,
      recipeKey: Type.Literal('rebuild_missing_work'),
      track: Type.Union([Type.Literal('map'), Type.Literal('content'), Type.Null()]),
    },
    { additionalProperties: false },
  ),
]);

/** Canonical recovery payload stored with structured_task_failed_v2 (§10.3.1). */
export const failureRecoveryPayloadV2Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('retry_system_command'),
      failedWorkItemId: Type.String({ minLength: 1 }),
      failedCommandId: Type.String({ minLength: 1 }),
      failedLeaseEpoch: Type.Integer({ minimum: 0 }),
      terminalEventId: Type.String({ minLength: 1 }),
      terminalCommitId: Type.String({ minLength: 1 }),
      authorityBaseRef: blobRefV2Schema,
      systemKind: Type.Union([
        Type.Literal('system_map_finalize'),
        Type.Literal('system_generation_finalize'),
        Type.Literal('system_repair_finalize'),
        Type.Literal('system_migration_validation_batch'),
        Type.Literal('system_review_settlement'),
        Type.Literal('system_seal'),
      ]),
      systemPayloadRef: blobRefV2Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('restart_review_cycle'),
      track: Type.Union([Type.Literal('map'), Type.Literal('content')]),
      failedWorkItemId: Type.String({ minLength: 1 }),
      failedAttemptOrCommandId: Type.String({ minLength: 1 }),
      failedLeaseEpoch: Type.Integer({ minimum: 0 }),
      terminalEventId: Type.String({ minLength: 1 }),
      terminalCommitId: Type.String({ minLength: 1 }),
      authorityBaseRef: blobRefV2Schema,
      rejectedSubjectRef: blobRefV2Schema,
      findingSetRef: blobRefV2Schema,
      failedCycleOrdinal: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('rebuild_missing_work'),
      predecessorResultRef: blobRefV2Schema,
      expectedSuccessorKind: workItemKindV2Schema,
      expectedSuccessorPayloadRef: blobRefV2Schema,
      authorityBaseRef: blobRefV2Schema,
      grantSpecInputRef: Type.Union([blobRefV2Schema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
]);

/** One available round-budget override (spec §10.3.1). */
export const roundBudgetOverrideV2Schema = Type.Object(
  {
    overrideId: Type.String({ minLength: 1 }),
    failedEventId: Type.String({ minLength: 1 }),
    track: Type.Union([Type.Literal('map'), Type.Literal('content')]),
    repairLineageId: Type.String({ minLength: 1 }),
    initialRepairPlanRef: blobRefV2Schema,
    currentAuthorizedRepairPlanRef: blobRefV2Schema,
    predecessorOverrideRef: Type.Union([blobRefV2Schema, Type.Null()]),
    transferOrdinal: Type.Integer({ minimum: 0 }),
    operationId: uuidV4Schema,
    operatorId: Type.String({ minLength: 1 }),
    reasonDigest: sha256HexSchema,
    state: Type.Literal('available'),
  },
  { additionalProperties: false },
);

/** Bounded owner-facing recovery summary (spec §10.3.1) — never private refs. */
export const failedTaskRecoverySummaryV2Schema = Type.Object(
  {
    failureCode: Type.String({ minLength: 1 }),
    failedSequence: Type.Integer({ minimum: 0 }),
    legalRecipes: Type.Array(
      Type.Object(
        {
          recipeKey: recoveryRecipeKeyV2Schema,
          track: Type.Union([Type.Literal('map'), Type.Literal('content'), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
    reopenAllowed: Type.Boolean(),
    cloneFallback: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Authenticated opaque snapshot cursor (spec §14.2). */
export const snapshotCursorV2Schema = Type.Object(
  {
    version: Type.Literal(2),
    keyId: Type.String({ minLength: 1 }),
    token: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Factory for the stable cursor-paginated collection page shape (§14.2). */
export function collectionPageV2Schema(items: TSchema): TSchema {
  return Type.Object(
    {
      items: Type.Array(items),
      nextCursor: Type.Union([snapshotCursorV2Schema, Type.Null()]),
    },
    { additionalProperties: false },
  );
}

/** Public Map identity summary (design §10.1). */
export const authoritativeMapSummaryV2Schema = Type.Object(
  {
    mapId: Type.String({ minLength: 1 }),
    mapRevision: Type.Integer({ minimum: 1 }),
    mapSemanticDigest: sha256HexSchema,
    supersedesMapId: Type.Union([Type.String(), Type.Null()]),
    mapSnapshotRef: Type.Union([blobRefV2Schema, Type.Null()]),
    mapReviewBundleRef: Type.Union([blobRefV2Schema, Type.Null()]),
    candidateRef: Type.Union([blobRefV2Schema, Type.Null()]),
  },
  { additionalProperties: false },
);

/**
 * Relationship-layer summary: zero relations is a valid neutral state. The
 * discriminated branches enforce the platform rule that a disabled policy
 * can never coexist with relations (design §9) — a truthful projection can
 * only ever produce `mode: 'disabled'` with zero relations.
 */
export const authoritativeRelationSummaryV2Schema = Type.Union([
  Type.Object(
    { mode: Type.Literal('disabled'), relationCount: Type.Literal(0) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal('optional'),
      relationCount: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
]);

/** Derived slot-review state counts (design §11.6). */
export const authoritativeReviewSummaryV2Schema = Type.Object(
  {
    version: Type.Literal(2),
    mapCycleOrdinal: Type.Integer({ minimum: 0 }),
    contentCycleOrdinal: Type.Integer({ minimum: 0 }),
    pendingCount: Type.Integer({ minimum: 0 }),
    passCount: Type.Integer({ minimum: 0 }),
    rejectCount: Type.Integer({ minimum: 0 }),
    staleCount: Type.Integer({ minimum: 0 }),
    openBlockingFindingCount: Type.Integer({ minimum: 0 }),
    relation: authoritativeRelationSummaryV2Schema,
  },
  { additionalProperties: false },
);

/** Public Finding summary (design §11.8). */
export const authoritativeFindingSummaryV2Schema = Type.Object(
  {
    findingId: Type.String({ minLength: 1 }),
    reviewContext: Type.Object(
      {
        kind: Type.Union([Type.Literal('map'), Type.Literal('content')]),
        roundId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    primaryLocation: Type.Object(
      {
        kind: Type.Union([
          Type.Literal('slot'),
          Type.Literal('relation'),
          Type.Literal('map_node'),
          Type.Literal('map'),
        ]),
        id: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    defectClass: Type.Union([Type.Literal('content'), Type.Literal('map'), Type.Literal('mixed')]),
    severity: Type.Union([Type.Literal('blocking'), Type.Literal('advisory')]),
    source: Type.Union([Type.Literal('reviewer'), Type.Literal('system_validator')]),
    status: Type.Union([
      Type.Literal('open'),
      Type.Literal('repair_planned'),
      Type.Literal('repair_dispatched'),
      Type.Literal('addressed'),
      Type.Literal('verified_closed'),
    ]),
  },
  { additionalProperties: false },
);

/** One review round row of the paginated rounds views (design §11.3/§11.10). */
export const authoritativeReviewRoundSummaryV2Schema = Type.Object(
  {
    reviewRoundId: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal('map'), Type.Literal('content')]),
    state: Type.Union([
      Type.Literal('planned'),
      Type.Literal('reviewing_batches'),
      Type.Literal('whole_map_observation'),
      Type.Literal('whole_tree_observation'),
      Type.Literal('completed'),
      Type.Literal('settled'),
    ]),
  },
  { additionalProperties: false },
);

/** Findings collection page bound to the item schema above. */
export const authoritativeFindingCollectionPageV2Schema = collectionPageV2Schema(
  authoritativeFindingSummaryV2Schema,
);

/** Seal readiness projection (design §16.2) — never a model verdict. */
export const authoritativeSealReadinessSummaryV2Schema = Type.Object(
  {
    readiness: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
    unmetConditionCount: Type.Integer({ minimum: 0 }),
    sealed: Type.Boolean(),
    sealRecordRef: Type.Union([blobRefV2Schema, Type.Null()]),
  },
  { additionalProperties: false },
);

/* ------------------- §14.1 tree/locate/map/candidate/slot/relation/seal detail schemas ------------------- */

const slotReviewStateV2Schema = Type.Object(
  {
    mapPreReview: Type.Union([Type.Literal('pending'), Type.Literal('pass'), Type.Literal('reject')]),
    content: Type.Union([Type.Literal('pending'), Type.Literal('pass'), Type.Literal('reject'), Type.Literal('stale')]),
  },
  { additionalProperties: false },
);

/** One child row of a non-recursive tree parent page (spec §14.2). */
export const authoritativeTreeEntryV2Schema = Type.Object(
  {
    slotId: Type.String({ minLength: 1 }),
    slotType: Type.String({ minLength: 1 }),
    documentOrder: Type.Integer({ minimum: 0 }),
    siblingOrder: Type.Integer({ minimum: 0 }),
    contentBearing: Type.Boolean(),
    childCount: Type.Integer({ minimum: 0 }),
    review: slotReviewStateV2Schema,
  },
  { additionalProperties: false },
);

export const authoritativeTreePageV2Schema = Type.Object(
  {
    parentId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    hasMoreChildren: Type.Boolean(),
    items: Type.Array(authoritativeTreeEntryV2Schema),
    nextCursor: Type.Union([snapshotCursorV2Schema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const authoritativeLocateAncestorV2Schema = Type.Object(
  {
    slotId: Type.String({ minLength: 1 }),
    seekCursor: snapshotCursorV2Schema,
  },
  { additionalProperties: false },
);

export const authoritativeLocateResultV2Schema = Type.Object(
  {
    target: authoritativeTreeEntryV2Schema,
    ancestors: Type.Array(authoritativeLocateAncestorV2Schema),
  },
  { additionalProperties: false },
);

export const authoritativeMapDetailV2Schema = Type.Object(
  {
    // Empty id/revision/digest represent the no-active-Map state; refs are null.
    mapId: Type.String(),
    mapRevision: Type.Integer({ minimum: 0 }),
    mapSemanticDigest: sha256HexSchema,
    supersedesMapId: Type.Union([Type.String(), Type.Null()]),
    mapSnapshotRef: Type.Union([blobRefV2Schema, Type.Null()]),
    mapReviewBundleRef: Type.Union([blobRefV2Schema, Type.Null()]),
    candidateRef: Type.Union([blobRefV2Schema, Type.Null()]),
    rootSlotId: Type.Union([Type.String(), Type.Null()]),
    nodeCount: Type.Integer({ minimum: 0 }),
    relationCount: Type.Integer({ minimum: 0 }),
    relation: authoritativeRelationSummaryV2Schema,
  },
  { additionalProperties: false },
);

export const authoritativeCandidateDetailV2Schema = Type.Object(
  {
    candidateId: Type.Union([Type.String(), Type.Null()]),
    candidateRef: Type.Union([blobRefV2Schema, Type.Null()]),
    baseMapId: Type.Union([Type.String(), Type.Null()]),
    buildId: Type.Union([Type.String(), Type.Null()]),
    nodeCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    relationCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const authoritativeSlotReviewDetailV2Schema = Type.Object(
  {
    slotId: Type.String({ minLength: 1 }),
    slotType: Type.String({ minLength: 1 }),
    parentSlotId: Type.Union([Type.String(), Type.Null()]),
    documentOrder: Type.Integer({ minimum: 0 }),
    siblingOrder: Type.Integer({ minimum: 0 }),
    contentBearing: Type.Boolean(),
    review: slotReviewStateV2Schema,
    openBlockingFindingIds: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const authoritativeRelationReviewDetailV2Schema = Type.Object(
  {
    relationId: Type.String({ minLength: 1 }),
    typeId: Type.String({ minLength: 1 }),
    fromSlotId: Type.String({ minLength: 1 }),
    toSlotId: Type.String({ minLength: 1 }),
    review: Type.Union([
      Type.Literal('pending'),
      Type.Literal('satisfied'),
      Type.Literal('violated'),
      Type.Literal('stale'),
    ]),
    openBlockingFindingIds: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const authoritativeSealReadinessConditionV2Schema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    detail: Type.String({ minLength: 1 }),
    satisfied: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const authoritativeSealReadinessDetailV2Schema = Type.Object(
  {
    readiness: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
    unmetConditionCount: Type.Integer({ minimum: 0 }),
    sealed: Type.Boolean(),
    sealRecordRef: Type.Union([blobRefV2Schema, Type.Null()]),
    conditions: Type.Array(authoritativeSealReadinessConditionV2Schema),
  },
  { additionalProperties: false },
);

/** Map review rounds collection page (review/map-rounds). */
export const authoritativeMapRoundCollectionPageV2Schema = collectionPageV2Schema(
  authoritativeReviewRoundSummaryV2Schema,
);

/** All review rounds collection page (review/rounds). */
export const authoritativeReviewRoundCollectionPageV2Schema = collectionPageV2Schema(
  authoritativeReviewRoundSummaryV2Schema,
);

/** Immutable v2 SealRecord identity (design §16.3). */
export const sealRecordV2Schema = Type.Object(
  {
    taskId: Type.String({ minLength: 1 }),
    mapRef: blobRefV2Schema,
    mapSemanticDigest: sha256HexSchema,
    mapReviewBundleRef: blobRefV2Schema,
    contentRevisionManifestRef: blobRefV2Schema,
    contentRootDigest: sha256HexSchema,
    reviewBundleRef: blobRefV2Schema,
    sealValidationBundleRef: blobRefV2Schema,
    templateSnapshotHash: sha256HexSchema,
    assemblerDigest: sha256HexSchema,
    artifactRef: blobRefV2Schema,
    artifactDigest: sha256HexSchema,
  },
  { additionalProperties: false },
);

/** System artifact delivery (spec §13.5) — deliberately no artifactVersion. */
export const systemArtifactDeliveryV2Schema = Type.Object(
  {
    deliveryId: Type.String({ minLength: 1 }),
    producer: Type.Literal('system:structured_seal'),
    sealRecordRef: blobRefV2Schema,
    sealRecordDigest: sha256HexSchema,
    artifactId: Type.String({ minLength: 1 }),
    artifactRef: blobRefV2Schema,
    artifactDigest: sha256HexSchema,
    custodyRef: blobRefV2Schema,
    custodyDigest: sha256HexSchema,
    submitterWorkItemId: Type.String({ minLength: 1 }),
    submitterAgentId: Type.String({ minLength: 1 }),
    templateSnapshotHash: sha256HexSchema,
  },
  { additionalProperties: false },
);

/** Versioned v2 workspace summary (spec §14/§19.2). */
export const authoritativeReviewWorkspaceV2Schema = Type.Object(
  {
    version: Type.Literal(2),
    executionEligibility: authoritativeReviewExecutionEligibilityV1Schema,
    pendingQuestion: Type.Union([pendingQuestionV2Schema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const taskWorkspaceSchema = Type.Object({
  task: taskSummarySchema,
  frozenInput: Type.Record(Type.String(), Type.String()),
  templateVersion: Type.String(),
  agents: Type.Array(agentSummarySchema),
  declaredRoutes: Type.Array(templateRouteSchema),
  nodes: Type.Array(workspaceNodeSchema),
  executedRoutes: Type.Array(workspaceRouteSchema),
  artifacts: Type.Array(artifactVersionSchema),
  pendingHumanQuestion: Type.Union([Type.String(), Type.Null()]),
  pendingHumanSource: Type.Union([
    Type.Literal('progress_guard'),
    Type.Literal('agent_request'),
    Type.Null(),
  ]),
  activeTurn: Type.Optional(Type.Union([liveTurnSchema, Type.Null()])),
  structuredSlots: Type.Optional(structuredSlotsSummarySchema),
  // Versioned v2 workspace summary (spec §14/§19.2): v2 tasks carry this
  // instead of the v1 structuredSlots summary. Optional on the wire so v1
  // and basic workspaces decode unchanged.
  authoritativeReview: Type.Optional(authoritativeReviewWorkspaceV2Schema),
});

export const healthSchema = Type.Object({
  ok: Type.Literal(true),
  service: Type.String(),
  mode: Type.String(),
});

/* --------------------------- phase E response shapes ------------------------- */

/** One observable step of a model Turn (display-only, never gates). */
export const traceEntrySchema = Type.Union([
  Type.Object({
    kind: Type.Literal('tool_call'),
    toolName: Type.String(),
    params: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({ kind: Type.Literal('tool_result'), toolName: Type.String(), text: Type.String() }),
  Type.Object({ kind: Type.Literal('text'), text: Type.String() }),
]);

/**
 * Display-only final phase summary of one Turn (plan 2026-08-04, spec
 * §7.4). Optional on the wire: historical traces without it stay legal.
 */
export const turnTracePhaseSchema = Type.Object({
  state: Type.Union([
    Type.Literal('production'),
    Type.Literal('production_complete'),
    Type.Literal('dispatching'),
    Type.Literal('dispatched'),
    Type.Literal('waiting_human'),
    Type.Literal('failed'),
  ]),
  dispatchAction: Type.Union([
    Type.Literal('send_message'),
    Type.Literal('publish_artifact'),
    Type.Literal('forward_input_version'),
    Type.Literal('submit_final_artifact'),
    Type.Literal('request_human_input'),
    Type.Null(),
  ]),
  target: Type.Union([Type.String(), Type.Null()]),
  message: Type.Union([Type.String(), Type.Null()]),
});

export const turnTraceSchema = Type.Object({
  turnId: Type.String(),
  phase: Type.Optional(turnTracePhaseSchema),
  entries: Type.Array(traceEntrySchema),
});

export const skillContentSchema = Type.Object({
  skillId: Type.String(),
  content: Type.String(),
  versionHash: Type.String(),
});

/* ------------------- structured slots read-only API (spec §14) ------------------- */

/** Signed, bound pagination cursor (design §25.13 / Task 10). */
export const structuredSlotTreeCursorSchema = Type.Object(
  {
    version: Type.Literal(1),
    generationId: Type.String(),
    revision: Type.Integer({ minimum: 0 }),
    projectionHash: Type.String(),
    lastDocumentKey: Type.Union([Type.String(), Type.Null()]),
    orderingVersion: Type.Integer(),
    signature: Type.String(),
  },
  { additionalProperties: false },
);

/** The ten closed issue phases (design §19.1). */
const issuePhaseSchema = Type.Union([
  Type.Literal('template_load'),
  Type.Literal('structure'),
  Type.Literal('draft'),
  Type.Literal('merge'),
  Type.Literal('seal_input'),
  Type.Literal('assemble'),
  Type.Literal('seal_output'),
  Type.Literal('publish'),
]);

/** The ten closed issue sources (design §19.1). */
const issueSourceSchema = Type.Union([
  Type.Literal('template_loader'),
  Type.Literal('slot_schema'),
  Type.Literal('layout_grammar'),
  Type.Literal('access_control'),
  Type.Literal('resource_limits'),
  Type.Literal('lifecycle'),
  Type.Literal('validator'),
  Type.Literal('assembler'),
  Type.Literal('artifact_validator'),
  Type.Literal('publisher'),
]);

const textSpanSchema = Type.Object(
  {
    start: Type.Object(
      { line: Type.Integer({ minimum: 0 }), column: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
    end: Type.Object(
      { line: Type.Integer({ minimum: 0 }), column: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Closed six-variant IssueLocation union (design §19.2). */
const issueLocationSchema = Type.Union([
  Type.Object({ kind: Type.Literal('contract'), pointer: Type.String() }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('template_resource'), resourcePath: Type.String(), span: Type.Union([textSpanSchema, Type.Null()]) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('proposal'),
      clientKey: Type.String(),
      instancePath: Type.String(),
      field: Type.Union([Type.Literal('node'), Type.Literal('typeId'), Type.Literal('spec'), Type.Literal('children')]),
      valuePointer: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('slot'),
      slotId: Type.String(),
      field: Type.Union([Type.Literal('node'), Type.Literal('spec'), Type.Literal('content'), Type.Literal('children')]),
      valuePointer: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('artifact'), routeId: Type.String(), artifactPath: Type.String(), valuePointer: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('operation') }, { additionalProperties: false }),
]);

export const structuredIssueSchema = Type.Object(
  {
    version: Type.Literal(1),
    code: Type.String(),
    severity: Type.Union([Type.Literal('error'), Type.Literal('warning')]),
    phase: issuePhaseSchema,
    source: issueSourceSchema,
    message: Type.String(),
    primaryLocation: issueLocationSchema,
    relatedLocations: Type.Array(issueLocationSchema),
    details: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Paged owner-visible issues. */
export const structuredIssuePageSchema = Type.Object(
  {
    issues: Type.Array(structuredIssueSchema),
    nextCursor: Type.Union([structuredSlotTreeCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** One row of the owner outline (spec §14). */
export const structuredSlotOutlineEntrySchema = Type.Object(
  {
    slotId: Type.String(),
    typeId: Type.String(),
    contentPresence: Type.Union([Type.Literal('unset'), Type.Literal('set')]),
    parentSlotId: Type.Union([Type.String(), Type.Null()]),
    shell: Type.Boolean(),
    level: Type.Union([Type.Literal('outline'), Type.Literal('spec'), Type.Literal('content')]),
    spec: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

/** Paged owner outline. */
export const structuredSlotOutlinePageSchema = Type.Object(
  {
    entries: Type.Array(structuredSlotOutlineEntrySchema),
    nextCursor: Type.Union([structuredSlotTreeCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** The authorized projection of one slot. */
export const structuredSlotReadResponseSchema = Type.Object(
  {
    slot: Type.Object(
      {
        slotId: Type.String(),
        typeId: Type.String(),
        contentPresence: Type.Union([Type.Literal('unset'), Type.Literal('set')]),
        level: Type.Union([Type.Literal('outline'), Type.Literal('spec'), Type.Literal('content')]),
        spec: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        content: Type.Optional(Type.Unknown()),
        ancestors: Type.Array(
          Type.Object(
            {
              slotId: Type.String(),
              typeId: Type.String(),
              contentPresence: Type.Union([Type.Literal('unset'), Type.Literal('set')]),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** The immutable SealRecord (design §17.2). */
export const structuredSealRecordSchema = Type.Object(
  {
    sealId: Type.String(),
    caseId: Type.String(),
    scaffoldId: Type.String(),
    scaffoldRevision: Type.Integer(),
    scaffoldTreeHash: Type.String(),
    templateId: Type.String(),
    templateVersion: Type.String(),
    snapshotHash: Type.String(),
    assemblerId: Type.String(),
    assemblerVersion: Type.String(),
    artifactVersionRef: Type.Object(
      { artifactId: Type.String(), version: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    outputs: Type.Array(
      Type.Object(
        {
          routeId: Type.String(),
          path: Type.String(),
          mediaType: Type.String(),
          byteLength: Type.Integer(),
          sha256: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    sealedAt: Type.String(),
  },
  { additionalProperties: false },
);

/** One 28-field limits group helper (spec §5). */
function limitsGroup(fields: readonly string[]): TSchema {
  const props: Record<string, TSchema> = {};
  for (const field of fields) {
    props[field] = Type.Integer({ minimum: 1 });
  }
  return Type.Object(props, { additionalProperties: false });
}

/** The full 28-field structured limits profile. */
export const structuredSlotLimitsSchema = Type.Object(
  {
    schema: limitsGroup(['maxSchemaDepth', 'maxSchemaNodes', 'maxEnumItems', 'maxPatternLength']),
    structure: limitsGroup(['maxSlots', 'maxTreeDepth', 'maxChildrenPerSlot']),
    payload: limitsGroup(['maxSpecBytesPerSlot', 'maxContentBytesPerSlot', 'maxScaffoldPayloadBytes']),
    draft: limitsGroup(['maxChangedSlots', 'maxDraftBytes']),
    attempt: limitsGroup([
      'maxSlotToolCallsPerAttempt',
      'maxValidationRunsPerAttempt',
      'maxValidatorInvocationsPerAttempt',
      'maxAggregateValidatorCpuMsPerAttempt',
      'maxAggregateValidatorWallClockMsPerAttempt',
      'maxValidatorOutputBytesPerAttempt',
      'maxAttemptWallClockMs',
    ]),
    validation: limitsGroup([
      'maxValidators',
      'maxValidatorInvocationsPerGate',
      'maxAggregateValidatorCpuMsPerGate',
      'maxAggregateValidatorWallClockMsPerGate',
      'maxValidatorOutputBytesPerGate',
      'maxIssuesPerRun',
    ]),
    output: limitsGroup(['maxArtifactFiles', 'maxArtifactBytesPerFile', 'maxTotalArtifactBytes']),
  },
  { additionalProperties: false },
);

/**
 * Public contract projection (spec §14): slot types + grammar + limits + ABI
 * identity, WITHOUT implementation paths, validators, accessProfiles or the
 * resource manifest. `specSchema`/`children` are serialized plain JSON.
 */
export const structuredSlotPublicContractSchema = Type.Object(
  {
    version: Type.Literal(1),
    slotTypes: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          name: Type.String(),
          description: Type.String(),
          specSchema: Type.Record(Type.String(), Type.Unknown()),
          content: Type.Union([
            Type.Object({ presence: Type.Literal('forbidden') }, { additionalProperties: false }),
            Type.Object(
              {
                presence: Type.Union([Type.Literal('optional'), Type.Literal('required')]),
                schema: Type.Record(Type.String(), Type.Unknown()),
              },
              { additionalProperties: false },
            ),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    layoutGrammar: Type.Object(
      {
        rootType: Type.String(),
        productions: Type.Record(
          Type.String(),
          Type.Object(
            {
              children: Type.Record(Type.String(), Type.Unknown()),
              nullable: Type.Boolean(),
              minConsumption: Type.Integer(),
              maxConsumption: Type.Integer(),
              first: Type.Array(Type.String()),
              generatable: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    limits: structuredSlotLimitsSchema,
    abiProfileIdentity: Type.Object(
      {
        validatorAbi: Type.Literal('forge-validator/v1'),
        assemblerAbi: Type.Literal('forge-assembler/v1'),
        profileIdentity: Type.Literal('forge-structured-runtime/v1'),
      },
      { additionalProperties: false },
    ),
    semanticDigest: Type.String(),
  },
  { additionalProperties: false },
);
