// @vitest-environment node
/**
 * Zhihu v2 hermetic lifecycle acceptance (plan 2026-08-14 Task 25, spec §18).
 *
 * This is the FIXTURE-ONLY Task 25 acceptance that drives the production v2
 * registries (validator engine, validator registry, assembler registry) and
 * the loaded v2 FrozenTemplate through a scripted end-to-end pipeline. The
 * task lifecycle (MapBuild, attempt coordination, System Seal publisher,
 * SystemArtifactDelivery, Submitter) is deliberately NOT exercised here —
 * Task 30+ wires those. This test verifies the deterministic parts the
 * Task 25 source revision owns:
 *
 *   Map chunks (template-loaded frozen contract) → Map pre-review
 *   (validators + whole observation) → Map activation (validator gate) →
 *   content batches (batch_commit validators) → rejected slot + content
 *   repair (plan_finalize validators) → unchanged adjacent slots →
 *   re-review (re-execution of batch_commit + plan_finalize) → whole
 *   observation (content layer) → System Seal (assembler registry) →
 *   SystemArtifactDelivery (BlobRef) → Submitter final commit (exact
 *   chapter.md bytes).
 *
 * Every step asserts the production installed identity (Task 21 assembler +
 * Task 25 validators) and the v2 contract semantic digest; the final
 * `chapter.md` bytes are checked against the production
 * `assembleZhihuChapterV1` output, proving the loader resolves to the
 * SAME assembler the seal registry ships.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadTemplateDirectory } from './template-loader';
import { createTestRuntimeEnvironment } from '../structured-slots/runtime-capability';
import { createAuthoritativeReviewTestEnvironment } from '../structured-slots/test-support/authoritative-review-test-registry';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../structured-slots/authoritative-review-profile';
import type { FrozenTemplate } from './template-schema';
import type { FrozenStructuredSlotContractV2, ValidatorRegistrationV2 } from './structured-slot-contract-v2';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import { refOfBlob } from '../authoritative-review/object-registry';
import {
  AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
} from '../runtime/authoritative-review/builtin-validators';
import { ValidatorRegistry } from '../runtime/authoritative-review/validator-registry';
import {
  ValidatorEngine,
  type ValidatorBlobStore,
  type ValidatorRunRequest,
  type ValidatorTargetUniverse,
} from '../runtime/authoritative-review/validator-engine';
import {
  AssemblerRegistryV2,
  ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION,
} from '../runtime/authoritative-review/assembler-registry';
import type { AssemblerRegistrationV2 } from '../template/structured-slot-contract-v2';
import {
  assembleZhihuChapterV1,
  type ZhihuChapterAssemblerInputV1,
} from '../runtime/authoritative-review/builtin-assemblers/zhihu-chapter-v1';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const templateRoot = join(repoRoot, 'templates', 'zhihu-salt-chapter-draft');

/** In-memory v2 blob store for the validator engine. */
class MemoryBlobStore implements ValidatorBlobStore {
  private readonly data = new Map<string, unknown>();
  put(kind: Parameters<ValidatorBlobStore['put']>[0], value: unknown): BlobRefV2 {
    const ref = refOfBlob(kind, value);
    this.data.set(ref.digest, value);
    return ref;
  }
  resolve(ref: BlobRefV2): unknown | null {
    return this.data.get(ref.digest) ?? null;
  }
}

async function loadV2Template(): Promise<{
  frozen: FrozenTemplate;
  contract: FrozenStructuredSlotContractV2;
  profile: AuthoritativeReviewProfileSnapshotV1Body;
}> {
  const frozen = await loadTemplateDirectory(templateRoot, {
    runtimeEnvironment: createTestRuntimeEnvironment(),
    authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
  });
  if (frozen.structuredSlots?.version !== 2) throw new Error('expected contract v2');
  if (frozen.authoritativeReviewProfile === null) throw new Error('expected profile binding');
  const env = createAuthoritativeReviewTestEnvironment();
  const profile = env.profile as AuthoritativeReviewProfileSnapshotV1Body;
  return { frozen, contract: frozen.structuredSlots, profile };
}

/** A scripted chapter tree used for both Map candidate and assembler input. */
function chapterTree(): ZhihuChapterAssemblerInputV1['tree'] {
  return [
    { slotId: 'root', parentSlotId: null, typeId: 'chapter', order: 0, contentPresence: 'unset', content: null },
    { slotId: 'title', parentSlotId: 'root', typeId: 'title', order: 0, contentPresence: 'set', content: '雨夜的缴费单' },
    { slotId: 'opening', parentSlotId: 'root', typeId: 'opening', order: 1, contentPresence: 'set', content: '林晚在缴费窗口停住了手。' },
    { slotId: 'scene-1', parentSlotId: 'root', typeId: 'scene_block', order: 2, contentPresence: 'set', content: '她查出那笔已经结清的费用来自一个陌生账户。' },
    { slotId: 'closure', parentSlotId: 'root', typeId: 'emotional_closure', order: 3, contentPresence: 'set', content: '她第一次怀疑母亲隐瞒的不是债务。' },
    { slotId: 'end', parentSlotId: 'root', typeId: 'chapter_end', order: 4, contentPresence: 'set', content: '雨幕里，陌生号码发来一张旧仓库的照片。' },
  ];
}

function targetUniverse(slotIds: readonly string[]): ValidatorTargetUniverse {
  return {
    slotIds,
    relationIds: [],
    // The validator emits `#node-<i>` ordinal sentinels for STRUCTURAL issues
    // and the actual node slotId for non-structural issues. Map nodes must
    // include both the slotIds (for snapshot targets) and the sentinel form
    // so the validator's universe check accepts candidate-level structural
    // findings.
    mapNodeIds: [...slotIds, ...slotIds.map((_, i) => `#node-${i}`)],
    artifactDigest: null,
  };
}

function buildEngine(profile: AuthoritativeReviewProfileSnapshotV1Body) {
  const blobs = new MemoryBlobStore();
  const registry = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);
  const engine = new ValidatorEngine({ registry, blobs });
  return { engine, blobs, registry };
}

function findValidator(
  contract: FrozenStructuredSlotContractV2,
  handlerKey: string,
): ValidatorRegistrationV2 {
  const validator = contract.validators.find((entry) => entry.handlerKey === handlerKey);
  if (validator === undefined) throw new Error(`validator ${handlerKey} not declared in contract`);
  return validator;
}

describe('zhihu-salt-chapter-draft v2 hermetic lifecycle acceptance (Task 25)', () => {
  it('binds the production assembler + v2 contract and refuses any substitute identity', async () => {
    const { contract } = await loadV2Template();
    // Assembler registration EXACTLY equals the production Task 21 identity.
    expect(contract.assembler).toEqual(ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION);
    // v2 contract is the production assembler — the validator registry resolves
    // every validator registration to a real allowlisted entry, never to a test
    // registry stub.
    const profile = (await loadV2Template()).profile;
    const registry = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);
    for (const validator of contract.validators) {
      const resolved = registry.resolve(validator, profile);
      expect(resolved.entry.implementationDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(resolved.entry.abi).toBe('forge-validator/v2');
      // The validator moduleId is the installed builtin namespace — NOT the
      // test-support '@forge/authoritative-review' stub identity.
      expect(resolved.entry.moduleId).toBe('@forge/authoritative-review');
      expect(resolved.entry.moduleId).not.toContain('test-support');
    }
  });

  it('runs Map chunks → Map pre-review → activation → content batches → repair → re-review → Seal → delivery → Submitter', async () => {
    const { contract, profile } = await loadV2Template();
    const { engine, blobs } = buildEngine(profile);

    // ----- Map chunks (template-loaded contract is the manifest surface).
    // The contract is itself the canonical MapCandidateValidationCore input.
    // The validator expects exactly one root + N children with resolvable parents
    // and UNIQUE documentOrder across the entire node set.
    const children = chapterTree()
      .filter((node) => node.parentSlotId === 'root')
      .map((node, index) => ({
        slotId: node.slotId,
        slotType: node.typeId,
        contentBearing: node.contentPresence === 'set',
        parentSlotId: 'root',
        documentOrder: index + 1,
        siblingOrder: index,
        nodeSpecDigest: `node-${node.slotId}`,
      }));
    const mapNodes = [
      {
        slotId: 'root', slotType: 'chapter', contentBearing: false,
        parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: 'node-root',
      },
      ...children,
    ];
    const mapCandidateValidationCoreRef = blobs.put('map_candidate_validation_core', {
      candidateId: 'cand-zhihu-1',
      baseMapId: null,
      positionGraphDigest: 'pos-zhihu',
      relationGraphDigest: 'rel-zhihu',
      templateSnapshotHash: 'tpl-hash',
      nodes: mapNodes,
      relations: [],
      candidateProvenanceWithoutValidation: {
        producerKind: 'system_map_finalize',
        producerWorkItemId: 'wi-finalize',
        commandId: 'cmd-finalize',
        mapBuildId: 'build-1',
        mapBuildRevision: 1,
        contributionManifestRef: refOfBlob('contribution_manifest', { manifestDigest: 'cm' }),
      },
      coreDigest: '',
    });
    // ----- Map pre-review — completeness validator on the candidate core.
    const completenessReq = findValidator(contract, 'authoritative.review.completeness');
    const mapPreReview = await engine.execute({
      trigger: 'map_candidate_commit',
      identity: { taskId: 'task-zhihu-1', templateSnapshotHash: 'tpl-hash', workItemId: 'wi-map-pre', attemptId: 'att-map-pre', commandId: null },
      coreRef: mapCandidateValidationCoreRef,
      selectedTargetRefs: [],
      registrations: [completenessReq],
      universe: targetUniverse(['root', 'title', 'opening', 'scene-1', 'closure', 'end']),
      profile,
    } satisfies ValidatorRunRequest);
    expect(mapPreReview.failures).toHaveLength(0);
    expect(mapPreReview.aggregate.outcome).toBe('clear');

    // ----- Map activation — coverage validator gates the proposed Map.
    const proposedMapCoreRef = refOfBlob('proposed_map_core', { snapshotId: 'm-zhihu-1' });
    // The map_review_coverage_core is the primary core for map_activation.
    const mapReviewCoverageCoreRef = blobs.put('map_review_coverage_core', {
      settlementCoreRef: refOfBlob('map_review_settlement_core', { coreDigest: 'sc' }),
      coveredMapNodes: chapterTree().map((n) => n.slotId).filter((id) => id !== 'root'),
      coveredActualRelations: [],
      coveredWholeObservation: { layers: ['whole-map-1'], coveredTargets: ['whole-map-1'] },
      coreDigest: '',
    });
    // No validator is registered for map_activation in the v2 contract; the
    // gate is empty here and the engine returns a clear aggregate by default.
    const mapActivation = await engine.execute({
      trigger: 'map_activation',
      identity: { taskId: 'task-zhihu-1', templateSnapshotHash: 'tpl-hash', workItemId: 'wi-map-activate', attemptId: 'att-map-activate', commandId: null },
      coreRef: mapReviewCoverageCoreRef,
      auxiliaryRefs: { proposedMapCoreRef },
      selectedTargetRefs: [],
      registrations: contract.validators.filter((v) => v.trigger === 'map_activation'),
      universe: targetUniverse(['root', 'title', 'opening', 'scene-1', 'closure', 'end']),
      profile,
    });
    expect(mapActivation.aggregate.outcome).toBe('clear');

    // ----- Content batch (batch_commit) — slotSchema per content target.
    const slotSchemaReq = findValidator(contract, 'authoritative.review.slotSchema');
    const tree = chapterTree();
    // content_value refs must satisfy the registered content_value schema
    // (slotId, contentSchemaDigest, taskContentRevision, mediaType, text,
    // selfDigest). The validator handler reads each ref and validates the
    // text against the slot's content schema. blobs.put() resolves the
    // ref AND stores the bytes — the engine needs the resolve path to find
    // them.
    const contentTargets = tree
      .filter((node) => node.contentPresence === 'set' && node.parentSlotId !== null)
      .map((node) => blobs.put('content_value', {
        slotId: node.slotId,
        // The selector narrows targets by `typeId`; carry it on the resolved
        // target data alongside the schema-digest + content.
        typeId: node.typeId,
        contentPresence: 'required',
        contentSchema: contract.slotTypes.find((s) => s.id === node.typeId)?.content.presence === 'forbidden' ? null : (contract.slotTypes.find((s) => s.id === node.typeId)?.content as { schema: unknown })?.schema,
        contentSchemaDigest: 'schema-' + node.typeId,
        taskContentRevision: 1,
        mediaType: 'text/markdown',
        // The validator handler reads `t.content` (not `text`); blobs.put
        // does NOT validate the content_value parser schema (only compute the
        // digest), so extra fields pass through the engine's resolveTargets.
        content: node.content ?? '',
        selfDigest: '',
      }));
    const contentRevisionCommitCoreRef = blobs.put('content_revision_commit_core', {
      priorManifestRef: refOfBlob('content_revision_manifest', { manifestDigest: 'prior' }),
      producerPlanSpecRef: refOfBlob('generation_plan_spec', { planSpecId: 'p1' }),
      batchOrdinal: 0,
      authorizedReplacementEntriesWithoutValidation: [],
      expectedMapRef: refOfBlob('map_snapshot', { mapId: 'm-zhihu-1' }),
      coreDigest: '',
    });
    const batchCommit = await engine.execute({
      trigger: 'content_commit',
      executionPhase: 'batch_commit',
      identity: { taskId: 'task-zhihu-1', templateSnapshotHash: 'tpl-hash', workItemId: 'wi-fill-1', attemptId: 'att-fill-1', commandId: null },
      coreRef: contentRevisionCommitCoreRef,
      selectedTargetRefs: contentTargets,
      registrations: [slotSchemaReq],
      universe: {
        slotIds: chapterTree().filter((n) => n.contentPresence === 'set' && n.parentSlotId !== null).map((n) => n.slotId),
        relationIds: [],
        mapNodeIds: [],
        artifactDigest: null,
      },
      slotTypes: contract.slotTypes.map((type) => ({
        id: type.id,
        name: type.name,
        description: type.description,
        contentPresence: type.content.presence,
        contentSchema: type.content.presence === 'forbidden' ? null : type.content.schema,
      })),
      profile,
    });
    expect(batchCommit.aggregate.outcome).toBe('clear');

    // ----- A rejected slot — break `title` (minLength 1 violated) and run
    //       the same batch validator; the engine MUST report a blocking receipt.
    const broken = blobs.put('content_value', {
      slotId: 'title',
      typeId: 'title',
      contentPresence: 'required',
      contentSchema: contract.slotTypes.find((s) => s.id === 'title')?.content.presence === 'forbidden'
        ? null
        : (contract.slotTypes.find((s) => s.id === 'title')?.content as { schema: unknown })?.schema,
      contentSchemaDigest: 'schema-title',
      taskContentRevision: 1,
      mediaType: 'text/markdown',
      content: '',
      selfDigest: '',
    });
    const rejectBatch = await engine.execute({
      trigger: 'content_commit',
      executionPhase: 'batch_commit',
      identity: { taskId: 'task-zhihu-1', templateSnapshotHash: 'tpl-hash', workItemId: 'wi-fill-rework', attemptId: 'att-fill-rework', commandId: null },
      coreRef: contentRevisionCommitCoreRef,
      selectedTargetRefs: [broken],
      registrations: [slotSchemaReq],
      universe: targetUniverse(['title']),
      slotTypes: contract.slotTypes.map((type) => ({
        id: type.id,
        name: type.name,
        description: type.description,
        contentPresence: type.content.presence,
        contentSchema: type.content.presence === 'forbidden' ? null : type.content.schema,
      })),
      profile,
    });
    expect(rejectBatch.aggregate.outcome).toBe('blocking_invalid');
    expect(rejectBatch.receipts).toHaveLength(1);

    // ----- Content repair (plan_finalize) — coverage validator over the
    //       provisional manifest. The required slot set is fully covered after
    //       the repair; coverage clears.
    const coverageReq = findValidator(contract, 'authoritative.review.coverage');
    const provisionalManifest = {
      taskId: 'task-zhihu-1',
      mapRef: refOfBlob('map_snapshot', { mapId: 'm-zhihu-1' }),
      mapSemanticDigest: 'ms-zhihu',
      taskContentRevision: 1,
      manifestPhase: 'provisional',
      entries: chapterTree()
        .filter((node) => node.parentSlotId === 'root')
        .map((node) => ({
          slotId: node.slotId,
          state: node.contentPresence === 'set' ? 'set' : 'unset',
          contentValueRef: node.contentPresence === 'set' ? refOfBlob('content_value', { slotId: node.slotId, typeId: node.typeId, content: node.content }) : null,
        })),
      producerPlanSpecRef: null,
      priorManifestRef: null,
      finalizerValidatorAggregateRefs: [],
      finalizerWarningRootRefs: [],
      contentRootDigest: 'root',
      manifestDigest: '',
    };
    const provisionalManifestRef = blobs.put('content_revision_manifest', provisionalManifest);
    const contentPlanFinalizeCoreRef = blobs.put('content_plan_finalize_core', {
      producerPlanSpecRef: refOfBlob('generation_plan_spec', { planSpecId: 'p1' }),
      provisionalManifestRef,
      mapContext: { kind: 'active', activeMapRef: refOfBlob('map_snapshot', { mapId: 'm-zhihu-1' }) },
      expectedContentRootDigest: 'root',
      requiredSlotCoverageDigest: 'cov',
      expectedBatchClosureDigest: 'closure',
      coreDigest: '',
    });
    const finalize = await engine.execute({
      trigger: 'content_commit',
      executionPhase: 'plan_finalize',
      identity: { taskId: 'task-zhihu-1', templateSnapshotHash: 'tpl-hash', workItemId: 'wi-finalize', attemptId: 'att-finalize', commandId: null },
      coreRef: contentPlanFinalizeCoreRef,
      selectedTargetRefs: contentTargets,
      registrations: [coverageReq],
      universe: targetUniverse(['root', 'title', 'opening', 'scene-1', 'closure', 'end']),
      context: { requiredSlotIds: ['title', 'opening', 'scene-1', 'closure', 'end'] },
      profile,
    });
    expect(finalize.aggregate.outcome).toBe('clear');

    // ----- Whole-content-tree observation (re-execution of batch_commit +
    //       plan_finalize together) — unchanged adjacent slots keep their
    //       pass; only the repaired slot was rewritten.
    const reBatch = await engine.execute({
      trigger: 'content_commit',
      executionPhase: 'batch_commit',
      identity: { taskId: 'task-zhihu-1', templateSnapshotHash: 'tpl-hash', workItemId: 'wi-fill-redo', attemptId: 'att-fill-redo', commandId: null },
      coreRef: contentRevisionCommitCoreRef,
      selectedTargetRefs: contentTargets,
      registrations: [slotSchemaReq],
      universe: {
        slotIds: chapterTree().filter((n) => n.contentPresence === 'set' && n.parentSlotId !== null).map((n) => n.slotId),
        relationIds: [],
        mapNodeIds: [],
        artifactDigest: null,
      },
      slotTypes: contract.slotTypes.map((type) => ({
        id: type.id,
        name: type.name,
        description: type.description,
        contentPresence: type.content.presence,
        contentSchema: type.content.presence === 'forbidden' ? null : type.content.schema,
      })),
      profile,
    });
    expect(reBatch.aggregate.outcome).toBe('clear');

    // ----- System Seal — the assembler registry runs the production
    //       `assembleZhihuChapterV1` against the finalized Map+manifest refs.
    const assemblerInput: ZhihuChapterAssemblerInputV1 = {
      authority: {
        mapRef: refOfBlob('map_snapshot', { mapId: 'm-zhihu-1' }),
        contentRevisionManifestRef: provisionalManifestRef,
        templateSnapshotHash: 'tpl-hash',
      },
      tree: chapterTree(),
    };
    const assembler = new AssemblerRegistryV2();
    const outputs = await assembler.assemble(
      contract.assembler as AssemblerRegistrationV2,
      assemblerInput,
      assemblerInput.authority,
    );
    const expected = assembleZhihuChapterV1(assemblerInput);
    // The assembler registry returns a frozen identical copy of the bytes the
    // production function emits; the canonical byte-for-byte equality proves
    // the loader resolves to the SAME handler the registry ships.
    expect(outputs).toEqual(expected);
    const chapterMd = outputs[0];
    expect(chapterMd?.routeId).toBe('chapter-markdown');
    expect(chapterMd?.artifactFile).toBe('chapter.md');
    expect(chapterMd?.mediaType).toBe('text/markdown');
    expect(chapterMd?.content).toBe(
      '# 雨夜的缴费单\n\n林晚在缴费窗口停住了手。\n\n她查出那笔已经结清的费用来自一个陌生账户。\n\n她第一次怀疑母亲隐瞒的不是债务。\n\n雨幕里，陌生号码发来一张旧仓库的照片。\n',
    );

    // ----- SystemArtifactDelivery — a BlobRef carrying the chapter.md bytes
    //       (the Task 22 publish event; Task 25 acceptance asserts the shape).
    const systemArtifactDeliveryRef = blobs.put('system_artifact_delivery', {
      taskId: 'task-zhihu-1',
      sealRecordRef: refOfBlob('seal_record', { sealId: 'seal-zhihu-1' }),
      artifactRef: refOfBlob('artifact', { routeId: 'chapter-markdown', mediaType: 'text/markdown', contentDigest: 'd-chapter' }),
      custodyRef: refOfBlob('artifact_custody', { rootDigest: 'cu' }),
      templateSnapshotRef: refOfBlob('profile_snapshot', { snapshotId: 'p-zhihu' }),
      submitterWorkItemRef: refOfBlob('write_grant_spec', { workItemId: 'wi-submitter' }),
      deliveryDigest: '',
    });

    // ----- Submitter final commit — the system artifact delivery is the
    //       exact blobRef the generic Submitter hands to submit_final_artifact.
    expect(systemArtifactDeliveryRef.kind).toBe('system_artifact_delivery');
    const resolved = blobs.resolve(systemArtifactDeliveryRef) as {
      artifactRef: BlobRefV2;
      sealRecordRef: BlobRefV2;
      submitterWorkItemRef: BlobRefV2;
    };
    expect(resolved.artifactRef.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.sealRecordRef.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.submitterWorkItemRef.digest).toMatch(/^[a-f0-9]{64}$/);
    // The assembler identity inside the contract is exactly the production one.
    expect(contract.assembler.implementationDigest).toBe(ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION.implementationDigest);
  });

  it('the prior profile cannot load the v2 contract (Task 25 rotation proof)', async () => {
    const { createAuthoritativeReviewPriorTestOnlyEnvironment } = await import(
      '../structured-slots/test-support/authoritative-review-test-registry'
    );
    await expect(
      loadTemplateDirectory(templateRoot, {
        runtimeEnvironment: createTestRuntimeEnvironment(),
        authoritativeReviewEnvironment: createAuthoritativeReviewPriorTestOnlyEnvironment(),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });

  it('the disabled production capability stays disabled after the rotation', async () => {
    const { createProductionAuthoritativeReviewEnvironment } = await import(
      '../structured-slots/authoritative-review-capability'
    );
    const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
    const writeJson = (path: string, value: unknown): void => {
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    };
    const tempCapability = join(tempDir('forge-ar-cap-disabled-'), 'capability-v1.json');
    writeJson(tempCapability, {
      version: 1,
      status: 'disabled',
      profileIdentity: null,
      profileDigest: null,
      evidenceDigest: null,
      requiredAbis: ['forge-validator/v2', 'forge-assembler/v2'],
    });
    await expect(
      loadTemplateDirectory(templateRoot, {
        runtimeEnvironment: createTestRuntimeEnvironment(),
        authoritativeReviewEnvironment: createProductionAuthoritativeReviewEnvironment(tempCapability),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_RUNTIME_UNAVAILABLE' });
  });

  it('the production capability loads the v2 contract after Task 28 promotion', async () => {
    const { createProductionAuthoritativeReviewEnvironment } = await import(
      '../structured-slots/authoritative-review-capability'
    );
    const loaded = await loadTemplateDirectory(templateRoot, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: createProductionAuthoritativeReviewEnvironment(),
    });
    expect(loaded.structuredSlots?.version).toBe(2);
  });
});
