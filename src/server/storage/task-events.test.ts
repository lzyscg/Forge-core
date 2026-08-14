// @vitest-environment node
/**
 * Canonical task event union tests for the v7 artifact version directory
 * schema (plan 2026-08-07 Phase 0). Covers the new members
 * (`artifact_annotated`, `pending_inputs_superseded`), the reshaped
 * `artifact_published` payload (`files[]` + `artifactType` + `artifactId`),
 * the `agent_result.inputNodeId`/`dispatchKind` fields, input-node
 * `inputVersion`/`humanAuthorized`, the `task_incompatible.SCHEMA_V2_REQUIRED`
 * reason, the `human_requested.source` field, and the legacy normalize
 * transform that keeps v1 events readable without corrupting.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  normalizeLegacyEvent,
  validateTaskEvent,
  type TaskEvent,
} from './task-events';
import { v1SealEvent } from '../template/v1-compatibility-support';

function base(): { id: string; at: string } {
  return { id: randomUUID(), at: '2026-08-07T00:00:00.000Z' };
}

const HASH64 = 'a'.repeat(64);

/**
 * The validator throws a `StorageError` carrying `code: 'EVENT_INVALID'`; its
 * `.message` is a presentable Chinese string without the code, so reject
 * assertions check the code directly.
 */
function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe('EVENT_INVALID');
    return;
  }
  throw new Error('expected validateTaskEvent to throw, but it did not');
}

describe('validateTaskEvent — v7 artifact_annotated', () => {
  it('accepts a well-formed artifact_annotated event', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'artifact_annotated',
      version: 2,
      file: 'review.md',
      contentHash: HASH64,
      turnId: 'turn-1',
      nodeId: 'node-1',
    });
    expect(event).toEqual({
      id,
      at,
      type: 'artifact_annotated',
      version: 2,
      file: 'review.md',
      contentHash: HASH64,
      turnId: 'turn-1',
      nodeId: 'node-1',
    });
  });

  it('rejects an artifact_annotated with a bad content hash', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'artifact_annotated',
        version: 1,
        file: 'review.md',
        contentHash: 'zz',
        turnId: 't',
        nodeId: 'n',
      }),
    );
  });

  it('rejects an artifact_annotated missing required fields', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({ id, at, type: 'artifact_annotated', version: 1, file: 'r' }),
    );
  });
});

describe('validateTaskEvent — v7 pending_inputs_superseded', () => {
  it('accepts a non-empty supersededNodeIds list', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'pending_inputs_superseded',
      supersededNodeIds: ['n1', 'n2'],
    });
    expect(event).toEqual({
      id,
      at,
      type: 'pending_inputs_superseded',
      supersededNodeIds: ['n1', 'n2'],
    });
  });

  it('rejects an empty supersededNodeIds list', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({ id, at, type: 'pending_inputs_superseded', supersededNodeIds: [] }),
    );
  });
});

describe('validateTaskEvent — v7 artifact_published files[]', () => {
  function artifact(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      title: '产物',
      sourceNodeId: 'src-1',
      format: 'markdown',
      files: [{ name: 'content.md', hash: HASH64 }],
      artifactType: '终稿',
      artifactId: 'art-1',
      ...overrides,
    };
  }

  it('accepts the new files[] + artifactType + artifactId shape', () => {
    const { id, at } = base();
    const event = validateTaskEvent({ id, at, type: 'artifact_published', artifact: artifact() });
    if (event.type !== 'artifact_published') throw new Error('unreachable');
    expect(event.artifact.files).toEqual([{ name: 'content.md', hash: HASH64 }]);
    expect(event.artifact.artifactType).toBe('终稿');
    expect(event.artifact.artifactId).toBe('art-1');
  });

  it('accepts null artifactType and artifactId', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'artifact_published',
      artifact: artifact({ artifactType: null, artifactId: null }),
    });
    if (event.type !== 'artifact_published') throw new Error('unreachable');
    expect(event.artifact.artifactType).toBeNull();
    expect(event.artifact.artifactId).toBeNull();
  });

  it('rejects the legacy contentHash key', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'artifact_published',
        artifact: {
          version: 1,
          title: '产物',
          sourceNodeId: 'src-1',
          format: 'markdown',
          contentHash: HASH64,
        },
      }),
    );
  });

  it('rejects an empty files array', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'artifact_published',
        artifact: artifact({ files: [] }),
      }),
    );
  });

  it('rejects a malformed file hash', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'artifact_published',
        artifact: artifact({ files: [{ name: 'content.md', hash: 'zz' }] }),
      }),
    );
  });
});

describe('validateTaskEvent — v7 agent_result fields', () => {
  function node() {
    return {
      sequence: 2,
      agentId: 'writer',
      kind: 'result',
      title: '结果',
      body: '正文',
      status: 'confirmed',
      attemptCount: 1,
      inputVersion: null,
    };
  }

  it('accepts inputNodeId and dispatchKind', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'agent_result',
      node: node(),
      inputNodeId: 'input-1',
      dispatchKind: 'publish',
    });
    if (event.type !== 'agent_result') throw new Error('unreachable');
    expect(event.inputNodeId).toBe('input-1');
    expect(event.dispatchKind).toBe('publish');
  });

  it('accepts a result without inputNodeId/dispatchKind (legacy/optional)', () => {
    const { id, at } = base();
    const event = validateTaskEvent({ id, at, type: 'agent_result', node: node() });
    if (event.type !== 'agent_result') throw new Error('unreachable');
    expect(event.inputNodeId).toBeUndefined();
    expect(event.dispatchKind).toBeUndefined();
  });

  it('rejects an unknown dispatchKind', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'agent_result',
        node: node(),
        dispatchKind: 'teleport',
      }),
    );
  });
});

describe('validateTaskEvent — v7 input node fields', () => {
  function inputNode(overrides: Record<string, unknown> = {}) {
    return {
      sequence: 1,
      agentId: 'reviewer',
      kind: 'input',
      title: '输入',
      body: 'b',
      status: 'confirmed',
      attemptCount: 1,
      inputVersion: null,
      ...overrides,
    };
  }

  it('accepts inputVersion on an input node', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'agent_input',
      node: inputNode({ inputVersion: 3 }),
    });
    if (event.type !== 'agent_input') throw new Error('unreachable');
    expect(event.node.inputVersion).toBe(3);
  });

  it('accepts optional humanAuthorized on an input node', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'agent_input',
      node: inputNode({ inputVersion: 2, humanAuthorized: true }),
    });
    if (event.type !== 'agent_input') throw new Error('unreachable');
    expect(event.node.humanAuthorized).toBe(true);
  });

  it('rejects a non-boolean humanAuthorized', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'agent_input',
        node: inputNode({ humanAuthorized: 'yes' }),
      }),
    );
  });
});

describe('validateTaskEvent — v7 incompatible + human source', () => {
  function humanRequestNode() {
    return {
      sequence: 1,
      agentId: 'reviewer',
      kind: 'human_request',
      title: '审核',
      body: 'q',
      status: 'confirmed',
      attemptCount: 1,
      inputVersion: null,
    };
  }

  it('accepts the SCHEMA_V2_REQUIRED reason', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'task_incompatible',
      reason: 'SCHEMA_V2_REQUIRED',
    });
    expect(event).toEqual({ id, at, type: 'task_incompatible', reason: 'SCHEMA_V2_REQUIRED' });
  });

  it('still accepts TURN_CONTRACT_REQUIRED', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'task_incompatible',
      reason: 'TURN_CONTRACT_REQUIRED',
    });
    if (event.type !== 'task_incompatible') throw new Error('unreachable');
    expect(event.reason).toBe('TURN_CONTRACT_REQUIRED');
  });

  it('accepts human_requested with source progress_guard', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'human_requested',
      node: humanRequestNode(),
      question: '如何处理？',
      source: 'progress_guard',
    });
    if (event.type !== 'human_requested') throw new Error('unreachable');
    expect(event.source).toBe('progress_guard');
  });

  it('accepts human_requested without source (legacy)', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'human_requested',
      node: humanRequestNode(),
      question: '如何处理？',
    });
    if (event.type !== 'human_requested') throw new Error('unreachable');
    expect(event.source).toBeUndefined();
  });

  it('rejects an unknown human source', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'human_requested',
        node: humanRequestNode(),
        question: '如何处理？',
        source: 'unknown',
      }),
    );
  });
});

describe('validateTaskEvent — structured slot events', () => {
  function blobRef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      kind: 'generation',
      sha256: HASH64,
      byteLength: 1024,
      ...overrides,
    };
  }

  const STRUCTURED_MEMBERS = [
    {
      name: 'structured_slot_attempt_started',
      valid: {
        inputNodeId: 'input-1',
        agentId: 'agent-1',
        attemptEpoch: 1,
        turnId: 'turn-1',
        sessionKind: 'structure',
      },
      missing: 'attemptEpoch',
    },
    {
      name: 'structured_slot_attempt_terminal',
      valid: {
        inputNodeId: 'input-1',
        attemptEpoch: 1,
        turnId: 'turn-1',
        status: 'committed',
        reason: 'completion_dispatch',
      },
      missing: 'status',
    },
    {
      name: 'structured_scaffold_generation_committed',
      valid: {
        scaffoldId: 'scaffold-1',
        generationId: 'generation-1',
        supersedesGenerationId: null,
        rootSlotId: 'slot-1',
        slotCount: 4,
        maxDepth: 3,
        structure: blobRef({ kind: 'generation' }),
        content: blobRef({ kind: 'content_revision' }),
        contentRevision: 0,
        proposalId: 'proposal-1',
      },
      missing: 'generationId',
    },
    {
      name: 'structured_fill_draft_opened',
      valid: {
        draftId: 'draft-1',
        turnId: 'turn-1',
        scaffoldId: 'scaffold-1',
        generationId: 'generation-1',
        baseRevision: 2,
      },
      missing: 'baseRevision',
    },
    {
      name: 'structured_fill_draft_terminal',
      valid: {
        draftId: 'draft-1',
        turnId: 'turn-1',
        status: 'merged',
        baseRevision: 2,
        resultRevision: 3,
        changeCount: 4,
        content: blobRef({ kind: 'content_revision' }),
      },
      missing: 'resultRevision',
    },
    {
      name: 'structured_scaffold_sealed',
      valid: {
        sealId: 'seal-1',
        scaffoldId: 'scaffold-1',
        generationId: 'generation-1',
        scaffoldRevision: 1,
        sealRecord: blobRef({ kind: 'seal_record' }),
        artifactId: 'artifact-1',
        artifactVersion: 2,
      },
      missing: 'sealRecord',
    },
  ] as const;

  for (const member of STRUCTURED_MEMBERS) {
    it(`accepts a well-formed ${member.name}`, () => {
      const { id, at } = base();
      const event = validateTaskEvent({ id, at, type: member.name, ...member.valid });
      expect(event).toMatchObject({ id, at, type: member.name, ...member.valid });
    });

    it(`rejects ${member.name} missing required field ${member.missing}`, () => {
      const { id, at } = base();
      const rest: Record<string, unknown> = { ...member.valid };
      delete rest[member.missing];
      expectInvalid(() => validateTaskEvent({ id, at, type: member.name, ...rest }));
    });

    it(`rejects ${member.name} with an unknown extra field`, () => {
      const { id, at } = base();
      expectInvalid(() =>
        validateTaskEvent({ id, at, type: member.name, ...member.valid, bogusField: 1 }),
      );
    });
  }

  it('rejects an unknown sessionKind', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'structured_slot_attempt_started',
        inputNodeId: 'input-1',
        agentId: 'agent-1',
        attemptEpoch: 1,
        turnId: 'turn-1',
        sessionKind: 'banana',
      }),
    );
  });

  it('rejects a zero attemptEpoch', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'structured_slot_attempt_started',
        inputNodeId: 'input-1',
        agentId: 'agent-1',
        attemptEpoch: 0,
        turnId: 'turn-1',
        sessionKind: 'structure',
      }),
    );
  });

  it('rejects an unknown structured attempt status', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'structured_slot_attempt_terminal',
        inputNodeId: 'input-1',
        attemptEpoch: 1,
        turnId: 'turn-1',
        status: 'teleported',
        reason: 'completion_dispatch',
      }),
    );
  });

  it('rejects an unknown structured attempt reason', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'structured_slot_attempt_terminal',
        inputNodeId: 'input-1',
        attemptEpoch: 1,
        turnId: 'turn-1',
        status: 'failed',
        reason: 'banana',
      }),
    );
  });

  it('rejects a non-zero contentRevision on a generation commit', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'structured_scaffold_generation_committed',
        scaffoldId: 'scaffold-1',
        generationId: 'generation-1',
        supersedesGenerationId: null,
        rootSlotId: 'slot-1',
        slotCount: 4,
        maxDepth: 3,
        structure: blobRef(),
        content: blobRef({ kind: 'content_revision' }),
        contentRevision: 1,
        proposalId: 'proposal-1',
      }),
    );
  });

  it('rejects a malformed blob ref sha256', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'structured_scaffold_generation_committed',
        scaffoldId: 'scaffold-1',
        generationId: 'generation-1',
        supersedesGenerationId: null,
        rootSlotId: 'slot-1',
        slotCount: 4,
        maxDepth: 3,
        structure: blobRef({ sha256: 'zz' }),
        content: blobRef({ kind: 'content_revision' }),
        contentRevision: 0,
        proposalId: 'proposal-1',
      }),
    );
  });

  it('rejects a non-positive blob byteLength', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'structured_scaffold_generation_committed',
        scaffoldId: 'scaffold-1',
        generationId: 'generation-1',
        supersedesGenerationId: null,
        rootSlotId: 'slot-1',
        slotCount: 4,
        maxDepth: 3,
        structure: blobRef({ byteLength: 0 }),
        content: blobRef({ kind: 'content_revision' }),
        contentRevision: 0,
        proposalId: 'proposal-1',
      }),
    );
  });

  it('rejects an unknown blob ref kind', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'structured_scaffold_generation_committed',
        scaffoldId: 'scaffold-1',
        generationId: 'generation-1',
        supersedesGenerationId: null,
        rootSlotId: 'slot-1',
        slotCount: 4,
        maxDepth: 3,
        structure: blobRef({ kind: 'banana' }),
        content: blobRef({ kind: 'content_revision' }),
        contentRevision: 0,
        proposalId: 'proposal-1',
      }),
    );
  });

  it('accepts a null content on a draft terminal', () => {
    const { id, at } = base();
    const event = validateTaskEvent({
      id,
      at,
      type: 'structured_fill_draft_terminal',
      draftId: 'draft-1',
      turnId: 'turn-1',
      status: 'abandoned',
      baseRevision: 2,
      resultRevision: 0,
      changeCount: 0,
      content: null,
    });
    if (event.type !== 'structured_fill_draft_terminal') throw new Error('unreachable');
    expect(event.content).toBeNull();
  });

  it('rejects an unknown draft terminal status', () => {
    const { id, at } = base();
    expectInvalid(() =>
      validateTaskEvent({
        id,
        at,
        type: 'structured_fill_draft_terminal',
        draftId: 'draft-1',
        turnId: 'turn-1',
        status: 'merged-into-main',
        baseRevision: 2,
        resultRevision: 3,
        changeCount: 4,
        content: blobRef({ kind: 'content_revision' }),
      }),
    );
  });
});

describe('normalizeLegacyEvent', () => {
  it('renames artifactVersion to inputVersion on a v1 input node', () => {
    const legacy = {
      id: 'e1',
      at: '2026-01-01T00:00:00.000Z',
      type: 'agent_input',
      node: {
        sequence: 1,
        agentId: 'reviewer',
        kind: 'input',
        title: '输入',
        body: 'b',
        status: 'confirmed',
        attemptCount: 1,
        artifactVersion: 2,
      },
    };
    const event = validateTaskEvent(normalizeLegacyEvent(legacy)) as Extract<
      TaskEvent,
      { type: 'agent_input' }
    >;
    expect(event.node.inputVersion).toBe(2);
    expect('artifactVersion' in event.node).toBe(false);
  });

  it('converts a v1 contentHash artifact_published to files[] + nulls', () => {
    const legacy = {
      id: 'e2',
      at: '2026-01-01T00:00:00.000Z',
      type: 'artifact_published',
      artifact: {
        version: 1,
        title: '产物',
        sourceNodeId: 'src',
        format: 'markdown',
        contentHash: HASH64,
      },
    };
    const event = validateTaskEvent(normalizeLegacyEvent(legacy)) as Extract<
      TaskEvent,
      { type: 'artifact_published' }
    >;
    expect(event.artifact.files).toEqual([{ name: 'content.md', hash: HASH64 }]);
    expect(event.artifact.artifactType).toBeNull();
    expect(event.artifact.artifactId).toBeNull();
    expect('contentHash' in event.artifact).toBe(false);
  });

  it('uses content.txt for a text-format legacy artifact', () => {
    const legacy = {
      id: 'e3',
      at: '2026-01-01T00:00:00.000Z',
      type: 'artifact_published',
      artifact: {
        version: 1,
        title: '产物',
        sourceNodeId: 'src',
        format: 'text',
        contentHash: HASH64,
      },
    };
    const event = validateTaskEvent(normalizeLegacyEvent(legacy)) as Extract<
      TaskEvent,
      { type: 'artifact_published' }
    >;
    expect(event.artifact.files[0].name).toBe('content.txt');
  });

  it('leaves a v7 artifact_published untouched', () => {
    const v7 = {
      id: 'e4',
      at: '2026-01-01T00:00:00.000Z',
      type: 'artifact_published',
      artifact: {
        version: 1,
        title: '产物',
        sourceNodeId: 'src',
        format: 'markdown',
        files: [{ name: 'content.md', hash: HASH64 }],
        artifactType: '终稿',
        artifactId: 'art-1',
      },
    };
    const event = validateTaskEvent(normalizeLegacyEvent(v7)) as Extract<
      TaskEvent,
      { type: 'artifact_published' }
    >;
    expect(event.artifact.files).toEqual([{ name: 'content.md', hash: HASH64 }]);
    expect(event.artifact.artifactType).toBe('终稿');
    expect(event.artifact.artifactId).toBe('art-1');
  });

  it('passes through non-event values unchanged', () => {
    expect(normalizeLegacyEvent(null)).toBeNull();
    expect(normalizeLegacyEvent('x')).toBe('x');
    expect(normalizeLegacyEvent({ type: 'task_started', id: 'e', at: 't' })).toEqual({
      type: 'task_started',
      id: 'e',
      at: 't',
    });
  });
});

describe('v1 seal-path acceptance fence (plan 2026-08-14 Task 1)', () => {
  it('keeps the structured v1 Seal path accepted end to end', () => {
    const { id, at } = base();
    // The v1 Seal path: a seal-session attempt plus the authoritative
    // scaffold seal event. Both stay accepted unchanged by the canonical
    // validator — later Contract v2 work adds new closed members and never
    // widens an existing v1 payload.
    const started = validateTaskEvent({
      id,
      at,
      type: 'structured_slot_attempt_started',
      inputNodeId: 'in-seal',
      agentId: 'seal',
      attemptEpoch: 1,
      turnId: 'turn-seal-1',
      sessionKind: 'seal',
    });
    expect(started).toMatchObject({ id, at, sessionKind: 'seal' });
    expect(validateTaskEvent(v1SealEvent)).toEqual(v1SealEvent);
  });
});
