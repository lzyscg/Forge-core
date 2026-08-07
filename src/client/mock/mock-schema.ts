import { Type, type TSchema } from 'typebox';
import type {
  ArtifactVersion,
  MockScenarioId,
  TemplateDetail,
  WorkspaceNode,
  WorkspaceRoute,
} from '../../shared/contracts';

/**
 * Schema and envelope definitions for the versioned mock persistence layer.
 * Platform vocabulary only: no business roles, products or scenario names
 * live here; business content flows in exclusively through fixtures.
 */

export const MOCK_STORAGE_KEYS = {
  catalog: 'forge-core:mock:v1:catalog',
  tasks: 'forge-core:mock:v1:tasks',
  development: 'forge-core:mock:v1:development',
} as const;

export const MOCK_STORAGE_PREFIX = 'forge-core:mock:v1:';

/** Injected clock: production passes Date/window timers, tests pass a fake. */
export interface MockClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/**
 * Append-only task events. Events are the only mutation channel for task
 * records; projections fold them in order and never rewrite history.
 */
export type MockTaskEvent =
  | { type: 'task_started'; at: string }
  | { type: 'task_stopped'; at: string }
  | { type: 'task_resumed'; at: string }
  | { type: 'agent_input'; at: string; node: WorkspaceNode }
  | { type: 'agent_attempt_failed'; at: string; nodeId: string; message: string; retryable: boolean }
  | { type: 'agent_result'; at: string; node: WorkspaceNode }
  | { type: 'skill_loaded'; at: string; node: WorkspaceNode }
  | { type: 'route_executed'; at: string; route: WorkspaceRoute }
  | { type: 'artifact_published'; at: string; artifact: ArtifactVersion }
  | { type: 'human_requested'; at: string; node: WorkspaceNode; question: string }
  | { type: 'human_answered'; at: string; node: WorkspaceNode; answer: string }
  | { type: 'pending_inputs_superseded'; at: string; supersededNodeIds: string[] }
  | { type: 'final_accepted'; at: string; artifactId: string }
  | { type: 'task_interrupted'; at: string };

/**
 * Persisted simulator scheduling state for one task. Events remain the only
 * history; this record is resumable bookkeeping (which script, which step is
 * due next, when, and which run generation owns the pending callback) so a
 * refreshed browser continues from the last confirmed step.
 */
export interface MockRunSchedule {
  scenarioId: MockScenarioId;
  nextStepIndex: number;
  nextDueAt: number | null;
  runGeneration: number;
}

/** One persisted task: frozen configuration plus append-only event history. */
export interface MockTaskRecord {
  id: string;
  name: string;
  templateId: string;
  templateName: string;
  frozenInput: Record<string, string>;
  frozenTemplate: TemplateDetail;
  events: MockTaskEvent[];
  /** Simulator bookkeeping; absent for tasks that were never started. */
  run?: MockRunSchedule | null;
  createdAt: string;
  updatedAt: string;
}

/** A task entry read back from storage; corrupt records stay addressable by id. */
export type MockTaskEntry =
  | { id: string; record: MockTaskRecord; corrupt: false }
  | { id: string; corrupt: true; updatedAt: string };

export interface CatalogTemplateEntry {
  template: TemplateDetail;
  updatedAt: string;
}

export interface CatalogData {
  templates: Record<string, CatalogTemplateEntry>;
  diagnostics: Record<string, string>;
}

export interface DevelopmentData {
  nextScenario: MockScenarioId;
}

/** Versioned envelope wrapping every persisted mock value. */
export interface StorageEnvelope<T> {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  data: T;
}

/** Shape a template fixture must provide to the mock registry. */
export interface MockTemplateSampleArtifact {
  title: string;
  content: string;
}

export interface MockTemplateFixture {
  template: TemplateDetail;
  sampleTaskName: string;
  sampleInput: Record<string, string>;
  sampleArtifacts: { v1: MockTemplateSampleArtifact; v2: MockTemplateSampleArtifact };
  /** Model thinking shown in the Phase E process-trace display reads. */
  sampleThinking: string;
  sampleHumanQuestion: string;
  sampleHumanAnswer: string;
  sampleReturnNote: string;
  sampleApprovalNote: string;
}

export const MOCK_SCENARIO_IDS: readonly MockScenarioId[] = [
  'happy_path',
  'review_return_v2',
  'transient_retry',
  'manual_retry',
  'human_input',
  'refresh_recovery',
];

export const DEFAULT_MOCK_SCENARIO: MockScenarioId = 'happy_path';

/* ---------------------------------------------------------------------------
 * Runtime validation schemas (TypeBox). Every persisted value is checked
 * against these before use; failures are treated as corruption and isolated.
 * ------------------------------------------------------------------------- */

const nodeKindSchema = Type.Union([
  Type.Literal('input'),
  Type.Literal('result'),
  Type.Literal('human_request'),
  Type.Literal('human_answer'),
  Type.Literal('skill'),
]);

const routeKindSchema = Type.Union([Type.Literal('message'), Type.Literal('artifact')]);

export const workspaceNodeSchema = Type.Object({
  id: Type.String(),
  sequence: Type.Integer(),
  agentId: Type.String(),
  kind: nodeKindSchema,
  title: Type.String(),
  body: Type.String(),
  status: Type.Union([Type.Literal('confirmed'), Type.Literal('active'), Type.Literal('failed')]),
  attemptCount: Type.Integer({ minimum: 1 }),
  inputVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  // Optional: records persisted before Phase E never carried the field.
  turnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // True when `pending_inputs_superseded` voided this input (spec §11.2).
  superseded: Type.Optional(Type.Boolean()),
});

export const workspaceRouteSchema = Type.Object({
  id: Type.String(),
  sequence: Type.Integer(),
  fromNodeId: Type.String(),
  toNodeId: Type.String(),
  kind: routeKindSchema,
  label: Type.String(),
});

export const inputVersionSchema = Type.Object({
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

export const mockTaskEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('task_started'), at: Type.String() }),
  Type.Object({ type: Type.Literal('task_stopped'), at: Type.String() }),
  Type.Object({ type: Type.Literal('task_resumed'), at: Type.String() }),
  Type.Object({ type: Type.Literal('agent_input'), at: Type.String(), node: workspaceNodeSchema }),
  Type.Object({
    type: Type.Literal('agent_attempt_failed'),
    at: Type.String(),
    nodeId: Type.String(),
    message: Type.String(),
    retryable: Type.Boolean(),
  }),
  Type.Object({ type: Type.Literal('agent_result'), at: Type.String(), node: workspaceNodeSchema }),
  Type.Object({
    type: Type.Literal('skill_loaded'),
    at: Type.String(),
    node: workspaceNodeSchema,
  }),
  Type.Object({
    type: Type.Literal('route_executed'),
    at: Type.String(),
    route: workspaceRouteSchema,
  }),
  Type.Object({
    type: Type.Literal('artifact_published'),
    at: Type.String(),
    artifact: inputVersionSchema,
  }),
  Type.Object({
    type: Type.Literal('human_requested'),
    at: Type.String(),
    node: workspaceNodeSchema,
    question: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('human_answered'),
    at: Type.String(),
    node: workspaceNodeSchema,
    answer: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('pending_inputs_superseded'),
    at: Type.String(),
    supersededNodeIds: Type.Array(Type.String()),
  }),
  Type.Object({ type: Type.Literal('final_accepted'), at: Type.String(), artifactId: Type.String() }),
  Type.Object({ type: Type.Literal('task_interrupted'), at: Type.String() }),
]);

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

const inputFieldSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  kind: Type.Union([Type.Literal('text'), Type.Literal('textarea')]),
  required: Type.Boolean(),
  description: Type.String(),
});

export const templateDetailSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  version: Type.String(),
  agentCount: Type.Integer({ minimum: 0 }),
  status: Type.Union([Type.Literal('valid'), Type.Literal('invalid_using_cache')]),
  updatedAt: Type.String(),
  inputFields: Type.Array(inputFieldSchema),
  agents: Type.Array(agentSummarySchema),
  routes: Type.Array(
    Type.Object({
      from: Type.String(),
      to: Type.String(),
      kind: routeKindSchema,
      label: Type.String(),
    }),
  ),
  finalOutput: Type.Object({
    name: Type.String(),
    format: Type.Union([Type.Literal('markdown'), Type.Literal('text')]),
    submitters: Type.Array(Type.String()),
  }),
});

export const scenarioIdSchema = Type.Union([
  Type.Literal('happy_path'),
  Type.Literal('review_return_v2'),
  Type.Literal('transient_retry'),
  Type.Literal('manual_retry'),
  Type.Literal('human_input'),
  Type.Literal('refresh_recovery'),
]);

export const mockRunScheduleSchema = Type.Object({
  scenarioId: scenarioIdSchema,
  nextStepIndex: Type.Integer({ minimum: 0 }),
  nextDueAt: Type.Union([Type.Integer(), Type.Null()]),
  runGeneration: Type.Integer({ minimum: 0 }),
});

export const taskRecordSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  templateId: Type.String(),
  templateName: Type.String(),
  frozenInput: Type.Record(Type.String(), Type.String()),
  frozenTemplate: templateDetailSchema,
  events: Type.Array(mockTaskEventSchema),
  // Optional: records persisted before the simulator existed stay valid.
  run: Type.Optional(Type.Union([mockRunScheduleSchema, Type.Null()])),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const tasksDataSchema = Type.Record(Type.String(), Type.Unknown());

export const catalogDataSchema = Type.Object({
  templates: Type.Record(
    Type.String(),
    Type.Object({ template: templateDetailSchema, updatedAt: Type.String() }),
  ),
  diagnostics: Type.Record(Type.String(), Type.String()),
});

export const developmentDataSchema = Type.Object({ nextScenario: scenarioIdSchema });

/**
 * Runtime schema for the generated UI evidence file
 * (public/development-evidence.json, written by scripts/verify-ui.ts and
 * extended with backend fields by scripts/verify-backend.ts in Phase B and
 * real acceptance fields by scripts/write-final-evidence.ts in Phase D).
 * External input: anything that fails this check maps to the not_run seed.
 * Backend and real acceptance fields are optional: evidence files stay valid
 * without them, and a malformed field in either dimension invalidates the
 * whole file rather than faking a connected backend or a verified capability.
 */
export const developmentEvidenceOutcomeSchema = Type.Union([
  Type.Literal('not_run'),
  Type.Literal('passed'),
  Type.Literal('failed'),
]);

export const developmentEvidenceFileSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  outcome: developmentEvidenceOutcomeSchema,
  observedAt: Type.Union([Type.String(), Type.Null()]),
  commit: Type.Union([Type.String(), Type.Null()]),
  command: Type.Union([Type.String(), Type.Null()]),
  passedCapabilities: Type.Array(Type.String()),
  backendOutcome: Type.Optional(developmentEvidenceOutcomeSchema),
  backendConnectedCapabilities: Type.Optional(Type.Array(Type.String())),
  realAcceptanceOutcome: Type.Optional(developmentEvidenceOutcomeSchema),
  realAcceptanceVerifiedCapabilities: Type.Optional(Type.Array(Type.String())),
});

export function createEnvelopeSchema(data: TSchema) {
  return Type.Object({
    schemaVersion: Type.Literal(1),
    revision: Type.Integer({ minimum: 1 }),
    updatedAt: Type.String(),
    data,
  });
}
