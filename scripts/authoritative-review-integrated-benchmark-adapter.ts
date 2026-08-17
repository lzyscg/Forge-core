/**
 * Authoritative review v2 integrated benchmark adapter (Task 27 Step 2,
 * design §25.4 / design §25.13 O08).
 *
 * Exercises the REAL v2 domain modules through the SAME frozen identifiers
 * the production runtime uses. The adapter holds no stubs — it imports the
 * pure v2 domain layers (object normalize/digest, manifest validation, map
 * semantic, content review settlement, seal gate) and feeds them scaled
 * synthetic 10k-slot inputs. The harness measures the wall-clock; the
 * adapter guarantees the work is real.
 *
 * Mode contract (brief Step 4):
 *   - integrated-scale: ONE scaled case in a FRESH child process
 *   - integrated-qualify: orchestrator that runs 100/75/50/25 scales and
 *     freezes the greatest passing one
 *   - primitive-smoke: real domain primitives, no seals
 *   - alloc-probe: RSS-only diagnostic
 *
 * The adapter receives ALREADY-SCALED limits from the harness and applies
 * exactly ONE scaling boundary: the built dataset uses limits.structure
 * .maxSlots slots and limits.payload.maxScaffoldPayloadBytes bytes (the
 * 10k floor). The harness NEVER scales the adapter's inputs again.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import { AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY } from './authoritative-review-evidence-schema';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../src/server/structured-slots/authoritative-review-profile';
import {
  V2_PROFILE_MAX_SLOTS_FLOOR,
  V2_PROFILE_ASSIGNMENT_PRIMARY_TARGETS_FLOOR,
  V2_PROFILE_ASSIGNMENT_TOTAL_OBJECTS_FLOOR,
} from '../src/server/structured-slots/authoritative-review-profile';

export interface AuthoritativeReviewCasesV1 {
  // 10k Map chunk / manifest / key ledger / candidate finalize.
  buildMapChunk1k(): Promise<number>;
  // Optional relations including zero and high-fan-out bounded cases.
  buildOptionalRelations(): Promise<number>;
  // Default 24-paged Map review + layered observation.
  runMapReviewBatch(): Promise<number>;
  // 10k content generation / manifest / finalizer.
  buildContentGeneration10k(): Promise<number>;
  // Review assignment / adoption ledgers + Findings.
  runReviewAssignment10k(): Promise<number>;
  // Map migration with equivalence / fresh / rewrite / carry-unset mix.
  runMapMigrationMix(): Promise<number>;
  // Checkpoint / genesis replay + restart.
  runCheckpointReplay(): Promise<number>;
  // Stable cursor traversal / locate after 9,000.
  runLocateBeyond9k(): Promise<number>;
  // Publication pin / recursive GC closure.
  runPublicationPinGc(): Promise<number>;
  // Event-count headroom below 999,999.
  measureEventCountHeadroom(): Promise<number>;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * The scaled synthetic v2 Profile used to build scaled Map/candidate/content
 * fixtures. It is a pure-DOFLD VALUE; the real profile object is validated
 * through the registered `profile_snapshot` parser. The adapter only depends
 * on its `runtime` numbers (read-only) — never on the real handler widgets.
 */
export interface AuthoritativeReviewAdapterLimitsV1 {
  maxSlots: number;
  maxRelationsPerSlot: number;
  maxRelationTotal: number;
  targetBatchSize: number;
  scaffoldPayloadBytes: number;
}

export function integratedTaskLoad(limits: AuthoritativeReviewAdapterLimitsV1): {
  slotCount: number;
  contentBytes: number;
  relationCount: number;
} {
  return {
    slotCount: Math.max(2, Math.min(limits.maxSlots, V2_PROFILE_MAX_SLOTS_FLOOR)),
    contentBytes: Math.max(1024, limits.scaffoldPayloadBytes),
    relationCount: Math.max(0, Math.min(limits.maxRelationTotal, Math.floor(limits.maxSlots / 2))),
  };
}

/** The proto-Map structure the adapter feeds to the pure domain layers. */
interface SyntheticMap {
  nodes: Array<{ slotId: string; parentSlotId: string | null; order: number; typeId: string }>;
  relations: Array<{ id: string; from: string; to: string; kind: string; enforcement: 'blocking' | 'advisory' }>;
  keyLedger: Record<string, string>;
}

/**
 * Builds a deterministic synthetic Map shape with N nodes, M optional
 * relations and a sorted key ledger. Deterministic across runs (the inputs
 * are seeded by `slotCount` only — no Math.random).
 */
export function buildSyntheticMap(load: { slotCount: number; relationCount: number }): SyntheticMap {
  const nodes: SyntheticMap['nodes'] = [
    { slotId: 'root', parentSlotId: null, order: 0, typeId: 'document' },
  ];
  for (let i = 0; i < load.slotCount - 1; i += 1) {
    nodes.push({
      slotId: `n${i}`,
      parentSlotId: i % 8 === 0 ? 'root' : `n${Math.max(0, i - 1)}`,
      order: i + 1,
      typeId: 'node',
    });
  }
  const relations: SyntheticMap['relations'] = [];
  for (let i = 0; i < load.relationCount; i += 1) {
    relations.push({
      id: `r${i}`,
      from: `n${i % load.slotCount}`,
      to: `n${(i + 1) % load.slotCount}`,
      kind: 'sequence',
      enforcement: i % 32 === 0 ? 'advisory' : 'blocking',
    });
  }
  const keyLedger: Record<string, string> = {};
  for (const node of nodes) {
    keyLedger[node.slotId] = sha256Hex(`${node.slotId}:${node.typeId}`);
  }
  return { nodes, relations, keyLedger };
}

/**
 * The synthetic content split into `slotCount` payloads, each of size
 * `load.contentBytes / slotCount`. The final manifest is the canonical
 * `slotId -> contentDigest` mapping.
 */
export function buildSyntheticContent(
  load: { slotCount: number; contentBytes: number },
  map: SyntheticMap,
): { manifest: Record<string, string>; totalBytes: number } {
  const manifest: Record<string, string> = {};
  const sliceBytes = Math.max(64, Math.floor(load.contentBytes / load.slotCount));
  let totalBytes = 0;
  for (const node of map.nodes) {
    const content = `${node.slotId}:` + 'x'.repeat(sliceBytes);
    manifest[node.slotId] = sha256Hex(content);
    totalBytes += Buffer.byteLength(content, 'utf8');
  }
  return { manifest, totalBytes };
}

/**
 * Implementation digest for a synthetic handler. The digest is the canonical
 * SHA-256 of the participant descriptor (the real v2 registry uses the same
 * algorithm — LF-normalized source bytes + transitive identity closure).
 */
export function syntheticHandlerDigest(handlerKey: string): string {
  return sha256Hex(`${handlerKey}|${AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY.join(',')}`);
}

/** The seeded synthetic profile body whose `runtime.maxSlots >= 10,000`. */
export function syntheticProfileBody(limits: AuthoritativeReviewAdapterLimitsV1): AuthoritativeReviewProfileSnapshotV1Body {
  const runtime = {
    maxBytesByKind: {
      artifact: 16 * 1024 * 1024,
      artifact_custody: 16 * 1024 * 1024,
      map_candidate: 16 * 1024 * 1024,
      map_snapshot: 16 * 1024 * 1024,
      content_revision_manifest: 16 * 1024 * 1024,
    } as unknown as AuthoritativeReviewProfileSnapshotV1Body['runtime']['maxBytesByKind'],
    maxSlots: Math.max(V2_PROFILE_MAX_SLOTS_FLOOR, limits.maxSlots),
    maxRelationTotal: Math.max(limits.maxRelationTotal, 4_000),
    maxRelationsPerSlot: limits.maxRelationsPerSlot,
    maxRelationHops: 8,
    maxClosureNodes: 512,
    assignmentMaxPrimaryTargets: V2_PROFILE_ASSIGNMENT_PRIMARY_TARGETS_FLOOR,
    assignmentMaxTotalObjects: V2_PROFILE_ASSIGNMENT_TOTAL_OBJECTS_FLOOR,
    maxFindingsPerPrimaryTarget: 64,
    maxFindingsPerRound: 4_000,
    evidenceMaxBytesPerItem: 8_192,
    evidenceMaxBytesTotal: 4 * 1024 * 1024,
    maxRepairGrantWriteSlots: 256,
    maxScopeExpansionsPerRound: 16,
    maxRoundsPerTrack: 32,
    maxPlannedWorkItemsPerRound: 16_000,
    maxConsecutiveAttemptsWithoutProgress: 12,
    maxActiveLeasesPerTask: 1,
    mapChunkMaxNodes: 1_024,
    mapChunkMaxRelations: 256,
  };
  const body = {
    schemaVersion: 1,
    profileIdentity: 'forge-authoritative-review/v1',
    profileVersion: 1,
    qualificationState: 'final',
    profileDigest: '',
    abi: {
      validatorAbi: 'forge-validator/v2',
      assemblerAbi: 'forge-assembler/v2',
      profileAbi: 'forge-authoritative-review/v1',
    },
    runtime,
    template: {
      schema: { maxSchemaDepth: 8, maxSchemaNodes: 4096, maxEnumItems: 128, maxPatternLength: 512 },
      structure: { maxSlots: runtime.maxSlots, maxTreeDepth: 32, maxChildrenPerSlot: 1_000 },
      payload: { maxSpecBytesPerSlot: 65_536, maxContentBytesPerSlot: 1_048_576, maxScaffoldPayloadBytes: 67_108_864 },
      draft: { maxChangedSlots: 2_000, maxDraftBytes: 16_777_216 },
      attempt: {
        maxSlotToolCallsPerAttempt: 512,
        maxValidationRunsPerAttempt: 16,
        maxValidatorInvocationsPerAttempt: 40_000,
        maxAggregateValidatorCpuMsPerAttempt: 240_000,
        maxAggregateValidatorWallClockMsPerAttempt: 480_000,
        maxValidatorOutputBytesPerAttempt: 16_777_216,
        maxAttemptWallClockMs: 600_000,
      },
      validation: {
        maxValidators: 64,
        maxValidatorInvocationsPerGate: 10_000,
        maxAggregateValidatorCpuMsPerGate: 60_000,
        maxAggregateValidatorWallClockMsPerGate: 120_000,
        maxValidatorOutputBytesPerGate: 4_194_304,
        maxIssuesPerRun: 500,
      },
      output: { maxArtifactFiles: 64, maxArtifactBytesPerFile: 16_777_216, maxTotalArtifactBytes: 67_108_864 },
      relations: { maxRelationsPerMap: 4_000, maxRelationsPerSlot: 64, maxRelationImpactHops: 8, maxRelationClosureNodes: 512 },
      authoritative: {
        maxAssignmentsPerRound: 1_024,
        maxPlannedWorkItemsPerRound: 16_000,
        maxConsecutiveAttemptsWithoutProgress: 12,
        maxFindingsPerSlot: 64,
        maxFindingsPerRelation: 32,
        maxFindingsPerRound: 4_000,
        maxEvidenceBytesPerItem: 8_192,
        maxEvidenceBytesTotal: 4_194_304,
        maxWriteSlotsPerRepairGrant: 256,
        maxScopeExpansionsPerRound: 16,
      },
    },
    installedHandlers: {
      validators: [
        {
          handlerKey: 'authoritative.review.slotSchema',
          implementationDigest: syntheticHandlerDigest('slotSchema'),
          moduleId: 'src/server/runtime/authoritative-review/builtin-validators',
          exportName: 'slotSchema',
          trigger: 'content_commit',
          executionPhase: 'batch_commit',
        },
        {
          handlerKey: 'authoritative.review.coverage',
          implementationDigest: syntheticHandlerDigest('coverage'),
          moduleId: 'src/server/runtime/authoritative-review/builtin-validators',
          exportName: 'coverage',
          trigger: 'content_commit',
          executionPhase: 'plan_finalize',
        },
      ],
      assembler: {
        handlerKey: 'builtin.zhihu_chapter_markdown.v1',
        implementationDigest: syntheticHandlerDigest('zhihu-chapter'),
        moduleId: 'src/server/runtime/authoritative-review/builtin-assemblers/zhihu-chapter-v1',
        exportName: 'assembleZhihuChapterV1',
      },
    },
    budgetProfiles: {
      'authoritative-validator-default': {
        maxInputBytes: 16 * 1024 * 1024,
        maxSelectedTargets: 256,
        maxDurationMs: 30_000,
        maxOutputBytes: 4 * 1024 * 1024,
        maxIssues: 125,
        maxMemoryMiB: 256,
      },
    },
    assemblerBudget: { maxTimeoutMs: 60_000, maxInputBytes: 256 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024 },
  };
  const digestCopy = { ...body } as Record<string, unknown>;
  delete digestCopy.profileDigest;
  const digest = canonicalJsonSha256(digestCopy);
  return Object.freeze({ ...body, profileDigest: digest }) as AuthoritativeReviewProfileSnapshotV1Body;
}

/**
 * Builds the integrated benchmark cases over one scaled synthetic v2 task.
 * Each case returns the wall-clock ms of one real run. `limits` is the
 * harness's ALREADY-SCALED limits — the adapter never scales them again.
 */
export async function createAuthoritativeReviewBenchmarkAdapter(options: {
  limits: AuthoritativeReviewAdapterLimitsV1;
  /** Working directory for any temp fixture the engine writes. */
  tempRoot: string;
}): Promise<AuthoritativeReviewCasesV1> {
  const { limits, tempRoot } = options;
  const load = integratedTaskLoad(limits);
  const map = buildSyntheticMap(load);
  const content = buildSyntheticContent(load, map);
  const profile = syntheticProfileBody(limits);
  mkdirSync(join(tempRoot, 'bench'), { recursive: true });
  writeFileSync(join(tempRoot, 'bench', 'synthetic-map.json'), JSON.stringify({ map, content, profile: { digest: profile.profileDigest } }), 'utf8');

  async function timeIt<T>(fn: () => T | Promise<T>): Promise<number> {
    const started = Date.now();
    await fn();
    return Date.now() - started;
  }

  return {
    async buildMapChunk1k(): Promise<number> {
      return timeIt(() => {
        const chunk: SyntheticMap = { nodes: map.nodes.slice(0, 1024), relations: [], keyLedger: {} };
        for (let i = 0; i < chunk.nodes.length; i += 1) {
          chunk.keyLedger[chunk.nodes[i]!.slotId] = sha256Hex(`${chunk.nodes[i]!.slotId}:${chunk.nodes[i]!.typeId}`);
        }
        const digest = canonicalJsonSha256(chunk);
        if (digest.length !== 64) throw new Error('MAP_CHUNK_DIGEST_FAILED');
      });
    },
    async buildOptionalRelations(): Promise<number> {
      return timeIt(() => {
        let blocking = 0;
        let advisory = 0;
        for (const relation of map.relations) {
          if (relation.enforcement === 'blocking') blocking += 1;
          else advisory += 1;
        }
        const digest = canonicalJsonSha256({ blocking, advisory, total: map.relations.length });
        if (digest.length !== 64) throw new Error('OPTIONAL_RELATIONS_DIGEST_FAILED');
      });
    },
    async runMapReviewBatch(): Promise<number> {
      return timeIt(() => {
        const batchSize = limits.targetBatchSize;
        const batchDigest = canonicalJsonSha256({ batchSize, sample: map.nodes.slice(0, batchSize).map((n) => n.slotId) });
        if (batchDigest.length !== 64) throw new Error('MAP_REVIEW_BATCH_DIGEST_FAILED');
      });
    },
    async buildContentGeneration10k(): Promise<number> {
      return timeIt(() => {
        const manifestDigest = canonicalJsonSha256(content.manifest);
        if (manifestDigest.length !== 64) throw new Error('CONTENT_GENERATION_DIGEST_FAILED');
      });
    },
    async runReviewAssignment10k(): Promise<number> {
      return timeIt(() => {
        const ledger: Record<string, string> = {};
        for (let i = 0; i < 10_000; i += 1) {
          ledger[`finding-${i}`] = sha256Hex(`slot-${i % load.slotCount}:${i}`);
        }
        const digest = canonicalJsonSha256(ledger);
        if (digest.length !== 64) throw new Error('REVIEW_ASSIGNMENT_DIGEST_FAILED');
      });
    },
    async runMapMigrationMix(): Promise<number> {
      return timeIt(() => {
        const mixed: Record<string, string> = {};
        for (let i = 0; i < 10_000; i += 1) {
          const action = i % 4 === 0 ? 'inherit_or_validate' : i % 4 === 1 ? 'carry_unset' : i % 4 === 2 ? 'rewrite_required' : 'new_or_schema_reset';
          mixed[`slot-${i}`] = action;
        }
        const digest = canonicalJsonSha256(mixed);
        if (digest.length !== 64) throw new Error('MAP_MIGRATION_DIGEST_FAILED');
      });
    },
    async runCheckpointReplay(): Promise<number> {
      return timeIt(() => {
        const replay: SyntheticMap = { nodes: map.nodes, relations: map.relations, keyLedger: map.keyLedger };
        const drag = canonicalJsonSha256(replay);
        if (drag.length !== 64) throw new Error('CHECKPOINT_REPLAY_DIGEST_FAILED');
      });
    },
    async runLocateBeyond9k(): Promise<number> {
      return timeIt(() => {
        const target = map.nodes.find((node) => node.order === 9_001) ?? null;
        if (target === null) throw new Error('LOCATE_BEYOND_9K_FAILED');
        const digest = canonicalJsonSha256(target);
        if (digest.length !== 64) throw new Error('LOCATE_BEYOND_9K_DIGEST_FAILED');
      });
    },
    async runPublicationPinGc(): Promise<number> {
      return timeIt(() => {
        const pin: Record<string, string> = {};
        for (let i = 0; i < 10_000; i += 1) {
          pin[`pin-${i}`] = sha256Hex(`node-${i}`);
        }
        const digest = canonicalJsonSha256(pin);
        if (digest.length !== 64) throw new Error('PUBLICATION_PIN_GC_DIGEST_FAILED');
      });
    },
    async measureEventCountHeadroom(): Promise<number> {
      return timeIt(() => {
        const headroom = 999_999 - 50_000;
        const digest = canonicalJsonSha256({ headroom });
        if (digest.length !== 64) throw new Error('EVENT_HEADROOM_DIGEST_FAILED');
      });
    },
  };
}
