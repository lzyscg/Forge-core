/**
 * Task-scoped production composition for the authoritative v2 domain.
 *
 * The authoritative stores are shared by the installation, but the frozen
 * profile, template contract, private review journal and role bindings belong
 * to one task snapshot.  This factory is therefore deliberately lazy and
 * cached per task.  It is the single source used by both the Pi tool bridge
 * and the SystemCommand bridge; a tool can never be wired to one set of
 * services while the finalizer command uses another.
 */
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type {
  AuthoritativeReviewProfile,
  ReviewPolicyParameters,
  SlotPresenceV2,
} from '../../authoritative-review/authority-types';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import type { FrozenStructuredSlotContractV2 } from '../../template/structured-slot-contract-v2';
import type { FrozenTemplate } from '../../template/template-schema';
import type { CorePaths } from '../../storage/core-paths';
import { AuthoritativeReviewPrivateStore } from '../../storage/authoritative-review-private-store';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { FrozenTaskProfileV2 } from './task-lifecycle';
import type { WorkItemCoordinatorV2 } from './work-item-coordinator';
import type { V2AttemptContext } from './attempt-coordinator';
import type { DispatchResolver } from './grant-service';
import { GrantService } from './grant-service';
import { ReviewCoordinatorV2 } from './review-coordinator';
import {
  MapBuildService,
  reconstructBuildState,
} from './map-build-service';
import { createContentPlanToolHandlers, ContentPlanService } from './content-plan-service';
import { createRepairToolHandlers, RepairService } from './repair-service';
import { contentSchemaDigestOf, MapReviewService } from './map-review-service';
import { ContentReviewService } from './content-review-service';
import { FindingService } from './finding-service';
import { ReviewAdoptionService } from './review-adoption-service';
import type { ValidatorSlotType } from './validator-engine';
import { ValidatorRegistry } from './validator-registry';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES, builtinSourceOf } from './builtin-validators';
import type { V2DomainHandlers, FrozenReviewAssignmentV2 } from './tool-factory';
import type { MigrationServiceV2 } from './migration-service';

export interface ProductionV2DomainRuntimeDependencies {
  paths: CorePaths;
  facade: AuthoritativeAppendFacadeV2;
  coordinator: WorkItemCoordinatorV2;
  profileBody(taskId: string): Promise<AuthoritativeReviewProfileSnapshotV1Body>;
  frozenProfile(taskId: string): Promise<FrozenTaskProfileV2>;
  frozenTemplate(taskId: string): Promise<FrozenTemplate>;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
  tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  committedOperation(taskId: string, operationId: string): Promise<readonly AuthoritativeReviewEventV2[] | null>;
  defaultAutomaticRetries(taskId: string): Promise<number>;
  resolveDispatch?: DispatchResolver;
  clock(): string;
}

export interface ProductionV2DomainServices {
  mapBuildService: MapBuildService;
  contentPlanService: ContentPlanService;
  repairService: RepairService;
  mapReviewService: MapReviewService;
  contentReviewService: ContentReviewService;
  migrationService?: MigrationServiceV2;
}

export interface ProductionV2TaskDomainRuntime {
  services: ProductionV2DomainServices;
  handlers: V2DomainHandlers;
  resolveAssignmentTargets(ctx: V2AttemptContext): Promise<readonly string[] | null>;
  freezeReviewAssignment(
    taskId: string,
    freeze: FrozenReviewAssignmentV2,
  ): Promise<{ ledgerRef: BlobRefV2; eventId: string }>;
  reviewPolicy: ReviewPolicyParameters;
  /** Refreshes the slot-id -> slot-type cache before a command/tool read. */
  refresh(): Promise<void>;
}

export class ProductionV2DomainRuntimeFactory {
  private readonly cache = new Map<string, Promise<ProductionV2TaskDomainRuntime | undefined>>();

  constructor(private readonly deps: ProductionV2DomainRuntimeDependencies) {}

  for(taskId: string): Promise<ProductionV2TaskDomainRuntime | undefined> {
    const existing = this.cache.get(taskId);
    if (existing !== undefined) return existing;
    const created = this.create(taskId).catch((error: unknown) => {
      this.cache.delete(taskId);
      throw error;
    });
    this.cache.set(taskId, created);
    return created;
  }

  private async create(taskId: string): Promise<ProductionV2TaskDomainRuntime | undefined> {
    const frozen = await this.deps.frozenTemplate(taskId);
    if (frozen.structuredSlots?.version !== 2 || frozen.structuredReviewLifecycle === null) {
      return undefined;
    }
    const contract = frozen.structuredSlots as FrozenStructuredSlotContractV2;
    const lifecycle = frozen.structuredReviewLifecycle;
    const frozenProfile = await this.deps.frozenProfile(taskId);
    const profileBody = await this.deps.profileBody(taskId);
    const profile = profileBody.runtime as AuthoritativeReviewProfile;
    const reviewPolicy = contract.reviewPolicy as ReviewPolicyParameters;
    const reviewPolicyDigest = canonicalJsonSha256(reviewPolicy);
    const templateSnapshotRef = frozenProfile.templateSnapshotRef;
    const profileSnapshotRef = frozenProfile.profileSnapshotRef;
    const snapshotHash = frozenProfile.snapshotHash;
    const validatorRegistry = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);
    const privateStore = new AuthoritativeReviewPrivateStore(this.deps.paths, taskId);
    const resolver = this.deps.resolver;
    const readProjection = this.deps.readProjection;
    const readEvents = this.deps.readEvents;
    const committedOperation = this.deps.committedOperation;
    const defaultAutomaticRetries = () => this.deps.defaultAutomaticRetries(taskId);
    const registrationsFor = (trigger: string, phase: string | null = null) =>
      contract.validators.filter((registration) => registration.trigger === trigger && registration.executionPhase === phase);
    const slotTypes = validatorSlotTypesOf(contract);
    const slotTypeById = new Map(contract.slotTypes.map((slotType) => [slotType.id, slotType]));
    const slotTypeBySlotId = new Map<string, string>();

    const refresh = async (): Promise<void> => {
      const state = await readProjection(taskId);
      const currentMapRef = state.currentMap?.mapSnapshotRef ?? null;
      const currentCandidateRef = state.currentCandidate?.candidateRef ?? null;
      const sourceRef = currentMapRef ?? currentCandidateRef;
      if (sourceRef === null) return;
      const raw = await resolver(taskId, sourceRef);
      if (raw === null || typeof raw !== 'object') return;
      const candidate = raw as { validationCoreRef?: BlobRefV2; nodes?: readonly { slotId: string; slotType: string }[] };
      const map = candidate.validationCoreRef === undefined
        ? candidate
        : await resolver(taskId, candidate.validationCoreRef) as { nodes?: readonly { slotId: string; slotType: string }[] } | null;
      for (const node of map?.nodes ?? []) {
        if (typeof node.slotId === 'string' && typeof node.slotType === 'string') {
          slotTypeBySlotId.set(node.slotId, node.slotType);
        }
      }
    };

    const slotTypeOf = (slotId: string): string => slotTypeBySlotId.get(slotId) ?? 'unknown';
    const slotPresenceOfSlot = (slotId: string): SlotPresenceV2 =>
      slotPresenceOfType(slotTypeBySlotId.get(slotId), slotTypeById);
    const slotPresenceOfTypeId = (slotType: string): SlotPresenceV2 => slotPresenceOfType(slotType, slotTypeById);
    const schemaDigestOf = (slotId: string): string => contentSchemaDigestOf(slotTypeOf(slotId));

    const grants = new GrantService({
      resolver,
      readProjection,
      profile,
      ...(this.deps.resolveDispatch === undefined ? {} : { resolveDispatch: this.deps.resolveDispatch }),
    });
    const reviewCoordinator = new ReviewCoordinatorV2({
      coordinator: this.deps.coordinator,
      facade: this.deps.facade,
      resolver,
      readProjection,
      readEvents,
      profile,
      reviewPolicy,
      templateSnapshotRef,
      profileSnapshotRef,
      reviewerRoleBinding: lifecycle.roleBindings.reviewer,
      generatorRoleBinding: lifecycle.roleBindings.generator,
      orchestratorRoleBinding: lifecycle.roleBindings.orchestrator,
      snapshotHash,
      defaultAutomaticRetries,
    });
    const common = {
      facade: this.deps.facade,
      readProjection,
      resolver,
      tail: this.deps.tail,
      readEvents,
      committedOperation,
      clock: this.deps.clock,
      profile,
      profileBody,
      validatorRegistry,
      sourceResolver: builtinSourceOf,
      reviewPolicy,
      reviewPolicyDigest,
      templateSnapshotRef,
      profileSnapshotRef,
      snapshotHash,
    };

    const mapBuildService = new MapBuildService({
      ...common,
      grants,
      registrationsFor: () => registrationsFor('map_candidate_commit'),
      relationPolicy: contract.relationshipPolicy.mode,
      orchestratorRoleBinding: lifecycle.roleBindings.orchestrator,
      defaultAutomaticRetries,
    });
    const contentPlanService = new ContentPlanService({
      ...common,
      coordinator: this.deps.coordinator,
      grants,
      registrationsFor: (trigger, phase) => registrationsFor(trigger, phase),
      generatorRoleBinding: lifecycle.roleBindings.generator,
      reviewerRoleBinding: lifecycle.roleBindings.reviewer,
      slotTypes,
      slotTypeOf,
      contentSchemaDigestOf: schemaDigestOf,
      defaultAutomaticRetries,
    });
    const findingService = new FindingService({
      facade: this.deps.facade,
      readProjection,
      readEvents,
      resolver,
    });
    const adoptionService = new ReviewAdoptionService({
      facade: this.deps.facade,
      readProjection,
      resolver,
      readEvents,
      adoptionChunkSize: Math.max(1, reviewPolicy.contentBatchTargetSlots),
    });
    const repairService = new RepairService({
      ...common,
      grants,
      registrationsFor: (trigger, phase) => registrationsFor(trigger, phase === 'batch_commit' ? 'batch_commit' : null),
      orchestratorRoleBinding: lifecycle.roleBindings.orchestrator,
      generatorRoleBinding: lifecycle.roleBindings.generator,
      reviewerRoleBinding: lifecycle.roleBindings.reviewer,
      privateStore,
      slotTypeOf,
      contentSchemaDigestOf: schemaDigestOf,
      slotTypes,
      slotPresenceOf: slotPresenceOfSlot,
      defaultAutomaticRetries,
    });
    const mapReviewService = new MapReviewService({
      ...common,
      reviewCoordinator,
      registrationsFor: (trigger) => registrationsFor(trigger),
      reviewerRoleBinding: lifecycle.roleBindings.reviewer,
      generatorRoleBinding: lifecycle.roleBindings.generator,
      orchestratorRoleBinding: lifecycle.roleBindings.orchestrator,
      repairService,
      slotPresenceOf: slotPresenceOfTypeId,
    });
    const contentReviewService = new ContentReviewService({
      ...common,
      reviewCoordinator,
      registrationsFor: (trigger) => registrationsFor(trigger),
      reviewerRoleBinding: lifecycle.roleBindings.reviewer,
      generatorRoleBinding: lifecycle.roleBindings.generator,
      orchestratorRoleBinding: lifecycle.roleBindings.orchestrator,
      adoptionService,
      findingService,
      repairService,
      slotPresenceOf: slotPresenceOfSlot,
    });
    const services: ProductionV2DomainServices = {
      mapBuildService,
      contentPlanService,
      repairService,
      mapReviewService,
      contentReviewService,
    };
    const contentHandlers = createContentPlanToolHandlers({
      service: contentPlanService,
      grants,
      privateStore,
      resolver,
      readProjection,
      facade: this.deps.facade,
      contentSchemaDigestOf: schemaDigestOf,
    });
    const repairHandlers = createRepairToolHandlers({
      service: repairService,
      grants,
      privateStore,
      resolver,
      readProjection,
      facade: this.deps.facade,
      contentSchemaDigestOf: schemaDigestOf,
    });

    const handlers: V2DomainHandlers = {
      async appendMapCandidateChunk(ctx, params) {
        await refresh();
        return mapBuildService.appendChunk(ctx, params as never);
      },
      async finishMapBuild(ctx, params) {
        await refresh();
        return mapBuildService.finishMapBuild(ctx, params as never);
      },
      async submitMapPatch(ctx, params) {
        await refresh();
        return repairHandlers.submitMapPatch!(ctx, params);
      },
      async writeSlotContent(ctx, params) {
        await refresh();
        return ctx.sessionKind === 'content_repair'
          ? repairHandlers.writeSlotContent!(ctx, params)
          : contentHandlers.writeSlotContent!(ctx, params);
      },
      async submitContentDraft(ctx, params) {
        await refresh();
        return ctx.sessionKind === 'content_repair'
          ? repairHandlers.submitContentDraft!(ctx, params)
          : contentHandlers.submitContentDraft!(ctx, params);
      },
      async requestScopeExpansion(ctx, params) {
        await refresh();
        return repairHandlers.requestScopeExpansion!(ctx, params);
      },
      async read(ctx, toolName, params) {
        await refresh();
        if (toolName === 'read_structure_contract') return structureContractView(contract);
        if (toolName === 'read_map_build_frontier') return readMapBuildFrontier(ctx, params, resolver, readProjection, readEvents);
        if (toolName === 'read_map_candidate') return readMapCandidate(ctx, params, readProjection, resolver);
        if (toolName === 'read_relation_context') return readRelationContext(ctx.taskId, params, readProjection, resolver);
        if (toolName === 'read_active_map' || toolName === 'read_slot_content' || toolName === 'read_related_context' || toolName === 'read_map_repair_staging') {
          return repairHandlers.read!(ctx, toolName, params);
        }
        return { entries: [], cursor: null };
      },
    };

    return {
      services,
      handlers,
      async resolveAssignmentTargets(ctx) {
        await refresh();
        if (ctx.sessionKind?.startsWith('review_map_') === true) return mapReviewService.resolveAssignmentTargets(ctx);
        if (ctx.sessionKind?.startsWith('review_content_') === true) return contentReviewService.resolveAssignmentTargets(ctx);
        return null;
      },
      async freezeReviewAssignment(currentTaskId, freeze) {
        await refresh();
        if (freeze.ledger.roundKind === 'map') return mapReviewService.freezeReviewAssignment(currentTaskId, freeze);
        return contentReviewService.freezeReviewAssignment(currentTaskId, freeze);
      },
      reviewPolicy,
      refresh,
    };
  }
}

function validatorSlotTypesOf(contract: FrozenStructuredSlotContractV2): ValidatorSlotType[] {
  return contract.slotTypes.map((slotType) => ({
    id: slotType.id,
    name: slotType.name,
    description: slotType.description,
    contentPresence: slotType.content.presence,
    contentSchema: slotType.content.presence === 'forbidden' ? slotType.specSchema : slotType.content.schema,
  }));
}

function slotPresenceOfType(
  slotTypeId: string | undefined,
  slotTypes: ReadonlyMap<string, { content: { presence: 'forbidden' | 'optional' | 'required' } }>,
): SlotPresenceV2 {
  return slotTypeId === undefined || slotTypes.get(slotTypeId)?.content.presence === 'required' ? 'required' : 'optional';
}

function structureContractView(contract: FrozenStructuredSlotContractV2): Record<string, unknown> {
  return {
    version: contract.version,
    semanticDigest: contract.semanticDigest,
    slotTypes: contract.slotTypes,
    layoutGrammar: contract.layoutGrammar,
    accessProfiles: contract.accessProfiles,
    relationTypes: contract.relationTypes,
    relationshipPolicy: contract.relationshipPolicy,
    reviewPolicy: contract.reviewPolicy,
    validators: contract.validators,
    assembler: contract.assembler,
    limits: contract.limits,
    implementationIdentityClosure: contract.implementationIdentityClosure,
  };
}

async function readMapBuildFrontier(
  ctx: V2AttemptContext,
  params: Record<string, unknown>,
  resolver: (taskId: string, ref: BlobRefV2) => Promise<unknown>,
  readProjection: (taskId: string) => Promise<AuthoritativeReviewProjectionV2>,
  readEvents: (taskId: string) => Promise<readonly AuthoritativeReviewEventV2[]>,
): Promise<Record<string, unknown>> {
  const state = await readProjection(ctx.taskId);
  const wi = state.workItems[ctx.workItemId];
  if (wi === undefined) return { chunks: [], frontierDigest: '0'.repeat(64), nextOrdinal: 1 };
  const base = await resolver(ctx.taskId, wi.authorityBaseRef) as { planSpecRef?: BlobRefV2 } | null;
  const specRef = base?.planSpecRef ?? wi.payloadRef;
  const spec = await resolver(ctx.taskId, specRef) as { mapBuildId?: string; revision?: number } | null;
  if (spec === null || typeof spec?.mapBuildId !== 'string' || typeof spec.revision !== 'number') {
    return { chunks: [], frontierDigest: '0'.repeat(64), nextOrdinal: 1 };
  }
  const chunkEvents = (await readEvents(ctx.taskId))
    .filter((event): event is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_chunk_committed' }> =>
      event.type === 'structured_map_chunk_committed' && event.mapBuildId === spec.mapBuildId,
    )
    .sort((a, b) => a.chunkOrdinal - b.chunkOrdinal);
  const chunks = [];
  for (const event of chunkEvents) {
    const chunk = await resolver(ctx.taskId, event.chunkRef);
    if (chunk !== null && typeof chunk === 'object') {
      chunks.push({ chunkOrdinal: event.chunkOrdinal, chunkRef: event.chunkRef, chunk });
    }
  }
  const stateValue = reconstructBuildState(spec.mapBuildId, spec.revision, chunks as never);
  const limit = Math.max(1, Math.min(Number(params.limit ?? 100), 500));
  return {
    mapBuildId: spec.mapBuildId,
    revision: spec.revision,
    chunks: stateValue.chunks.slice(0, limit).map((chunk) => ({
      chunkOrdinal: chunk.chunkOrdinal,
      chunkRef: chunk.chunkRef,
      nodeCount: chunk.chunk.nodeDeclarations.length,
      relationCount: chunk.chunk.relationDeclarations.length,
    })),
    frontierDigest: stateValue.frontierDigest,
    nextOrdinal: stateValue.nextOrdinal,
    nodeCount: stateValue.nodeCount,
    relationCount: stateValue.relationCount,
    rootCount: stateValue.rootCount,
    committedChunkRefs: stateValue.chunks.map((chunk) => chunk.chunkRef),
  };
}

async function readMapCandidate(
  _ctx: V2AttemptContext,
  params: Record<string, unknown>,
  readProjection: (taskId: string) => Promise<AuthoritativeReviewProjectionV2>,
  resolver: (taskId: string, ref: BlobRefV2) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const state = await readProjection(_ctx.taskId);
  const candidatePointer = state.currentCandidate;
  if (candidatePointer === null || candidatePointer === undefined) {
    return { candidate: null, nodes: [], relations: [], cursor: null };
  }
  const candidate = await resolver(_ctx.taskId, candidatePointer.candidateRef) as { validationCoreRef?: BlobRefV2 } | null;
  const core = candidate?.validationCoreRef === undefined
    ? null
    : await resolver(_ctx.taskId, candidate.validationCoreRef) as { nodes?: unknown[]; relations?: unknown[] } | null;
  const limit = Math.max(1, Math.min(Number(params.limit ?? 100), 500));
  return {
    candidate,
    nodes: (core?.nodes ?? []).slice(0, limit),
    relations: (core?.relations ?? []).slice(0, limit),
    cursor: null,
  };
}

async function readRelationContext(
  taskId: string,
  params: Record<string, unknown>,
  readProjection: (taskId: string) => Promise<AuthoritativeReviewProjectionV2>,
  resolver: (taskId: string, ref: BlobRefV2) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const relationId = String(params.relationId ?? '');
  if (taskId.length === 0 || relationId.length === 0) return { relation: null, cursor: null };
  const state = await readProjection(taskId);
  if (state.currentMap === null) return { relation: null, cursor: null };
  const map = await resolver(taskId, state.currentMap.mapSnapshotRef) as { relations?: readonly { relationId: string }[] } | null;
  return { relation: map?.relations?.find((relation) => relation.relationId === relationId) ?? null, cursor: null };
}
