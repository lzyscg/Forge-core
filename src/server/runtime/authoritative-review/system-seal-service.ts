/**
 * Task 21 system-owned Seal Gate.  The Gate is a pure ten-condition predicate;
 * assembler/validators/publication are injected platform capabilities and are
 * reached only after the exact authority refs pass.
 */
import { createHash } from 'node:crypto';

import type { BlobRefV2, SealRecordV2, SystemArtifactDeliveryV2 } from '../../../shared/authoritative-review-v2';
import type { SealValidationBundleV2, ValidatorAggregateOutcomeV2 } from '../../authoritative-review/authority-types';
import type { AssemblerRegistrationV2 } from '../../template/structured-slot-contract-v2';
import { canonicalJson, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { SystemCommandHandler, SystemCommandOutcome } from './system-command-registry';
import type { ZhihuChapterAssemblerInputV1 } from './builtin-assemblers/zhihu-chapter-v1';
import { AssemblerRegistryV2 } from './assembler-registry';
import { buildReviewObservationGrantSpec } from './review-coordinator';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { ArtifactStore, PromoteSystemArtifactInputV2, StageSystemArtifactInputV2 } from '../../storage/artifact-store';

export const SEAL_GATE_UNMET_REASONS = [
  'ACTIVE_MAP_REF_MISMATCH',
  'FINALIZED_MANIFEST_REF_MISMATCH',
  'MAP_REVIEW_BUNDLE_NOT_CURRENT',
  'CONTENT_FACTS_NOT_PASSING',
  'BLOCKING_RELATIONS_NOT_SATISFIED',
  'WHOLE_TREE_OBSERVATION_INCOMPLETE',
  'BLOCKING_FINDINGS_OPEN',
  'REVIEW_OR_REPAIR_PENDING',
  'PRESEAL_VALIDATORS_NOT_CLEAR',
  'ASSEMBLER_TEMPLATE_IDENTITY_MISMATCH',
] as const;

export type SealGateUnmetReasonV2 = (typeof SEAL_GATE_UNMET_REASONS)[number];

export interface SealGateInputV2 {
  activeMapRef: BlobRefV2;
  reviewMapRef: BlobRefV2;
  activeManifestRef: BlobRefV2;
  reviewManifestRef: BlobRefV2;
  activeMapReviewBundleRef: BlobRefV2;
  reviewMapReviewBundleRef: BlobRefV2;
  allContentFactsPassing: boolean;
  allBlockingRelationsSatisfied: boolean;
  wholeTreeObservationComplete: boolean;
  blockingFindingCount: number;
  pendingOrStaleReviewCount: number;
  activeRepairGrantCount: number;
  preSealAggregatesClearAndBound: boolean;
  frozenAssembler: AssemblerRegistrationV2;
  installedAssembler: AssemblerRegistrationV2 | null;
  frozenTemplateSnapshotHash: string;
  resolvedTemplateSnapshotHash: string;
}

export interface SealGateResultV2 {
  ready: boolean;
  unmetReasons: readonly SealGateUnmetReasonV2[];
}

function sameRef(a: BlobRefV2, b: BlobRefV2): boolean {
  return a.kind === b.kind
    && a.digest === b.digest
    && a.byteLength === b.byteLength
    && a.mediaType === b.mediaType
    && a.schemaVersion === b.schemaVersion;
}

/** Stable reason order is the frozen condition order, never discovery order. */
export function evaluateSystemSealGate(input: SealGateInputV2): SealGateResultV2 {
  const unmet: SealGateUnmetReasonV2[] = [];
  if (!sameRef(input.activeMapRef, input.reviewMapRef)) unmet.push('ACTIVE_MAP_REF_MISMATCH');
  if (!sameRef(input.activeManifestRef, input.reviewManifestRef)) unmet.push('FINALIZED_MANIFEST_REF_MISMATCH');
  if (!sameRef(input.activeMapReviewBundleRef, input.reviewMapReviewBundleRef)) unmet.push('MAP_REVIEW_BUNDLE_NOT_CURRENT');
  if (!input.allContentFactsPassing) unmet.push('CONTENT_FACTS_NOT_PASSING');
  if (!input.allBlockingRelationsSatisfied) unmet.push('BLOCKING_RELATIONS_NOT_SATISFIED');
  if (!input.wholeTreeObservationComplete) unmet.push('WHOLE_TREE_OBSERVATION_INCOMPLETE');
  if (input.blockingFindingCount !== 0) unmet.push('BLOCKING_FINDINGS_OPEN');
  if (input.pendingOrStaleReviewCount !== 0 || input.activeRepairGrantCount !== 0) unmet.push('REVIEW_OR_REPAIR_PENDING');
  if (!input.preSealAggregatesClearAndBound) unmet.push('PRESEAL_VALIDATORS_NOT_CLEAR');
  if (
    input.installedAssembler === null
    || canonicalJson(input.frozenAssembler) !== canonicalJson(input.installedAssembler)
    || input.frozenTemplateSnapshotHash !== input.resolvedTemplateSnapshotHash
  ) unmet.push('ASSEMBLER_TEMPLATE_IDENTITY_MISMATCH');
  return Object.freeze({ ready: unmet.length === 0, unmetReasons: Object.freeze(unmet) });
}

export interface SealValidatorRunV2 {
  outcome: ValidatorAggregateOutcomeV2;
  aggregateRef: BlobRefV2;
  blockingReceiptRef: BlobRefV2 | null;
  warningCustodyRootRef: BlobRefV2;
}

export interface SystemSealBlobWriter {
  prepare(kind: 'artifact' | 'seal_validation_bundle' | 'seal_record' | 'system_artifact_delivery' | 'write_grant_spec', value: unknown): Promise<BlobRefV2>;
}

export interface SystemSealPublisherV2 {
  /** Stages immutable disk bytes and returns a formal custody ref before lock. */
  stage(input: {
    taskId: string;
    sealWorkItemId: string;
    sealRecordRef: BlobRefV2;
    templateSnapshotHash: string;
    artifactRef: BlobRefV2;
    files: readonly { name: string; mediaType: string; content: string }[];
  }): Promise<{ artifactId: string; custodyRef: BlobRefV2 }>;
  /** Acquires the publication lock and commits the complete clear envelope. */
  publish(input: {
    taskId: string;
    operationId: string;
    sealWorkItemId: string;
    sealCommandId: string;
    sealLeaseEpoch: number;
    sealAuthorityBaseRef: BlobRefV2;
    sealRecordRef: BlobRefV2;
    sealValidationBundleRef: BlobRefV2;
    artifactRef: BlobRefV2;
    custodyRef: BlobRefV2;
    deliveryRef: BlobRefV2;
    delivery: SystemArtifactDeliveryV2;
    submitterAuthorityBaseRef: BlobRefV2;
    submitterGrantSpecRef: BlobRefV2;
    submitterLogicalAssignmentId: string;
    submitterMaxAutomaticRetries: number;
    mapRef: BlobRefV2;
    contentRevisionManifestRef: BlobRefV2;
    reviewBundleRef: BlobRefV2;
    files: readonly { name: string; hash: string; mediaType: string }[];
  }): Promise<{ artifactVersion: number; deliveryRef: BlobRefV2 }>;
}

export interface SystemSealServiceDependenciesV2 {
  assemblerRegistry: AssemblerRegistryV2;
  blobs: SystemSealBlobWriter;
  publisher: SystemSealPublisherV2;
  validate(stage: 'seal_input' | 'seal_output', artifactRef: BlobRefV2 | null): Promise<SealValidatorRunV2>;
  routeInputBlocking(aggregateRef: BlobRefV2, receiptRef: BlobRefV2): Promise<SystemCommandOutcome>;
  recordOutputBlocking(aggregateRef: BlobRefV2, receiptRef: BlobRefV2): Promise<SystemCommandOutcome>;
}

export interface ExecuteSystemSealInputV2 {
  taskId: string;
  commandId: string;
  sealWorkItemId: string;
  sealLeaseEpoch: number;
  sealAuthorityBaseRef: BlobRefV2;
  operationId: string;
  gate: SealGateInputV2;
  assemblerInput: ZhihuChapterAssemblerInputV1;
  mapSemanticDigest: string;
  contentRootDigest: string;
  reviewBundleRef: BlobRefV2;
  templateSnapshotHash: string;
  submitterWorkItemId: string;
  submitterAgentId: string;
  submitterAuthorityBaseRef: BlobRefV2;
  submitterLogicalAssignmentId: string;
  submitterMaxAutomaticRetries: number;
}

function failure(code: string, aggregateRef?: BlobRefV2): SystemCommandOutcome {
  return {
    kind: 'retryable_failure',
    failureCode: code,
    failureDigest: createHash('sha256').update(code, 'utf8').digest('hex'),
    validatorAggregateRef: aggregateRef ?? null,
  };
}

export class SystemSealServiceV2 {
  constructor(private readonly deps: SystemSealServiceDependenciesV2) {}

  async execute(input: ExecuteSystemSealInputV2): Promise<SystemCommandOutcome> {
    const gate = evaluateSystemSealGate(input.gate);
    if (!gate.ready) return failure(`SEAL_GATE_UNMET:${gate.unmetReasons.join(',')}`);
    if (
      input.templateSnapshotHash !== input.gate.frozenTemplateSnapshotHash
      || input.templateSnapshotHash !== input.gate.resolvedTemplateSnapshotHash
    ) {
      return failure('SEAL_GATE_UNMET:ASSEMBLER_TEMPLATE_IDENTITY_MISMATCH');
    }

    const sealInput = await this.deps.validate('seal_input', null);
    if (sealInput.outcome === 'infrastructure_failure') return failure('SEAL_INPUT_INFRASTRUCTURE', sealInput.aggregateRef);
    if (sealInput.outcome === 'blocking_invalid') {
      if (sealInput.blockingReceiptRef === null) return failure('SEAL_INPUT_RECEIPT_MISSING', sealInput.aggregateRef);
      return this.deps.routeInputBlocking(sealInput.aggregateRef, sealInput.blockingReceiptRef);
    }

    let outputs;
    try {
      outputs = await this.deps.assemblerRegistry.assemble(input.gate.frozenAssembler, input.assemblerInput, {
        mapRef: input.gate.activeMapRef,
        contentRevisionManifestRef: input.gate.activeManifestRef,
        templateSnapshotHash: input.templateSnapshotHash,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return failure(`ASSEMBLER_FAILED:${canonicalJsonSha256(reason)}`);
    }
    if (outputs.length !== 1) return failure('ASSEMBLER_OUTPUT_COUNT');
    const output = outputs[0]!;
    const artifact = { artifactId: `artifact-${input.sealWorkItemId}`, mediaType: output.mediaType, text: output.content };
    const artifactRef = await this.deps.blobs.prepare('artifact', artifact);
    const sealOutput = await this.deps.validate('seal_output', artifactRef);
    if (sealOutput.outcome === 'infrastructure_failure') return failure('SEAL_OUTPUT_INFRASTRUCTURE', sealOutput.aggregateRef);
    if (sealOutput.outcome === 'blocking_invalid') {
      if (sealOutput.blockingReceiptRef === null) return failure('SEAL_OUTPUT_RECEIPT_MISSING', sealOutput.aggregateRef);
      return this.deps.recordOutputBlocking(sealOutput.aggregateRef, sealOutput.blockingReceiptRef);
    }

    const bundleCore = {
      sealWorkItemId: input.sealWorkItemId,
      reviewBundleRef: input.reviewBundleRef,
      contentRevisionManifestRef: input.gate.activeManifestRef,
      sealInputAggregateRef: sealInput.aggregateRef,
      sealOutputAggregateRef: sealOutput.aggregateRef,
      sealWarningCustodyRootRef: sealOutput.warningCustodyRootRef,
      assemblerDigest: input.gate.frozenAssembler.implementationDigest,
      artifactRef,
      artifactDigest: artifactRef.digest,
    };
    const bundle: SealValidationBundleV2 = {
      ...bundleCore,
      bundleDigest: canonicalJsonSha256(bundleCore),
    };
    const bundleRef = await this.deps.blobs.prepare('seal_validation_bundle', bundle);
    const record: SealRecordV2 = {
      taskId: input.taskId,
      mapRef: input.gate.activeMapRef,
      mapSemanticDigest: input.mapSemanticDigest,
      mapReviewBundleRef: input.gate.activeMapReviewBundleRef,
      contentRevisionManifestRef: input.gate.activeManifestRef,
      contentRootDigest: input.contentRootDigest,
      reviewBundleRef: input.reviewBundleRef,
      sealValidationBundleRef: bundleRef,
      templateSnapshotHash: input.templateSnapshotHash,
      assemblerDigest: input.gate.frozenAssembler.implementationDigest,
      artifactRef,
      artifactDigest: artifactRef.digest,
    };
    const sealRecordRef = await this.deps.blobs.prepare('seal_record', record);
    let staged: Awaited<ReturnType<SystemSealPublisherV2['stage']>>;
    try {
      staged = await this.deps.publisher.stage({
        taskId: input.taskId,
        sealWorkItemId: input.sealWorkItemId,
        sealRecordRef,
        templateSnapshotHash: input.templateSnapshotHash,
        artifactRef,
        files: outputs.map((item) => ({ name: item.artifactFile, mediaType: item.mediaType, content: item.content })),
      });
    } catch {
      return failure('ARTIFACT_STAGE_INFRASTRUCTURE', sealOutput.aggregateRef);
    }
    const delivery: SystemArtifactDeliveryV2 = {
      deliveryId: `delivery-${sealRecordRef.digest}`,
      producer: 'system:structured_seal',
      sealRecordRef,
      sealRecordDigest: sealRecordRef.digest,
      artifactId: staged.artifactId,
      artifactRef,
      artifactDigest: artifactRef.digest,
      custodyRef: staged.custodyRef,
      custodyDigest: staged.custodyRef.digest,
      submitterWorkItemId: input.submitterWorkItemId,
      submitterAgentId: input.submitterAgentId,
      templateSnapshotHash: input.templateSnapshotHash,
    };
    const deliveryRef = await this.deps.blobs.prepare('system_artifact_delivery', delivery);
    const submitterGrantSpecRef = await this.deps.blobs.prepare('write_grant_spec', buildReviewObservationGrantSpec({
      grantSpecId: `grant-${input.submitterWorkItemId}`,
      workItemId: input.submitterWorkItemId,
      authorityBaseRef: input.submitterAuthorityBaseRef,
      sessionKind: null,
      reviewAssignmentId: null,
      roundId: null,
      roundKind: null,
      snapshotHash: input.templateSnapshotHash,
      maxContextBytes: input.gate.frozenAssembler.budget.maxInputBytes,
    }));
    let published: Awaited<ReturnType<SystemSealPublisherV2['publish']>>;
    try {
      published = await this.deps.publisher.publish({
      taskId: input.taskId,
      operationId: input.operationId,
      sealWorkItemId: input.sealWorkItemId,
      sealCommandId: input.commandId,
      sealLeaseEpoch: input.sealLeaseEpoch,
      sealAuthorityBaseRef: input.sealAuthorityBaseRef,
      sealRecordRef,
      sealValidationBundleRef: bundleRef,
      artifactRef,
      custodyRef: staged.custodyRef,
      deliveryRef,
      delivery,
      submitterAuthorityBaseRef: input.submitterAuthorityBaseRef,
      submitterGrantSpecRef,
      submitterLogicalAssignmentId: input.submitterLogicalAssignmentId,
      submitterMaxAutomaticRetries: input.submitterMaxAutomaticRetries,
      mapRef: input.gate.activeMapRef,
      contentRevisionManifestRef: input.gate.activeManifestRef,
      reviewBundleRef: input.reviewBundleRef,
      files: outputs.map((item) => ({
        name: item.artifactFile,
        mediaType: item.mediaType,
        hash: createHash('sha256').update(item.content, 'utf8').digest('hex'),
      })),
      });
    } catch {
      return failure('SEAL_PUBLISH_INFRASTRUCTURE', sealOutput.aggregateRef);
    }
    if (!sameRef(published.deliveryRef, deliveryRef)) return failure('DELIVERY_REF_MISMATCH');
    return { kind: 'completed', resultRefs: [bundleRef, sealRecordRef, artifactRef, deliveryRef] };
  }
}

/** Production append-facade adapter; no EventStore import leaks into runtime. */
export function createFacadeSystemSealPublisher(input: {
  facade: AuthoritativeAppendFacadeV2;
  readTail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  stage: SystemSealPublisherV2['stage'];
  promote?(seal: Parameters<SystemSealPublisherV2['publish']>[0], published: { artifactVersion: number; deliveryRef: BlobRefV2 }): Promise<void>;
}): SystemSealPublisherV2 {
  return {
    stage: input.stage,
    async publish(seal) {
      const tail = await input.readTail(seal.taskId);
      const payload = {
        family: 'seal_publish' as const,
        operationId: seal.operationId,
        taskId: seal.taskId,
        artifactRef: seal.artifactRef,
        artifactFile: seal.files[0]?.name ?? '',
        artifactFileHash: seal.files[0]?.hash ?? '',
        sealRecordRef: seal.sealRecordRef,
        sealValidationBundleRef: seal.sealValidationBundleRef,
        deliveryRef: seal.deliveryRef,
        custodyRef: seal.custodyRef,
        mapRef: seal.mapRef,
        contentRevisionManifestRef: seal.contentRevisionManifestRef,
        reviewBundleRef: seal.reviewBundleRef,
        sealWorkItemId: seal.sealWorkItemId,
        sealCommandId: seal.sealCommandId,
        sealLeaseEpoch: seal.sealLeaseEpoch,
        sealAuthorityBaseRef: seal.sealAuthorityBaseRef,
        submitterWorkItemId: seal.delivery.submitterWorkItemId,
        submitterAuthorityBaseRef: seal.submitterAuthorityBaseRef,
        submitterGrantSpecRef: seal.submitterGrantSpecRef,
        submitterLogicalAssignmentId: seal.submitterLogicalAssignmentId,
        submitterMaxAutomaticRetries: seal.submitterMaxAutomaticRetries,
      };
      const result = await input.facade.publishWithPin({
        taskId: seal.taskId,
        operationId: seal.operationId,
        payload,
        intent: { handlerKind: 'system_seal_publish', handlerVersion: 1 },
        preparedRefs: [
          seal.artifactRef, seal.sealRecordRef, seal.sealValidationBundleRef,
          seal.deliveryRef, seal.custodyRef,
          seal.mapRef, seal.contentRevisionManifestRef, seal.reviewBundleRef,
          seal.sealAuthorityBaseRef, seal.submitterAuthorityBaseRef,
          seal.submitterGrantSpecRef,
        ],
        expectedTailSequence: tail.lastSequence,
        expectedTailCommitId: tail.lastCommitId,
      });
      const event = result.events.find((entry) => entry.event.type === 'artifact_published_v2')?.event;
      if (event === undefined || event.type !== 'artifact_published_v2') throw new Error('system Seal publication omitted artifact_published_v2');
      const published = { artifactVersion: event.artifactVersion, deliveryRef: event.deliveryRef };
      await input.promote?.(seal, published);
      return published;
    },
  };
}

/** Production custody adapter: stage before lock, promote/recover after event allocation. */
export function createArtifactStoreSystemSealPublisher(input: {
  facade: AuthoritativeAppendFacadeV2;
  readTail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  artifactStore: Pick<ArtifactStore, 'stageSystemArtifact' | 'promoteSystemArtifact'>;
}): SystemSealPublisherV2 {
  return createFacadeSystemSealPublisher({
    facade: input.facade,
    readTail: input.readTail,
    stage: async (stage) => {
      const format = stage.files[0]?.mediaType === 'text/plain' ? 'text' : 'markdown';
      const artifactId = `artifact-${stage.sealWorkItemId}`;
      const custodyRef = stage.artifactRef;
      const payload: StageSystemArtifactInputV2 = {
        sealWorkItemId: stage.sealWorkItemId,
        artifactId,
        title: 'Sealed structured artifact',
        format,
        producerWorkItemId: stage.sealWorkItemId,
        sealRecordRef: stage.sealRecordRef,
        artifactRef: stage.artifactRef,
        custodyRef,
        templateSnapshotHash: stage.templateSnapshotHash,
        files: stage.files.map((file) => ({ name: file.name, content: file.content })),
      };
      await input.artifactStore.stageSystemArtifact('system_seal', stage.taskId, payload);
      return { artifactId, custodyRef };
    },
    promote: async (seal, published) => {
      const payload: PromoteSystemArtifactInputV2 = {
        sealWorkItemId: seal.sealWorkItemId,
        artifactRef: seal.artifactRef,
        artifactVersion: published.artifactVersion,
        deliveryRef: published.deliveryRef,
      };
      await input.artifactStore.promoteSystemArtifact('system_seal', seal.taskId, payload);
    },
  });
}

export function createSystemSealCommandHandler(
  service: SystemSealServiceV2,
  resolveInput: (taskId: string, payloadRef: BlobRefV2) => Promise<ExecuteSystemSealInputV2>,
): SystemCommandHandler {
  return {
    commandKind: 'seal',
    async execute(ctx) {
      const input = await resolveInput(ctx.taskId, ctx.payloadRef);
      if (input.taskId !== ctx.taskId || input.commandId !== ctx.commandId || input.sealWorkItemId !== ctx.workItemId) {
        return failure('SEAL_COMMAND_AUTHORITY_MISMATCH');
      }
      return service.execute(input);
    },
  };
}
