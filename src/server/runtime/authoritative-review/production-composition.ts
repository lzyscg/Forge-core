/**
 * Production composition root (design §17.2, spec §9.2/§10.2): the ONE
 * installation path that binds the closed SystemCommand allowlist, the
 * task-scoped v2 domain services, and a `V2AttemptCoordinator` + scheduling
 * tick driver to the authoritative runtime.
 *
 * This module is the P1#1 correction: before it existed, `SystemCommandRegistry`
 * was only ever constructed with `createDefaultSystemCommandHandlers()` (six
 * `NOT_IMPLEMENTED` retryable doubles) and the real handler factories were only
 * invoked inside their own service tests — a leased `system_seal` WorkItem
 * parked/retried forever instead of sealing. `installAuthoritativeReviewRuntime`
 * installs the real handlers, constructs the System Seal service (per task, so
 * the task-agnostic `validate(stage, artifactRef)` / `blobs.prepare` /
 * `resolveTemplateIdentity` dep signatures still bind the exact task authority),
 * and wires the scheduler tick that executes freshly leased work items. A
 * service that is not composed is represented by an explicit terminal
 * fail-closed outcome; it is never silently left as a retrying stub.
 *
 * Execution discipline (the Task 20 production precedent): every domain command
 * handler that completes publishes the WHOLE terminal batch — including
 * `structured_system_command_completed` + `structured_work_item_completed` —
 * through the facade using `attemptContinuationOperationId(taskId, workItemId,
 * commandId, 'complete')` as the publication operation id, so the
 * attempt-coordinator's subsequent `completeWorkItem` REPLAYS the committed
 * operation (response-loss idempotent, exactly one terminal batch). The System
 * Seal publisher below follows that pattern: it stages through the unforgeable
 * `ArtifactStore.createSystemSealPublisher()` capability and ignores the
 * caller-supplied §16.3 operation id in favour of the coordinator's
 * completion operation id.
 *
 * V1 is untouched; with the authoritative capability disabled the whole
 * composition is legal but idle (nothing is leased/executed — the scheduling
 * engine's eligibility gate and the coordinator's claim key decide).
 */
import type { BlobRefV2, AuthoritativeReviewExecutionEligibilityV1 } from '../../../shared/authoritative-review-v2';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { parseBlob } from '../../authoritative-review/object-registry';
import type {
  AuthoritativeReviewProjectionV2,
} from '../../storage/authoritative-review-state';
import { validateAuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import { deterministicEventId } from '../../storage/authoritative-publication-intent-registry';
import type { AuthoritativeReviewBlobStore } from '../../storage/authoritative-review-blob-store';
import type { AuthoritativePublicationStore, StoreFenceProof } from '../../storage/authoritative-publication-store';
import type { ArtifactStore, SystemSealPublisherCapability } from '../../storage/artifact-store';
import type { TraceStore } from '../../storage/trace-store';
import type { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import type { WorkItemCoordinatorV2 } from './work-item-coordinator';
import { sameRef } from './authority-base';
import type { AuthoritativeV2SchedulingEngine } from '../task-scheduler';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import type { ValidatorSlotType, ValidatorBlobStore } from './validator-engine';
import { ValidatorEngine } from './validator-engine';
import type { ValidatorRegistry } from './validator-registry';
import { ValidatorRegistry as ValidatorRegistryImpl } from './validator-registry';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES, builtinSourceOf } from './builtin-validators';
import { AssemblerRegistryV2 } from './assembler-registry';
import type { AssemblerRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type { FrozenStructuredSlotContractV2 } from '../../template/structured-slot-contract-v2';
import type { FrozenTemplate } from '../../template/template-schema';
import type { FrozenTaskProfileV2 } from './task-lifecycle';
import {
  SystemCommandRegistry,
  type SystemCommandHandler,
} from './system-command-registry';
import { V2AttemptCoordinator, type V2AttemptOutcome, type V2SchedulingTickResult, type TerminalFailInputV2 } from './attempt-coordinator';
import type { V2AssignmentRunner } from './assignment-runner';
import {
  SystemSealServiceV2,
  createSystemSealCommandHandler,
  type SystemSealBlobWriter,
  type SystemSealPublisherV2,
  type SealValidatorRunV2,
} from './system-seal-service';
import {
  createSystemSealAuthorityResolver,
  SealAuthorityError,
  type SealAuthorityResolverDependenciesV2,
  type SealProjectionViewV2,
} from './seal-authority-resolver';
import type { ZhihuChapterAssemblerInputV1, ZhihuChapterAssemblerNodeV1 } from './builtin-assemblers/zhihu-chapter-v1';
import type { MapSnapshotV2, ContentRevisionManifestV2, SlotContentVersionV2, AuthorityBaseSetV2 } from '../../authoritative-review/authority-types';
import type { ContentPlanService } from './content-plan-service';
import type { MapBuildService } from './map-build-service';
import type { RepairService } from './repair-service';
import type { MigrationServiceV2 } from './migration-service';
import type { ContentReviewService } from './content-review-service';
import type { MapReviewService } from './map-review-service';
import type { ProductionV2TaskDomainRuntime } from './production-domain-runtime';
import type { DispatchResolver } from './grant-service';
import { createMapFinalizeSystemCommandHandler } from './map-build-service';
import { createGenerationFinalizeSystemCommandHandler } from './content-plan-service';
import { createRepairFinalizeSystemCommandHandler } from './repair-service';
import { createMigrationValidationBatchSystemCommandHandler, createMigrationReviewSettlementSystemCommandHandler } from './migration-service';
import { createContentReviewSettlementSystemCommandHandler } from './content-review-service';
import { createMapReviewSettlementSystemCommandHandler } from './map-review-service';
import { attemptContinuationOperationId } from './attempt-coordinator';
import { SystemArtifactDeliveryValidatorV2 } from './system-artifact-delivery';

/** The stable rejection code the seal output blocking path returns. */
export const SEAL_OUTPUT_BLOCKING_FAILURE_CODE = 'ARTIFACT_VALIDATION_FAILED';

/**
 * The bounded event-store seam the seal-rejection direct append needs. A
 * STRUCTURAL type (never `EventStore` — the runtime tree statically rejects
 * EventStore imports; the facade abstracts it). Only tail/read/append are
 * used, all fenced by the publication store lock.
 */
export interface SealEventStoreSeam {
  tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  readBatchByCommitId(taskId: string, commitId: string): Promise<readonly { event: unknown }[] | null>;
  appendBatch(
    taskId: string,
    commitId: string,
    events: readonly unknown[],
    options: { expectedLastSequence: number; fenceProof?: StoreFenceProof },
  ): Promise<unknown[]>;
}

/** The deterministic submitter WorkItem identity of the seal's next stage. */
export function deterministicSubmitterWorkItemId(taskId: string): string {
  return `wi-submit-${canonicalJsonSha256({ taskId, role: 'submitter' }).slice(0, 24)}`;
}

/** The deterministic submitter logical-assignment identity. */
export function deterministicSubmitterLogicalAssignmentId(taskId: string): string {
  return `la-${deterministicSubmitterWorkItemId(taskId)}`;
}

/** Deterministic seal-rejection operation id (replay-stable per stage). */
export function sealRejectionOperationId(taskId: string, stage: 'input' | 'output'): string {
  return canonicalJsonSha256({ taskId, label: 'system_seal_validation_rejected', stage });
}

/* ------------------------------------------------------------------ */
/* per-task template identity                                          */
/* ------------------------------------------------------------------ */

/**
 * The template-owned coverage facts the seal gate needs: relation TYPE id ->
 * enforcement (condition 5 enumerates the ACTIVE Map's blocking relations) and
 * slot TYPE id -> presence. Both are frozen template contract facts.
 */
function templateCoverageOf(contract: FrozenStructuredSlotContractV2): {
  relationEnforcement: Map<string, 'blocking' | 'advisory'>;
  contentPresence: Map<string, 'required' | 'optional'>;
} {
  const relationEnforcement = new Map<string, 'blocking' | 'advisory'>();
  for (const relation of contract.relationTypes) {
    relationEnforcement.set(relation.id, relation.enforcement);
  }
  const contentPresence = new Map<string, 'required' | 'optional'>();
  for (const slotType of contract.slotTypes) {
    contentPresence.set(
      slotType.id,
      slotType.content.presence === 'required' ? 'required' : 'optional',
    );
  }
  return { relationEnforcement, contentPresence };
}

/** `ValidatorSlotType` (the engine's schema enrichment view) from the contract. */
function validatorSlotTypesOf(contract: FrozenStructuredSlotContractV2): ValidatorSlotType[] {
  return contract.slotTypes.map((slotType) => ({
    id: slotType.id,
    name: slotType.name,
    description: slotType.description,
    contentPresence: slotType.content.presence,
    contentSchema: slotType.content.presence === 'forbidden'
      ? slotType.specSchema
      : slotType.content.schema,
  }));
}

/* ------------------------------------------------------------------ */
/* in-memory validator blob store (engine `put`/`resolve` surface)     */
/* ------------------------------------------------------------------ */

/**
 * The engine writes envelope/aggregate/receipt/warning blobs into an
 * in-memory store first (its deterministic content-addressed `put`), then the
 * caller persists every produced blob through the real facade. `parseBlob`
 * verifies the bytes against the kind so a malformed engine output fails loud
 * instead of silently landing an unverifiable aggregate.
 */
class CompositionValidatorBlobStore implements ValidatorBlobStore {
  readonly produced: Array<{ kind: string; value: unknown }> = [];

  private readonly byKey = new Map<string, unknown>();

  put(kind: Parameters<typeof parseBlob>[0], value: unknown): BlobRefV2 {
    const { ref } = parseBlob(kind, value);
    this.byKey.set(`${ref.kind}:${ref.digest}`, value);
    this.produced.push({ kind, value });
    return ref;
  }

  resolve(ref: BlobRefV2): unknown | null {
    return this.byKey.get(`${ref.kind}:${ref.digest}`) ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* the composition                                                     */
/* ------------------------------------------------------------------ */

/** The v2 stack slices `installAuthoritativeReviewRuntime` consumes. */
export interface AuthoritativeReviewCompositionInputV2 {
  coordinator: WorkItemCoordinatorV2;
  facade: AuthoritativeAppendFacadeV2;
  blobStore: AuthoritativeReviewBlobStore;
  wakeups: AuthoritativeWakeupIndexV1;
  /** The ArtifactStore already wired with the v2 blob resolver (closure
   * cross-check) — its unforgeable seal capability stages/promotes the system
   * artifact. */
  artifacts: ArtifactStore;
  /** The deterministic §10.4 scheduling engine (the tick's pass half). */
  scheduling: AuthoritativeV2SchedulingEngine;
  /** Event projection reader (the coordinator's readProjectionState is the
   * canonical source; core-service passes its v2 projection). */
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
  /** The task-FROZEN profile carrier (row refs + frozen digest + snapshot hash). */
  frozenProfile(taskId: string): Promise<FrozenTaskProfileV2>;
  /** The task-FROZEN template snapshot (the v2 contract source). */
  frozenTemplate(taskId: string): Promise<FrozenTemplate>;
  /** The FULL installed authoritative profile body (the validator engine
   * resolves registrations against its budgetProfiles/installedHandlers — the
   * profile_snapshot blob parser strips those groups, so the body comes from
   * the frozen profile source, never a stripped re-read). */
  profileBody(taskId: string): Promise<AuthoritativeReviewProfileSnapshotV1Body>;
  frozenAutomaticRetries(taskId: string): Promise<number>;
  eligibility(frozenProfileDigest: string): AuthoritativeReviewExecutionEligibilityV1;
  /** The v2 Agent-session runner (Task 13's tool-factory binds its tools). */
  runner: V2AssignmentRunner;
  clock(): string;
  traces?: TraceStore;
  log?(line: string): void;
  /** The terminal-fail envelope seam (the lifecycle's terminalFailWorkItem);
   * the seal_output blocking path commits `ARTIFACT_VALIDATION_FAILED` through
   * it. Absent, the coordinator's terminal-fail path fails loud (no seam). */
  terminalFail?(taskId: string, input: TerminalFailInputV2): Promise<void>;
  /** The task-scoped domain services shared by command and Pi-tool bridges.
   * Missing services are surfaced as explicit fail-closed outcomes rather
   * than hidden behind a retrying stub. */
  mapBuildService?: MapBuildService;
  contentPlanService?: ContentPlanService;
  repairService?: RepairService;
  migrationService?: MigrationServiceV2;
  contentReviewService?: ContentReviewService;
  mapReviewService?: MapReviewService;
  /** Task-scoped domain services shared with the Pi tool factory. */
  domainRuntimeFor?(taskId: string): Promise<ProductionV2TaskDomainRuntime | undefined>;
  /** Resolves the committed assignment dispatch for Pi context reconstruction. */
  resolveDispatch?: DispatchResolver;
  /** Event store + publication store for the direct seal-rejection append
   * (no publication handler is registered for `structured_seal_validation_
   * rejected_v2` yet; the append is fenced + schema-validated). */
  eventStore: SealEventStoreSeam;
  publicationStore: AuthoritativePublicationStore;
}

/** Everything the runtime + core-service consume from one installation. */
export interface AuthoritativeReviewCompositionV2 {
  systemCommands: SystemCommandRegistry;
  attempts: V2AttemptCoordinator;
  /** One deterministic scheduling tick: pass + execute every fresh lease. */
  runTick(now?: string): Promise<V2SchedulingTickResult>;
  /** The real System Seal service bound to one task (cached per task). */
  sealServiceFor(taskId: string): SystemSealServiceV2;
  /** The installed `seal` registry member (per-task dispatcher). */
  sealCommandHandler: SystemCommandHandler;
}

/**
 * The production installation. All deps are real store/facade/frozen surfaces
 * — no call-string fabrication and no test doubles. The initial structure,
 * generation, repair, map/content review, validator, and seal paths are
 * task-scoped real services. A not-yet-composed migration service is reported
 * explicitly as `MIGRATION_RUNTIME_NOT_WIRED` rather than parked forever.
 */
export function installAuthoritativeReviewRuntime(
  input: AuthoritativeReviewCompositionInputV2,
): AuthoritativeReviewCompositionV2 {
  const registry = new SystemCommandRegistry();

  // ---- the five domain handlers (Tasks 15/16/17/19/20 services) ----
  // A task-scoped runtime is preferred in production: all command handlers
  // and Pi domain tools resolve the same frozen service bundle.  The direct
  // service fields remain for focused service tests and older callers.
  if (input.domainRuntimeFor !== undefined) {
    const missingProductionDomain = (
      ctx: Parameters<SystemCommandHandler['execute']>[0],
      code: string,
      reason: string,
    ): Awaited<ReturnType<SystemCommandHandler['execute']>> => ({
      kind: 'terminal_failure',
      failureCode: code,
      failureDigest: canonicalJsonSha256({
        taskId: ctx.taskId,
        workItemId: ctx.workItemId,
        commandKind: ctx.commandKind,
        reason,
      }),
      taskFailure: true,
    });
    const dynamicCommand = <T>(
      commandKind: 'map_finalize' | 'generation_finalize' | 'repair_finalize' | 'migration_validation_batch',
      select: (runtime: ProductionV2TaskDomainRuntime) => T | undefined,
      makeHandler: (service: T) => SystemCommandHandler,
    ): SystemCommandHandler => {
      return {
        commandKind,
        async execute(ctx) {
          const runtime = await input.domainRuntimeFor!(ctx.taskId);
          if (runtime === undefined) {
            return missingProductionDomain(ctx, 'AUTHORITATIVE_DOMAIN_RUNTIME_NOT_WIRED', 'task runtime unavailable');
          }
          const service = select(runtime);
          if (service === undefined) {
            return missingProductionDomain(
              ctx,
              commandKind === 'migration_validation_batch'
                ? 'MIGRATION_RUNTIME_NOT_WIRED'
                : 'AUTHORITATIVE_DOMAIN_SERVICE_NOT_WIRED',
              `service missing for ${commandKind}`,
            );
          }
          await runtime.refresh();
          return makeHandler(service).execute(ctx);
        },
      };
    };
    registry.replace(dynamicCommand('map_finalize', (runtime) => runtime.services.mapBuildService, createMapFinalizeSystemCommandHandler));
    registry.replace(dynamicCommand('generation_finalize', (runtime) => runtime.services.contentPlanService, createGenerationFinalizeSystemCommandHandler));
    registry.replace(dynamicCommand('repair_finalize', (runtime) => runtime.services.repairService, createRepairFinalizeSystemCommandHandler));
    registry.replace(dynamicCommand('migration_validation_batch', (runtime) => runtime.services.migrationService, createMigrationValidationBatchSystemCommandHandler));

    registry.replace({
      commandKind: 'review_settlement',
      async execute(ctx) {
        const runtime = await input.domainRuntimeFor!(ctx.taskId);
        if (runtime === undefined) {
          return missingProductionDomain(ctx, 'AUTHORITATIVE_DOMAIN_RUNTIME_NOT_WIRED', 'task runtime unavailable');
        }
        await runtime.refresh();
        if (ctx.payloadRef.kind === 'map_review_coverage_core') {
          return createMapReviewSettlementSystemCommandHandler(runtime.services.mapReviewService).execute(ctx);
        }
        if (ctx.payloadRef.kind === 'content_review_coverage_core') {
          return createContentReviewSettlementSystemCommandHandler(runtime.services.contentReviewService).execute(ctx);
        }
        if (ctx.payloadRef.kind === 'migration_validation_plan_spec' && runtime.services.migrationService !== undefined) {
          const mapHandler = createMapReviewSettlementSystemCommandHandler(runtime.services.mapReviewService);
          return createMigrationReviewSettlementSystemCommandHandler(
            runtime.services.migrationService,
            input.resolver,
            mapHandler,
          ).execute(ctx);
        }
        return missingProductionDomain(
          ctx,
          ctx.payloadRef.kind === 'migration_validation_plan_spec'
            ? 'MIGRATION_RUNTIME_NOT_WIRED'
            : 'AUTHORITATIVE_REVIEW_SETTLEMENT_PAYLOAD_UNSUPPORTED',
          `unsupported settlement payload ${ctx.payloadRef.kind}`,
        );
      },
    });
  } else {
    if (input.mapBuildService !== undefined) {
      registry.replace(createMapFinalizeSystemCommandHandler(input.mapBuildService));
    }
    if (input.contentPlanService !== undefined) {
      registry.replace(createGenerationFinalizeSystemCommandHandler(input.contentPlanService));
    }
    if (input.repairService !== undefined) {
      registry.replace(createRepairFinalizeSystemCommandHandler(input.repairService));
    }
    if (input.migrationService !== undefined) {
      registry.replace(createMigrationValidationBatchSystemCommandHandler(input.migrationService));
    }
    if (input.contentReviewService !== undefined) {
      registry.replace(createContentReviewSettlementSystemCommandHandler(input.contentReviewService));
    }
    if (input.mapReviewService !== undefined) {
      registry.replace(createMapReviewSettlementSystemCommandHandler(input.mapReviewService));
    }
    if (input.migrationService !== undefined) {
      // The migration half of review_settlement only intercepts migration
      // payloads; non-migration payloads fall through to whatever was installed
      // before (the Map-review or content-review settlement handler above).
      const prior = registry.resolve('review_settlement');
      registry.replace(createMigrationReviewSettlementSystemCommandHandler(input.migrationService, input.resolver, prior));
    }
  }

  // ---- shared cross-task infrastructure ----
  const assemblerRegistry = new AssemblerRegistryV2();
  const validatorRegistry: ValidatorRegistry = new ValidatorRegistryImpl(
    AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
  );

  /** Resolve any registered blob (seal custody replay + engine cores). */
  const resolveBlob = (taskId: string, ref: BlobRefV2): Promise<unknown> => input.resolver(taskId, ref);

  /** The installed profile body of one task (the engine resolves against it). */
  const profileBodyOf = async (taskId: string): Promise<AuthoritativeReviewProfileSnapshotV1Body> =>
    input.profileBody(taskId);

  /* ---------------- per-task System Seal service factory ---------------- */

  const sealServices = new Map<string, SystemSealServiceV2>();

  /**
   * Builds ONE SystemSealServiceV2 bound to a task. The deps whose public
   * signatures carry NO taskId (`validate`, `blobs.prepare`,
   * `resolveTemplateIdentity`, `installedTemplateIdentity`,
   * `buildAssemblerInput`, `submitterIdentity`, `routeInputBlocking`,
   * `recordOutputBlocking`) are closed over the task here, so every aggregate/
   * custody blob lands in the task's blob store and every authority read is
   * the task's projection — never a guessed identity.
   */
  const sealServiceFor = (taskId: string): SystemSealServiceV2 => {
    const existing = sealServices.get(taskId);
    if (existing !== undefined) return existing;

    const service = new SystemSealServiceV2(buildSealDependenciesFor(taskId));
    sealServices.set(taskId, service);
    return service;
  };

  /** One per-task `SystemSealBlobWriter`: every prepared blob is the task's
   * content-addressed blob, prepared through the same facade the events pin. */
  const blobsFor = (taskId: string): SystemSealBlobWriter => ({
    async prepare(kind, value) {
      return input.facade.prepareBlob(taskId, kind, value);
    },
  });

  /** The unforgeable stage/promote capability (single ArtifactStore holder). */
  const sealCapability: SystemSealPublisherCapability = input.artifacts.createSystemSealPublisher();

  /**
   * The production System Seal publisher for one task (Task 21 P1#4/P1#5):
   * stage before lock through the capability, then the facade's
   * `system_seal_publish` registration allocates the combined-history version
   * under the fresh-tail cross-process fence. The publication operation id is
   * the attempt-coordinator's completion id so the terminal `[scaffold_sealed,
   * artifact_published, delivery_created, submitter_work_item_created,
   * command_completed, work_item_completed]` batch is committed ONCE and the
   * coordinator's `completeWorkItem` replays it (the Task 20 precedent —
   * `sealPublishOperationId` is intentionally NOT used as the pin id).
   */
  const sealPublisherFor = (taskId: string): SystemSealPublisherV2 => ({
    async stage(input) {
      const format = input.files[0]?.mediaType === 'text/plain' ? 'text' : 'markdown';
      const artifactId = `artifact-${input.sealWorkItemId}`;
      const payload: import('../../storage/artifact-store').StageSystemArtifactInputV2 = {
        sealWorkItemId: input.sealWorkItemId,
        artifactId,
        title: 'Sealed structured artifact',
        format,
        producerWorkItemId: input.sealWorkItemId,
        sealRecordRef: input.sealRecordRef,
        artifactRef: input.artifactRef,
        custodyRef: input.custodyRef,
        templateSnapshotHash: input.templateSnapshotHash,
        files: input.files.map((file) => ({ name: file.name, content: file.content })),
      };
      await sealCapability.stage(taskId, payload);
      return { artifactId, custodyRef: input.custodyRef };
    },
    async publish(seal) {
      // The operation id the coordinator's `completeWorkItem` will derive —
      // the whole terminal batch (including command/work-item completion)
      // commits under it, so a retransmission replays the original commit.
      const operationId = attemptContinuationOperationId(
        seal.taskId,
        seal.sealWorkItemId,
        seal.sealCommandId,
        'complete',
      );
      const tail = await input.eventStore.tail(taskId);
      const payload = {
        family: 'seal_publish' as const,
        operationId,
        taskId,
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
        taskId,
        operationId,
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
      if (event === undefined || event.type !== 'artifact_published_v2') {
        throw new Error('system Seal publication omitted artifact_published_v2');
      }
      const published = { artifactVersion: event.artifactVersion, deliveryRef: event.deliveryRef };
      await sealCapability.promote(taskId, {
        sealWorkItemId: seal.sealWorkItemId,
        artifactRef: seal.artifactRef,
        artifactVersion: published.artifactVersion,
        deliveryRef: published.deliveryRef,
      });
      return published;
    },
  });

  /** Fenced, schema-validated direct append of the rejection event (no
   * publication handler is registered for it yet). */
  const commitSealRejection = async (taskId: string, stage: 'input' | 'output', input2: {
    aggregateRef: BlobRefV2;
    receiptRef: BlobRefV2;
  }): Promise<void> => {
    const projection = (await input.readProjection(taskId)) as SealProjectionViewV2;
    const lease = projection.activeLease;
    if (lease === null || lease.commandId === null) {
      throw new SealAuthorityError('SEAL_LEASE_STALE', 'no active seal command to reject');
    }
    const operationId = sealRejectionOperationId(taskId, stage);
    const committed = await input.eventStore.readBatchByCommitId(taskId, operationId);
    if (committed !== null) return; // replay-safe
    const hold = await input.publicationStore.lock().acquire();
    try {
      const tail = await input.eventStore.tail(taskId);
      const event = validateAuthoritativeReviewEventV2({
        protocolVersion: 2,
        id: deterministicEventId(operationId, 'system_seal_rejected', 0),
        at: input.clock(),
        type: 'structured_seal_validation_rejected_v2',
        sealWorkItemId: lease.workItemId,
        stage,
        validatorAggregateRef: input2.aggregateRef,
        validationReceiptRef: input2.receiptRef,
      });
      await input.eventStore.appendBatch(taskId, operationId, [event], {
        expectedLastSequence: tail.lastSequence,
        fenceProof: await hold.proof(),
      });
    } finally {
      await hold.release();
    }
  };

  /** The per-task `validate(stage, artifactRef)` dep: REAL engine runs with
   * the frozen template's registrations, persisting the aggregate/receipt
   * custody through the facade. */
  const validateFor = (
    taskId: string,
  ): (stage: 'seal_input' | 'seal_output', artifactRef: BlobRefV2 | null) => Promise<SealValidatorRunV2> => {
    const fn: (stage: 'seal_input' | 'seal_output', artifactRef: BlobRefV2 | null) => Promise<SealValidatorRunV2> = async (stage, artifactRef) => {
      const projection = (await input.readProjection(taskId)) as SealProjectionViewV2;
      const lease = projection.activeLease;
      if (lease === null) {
        throw new SealAuthorityError('SEAL_LEASE_STALE', 'no active lease to validate');
      }
      const workItem = projection.workItems[lease.workItemId];
      if (workItem === undefined || workItem.kind !== 'system_seal') {
        throw new SealAuthorityError('SEAL_WORK_ITEM_MISSING', 'the active lease is not a system_seal work item');
      }
      const reviewBundleRef = workItem.payloadRef;
      const profile = await input.frozenProfile(taskId);
      const frozen = await input.frozenTemplate(taskId);
      const contract = frozen.structuredSlots as unknown as FrozenStructuredSlotContractV2;
      const profileBody = await profileBodyOf(taskId);

      const store = new CompositionValidatorBlobStore();
      // The trigger core IS the review bundle (seal_input/seal_output
      // envelopes both bind reviewBundleRef); the engine resolves it.
      const reviewBundle = await resolveBlob(taskId, reviewBundleRef);
      if (reviewBundle === null || typeof reviewBundle !== 'object') {
        throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'seal review bundle is unresolvable');
      }
      store.put('review_bundle', reviewBundle);

      const engine = new ValidatorEngine({
        registry: validatorRegistry,
        blobs: store,
        sourceResolver: builtinSourceOf,
      });
      const registrations = contract.validators.filter((registration) => registration.trigger === stage);
      const run = await engine.execute({
        trigger: stage,
        identity: {
          taskId,
          templateSnapshotHash: profile.snapshotHash,
          workItemId: lease.workItemId,
          attemptId: null,
          commandId: lease.commandId,
        },
        coreRef: reviewBundleRef,
        auxiliaryRefs: stage === 'seal_output' && artifactRef !== null ? { artifactRef } : undefined,
        selectedTargetRefs: [],
        registrations,
        universe: {
          slotIds: [],
          relationIds: [],
          mapNodeIds: [],
          artifactDigest: stage === 'seal_output' && artifactRef !== null ? artifactRef.digest : null,
        },
        slotTypes: validatorSlotTypesOf(contract),
        context: stage === 'seal_output'
          ? {
              artifactRouteId: contract.assembler.routes[0]?.id ?? '',
              artifactMediaType: contract.assembler.routes[0]?.mediaType ?? '',
              assemblerRoutes: contract.assembler.routes,
            }
          : undefined,
        profile: profileBody,
      });
      for (const produced of store.produced) {
        await input.facade.prepareBlob(taskId, produced.kind as never, produced.value);
      }
      const blockingReceiptRef = run.aggregate.blockingInvalidReceiptRefs[0] ?? null;
      return {
        outcome: run.aggregate.outcome,
        aggregateRef: run.aggregateRef,
        blockingReceiptRef,
      };
    };
    return fn;
  };

  /** The per-task seal-authority resolver deps. */
  const resolverDepsFor = (taskId: string): SealAuthorityResolverDependenciesV2 => {
    const contractOf = async (): Promise<FrozenStructuredSlotContractV2> => {
      const frozen = await input.frozenTemplate(taskId);
      return frozen.structuredSlots as unknown as FrozenStructuredSlotContractV2;
    };
    return {
      readProjection: async () => (await input.readProjection(taskId)) as SealProjectionViewV2,
      resolveBlob,
      async resolveTemplateIdentity(templateSnapshotRef) {
        const profile = await input.frozenProfile(taskId);
        if (!sameRef(profile.templateSnapshotRef, templateSnapshotRef)) {
          throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'seal authority base binds a different template snapshot than the frozen task');
        }
        const contract = await contractOf();
        const { relationEnforcement, contentPresence } = templateCoverageOf(contract);
        return {
          templateSnapshotHash: profile.snapshotHash,
          resourceManifestDigest: contract.semanticDigest,
          assembler: contract.assembler as AssemblerRegistrationV2,
          relationEnforcement,
          contentPresence,
        };
      },
      async installedTemplateIdentity() {
        const profile = await input.frozenProfile(taskId);
        const contract = await contractOf();
        return {
          templateSnapshotHash: profile.snapshotHash,
          resourceManifestDigest: contract.semanticDigest,
          assembler: contract.assembler as AssemblerRegistrationV2,
        };
      },
      async readProfileSnapshotRef() {
        return (await input.frozenProfile(taskId)).profileSnapshotRef;
      },
      async buildAssemblerInput(request) {
        return buildAssemblerInputFor(taskId, request, resolveBlob);
      },
      async submitterIdentity() {
        const frozen = await input.frozenTemplate(taskId);
        const agentId = frozen.finalOutput.submitters[0] ?? frozen.structuredReviewLifecycle?.roleBindings.submitter;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'the frozen template declares no submitter role');
        }
        return {
          workItemId: deterministicSubmitterWorkItemId(taskId),
          agentId,
          logicalAssignmentId: deterministicSubmitterLogicalAssignmentId(taskId),
          maxAutomaticRetries: await input.frozenAutomaticRetries(taskId),
        };
      },
    };
  };

  /** Builds the SystemSealServiceV2 deps for one task. */
  const buildSealDependenciesFor = (taskId: string): import('./system-seal-service').SystemSealServiceDependenciesV2 => ({
    assemblerRegistry,
    blobs: blobsFor(taskId),
    publisher: sealPublisherFor(taskId),
    validate: validateFor(taskId),
    async routeInputBlocking(aggregateRef, receiptRef) {
      await commitSealRejection(taskId, 'input', { aggregateRef, receiptRef });
      // Seal-input blocking routes to a repair; the work item completes with
      // the aggregate as its domain result carrier (§9.2 gated kinds).
      return { kind: 'completed' as const, resultRefs: [aggregateRef] };
    },
    async recordOutputBlocking(aggregateRef, receiptRef) {
      await commitSealRejection(taskId, 'output', { aggregateRef, receiptRef });
      return {
        kind: 'terminal_failure' as const,
        failureCode: SEAL_OUTPUT_BLOCKING_FAILURE_CODE,
        failureDigest: canonicalJsonSha256({ aggregateRef, receiptRef, stage: 'output' }),
        taskFailure: true,
      };
    },
    resolveBlob,
    resolveSealAuthority: createSystemSealAuthorityResolver(resolverDepsFor(taskId)),
  });

  /** The registered `seal` member: per-task dispatcher over real services. */
  const sealCommandHandler: SystemCommandHandler = {
    commandKind: 'seal',
    async execute(ctx) {
      return createSystemSealCommandHandler(sealServiceFor(ctx.taskId)).execute(ctx);
    },
  };
  registry.replace(sealCommandHandler);

  // ---- the attempt coordinator + scheduler tick ----
  const attempts = new V2AttemptCoordinator({
    coordinator: input.coordinator,
    runner: input.runner,
    systemCommands: registry,
    agentForRole: async (taskId, roleBinding) => {
      if (roleBinding === null) return null;
      const frozen = await input.frozenTemplate(taskId);
      return frozen.agents.find((agent) => agent.id === roleBinding) ?? null;
    },
    frozenFor: async (taskId) => input.frozenTemplate(taskId),
    wakeups: input.wakeups,
    ...(input.resolveDispatch === undefined ? {} : { resolveDispatch: input.resolveDispatch }),
    traces: input.traces,
    terminalFail: input.terminalFail,
    // Task 22: the production final-submission validator. The FROZEN profile's
    // snapshotHash is the template-snapshot identity (spec §4.1 — never the
    // catalog); the resolver fails closed on any unresolvable blob.
    finalSubmission: new SystemArtifactDeliveryValidatorV2({
      readProjection: input.readProjection,
      resolveBlob: input.resolver,
      frozenTemplateHash: async (taskId) => (await input.frozenProfile(taskId)).snapshotHash,
    }),
    clock: input.clock,
  });

  const runTick = async (now?: string): Promise<V2SchedulingTickResult> => {
    const nowValue = now ?? input.clock();
    const pass = await input.scheduling.runPass(nowValue);
    const outcomes: V2AttemptOutcome[] = [];
    for (const leased of pass.leased) {
      // Every fresh lease is already classified and authorized by the
      // coordinator. System commands and Agent assignments must both enter the
      // AttemptCoordinator here; filtering Agent assignments at this boundary
      // would emit lease/dispatch/attempt-start facts without invoking the
      // Agent runtime.
      outcomes.push(await attempts.executeLeased(leased.taskId));
    }
    return { pass, outcomes };
  };

  return {
    systemCommands: registry,
    attempts,
    runTick,
    sealServiceFor,
    sealCommandHandler,
  };
}

/* ------------------------------------------------------------------ */
/* assembler input (the seal assembler's canonical Zhihu chapter tree) */
/* ------------------------------------------------------------------ */

/**
 * Builds the canonical assembler input from the ACTIVE Map snapshot + the
 * finalized content manifest (exact refs, never caller content for the
 * authority fields). Every content-bearing map node's `slotType` becomes the
 * assembler node `typeId`; set content versions supply the node content.
 */
async function buildAssemblerInputFor(
  taskId: string,
  request: {
    taskId: string;
    activeMapRef: BlobRefV2;
    contentRevisionManifestRef: BlobRefV2;
    reviewBundleRef: BlobRefV2;
    templateSnapshotHash: string;
  },
  resolveBlob: (taskId: string, ref: BlobRefV2) => Promise<unknown>,
): Promise<ZhihuChapterAssemblerInputV1> {
  const mapRaw = await resolveBlob(taskId, request.activeMapRef);
  const manifestRaw = await resolveBlob(taskId, request.contentRevisionManifestRef);
  if (mapRaw === null || typeof mapRaw !== 'object' || manifestRaw === null || typeof manifestRaw !== 'object') {
    throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'assembler map/manifest is unresolvable');
  }
  const map = mapRaw as unknown as MapSnapshotV2;
  const manifest = manifestRaw as unknown as ContentRevisionManifestV2;

  const contentBySlot = new Map<string, string>();
  for (const entry of manifest.entries) {
    let version: SlotContentVersionV2 | null = null;
    try {
      version = (await resolveBlob(taskId, entry.versionRef)) as SlotContentVersionV2 | null;
    } catch {
      version = null;
    }
    if (version === null || version.state !== 'set' || version.blobRef === null) continue;
    const value = await resolveBlob(taskId, version.blobRef);
    if (value === null || typeof value !== 'object') continue;
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') contentBySlot.set(entry.slotId, text);
  }

  const tree: ZhihuChapterAssemblerNodeV1[] = map.nodes.map((node, index) => {
    const content = contentBySlot.get(node.slotId) ?? null;
    return {
      slotId: node.slotId,
      parentSlotId: node.parentSlotId,
      typeId: node.slotType,
      order: node.documentOrder ?? index,
      contentPresence: content === null ? 'unset' : 'set',
      content,
    };
  });

  return {
    authority: {
      mapRef: request.activeMapRef,
      contentRevisionManifestRef: request.contentRevisionManifestRef,
      templateSnapshotHash: request.templateSnapshotHash,
    },
    tree,
  };
}
