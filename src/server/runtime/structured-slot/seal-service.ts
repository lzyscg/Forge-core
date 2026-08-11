/**
 * Seal Gate + Assembler + artifact custody service (Task 16; spec §9.3/§10/§12,
 * design §14.4/§16/§17, J03–J06).
 *
 * `requestSeal` is the final-authority tri-state Gate for one seal turn:
 *
 * - It runs the FULL Seal Gate (required presence, every contentSchema, the
 *   LayoutGrammar, ALL applicable blocking + advisory template validators —
 *   advisory must also complete) AND the Assembler, then validates the produced
 *   files against the artifactSchema create subset (exact required create
 *   coverage, no extra route, safe single-segment static file names, the global
 *   `finalOutput.format` media type, artifact byte limits).
 * - `passed`   → freeze a TURN-BOUND sealed candidate: custody staging via
 *               `ArtifactStore.prepareStructuredVersion` + an immutable
 *               SealRecord candidate; NO event is written.
 * - `failed`   → every evaluator completed reliably and the verdict is failed:
 *               freeze a REVISION-BOUND `seal_rework_required` receipt (not a
 *               candidate; no artifact/SealRecord; scaffold unchanged).
 * - `incomplete` → no receipt at all; a retry is allowed within the remaining
 *               Attempt budget / runtime retry / human, but NEVER a dispatch.
 *
 * Content identity (J06) is derived from taskId + scaffoldId + revision +
 * snapshotHash + Assembler implementation digest + the canonical assembler
 * input, so the same revision always maps to the same custody key and the same
 * SealRecord. Assembler execution failures are adapted through the Task 1 issue
 * registry with phase 'assemble' (Task 8 note); output-schema mismatches are
 * ARTIFACT_SCHEMA_MISMATCH at phase 'seal_output'.
 *
 * This module carries zero business vocabulary (iron rule 1).
 */
import { createHash } from 'node:crypto';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type {
  IssueLocation,
  JsonObject,
  SealRecord,
  SealSessionGrantV1,
  StructuredIssueV1,
  StructuredVerdictV1,
} from '../../../shared/structured-slots';
import { makeStructuredIssue } from '../../structured-slots/issues';
import { matchProduction } from '../../structured-slots/layout-grammar';
import { validateSlotValue } from '../../structured-slots/slot-schema';
import type {
  FrozenStructuredSlotContractV1,
} from '../../template/structured-slot-contract';
import type { ArtifactSchema } from '../../template/template-schema';
import type { CorePaths } from '../../storage/core-paths';
import { ArtifactStore } from '../../storage/artifact-store';
import {
  StructuredSlotBlobStore,
} from '../../storage/structured-slot-blob-store';
import { projectStructuredSlotState } from '../../storage/structured-slot-state';
import type { TaskEvent } from '../../storage/task-events';
import type { SlotToolCallContext } from './attempt-meter';
import type {
  AssemblerFileResult,
  EvaluatorSlotProjection,
  EvaluatorTypeDeclaration,
} from './evaluator-runner';
import {
  buildAssemblerEnvelope,
  EvaluatorRunner,
} from './evaluator-runner';
import type {
  GateSlotInput,
} from './validation-engine';
import { ValidationEngine } from './validation-engine';
import type {
  SealCandidateV1,
  SealDispatchStateV1,
  SealRequestResult,
  SealReworkReceiptV1,
  SealSafeReceiptV1,
  SealToolOperations,
} from './tool-factory';

/** Stable code when the seal gate could not complete reliably. */
export const SEAL_INCOMPLETE = 'SEAL_INCOMPLETE';

/** Stable code when no active scaffold is present to seal. */
export const SEAL_NOT_READY = 'SEAL_NOT_READY';

/** Stable code when the grant is bound to a stale scaffold/revision. */
export const SEAL_STALE = 'SEAL_STALE';

/** Platform-frozen media type mapping (design J05 / spec §12). */
const MEDIA_TYPE_BY_FORMAT: Record<'markdown' | 'text', string> = {
  markdown: 'text/markdown; charset=utf-8',
  text: 'text/plain; charset=utf-8',
};

/** v1 create file names must be safe single-segment static names (J04). */
const SAFE_SINGLE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface SealServiceOptions {
  taskId: string;
  snapshotHash: string;
  contract: FrozenStructuredSlotContractV1;
  paths: CorePaths;
  blobStore: StructuredSlotBlobStore;
  artifactStore: ArtifactStore;
  validationEngine: ValidationEngine;
  events: () => Promise<readonly TaskEvent[]>;
  /** The template's frozen artifactSchema (phase:create subset is the contract). */
  artifactSchema: ArtifactSchema;
  finalOutputFormat: 'markdown' | 'text';
  finalOutputName: string;
  templateId: string;
  templateVersion: string;
  /** The frozen v3 fill/structure target a reliable failure may send to. */
  reworkTarget: string;
  /** The seal dispatches the turn contract declares (design L01). */
  declaredDispatches: Array<'publish_artifact' | 'submit_final_artifact'>;
  /** Injectable clock for SealRecord `sealedAt`; defaults to system time. */
  clock?: () => Date;
  /** Composite abort signal for the attempt; aborted gates fail incomplete. */
  signal?: AbortSignal;
}

/**
 * The Seal Tool operations implementation: `requestSeal` + the frozen dispatch
 * state the ActionCommitter reads (spec §11 / design §11.3).
 */
export class StructuredSlotSealService implements SealToolOperations {
  private readonly taskId: string;

  private readonly snapshotHash: string;

  private readonly contract: FrozenStructuredSlotContractV1;

  private readonly blobStore: StructuredSlotBlobStore;

  private readonly artifactStore: ArtifactStore;

  private readonly validationEngine: ValidationEngine;

  private readonly events: () => Promise<readonly TaskEvent[]>;

  private readonly artifactSchema: ArtifactSchema;

  private readonly finalOutputFormat: 'markdown' | 'text';

  private readonly finalOutputName: string;

  private readonly templateId: string;

  private readonly templateVersion: string;

  private readonly reworkTarget: string;

  private readonly declaredDispatches: Array<'publish_artifact' | 'submit_final_artifact'>;

  private readonly clock: () => Date;

  private readonly signal?: AbortSignal;

  private readonly evaluatorRunner: EvaluatorRunner;

  private dispatchState: SealDispatchStateV1 = { status: 'none' };

  constructor(options: SealServiceOptions) {
    this.taskId = options.taskId;
    this.snapshotHash = options.snapshotHash;
    this.contract = options.contract;
    this.blobStore = options.blobStore;
    this.artifactStore = options.artifactStore;
    this.validationEngine = options.validationEngine;
    this.events = options.events;
    this.artifactSchema = options.artifactSchema;
    this.finalOutputFormat = options.finalOutputFormat;
    this.finalOutputName = options.finalOutputName;
    this.templateId = options.templateId;
    this.templateVersion = options.templateVersion;
    this.reworkTarget = options.reworkTarget;
    this.declaredDispatches = options.declaredDispatches;
    this.clock = options.clock ?? (() => new Date());
    this.signal = options.signal;
    this.evaluatorRunner = new EvaluatorRunner({
      paths: options.paths,
      taskId: options.taskId,
      limits: options.contract.limits,
    });
  }

  /** The frozen seal dispatch state the ActionCommitter reads. */
  get dispatch(): SealDispatchStateV1 {
    return this.dispatchState;
  }

  /**
   * The full Seal Gate + Assembler + artifact-schema validation (spec §9.3).
   * Returns the tri-state result; never writes a TaskEvent. On `passed` the
   * sealed candidate (custody staging + immutable SealRecord) is frozen on this
   * instance; on reliable `failed` a revision-bound rework receipt is frozen;
   * on `incomplete` nothing is frozen and a retry within the Attempt budget is
   * allowed.
   */
  async requestSeal(
    grant: SealSessionGrantV1,
    _ctx: SlotToolCallContext,
  ): Promise<SealRequestResult> {
    if (grant.kind !== 'seal') {
      return this.fail('GRANT_INVALID', 'the grant is not a seal grant');
    }
    if (grant.caseId !== this.taskId || grant.snapshotHash !== this.snapshotHash) {
      return this.fail('GRANT_INVALID', 'the grant is bound to a different task/snapshot');
    }
    if (this.signal?.aborted) {
      // Incomplete: no receipt, no dispatch; a retry within the attempt budget
      // / runtime retry / human is legal (spec §9.3 / design §14.4).
      this.dispatchState = { status: 'incomplete' };
      return this.fail(SEAL_INCOMPLETE, 'the attempt was stopped before the seal gate could complete');
    }

    const state = projectStructuredSlotState(await this.events());
    if (state.generationId === null || state.scaffoldId === null || state.content === null) {
      return this.fail(SEAL_NOT_READY, 'no active scaffold is available to seal');
    }
    const revision = state.contentRevision ?? 0;
    // The grant must bind the ACTIVE scaffold/revision before any idempotent
    // seal receipt is returned (J06: the same revision returns the same result).
    if (grant.scaffoldId !== state.scaffoldId || grant.baseRevision !== revision) {
      return this.fail(SEAL_STALE, 'the grant is bound to a stale scaffold/revision; re-open a fresh seal turn');
    }
    if (state.sealStatus === 'sealed') {
      // J06 idempotency: an already-sealed scaffold returns the passed receipt.
      return this.ok({ kind: 'seal', status: 'passed', issueSummary: { errors: 0, warnings: 0 } });
    }

    const slots = await this.loadSlots(state.generationId, state.content);
    const issues: StructuredIssueV1[] = [];
    this.checkRequiredPresence(slots, issues);
    this.checkContentSchemas(slots, issues);
    this.checkGrammar(slots, issues);

    const gateResult = await this.validationEngine.runSealGate({
      taskId: this.taskId,
      contract: this.contract,
      slots,
      signal: this.signal,
    });
    issues.push(...gateResult.verdict.issues);
    let incomplete = gateResult.verdict.status === 'incomplete';

    const assemblerEnvelope = this.buildAssemblerEnvelope(slots);
    const contentIdentity = this.deriveContentIdentity(state, assemblerEnvelope);

    let producedFiles: AssemblerFileResult[] = [];
    if (!incomplete) {
      const assemblerResult = await this.evaluatorRunner.runAssembler(
        this.contract.assembler,
        assemblerEnvelope,
        this.signal,
      );
      if (assemblerResult.kind === 'unavailable') {
        // ASSEMBLER_* codes allow ONLY phase 'assemble' (Task 8 note).
        issues.push(
          makeStructuredIssue(
            'ASSEMBLER_UNAVAILABLE',
            'assemble',
            { kind: 'operation' },
            { assemblerId: this.contract.assembler.id, reason: assemblerResult.reason },
          ),
        );
        incomplete = true;
      } else if (assemblerResult.kind === 'resultInvalid') {
        issues.push(
          makeStructuredIssue(
            'ASSEMBLER_RESULT_INVALID',
            'assemble',
            { kind: 'operation' },
            { assemblerId: this.contract.assembler.id, reason: assemblerResult.reason },
          ),
        );
        incomplete = true;
      } else {
        producedFiles = assemblerResult.files;
        this.validateAssemblerOutput(producedFiles, issues);
      }
    }

    if (incomplete) {
      // NO receipt, NO dispatch, NO candidate: a retry within the Attempt
      // budget / runtime retry / human is legal (spec §9.3 / design §14.4).
      this.dispatchState = { status: 'incomplete' };
      return this.fail(
        SEAL_INCOMPLETE,
        'the seal gate could not complete reliably; retry within the attempt budget or request human input',
      );
    }

    const errors = issues.filter((issue) => issue.severity === 'error').length;
    const warnings = issues.length - errors;
    const issueSummary = { errors, warnings };
    const verdict: StructuredVerdictV1 = {
      version: 1,
      status: errors > 0 ? 'failed' : 'passed',
      issues: [...issues],
      truncated: gateResult.verdict.truncated,
      summary: issueSummary,
    };

    if (errors > 0) {
      // Reliable failure: freeze a REVISION-BOUND rework receipt — NOT a
      // candidate, no artifact/SealRecord, scaffold unchanged (N03).
      const sealId = this.sealIdFor(contentIdentity);
      const receipt: SealReworkReceiptV1 = {
        sealId,
        contentIdentity,
        turnId: grant.turnId,
        scaffoldId: state.scaffoldId,
        generationId: state.generationId,
        scaffoldRevision: revision,
        issueSummary,
      };
      this.dispatchState = { status: 'rework_required', reworkTarget: this.reworkTarget, receipt };
      return this.ok(
        { kind: 'seal', status: 'rework_required', issueSummary },
        verdict,
      );
    }

    // Passed: freeze the TURN-BOUND sealed candidate (custody staging +
    // immutable SealRecord candidate; NO events written — design §17.1 step 7).
    const candidate = await this.buildCandidate(
      grant,
      state,
      revision,
      producedFiles,
      contentIdentity,
    );
    this.dispatchState = {
      status: 'passed',
      declaredDispatches: this.declaredDispatches,
      candidate,
    };
    return this.ok({ kind: 'seal', status: 'passed', issueSummary }, verdict);
  }

  // ------------------------------------------------------------------ helpers

  private ok(receipt: SealSafeReceiptV1, verdict?: StructuredVerdictV1): SealRequestResult {
    return verdict === undefined ? { ok: true, receipt } : { ok: true, receipt, verdict };
  }

  private fail(code: string, reason: string): SealRequestResult {
    return { ok: false, code, reason };
  }

  /** The Assembler implementation digest (J06) from the frozen resource manifest. */
  private assemblerDigest(): string {
    const path = this.contract.assembler.implementation.path;
    const entry = this.contract.resourceManifest.find((item) => item.logicalPath === path);
    return entry?.sha256 ?? this.contract.semanticDigest;
  }

  /** J06 content identity: task + scaffold + revision + snapshot + assembler digest + canonical input. */
  private deriveContentIdentity(
    state: ReturnType<typeof projectStructuredSlotState>,
    canonicalInput: JsonObject,
  ): string {
    return canonicalJsonSha256({
      v: 1,
      taskId: this.taskId,
      scaffoldId: state.scaffoldId,
      generationId: state.generationId,
      revision: state.contentRevision ?? 0,
      snapshotHash: this.snapshotHash,
      assemblerId: this.contract.assembler.id,
      assemblerDigest: this.assemblerDigest(),
      canonicalInput,
    });
  }

  /** Deterministic seal identity bound to the content identity (J06). */
  private sealIdFor(contentIdentity: string): string {
    return `seal-${contentIdentity.slice(0, 32)}`;
  }

  /** Loads the effective scaffold slots (base presence + committed content). */
  private async loadSlots(
    generationId: string,
    contentRef: NonNullable<ReturnType<typeof projectStructuredSlotState>['content']>,
  ): Promise<GateSlotInput[]> {
    const index = await this.blobStore.getGenerationIndex(generationId);
    const effective = await this.blobStore.readEffectiveContent(contentRef);
    const slots: GateSlotInput[] = [];
    for (const slotId of index.documentOrder) {
      const slot = await this.blobStore.readSlot(generationId, slotId);
      if (slot === null) {
        continue;
      }
      const entry = effective[slotId];
      const presence: 'unset' | 'set' = entry?.presence ?? slot.contentPresence;
      slots.push({
        slotId: slot.slotId,
        parentSlotId: slot.parentSlotId,
        order: slot.order,
        typeId: slot.typeId,
        spec: slot.spec,
        contentPresence: presence,
        content: presence === 'set' ? (entry?.content ?? slot.content ?? null) : null,
      });
    }
    return slots;
  }

  /** Seal Gate check 1: every `required` content slot must be filled. */
  private checkRequiredPresence(slots: readonly GateSlotInput[], issues: StructuredIssueV1[]): void {
    const typeById = new Map(this.contract.slotTypes.map((type) => [type.id, type]));
    for (const slot of slots) {
      const type = typeById.get(slot.typeId);
      if (type?.content.presence === 'required' && slot.contentPresence !== 'set') {
        issues.push(
          makeStructuredIssue(
            'CONTENT_REQUIRED',
            'seal_input',
            { kind: 'slot', slotId: slot.slotId, field: 'content', valuePointer: '' },
            {},
          ),
        );
      }
    }
  }

  /** Seal Gate check 2: every set slot's content passes its contentSchema. */
  private checkContentSchemas(slots: readonly GateSlotInput[], issues: StructuredIssueV1[]): void {
    const typeById = new Map(this.contract.slotTypes.map((type) => [type.id, type]));
    for (const slot of slots) {
      const type = typeById.get(slot.typeId);
      if (type === undefined || type.content.presence === 'forbidden') {
        continue;
      }
      if (slot.contentPresence !== 'set') {
        continue;
      }
      const location: IssueLocation = { kind: 'slot', slotId: slot.slotId, field: 'content', valuePointer: '' };
      issues.push(...validateSlotValue(type.content.schema, slot.content, location, 'seal_input'));
    }
  }

  /** Seal Gate check 3: the committed tree still satisfies the LayoutGrammar. */
  private checkGrammar(slots: readonly GateSlotInput[], issues: StructuredIssueV1[]): void {
    const byParent = new Map<string | null, GateSlotInput[]>();
    for (const slot of slots) {
      const bucket = byParent.get(slot.parentSlotId) ?? [];
      bucket.push(slot);
      byParent.set(slot.parentSlotId, bucket);
    }
    for (const slot of slots) {
      const kids = byParent.get(slot.slotId);
      if (kids === undefined || kids.length === 0) {
        continue;
      }
      const childTypeIds = kids.map((kid) => kid.typeId);
      const locations: IssueLocation[] = kids.map((kid) => ({
        kind: 'slot',
        slotId: kid.slotId,
        field: 'node',
        valuePointer: '',
      }));
      issues.push(...matchProduction(this.contract.layoutGrammar, slot.typeId, childTypeIds, locations));
    }
  }

  /** Builds the canonical assembler envelope from the effective scaffold. */
  private buildAssemblerEnvelope(slots: readonly GateSlotInput[]): JsonObject {
    const pathMap = new Map<string, string[]>();
    for (const slot of slots) {
      if (slot.parentSlotId === null) {
        pathMap.set(slot.slotId, []);
      } else {
        pathMap.set(slot.slotId, [...(pathMap.get(slot.parentSlotId) ?? []), slot.parentSlotId]);
      }
    }
    const projections: EvaluatorSlotProjection[] = slots.map((slot) => ({
      slotId: slot.slotId,
      parentSlotId: slot.parentSlotId,
      order: slot.order,
      typeId: slot.typeId,
      spec: slot.spec,
      contentPresence: slot.contentPresence,
      content: slot.contentPresence === 'set' ? slot.content : null,
      path: pathMap.get(slot.slotId) ?? [],
    }));
    const typeDeclarations: EvaluatorTypeDeclaration[] = this.contract.slotTypes.map((type) => ({
      id: type.id,
      name: type.name,
      description: type.description,
    }));
    return buildAssemblerEnvelope(this.contract.assembler, { slots: projections, typeDeclarations });
  }

  /**
   * Validates the produced files against the artifactSchema create subset
   * (design §16/J04/J05): each route maps to exactly one `phase: create` file,
   * file names are safe single-segment static names, no two routes share a
   * file, every required create file is produced, and every produced file
   * inherits the frozen global `finalOutput.format` media type.
   */
  private validateAssemblerOutput(
    produced: readonly AssemblerFileResult[],
    issues: StructuredIssueV1[],
  ): void {
    const routeById = new Map(this.contract.assembler.routes.map((route) => [route.id, route]));
    const createByName = new Map(
      this.artifactSchema.files
        .filter((file) => file.phase === 'create')
        .map((file) => [file.name, file]),
    );
    const artifactLocation = (routeId: string, artifactPath: string): IssueLocation => ({
      kind: 'artifact',
      routeId,
      artifactPath,
      valuePointer: '',
    });
    const seenNames = new Set<string>();
    for (const file of produced) {
      const route = routeById.get(file.routeId);
      if (route === undefined) {
        issues.push(
          makeStructuredIssue(
            'ARTIFACT_SCHEMA_MISMATCH',
            'seal_output',
            artifactLocation(file.routeId, ''),
            { reason: 'assembler returned an undeclared route' },
          ),
        );
        continue;
      }
      const name = route.artifactFile;
      const create = createByName.get(name);
      if (create === undefined) {
        issues.push(
          makeStructuredIssue(
            'ARTIFACT_SCHEMA_MISMATCH',
            'seal_output',
            artifactLocation(file.routeId, name),
            { reason: 'route does not map to a phase:create artifactSchema file' },
          ),
        );
        continue;
      }
      if (seenNames.has(name)) {
        issues.push(
          makeStructuredIssue(
            'ARTIFACT_SCHEMA_MISMATCH',
            'seal_output',
            artifactLocation(file.routeId, name),
            { reason: 'two routes produce the same artifact file name' },
          ),
        );
        continue;
      }
      seenNames.add(name);
      if (!SAFE_SINGLE_SEGMENT.test(name)) {
        issues.push(
          makeStructuredIssue(
            'ARTIFACT_SCHEMA_MISMATCH',
            'seal_output',
            artifactLocation(file.routeId, name),
            { reason: 'artifact file name is not a safe single-segment static name' },
          ),
        );
      }
    }
    for (const required of this.artifactSchema.files) {
      if (required.phase === 'create' && required.required && !seenNames.has(required.name)) {
        issues.push(
          makeStructuredIssue(
            'ARTIFACT_SCHEMA_MISMATCH',
            'seal_output',
            artifactLocation('', required.name),
            { reason: 'required create file was not produced' },
          ),
        );
      }
    }
  }

  /** Stages custody and freezes the immutable SealRecord candidate (step 7). */
  private async buildCandidate(
    grant: SealSessionGrantV1,
    state: ReturnType<typeof projectStructuredSlotState>,
    revision: number,
    produced: readonly AssemblerFileResult[],
    contentIdentity: string,
  ): Promise<SealCandidateV1> {
    const routeById = new Map(this.contract.assembler.routes.map((route) => [route.id, route]));
    const files = produced.map((file) => {
      const route = routeById.get(file.routeId);
      return { name: route?.artifactFile ?? file.routeId, content: file.content };
    });
    const sealId = this.sealIdFor(contentIdentity);
    const outputs = files.map((file, index) => ({
      routeId: produced[index]?.routeId ?? '',
      path: file.name,
      mediaType: MEDIA_TYPE_BY_FORMAT[this.finalOutputFormat],
      byteLength: Buffer.byteLength(file.content, 'utf8'),
      sha256: sha256(file.content),
    }));
    const sourceNodeId = `${grant.turnId}-result`;
    const provisional: SealRecord = {
      sealId,
      caseId: this.taskId,
      scaffoldId: state.scaffoldId as string,
      scaffoldRevision: revision,
      scaffoldTreeHash: (state.structure as { sha256: string }).sha256,
      templateId: this.templateId,
      templateVersion: this.templateVersion,
      snapshotHash: this.snapshotHash,
      assemblerId: this.contract.assembler.id,
      assemblerVersion: this.assemblerDigest(),
      // The store stamps the final allocated { artifactId, version }.
      artifactVersionRef: { artifactId: '', version: 0 },
      outputs,
      sealedAt: this.clock().toISOString(),
    };
    const prepared = await this.artifactStore.prepareStructuredVersion(this.taskId, {
      contentIdentity,
      files,
      meta: {
        title: this.finalOutputName,
        sourceNodeId,
        format: this.finalOutputFormat,
      },
      sealRecord: provisional,
    });
    return {
      sealId,
      contentIdentity,
      turnId: grant.turnId,
      scaffoldId: state.scaffoldId as string,
      generationId: state.generationId as string,
      scaffoldRevision: revision,
      artifact: prepared,
      sealRecord: prepared.sealRecord,
      sourceNodeId,
      title: prepared.title,
      format: prepared.format,
    };
  }
}
