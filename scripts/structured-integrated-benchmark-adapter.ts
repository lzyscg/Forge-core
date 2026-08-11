#!/usr/bin/env node
/**
 * Integrated structured-slot benchmark adapter (Task 19 Step 6, design §25.13
 * O08). Exercises the REAL Task 10 authorized/owner issue projection and Task
 * 16 Seal/Assembler/custody/batch-recovery paths — no stubs. The benchmark
 * script (`benchmark-structured-slots.ts --mode integrated-qualify`) builds a
 * scaled real task and drives these cases through the SAME modules the
 * production runtime uses.
 *
 * The adapter receives the ALREADY-SCALED limits from the benchmark harness and
 * applies exactly ONE scaling boundary: the built scaffold uses
 * `limits.structure.maxSlots` filled slots and a content root of
 * `limits.payload.maxScaffoldPayloadBytes` bytes directly (never multiplied by
 * a scale factor again — the harness scales the candidate axes and the adapter
 * consumes those scaled limits verbatim). The benchmark tries
 * 100%/75%/50%/25% per candidate axis and freezes the greatest passing value.
 * It creates NO release evidence on its own and writes nothing outside the
 * benchmark's temp roots.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { StructuredSlotLimitsV1 } from '../src/shared/structured-slots';
import type { FrozenStructuredSlotContractV1 } from '../src/server/template/structured-slot-contract';
import { CorePaths } from '../src/server/storage/core-paths';
import { EventStore } from '../src/server/storage/event-store';
import { ArtifactStore } from '../src/server/storage/artifact-store';
import {
  StructuredSlotBlobStore,
  type StructuredSlotBlobStoreInstrumentation,
} from '../src/server/storage/structured-slot-blob-store';
import { compileSlotSchemaV1 } from '../src/server/structured-slots/slot-schema';
import { compileLayoutGrammarV1 } from '../src/server/structured-slots/layout-grammar';
import { projectStructuredVerdict, makeStructuredIssue, ALL_LOCATION_KINDS } from '../src/server/structured-slots/issues';
import type { StructuredVerdictV1 } from '../src/shared/structured-slots';
import { StructuredSlotSealService } from '../src/server/runtime/structured-slot/seal-service';
import { ValidationEngine } from '../src/server/runtime/structured-slot/validation-engine';
import {
  StructuredSlotProjectionService,
  createTaskLocalCursorSigner,
} from '../src/server/runtime/structured-slot/projection-service';
import { createStructuredSlotDataSource } from '../src/server/runtime/structured-slot/session-service';
import type { CommittedEvent } from '../src/server/storage/event-store';
import type { TaskEvent } from '../src/server/storage/task-events';

export interface IntegratedBenchmarkCasesV1 {
  /**
   * PURE 500-issue authorized verdict projection (Task 10 F06): builds the
   * 500-issue `StructuredVerdictV1` and calls `projectStructuredVerdict` with
   * full visibility. NO projection-service build and NO listSlots/readSlot I/O
   * in this method — this is exactly the operation the 250 ms
   * `issueProjectionMaxMs` bound gates. (The projection-service outline is
   * measured separately by `runOwnerOutlineCold`/`runOwnerOutlineHot`.)
   */
  runAuthorizedProjection500Issues(): Promise<number>;
  /** 64 MiB real Seal/Assembler/custody (Task 16). */
  runSealAssemblerCustody64MiB(): Promise<number>;
  /** Batch recovery (Task 16). */
  runBatchRecovery(): Promise<number>;
  /** ONE indexed slot read through the real projection (p95 bound). */
  runIndexedSlotRead(): Promise<number>;
  /**
   * FIRST `task_owner` outline read over the real task (diagnostic): projection
   * build + generation-index read + presence-root read + per-slot NDJSON reads.
   */
  runOwnerOutlineCold(): Promise<number>;
  /** SUBSEQUENT `task_owner` outline over the same task (diagnostic, warm). */
  runOwnerOutlineHot(): Promise<number>;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const BENCH_ASSEMBLER_SOURCE =
  "module.exports = { assemble(input) { return [{ routeId: 'doc', content: '# bench\\n' }]; } };";

/** The benchmark artifact schema (one phase:create file, produced by the assembler). */
const BENCH_ARTIFACT_SCHEMA = {
  files: [{ name: 'document.md', required: true, producer: 'seal', extract: 'content', phase: 'create' }],
};

interface BenchTask {
  paths: CorePaths;
  taskId: string;
  contract: FrozenStructuredSlotContractV1;
  slots: Array<{ slotId: string; parentSlotId: string | null; order: number; typeId: string; spec: Record<string, unknown>; contentPresence: 'unset' | 'set'; content: unknown }>;
  contentRootBytes: number;
}

/**
 * The exact load the built bench task must carry for one scaled limits object.
 * Single scaling boundary: the scaffold holds `limits.structure.maxSlots`
 * filled slots and a `limits.payload.maxScaffoldPayloadBytes` content root —
 * never a further scale factor (the harness already scaled the candidate axes).
 */
export function integratedTaskLoad(limits: StructuredSlotLimitsV1): { slotCount: number; contentBytes: number } {
  return {
    slotCount: Math.max(2, limits.structure.maxSlots),
    contentBytes: Math.max(1024, limits.payload.maxScaffoldPayloadBytes),
  };
}

/**
 * Builds one scaled real task with a committed scaffold + content root. The
 * validator is scaffold-scoped (one invocation) so the 64 MiB seal case
 * measures the content-root processing / Assembler / custody work — the
 * per-slot validator fanout is deliberately budgeted OUT of that bound
 * (spec §16.3) and measured separately by the primitive fanout case.
 *
 * The scaffold is a deliberately shallow stress fixture: every filled slot is a
 * direct child of the root, so the layout grammar's `document` children ceiling
 * must reach `maxSlots` for the tree to seal. The bench contract raises
 * `maxChildrenPerSlot` to `max(maxSlots, maxChildrenPerSlot)` solely so the
 * depth-1 scaffold is internally legal; the evidence `frozenLimits` still
 * records the harness's scaled candidate limits, not this internal fixture
 * ceiling.
 */
export async function buildBenchTask(
  paths: CorePaths,
  taskId: string,
  limits: StructuredSlotLimitsV1,
  instrumentation?: StructuredSlotBlobStoreInstrumentation,
): Promise<BenchTask> {
  mkdirSync(paths.taskRoot(taskId), { recursive: true });
  const blobStore = new StructuredSlotBlobStore(paths, taskId, instrumentation);

  const { slotCount, contentBytes } = integratedTaskLoad(limits);
  const contractLimits: StructuredSlotLimitsV1 = {
    ...limits,
    structure: {
      ...limits.structure,
      maxChildrenPerSlot: Math.max(limits.structure.maxSlots, limits.structure.maxChildrenPerSlot),
    },
  };

  const slotType = {
    id: 'node',
    name: 'Node',
    description: 'benchmark node',
    specSchema: compileSlotSchemaV1({ type: 'object', additionalProperties: false }, limits),
    content: {
      presence: 'required' as const,
      schema: compileSlotSchemaV1({ type: 'string', minLength: 1, maxLength: contentBytes }, limits),
    },
  };
  const assembler = {
    id: 'bench-assembler',
    implementation: { abi: 'forge-assembler/v1' as const, path: 'slots/assembler/bench.cjs' },
    budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 512 },
    routes: [{ id: 'doc', artifactFile: 'document.md' }],
  };
  const compiledGrammar = compileLayoutGrammarV1(
    {
      rootType: 'document',
      productions: {
        document: {
          children: {
            kind: 'repeat',
            min: 1,
            max: contractLimits.structure.maxChildrenPerSlot,
            item: { kind: 'slot', type: 'node' },
          },
        },
        node: { children: { kind: 'empty' } },
      },
    },
    new Set(['document', 'node']),
    contractLimits,
  );
  const contract: FrozenStructuredSlotContractV1 = {
    version: 1,
    slotTypes: [slotType],
    layoutGrammar: compiledGrammar,
    accessProfiles: [],
    // The validator fanout is deliberately budgeted OUT of the 64 MiB seal
    // bound (spec §16.3) and measured separately by the primitive fanout case:
    // a validator envelope over the full 64 MiB content root would dominate
    // the sandbox budget. The seal case measures the content-root processing,
    // Assembler and custody.
    validators: [],
    assembler,
    limits: contractLimits,
    resourceManifest: [
      { logicalPath: 'slots/assembler/bench.cjs', sha256: sha256Hex(BENCH_ASSEMBLER_SOURCE) },
    ],
    abiProfileIdentity: {
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    },
    semanticDigest: '0'.repeat(64),
  };

  // Root + `slotCount` children, each carrying a slice of the content root.
  const slots: BenchTask['slots'] = [];
  const sliceBytes = Math.max(64, Math.floor(contentBytes / slotCount));
  slots.push({
    slotId: 'root',
    parentSlotId: null,
    order: 0,
    typeId: 'document',
    spec: {},
    contentPresence: 'unset',
    content: null,
  });
  for (let i = 0; i < slotCount; i += 1) {
    slots.push({
      slotId: `n${i}`,
      parentSlotId: 'root',
      order: i + 1,
      typeId: 'node',
      spec: {},
      contentPresence: 'set',
      content: `c${i}:` + 'x'.repeat(sliceBytes),
    });
  }

  const generationManifest = await blobStore.putGeneration({
    generationId: 'gen-1',
    scaffoldId: 'scaffold-1',
    slots: slots.map((slot) => ({
      slotId: slot.slotId,
      scaffoldId: 'scaffold-1',
      parentSlotId: slot.parentSlotId,
      order: slot.order,
      typeId: slot.typeId,
      spec: slot.spec,
      contentPresence: 'unset',
    })),
  });
  // Store each set content value as a content-addressed blob, then build the
  // revision root mapping slotId -> 'unset' | contentBlobDigest.
  const mappings: Record<string, 'unset' | string> = {};
  for (const slot of slots) {
    if (slot.contentPresence === 'set') {
      const blob = await blobStore.putContentValue(slot.content);
      mappings[slot.slotId] = blob.sha256;
    } else {
      mappings[slot.slotId] = 'unset';
    }
  }
  const contentRef = await blobStore.putContentRevision(mappings);
  const events = new EventStore(paths);
  await events.append(taskId, {
    id: 'gen-committed',
    at: new Date().toISOString(),
    type: 'structured_scaffold_generation_committed',
    scaffoldId: 'scaffold-1',
    generationId: 'gen-1',
    supersedesGenerationId: null,
    rootSlotId: 'root',
    slotCount: slots.length,
    maxDepth: 1,
    structure: generationManifest.structure,
    content: contentRef,
    contentRevision: 0,
    proposalId: 'p-1',
  });

  // Write the assembler source into the task snapshot so the real EvaluatorRunner
  // can load it (it resolves from the task snapshot root).
  const snapshotDir = join(paths.taskSnapshotRoot(taskId), 'slots');
  mkdirSync(join(snapshotDir, 'assembler'), { recursive: true });
  writeFileSync(join(snapshotDir, 'assembler', 'bench.cjs'), BENCH_ASSEMBLER_SOURCE, 'utf8');

  return { paths, taskId, contract, slots, contentRootBytes: contentBytes };
}

/**
 * Creates the integrated benchmark cases over one scaled real task. Each case
 * returns the wall-clock ms of one real run. `limits` are the harness's
 * ALREADY-SCALED limits — the adapter never scales them again (single scaling
 * boundary).
 */
export async function createIntegratedBenchmarkAdapter(options: {
  paths: CorePaths;
  taskId: string;
  limits: StructuredSlotLimitsV1;
  /** Optional blob-store instrumentation (tests count reads/opens). */
  instrumentation?: StructuredSlotBlobStoreInstrumentation;
}): Promise<IntegratedBenchmarkCasesV1> {
  const { paths, taskId, limits, instrumentation } = options;
  const task = await buildBenchTask(paths, taskId, limits, instrumentation);
  const events = new EventStore(paths);
  const readEvents = async (): Promise<readonly CommittedEvent[]> => events.read(taskId);
  const blobStore = new StructuredSlotBlobStore(paths, taskId, instrumentation);
  let projectionService: StructuredSlotProjectionService | null = null;

  async function ownerProjection(): Promise<StructuredSlotProjectionService> {
    if (projectionService !== null) return projectionService;
    const committed = await readEvents();
    const source = createStructuredSlotDataSource({
      blobStore,
      events: async () => committed.map((entry) => entry.event),
    });
    projectionService = new StructuredSlotProjectionService({
      contract: task.contract,
      source,
      signer: createTaskLocalCursorSigner(taskId),
    });
    return projectionService;
  }

  // The outline diagnostics read the ENTIRE real outline in one page (root +
  // `maxSlots` filled children) so cold measures the full projection build,
  // generation-index read, presence-root read AND per-slot NDJSON reads.
  const outlineLimit = limits.structure.maxSlots + 1;

  /** The exact 500-issue verdict the authorized projection bound exercises. */
  function buildFiveHundredIssueVerdict(): StructuredVerdictV1 {
    const issues = Array.from({ length: 500 }, (_, i) =>
      makeStructuredIssue(
        i % 2 === 0 ? 'CONTENT_REQUIRED' : 'SLOT_NOT_VISIBLE',
        i % 2 === 0 ? 'seal_input' : 'merge',
        i % 2 === 0
          ? { kind: 'slot', slotId: `bench-${i}`, field: 'content', valuePointer: '' }
          : { kind: 'operation' },
        {},
      ),
    );
    return {
      version: 1,
      status: 'failed',
      issues,
      truncated: false,
      summary: { errors: 250, warnings: 250 },
    };
  }

  return {
    async runAuthorizedProjection500Issues(): Promise<number> {
      const started = Date.now();
      // PURE authorized verdict projection — no projection-service build, no
      // listSlots/readSlot I/O. This is exactly the operation the 250 ms
      // `issueProjectionMaxMs` bound gates (spec §16.3).
      const projected = projectStructuredVerdict(buildFiveHundredIssueVerdict(), {
        visibleLocationKinds: ALL_LOCATION_KINDS,
      });
      if (projected.issues.length !== 500) throw new Error('BENCH_ISSUE_PROJECTION_FAILED');
      return Date.now() - started;
    },

    async runOwnerOutlineCold(): Promise<number> {
      const started = Date.now();
      const projection = await ownerProjection();
      // FIRST owner outline: includes the projection build (event-state
      // projection), the generation-index read + parse, the presence-root read
      // and one NDJSON open per visible slot.
      const owner = await projection.listSlots({ kind: 'task_owner' }, null, outlineLimit);
      if (!owner.ok) throw new Error('BENCH_PROJECTION_FAILED');
      return Date.now() - started;
    },

    async runOwnerOutlineHot(): Promise<number> {
      const started = Date.now();
      const projection = await ownerProjection();
      // SUBSEQUENT outline over the SAME task: the projection service and the
      // data source are cached, the generation index and presence root are
      // already cached — only the per-slot NDJSON reads remain.
      const owner = await projection.listSlots({ kind: 'task_owner' }, null, outlineLimit);
      if (!owner.ok) throw new Error('BENCH_PROJECTION_FAILED');
      return Date.now() - started;
    },

    async runSealAssemblerCustody64MiB(): Promise<number> {
      const started = Date.now();
      const artifactStore = new ArtifactStore(paths, events);
      const sealService = new StructuredSlotSealService({
        taskId,
        snapshotHash: 'snapshot-bench',
        contract: task.contract,
        paths,
        blobStore,
        artifactStore,
        validationEngine: new ValidationEngine({ paths, taskId }),
        events: async () => (await readEvents()).map((entry) => entry.event),
        artifactSchema: BENCH_ARTIFACT_SCHEMA,
        finalOutputFormat: 'markdown',
        finalOutputName: 'output',
        templateId: 'bench-template',
        templateVersion: 'v1',
        reworkTarget: 'fill',
        declaredDispatches: ['publish_artifact'],
      });
      const grant = {
        grantId: 'grant-seal-bench',
        kind: 'seal' as const,
        caseId: taskId,
        turnId: 'bench-seal-t1',
        agentId: 'seal',
        snapshotHash: 'snapshot-bench',
        accessProfileId: 'editor',
        scaffoldId: 'scaffold-1',
        generationId: 'gen-1',
        baseRevision: 0,
        capabilities: ['request_seal'],
        readableSlotIds: task.slots.map((s) => s.slotId),
        writableSlotIds: [],
      };
      const result = await sealService.requestSeal(grant, {
        toolCallId: 'bench-seal-tc',
        canonicalArgsHash: 'bench-seal-args',
        toolName: 'request_seal',
      });
      if (!result.ok || result.receipt.status !== 'passed') {
        throw new Error(`BENCH_SEAL_FAILED: ${result.ok ? result.receipt.status : result.reason}`);
      }
      return Date.now() - started;
    },

    async runBatchRecovery(): Promise<number> {
      const started = Date.now();
      // Fixed, scale-independent batch count: there is no limits axis that
      // scales the batch-recovery journal load, so the case always replays a
      // documented 100 committed batches at every candidate scale.
      const batchCount = 100;
      const appendBatch = (
        commitId: string,
        batch: readonly TaskEvent[],
        expectedLastSequence: number,
      ) => events.appendBatch(taskId, commitId, batch, { expectedLastSequence });
      let tail = (await readEvents()).length;
      for (let i = 0; i < batchCount; i += 1) {
        const committed = await appendBatch(
          `bench-batch-${i}`,
          [
            {
              id: `bench-batch-${i}-event`,
              at: new Date().toISOString(),
              type: 'structured_slot_attempt_started',
              inputNodeId: `bench-input-${i}`,
              agentId: 'seal',
              attemptEpoch: 1,
              turnId: `bench-input-${i}-t1`,
              sessionKind: 'structure',
            },
          ],
          tail,
        );
        tail += committed.length;
        const readBack = await events.readBatchByCommitId(taskId, `bench-batch-${i}`);
        if (readBack === null || readBack.length !== 1) {
          throw new Error('BENCH_BATCH_RECOVERY_FAILED');
        }
      }
      return Date.now() - started;
    },

    async runIndexedSlotRead(): Promise<number> {
      const started = Date.now();
      const projection = await ownerProjection();
      const owner = await projection.listSlots({ kind: 'task_owner' }, null, 2);
      if (!owner.ok || owner.entries.length === 0) throw new Error('BENCH_PROJECTION_FAILED');
      const read = await projection.readSlot({ kind: 'task_owner' }, owner.entries[0]!.slotId);
      if (!read.ok) throw new Error('BENCH_PROJECTION_READ_FAILED');
      return Date.now() - started;
    },
  };
}
