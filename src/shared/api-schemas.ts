/**
 * Read-only TypeBox schemas for the Phase B JSON API payloads (plan Phase B
 * Task 5). The frozen interfaces in `contracts.ts` stay the source of truth;
 * these schemas mirror them so the server can reject request bodies that fall
 * outside the declared shape (unknown fields included) and the HttpGateway
 * can decode success/error payloads before handing them to pages.
 *
 * Platform-generic: no business vocabulary (iron rule 1).
 */
import { Type } from 'typebox';

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
  thinking: Type.String(),
  tools: Type.Array(liveToolCallSchema),
  updatedAt: Type.String(),
});

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
});

export const healthSchema = Type.Object({
  ok: Type.Literal(true),
  service: Type.String(),
  mode: Type.String(),
});

/* --------------------------- phase E response shapes ------------------------- */

/** One observable step of a model Turn (display-only, never gates). */
export const traceEntrySchema = Type.Union([
  Type.Object({ kind: Type.Literal('thinking'), text: Type.String() }),
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
