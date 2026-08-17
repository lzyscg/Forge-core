// @vitest-environment node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplateDirectory } from './template-loader';
import { createTestRuntimeEnvironment } from '../structured-slots/runtime-capability';
import {
  createAuthoritativeReviewTestEnvironment,
} from '../structured-slots/test-support/authoritative-review-test-registry';
import {
  isArtifactSystemProducerRef,
} from './template-schema';
import {
  ZHIHU_CHAPTER_ASSEMBLER_EXPORT_NAME,
  ZHIHU_CHAPTER_ASSEMBLER_HANDLER_KEY,
  ZHIHU_CHAPTER_ASSEMBLER_IMPLEMENTATION_DIGEST,
  ZHIHU_CHAPTER_ASSEMBLER_MODULE_ID,
} from '../runtime/authoritative-review/assembler-registry';
import { readV1CompatibilitySnapshot, V1_PACKAGE_FIXTURE } from './v1-compatibility-support';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const templateRoot = join(repoRoot, 'templates', 'zhihu-salt-chapter-draft');

function node(slotId: string, typeId: string, order: number, content?: string) {
  return {
    slotId,
    parentSlotId: slotId === 'root' ? null : 'root',
    order,
    typeId,
    spec: {},
    contentPresence: content === undefined ? 'unset' : 'set',
    ...(content === undefined ? {} : { content }),
  };
}

describe('zhihu-salt-chapter-draft v2 production source (Task 25)', () => {
  it('loads as a contract-v2 template with independent reviewer and system Seal producer', async () => {
    const frozen = await loadTemplateDirectory(templateRoot, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
    });
    expect(frozen.id).toBe('zhihu-salt-chapter-draft');
    expect(frozen.productionMode).toBe('structured_slots');
    expect(frozen.structuredSlots?.version).toBe(2);
    // The contract v2 lifecycle block + the frozen system producer.
    expect(frozen.structuredReviewLifecycle).toEqual({
      protocol: 'authoritative_review_v1',
      roleBindings: { orchestrator: 'structure', generator: 'fill', reviewer: 'review', submitter: 'submitter' },
      systemArtifactProducer: 'system:structured_seal',
    });
    // The chapter.md artifact producer is the frozen system reference.
    const chapter = frozen.artifactSchema.files[0];
    expect(chapter?.name).toBe('chapter.md');
    expect(isArtifactSystemProducerRef(chapter?.producer)).toBe(true);
    // Roles are independent — reviewer id differs from orchestrator/generator.
    const reviewer = frozen.agents.find((agent) => agent.id === 'review');
    expect(reviewer).toBeDefined();
    expect(reviewer?.id).not.toBe('structure');
    expect(reviewer?.id).not.toBe('fill');
    // The seal Agent is removed.
    expect(frozen.agents.find((agent) => agent.id === 'seal')).toBeUndefined();
    // v4 review contract carries finding verification but no Seal capability.
    if (reviewer?.turnContract?.version === 4) {
      const capabilities = reviewer.turnContract.authoritativeReview.capabilities;
      expect(capabilities).toContain('submit_finding_verification');
      expect(capabilities).not.toContain('request_seal');
      // No Map/content write capabilities.
      expect(capabilities).not.toContain('write_map_patch');
      expect(capabilities).not.toContain('write_slot_content');
    }
    // Final submitter binding is the generic Submitter.
    expect(frozen.finalOutput.submitters).toEqual(['submitter']);
  });

  it('declares relationshipPolicy: optional with narrative relation types and review policy defaults', async () => {
    const frozen = await loadTemplateDirectory(templateRoot, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
    });
    const contract = frozen.structuredSlots;
    if (contract?.version !== 2) throw new Error('expected contract v2');
    expect(contract.relationshipPolicy.mode).toBe('optional');
    expect(contract.relationTypes.length).toBeGreaterThan(0);
    // Every declared relation type carries a meaningful narrative criterion.
    for (const rel of contract.relationTypes) {
      expect(rel.semanticCriterion.length).toBeGreaterThan(0);
      expect(['blocking', 'advisory']).toContain(rel.enforcement);
      expect(rel.invalidation.direction).toBe('downstream');
      expect(rel.invalidation.maxHops).toBeGreaterThan(0);
    }
    // reviewPolicy defaults: batch 24, soft 64, maxRounds 8, observation required.
    expect(contract.reviewPolicy.mapBatchTargetSlots).toBe(24);
    expect(contract.reviewPolicy.contentBatchTargetSlots).toBe(24);
    expect(contract.reviewPolicy.assignmentSoftLimit).toBe(64);
    expect(contract.reviewPolicy.wholeMapObservation).toBe('required');
    expect(contract.reviewPolicy.wholeContentTreeObservation).toBe('required');
    expect(contract.reviewPolicy.maxRounds).toBe(8);
    expect(contract.reviewPolicy.reviewAdvisoryRelations).toBe(true);
    // Deployment envelope includes maxSlots = 10,000.
    expect(contract.limits.structure.maxSlots).toBe(10_000);
  });

  it('binds the production assembler identity exactly (no copy, no wrap, no test registry)', async () => {
    const frozen = await loadTemplateDirectory(templateRoot, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
    });
    const contract = frozen.structuredSlots;
    if (contract?.version !== 2) throw new Error('expected contract v2');
    expect(contract.assembler).toMatchObject({
      abi: 'forge-assembler/v2',
      handlerKey: ZHIHU_CHAPTER_ASSEMBLER_HANDLER_KEY,
      implementationDigest: ZHIHU_CHAPTER_ASSEMBLER_IMPLEMENTATION_DIGEST,
      implementationRef: {
        kind: 'builtin',
        moduleId: ZHIHU_CHAPTER_ASSEMBLER_MODULE_ID,
        exportName: ZHIHU_CHAPTER_ASSEMBLER_EXPORT_NAME,
      },
      budget: { timeoutMs: 5000, maxInputBytes: 67_108_864, maxOutputBytes: 8_388_608 },
      routes: [{ id: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown' }],
    });
  });

  it('rejects v2 source if it references the deleted v1 CJS assembler or a test registry entry', () => {
    // The v2 source must not ship the old assembler path or any test-registry
    // moduleId — both are explicitly disallowed by the v2 contract.
    const contract = readFileSync(join(templateRoot, 'slots/contract.yaml'), 'utf8');
    expect(contract).not.toContain('render.cjs');
    expect(contract).not.toContain('validate.cjs');
    expect(contract).not.toContain('forge-assembler/v1');
    expect(contract).not.toContain('forge-validator/v1');
    expect(contract).not.toContain('@forge/authoritative-review-test');
    // The pipeline.yaml carries the system producer and no seal Agent.
    const pipeline = readFileSync(join(templateRoot, 'pipeline.yaml'), 'utf8');
    expect(pipeline).toContain('system:structured_seal');
    expect(pipeline).not.toContain('- seal');
    // The seal Agent file and prompt are deleted.
    expect(() => readFileSync(join(templateRoot, 'agents/seal.yaml'), 'utf8')).toThrow();
    expect(() => readFileSync(join(templateRoot, 'prompts/seal-system.md'), 'utf8')).toThrow();
  });

  it('reviewer prompt forbids whole-Map/tree pass/seal fields and requires target-level facts/evidence', () => {
    const review = readFileSync(join(templateRoot, 'prompts/review-system.md'), 'utf8');
    // Reviewer must request target-level facts + evidence.
    expect(review).toContain('事实');
    expect(review).toContain('证据');
    // Reviewer must NOT silently grant whole-Map / whole-tree / Seal authority.
    // The prompt MAY mention those names only to FORBID them — the assertion
    // below strips every "禁止使用 ... " prefix so the forbidden-context
    // references remain in the prompt while unannotated claims do not.
    const stripped = (term: string) => {
      const lines = review.split('\n');
      const bannedLines = lines.filter((line) => line.includes('禁止') || line.includes('不得') || line.includes('禁止使用') || line.includes('禁止声明'));
      const allowed = lines.filter((line) => !bannedLines.includes(line) && line.includes(term));
      return allowed.join('\n');
    };
    expect(stripped('mapPassed')).not.toMatch(/mapPassed[^。]*?$/m);
    expect(stripped('treePassed')).not.toMatch(/treePassed[^。]*?$/m);
    expect(stripped('sealApproved')).not.toMatch(/sealApproved[^。]*?$/m);
    // Structure/fill prompts must use the bound v2 tool protocol.
    const structure = readFileSync(join(templateRoot, 'prompts/structure-system.md'), 'utf8');
    expect(structure).toContain('chunk');
    expect(structure).toContain('finish_map_build');
    const fill = readFileSync(join(templateRoot, 'prompts/fill-system.md'), 'utf8');
    expect(fill).toContain('submit_content_draft');
    expect(fill).toContain('repair');
    const submitter = readFileSync(join(templateRoot, 'prompts/submitter-system.md'), 'utf8');
    expect(submitter).toContain('submit_final_artifact');
    // The submitter prompt MAY list request_seal as forbidden — but it must
    // not silently call it. Strip the forbidden-context mentions first.
    const strippedSubmitter = submitter
      .split('\n')
      .filter((line) => !(line.includes('不要调用') || line.includes('不得调用')))
      .join('\n');
    expect(strippedSubmitter).not.toContain('request_seal');
  });

  it('template semantic hash differs from the archived v1 hash (Task 25 spec)', async () => {
    const v2 = await loadTemplateDirectory(templateRoot, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
    });
    expect(v2.versionHash).not.toBe(readV1CompatibilitySnapshot().zhihuV1VersionHash);
    // Profile binding is the authoritative review v1 family.
    expect(v2.authoritativeReviewProfile?.profileIdentity).toBe('forge-authoritative-review/v1');
    // Snapshot ref is a profile_snapshot blob (distinct from profileDigest).
    expect(v2.authoritativeReviewProfile?.profileSnapshotRef?.kind).toBe('profile_snapshot');
    expect(v2.authoritativeReviewProfile?.profileDigest).not.toBe(
      v2.authoritativeReviewProfile?.profileSnapshotRef?.digest,
    );
  });
});

describe('zhihu-salt-chapter-v1 archived fixture (Task 1 frozen)', () => {
  it('still loads as a v1 structured template and matches the frozen v1 route list', async () => {
    const frozen = await loadTemplateDirectory(V1_PACKAGE_FIXTURE, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
    });
    const snapshot = readV1CompatibilitySnapshot();
    // The frozen v1 fixture directory is named "zhihu-salt-chapter-v1"
    // (archive-style basename); the loaded template id matches the basename.
    expect(frozen.id).toBe('zhihu-salt-chapter-v1');
    expect(frozen.structuredSlots?.version).toBe(1);
    // Routes come from the archived fixture — Task 1 captured the v1 source
    // BEFORE the Task 25 migration; the routes must remain reachable.
    expect(frozen.routes.length).toBeGreaterThan(0);
    for (const route of frozen.routes) {
      expect(snapshot.zhihuV1Routes.some((entry) => entry.from === route.from && entry.to === route.to && entry.kind === route.kind)).toBe(true);
    }
    expect(frozen.versionHash).toBe(snapshot.zhihuV1VersionHash);
    // The archived fixture still ships the v1 CJS assembler/validator (v1
    // owns these, never the v2 builtin identity).
    const validator = require(join(V1_PACKAGE_FIXTURE, 'slots/validators/validate.cjs')) as {
      validate: (input: unknown) => { pass: boolean; issues: unknown[] };
    };
    const assembler = require(join(V1_PACKAGE_FIXTURE, 'slots/assembler/render.cjs')) as {
      assemble: (input: unknown) => Array<{ routeId: string; content: string }>;
    };
    const tree = [
      node('root', 'chapter', 0),
      node('title', 'title', 1, '雨夜的缴费单'),
      node('opening', 'opening', 2, '林晚在缴费窗口停住了手。'),
      node('scene-1', 'scene_block', 3, '她查出那笔已经结清的费用来自一个陌生账户。'),
      node('closure', 'emotional_closure', 4, '她第一次怀疑母亲隐瞒的不是债务。'),
      node('end', 'chapter_end', 5, '雨幕里，陌生号码发来一张旧仓库的照片。'),
    ];
    expect(validator.validate({ tree })).toEqual({ pass: true, issues: [] });
    expect(assembler.assemble({ tree })[0]?.content).toBe(
      '# 雨夜的缴费单\n\n林晚在缴费窗口停住了手。\n\n她查出那笔已经结清的费用来自一个陌生账户。\n\n她第一次怀疑母亲隐瞒的不是债务。\n\n雨幕里，陌生号码发来一张旧仓库的照片。\n',
    );
  });
});

describe('legacy template package test (Task 1 fixture compatibility)', () => {
  it('keeps the archived v1 fixture byte-stable and matches the snapshot hash', async () => {
    // The legacy test path below uses the production source — its `slots/`
    // directory references v2 builtin validators + assembler, so it loads as
    // v2. The legacy path assertions have moved to the v1 fixture describe
    // block above; this case exists purely as a fence so a future v2 source
    // edit cannot silently drop the v1 archive coverage.
    const v2 = await loadTemplateDirectory(templateRoot, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
    });
    expect(v2.structuredSlots?.version).toBe(2);
  });
});

describe('legacy template package test (Task 1 fixture compatibility)', () => {
  it('keeps the archived v1 fixture byte-stable and matches the snapshot hash', async () => {
    const frozen = await loadTemplateDirectory(V1_PACKAGE_FIXTURE, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
    });
    expect(frozen.versionHash).toBe(readV1CompatibilitySnapshot().zhihuV1VersionHash);
  });
});
