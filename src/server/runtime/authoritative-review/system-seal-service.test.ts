import { describe, expect, it, vi } from 'vitest';

import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { AssemblerRegistryV2, ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION } from './assembler-registry';
import { zhihuAssemblerFixture } from './builtin-assemblers/zhihu-chapter-v1.test';
import { parseBlob } from '../../authoritative-review/object-registry';
import { SEAL_GATE_UNMET_REASONS, SystemSealServiceV2, createArtifactStoreSystemSealPublisher, evaluateSystemSealGate, type SealGateInputV2, type SystemSealServiceDependenciesV2 } from './system-seal-service';

const ref = (kind: BlobRefV2['kind'], digest: string): BlobRefV2 => ({
  kind,
  digest: digest.repeat(64).slice(0, 64),
  byteLength: 1,
  mediaType: 'application/json',
  schemaVersion: 1,
});

function eligible(): SealGateInputV2 {
  const map = ref('map_snapshot', 'a');
  const manifest = ref('content_revision_manifest', 'b');
  const mapBundle = ref('map_review_bundle', 'c');
  return {
    activeMapRef: map,
    reviewMapRef: map,
    activeManifestRef: manifest,
    reviewManifestRef: manifest,
    activeMapReviewBundleRef: mapBundle,
    reviewMapReviewBundleRef: mapBundle,
    allContentFactsPassing: true,
    allBlockingRelationsSatisfied: true,
    wholeTreeObservationComplete: true,
    blockingFindingCount: 0,
    pendingOrStaleReviewCount: 0,
    activeRepairGrantCount: 0,
    preSealAggregatesClearAndBound: true,
    frozenAssembler: ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION,
    installedAssembler: ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION,
    frozenTemplateSnapshotHash: 'template',
    resolvedTemplateSnapshotHash: 'template',
  };
}

describe('system Seal Gate', () => {
  it('passes only the fully eligible exact-ref fixture', () => {
    expect(evaluateSystemSealGate(eligible())).toEqual({ ready: true, unmetReasons: [] });
  });

  it('returns each of the ten independent stable reasons in frozen order', () => {
    const mutations: Array<(input: SealGateInputV2) => void> = [
      (i) => { i.reviewMapRef = { ...i.reviewMapRef, digest: 'd'.repeat(64) }; },
      (i) => { i.reviewManifestRef = { ...i.reviewManifestRef, digest: 'd'.repeat(64) }; },
      (i) => { i.reviewMapReviewBundleRef = { ...i.reviewMapReviewBundleRef, digest: 'd'.repeat(64) }; },
      (i) => { i.allContentFactsPassing = false; },
      (i) => { i.allBlockingRelationsSatisfied = false; },
      (i) => { i.wholeTreeObservationComplete = false; },
      (i) => { i.blockingFindingCount = 1; },
      (i) => { i.activeRepairGrantCount = 1; },
      (i) => { i.preSealAggregatesClearAndBound = false; },
      (i) => { i.resolvedTemplateSnapshotHash = 'other'; },
    ];
    mutations.forEach((mutate, index) => {
      const input = eligible();
      mutate(input);
      expect(evaluateSystemSealGate(input)).toEqual({ ready: false, unmetReasons: [SEAL_GATE_UNMET_REASONS[index]] });
    });
  });

  it('does not accept equal semantic/content aliases with different refs and has no assembler side effect', () => {
    const assembler = vi.fn();
    const input = eligible();
    input.reviewMapRef = { ...input.reviewMapRef, digest: 'e'.repeat(64) };
    input.reviewManifestRef = { ...input.reviewManifestRef, digest: 'f'.repeat(64) };
    const result = evaluateSystemSealGate(input);
    expect(result.unmetReasons).toEqual(['ACTIVE_MAP_REF_MISMATCH', 'FINALIZED_MANIFEST_REF_MISMATCH']);
    expect(assembler).not.toHaveBeenCalled();
  });
});

function serviceHarness(outcomes: Array<'clear' | 'blocking_invalid' | 'infrastructure_failure'>) {
  const publisher = {
    stage: vi.fn(async () => ({ artifactId: 'artifact-1', custodyRef: ref('artifact', '9') })),
    publish: vi.fn(async (input: { deliveryRef: BlobRefV2 }) => ({ artifactVersion: 1, deliveryRef: input.deliveryRef })),
  };
  const routeInputBlocking = vi.fn(async () => ({ kind: 'completed' as const, resultRefs: [] }));
  const recordOutputBlocking = vi.fn(async () => ({
    kind: 'terminal_failure' as const,
    failureCode: 'ARTIFACT_VALIDATION_FAILED',
    failureDigest: 'f'.repeat(64),
    taskFailure: true,
  }));
  const deps: SystemSealServiceDependenciesV2 = {
    assemblerRegistry: new AssemblerRegistryV2(),
    blobs: { prepare: vi.fn(async (kind, value) => parseBlob(kind, value).ref) },
    publisher,
    validate: vi.fn(async () => {
      const outcome = outcomes.shift() ?? 'clear';
      return {
        outcome,
        aggregateRef: ref('validator_aggregate', outcome === 'clear' ? '1' : '2'),
        blockingReceiptRef: outcome === 'blocking_invalid' ? ref('validation_receipt', '3') : null,
        warningCustodyRootRef: ref('validation_warning_custody_root', '4'),
      };
    }),
    routeInputBlocking,
    recordOutputBlocking,
  };
  return { service: new SystemSealServiceV2(deps), deps, publisher, routeInputBlocking, recordOutputBlocking };
}

function executeInput() {
  return {
    taskId: 'task', commandId: 'command', sealWorkItemId: 'seal-work', sealLeaseEpoch: 1,
    sealAuthorityBaseRef: ref('authority_base_set', '6'), operationId: 'seal-op',
    gate: eligible(), assemblerInput: zhihuAssemblerFixture(), mapSemanticDigest: 'a'.repeat(64),
    contentRootDigest: 'b'.repeat(64), reviewBundleRef: ref('review_bundle', '5'),
    templateSnapshotHash: 'template', submitterWorkItemId: 'submit-work', submitterAgentId: 'submitter',
    submitterAuthorityBaseRef: ref('authority_base_set', '7'), submitterLogicalAssignmentId: 'submit-logical',
    submitterMaxAutomaticRetries: 2,
  };
}

describe('SystemSealServiceV2 validator and publication branches', () => {
  it('rejects an execution template hash outside the frozen gate identity before validation', async () => {
    const h = serviceHarness(['clear', 'clear']);
    const input = executeInput();
    input.templateSnapshotHash = 'other';
    await expect(h.service.execute(input)).resolves.toMatchObject({
      kind: 'retryable_failure',
      failureCode: 'SEAL_GATE_UNMET:ASSEMBLER_TEMPLATE_IDENTITY_MISMATCH',
    });
    expect(h.deps.validate).not.toHaveBeenCalled();
    expect(h.publisher.stage).not.toHaveBeenCalled();
    expect(h.publisher.publish).not.toHaveBeenCalled();
  });

  it('routes seal_input blocking with aggregate/receipt and never assembles or publishes', async () => {
    const h = serviceHarness(['blocking_invalid']);
    await expect(h.service.execute(executeInput())).resolves.toMatchObject({ kind: 'completed' });
    expect(h.routeInputBlocking).toHaveBeenCalledWith(expect.objectContaining({ kind: 'validator_aggregate' }), expect.objectContaining({ kind: 'validation_receipt' }));
    expect(h.publisher.stage).not.toHaveBeenCalled();
    expect(h.publisher.publish).not.toHaveBeenCalled();
  });

  it('records seal_output blocking as ARTIFACT_VALIDATION_FAILED and does not publish', async () => {
    const h = serviceHarness(['clear', 'blocking_invalid']);
    await expect(h.service.execute(executeInput())).resolves.toMatchObject({ kind: 'terminal_failure', failureCode: 'ARTIFACT_VALIDATION_FAILED' });
    expect(h.recordOutputBlocking).toHaveBeenCalled();
    expect(h.publisher.stage).not.toHaveBeenCalled();
    expect(h.publisher.publish).not.toHaveBeenCalled();
  });

  it('preserves infrastructure aggregate for retry', async () => {
    const h = serviceHarness(['infrastructure_failure']);
    await expect(h.service.execute(executeInput())).resolves.toMatchObject({
      kind: 'retryable_failure', failureCode: 'SEAL_INPUT_INFRASTRUCTURE', validatorAggregateRef: { kind: 'validator_aggregate' },
    });
  });

  it('prepares bundle, record, artifact and delivery before one clear publication', async () => {
    const h = serviceHarness(['clear', 'clear']);
    await expect(h.service.execute(executeInput())).resolves.toMatchObject({ kind: 'completed', resultRefs: expect.any(Array) });
    expect(h.publisher.stage).toHaveBeenCalledTimes(1);
    expect(h.publisher.publish).toHaveBeenCalledTimes(1);
    const published = h.publisher.publish.mock.calls[0]![0] as unknown as {
      sealWorkItemId: string;
      delivery: Record<string, unknown>;
      files: Array<{ name: string; mediaType: string }>;
    };
    expect(published.delivery).not.toHaveProperty('artifactVersion');
    expect(published).toMatchObject({ sealWorkItemId: 'seal-work', files: [{ name: 'chapter.md', mediaType: 'text/markdown' }] });
  });

  it('turns stage/append infrastructure crashes into stable retryable failures with aggregate custody', async () => {
    const stageCrash = serviceHarness(['clear', 'clear']);
    stageCrash.publisher.stage.mockRejectedValueOnce(new Error('disk offline'));
    await expect(stageCrash.service.execute(executeInput())).resolves.toMatchObject({
      kind: 'retryable_failure', failureCode: 'ARTIFACT_STAGE_INFRASTRUCTURE',
      validatorAggregateRef: { kind: 'validator_aggregate' },
    });
    const appendCrash = serviceHarness(['clear', 'clear']);
    appendCrash.publisher.publish.mockRejectedValueOnce(new Error('response lost'));
    await expect(appendCrash.service.execute(executeInput())).resolves.toMatchObject({
      kind: 'retryable_failure', failureCode: 'SEAL_PUBLISH_INFRASTRUCTURE',
      validatorAggregateRef: { kind: 'validator_aggregate' },
    });
  });
});

describe('production ArtifactStore publisher adapter', () => {
  it('uses only system_seal stage/promote around the facade-allocated event version', async () => {
    const artifactStore = {
      stageSystemArtifact: vi.fn(async () => ({})),
      promoteSystemArtifact: vi.fn(async () => ({})),
    };
    const deliveryRef = ref('system_artifact_delivery', 'd');
    const facade = {
      publishWithPin: vi.fn(async () => ({
        events: [{ sequence: 1, fileName: 'batch', size: 1, event: {
          protocolVersion: 2, id: 'publish', at: '2026-08-16T00:00:00.000Z', type: 'artifact_published_v2',
          artifactId: 'artifact-seal-work', artifactVersion: 7, deliveryRef,
          files: [{ name: 'chapter.md', hash: 'a'.repeat(64) }], mediaType: 'text/markdown',
          provenance: { producerKind: 'system', producerWorkItemId: 'seal-work', sealRecordRef: ref('seal_record', 'e'), artifactRef: ref('artifact', 'a'), custodyRef: ref('artifact', 'a') },
        } }], pinId: 'pin', generation: 1,
      })),
    };
    const publisher = createArtifactStoreSystemSealPublisher({
      facade: facade as never, readTail: async () => ({ lastSequence: 0, lastCommitId: null }),
      artifactStore: artifactStore as never,
    });
    const sealRecordRef = ref('seal_record', 'e');
    const artifactRef = ref('artifact', 'a');
    const staged = await publisher.stage({
      taskId: 'task', sealWorkItemId: 'seal-work', sealRecordRef,
      templateSnapshotHash: 'b'.repeat(64), artifactRef,
      files: [{ name: 'chapter.md', mediaType: 'text/markdown', content: '# chapter' }],
    });
    await publisher.publish({
      taskId: 'task', operationId: 'operation', sealWorkItemId: 'seal-work', sealCommandId: 'command',
      sealLeaseEpoch: 1, sealAuthorityBaseRef: ref('authority_base_set', '1'), sealRecordRef,
      sealValidationBundleRef: ref('seal_validation_bundle', '2'), artifactRef, custodyRef: staged.custodyRef,
      deliveryRef, delivery: {
        deliveryId: 'delivery', producer: 'system:structured_seal', sealRecordRef, sealRecordDigest: sealRecordRef.digest,
        artifactId: staged.artifactId, artifactRef, artifactDigest: artifactRef.digest,
        custodyRef: staged.custodyRef, custodyDigest: staged.custodyRef.digest,
        submitterWorkItemId: 'submit', submitterAgentId: 'agent', templateSnapshotHash: 'b'.repeat(64),
      },
      submitterAuthorityBaseRef: ref('authority_base_set', '3'), submitterGrantSpecRef: ref('write_grant_spec', '4'),
      submitterLogicalAssignmentId: 'logical', submitterMaxAutomaticRetries: 2,
      mapRef: ref('map_snapshot', '5'), contentRevisionManifestRef: ref('content_revision_manifest', '6'),
      reviewBundleRef: ref('review_bundle', '7'), files: [{ name: 'chapter.md', mediaType: 'text/markdown', hash: 'a'.repeat(64) }],
    });
    expect(artifactStore.stageSystemArtifact).toHaveBeenCalledWith('system_seal', 'task', expect.objectContaining({ artifactId: 'artifact-seal-work' }));
    expect(artifactStore.promoteSystemArtifact).toHaveBeenCalledWith('system_seal', 'task', expect.objectContaining({ artifactVersion: 7, deliveryRef }));
    expect(facade.publishWithPin).toHaveBeenCalledWith(expect.objectContaining({
      preparedRefs: expect.arrayContaining([
        artifactRef, sealRecordRef, deliveryRef,
        expect.objectContaining({ kind: 'seal_validation_bundle' }),
        expect.objectContaining({ kind: 'map_snapshot' }),
        expect.objectContaining({ kind: 'content_revision_manifest' }),
        expect.objectContaining({ kind: 'review_bundle' }),
        expect.objectContaining({ kind: 'authority_base_set' }),
        expect.objectContaining({ kind: 'write_grant_spec' }),
      ]),
    }));
  });
});
