// @vitest-environment node
/**
 * Shared API schema tests for the production/dispatch turn contract (plan
 * 2026-08-04 Task 1 Step 1, spec §7.4/§7.5).
 *
 * `turnTraceSchema` gains the optional display-only `phase` summary; traces
 * without it stay legal so historical trace files decode unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import {
  answerBodyV2Schema,
  artifactVersionSchema,
  authoritativeBlobKindV2Schema,
  authoritativeReviewWorkspaceV2Schema,
  structuredIssuePageSchema,
  structuredSealRecordSchema,
  structuredSlotOutlinePageSchema,
  structuredSlotPublicContractSchema,
  structuredSlotReadResponseSchema,
  structuredSlotsSummarySchema,
  taskSummarySchema,
  taskWorkspaceSchema,
  traceEntrySchema,
  turnTraceSchema,
} from './api-schemas';

describe('artifactVersionSchema authority union', () => {
  const ref = (kind: string) => ({
    kind, digest: 'a'.repeat(64), byteLength: 1, mediaType: 'application/json', schemaVersion: 1,
  });
  const common = { id: 'artifact', version: 1, title: 'title', files: [], createdAt: '2026-08-16T00:00:00.000Z', final: false };

  it('keeps legacy v1 bytes and accepts exact system v2 without sourceNodeId', () => {
    expect(Value.Check(artifactVersionSchema, { ...common, sourceNodeId: 'node' })).toBe(true);
    const v2 = {
      ...common, protocolVersion: 2, producerWorkItemId: 'seal-work', sealRecordRef: ref('seal_record'),
      artifactRef: ref('artifact'), custodyRef: ref('artifact'), templateSnapshotHash: 'b'.repeat(64),
      deliveryRef: ref('system_artifact_delivery'),
    };
    expect(Value.Check(artifactVersionSchema, v2)).toBe(true);
    expect(Value.Check(artifactVersionSchema, { ...v2, sourceNodeId: 'forbidden' })).toBe(false);
  });
});

describe('turnTraceSchema phase compatibility (spec §7.5)', () => {
  it('accepts a trace without phase (backward compatible)', () => {
    expect(Value.Check(turnTraceSchema, { turnId: 'turn-1', entries: [] })).toBe(true);
  });

  it('rejects a thinking trace entry on the wire (semantic audit P0)', () => {
    // Provider raw thinking is never durable or exposed via the API (plan
    // 2026-08-07): a thinking-kind entry must fail the browser wire schema.
    expect(Value.Check(traceEntrySchema, { kind: 'thinking', text: 'secret chain' })).toBe(false);
    expect(
      Value.Check(turnTraceSchema, {
        turnId: 'turn-1',
        entries: [{ kind: 'thinking', text: 'secret chain' }],
      }),
    ).toBe(false);
  });

  it('accepts a trace carrying the complete phase summary', () => {
    expect(Value.Check(turnTraceSchema, {
      turnId: 'turn-1',
      phase: {
        state: 'dispatched',
        dispatchAction: 'publish_artifact',
        target: 'agent-beta',
        message: null,
      },
      entries: [{ kind: 'text', text: 'neutral' }],
    })).toBe(true);
  });

  it('accepts the v7 forward_input_version dispatch action', () => {
    // Plan 2026-08-06: forward_input_version is a legal v7 dispatch and must
    // survive the browser-side wire schema (a missing literal would fail
    // getDecoded and the UI would show the empty-trace placeholder).
    expect(Value.Check(turnTraceSchema, {
      turnId: 'turn-1',
      phase: {
        state: 'dispatched',
        dispatchAction: 'forward_input_version',
        target: 'controller',
        message: null,
      },
      entries: [{ kind: 'text', text: 'neutral' }],
    })).toBe(true);
  });

  it('accepts every declared phase state and nullable fields', () => {
    const states = ['production', 'production_complete', 'dispatching', 'dispatched', 'waiting_human', 'failed'];
    for (const state of states) {
      expect(Value.Check(turnTraceSchema, {
        turnId: 'turn-1',
        phase: { state, dispatchAction: null, target: null, message: null },
        entries: [],
      })).toBe(true);
    }
  });

  it('rejects unknown phase states and dispatch actions', () => {
    expect(Value.Check(turnTraceSchema, {
      turnId: 'turn-1',
      phase: { state: 'exploded', dispatchAction: null, target: null, message: null },
      entries: [],
    })).toBe(false);
    expect(Value.Check(turnTraceSchema, {
      turnId: 'turn-1',
      phase: { state: 'dispatched', dispatchAction: 'load_skill', target: null, message: null },
      entries: [],
    })).toBe(false);
  });
});

/* ------------------- live streaming activeTurn (plan C) ------------------- */

const BASE_TASK = {
  id: 'task-1',
  name: '任务',
  templateId: 'tpl',
  templateName: '模板',
  status: 'running' as const,
  currentAgentName: null,
  latestVersion: null,
  updatedAt: '2026-08-05T00:00:00.000Z',
  diagnostic: null,
  structuredProtocol: 'none' as const,
};

function baseWorkspace(activeTurn?: unknown): Record<string, unknown> {
  return {
    task: BASE_TASK,
    frozenInput: {},
    templateVersion: 'v1',
    agents: [],
    declaredRoutes: [],
    nodes: [],
    executedRoutes: [],
    artifacts: [],
    pendingHumanQuestion: null,
    pendingHumanSource: null,
    ...(activeTurn !== undefined ? { activeTurn } : {}),
  };
}

describe('taskWorkspaceSchema activeTurn (plan C realtime streaming)', () => {
  it('accepts a workspace without activeTurn (backward compatible)', () => {
    expect(Value.Check(taskWorkspaceSchema, baseWorkspace())).toBe(true);
  });

  it('accepts an explicit null activeTurn', () => {
    expect(Value.Check(taskWorkspaceSchema, baseWorkspace(null))).toBe(true);
  });

  it('accepts a full running live turn', () => {
    const workspace = baseWorkspace({
      agentId: 'agent-alpha',
      turnId: 'turn-1',
      status: 'running',
      text: 'streaming text',
      thinking: 'streaming thinking',
      tools: [
        { name: 'load_skill', state: 'done' },
        { name: 'finish_production', state: 'running' },
      ],
      updatedAt: '2026-08-05T00:00:01.000Z',
    });
    expect(Value.Check(taskWorkspaceSchema, workspace)).toBe(true);
  });

  it('rejects a live turn with an invalid status or tool state', () => {
    const badStatus = baseWorkspace({
      agentId: 'a',
      turnId: 't',
      status: 'paused',
      text: '',
      thinking: '',
      tools: [],
      updatedAt: '2026-08-05T00:00:01.000Z',
    });
    expect(Value.Check(taskWorkspaceSchema, badStatus)).toBe(false);
    const badTool = baseWorkspace({
      agentId: 'a',
      turnId: 't',
      status: 'running',
      text: '',
      thinking: '',
      tools: [{ name: 'x', state: 'pending' }],
      updatedAt: '2026-08-05T00:00:01.000Z',
    });
    expect(Value.Check(taskWorkspaceSchema, badTool)).toBe(false);
  });
});

/* ------------------- structured slots summary (spec §14 / I01) ------------------- */

const SUMMARY = {
  version: 1,
  mode: 'structured_slots',
  scaffoldId: 'scaffold-1',
  generationId: 'gen-1',
  contentRevision: 2,
  structureStatus: 'active',
  sealStatus: 'unsealed',
  visibleSlotCount: 12,
  filledSlotCount: 9,
  issueSummary: { errors: 1, warnings: 2 },
};

function workspaceWithStructured(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseWorkspace(),
    structuredSlots: { ...SUMMARY, ...extra },
  };
}

describe('structuredSlots summary schema (spec §14)', () => {
  it('accepts the complete structured summary', () => {
    expect(Value.Check(structuredSlotsSummarySchema, SUMMARY)).toBe(true);
  });

  it('accepts a pre-scaffold structured summary with null identities', () => {
    expect(
      Value.Check(structuredSlotsSummarySchema, {
        version: 1,
        mode: 'structured_slots',
        scaffoldId: null,
        generationId: null,
        contentRevision: null,
        structureStatus: 'none',
        sealStatus: 'unsealed',
        visibleSlotCount: 0,
        filledSlotCount: 0,
        issueSummary: { errors: 0, warnings: 0 },
      }),
    ).toBe(true);
  });

  it('rejects unknown summary fields so content/tree/Draft/Grant never leak', () => {
    expect(Value.Check(structuredSlotsSummarySchema, SUMMARY)).toBe(true);
    for (const leak of ['content', 'tree', 'drafts', 'grant', 'scaffold', 'structure']) {
      expect(
        Value.Check(structuredSlotsSummarySchema, { ...SUMMARY, [leak]: { anything: 1 } }),
      ).toBe(false);
    }
  });

  it('rejects malformed summary values', () => {
    expect(Value.Check(structuredSlotsSummarySchema, { ...SUMMARY, structureStatus: 'bogus' })).toBe(false);
    expect(Value.Check(structuredSlotsSummarySchema, { ...SUMMARY, visibleSlotCount: -1 })).toBe(false);
    expect(Value.Check(structuredSlotsSummarySchema, { ...SUMMARY, issueSummary: { errors: 1 } })).toBe(false);
  });
});

describe('taskWorkspaceSchema structuredSlots (basic omits the field)', () => {
  it('basic workspace without structuredSlots stays legal (backward compatible)', () => {
    expect(Value.Check(taskWorkspaceSchema, baseWorkspace())).toBe(true);
  });

  it('accepts a structured workspace carrying the summary', () => {
    expect(Value.Check(taskWorkspaceSchema, workspaceWithStructured())).toBe(true);
  });

  it('rejects a structured summary that embeds content/tree/Draft/Grant on the wire', () => {
    for (const leak of ['content', 'tree', 'drafts', 'grant']) {
      expect(Value.Check(taskWorkspaceSchema, workspaceWithStructured({ [leak]: [1, 2] }))).toBe(false);
    }
  });
});

/* ------------------- structured slot read-only response schemas (spec §14) ------------------- */

const VALID_CURSOR = {
  version: 1,
  generationId: 'gen-1',
  revision: 0,
  projectionHash: 'a'.repeat(64),
  lastDocumentKey: 'title',
  orderingVersion: 1,
  signature: 'b'.repeat(64),
};

describe('structured slot read-only response schemas (spec §14)', () => {
  it('accepts a valid public contract projection without implementation paths', () => {
    const contract = {
      version: 1,
      slotTypes: [
        {
          id: 'title',
          name: 'Title',
          description: 'leaf',
          specSchema: { type: 'object', additionalProperties: false },
          content: { presence: 'required', schema: { type: 'string', minLength: 1 } },
        },
        {
          id: 'document',
          name: 'Document',
          description: 'root',
          specSchema: { type: 'object' },
          content: { presence: 'forbidden' },
        },
      ],
      layoutGrammar: {
        rootType: 'document',
        productions: {
          document: {
            children: { kind: 'sequence', items: [{ kind: 'slot', type: 'title' }] },
            nullable: false,
            minConsumption: 1,
            maxConsumption: 1,
            first: ['title'],
            generatable: true,
          },
        },
      },
      limits: {
        schema: { maxSchemaDepth: 4, maxSchemaNodes: 1024, maxEnumItems: 64, maxPatternLength: 128 },
        structure: { maxSlots: 2500, maxTreeDepth: 8, maxChildrenPerSlot: 250 },
        payload: { maxSpecBytesPerSlot: 16384, maxContentBytesPerSlot: 262144, maxScaffoldPayloadBytes: 16777216 },
        draft: { maxChangedSlots: 500, maxDraftBytes: 4194304 },
        attempt: {
          maxSlotToolCallsPerAttempt: 128,
          maxValidationRunsPerAttempt: 4,
          maxValidatorInvocationsPerAttempt: 10000,
          maxAggregateValidatorCpuMsPerAttempt: 60000,
          maxAggregateValidatorWallClockMsPerAttempt: 120000,
          maxValidatorOutputBytesPerAttempt: 4194304,
          maxAttemptWallClockMs: 150000,
        },
        validation: {
          maxValidators: 16,
          maxValidatorInvocationsPerGate: 2500,
          maxAggregateValidatorCpuMsPerGate: 15000,
          maxAggregateValidatorWallClockMsPerGate: 30000,
          maxValidatorOutputBytesPerGate: 1048576,
          maxIssuesPerRun: 125,
        },
        output: { maxArtifactFiles: 16, maxArtifactBytesPerFile: 4194304, maxTotalArtifactBytes: 16777216 },
      },
      abiProfileIdentity: {
        validatorAbi: 'forge-validator/v1',
        assemblerAbi: 'forge-assembler/v1',
        profileIdentity: 'forge-structured-runtime/v1',
      },
      semanticDigest: 'c'.repeat(64),
    };
    expect(Value.Check(structuredSlotPublicContractSchema, contract)).toBe(true);
  });

  it('rejects a contract response carrying implementation paths or ACL as unknown fields', () => {
    const valid = structuredSlotPublicContractSchema;
    const withLeak = {
      version: 1,
      slotTypes: [],
      layoutGrammar: { rootType: 'document', productions: {} },
      limits: {
        schema: { maxSchemaDepth: 4, maxSchemaNodes: 1024, maxEnumItems: 64, maxPatternLength: 128 },
        structure: { maxSlots: 2500, maxTreeDepth: 8, maxChildrenPerSlot: 250 },
        payload: { maxSpecBytesPerSlot: 16384, maxContentBytesPerSlot: 262144, maxScaffoldPayloadBytes: 16777216 },
        draft: { maxChangedSlots: 500, maxDraftBytes: 4194304 },
        attempt: {
          maxSlotToolCallsPerAttempt: 128,
          maxValidationRunsPerAttempt: 4,
          maxValidatorInvocationsPerAttempt: 10000,
          maxAggregateValidatorCpuMsPerAttempt: 60000,
          maxAggregateValidatorWallClockMsPerAttempt: 120000,
          maxValidatorOutputBytesPerAttempt: 4194304,
          maxAttemptWallClockMs: 150000,
        },
        validation: {
          maxValidators: 16,
          maxValidatorInvocationsPerGate: 2500,
          maxAggregateValidatorCpuMsPerGate: 15000,
          maxAggregateValidatorWallClockMsPerGate: 30000,
          maxValidatorOutputBytesPerGate: 1048576,
          maxIssuesPerRun: 125,
        },
        output: { maxArtifactFiles: 16, maxArtifactBytesPerFile: 4194304, maxTotalArtifactBytes: 16777216 },
      },
      abiProfileIdentity: {
        validatorAbi: 'forge-validator/v1',
        assemblerAbi: 'forge-assembler/v1',
        profileIdentity: 'forge-structured-runtime/v1',
      },
      semanticDigest: 'c'.repeat(64),
    };
    expect(Value.Check(valid, withLeak)).toBe(true);
    for (const leak of ['validators', 'assembler', 'accessProfiles', 'resourceManifest']) {
      expect(Value.Check(structuredSlotPublicContractSchema, { ...withLeak, [leak]: [] })).toBe(false);
    }
  });

  it('accepts and rejects the paged outline response exactly', () => {
    const page = {
      entries: [
        {
          slotId: 'root',
          typeId: 'document',
          contentPresence: 'unset',
          parentSlotId: null,
          shell: false,
          level: 'content',
          spec: { type: 'object' },
        },
      ],
      nextCursor: VALID_CURSOR,
    };
    expect(Value.Check(structuredSlotOutlinePageSchema, page)).toBe(true);
    expect(Value.Check(structuredSlotOutlinePageSchema, { entries: [], nextCursor: null })).toBe(true);
    expect(Value.Check(structuredSlotOutlinePageSchema, { ...page, entries: [{ ...page.entries[0], shell: 'yes' }] })).toBe(false);
    expect(Value.Check(structuredSlotOutlinePageSchema, { ...page, totals: 1 })).toBe(false);
  });

  it('accepts and rejects the slot read response exactly', () => {
    const read = {
      slot: {
        slotId: 'title',
        typeId: 'title',
        contentPresence: 'set',
        level: 'content',
        spec: { type: 'object' },
        content: 'The Title',
        ancestors: [{ slotId: 'root', typeId: 'document', contentPresence: 'unset' }],
      },
    };
    expect(Value.Check(structuredSlotReadResponseSchema, read)).toBe(true);
    expect(Value.Check(structuredSlotReadResponseSchema, { ...read, slot: { ...read.slot, childCount: 3 } })).toBe(false);
    expect(Value.Check(structuredSlotReadResponseSchema, { ...read, grant: {} })).toBe(false);
  });

  it('accepts and rejects the paged issues response exactly', () => {
    const page = {
      issues: [
        {
          version: 1,
          code: 'DRAFT_STALE',
          severity: 'error',
          phase: 'merge',
          source: 'lifecycle',
          message: 'DRAFT_STALE (merge)',
          primaryLocation: { kind: 'operation' },
          relatedLocations: [],
          details: { draftId: 'draft-1' },
        },
      ],
      nextCursor: null,
    };
    expect(Value.Check(structuredIssuePageSchema, page)).toBe(true);
    expect(Value.Check(structuredIssuePageSchema, { issues: [], nextCursor: VALID_CURSOR })).toBe(true);
    expect(Value.Check(structuredIssuePageSchema, { ...page, issues: [{ ...page.issues[0], version: 2 }] })).toBe(false);
    expect(Value.Check(structuredIssuePageSchema, { ...page, truncated: false })).toBe(false);
  });

  it('accepts and rejects the SealRecord response exactly', () => {
    const seal = {
      sealId: 'seal-1',
      caseId: 'task-1',
      scaffoldId: 'scaffold-1',
      scaffoldRevision: 3,
      scaffoldTreeHash: 'a'.repeat(64),
      templateId: 'tpl',
      templateVersion: 'v1',
      snapshotHash: 'b'.repeat(64),
      assemblerId: 'render',
      assemblerVersion: 'v1',
      artifactVersionRef: { artifactId: 'artifact-1', version: 1 },
      outputs: [
        { routeId: 'document-md', path: 'document.md', mediaType: 'text/markdown; charset=utf-8', byteLength: 120, sha256: 'c'.repeat(64) },
      ],
      sealedAt: '2026-08-05T00:00:00.000Z',
    };
    expect(Value.Check(structuredSealRecordSchema, seal)).toBe(true);
    expect(Value.Check(structuredSealRecordSchema, { ...seal, outputs: [{ ...seal.outputs[0], extra: 1 }] })).toBe(false);
    expect(Value.Check(structuredSealRecordSchema, { ...seal, stagingPath: '/tmp/x' })).toBe(false);
  });
});

/* ------------------- v2 task summary: failed + structuredProtocol (spec §10.3/§10.5) ------------------- */

describe('taskSummarySchema v2 fields (failed + structuredProtocol)', () => {
  it('accepts the terminal failed status next to every v1 status', () => {
    const failed = { ...BASE_TASK, status: 'failed' };
    expect(Value.Check(taskSummarySchema, failed)).toBe(true);
    for (const status of [
      'draft',
      'ready',
      'running',
      'waiting_human',
      'retryable_failure',
      'interrupted',
      'completed',
      'stopped',
      'corrupt',
      'incompatible',
    ]) {
      expect(Value.Check(taskSummarySchema, { ...BASE_TASK, status })).toBe(true);
    }
  });

  it('requires structuredProtocol on every summary (the client never guesses)', () => {
    expect(Value.Check(taskSummarySchema, { ...BASE_TASK, structuredProtocol: 'none' })).toBe(true);
    expect(Value.Check(taskSummarySchema, { ...BASE_TASK, structuredProtocol: 'v1' })).toBe(true);
    expect(Value.Check(taskSummarySchema, { ...BASE_TASK, structuredProtocol: 'v2' })).toBe(true);
    const { structuredProtocol: _dropped, ...without } = BASE_TASK;
    expect(Value.Check(taskSummarySchema, without)).toBe(false);
    expect(Value.Check(taskSummarySchema, { ...BASE_TASK, structuredProtocol: 'v3' })).toBe(false);
    expect(Value.Check(taskSummarySchema, { ...BASE_TASK, structuredProtocol: 2 })).toBe(false);
  });
});

/* ------------------- v1/v2 workspace summary discrimination (spec §14/§15) ------------------- */

describe('taskWorkspaceSchema v1/v2 structured summary discrimination', () => {
  it('accepts a v1 structured workspace whose task carries structuredProtocol v1', () => {
    const workspace = workspaceWithStructured();
    workspace.task = { ...BASE_TASK, structuredProtocol: 'v1' };
    expect(Value.Check(taskWorkspaceSchema, workspace)).toBe(true);
  });

  it('accepts a v2 workspace with the versioned authoritativeReview summary', () => {
    const workspace = baseWorkspace();
    workspace.task = { ...BASE_TASK, status: 'running', structuredProtocol: 'v2' };
    (workspace as Record<string, unknown>).authoritativeReview = {
      version: 2,
      executionEligibility: {
        state: 'eligible',
        frozenProfileDigest: 'a'.repeat(64),
        currentProfileDigest: 'a'.repeat(64),
      },
      pendingQuestion: {
        questionId: 'question-1',
        questionDigest: 'b'.repeat(64),
        questionVersion: 'MYf28MmooIcTH9zYHiYmYEzbJCymSvrmmWPX1W0B7Pk',
        source: 'agent_request',
        text: '该章结尾是否需要补充来源？',
      },
    };
    expect(Value.Check(taskWorkspaceSchema, workspace)).toBe(true);
    expect(Value.Check(authoritativeReviewWorkspaceV2Schema, workspace.authoritativeReview)).toBe(true);
  });

  it('rejects a v2 workspace summary that is missing eligibility or carries v1 fields', () => {
    const workspace = baseWorkspace();
    workspace.task = { ...BASE_TASK, structuredProtocol: 'v2' };
    (workspace as Record<string, unknown>).authoritativeReview = {
      version: 2,
      pendingQuestion: null,
    };
    expect(Value.Check(taskWorkspaceSchema, workspace)).toBe(false);

    (workspace as Record<string, unknown>).authoritativeReview = {
      version: 2,
      executionEligibility: {
        state: 'blocked',
        reason: 'authoritative_capability_disabled',
        frozenProfileDigest: 'c'.repeat(64),
        currentProfileDigest: null,
      },
      pendingQuestion: { questionId: 'q', questionDigest: 'd'.repeat(64), questionVersion: '1', source: 'agent_request', text: 'x' },
      structuredSlots: { version: 1 },
    };
    expect(Value.Check(taskWorkspaceSchema, workspace)).toBe(false);
  });

  it('rejects unknown kinds at the blob registry schema', () => {
    expect(Value.Check(authoritativeBlobKindV2Schema, 'profile_snapshot')).toBe(true);
    expect(Value.Check(authoritativeBlobKindV2Schema, 'made_up_kind')).toBe(false);
  });

  it('keeps the v1 answer body legal and requires question identity on the v2 body', () => {
    expect(Value.Check(answerBodyV2Schema, { answer: 'text' })).toBe(false);
    expect(Value.Check(answerBodyV2Schema, {
      questionId: 'question-1',
      questionVersion: 'MYf28MmooIcTH9zYHiYmYEzbJCymSvrmmWPX1W0B7Pk',
      operationId: '3b2c8f4e-9a1d-4f6e-b2c4-1a2b3c4d5e6f',
      answer: 'text',
    })).toBe(true);
    expect(Value.Check(answerBodyV2Schema, {
      questionId: 'question-1',
      questionVersion: 'MYf28MmooIcTH9zYHiYmYEzbJCymSvrmmWPX1W0B7Pk',
      operationId: '3b2c8f4e-9a1d-4f6e-b2c4-1a2b3c4d5e6f',
      decision: 'stop',
    })).toBe(true);
  });
});
