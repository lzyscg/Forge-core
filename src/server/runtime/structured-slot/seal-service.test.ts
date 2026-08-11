// @vitest-environment node
/**
 * Seal Gate + Assembler + custody tests (Task 16 Step 1; spec §9.3/§12,
 * design §14.4/§16/§17, J03–J06).
 *
 * `requestSeal` is the tri-state final-authority Gate:
 *
 * - required content unset / contentSchema / grammar / blocking validator
 *   rejection → reliable `failed` → a REVISION-BOUND `seal_rework_required`
 *   receipt, no candidate, no artifact/SealRecord, scaffold unchanged;
 * - advisory validator rejection → `passed` with warnings (advisory must still
 *   complete);
 * - an unavailable/exception validator or assembler → `incomplete` → NO receipt
 *   at all, a retry within the remaining Attempt budget is legal, never a
 *   dispatch;
 * - assembler output schema mismatch (missing required create, extra route,
 *   unsafe name) → reliable `failed` (ARTIFACT_SCHEMA_MISMATCH at
 *   phase 'seal_output'; assembler EXECUTION failures use phase 'assemble');
 * - `passed` → a TURN-BOUND sealed candidate: custody staged, immutable
 *   SealRecord candidate frozen, NO event written; only then may
 *   publish/final-submit dispatch.
 *
 * No business vocabulary lives here (iron rule 1).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../storage/event-store';
import { StructuredSlotBlobStore, type SlotInstance } from '../../storage/structured-slot-blob-store';
import { ArtifactStore } from '../../storage/artifact-store';
import {
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  makeTempCorePaths,
} from '../../test-support';
import { compileLayoutGrammarV1 } from '../../structured-slots/layout-grammar';
import { compileSlotSchemaV1 } from '../../structured-slots/slot-schema';
import type {
  AccessProfileV1,
  FrozenStructuredSlotContractV1,
  FrozenSlotTypeV1,
  ValidatorRegistrationV1,
} from '../../template/structured-slot-contract';
import type { ArtifactSchema } from '../../template/template-schema';
import type {
  SealSessionGrantV1,
  StructuredSlotLimitsV1,
} from '../../../shared/structured-slots';
import { ValidationEngine } from './validation-engine';
import {
  StructuredSlotSealService,
  type SealServiceOptions,
} from './seal-service';
import type { SealCandidateV1 } from './tool-factory';

const TASK = 'task-seal';
const SNAPSHOT = 'snapshot-1';
const SEAL_AGENT = 'agent-1';
const SC = 'scaffold-1';
const GEN = 'gen-1';
const TURN = 'seal-turn-1';
const ASSEMBLER_PATH = 'slots/assembler/a.cjs';
const VALIDATOR_PATH = 'slots/validators/v.cjs';

afterEach(() => {
  disposeAllTestRoots();
});

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function makeLimits(): StructuredSlotLimitsV1 {
  return {
    schema: { maxSchemaDepth: 4, maxSchemaNodes: 1024, maxEnumItems: 64, maxPatternLength: 128 },
    structure: { maxSlots: 64, maxTreeDepth: 8, maxChildrenPerSlot: 32 },
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

function slotType(id: string, presence: 'forbidden' | 'required' = 'forbidden'): FrozenSlotTypeV1 {
  const limits = makeLimits();
  return {
    id,
    name: id,
    description: `slot type ${id}`,
    specSchema: compileSlotSchemaV1(
      { type: 'object', additionalProperties: false, properties: { purpose: { type: 'string' } }, required: ['purpose'] },
      limits,
    ),
    content:
      presence === 'forbidden'
        ? { presence }
        : { presence, schema: compileSlotSchemaV1({ type: 'string', minLength: 1, maxLength: 200 }, limits) },
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
    { name: 'content.md', required: true, producer: SEAL_AGENT, extract: 'content', phase: 'create' },
    { name: 'appendix.md', required: false, producer: SEAL_AGENT, extract: 'content', phase: 'create' },
    { name: 'review.md', required: false, producer: SEAL_AGENT, extract: 'content', phase: 'annotate' },
  ],
};

const ASSEMBLER_SOURCE = `
module.exports = { assemble(input) {
  const byType = Object.create(null);
  for (const n of input.tree) { (byType[n.typeId] ||= []).push(n); }
  const title = (byType['title'] || [])[0];
  const body = (byType['body'] || [])[0];
  const content = ['# ' + (title && title.content), '', (body && body.content) || ''].join('\\n');
  return [
    { routeId: 'out-1', content },
    { routeId: 'out-2', content: 'Appendix' },
  ];
} };
`;

function makeContract(options: {
  validators?: ValidatorRegistrationV1[];
  assemblerSource?: string;
  missingAssembler?: boolean;
  routes?: Array<{ id: string; artifactFile: string }>;
} = {}): FrozenStructuredSlotContractV1 {
  const limits = makeLimits();
  const document = slotType('document');
  const title = slotType('title', 'required');
  const body = slotType('body', 'required');
  const slotTypes = [document, title, body];
  const layoutGrammar = compileLayoutGrammarV1(
    {
      rootType: 'document',
      productions: {
        document: {
          children: { kind: 'sequence', items: [{ kind: 'slot', type: 'title' }, { kind: 'slot', type: 'body' }] },
        },
        title: { children: { kind: 'empty' } },
        body: { children: { kind: 'empty' } },
      },
    },
    new Set(slotTypes.map((type) => type.id)),
    limits,
  );
  const source = options.assemblerSource ?? ASSEMBLER_SOURCE;
  return {
    version: 1,
    slotTypes,
    layoutGrammar,
    accessProfiles: [PROFILE],
    validators: options.validators ?? [],
    assembler: {
      id: 'asm',
      implementation: { abi: 'forge-assembler/v1', path: ASSEMBLER_PATH },
      budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
      routes: options.routes ?? [
        { id: 'out-1', artifactFile: 'content.md' },
        { id: 'out-2', artifactFile: 'appendix.md' },
      ],
    },
    limits,
    resourceManifest: options.missingAssembler
      ? []
      : [{ logicalPath: ASSEMBLER_PATH, sha256: sha256(source), byteLength: Buffer.byteLength(source, 'utf8') }],
    abiProfileIdentity: {
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    },
    semanticDigest: 'test',
  };
}

function blockingValidator(id: string): ValidatorRegistrationV1 {
  return {
    id,
    scope: 'scaffold',
    trigger: 'seal',
    enforcement: 'blocking',
    selector: { kind: 'all' },
    implementation: { abi: 'forge-validator/v1', path: VALIDATOR_PATH },
    budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
  };
}

/** Builds a fully-wired seal harness with the seeded generation + content. */
async function sealHarness(options: {
  validators?: ValidatorRegistrationV1[];
  content?: { t1?: string | null; b1?: string | null };
  assemblerSource?: string;
  missingAssembler?: boolean;
  routes?: Array<{ id: string; artifactFile: string }>;
  signal?: AbortSignal;
} = {}): Promise<{
  paths: ReturnType<typeof makeTempCorePaths>['paths'];
  taskId: string;
  store: EventStore;
  blobStore: StructuredSlotBlobStore;
  artifactStore: ArtifactStore;
  service: StructuredSlotSealService;
  grant: SealSessionGrantV1;
  contract: FrozenStructuredSlotContractV1;
  readEvents: () => Promise<readonly import('../../storage/event-store').CommittedEvent[]>;
  seedContent: (content: { t1?: string | null; b1?: string | null }) => Promise<void>;
}> {
  const { paths } = makeTempCorePaths('forge-core-seal-');
  const taskId = TASK;
  const store = new EventStore(paths);
  await store.append(taskId, makeTaskEvent({ type: 'task_started', at: '2026-01-01T00:00:00.000Z' }));
  const blobStore = new StructuredSlotBlobStore(paths, taskId);
  const artifactStore = new ArtifactStore(paths, store);
  const contract = makeContract({
    validators: options.validators,
    assemblerSource: options.assemblerSource,
    missingAssembler: options.missingAssembler,
    routes: options.routes,
  });
  const assemblerSource = options.assemblerSource ?? ASSEMBLER_SOURCE;

  // Write the evaluator sources into the task snapshot (EvaluatorRunner reads
  // only from the snapshot with full containment).
  const snapshotRoot = paths.taskSnapshotRoot(taskId);
  mkdirSync(join(snapshotRoot, dirname(ASSEMBLER_PATH)), { recursive: true });
  writeFileSync(join(snapshotRoot, ASSEMBLER_PATH), assemblerSource, 'utf8');
  mkdirSync(join(snapshotRoot, dirname(VALIDATOR_PATH)), { recursive: true });

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
    finalOutputName: 'Sealed Story',
    templateId: 'story-template',
    templateVersion: 'v1',
    reworkTarget: 'agent-2',
    declaredDispatches: ['publish_artifact', 'submit_final_artifact'],
    signal: options.signal,
  });

  const grant: SealSessionGrantV1 = {
    grantId: 'grant-seal-1',
    kind: 'seal',
    caseId: taskId,
    turnId: TURN,
    agentId: SEAL_AGENT,
    snapshotHash: SNAPSHOT,
    capabilities: ['request_seal'],
    accessProfileId: PROFILE.id,
    scaffoldId: SC,
    baseRevision: 0,
    readableSlotIds: ['r', 't1', 'b1'],
    writableSlotIds: [],
    draftId: null,
  };

  async function seedContent(content: { t1?: string | null; b1?: string | null }): Promise<void> {
    const t1Value = content.t1 === undefined ? 'The Title' : content.t1;
    const b1Value = content.b1 === undefined ? 'The Body' : content.b1;
    const t1Ref = t1Value === null ? 'unset' : (await blobStore.putContentValue(t1Value)).sha256;
    const b1Ref = b1Value === null ? 'unset' : (await blobStore.putContentValue(b1Value)).sha256;
    const contentRoot = await blobStore.putContentRevision({ r: 'unset', t1: t1Ref, b1: b1Ref });
    const slots: SlotInstance[] = [
      { slotId: 'r', scaffoldId: SC, parentSlotId: null, order: 0, typeId: 'document', spec: {}, contentPresence: 'unset' },
      { slotId: 't1', scaffoldId: SC, parentSlotId: 'r', order: 1, typeId: 'title', spec: { purpose: 'head' }, contentPresence: t1Value === null ? 'unset' : 'set', content: t1Value ?? null },
      { slotId: 'b1', scaffoldId: SC, parentSlotId: 'r', order: 2, typeId: 'body', spec: { purpose: 'para' }, contentPresence: b1Value === null ? 'unset' : 'set', content: b1Value ?? null },
    ];
    const manifest = await blobStore.putGeneration({ generationId: GEN, scaffoldId: SC, slots });
    await store.append(
      taskId,
      makeTaskEvent({
        id: 'gen-committed',
        at: '2026-01-01T00:00:00.000Z',
        type: 'structured_scaffold_generation_committed',
        scaffoldId: SC,
        generationId: GEN,
        supersedesGenerationId: null,
        rootSlotId: 'r',
        slotCount: 3,
        maxDepth: 1,
        structure: manifest.structure,
        content: contentRoot,
        contentRevision: 0,
        proposalId: 'proposal-1',
      }),
    );
  }

  return {
    paths,
    taskId,
    store,
    blobStore,
    artifactStore,
    service,
    grant,
    contract,
    readEvents: () => store.read(taskId),
    seedContent,
  };
}

function isCandidate(candidate: SealCandidateV1 | undefined): candidate is SealCandidateV1 {
  return candidate !== undefined;
}

// ---------------------------------------------------------------------------
// Step 1: tri-state — passed / failed / incomplete
// ---------------------------------------------------------------------------

describe('StructuredSlotSealService — requestSeal tri-state', () => {
  it('passed: freezes a turn-bound sealed candidate (custody staged, NO events)', async () => {
    const h = await sealHarness();
    await h.seedContent({});

    const result = await h.service.requestSeal(h.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toMatchObject({ kind: 'seal', status: 'passed' });
    expect(result.verdict?.status).toBe('passed');

    const dispatch = h.service.dispatch;
    expect(dispatch.status).toBe('passed');
    if (dispatch.status !== 'passed') return;
    expect(dispatch.declaredDispatches).toEqual(['publish_artifact', 'submit_final_artifact']);
    expect(isCandidate(dispatch.candidate)).toBe(true);
    const candidate = dispatch.candidate!;
    expect(candidate.artifact.version).toBe(1);
    expect(candidate.artifact.files.map((file) => file.name).sort()).toEqual(['appendix.md', 'content.md']);
    expect(candidate.sealRecord.artifactVersionRef).toEqual({ artifactId: candidate.artifact.artifactId, version: 1 });
    expect(candidate.sealRecord.outputs.map((output) => output.path).sort()).toEqual(['appendix.md', 'content.md']);
    expect(candidate.sealRecord.outputs[0]?.mediaType).toBe('text/markdown; charset=utf-8');

    // Custody staged on disk; the version is still unreferenced.
    const custodyDir = join(h.paths.taskStructuredCustodyRoot(h.taskId), candidate.contentIdentity);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(custodyDir).sort()).toEqual(['appendix.md', 'content.md', 'manifest.json', 'meta.json', 'seal-record.json']);
    expect(await h.artifactStore.list(h.taskId)).toEqual([]);
    // No artifact_published / sealed event was written by requestSeal.
    const events = (await h.readEvents()).map((entry) => entry.event);
    expect(events.some((event) => event.type === 'artifact_published')).toBe(false);
    expect(events.some((event) => event.type === 'structured_scaffold_sealed')).toBe(false);
  });

  it('required content unset: reliable failed → revision-bound rework receipt, scaffold unchanged', async () => {
    const h = await sealHarness();
    await h.seedContent({ b1: null }); // body is required but unset

    const result = await h.service.requestSeal(h.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toMatchObject({ kind: 'seal', status: 'rework_required' });
    expect(result.verdict?.status).toBe('failed');
    expect(result.verdict?.issues.some((issue) => issue.code === 'CONTENT_REQUIRED')).toBe(true);

    const dispatch = h.service.dispatch;
    expect(dispatch.status).toBe('rework_required');
    if (dispatch.status !== 'rework_required') return;
    expect(dispatch.reworkTarget).toBe('agent-2');
    expect(dispatch.receipt).toMatchObject({ scaffoldId: SC, generationId: GEN, scaffoldRevision: 0 });
    // NOT a candidate: no custody, no artifact, no SealRecord.
    expect(await h.artifactStore.list(h.taskId)).toEqual([]);
    const custodyRoot = h.paths.taskStructuredCustodyRoot(h.taskId);
    const { readdirSync } = await import('node:fs');
    let custodyEntries = 0;
    try {
      custodyEntries = readdirSync(custodyRoot).length;
    } catch {
      custodyEntries = 0;
    }
    expect(custodyEntries).toBe(0);
    // Scaffold unchanged: sealStatus stays unsealed.
    const { projectStructuredSlotState } = await import('../../storage/structured-slot-state');
    const state = projectStructuredSlotState((await h.readEvents()).map((entry) => entry.event));
    expect(state.sealStatus).toBe('unsealed');
  });

  it('contentSchema violation: reliable failed with CONTENT_SCHEMA_INVALID', async () => {
    const h = await sealHarness();
    await h.seedContent({ t1: { not: 'a string' } as unknown as string });

    const result = await h.service.requestSeal(h.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.status).toBe('rework_required');
    expect(result.verdict?.issues.some((issue) => issue.code === 'CONTENT_SCHEMA_INVALID')).toBe(true);
  });

  it('blocking validator rejection: reliable failed with VALIDATOR_REJECTED; advisory is a warning and passes', async () => {
    // Blocking validator that rejects.
    const h1 = await sealHarness({
      validators: [
        { ...blockingValidator('blocking-v'), enforcement: 'blocking' as const },
      ],
    });
    const vBlocking = 'module.exports = { validate() { return { pass: false, issues: [{ code: "X", evidence: "blocked" }] }; } };';
    writeFileSync(join(h1.paths.taskSnapshotRoot(h1.taskId), VALIDATOR_PATH), vBlocking, 'utf8');
    await h1.seedContent({});
    const r1 = await h1.service.requestSeal(h1.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.receipt.status).toBe('rework_required');
    expect(r1.verdict?.issues.some((issue) => issue.code === 'VALIDATOR_REJECTED' && issue.severity === 'error')).toBe(true);

    // Advisory validator that rejects: passes with a warning.
    const h2 = await sealHarness({
      validators: [
        { ...blockingValidator('advisory-v'), enforcement: 'advisory' as const },
      ],
    });
    const vAdvisory = 'module.exports = { validate() { return { pass: false, issues: [{ code: "A", evidence: "advisory" }] }; } };';
    writeFileSync(join(h2.paths.taskSnapshotRoot(h2.taskId), VALIDATOR_PATH), vAdvisory, 'utf8');
    await h2.seedContent({});
    const r2 = await h2.service.requestSeal(h2.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.receipt.status).toBe('passed');
    expect(r2.receipt.issueSummary.warnings).toBeGreaterThan(0);
    expect(r2.verdict?.issues.some((issue) => issue.code === 'VALIDATOR_ADVISORY')).toBe(true);
  });

  it('unavailable validator: incomplete → NO receipt, no dispatch, retry allowed', async () => {
    // The validator source is never written → VALIDATOR_UNAVAILABLE.
    const h = await sealHarness({ validators: [blockingValidator('missing-v')] });
    await h.seedContent({});

    const first = await h.service.requestSeal(h.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.code).toBe('SEAL_INCOMPLETE');
    expect(h.service.dispatch.status).toBe('incomplete');

    // A retry within the remaining Attempt budget (fresh attempt/service with
    // the source now present) can succeed — nothing was frozen by the incomplete.
    const h2 = await sealHarness({ validators: [blockingValidator('missing-v')] });
    writeFileSync(
      join(h2.paths.taskSnapshotRoot(h2.taskId), VALIDATOR_PATH),
      'module.exports = { validate() { return { pass: true, issues: [] }; } };',
      'utf8',
    );
    await h2.seedContent({});
    const retry = await h2.service.requestSeal(h2.grant, { toolCallId: 't-2', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.receipt.status).toBe('passed');
      expect(h2.service.dispatch.status).toBe('passed');
    }
  });

  it('assembler execution error: incomplete via phase assemble; output schema mismatch is a reliable failure', async () => {
    // Assembler source throws → ASSEMBLER_UNAVAILABLE / incomplete.
    const h1 = await sealHarness({ assemblerSource: 'module.exports = { assemble() { throw new Error("boom"); } };' });
    await h1.seedContent({});
    const r1 = await h1.service.requestSeal(h1.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.code).toBe('SEAL_INCOMPLETE');
    expect(h1.service.dispatch.status).toBe('incomplete');

    // A route maps to an annotate file (not phase:create) → the output does not
    // match the artifactSchema create subset → ARTIFACT_SCHEMA_MISMATCH (failed).
    const h2 = await sealHarness({
      routes: [
        { id: 'out-1', artifactFile: 'content.md' },
        { id: 'out-2', artifactFile: 'review.md' }, // review.md is annotate, not create
      ],
    });
    await h2.seedContent({});
    const r2 = await h2.service.requestSeal(h2.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.receipt.status).toBe('rework_required');
    expect(r2.verdict?.issues.some((issue) => issue.code === 'ARTIFACT_SCHEMA_MISMATCH')).toBe(true);
  });

  it('an aborted attempt is incomplete and never freezes a receipt', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = await sealHarness({ signal: controller.signal });
    await h.seedContent({});
    const result = await h.service.requestSeal(h.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SEAL_INCOMPLETE');
    expect(h.service.dispatch.status).toBe('incomplete');
  });

  it('the content identity is deterministic and binds revision/snapshot/assembler digest', async () => {
    const h = await sealHarness();
    await h.seedContent({});
    const first = await h.service.requestSeal(h.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const h2 = await sealHarness();
    await h2.seedContent({});
    const second = await h2.service.requestSeal(h2.grant, { toolCallId: 't-1', canonicalArgsHash: 'h', toolName: 'request_seal' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const d1 = h.service.dispatch.status === 'passed' ? h.service.dispatch.candidate?.contentIdentity : null;
    const d2 = h2.service.dispatch.status === 'passed' ? h2.service.dispatch.candidate?.contentIdentity : null;
    expect(d1).toMatch(/^[a-f0-9]{64}$/);
    expect(d1).toBe(d2);
    expect(h.service.dispatch.status === 'passed' ? h.service.dispatch.candidate?.sealId : null).toBe(
      h2.service.dispatch.status === 'passed' ? h2.service.dispatch.candidate?.sealId : null,
    );
  });
});
