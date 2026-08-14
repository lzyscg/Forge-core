// @vitest-environment node
/**
 * Authoritative review v2 event protocol tests (Task 7).
 *
 * Table-driven closed-union coverage for every `AuthoritativeReviewEventV2`
 * name: one legal payload plus mutations for missing required identity/ref,
 * unknown field, wrong protocol version, name-mismatched cross-attempt branch
 * fields, bare custody digest, invalid filename-safe id, and illegal
 * null/non-null rule violations. Extra matrices cover the reopenable vs
 * ineligible `structured_task_failed_v2`, `structured_task_reopened_v2`
 * recipe/track/overrideRef correlation, `structured_round_budget_override_
 * transferred_v2`, and the Map/content round-created `consumedOverrideRef`
 * null matrix.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTHORITATIVE_REVIEW_EVENT_NAMES_V2,
  validateAuthoritativeReviewEventV2,
} from './authoritative-review-events';

const AT = '2026-08-14T00:00:00.000Z';
const HASH64 = 'a'.repeat(64);
const TOKEN43 = 'A'.repeat(43);
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function base(type: string): { protocolVersion: 2; id: string; at: string; type: string } {
  return { protocolVersion: 2, id: randomUUID(), at: AT, type };
}

/** A legal BlobRefV2 of the closed registry. */
function ref(kind = 'authority_base_set'): Record<string, unknown> {
  return {
    kind,
    digest: HASH64,
    byteLength: 12,
    mediaType: 'application/json',
    schemaVersion: 1,
  };
}

function refs(count: number, kind = 'authority_base_set'): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ref(kind));
}

/** Replace every BlobRefV2-shaped value with a bare digest string (GC-test). */
function withBareRefDigest(payload: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'digest' in value &&
      typeof (value as Record<string, unknown>).kind === 'string'
    ) {
      clone[key] = HASH64;
    } else {
      clone[key] = value;
    }
  }
  return clone;
}

interface Row {
  name: string;
  /** Legal canonical payload (fresh per call). */
  make: () => Record<string, unknown>;
  /** Deletes one required identity/ref field. */
  missing: (p: Record<string, unknown>) => Record<string, unknown>;
  /** Attaches a closed-world branch field that must not appear here. */
  crossBranch: (p: Record<string, unknown>) => Record<string, unknown>;
  /** Bare digest in place of a required ref; omitted for ref-less members. */
  bareDigest?: (p: Record<string, unknown>) => Record<string, unknown>;
  /** Violates a null/non-null (or exact-one/exclusive-pair) rule. */
  nullNonNull: (p: Record<string, unknown>) => Record<string, unknown>;
  extra?: Array<{
    label: string;
    mutate: (p: Record<string, unknown>) => Record<string, unknown>;
    /** When true the mutation produces a LEGAL payload (matrix evidence, not a rejection). */
    expectValid?: true;
  }>;
}

/**
 * WorkItem identity base used by attempt/command/lifecycle members. `session`
 * selects the structured-session attempt family fields.
 */
function workIdentity(session: boolean): Record<string, unknown> {
  return {
    workItemId: 'wi-1',
    leaseEpoch: 1,
    authorityBaseRef: ref(),
    ...(session
      ? {
          logicalAssignmentId: 'la-1',
          reviewAssignmentId: null,
          attemptId: 'att-1',
          sessionKind: 'generation_batch',
        }
      : {}),
  };
}

function systemCommandIdentity(): Record<string, unknown> {
  return { commandId: 'cmd-1', workItemId: 'wi-1', commandKind: 'seal', leaseEpoch: 1, authorityBaseRef: ref() };
}

/** Every v2 event name, one open row each. */
const ROWS: Row[] = [
  {
    name: 'structured_work_item_created',
    make: () => ({
      ...base('structured_work_item_created'),
      workItemId: 'wi-1',
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      roundId: 'round-1',
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      grantSpecRef: ref('write_grant_spec'),
      inputArtifactDeliveryId: null,
      authorityBaseRef: ref(),
      payloadRef: ref('map_build_spec'),
      initialLeaseEpoch: 0,
      maxAutomaticRetries: 3,
    }),
    missing: (p) => {
      const { logicalAssignmentId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, agentExecutionKind: null }),
  },
  {
    name: 'structured_work_item_leased',
    make: () => ({
      ...base('structured_work_item_leased'),
      workItemId: 'wi-1',
      leaseEpoch: 1,
      leaseOwner: 'agent-1',
      leaseExpiresAt: '2026-08-14T00:05:00.000Z',
      expectedLastSequence: 4,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { leaseEpoch, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, leaseOwner: null }),
  },
  {
    name: 'structured_work_item_completed',
    make: () => ({ ...base('structured_work_item_completed'), ...workIdentity(false) }),
    missing: (p) => {
      const { authorityBaseRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_work_item_retryable_failed',
    make: () => ({
      ...base('structured_work_item_retryable_failed'),
      ...workIdentity(false),
      failureCode: 'PROVIDER_FLAKE',
      failureDigest: HASH64,
      retryOrdinal: 1,
      retryNotBefore: '2026-08-14T00:02:00.000Z',
      maxAutomaticRetries: 3,
      validatorAggregateRef: null,
    }),
    missing: (p) => {
      const { failureCode, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, retryOrdinal: 0 }),
  },
  {
    name: 'structured_work_item_requeued',
    make: () => ({
      ...base('structured_work_item_requeued'),
      workItemId: 'wi-1',
      leaseEpoch: 2,
      expectedLastSequence: 9,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { expectedLastSequence, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_work_item_lease_reclaimed',
    make: () => ({
      ...base('structured_work_item_lease_reclaimed'),
      workItemId: 'wi-1',
      leaseEpoch: 1,
      reason: 'lease_expired',
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { reason, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_work_item_terminal_failed',
    make: () => ({
      ...base('structured_work_item_terminal_failed'),
      workItemId: 'wi-1',
      leaseEpoch: 1,
      failureCode: 'POLICY_VIOLATION',
      failureDigest: HASH64,
      terminalAttemptId: 'att-1',
      terminalCommandId: null,
      validatorAggregateRef: null,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { terminalAttemptId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, inputArtifactDeliveryId: 'del-x' }),
    nullNonNull: (p) => ({ ...p, terminalAttemptId: null, terminalCommandId: null }),
  },
  {
    name: 'structured_work_item_superseded',
    make: () => ({
      ...base('structured_work_item_superseded'),
      workItemId: 'wi-1',
      leaseEpoch: 1,
      reason: 'new_authority_base',
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { workItemId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_work_item_parked',
    make: () => ({
      ...base('structured_work_item_parked'),
      workItemId: 'wi-1',
      leaseEpoch: 2,
      authorityBaseRef: ref(),
      parkDisposition: { kind: 'retry_budget_exhausted', retryOrdinal: 3, budgetPolicyDigest: HASH64 },
    }),
    missing: (p) => {
      const { parkDisposition, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, questionId: 'q-x' }),
    nullNonNull: (p) => ({ ...p, parkDisposition: null }),
    extra: [
      {
        label: 'human_question disposition is legal and mutually exclusive',
        expectValid: true,
        mutate: (p) => ({
          ...p,
          parkDisposition: { kind: 'human_question', questionId: 'q-1', questionVersion: TOKEN43 },
        }),
      },
      {
        label: 'budget disposition with both branches is rejected',
        mutate: (p) => ({
          ...p,
          parkDisposition: {
            kind: 'retry_budget_exhausted',
            retryOrdinal: 3,
            budgetPolicyDigest: HASH64,
            questionId: 'q-1',
          },
        }),
      },
    ],
  },
  {
    name: 'structured_work_item_resumed',
    make: () => ({
      ...base('structured_work_item_resumed'),
      workItemId: 'wi-1',
      leaseEpoch: 3,
      expectedLastSequence: 12,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { leaseEpoch, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_assignment_dispatched',
    make: () => ({
      ...base('structured_assignment_dispatched'),
      dispatchRef: ref('assignment_dispatch'),
      workItemId: 'wi-1',
      attemptId: 'att-1',
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: 'ra-1',
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_content_batch',
      inputArtifactDeliveryId: null,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { attemptId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, agentExecutionKind: null }),
  },
  {
    name: 'structured_generic_agent_attempt_started',
    make: () => ({
      ...base('structured_generic_agent_attempt_started'),
      attemptId: 'att-1',
      workItemId: 'wi-1',
      agentId: 'submitter-1',
      logicalAssignmentId: 'la-1',
      leaseEpoch: 1,
      inputArtifactDeliveryId: 'del-1',
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { inputArtifactDeliveryId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sessionKind: 'generation_batch' }),
    nullNonNull: (p) => ({ ...p, agentId: null }),
  },
  {
    name: 'structured_generic_agent_attempt_completed',
    make: () => ({
      ...base('structured_generic_agent_attempt_completed'),
      attemptId: 'att-1',
      workItemId: 'wi-1',
      agentId: 'submitter-1',
      logicalAssignmentId: 'la-1',
      leaseEpoch: 1,
      inputArtifactDeliveryId: 'del-1',
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { authorityBaseRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sessionKind: 'map_repair' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_generic_agent_attempt_retryable_failed',
    make: () => ({
      ...base('structured_generic_agent_attempt_retryable_failed'),
      attemptId: 'att-1',
      workItemId: 'wi-1',
      agentId: 'submitter-1',
      logicalAssignmentId: 'la-1',
      leaseEpoch: 1,
      inputArtifactDeliveryId: 'del-1',
      failureCode: 'PROVIDER_FLAKE',
      failureDigest: HASH64,
      retryOrdinal: 1,
      retryNotBefore: '2026-08-14T00:02:00.000Z',
      validatorAggregateRef: null,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { leaseEpoch, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sessionKind: 'generation_batch' }),
    nullNonNull: (p) => ({ ...p, retryOrdinal: 0 }),
  },
  {
    name: 'structured_generic_agent_attempt_terminal_failed',
    make: () => ({
      ...base('structured_generic_agent_attempt_terminal_failed'),
      attemptId: 'att-1',
      workItemId: 'wi-1',
      agentId: 'submitter-1',
      logicalAssignmentId: 'la-1',
      leaseEpoch: 1,
      inputArtifactDeliveryId: 'del-1',
      failureCode: 'ARTIFACT_VALIDATION_FAILED',
      failureDigest: HASH64,
      validatorAggregateRef: null,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { failureDigest, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, failureCode: '' }),
  },
  {
    name: 'structured_generic_agent_attempt_abandoned',
    make: () => ({
      ...base('structured_generic_agent_attempt_abandoned'),
      attemptId: 'att-1',
      workItemId: 'wi-1',
      agentId: 'submitter-1',
      logicalAssignmentId: 'la-1',
      leaseEpoch: 1,
      inputArtifactDeliveryId: 'del-1',
      reason: 'crash_recovery',
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { attemptId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandKind: 'seal' }),
    nullNonNull: (p) => ({ ...p, reason: 'budget_exhausted' }),
  },
  {
    name: 'structured_agent_attempt_started_v2',
    make: () => ({
      ...base('structured_agent_attempt_started_v2'),
      workItemId: 'wi-1',
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      attemptId: 'att-1',
      sessionKind: 'structure_chunk',
      leaseEpoch: 1,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { authorityBaseRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, sessionKind: null }),
  },
  {
    name: 'structured_agent_attempt_completed_v2',
    make: () => ({
      ...base('structured_agent_attempt_completed_v2'),
      workItemId: 'wi-1',
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      attemptId: 'att-1',
      sessionKind: 'structure_chunk',
      leaseEpoch: 1,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { attemptId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, inputArtifactDeliveryId: 'del-x' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_agent_attempt_retryable_failed_v2',
    make: () => ({
      ...base('structured_agent_attempt_retryable_failed_v2'),
      workItemId: 'wi-1',
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      attemptId: 'att-1',
      sessionKind: 'generation_batch',
      leaseEpoch: 1,
      failureCode: 'PROVIDER_FLAKE',
      failureDigest: HASH64,
      retryOrdinal: 1,
      retryNotBefore: '2026-08-14T00:02:00.000Z',
      validatorAggregateRef: null,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { retryNotBefore, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, retryOrdinal: 0 }),
  },
  {
    name: 'structured_agent_attempt_terminal_failed_v2',
    make: () => ({
      ...base('structured_agent_attempt_terminal_failed_v2'),
      workItemId: 'wi-1',
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      attemptId: 'att-1',
      sessionKind: 'generation_batch',
      leaseEpoch: 1,
      failureCode: 'POLICY_VIOLATION',
      failureDigest: HASH64,
      validatorAggregateRef: null,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { logicalAssignmentId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandKind: 'seal' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_agent_attempt_abandoned_v2',
    make: () => ({
      ...base('structured_agent_attempt_abandoned_v2'),
      workItemId: 'wi-1',
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      attemptId: 'att-1',
      sessionKind: 'review_map_batch',
      leaseEpoch: 1,
      reason: 'lease_expired',
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { reason, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, inputArtifactDeliveryId: 'del-x' }),
    nullNonNull: (p) => ({ ...p, sessionKind: null }),
  },
  {
    name: 'structured_system_command_started',
    make: () => ({
      ...base('structured_system_command_started'),
      ...systemCommandIdentity(),
    }),
    missing: (p) => {
      const { commandKind, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sessionKind: 'map_repair' }),
    nullNonNull: (p) => ({ ...p, commandKind: 'agent_assignment' }),
  },
  {
    name: 'structured_system_command_completed',
    make: () => ({
      ...base('structured_system_command_completed'),
      ...systemCommandIdentity(),
    }),
    missing: (p) => {
      const { leaseEpoch, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_system_command_retryable_failed',
    make: () => ({
      ...base('structured_system_command_retryable_failed'),
      ...systemCommandIdentity(),
      failureCode: 'PROVIDER_FLAKE',
      failureDigest: HASH64,
      retryOrdinal: 1,
      retryNotBefore: '2026-08-14T00:02:00.000Z',
      validatorAggregateRef: ref('validator_aggregate'),
    }),
    missing: (p) => {
      const { validatorAggregateRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, retryOrdinal: 0 }),
  },
  {
    name: 'structured_system_command_terminal_failed',
    make: () => ({
      ...base('structured_system_command_terminal_failed'),
      ...systemCommandIdentity(),
      failureCode: 'ASSEMBLER_UNAVAILABLE',
      failureDigest: HASH64,
      validatorAggregateRef: null,
    }),
    missing: (p) => {
      const { commandId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sessionKind: 'map_repair' }),
    nullNonNull: (p) => ({ ...p, failureDigest: 'not-a-digest' }),
  },
  {
    name: 'structured_system_command_abandoned',
    make: () => ({
      ...base('structured_system_command_abandoned'),
      ...systemCommandIdentity(),
      reason: 'operator_interrupt',
    }),
    missing: (p) => {
      const { reason, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sessionKind: 'map_repair' }),
    nullNonNull: (p) => ({ ...p, commandKind: 'seal_input' }),
  },
  {
    name: 'structured_seal_validation_rejected_v2',
    make: () => ({
      ...base('structured_seal_validation_rejected_v2'),
      sealWorkItemId: 'wi-9',
      stage: 'input',
      validatorAggregateRef: ref('validator_aggregate'),
      validationReceiptRef: ref('validation_receipt'),
    }),
    missing: (p) => {
      const { validationReceiptRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, artifactId: 'art-x' }),
    nullNonNull: (p) => ({ ...p, stage: 'finalize' }),
  },
  {
    name: 'structured_map_build_started',
    make: () => ({
      ...base('structured_map_build_started'),
      mapBuildId: 'mb-1',
      revision: 1,
      mapBuildSpecRef: ref('map_build_spec'),
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    }),
    missing: (p) => {
      const { mapBuildSpecRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, activeMapRef: ref('map_snapshot') }),
    nullNonNull: (p) => ({ ...p, revision: 0 }),
  },
  {
    name: 'structured_map_chunk_committed',
    make: () => ({
      ...base('structured_map_chunk_committed'),
      mapBuildId: 'mb-1',
      chunkId: 'ch-1',
      chunkOrdinal: 1,
      chunkRef: ref('map_build_chunk'),
      parentFrontierDigest: HASH64,
    }),
    missing: (p) => {
      const { chunkRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, candidateRef: ref('map_candidate') }),
    nullNonNull: (p) => ({ ...p, chunkOrdinal: 0 }),
  },
  {
    name: 'structured_map_build_finish_proposed',
    make: () => ({
      ...base('structured_map_build_finish_proposed'),
      mapBuildId: 'mb-1',
      expectedChunkCount: 4,
      expectedFrontierDigest: HASH64,
      expectedRootCount: 2,
    }),
    missing: (p) => {
      const { expectedChunkCount, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, chunkRef: ref('map_build_chunk') }),
    nullNonNull: (p) => ({ ...p, expectedRootCount: 0 }),
  },
  {
    name: 'structured_map_build_rejected',
    make: () => ({
      ...base('structured_map_build_rejected'),
      mapBuildId: 'mb-1',
      validatorAggregateRef: ref('validator_aggregate'),
      validationReceiptRef: ref('validation_receipt'),
    }),
    missing: (p) => {
      const { validatorAggregateRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, candidateId: 'c-x' }),
    nullNonNull: (p) => ({ ...p, validatorAggregateRef: null }),
  },
  {
    name: 'structured_map_build_finalized',
    make: () => ({
      ...base('structured_map_build_finalized'),
      mapBuildId: 'mb-1',
      manifestRef: ref('map_build_manifest'),
      contributionManifestRef: ref('contribution_manifest'),
    }),
    missing: (p) => {
      const { contributionManifestRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, contributionManifestRef: null }),
  },
  {
    name: 'structured_map_candidate_committed',
    make: () => ({
      ...base('structured_map_candidate_committed'),
      candidateId: 'cand-1',
      candidateRef: ref('map_candidate'),
      candidateDigest: HASH64,
      baseMapId: null,
    }),
    missing: (p) => {
      const { candidateRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, mapSnapshotRef: ref('map_snapshot') }),
    nullNonNull: (p) => ({ ...p, candidateDigest: 'zz' }),
    extra: [
      {
        label: 'display digest must equal the candidate ref digest',
        mutate: (p) => ({ ...p, candidateRef: ref('map_candidate'), candidateDigest: 'b'.repeat(64) }),
      },
    ],
  },
  {
    name: 'structured_generation_plan_started',
    make: () => ({
      ...base('structured_generation_plan_started'),
      generationPlanId: 'gp-1',
      revision: 1,
      supersedesGenerationPlanId: null,
      generationPlanSpecRef: ref('generation_plan_spec'),
      sourceValidationReceiptRef: null,
    }),
    missing: (p) => {
      const { generationPlanSpecRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, stagedCandidateRef: ref('map_candidate') }),
    nullNonNull: (p) => ({ ...p, revision: 0 }),
  },
  {
    name: 'structured_generation_batch_committed',
    make: () => ({
      ...base('structured_generation_batch_committed'),
      generationPlanId: 'gp-1',
      batchOrdinal: 1,
      contentRevisionCommitCoreRef: ref('content_revision_commit_core'),
      validatorAggregateRef: ref('validator_aggregate'),
      contentRevisionManifestRef: ref('content_revision_manifest'),
    }),
    missing: (p) => {
      const { contentRevisionManifestRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, repairPlanSpecRef: ref('repair_plan_spec') }),
    nullNonNull: (p) => ({ ...p, contentRevisionCommitCoreRef: null }),
  },
  {
    name: 'structured_generation_plan_rejected',
    make: () => ({
      ...base('structured_generation_plan_rejected'),
      generationPlanId: 'gp-1',
      validatorAggregateRef: ref('validator_aggregate'),
      validationReceiptRef: ref('validation_receipt'),
    }),
    missing: (p) => {
      const { validationReceiptRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, contentRevisionManifestRef: ref('content_revision_manifest') }),
    nullNonNull: (p) => ({ ...p, validationReceiptRef: null }),
  },
  {
    name: 'structured_generation_plan_completed',
    make: () => ({
      ...base('structured_generation_plan_completed'),
      generationPlanId: 'gp-1',
      contentRevisionManifestRef: ref('content_revision_manifest'),
      validatorAggregateRef: ref('validator_aggregate'),
      warningRootRef: ref('validation_warning_root'),
    }),
    missing: (p) => {
      const { validatorAggregateRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandKind: 'seal' }),
    nullNonNull: (p) => ({ ...p, contentRevisionManifestRef: null }),
  },
  {
    name: 'structured_migration_validation_plan_started',
    make: () => ({
      ...base('structured_migration_validation_plan_started'),
      migrationValidationPlanId: 'mvp-1',
      intentCoreRef: ref('migration_intent_core'),
      planSpecRef: ref('migration_validation_plan_spec'),
    }),
    missing: (p) => {
      const { planSpecRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, settlementCoreRef: ref('migration_settlement_core') }),
    nullNonNull: (p) => ({ ...p, intentCoreRef: null }),
  },
  {
    name: 'structured_migration_validation_batch_completed',
    make: () => ({
      ...base('structured_migration_validation_batch_completed'),
      planSpecRef: ref('migration_validation_plan_spec'),
      batchOrdinal: 0,
      batchResultRootRef: ref('migration_validation_batch_result'),
      batchOutcome: 'clear',
    }),
    missing: (p) => {
      const { batchResultRootRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, settlementCoreRef: ref('migration_settlement_core') }),
    nullNonNull: (p) => ({ ...p, batchOutcome: 'unknown' }),
  },
  {
    name: 'structured_migration_validation_settlement_completed',
    make: () => ({
      ...base('structured_migration_validation_settlement_completed'),
      settlementCoreRef: ref('migration_settlement_core'),
      provisionalManifestRef: ref('content_revision_manifest'),
      finalizerAggregateRef: ref('validator_aggregate'),
      activationDecisionRef: ref('migration_activation_decision'),
    }),
    missing: (p) => {
      const { activationDecisionRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, candidateRef: ref('map_candidate') }),
    nullNonNull: (p) => ({ ...p, finalizerAggregateRef: null }),
  },
  {
    name: 'structured_map_repair_plan_started',
    make: () => ({
      ...base('structured_map_repair_plan_started'),
      repairPlanId: 'rp-1',
      planRevisionId: 'rp-1-r1',
      repairPlanSpecRef: ref('repair_plan_spec'),
      sourceValidationReceiptRef: null,
    }),
    missing: (p) => {
      const { repairPlanSpecRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, generationPlanSpecRef: ref('generation_plan_spec') }),
    nullNonNull: (p) => ({ ...p, planRevisionId: '' }),
  },
  {
    name: 'structured_map_repair_batch_committed',
    make: () => ({
      ...base('structured_map_repair_batch_committed'),
      repairPlanId: 'rp-1',
      planRevisionId: 'rp-1-r1',
      batchOrdinal: 1,
      stagingRootRef: ref('repair_staging_root'),
    }),
    missing: (p) => {
      const { stagingRootRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, candidateRef: ref('map_candidate') }),
    nullNonNull: (p) => ({ ...p, batchOrdinal: 0 }),
  },
  {
    name: 'structured_map_repair_plan_rejected',
    make: () => ({
      ...base('structured_map_repair_plan_rejected'),
      repairPlanId: 'rp-1',
      planRevisionId: 'rp-1-r1',
      validatorAggregateRef: ref('validator_aggregate'),
      validationReceiptRef: ref('validation_receipt'),
    }),
    missing: (p) => {
      const { repairPlanId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, contributionManifestRef: ref('contribution_manifest') }),
    nullNonNull: (p) => ({ ...p, validationReceiptRef: null }),
  },
  {
    name: 'structured_content_repair_plan_started',
    make: () => ({
      ...base('structured_content_repair_plan_started'),
      repairPlanId: 'rp-2',
      planRevisionId: 'rp-2-r1',
      repairPlanSpecRef: ref('repair_plan_spec'),
      sourceValidationReceiptRef: null,
    }),
    missing: (p) => {
      const { planRevisionId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, intentCoreRef: ref('migration_intent_core') }),
    nullNonNull: (p) => ({ ...p, repairPlanSpecRef: null }),
  },
  {
    name: 'structured_content_repair_batch_committed',
    make: () => ({
      ...base('structured_content_repair_batch_committed'),
      repairPlanId: 'rp-2',
      planRevisionId: 'rp-2-r1',
      batchOrdinal: 1,
      stagingRootRef: ref('repair_staging_root'),
    }),
    missing: (p) => {
      const { batchOrdinal, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, contentRevisionManifestRef: ref('content_revision_manifest') }),
    nullNonNull: (p) => ({ ...p, stagingRootRef: null }),
  },
  {
    name: 'structured_content_repair_plan_rejected',
    make: () => ({
      ...base('structured_content_repair_plan_rejected'),
      repairPlanId: 'rp-2',
      planRevisionId: 'rp-2-r1',
      validatorAggregateRef: ref('validator_aggregate'),
      validationReceiptRef: ref('validation_receipt'),
    }),
    missing: (p) => {
      const { validatorAggregateRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, warningRootRef: ref('validation_warning_root') }),
    nullNonNull: (p) => ({ ...p, validatorAggregateRef: null }),
  },
  {
    name: 'structured_repair_plan_revision_started',
    make: () => ({
      ...base('structured_repair_plan_revision_started'),
      repairPlanId: 'rp-2',
      planRevisionId: 'rp-2-r2',
      repairPlanSpecRef: ref('repair_plan_spec'),
      supersedesPlanRevisionId: 'rp-2-r1',
      successorReason: 'scope_expansion',
    }),
    missing: (p) => {
      const { repairPlanSpecRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandKind: 'repair_finalize' }),
    nullNonNull: (p) => ({ ...p, supersedesPlanRevisionId: null, successorReason: 'scope_expansion' }),
  },
  {
    name: 'structured_task_failed_v2',
    make: () => ({
      ...base('structured_task_failed_v2'),
      workItemId: 'wi-1',
      attemptId: 'att-1',
      commandId: null,
      leaseEpoch: 1,
      failureCode: 'REVIEW_REPAIR_LIMIT_EXCEEDED',
      failureDigest: HASH64,
      failureRecoveryPayloadRef: ref('failure_recovery_payload'),
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { workItemId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sessionKind: 'map_repair' }),
    nullNonNull: (p) => ({ ...p, attemptId: null, commandId: null }),
    extra: [
      {
        label: 'ineligible failure must carry a null recovery payload ref',
        expectValid: true,
        mutate: (p) => ({
          ...p,
          failureCode: 'ARTIFACT_VALIDATION_FAILED',
          attemptId: null,
          commandId: 'cmd-1',
          failureRecoveryPayloadRef: null,
        }),
      },
      {
        label: 'the recovery payload ref field must be explicitly present',
        mutate: (p) => {
          const { failureRecoveryPayloadRef, ...rest } = p;
          return rest;
        },
      },
      {
        label: 'attempt and command branches are exclusive',
        mutate: (p) => ({ ...p, attemptId: 'att-1', commandId: 'cmd-1' }),
      },
    ],
  },
  {
    name: 'structured_task_reopened_v2',
    make: () => ({
      ...base('structured_task_reopened_v2'),
      expectedLastSequence: 40,
      operationId: UUID,
      operatorId: 'task_owner',
      reason: '按冻结恢复配方重开',
      recipeKey: 'restart_content_review_cycle',
      track: 'content',
      failureRecoveryPayloadRef: ref('failure_recovery_payload'),
      overrideRef: ref('round_budget_override'),
    }),
    missing: (p) => {
      const { reason, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, consumedOverrideRef: ref('round_budget_override') }),
    nullNonNull: (p) => ({ ...p, overrideRef: null }),
    extra: [
      {
        label: 'map restart recipe requires track=map and overrideRef',
        expectValid: true,
        mutate: (p) => ({
          ...p,
          recipeKey: 'restart_map_review_cycle',
          track: 'map',
          overrideRef: ref('round_budget_override'),
        }),
      },
      {
        label: 'map restart recipe rejects track=content',
        mutate: (p) => ({ ...p, recipeKey: 'restart_map_review_cycle', track: 'content' }),
      },
      {
        label: 'retry_system_command requires track=null and overrideRef=null',
        expectValid: true,
        mutate: (p) => ({
          ...p,
          recipeKey: 'retry_system_command',
          track: null,
          overrideRef: null,
        }),
      },
      {
        label: 'retry_system_command rejects an overrideRef',
        mutate: (p) => ({
          ...p,
          recipeKey: 'retry_system_command',
          track: null,
          overrideRef: ref('round_budget_override'),
        }),
      },
      {
        label: 'round-limit recipe rejects missing overrideRef',
        mutate: (p) => ({ ...p, recipeKey: 'restart_map_review_cycle', track: 'map', overrideRef: null }),
      },
      {
        label: 'rebuild_missing_work permits a stored track with no override',
        expectValid: true,
        mutate: (p) => ({
          ...p,
          recipeKey: 'rebuild_missing_work',
          track: 'map',
          overrideRef: null,
        }),
      },
      {
        label: 'rebuild_missing_work with null track is legal',
        expectValid: true,
        mutate: (p) => ({
          ...p,
          recipeKey: 'rebuild_missing_work',
          track: null,
          overrideRef: null,
        }),
      },
      {
        label: 'rebuild_missing_work never carries an override',
        mutate: (p) => ({
          ...p,
          recipeKey: 'rebuild_missing_work',
          track: 'map',
          overrideRef: ref('round_budget_override'),
        }),
      },
      {
        label: 'reopen always requires the recovery payload ref',
        mutate: (p) => ({ ...p, failureRecoveryPayloadRef: null }),
      },
      {
        label: 'operation id must be a UUID v4',
        mutate: (p) => ({ ...p, operationId: 'not-a-uuid' }),
      },
    ],
  },
  {
    name: 'structured_task_retry_resumed_v2',
    make: () => ({
      ...base('structured_task_retry_resumed_v2'),
      workItemId: 'wi-1',
      leaseEpoch: 4,
      expectedLastSequence: 13,
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { workItemId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, leaseEpoch: 0 }),
  },
  {
    name: 'structured_task_suspension_applied_v2',
    make: () => ({
      ...base('structured_task_suspension_applied_v2'),
      suspensionId: 'sus-1',
      reason: 'user_stop',
      operationId: 'op-1',
    }),
    missing: (p) => {
      const { suspensionId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, workItemId: 'wi-x' }),
    nullNonNull: (p) => ({ ...p, reason: 'operator_pause' }),
  },
  {
    name: 'structured_task_suspension_cleared_v2',
    make: () => ({
      ...base('structured_task_suspension_cleared_v2'),
      suspensionId: 'sus-1',
      operationId: 'op-2',
    }),
    missing: (p) => {
      const { operationId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, suspensionReason: 'user_stop' }),
    nullNonNull: (p) => ({ ...p, suspensionId: '' }),
  },
  {
    name: 'structured_human_question_opened_v2',
    make: () => ({
      ...base('structured_human_question_opened_v2'),
      questionId: 'q-1',
      questionVersion: TOKEN43,
      questionDigest: HASH64,
      originalWorkItemId: 'wi-1',
      attemptId: 'att-1',
      leaseEpoch: 1,
      logicalAssignmentId: 'la-1',
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { questionVersion, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandKind: 'seal' }),
    nullNonNull: (p) => ({ ...p, questionVersion: 'short' }),
  },
  {
    name: 'structured_human_answer_delivered_v2',
    make: () => ({
      ...base('structured_human_answer_delivered_v2'),
      deliveryId: 'dl-1',
      questionId: 'q-1',
      questionVersion: TOKEN43,
      originalWorkItemId: 'wi-1',
      replacementWorkItemId: 'wi-2',
      logicalAssignmentId: 'la-1',
      answerDigest: HASH64,
      operationId: 'op-3',
      authorityBaseRef: ref(),
    }),
    missing: (p) => {
      const { replacementWorkItemId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sessionKind: 'generation_batch' }),
    nullNonNull: (p) => ({ ...p, answerDigest: 'not-a-digest' }),
  },
  {
    name: 'artifact_published_v2',
    make: () => ({
      ...base('artifact_published_v2'),
      artifactId: 'art-1',
      artifactVersion: 3,
      deliveryRef: ref('system_artifact_delivery'),
      files: [{ name: 'artifact.json', hash: HASH64 }],
      mediaType: 'application/json',
      provenance: {
        producerKind: 'system',
        producerWorkItemId: 'wi-9',
        sealRecordRef: ref('seal_record'),
        artifactRef: ref('artifact'),
        custodyRef: ref('seal_validation_bundle'),
      },
    }),
    missing: (p) => {
      const { deliveryRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sourceNodeId: 'node-1' }),
    bareDigest: (p) => ({ ...p, deliveryRef: HASH64 }),
    nullNonNull: (p) => ({ ...p, files: [] }),
    extra: [
      {
        label: 'file hash must be a SHA-256 hex digest',
        mutate: (p) => ({ ...p, files: [{ name: 'a.json', hash: 'zz' }] }),
      },
      {
        label: 'file entries reject unknown keys',
        mutate: (p) => ({ ...p, files: [{ name: 'a.json', hash: HASH64, path: '/tmp' }] }),
      },
      {
        label: 'agent provenance branch is forbidden on the v2 member',
        mutate: (p) => ({
          ...p,
          provenance: { producerKind: 'agent', sourceNodeId: 'n-1', producerAgentId: 'a-1' },
        }),
      },
    ],
  },
  {
    name: 'structured_system_artifact_delivery_created',
    make: () => ({
      ...base('structured_system_artifact_delivery_created'),
      deliveryId: 'dl-9',
      deliveryRef: ref('system_artifact_delivery'),
      artifactId: 'art-1',
      artifactRef: ref('artifact'),
      sealRecordRef: ref('seal_record'),
      submitterWorkItemId: 'wi-10',
    }),
    missing: (p) => {
      const { deliveryRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, artifactVersion: 3 }),
    nullNonNull: (p) => ({ ...p, submitterWorkItemId: null }),
  },
  {
    name: 'structured_map_review_round_planned',
    make: () => ({
      ...base('structured_map_review_round_planned'),
      mapReviewRoundId: 'mrr-1',
      mapCycleOrdinal: 1,
      candidateId: 'cand-1',
      candidateRef: ref('map_candidate'),
      contentRevisionManifestRef: null,
      reviewPolicyDigest: HASH64,
      coverageNodeCount: 24,
      coverageRelationCount: 0,
      assignmentCount: 2,
      consumedOverrideRef: null,
    }),
    missing: (p) => {
      const { candidateRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, mapSnapshotRef: ref('map_snapshot') }),
    nullNonNull: (p) => ({ ...p, mapCycleOrdinal: 0 }),
    extra: [
      {
        label: 'consumedOverrideRef is legal when an override was consumed',
        expectValid: true,
        mutate: (p) => ({ ...p, consumedOverrideRef: ref('round_budget_override') }),
      },
    ],
  },
  {
    name: 'structured_map_review_assignment_committed',
    make: () => ({
      ...base('structured_map_review_assignment_committed'),
      assignmentId: 'asg-1',
      mapReviewRoundId: 'mrr-1',
      workItemId: 'wi-3',
      attemptId: 'att-3',
      reviewAssignmentId: 'ra-1',
      source: 'batch',
      ledgerRef: ref('review_assignment_ledger'),
      coverageTargetCount: 16,
      findingCount: 2,
    }),
    missing: (p) => {
      const { ledgerRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, source: 'whole_tree_observation' }),
  },
  {
    name: 'structured_map_observation_recorded',
    make: () => ({
      ...base('structured_map_observation_recorded'),
      observationId: 'obs-1',
      mapReviewRoundId: 'mrr-1',
      level: 1,
      parentObservationId: null,
      observationRef: ref('review_assignment_ledger'),
      coveredTargetCount: 10,
      childObservationRefs: refs(2, 'review_assignment_ledger'),
    }),
    missing: (p) => {
      const { observationRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, wholeMapObservationRef: ref('review_assignment_ledger') }),
    nullNonNull: (p) => ({ ...p, parentObservationId: 'obs-0' }),
    extra: [
      {
        label: 'child observations must be valid refs',
        mutate: (p) => ({ ...p, childObservationRefs: [{ kind: 'review_assignment_ledger' }] }),
      },
    ],
  },
  {
    name: 'structured_map_review_round_completed',
    make: () => ({
      ...base('structured_map_review_round_completed'),
      mapReviewRoundId: 'mrr-1',
      coverageCoreRef: ref('map_review_coverage_core'),
    }),
    missing: (p) => {
      const { mapReviewRoundId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, adoptionRootRef: ref('review_adoption_root') }),
    nullNonNull: (p) => ({ ...p, coverageCoreRef: null }),
  },
  {
    name: 'structured_map_review_round_settled',
    make: () => ({
      ...base('structured_map_review_round_settled'),
      mapReviewRoundId: 'mrr-1',
      settlementCoreRef: ref('map_review_settlement_core'),
      outcome: 'map_repair',
    }),
    missing: (p) => {
      const { settlementCoreRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, reviewBundleRef: ref('review_bundle') }),
    nullNonNull: (p) => ({ ...p, outcome: 'repair' }),
  },
  {
    name: 'structured_map_activated',
    make: () => ({
      ...base('structured_map_activated'),
      mapId: 'map-1',
      mapRevision: 1,
      supersedesMapId: null,
      mapSnapshotRef: ref('map_snapshot'),
      mapReviewBundleRef: ref('map_review_bundle'),
      mapSemanticDigest: HASH64,
      contentRevisionManifestRef: ref('content_revision_manifest'),
      activationValidatorAggregateRef: ref('validator_aggregate'),
      migrationSettlementCoreRef: null,
      migrationActivationDecisionRef: null,
    }),
    missing: (p) => {
      const { mapReviewBundleRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, candidateRef: ref('map_candidate') }),
    nullNonNull: (p) => ({
      ...p,
      migrationSettlementCoreRef: ref('migration_settlement_core'),
      migrationActivationDecisionRef: null,
    }),
  },
  {
    name: 'structured_content_revision_committed',
    make: () => ({
      ...base('structured_content_revision_committed'),
      contentRevisionManifestRef: ref('content_revision_manifest'),
      taskContentRevision: 1,
      manifestPhase: 'provisional',
      producerPlanSpecRef: ref('generation_plan_spec'),
      priorManifestRef: null,
    }),
    missing: (p) => {
      const { contentRevisionManifestRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, systemPayloadRef: ref('content_revision_commit_core') }),
    nullNonNull: (p) => ({ ...p, taskContentRevision: 0 }),
  },
  {
    name: 'structured_review_round_planned',
    make: () => ({
      ...base('structured_review_round_planned'),
      reviewRoundId: 'rr-1',
      contentCycleOrdinal: 1,
      mapRef: ref('map_snapshot'),
      mapSemanticDigest: HASH64,
      contentRevisionManifestRef: ref('content_revision_manifest'),
      reviewPolicyDigest: HASH64,
      adoptionRootRef: ref('review_adoption_root'),
      coverageSlotCount: 24,
      coverageRelationCount: 0,
      assignmentCount: 2,
      verificationFindingCount: 1,
      consumedOverrideRef: null,
    }),
    missing: (p) => {
      const { adoptionRootRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, candidateId: 'cand-x' }),
    nullNonNull: (p) => ({ ...p, contentCycleOrdinal: 0 }),
    extra: [
      {
        label: 'consumedOverrideRef is legal when an override was consumed',
        expectValid: true,
        mutate: (p) => ({ ...p, consumedOverrideRef: ref('round_budget_override') }),
      },
    ],
  },
  {
    name: 'structured_review_assignment_started',
    make: () => ({
      ...base('structured_review_assignment_started'),
      assignmentId: 'asg-2',
      reviewRoundId: 'rr-1',
      workItemId: 'wi-4',
      attemptId: 'att-4',
      reviewAssignmentId: 'ra-2',
      source: 'batch',
    }),
    missing: (p) => {
      const { attemptId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, source: 'whole_map_observation' }),
  },
  {
    name: 'structured_content_review_assignment_committed',
    make: () => ({
      ...base('structured_content_review_assignment_committed'),
      assignmentId: 'asg-2',
      reviewRoundId: 'rr-1',
      workItemId: 'wi-4',
      attemptId: 'att-4',
      reviewAssignmentId: 'ra-2',
      source: 'batch',
      ledgerRef: ref('review_assignment_ledger'),
      coverageTargetCount: 16,
      findingCount: 2,
    }),
    missing: (p) => {
      const { coverageTargetCount, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandKind: 'seal' }),
    nullNonNull: (p) => ({ ...p, ledgerRef: null }),
  },
  {
    name: 'structured_finding_opened',
    make: () => ({
      ...base('structured_finding_opened'),
      findingId: 'f-1',
      findingRef: ref('finding'),
      reviewContext: { kind: 'content', roundId: 'rr-1' },
      primaryLocation: { kind: 'slot', id: 'slot-1' },
      defectClass: 'content',
      severity: 'blocking',
      source: 'reviewer',
      openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-4' },
    }),
    missing: (p) => {
      const { findingRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, validatorAggregateRef: ref('validator_aggregate') }),
    nullNonNull: (p) => ({ ...p, defectClass: 'seal' }),
    extra: [
      {
        label: 'system_validator source requires the validator execution identity',
        expectValid: true,
        mutate: (p) => ({
          ...p,
          source: 'system_validator',
          openedBy: { kind: 'system_validator', validatorExecutionId: 'vex-1' },
        }),
      },
      {
        label: 'reviewer and validator openedBy branches cannot be mixed',
        mutate: (p) => ({
          ...p,
          openedBy: { kind: 'reviewer', validatorExecutionId: 'vex-1' },
        }),
      },
      {
        label: 'reviewer source cannot impersonate a validator execution identity',
        mutate: (p) => ({
          ...p,
          source: 'reviewer',
          openedBy: { kind: 'system_validator', validatorExecutionId: 'vex-1' },
        }),
      },
      {
        label: 'system_validator source cannot impersonate a reviewer attempt',
        mutate: (p) => ({
          ...p,
          source: 'system_validator',
          openedBy: { kind: 'reviewer', reviewerAttemptId: 'att-4' },
        }),
      },
    ],
  },
  {
    name: 'structured_finding_verification_recorded',
    make: () => ({
      ...base('structured_finding_verification_recorded'),
      recordId: 'vr-1',
      recordRef: ref('finding_verification_record'),
      findingId: 'f-1',
      reviewContext: { kind: 'content', roundId: 'rr-1' },
      assignmentId: 'asg-2',
      repairStage: 'content',
      verdict: 'resolved',
    }),
    missing: (p) => {
      const { verdict, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, validatorExecutionId: 'vex-x' }),
    nullNonNull: (p) => ({ ...p, repairStage: 'map', verdict: 'passed' }),
  },
  {
    name: 'structured_validator_finding_verification_recorded',
    make: () => ({
      ...base('structured_validator_finding_verification_recorded'),
      recordId: 'vr-2',
      recordRef: ref('finding_verification_record'),
      findingId: 'f-2',
      reviewContext: { kind: 'map', roundId: 'mrr-1' },
      repairStage: 'map',
      verdict: 'still_present',
      validatorExecutionId: 'vex-1',
      validatorAggregateRef: ref('validator_aggregate'),
      validationReceiptRef: null,
    }),
    missing: (p) => {
      const { validatorAggregateRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, reviewerAttemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, verdict: 'passed' }),
  },
  {
    name: 'structured_review_assignment_completed',
    make: () => ({
      ...base('structured_review_assignment_completed'),
      assignmentId: 'asg-2',
      reviewRoundId: 'rr-1',
      workItemId: 'wi-4',
      attemptId: 'att-4',
      ledgerRef: ref('review_assignment_ledger'),
      source: 'batch',
    }),
    missing: (p) => {
      const { ledgerRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, source: 'whole_map_observation' }),
  },
  {
    name: 'structured_whole_tree_observation_recorded',
    make: () => ({
      ...base('structured_whole_tree_observation_recorded'),
      observationId: 'obs-2',
      reviewRoundId: 'rr-1',
      level: 1,
      parentObservationId: null,
      observationRef: ref('review_assignment_ledger'),
      coveredTargetCount: 10,
      childObservationRefs: [],
    }),
    missing: (p) => {
      const { coveredTargetCount, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, mapReviewRoundId: 'mrr-x' }),
    nullNonNull: (p) => ({ ...p, level: 0 }),
  },
  {
    name: 'structured_review_round_completed',
    make: () => ({
      ...base('structured_review_round_completed'),
      reviewRoundId: 'rr-1',
      coverageCoreRef: ref('content_review_coverage_core'),
    }),
    missing: (p) => {
      const { reviewRoundId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, mapReviewRoundId: 'mrr-x' }),
    nullNonNull: (p) => ({ ...p, coverageCoreRef: null }),
  },
  {
    name: 'structured_review_round_settled',
    make: () => ({
      ...base('structured_review_round_settled'),
      reviewRoundId: 'rr-1',
      settlementCoreRef: ref('content_review_settlement_core'),
      outcome: 'seal',
    }),
    missing: (p) => {
      const { settlementCoreRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, mapReviewRoundId: 'mrr-x' }),
    nullNonNull: (p) => ({ ...p, outcome: 'map_repair' }),
  },
  {
    name: 'structured_repair_scope_requested',
    make: () => ({
      ...base('structured_repair_scope_requested'),
      requestId: 'rs-1',
      repairPlanId: 'rp-1',
      planRevisionId: 'rp-1-r1',
      track: 'map',
      findingIds: ['f-1'],
      requestedNodeIds: ['node-2'],
      requestedRelationIds: [],
      requestedSlotIds: [],
      reason: '缺少跨槽依赖约束',
    }),
    missing: (p) => {
      const { findingIds, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandKind: 'seal' }),
    nullNonNull: (p) => ({ ...p, track: 'map', requestedSlotIds: ['slot-1'] }),
    extra: [
      {
        label: 'content track requests slot ids only',
        expectValid: true,
        mutate: (p) => ({
          ...p,
          track: 'content',
          requestedNodeIds: [],
          requestedRelationIds: [],
          requestedSlotIds: ['slot-1'],
        }),
      },
      {
        label: 'map track may name relations instead of nodes',
        expectValid: true,
        mutate: (p) => ({ ...p, requestedNodeIds: [], requestedRelationIds: ['rel-1'] }),
      },
    ],
  },
  {
    name: 'structured_repair_scope_expansion_approved_v2',
    make: () => ({
      ...base('structured_repair_scope_expansion_approved_v2'),
      requestId: 'rs-1',
      repairPlanId: 'rp-1',
      supersededPlanRevisionId: 'rp-1-r1',
      successorPlanRevisionId: 'rp-1-r2',
      successorPlanSpecRef: ref('repair_plan_spec'),
    }),
    missing: (p) => {
      const { successorPlanSpecRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, successorPlanRevisionId: '' }),
  },
  {
    name: 'structured_repair_scope_expansion_rejected_v2',
    make: () => ({
      ...base('structured_repair_scope_expansion_rejected_v2'),
      requestId: 'rs-1',
      repairPlanId: 'rp-1',
      planRevisionId: 'rp-1-r1',
      reason: '证据不足',
    }),
    missing: (p) => {
      const { reason, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, sessionKind: 'map_repair' }),
    nullNonNull: (p) => ({ ...p, planRevisionId: '' }),
  },
  {
    name: 'structured_repair_grant_issued',
    make: () => ({
      ...base('structured_repair_grant_issued'),
      grantSpecRef: ref('write_grant_spec'),
      grantSpecId: 'gs-1',
      workItemId: 'wi-5',
      grantKind: 'map_repair_batch',
    }),
    missing: (p) => {
      const { grantSpecRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, attemptId: 'att-x' }),
    nullNonNull: (p) => ({ ...p, grantKind: 'initial_seal_grant' }),
  },
  {
    name: 'structured_repair_committed',
    make: () => ({
      ...base('structured_repair_committed'),
      repairPlanId: 'rp-1',
      planRevisionId: 'rp-1-r1',
      batchOrdinal: 1,
      workItemId: 'wi-5',
      attemptId: 'att-5',
      stagingRootRef: ref('repair_staging_root'),
    }),
    missing: (p) => {
      const { stagingRootRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandKind: 'repair_finalize' }),
    nullNonNull: (p) => ({ ...p, batchOrdinal: 0 }),
  },
  {
    name: 'structured_finding_addressed',
    make: () => ({
      ...base('structured_finding_addressed'),
      findingId: 'f-1',
      repairStage: 'content',
      repairPlanId: 'rp-2',
    }),
    missing: (p) => {
      const { findingId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, commandId: 'cmd-x' }),
    nullNonNull: (p) => ({ ...p, repairStage: 'seal' }),
  },
  {
    name: 'structured_finding_verified_closed',
    make: () => ({ ...base('structured_finding_verified_closed'), findingId: 'f-1' }),
    missing: (p) => {
      const { findingId, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, repairStage: 'map' }),
    nullNonNull: (p) => ({ ...p, findingId: '' }),
  },
  {
    name: 'structured_scaffold_sealed_v2',
    make: () => ({
      ...base('structured_scaffold_sealed_v2'),
      sealWorkItemId: 'wi-9',
      sealRecordRef: ref('seal_record'),
      sealValidationBundleRef: ref('seal_validation_bundle'),
      mapRef: ref('map_snapshot'),
      contentRevisionManifestRef: ref('content_revision_manifest'),
      reviewBundleRef: ref('review_bundle'),
      artifactRef: ref('artifact'),
    }),
    missing: (p) => {
      const { sealRecordRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, artifactVersion: 3 }),
    nullNonNull: (p) => ({ ...p, artifactRef: null }),
  },
  {
    name: 'structured_round_budget_override_transferred_v2',
    make: () => ({
      ...base('structured_round_budget_override_transferred_v2'),
      overrideRef: ref('round_budget_override'),
      fromRepairPlanRef: ref('repair_plan_spec'),
      toRepairPlanRef: ref('repair_plan_spec'),
      transferOperationId: 'op-4',
    }),
    missing: (p) => {
      const { overrideRef, ...rest } = p;
      return rest;
    },
    crossBranch: (p) => ({ ...p, consumedOverrideRef: ref('round_budget_override') }),
    nullNonNull: (p) => ({ ...p, fromRepairPlanRef: null }),
    extra: [
      {
        label: 'transfer is one-directional: successor plan ref is required',
        mutate: (p) => {
          const { toRepairPlanRef, ...rest } = p;
          return rest;
        },
      },
      {
        label: 'the spec-exact payload has no repairLineageId field (lineage resolves via the override blob)',
        mutate: (p) => ({ ...p, repairLineageId: 'lineage-1' }),
      },
    ],
  },
];

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe('EVENT_INVALID');
    return;
  }
  throw new Error('expected validateAuthoritativeReviewEventV2 to throw, but it did not');
}

describe('validateAuthoritativeReviewEventV2 — closed union', () => {
  it('covers exactly the closed name registry', () => {
    expect(ROWS.map((row) => row.name).sort()).toEqual(
      [...AUTHORITATIVE_REVIEW_EVENT_NAMES_V2].sort(),
    );
  });

  for (const row of ROWS) {
    describe(row.name, () => {
      it('accepts the legal payload unchanged', () => {
        const payload = row.make();
        expect(validateAuthoritativeReviewEventV2(payload)).toEqual(payload);
      });

      it('rejects an unknown extra field', () => {
        expectInvalid(() => validateAuthoritativeReviewEventV2({ ...row.make(), bogusField: 1 }));
      });

      it('rejects a wrong protocol version', () => {
        for (const version of [1, 3]) {
          expectInvalid(() =>
            validateAuthoritativeReviewEventV2({ ...row.make(), protocolVersion: version }),
          );
        }
      });

      it('rejects a filename-unsafe event id', () => {
        for (const id of ['../ev', 'a b', 'a/b']) {
          expectInvalid(() => validateAuthoritativeReviewEventV2({ ...row.make(), id }));
        }
      });

      it('rejects a missing required identity/ref field', () => {
        expectInvalid(() => validateAuthoritativeReviewEventV2(row.missing(row.make())));
      });

      it('rejects cross-attempt/system branch fields', () => {
        expectInvalid(() => validateAuthoritativeReviewEventV2(row.crossBranch(row.make())));
      });

      const hasRef = Object.values(row.make()).some(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          typeof (value as Record<string, unknown>).kind === 'string',
      );
      if (hasRef) {
        it('rejects a bare custody digest in place of a ref', () => {
          const mutate = row.bareDigest ?? withBareRefDigest;
          expectInvalid(() => validateAuthoritativeReviewEventV2(mutate(row.make())));
        });
      }

      it('rejects an illegal null/non-null combination', () => {
        expectInvalid(() => validateAuthoritativeReviewEventV2(row.nullNonNull(row.make())));
      });

      for (const extra of row.extra ?? []) {
        it(`extra matrix: ${extra.label}`, () => {
          if (extra.expectValid === true) {
            const payload = extra.mutate(row.make());
            expect(validateAuthoritativeReviewEventV2(payload)).toEqual(payload);
            return;
          }
          expectInvalid(() => validateAuthoritativeReviewEventV2(extra.mutate(row.make())));
        });
      }
    });
  }
});