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
  ]),
  currentAgentName: Type.Union([Type.String(), Type.Null()]),
  latestVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  updatedAt: Type.String(),
  diagnostic: Type.Union([Type.String(), Type.Null()]),
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

export const artifactVersionSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  files: Type.Array(
    Type.Object({
      name: Type.String(),
      extract: Type.String(),
      content: Type.String(),
    }),
  ),
  sourceNodeId: Type.String(),
  createdAt: Type.String(),
  final: Type.Boolean(),
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
