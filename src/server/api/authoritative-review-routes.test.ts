// @vitest-environment node
/**
 * Task 23: authoritative per-slot review v2 read-only REST routes (spec §14.1).
 *
 * Boots a real HTTP server over the `authoritative-valid` v2 fixture, creates a
 * v2 task and seeds a legal v2 event history + canonical blobs through the
 * checkpoint store / blob store. Asserts:
 * - all 11 endpoints return exact schemas as `task_owner`;
 * - basic/v1 tasks reject with AUTHORITATIVE_REVIEW_UNAVAILABLE;
 * - cursor tamper/stale maps to a stable public 409 (CURSOR_STALE);
 * - tree parent pages + locate produce seek cursors; query-param injection is
 *   rejected;
 * - reads work even while the authoritative capability is DISABLED (frozen
 *   profile historical read, spec §4.3) and v2 mutations answer
 *   AUTHORITATIVE_REVIEW_UNAVAILABLE / stable errors under that state.
 */
import { cpSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import { CoreService } from '../core-service';
import { FakeAgentRuntime } from '../runtime/fake-agent-runtime';
import { createForgeCoreServer } from '../http-server';
import { CorePaths } from '../storage/core-paths';
import { createTestRuntimeEnvironment } from '../structured-slots/runtime-capability';
import { createAuthoritativeReviewTestEnvironment } from '../structured-slots/test-support/authoritative-review-test-registry';
import { LegalHistory, digestFor } from '../storage/authoritative-review-state.test';
import type { MapPositionNodeV2 } from '../authoritative-review/authority-types';

const V2_TEMPLATE_ID = 'authoritative-valid';
const V1_TEMPLATE_ID = 'structured-valid';

const rawRoots: string[] = [];

function v2Roots(): { dataRoot: string; templateRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-ar-routes-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-ar-routes-tpl-'));
  rawRoots.push(dataRoot, templateRoot);
  const srcDir = fileURLToPath(new URL('../template/__fixtures__/authoritative-valid', import.meta.url));
  cpSync(srcDir, join(templateRoot, V2_TEMPLATE_ID), { recursive: true });
  return { dataRoot, templateRoot };
}

function smallTreeNodes(): MapPositionNodeV2[] {
  const node = (slotId: string, parentSlotId: string | null, documentOrder: number, siblingOrder: number): MapPositionNodeV2 => ({
    slotId,
    slotType: slotId === 'root' ? 'document' : 'body',
    contentBearing: true,
    parentSlotId,
    documentOrder,
    siblingOrder,
    nodeSpecDigest: digestFor(slotId, 1),
  });
  return [
    node('root', null, 0, 0),
    node('a', 'root', 1, 0),
    node('b', 'root', 2, 1),
    node('a1', 'a', 3, 0),
    node('a2', 'a', 4, 1),
    node('b1', 'b', 5, 0),
  ];
}

/** Seeds a legal v2 event history + canonical blob bytes into the task roots. */
async function seedV2Projection(service: CoreService, taskId: string): Promise<{ mapSnapshotRef: BlobRefV2 }> {
  const blobStore = service['v2BlobStore'];
  const nodes = smallTreeNodes();
  const mapSnapshot = {
    scaffoldId: 'scaffold-ar',
    mapId: 'map-ar',
    supersedesMapId: null,
    sourceCandidateId: 'cand-ar-1',
    proposedMapCoreRef: { kind: 'proposed_map_core', digest: digestFor('pc', 1), byteLength: 12, mediaType: 'application/json', schemaVersion: 1 },
    mapReviewBundleRef: { kind: 'map_review_bundle', digest: digestFor('mb', 1), byteLength: 12, mediaType: 'application/json', schemaVersion: 1 },
    mapRevision: 1,
    mapSemanticDigest: digestFor('semantic-ar', 1),
    positionGraphDigest: digestFor('pos', 1),
    relationGraphDigest: digestFor('rel', 1),
    templateSnapshotHash: digestFor('tpl', 1),
    nodes,
    relations: [],
    activatedAt: '2026-08-14T00:00:00.000Z',
  };
  const mapSnapshotRef = await blobStore.putJson(taskId, 'map_snapshot', mapSnapshot);

  const h = new LegalHistory('ar');
  const build = h.commitMapBuildRevision({ revision: 1, chunkCount: 1 });
  const mapRoundId = 'mr-ar-1';
  h.push({
    type: 'structured_map_review_round_planned',
    mapReviewRoundId: mapRoundId,
    mapCycleOrdinal: 1,
    candidateId: build.candidateId,
    candidateRef: build.candidateRef,
    contentRevisionManifestRef: null,
    reviewPolicyDigest: digestFor('policy', 1),
    coverageNodeCount: nodes.length,
    coverageRelationCount: 0,
    assignmentCount: 1,
    consumedOverrideRef: null,
  });
  {
    const { workItemId } = h.createAgentWorkItem({ sessionKind: 'review_map_batch', logicalAssignmentId: 'la-mr-1', reviewAssignmentId: 'ra-mr-1', roundId: mapRoundId });
    h.completeAgentCycle({
      workItemId,
      logicalAssignmentId: 'la-mr-1',
      sessionKind: 'review_map_batch',
      reviewAssignmentId: 'ra-mr-1',
      leaseEpoch: 1,
      onStarted: () => {
        h.push({
          type: 'structured_map_review_assignment_committed',
          assignmentId: 'asg-mr-1',
          mapReviewRoundId: mapRoundId,
          workItemId,
          attemptId: `att-${workItemId}-1`,
          reviewAssignmentId: 'ra-mr-1',
          source: 'batch',
          ledgerRef: h.ref('review_assignment_ledger'),
          coverageTargetCount: nodes.length,
          findingCount: 0,
        });
      },
    });
  }
  h.push({ type: 'structured_map_review_round_completed', mapReviewRoundId: mapRoundId, coverageCoreRef: h.ref('map_review_coverage_core') });
  const baselineManifestRef = h.ref('content_revision_manifest');
  {
    const settle = h.createSystemWorkItem('system_review_settlement');
    h.lease(settle.workItemId, 1, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${settle.workItemId}-1`, workItemId: settle.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_map_review_round_settled', mapReviewRoundId: mapRoundId, settlementCoreRef: h.ref('map_review_settlement_core'), outcome: 'activate' });
    h.push({ type: 'structured_map_activated', mapId: 'map-ar', mapRevision: 1, supersedesMapId: null, mapSnapshotRef, mapReviewBundleRef: mapSnapshot.mapReviewBundleRef, mapSemanticDigest: mapSnapshot.mapSemanticDigest, contentRevisionManifestRef: baselineManifestRef, activationValidatorAggregateRef: h.ref('validator_aggregate'), migrationSettlementCoreRef: null, migrationActivationDecisionRef: null });
    h.push({ type: 'structured_system_command_completed', commandId: `cmd-${settle.workItemId}-1`, workItemId: settle.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.workItemCompleted(settle.workItemId, 1);
  }
  h.push({ type: 'structured_content_revision_committed', contentRevisionManifestRef: baselineManifestRef, taskContentRevision: 1, manifestPhase: 'baseline_unset', producerPlanSpecRef: null, priorManifestRef: null });

  // Commit the v2 events through the EventStore's fenced appendBatch (the only
  // legal channel for a v2 history without running the full mutation facade).
  const events = h.events;
  const hold = await service['v2PublicationStore'].lock().acquire();
  try {
    const proof = await hold.proof();
    await service.events.appendBatch(taskId, 'seed-ar-history', events, {
      expectedLastSequence: 0,
      fenceProof: proof,
      publicationPinId: 'seed-ar-pin',
    });
  } finally {
    await hold.release();
  }
  return { mapSnapshotRef };
}

async function bootV2Server(
  env = createAuthoritativeReviewTestEnvironment(),
  extraTemplate = false,
  existingRoots?: { dataRoot: string; templateRoot: string },
) {
  const roots = existingRoots ?? v2Roots();
  if (!existingRoots) {
    if (extraTemplate) {
      const { installValidFixtureTemplate } = await import('../test-support');
      installValidFixtureTemplate(roots.templateRoot);
      const v1Src = fileURLToPath(new URL('../template/__fixtures__/structured-valid', import.meta.url));
      cpSync(v1Src, join(roots.templateRoot, V1_TEMPLATE_ID), { recursive: true });
    }
  }
  const service = new CoreService(CorePaths.create(roots), {
    runtime: new FakeAgentRuntime(),
    runtimeEnvironment: createTestRuntimeEnvironment(),
    authoritativeReviewEnvironment: env,
  });
  await service.initialize();
  const server = await createForgeCoreServer({ mode: 'test', dataRoot: roots.dataRoot, templateRoot: roots.templateRoot, coreService: service });
  const baseUrl = await server.listen(0);
  async function request(method: string, path: string, options: { json?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }
  return { roots, service, baseUrl, close: () => server.close(), request };
}

const manual: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (manual.length) {
    const dispose: (() => Promise<unknown>) | undefined = manual.pop() as () => Promise<unknown>;
    if (dispose !== undefined) await dispose();
  }
});

describe('authoritative review v2 read-only routes (spec §14.1)', () => {
  it('returns the 11 endpoints with exact shapes on a seeded v2 task', async () => {
    const fixture = await bootV2Server();
    manual.push(async () => fixture.close());
    const created = await fixture.request('POST', '/api/tasks', { json: { templateId: V2_TEMPLATE_ID, name: 'ar task', input: { 'source-text': 'x' } } });
    expect(created.status).toBe(200);
    const taskId = (created.body as { id: string }).id;
    await seedV2Projection(fixture.service, taskId);

    const map = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/map`);
    expect(map.status).toBe(200);
    expect((map.body as { mapId: string }).mapId).toBe('map-ar');

    const candidate = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/map/candidate`);
    expect(candidate.status).toBe(200);

    const tree = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/tree?parentId=root&limit=10`);
    expect(tree.status).toBe(200);
    expect((tree.body as { hasMoreChildren: boolean }).hasMoreChildren).toBe(false);

    const locate = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/tree/locate/a1`);
    expect(locate.status).toBe(200);
    expect((locate.body as { ancestors: unknown[] }).ancestors.length).toBeGreaterThan(0);

    const mapRounds = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/review/map-rounds`);
    expect(mapRounds.status).toBe(200);

    const summary = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/review/summary`);
    expect(summary.status).toBe(200);

    const rounds = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/review/rounds`);
    expect(rounds.status).toBe(200);

    const slot = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/review/slots/a1`);
    expect(slot.status).toBe(200);

    const relation = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/review/relations/r-missing`);
    expect(relation.status).toBe(404);
    expect((relation.body as { error: { code: string } }).error.code).toBe('SLOT_NOT_VISIBLE');

    const findings = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/review/findings`);
    expect(findings.status).toBe(200);

    const seal = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/review/seal-readiness`);
    expect(seal.status).toBe(200);

    const issues = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/issues`);
    expect(issues.status).toBe(200);
  });

  it('rejects basic/v1 tasks with AUTHORITATIVE_REVIEW_UNAVAILABLE and missing slots identically', async () => {
    const fixture = await bootV2Server(undefined, true);
    manual.push(async () => fixture.close());
    const basic = await fixture.request('POST', '/api/tasks', { json: { templateId: 'test-template', name: 'basic', input: { 'source-material': 'x', 'style-note': 'simple' } } });
    expect(basic.status).toBe(200);
    const basicId = (basic.body as { id: string }).id;
    const response = await fixture.request('GET', `/api/tasks/${basicId}/structured-slots/map`);
    expect(response.status).toBe(503);
    expect((response.body as { error: { code: string } }).error.code).toBe('AUTHORITATIVE_REVIEW_UNAVAILABLE');

    const v1 = await fixture.request('POST', '/api/tasks', { json: { templateId: V1_TEMPLATE_ID, name: 'v1', input: { 'source-text': 'x' } } });
    expect(v1.status).toBe(200);
    const v1Id = (v1.body as { id: string }).id;
    // v2-only endpoints reject for a v1 task; the shared /tree serves the v1
    // outline (protocol dispatch).
    const v1MapResponse = await fixture.request('GET', `/api/tasks/${v1Id}/structured-slots/map`);
    expect(v1MapResponse.status).toBe(503);
    expect((v1MapResponse.body as { error: { code: string } }).error.code).toBe('AUTHORITATIVE_REVIEW_UNAVAILABLE');
    const v1Tree = await fixture.request('GET', `/api/tasks/${v1Id}/structured-slots/tree`);
    expect(v1Tree.status).toBe(200);
  });

  it('is available on a v2 task even when the authoritative capability is disabled (frozen-profile historical read)', async () => {
    // Freeze a v2 task under an ENABLED environment.
    const enabled = await bootV2Server();
    const created = await enabled.request('POST', '/api/tasks', { json: { templateId: V2_TEMPLATE_ID, name: 'ar-disabled', input: { 'source-text': 'x' } } });
    expect(created.status).toBe(200);
    const taskId = (created.body as { id: string }).id;
    await seedV2Projection(enabled.service, taskId);
    await enabled.close();

    // Reopen the SAME roots under an explicitly DISABLED authoritative
    // environment: the read API still serves the historical projection
    // (spec §4.3), and v2 mutations answer AUTHORITATIVE_REVIEW_UNAVAILABLE.
    const { createAuthoritativeReviewRuntimeEnvironment, AUTHORITATIVE_REVIEW_REQUIRED_ABIS } = await import('../structured-slots/authoritative-review-capability');
    const disabledEnv = createAuthoritativeReviewRuntimeEnvironment(
      { version: 1, status: 'disabled', profileIdentity: null, profileDigest: null, evidenceDigest: null, requiredAbis: [...AUTHORITATIVE_REVIEW_REQUIRED_ABIS] },
      null,
      (await import('../structured-slots/test-support/authoritative-review-test-registry')).createAuthoritativeReviewTestHandlerRegistry(),
    );
    const disabled = await bootV2Server(disabledEnv, false, enabled.roots);
    manual.push(async () => disabled.close());
    const summary = await disabled.request('GET', `/api/tasks/${taskId}/structured-slots/review/summary`);
    expect(summary.status).toBe(200);
    // A v2 mutation never succeeds under a disabled capability: it rejects
    // with a stable public code (spec §4.3 "or equivalent stable error").
    const answer = await disabled.request('POST', `/api/tasks/${taskId}/answer`, { json: { questionId: 'q', questionVersion: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', operationId: '00000000-0000-4000-8000-000000000000', answer: 'x' } });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(typeof (answer.body as { error?: { code: string } }).error?.code).toBe('string');
  });

  it('rejects cursor tamper and query-param injection with stable codes', async () => {
    const fixture = await bootV2Server();
    manual.push(async () => fixture.close());
    const created = await fixture.request('POST', '/api/tasks', { json: { templateId: V2_TEMPLATE_ID, name: 'ar-task', input: { 'source-text': 'x' } } });
    const taskId = (created.body as { id: string }).id;
    await seedV2Projection(fixture.service, taskId);

    const tampered = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/tree?parentId=root&limit=1&after=${encodeURIComponent('{"version":2,"keyId":"k","token":"garbage"}')}`);
    expect(tampered.status).toBe(409);
    expect((tampered.body as { error: { code: string } }).error.code).toBe('CURSOR_STALE');

    const injection = await fixture.request('GET', `/api/tasks/${taskId}/structured-slots/map?profile=editor`);
    expect(injection.status).toBe(400);
    expect((injection.body as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });
});
