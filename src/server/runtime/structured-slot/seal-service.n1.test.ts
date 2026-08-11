// @vitest-environment node
/**
 * Seal full-scaffold batch-read N+1 remediation test (Task 19 remediation
 * Task C).
 *
 * `requestSeal`'s `loadSlots` previously read `index.json` once, hydrated every
 * content blob, then re-read `index.json` + re-opened `slots.ndjson` PER SLOT
 * (O(slotCount) index parses and file opens). This test instruments the blob
 * store and asserts the seal path reads the index ONCE and opens the NDJSON
 * file ONCE, regardless of slot count — the batch read `readGenerationSlots`
 * serves the whole scaffold through one open handle.
 *
 * The generation has 100 slots. Content is all `unset`, and the registered
 * validator's source is deliberately missing, so `requestSeal` reaches
 * `loadSlots` fully and then completes as `SEAL_INCOMPLETE` without running
 * the assembler (fast, no subprocess).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../storage/event-store';
import { ArtifactStore } from '../../storage/artifact-store';
import {
  StructuredSlotBlobStore,
  type SlotInstance,
  type StructuredSlotBlobStoreInstrumentation,
} from '../../storage/structured-slot-blob-store';
import { compileLayoutGrammarV1 } from '../../structured-slots/layout-grammar';
import { compileSlotSchemaV1 } from '../../structured-slots/slot-schema';
import type {
  AccessProfileV1,
  FrozenStructuredSlotContractV1,
  FrozenSlotTypeV1,
  ValidatorRegistrationV1,
} from '../../template/structured-slot-contract';
import type { ArtifactSchema } from '../../template/template-schema';
import type { SealSessionGrantV1, StructuredSlotLimitsV1 } from '../../../shared/structured-slots';
import { disposeAllTestRoots, makeTempCorePaths } from '../../test-support';
import { ValidationEngine } from './validation-engine';
import { StructuredSlotSealService } from './seal-service';

const TASK = 'task-seal-n1';
const SNAPSHOT = 'snapshot-1';
const SLOT_COUNT = 100;
const VALIDATOR_PATH = 'slots/validators/v.cjs';

function makeLimits(): StructuredSlotLimitsV1 {
  return {
    schema: { maxSchemaDepth: 4, maxSchemaNodes: 1024, maxEnumItems: 64, maxPatternLength: 128 },
    structure: { maxSlots: 256, maxTreeDepth: 8, maxChildrenPerSlot: 256 },
    payload: { maxSpecBytesPerSlot: 4096, maxContentBytesPerSlot: 65536, maxScaffoldPayloadBytes: 65536 },
    draft: { maxChangedSlots: 32, maxDraftBytes: 65536 },
    attempt: {
      maxSlotToolCallsPerAttempt: 64,
      maxValidationRunsPerAttempt: 8,
      maxValidatorInvocationsPerAttempt: 200,
      maxAggregateValidatorCpuMsPerAttempt: 2000,
      maxAggregateValidatorWallClockMsPerAttempt: 4000,
      maxValidatorOutputBytesPerAttempt: 4096,
      maxAttemptWallClockMs: 10000,
    },
    validation: {
      maxValidators: 4,
      maxValidatorInvocationsPerGate: 10,
      maxAggregateValidatorCpuMsPerGate: 500,
      maxAggregateValidatorWallClockMsPerGate: 1000,
      maxValidatorOutputBytesPerGate: 512,
      maxIssuesPerRun: 50,
    },
    output: { maxArtifactFiles: 4, maxArtifactBytesPerFile: 1024, maxTotalArtifactBytes: 4096 },
  };
}

function slotType(id: string): FrozenSlotTypeV1 {
  const limits = makeLimits();
  return {
    id,
    name: id,
    description: `slot type ${id}`,
    specSchema: compileSlotSchemaV1(
      { type: 'object', additionalProperties: false, properties: {}, required: [] },
      limits,
    ),
    content: { presence: 'forbidden' },
  };
}

const PROFILE: AccessProfileV1 = {
  id: 'seal-profile',
  read: [{ targets: { kind: 'all' }, targetLevel: 'content', context: { level: 'outline', ancestors: 0, descendants: 0, directSiblings: false } }],
  writeContent: [],
  continuity: { precedingFilled: false },
};

const ARTIFACT_SCHEMA: ArtifactSchema = {
  files: [
    { name: 'content.md', required: true, producer: TASK, extract: 'content', phase: 'create' },
    { name: 'appendix.md', required: false, producer: TASK, extract: 'content', phase: 'create' },
  ],
};

function makeContract(): FrozenStructuredSlotContractV1 {
  const limits = makeLimits();
  const document = slotType('document');
  const node = slotType('node');
  const slotTypes = [document, node];
  const layoutGrammar = compileLayoutGrammarV1(
    {
      rootType: 'document',
      productions: {
        document: {
          children: { kind: 'repeat', min: 0, max: 256, item: { kind: 'slot', type: 'node' } },
        },
        node: { children: { kind: 'empty' } },
      },
    },
    new Set(slotTypes.map((type) => type.id)),
    limits,
  );
  const validator: ValidatorRegistrationV1 = {
    id: 'missing-v',
    scope: 'scaffold',
    trigger: 'seal',
    enforcement: 'blocking',
    selector: { kind: 'all' },
    implementation: { abi: 'forge-validator/v1', path: VALIDATOR_PATH },
    budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
  };
  return {
    version: 1,
    slotTypes,
    layoutGrammar,
    accessProfiles: [PROFILE],
    validators: [validator],
    assembler: {
      id: 'asm',
      implementation: { abi: 'forge-assembler/v1', path: 'slots/assembler/a.cjs' },
      budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
      routes: [
        { id: 'out-1', artifactFile: 'content.md' },
        { id: 'out-2', artifactFile: 'appendix.md' },
      ],
    },
    limits,
    resourceManifest: [],
    abiProfileIdentity: {
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    },
    semanticDigest: 'test',
  };
}

interface Counters {
  indexReads: number;
  slotsOpens: number;
  blobReads: number;
  contentRootReads: number;
}

describe('Seal full-scaffold batch read — O(1) index reads and file opens (Task C)', () => {
  it('requestSeal reads the index once and opens slots.ndjson once for a 100-slot generation', async () => {
    const { paths } = makeTempCorePaths('forge-core-seal-n1-');
    const taskId = TASK;
    const store = new EventStore(paths);
    const counters: Counters = { indexReads: 0, slotsOpens: 0, blobReads: 0, contentRootReads: 0 };
    const instrumentation: StructuredSlotBlobStoreInstrumentation = {
      onIndexRead: () => {
        counters.indexReads += 1;
      },
      onSlotsFileOpen: () => {
        counters.slotsOpens += 1;
      },
      onBlobRead: () => {
        counters.blobReads += 1;
      },
      onContentRootRead: () => {
        counters.contentRootReads += 1;
      },
    };
    const blobStore = new StructuredSlotBlobStore(paths, taskId, instrumentation);
    const artifactStore = new ArtifactStore(paths, store);
    const contract = makeContract();

    // Root + (SLOT_COUNT - 1) children, all content unset.
    const slots: SlotInstance[] = [
      { slotId: 'root', scaffoldId: 'scaffold-1', parentSlotId: null, order: 0, typeId: 'document', spec: {}, contentPresence: 'unset' },
    ];
    for (let i = 1; i < SLOT_COUNT; i += 1) {
      slots.push({
        slotId: `n${i}`,
        scaffoldId: 'scaffold-1',
        parentSlotId: 'root',
        order: i,
        typeId: 'node',
        spec: {},
        contentPresence: 'unset',
      });
    }
    const manifest = await blobStore.putGeneration({ generationId: 'gen-1', scaffoldId: 'scaffold-1', slots });
    const mappings: Record<string, 'unset'> = {};
    for (const slot of slots) {
      mappings[slot.slotId] = 'unset';
    }
    const contentRef = await blobStore.putContentRevision(mappings);
    await store.append(taskId, {
      id: 'gen-committed',
      at: new Date().toISOString(),
      type: 'structured_scaffold_generation_committed',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      supersedesGenerationId: null,
      rootSlotId: 'root',
      slotCount: slots.length,
      maxDepth: 1,
      structure: manifest.structure,
      content: contentRef,
      contentRevision: 0,
      proposalId: 'proposal-1',
    });

    const service = new StructuredSlotSealService({
      taskId,
      snapshotHash: SNAPSHOT,
      contract,
      paths,
      blobStore,
      artifactStore,
      validationEngine: new ValidationEngine({ paths }),
      events: async () => (await store.read(taskId)).map((entry) => entry.event),
      artifactSchema: ARTIFACT_SCHEMA,
      finalOutputFormat: 'markdown',
      finalOutputName: 'Sealed',
      templateId: 'story-template',
      templateVersion: 'v1',
      reworkTarget: 'agent-2',
      declaredDispatches: ['publish_artifact', 'submit_final_artifact'],
    });

    const grant: SealSessionGrantV1 = {
      grantId: 'grant-seal-n1',
      kind: 'seal',
      caseId: taskId,
      turnId: 'seal-turn-n1',
      agentId: 'agent-1',
      snapshotHash: SNAPSHOT,
      capabilities: ['request_seal'],
      accessProfileId: PROFILE.id,
      scaffoldId: 'scaffold-1',
      baseRevision: 0,
      readableSlotIds: [],
      writableSlotIds: [],
      draftId: null,
    };

    const result = await service.requestSeal(grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    // The missing validator makes the gate incomplete — but loadSlots already
    // ran in full before the gate, which is exactly what we are measuring.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SEAL_INCOMPLETE');

    // The whole scaffold read: index parsed once, NDJSON opened once, content
    // root read once, zero content blobs (all unset). Not O(slotCount).
    expect(counters.indexReads).toBe(1);
    expect(counters.slotsOpens).toBe(1);
    expect(counters.contentRootReads).toBe(1);
    expect(counters.blobReads).toBe(0);
  });
});

afterEach(() => {
  disposeAllTestRoots();
});
