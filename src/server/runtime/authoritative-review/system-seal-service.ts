/**
 * Task 21 system-owned Seal service (design §16.2/§16.3; spec §13.5).
 *
 * P1#2: the Seal Gate is the PURE ten-condition gate
 * (`evaluateSealGate`, seal-gate.ts). The service never accepts a caller-
 * supplied boolean digest of readiness or caller-supplied authority refs; it
 * consumes `ResolvedSealAuthorityV2` derived by `seal-authority-resolver.ts`
 * from the event projection + resolved blob graph (exact-ref bound to the
 * active Map / finalized manifest / MapReviewBundle / ReviewBundle / profile /
 * template). Any unmet condition (frozen `sealConditionCodes`, stable order)
 * fails the command closed before the Assembler/validators are reached.
 *
 * P2#8: the canonical Seal warning custody root is BUILT from the seal_input
 * advisory validator custody (seal_output warning entries stay empty in the
 * first release). `sealWarningCustodyRootRef` on `SealValidationBundleV2` is
 * never copied from a validator/supplier-supplied ref; it is the system-
 * authored, replayable seal-scope custody, so SealRecord → SealValidationBundle
 * replay makes the seal_input advisory warnings visible.
 */
import { createHash } from 'node:crypto';

import type { BlobRefV2, SealRecordV2, SystemArtifactDeliveryV2 } from '../../../shared/authoritative-review-v2';
import type { SealValidationBundleV2, ValidatorAggregateOutcomeV2, ValidatorAggregateV2, ValidationWarningCustodyRootV2 } from '../../authoritative-review/authority-types';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { assertTemplateIdentityMatchesSeal, evaluateSealGate, sealConditionCodes } from '../../authoritative-review/seal-gate';
import { sameRef } from './authority-base';
import type { SystemCommandHandler, SystemCommandOutcome } from './system-command-registry';
import { AssemblerRegistryV2 } from './assembler-registry';
import { buildReviewObservationGrantSpec } from './review-coordinator';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { ArtifactStore, PromoteSystemArtifactInputV2, StageSystemArtifactInputV2 } from '../../storage/artifact-store';
import {
  SealAuthorityError,
  type ResolvedSealAuthorityV2,
  type SealAuthorityResolverV2,
} from './seal-authority-resolver';

export const SEAL_WARNING_CUSTODY_SUPERSESSION_POLICY_VERSION = 'seal-v1';

export interface SealValidatorRunV2 {
  outcome: ValidatorAggregateOutcomeV2;
  aggregateRef: BlobRefV2;
  blockingReceiptRef: BlobRefV2 | null;
}

export interface SystemSealBlobWriter {
  prepare(kind: 'artifact' | 'seal_validation_bundle' | 'seal_record' | 'system_artifact_delivery' | 'write_grant_spec' | 'validation_warning_custody_root', value: unknown): Promise<BlobRefV2>;
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
  /** Resolve any registered blob (Seal custody replay, P2#8). */
  resolveBlob(taskId: string, ref: BlobRefV2): Promise<unknown>;
  /** System-derived gate authority (P1#2). */
  resolveSealAuthority: SealAuthorityResolverV2;
}

export interface ExecuteSystemSealInputV2 {
  taskId: string;
  commandId: string;
  sealWorkItemId: string;
  sealLeaseEpoch: number;
  sealAuthorityBaseRef: BlobRefV2;
  payloadRef: BlobRefV2;
}

function failure(code: string, aggregateRef?: BlobRefV2): SystemCommandOutcome {
  return {
    kind: 'retryable_failure',
    failureCode: code,
    failureDigest: createHash('sha256').update(code, 'utf8').digest('hex'),
    validatorAggregateRef: aggregateRef ?? null,
  };
}

function authorityFailure(error: SealAuthorityError): SystemCommandOutcome {
  return failure(`SEAL_AUTHORITY:${error.code}`);
}

/** §16.3 seal-scope publication operation id (replayable from immutable bytes). */
export function sealPublishOperationId(sealWorkItemId: string, artifactDigest: string): string {
  return canonicalJsonSha256({ sealWorkItemId, artifactDigest });
}

/**
 * §16.3 canonical Seal advisory custody: ONE entry for the seal_input validators
 * (advisory receipts are visible through the aggregate/warning root); seal_output
 * warning entries stay EMPTY in the first release. Building it here from the
 * RESOLVED seal_input aggregate keeps the bundle's warning custody system-owned
 * and replayable — never a supplier-supplied ref.
 */
export function buildSealWarningCustodyRoot(input: {
  taskId: string;
  sealWorkItemId: string;
  reviewBundleRef: BlobRefV2;
  sealInputAggregateRef: BlobRefV2;
  sealInputAggregate: ValidatorAggregateV2;
}): ValidationWarningCustodyRootV2 {
  const baseRefs = [input.reviewBundleRef, input.sealInputAggregateRef]
    .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  const record = {
    scope: 'seal' as const,
    taskId: input.taskId,
    baseRefs,
    entries: [
      {
        trigger: 'seal_input' as const,
        inputRef: input.sealInputAggregate.inputRef,
        inputDigest: input.sealInputAggregate.inputRef.digest,
        executionScope: { sealWorkItemId: input.sealWorkItemId },
        validatorAggregateRef: input.sealInputAggregateRef,
        warningRootRef: input.sealInputAggregate.warningRootRef,
      },
    ],
    supersessionPolicyVersion: SEAL_WARNING_CUSTODY_SUPERSESSION_POLICY_VERSION,
    rootDigest: '',
  };
  const { rootDigest: _ignored, ...body } = record;
  return { ...record, rootDigest: canonicalJsonSha256(body) };
}

export class SystemSealServiceV2 {
  constructor(private readonly deps: SystemSealServiceDependenciesV2) {}

  async execute(input: ExecuteSystemSealInputV2): Promise<SystemCommandOutcome> {
    let resolved: ResolvedSealAuthorityV2;
    try {
      resolved = await this.deps.resolveSealAuthority({
        taskId: input.taskId,
        workItemId: input.sealWorkItemId,
        commandId: input.commandId,
        leaseEpoch: input.sealLeaseEpoch,
        authorityBaseRef: input.sealAuthorityBaseRef,
        payloadRef: input.payloadRef,
      });
    } catch (error) {
      if (error instanceof SealAuthorityError) return authorityFailure(error);
      return failure('SEAL_AUTHORITY_RESOLUTION_INFRASTRUCTURE');
    }

    const gate = resolved.gate;
    const gateResult = assertTemplateIdentityMatchesSeal({
      templateSnapshotHash: gate.templateSnapshotHash,
      assemblerDigest: gate.assemblerDigest,
      resourceManifestDigest: gate.resourceManifestDigest,
      frozenTemplateSnapshotHash: gate.frozenTemplateSnapshotHash,
      frozenAssemblerDigest: gate.frozenAssemblerDigest,
      frozenResourceManifestDigest: gate.frozenResourceManifestDigest,
    });
    if (gateResult.length > 0) {
      return failure(`SEAL_GATE_UNMET:${sealConditionCodes.TEMPLATE_MISMATCH}`);
    }

    // The pure §16.2 ten-condition gate. Unresolvable derivation paths already
    // surfaced as unmet conditions (frozen codes, stable order) — never guessed.
    const gateConclusion = evaluateSealGate(gate);
    if (!gateConclusion.eligible) {
      return failure(`SEAL_GATE_UNMET:${gateConclusion.unmetConditions.map((c) => c.code).join(',')}`);
    }
    // Condition 3 guarantees a non-null active MapReviewBundle; the pure gate's
    // nullable field needs a narrowing guard before it reaches the record.
    const activeMapReviewBundleRef = gate.activeMapReviewBundleRef;
    if (activeMapReviewBundleRef === null) {
      return failure(`SEAL_GATE_UNMET:${sealConditionCodes.MAP_REVIEW_BUNDLE_MISSING}`);
    }

    const sealInput = await this.deps.validate('seal_input', null);
    if (sealInput.outcome === 'infrastructure_failure') return failure('SEAL_INPUT_INFRASTRUCTURE', sealInput.aggregateRef);
    if (sealInput.outcome === 'blocking_invalid') {
      if (sealInput.blockingReceiptRef === null) return failure('SEAL_INPUT_RECEIPT_MISSING', sealInput.aggregateRef);
      return this.deps.routeInputBlocking(sealInput.aggregateRef, sealInput.blockingReceiptRef);
    }

    let outputs;
    try {
      outputs = await this.deps.assemblerRegistry.assemble(resolved.assembler, resolved.assemblerInput, {
        mapRef: gate.activeMapRef,
        contentRevisionManifestRef: gate.baseFinalizedManifestRef,
        templateSnapshotHash: gate.templateSnapshotHash,
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

    // P2#8: canonical Seal advisory custody built from the RESOLVED seal_input
    // aggregate (seal_output warnings stay empty). Never a supplier-supplied ref.
    const rawSealInputAggregate = await this.deps.resolveBlob(input.taskId, sealInput.aggregateRef);
    if (rawSealInputAggregate === null || rawSealInputAggregate === undefined || typeof rawSealInputAggregate !== 'object') {
      return failure('SEAL_INPUT_AGGREGATE_UNRESOLVED', sealInput.aggregateRef);
    }
    const sealInputAggregate = rawSealInputAggregate as ValidatorAggregateV2;
    const sealWarningCustodyRootRef = await this.deps.blobs.prepare('validation_warning_custody_root', buildSealWarningCustodyRoot({
      taskId: input.taskId,
      sealWorkItemId: input.sealWorkItemId,
      reviewBundleRef: gate.reviewBundleRef,
      sealInputAggregateRef: sealInput.aggregateRef,
      sealInputAggregate,
    }));

    const bundleCore = {
      sealWorkItemId: input.sealWorkItemId,
      reviewBundleRef: gate.reviewBundleRef,
      contentRevisionManifestRef: gate.baseFinalizedManifestRef,
      sealInputAggregateRef: sealInput.aggregateRef,
      sealOutputAggregateRef: sealOutput.aggregateRef,
      sealWarningCustodyRootRef,
      assemblerDigest: resolved.assembler.implementationDigest,
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
      mapRef: gate.activeMapRef,
      mapSemanticDigest: gate.activeMapSemanticDigest,
      mapReviewBundleRef: activeMapReviewBundleRef,
      contentRevisionManifestRef: gate.baseFinalizedManifestRef,
      contentRootDigest: gate.contentRootDigest,
      reviewBundleRef: gate.reviewBundleRef,
      sealValidationBundleRef: bundleRef,
      templateSnapshotHash: gate.templateSnapshotHash,
      assemblerDigest: resolved.assembler.implementationDigest,
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
        templateSnapshotHash: gate.templateSnapshotHash,
        artifactRef,
        files: outputs.map((item) => ({ name: item.artifactFile, mediaType: item.mediaType, content: item.content })),
      });
    } catch {
      return failure('ARTIFACT_STAGE_INFRASTRUCTURE', sealOutput.aggregateRef);
    }
    const operationId = sealPublishOperationId(input.sealWorkItemId, artifactRef.digest);
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
      submitterWorkItemId: resolved.submitter.workItemId,
      submitterAgentId: resolved.submitter.agentId,
      templateSnapshotHash: gate.templateSnapshotHash,
    };
    const deliveryRef = await this.deps.blobs.prepare('system_artifact_delivery', delivery);
    const submitterGrantSpecRef = await this.deps.blobs.prepare('write_grant_spec', buildReviewObservationGrantSpec({
      grantSpecId: `grant-${resolved.submitter.workItemId}`,
      workItemId: resolved.submitter.workItemId,
      authorityBaseRef: input.sealAuthorityBaseRef,
      sessionKind: null,
      reviewAssignmentId: null,
      roundId: null,
      roundKind: null,
      snapshotHash: gate.templateSnapshotHash,
      maxContextBytes: resolved.assembler.budget.maxInputBytes,
    }));
    let published: Awaited<ReturnType<SystemSealPublisherV2['publish']>>;
    try {
      published = await this.deps.publisher.publish({
      taskId: input.taskId,
      operationId,
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
      submitterAuthorityBaseRef: input.sealAuthorityBaseRef,
      submitterGrantSpecRef,
      submitterLogicalAssignmentId: resolved.submitter.logicalAssignmentId,
      submitterMaxAutomaticRetries: resolved.submitter.maxAutomaticRetries,
      mapRef: gate.activeMapRef,
      contentRevisionManifestRef: gate.baseFinalizedManifestRef,
      reviewBundleRef: gate.reviewBundleRef,
      files: outputs.map((item) => ({
        name: item.artifactFile,
        mediaType: item.mediaType,
        hash: createHash('sha256').update(item.content, 'utf8').digest('hex'),
      })),
      });
    } catch {
      return failure('SEAL_PUBLISH_INFRASTRUCTURE', sealOutput.aggregateRef);
    }
    if (!sameRef(published.deliveryRef, deliveryRef)) {
      return failure('DELIVERY_REF_MISMATCH');
    }
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

/**
 * The SystemCommand `seal` handler. All authority (lease/work item/base/
 * payload) is derived system-side by the service's `resolveSealAuthority`;
 * nothing caller-supplied reaches the Gate.
 */
export function createSystemSealCommandHandler(
  service: SystemSealServiceV2,
): SystemCommandHandler {
  return {
    commandKind: 'seal',
    async execute(ctx) {
      return service.execute({
        taskId: ctx.taskId,
        commandId: ctx.commandId,
        sealWorkItemId: ctx.workItemId,
        sealLeaseEpoch: ctx.leaseEpoch,
        sealAuthorityBaseRef: ctx.authorityBaseRef,
        payloadRef: ctx.payloadRef,
      });
    },
  };
}