// @vitest-environment node
/**
 * Artifact version directory store tests (plan 2026-08-07 Phase 1). The store
 * is event-authoritative: a version number is the count of committed
 * `artifact_published` events plus one, meta carries no file hashes (they live
 * on the events), reads cross-check the disk files against those events,
 * annotate is unique per (version, file) with replay self-exclusion, and the
 * read window tolerates "event exists, directory missing" by claiming a
 * staged sibling.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  catalogWithOneTemplate,
  disposeAllTestRoots,
  validTaskRequest,
} from '../test-support';
import type { CorePaths } from './core-paths';
import {
  ArtifactStore,
  publishedArtifactAuthorities,
  systemArtifactStageIdentity,
  type AnnotateProposal,
  type ArtifactProposal,
  type PrepareStructuredVersionInput,
  type PublishedArtifact,
  type StageSystemArtifactInputV2,
} from './artifact-store';
import type { CommittedEvent } from './event-store';
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../shared/authoritative-review-v2';
import type { SealRecord } from '../../shared/structured-slots';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import { parseBlob } from '../authoritative-review/object-registry';
import { fullProfileForTests } from '../authoritative-review/object-schemas';
import { AuthoritativeReviewBlobStore } from './authoritative-review-blob-store';
import { EventStore } from './event-store';
import { TaskStore } from './task-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const blobRef = (kind: BlobRefV2['kind'], digit: string): BlobRefV2 => ({
  kind,
  digest: digit.repeat(64),
  byteLength: 1,
  mediaType: 'application/json',
  schemaVersion: 1,
});

describe('ArtifactStore v1/v2 authority adapter', () => {
  it('preserves the exact discriminated authority and combined 1/2/3 ordering', () => {
    const v1 = (version: number, id: string): CommittedEvent => ({
      sequence: version,
      fileName: `${version}.json`,
      size: 1,
      event: {
        id,
        at: '2026-08-16T00:00:00.000Z',
        type: 'artifact_published',
        artifact: { version, title: id, sourceNodeId: `node-${id}`, format: 'markdown', files: [{ name: 'x.md', hash: 'a'.repeat(64) }], artifactType: null, artifactId: id },
      },
    });
    const v2: CommittedEvent = {
      sequence: 2,
      fileName: '2.json',
      size: 1,
      event: {
        protocolVersion: 2,
        id: 'v2',
        at: '2026-08-16T00:00:00.000Z',
        type: 'artifact_published_v2',
        artifactId: 'system-artifact',
        artifactVersion: 2,
        deliveryRef: blobRef('system_artifact_delivery', 'd'),
        files: [{ name: 'chapter.md', hash: 'b'.repeat(64) }],
        mediaType: 'text/markdown',
        provenance: {
          producerKind: 'system',
          producerWorkItemId: 'seal-work',
          sealRecordRef: blobRef('seal_record', 's'),
          artifactRef: blobRef('artifact', 'a'),
          custodyRef: blobRef('artifact', 'c'),
        },
      },
    };
    const result = publishedArtifactAuthorities([v1(1, 'v1-a'), v2, v1(3, 'v1-b')]);
    expect(result.map((entry) => entry.kind)).toEqual(['agent_v1', 'system_seal_v2', 'agent_v1']);
    expect(result[0]).toMatchObject({ sourceNodeId: 'node-v1-a' });
    expect(result[1]).toMatchObject({ provenance: { producerWorkItemId: 'seal-work' } });
    expect(result[2]).toMatchObject({ event: { artifact: { version: 3 } } });
  });
});

describe('ArtifactStore v2 system custody', () => {
  const artifactRef = blobRef('artifact', 'a');
  const sealRecordRef = blobRef('seal_record', 'e');
  const custodyRef = blobRef('artifact', 'c');
  const deliveryRef = blobRef('system_artifact_delivery', 'd');

  async function stageSystem(content = '# chapter') {
    return store.createSystemSealPublisher().stage(taskId, {
      sealWorkItemId: 'seal-work-1',
      artifactId: 'system-artifact-1',
      title: 'Sealed chapter',
      format: 'markdown',
      producerWorkItemId: 'seal-work-1',
      sealRecordRef,
      artifactRef,
      custodyRef,
      templateSnapshotHash: 'template-snapshot',
      files: [{ name: 'chapter.md', content }],
    });
  }

  async function appendSystemEvent(version: number, content = '# chapter') {
    const acquisitionNonce = randomUUID();
    writeFileSync(paths.storeFenceRecordFile(), JSON.stringify({
      ownerPid: process.pid, processStartToken: 'artifact-store-test', processStartTime: null,
      bootId: 'artifact-store-test', leaseEpoch: 1, acquisitionNonce, durableGeneration: 0,
      acquiredAt: '2026-08-16T00:00:00.000Z',
    }), 'utf8');
    const tail = await events.tail(taskId);
    await events.appendBatch(taskId, `system-publish-${version}`, [{
      protocolVersion: 2, id: `system-publish-${version}`, at: '2026-08-16T00:00:00.000Z',
      type: 'artifact_published_v2', artifactId: 'system-artifact-1', artifactVersion: version,
      deliveryRef, files: [{ name: 'chapter.md', hash: sha256(content) }], mediaType: 'text/markdown',
      provenance: { producerKind: 'system', producerWorkItemId: 'seal-work-1', sealRecordRef, artifactRef, custodyRef },
    }], { expectedLastSequence: tail.lastSequence, fenceProof: {
      ownerPid: process.pid, processStartToken: 'artifact-store-test', leaseEpoch: 1,
      acquisitionNonce, durableGeneration: 0,
    } });
  }

  it('P1#5: the System Seal capability is unforgeable — no caller string or raw-store trick reaches the privilege path', async () => {
    const input: StageSystemArtifactInputV2 = {
      sealWorkItemId: 'seal-work-1', artifactId: 'system-artifact-1', title: 'Sealed chapter',
      format: 'markdown', producerWorkItemId: 'seal-work-1', sealRecordRef, artifactRef,
      custodyRef, templateSnapshotHash: 'template-snapshot', files: [{ name: 'chapter.md', content: '# chapter' }],
    };
    // The old caller-string methods are GONE from the class surface.
    const surface = store as unknown as Record<string, unknown>;
    expect(surface.stageSystemArtifact).toBeUndefined();
    expect(surface.promoteSystemArtifact).toBeUndefined();
    // The privileged implementations are #-private instance slots: neither the
    // bare name nor a '#name' key exists outside the class body, so a hostile
    // holder of a raw ArtifactStore can never call them.
    expect(surface.stageSystemArtifactExclusive).toBeUndefined();
    expect(surface.promoteSystemArtifactExclusive).toBeUndefined();
    expect(surface['#stageSystemArtifactExclusive']).toBeUndefined();
    expect(surface['#promoteSystemArtifactExclusive']).toBeUndefined();
    // Calling the removed public path at runtime throws (not a function).
    const hostile = store as unknown as {
      stageSystemArtifact: (caller: string, taskId: string, i: unknown) => Promise<unknown>;
    };
    expect(() => hostile.stageSystemArtifact('system_seal', taskId, input)).toThrow(TypeError);
    expect(() => hostile.stageSystemArtifact('agent', taskId, input)).toThrow(TypeError);
    // v1 publish stays available (the capability only gates v2 system custody).
    expect((await store.publish(taskId, proposal('legacy'))).version).toBe(1);
    // The capability itself is the only working entry and drives stage/promote
    // of the NEXT version after the committed v1 history.
    const capability = store.createSystemSealPublisher();
    const staged = await capability.stage(taskId, input);
    expect(staged.stageIdentity).toBe(systemArtifactStageIdentity('seal-work-1', artifactRef));
    await appendSystemEvent(2);
    const promoted = await capability.promote(taskId, {
      sealWorkItemId: 'seal-work-1', artifactRef, artifactVersion: 2, deliveryRef,
    });
    expect(promoted.meta).toEqual(expect.objectContaining({ authorityKind: 'system_seal_v2', version: 2 }));
  });

  it('keeps version and delivery out of staging, then recovers list/read after response loss and reconstruction', async () => {
    const staged = await stageSystem();
    const replayedStage = await stageSystem();
    expect(replayedStage).toEqual(staged);
    expect(staged).not.toHaveProperty('version');
    expect(staged.stageIdentity).toBe(systemArtifactStageIdentity('seal-work-1', artifactRef));
    const stageManifest = JSON.parse(readFileSync(join(
      paths.taskStructuredCustodyRoot(taskId), `system-${staged.stageIdentity}`, 'system-stage.json',
    ), 'utf8'));
    expect(stageManifest).not.toHaveProperty('version');
    expect(stageManifest).not.toHaveProperty('deliveryRef');

    await appendSystemEvent(1); // response lost before promote
    const reconstructed = new ArtifactStore(paths, new EventStore(paths));
    const listed = await reconstructed.list(taskId); // claims the staged directory
    expect(listed).toHaveLength(1);
    expect(listed[0]?.meta).toEqual(expect.objectContaining({
      authorityKind: 'system_seal_v2', id: 'system-artifact-1', version: 1,
      producerWorkItemId: 'seal-work-1', sealRecordRef, artifactRef, custodyRef,
      templateSnapshotHash: 'template-snapshot', deliveryRef,
    }));
    expect(listed[0]?.meta).not.toHaveProperty('sourceNodeId');
    expect(await reconstructed.readFile(taskId, 1, 'chapter.md')).toBe('# chapter');
  });

  it('allocates legacy v1 after v2 from combined history with no collision or gap', async () => {
    const first = await publishWithEvent('legacy-first');
    expect(first.version).toBe(1);
    await stageSystem();
    await appendSystemEvent(2);
    expect((await new ArtifactStore(paths, new EventStore(paths)).read(taskId, 2)).meta.version).toBe(2);
    const third = await store.publish(taskId, proposal('legacy-third'));
    expect(third.version).toBe(3);
  });

  it('fails corrupt when disk provenance or file bytes no longer match the v2 event', async () => {
    await stageSystem();
    await appendSystemEvent(1);
    const reconstructed = new ArtifactStore(paths, new EventStore(paths));
    await reconstructed.read(taskId, 1);
    writeFileSync(join(paths.taskArtifactVersionRoot(taskId, 1), 'chapter.md'), 'tampered', 'utf8');
    await expect(reconstructed.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('two instances racing the same stage identity can never delete the winning stage', async () => {
    const second = new ArtifactStore(paths, new EventStore(paths));
    const content = '# chapter\n' + 'x'.repeat(1_000_000);
    const makeInput = (): StageSystemArtifactInputV2 => ({
      sealWorkItemId: 'seal-work-1', artifactId: 'system-artifact-1', title: 'Sealed chapter',
      format: 'markdown', producerWorkItemId: 'seal-work-1', sealRecordRef, artifactRef,
      custodyRef, templateSnapshotHash: 'template-snapshot', files: [{ name: 'chapter.md', content }],
    });
    const identity = systemArtifactStageIdentity('seal-work-1', artifactRef);
    const stageDir = join(paths.taskStructuredCustodyRoot(taskId), `system-${identity}`);
    for (let round = 0; round < 12; round += 1) {
      rmSync(stageDir, { recursive: true, force: true });
      const results = await Promise.allSettled([
        store.createSystemSealPublisher().stage(taskId, makeInput()),
        second.createSystemSealPublisher().stage(taskId, makeInput()),
      ]);
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
      }
      // The winning stage survived the loser's run: complete, byte-identical.
      expect(readFileSync(join(stageDir, 'chapter.md'), 'utf8')).toBe(content);
      const replayed = await new ArtifactStore(paths, new EventStore(paths)).createSystemSealPublisher().stage(taskId, makeInput());
      expect(replayed.files[0]).toMatchObject({ name: 'chapter.md', sha256: sha256(content) });
    }
  });

  it('racing the same identity with different bytes fails integrity and keeps the winner stage', async () => {
    const second = new ArtifactStore(paths, new EventStore(paths));
    const a = 'A'.repeat(400_000);
    const b = 'B'.repeat(400_000);
    const makeInput = (content: string): StageSystemArtifactInputV2 => ({
      sealWorkItemId: 'seal-work-1', artifactId: 'system-artifact-1', title: 'Sealed chapter',
      format: 'markdown', producerWorkItemId: 'seal-work-1', sealRecordRef, artifactRef,
      custodyRef, templateSnapshotHash: 'template-snapshot', files: [{ name: 'chapter.md', content }],
    });
    const identity = systemArtifactStageIdentity('seal-work-1', artifactRef);
    const stageDir = join(paths.taskStructuredCustodyRoot(taskId), `system-${identity}`);
    for (let round = 0; round < 6; round += 1) {
      rmSync(stageDir, { recursive: true, force: true });
      const results = await Promise.allSettled([
        store.createSystemSealPublisher().stage(taskId, makeInput(a)),
        second.createSystemSealPublisher().stage(taskId, makeInput(b)),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.status === 'rejected' ? rejected[0].reason : null)
        .toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
      // The winner stage is never deleted: the deterministic stage holds exactly one byte set.
      const bytes = readFileSync(join(stageDir, 'chapter.md'), 'utf8');
      expect(bytes === a || bytes === b).toBe(true);
    }
  });

  it('response-loss reconstruction: a late re-stage after the winner published returns the same stage and promotes', async () => {
    const winner = new ArtifactStore(paths, new EventStore(paths));
    const loser = new ArtifactStore(paths, new EventStore(paths));
    const input: StageSystemArtifactInputV2 = {
      sealWorkItemId: 'seal-work-1', artifactId: 'system-artifact-1', title: 'Sealed chapter',
      format: 'markdown', producerWorkItemId: 'seal-work-1', sealRecordRef, artifactRef,
      custodyRef, templateSnapshotHash: 'template-snapshot', files: [{ name: 'chapter.md', content: '# chapter' }],
    };
    const staged = await winner.createSystemSealPublisher().stage(taskId, input);
    await appendSystemEvent(1); // the winner commits artifact_published_v2; the response is lost
    const replayed = await loser.createSystemSealPublisher().stage(taskId, input);
    expect(replayed).toEqual(staged);
    const promoted = await loser.createSystemSealPublisher().promote(taskId, {
      sealWorkItemId: 'seal-work-1', artifactRef, artifactVersion: 1, deliveryRef,
    });
    expect(promoted.meta).toEqual(expect.objectContaining({
      authorityKind: 'system_seal_v2', id: 'system-artifact-1', version: 1,
      producerWorkItemId: 'seal-work-1', sealRecordRef, artifactRef, custodyRef,
      templateSnapshotHash: 'template-snapshot', deliveryRef,
    }));
    expect(promoted.files[0].content).toBe('# chapter');
  });

  it('same stage identity with different bytes fails integrity and never deletes the winner stage', async () => {
    await stageSystem('# winner chapter');
    const stageDir = join(paths.taskStructuredCustodyRoot(taskId), `system-${systemArtifactStageIdentity('seal-work-1', artifactRef)}`);
    await expect(stageSystem('# different chapter')).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
    expect(readFileSync(join(stageDir, 'chapter.md'), 'utf8')).toBe('# winner chapter');
    expect(await stageSystem('# winner chapter')).toMatchObject({ files: [{ name: 'chapter.md', content: '# winner chapter' }] });
  });

  it('a failed write cleans only its own temp dir and never the deterministic stage', async () => {
    await stageSystem('# winner chapter');
    const custodyRoot = paths.taskStructuredCustodyRoot(taskId);
    await expect(store.createSystemSealPublisher().stage(taskId, {
      sealWorkItemId: 'seal-work-2', artifactId: 'system-artifact-2', title: 'Sealed chapter',
      format: 'markdown', producerWorkItemId: 'seal-work-2', sealRecordRef, artifactRef,
      custodyRef, templateSnapshotHash: 'template-snapshot',
      files: [
        { name: 'written.md', content: 'lands first' },
        { name: `${'b'.repeat(300)}.md`, content: 'blows up on open' },
      ],
    })).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
    // No per-writer temp residue anywhere in the custody root.
    expect(readdirSync(custodyRoot).filter((name) => name.includes('.tmp-'))).toEqual([]);
    // The pre-existing deterministic stage is untouched and still readable.
    const stageDir = join(custodyRoot, `system-${systemArtifactStageIdentity('seal-work-1', artifactRef)}`);
    expect(readFileSync(join(stageDir, 'chapter.md'), 'utf8')).toBe('# winner chapter');
    expect(readFileSync(join(stageDir, 'system-stage.json'), 'utf8')).toContain('"createdAt"');
    expect(await stageSystem('# winner chapter')).toMatchObject({ files: [{ name: 'chapter.md', content: '# winner chapter' }] });
  });

  it('a crashed writer leaves an orphan temp dir that a later stage cleans without touching the deterministic stage', async () => {
    const identity = systemArtifactStageIdentity('seal-work-1', artifactRef);
    const foreignIdentity = systemArtifactStageIdentity('seal-work-other', artifactRef);
    const custodyRoot = paths.taskStructuredCustodyRoot(taskId);
    const orphanName = `system-${identity}.tmp-${randomUUID()}`;
    const foreignName = `system-${foreignIdentity}.tmp-${randomUUID()}`;
    mkdirSync(join(custodyRoot, orphanName), { recursive: true });
    writeFileSync(join(custodyRoot, orphanName, 'system-stage.json'), '{"partial":true}', 'utf8');
    mkdirSync(join(custodyRoot, foreignName), { recursive: true });
    writeFileSync(join(custodyRoot, foreignName, 'junk'), 'junk', 'utf8');

    const staged = await stageSystem('# chapter');

    expect(readdirSync(custodyRoot).sort()).toEqual([foreignName, `system-${identity}`].sort());
    const stageDir = join(custodyRoot, `system-${identity}`);
    expect(readFileSync(join(stageDir, 'chapter.md'), 'utf8')).toBe('# chapter');
    expect(staged.files[0]).toMatchObject({ name: 'chapter.md', sha256: sha256('# chapter') });
  });
});

describe('ArtifactStore v2 provenance closure validation (P1#4)', () => {
  const TEMPLATE = 'template-snapshot';
  const CONTENT = '# chapter';
  const sealWorkItemId = 'seal-work-1';
  const sha = (value: unknown): string => canonicalJsonSha256(value);
  const digestOf = (seed: string): string => sha({ seed }).slice(0, 64);
  const fabricatedRef = (kind: BlobRefV2['kind'], seed: string): BlobRefV2 => ({
    kind,
    digest: digestOf(seed),
    byteLength: 1,
    mediaType: 'application/json',
    schemaVersion: 1,
  });
  const selfDigest = (obj: Record<string, unknown>, field: string): string => {
    const { [field]: _omit, ...rest } = obj;
    return canonicalJsonSha256(rest);
  };
  const withSelfDigest = <T extends Record<string, unknown>>(body: T, field: string): T => ({
    ...body,
    [field]: selfDigest(body, field),
  });

  interface ClosureWorld {
    store: Map<string, unknown>;
    put(kind: Parameters<typeof parseBlob>[0], value: unknown): BlobRefV2;
    resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
    makeStore(): ArtifactStore;
    refs: {
      artifactRef: BlobRefV2;
      sealRecordRef: BlobRefV2;
      bundleRef: BlobRefV2;
      deliveryRef: BlobRefV2;
      custodyRef: BlobRefV2;
      sealWarningCustodyRootRef: BlobRefV2;
    };
    stageInput: StageSystemArtifactInputV2;
    event: {
      protocolVersion: 2;
      id: string;
      at: string;
      type: 'artifact_published_v2';
      artifactId: string;
      artifactVersion: number;
      deliveryRef: BlobRefV2;
      files: { name: string; hash: string }[];
      mediaType: 'text/markdown';
      provenance: {
        producerKind: 'system';
        producerWorkItemId: string;
        sealRecordRef: BlobRefV2;
        artifactRef: BlobRefV2;
        custodyRef: BlobRefV2;
      };
    };
  }

  /**
   * A self-consistent v2 provenance world: every ref resolves to a REAL
   * canonical blob in the in-memory resolver map. `metaEventCustodyRef`, when
   * given, is what the staged meta + event carry (an attacker-directed swap);
   * the delivery blob always keeps the internally-built custody.
   */
  function buildClosureWorld(metaEventCustodyRef?: BlobRefV2): ClosureWorld {
    const store = new Map<string, unknown>();
    const put = (kind: Parameters<typeof parseBlob>[0], value: unknown): BlobRefV2 => {
      const { ref } = parseBlob(kind, value);
      store.set(`${ref.kind}:${ref.digest}`, value);
      return ref;
    };
    const resolver = async (_taskId: string, ref: BlobRefV2): Promise<unknown> =>
      store.get(`${ref.kind}:${ref.digest}`) ?? null;
    const makeStore = (): ArtifactStore => new ArtifactStore(paths, new EventStore(paths), resolver);

    // artifact blob: the assembled text equals the staged chapter.md content.
    const artifactRef = put('artifact', {
      artifactId: 'system-artifact-1',
      mediaType: 'text/markdown',
      text: CONTENT,
    });
    // map_snapshot / finalized content manifest / review bundle (resolved links
    // of the SealRecord; their own children are fabricated, never resolved).
    const mapRef = put('map_snapshot', {
      scaffoldId: 'scaffold',
      mapId: 'map-1',
      supersedesMapId: null,
      sourceCandidateId: 'candidate-1',
      proposedMapCoreRef: fabricatedRef('proposed_map_core', 'proposed'),
      mapReviewBundleRef: fabricatedRef('map_review_bundle', 'map-review'),
      mapRevision: 1,
      mapSemanticDigest: digestOf('map'),
      positionGraphDigest: digestOf('position'),
      relationGraphDigest: digestOf('relation-graph'),
      templateSnapshotHash: TEMPLATE,
      nodes: [
        { slotId: 'root', slotType: 'chapter', contentBearing: false, parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: digestOf('node-root') },
      ],
      relations: [],
      activatedAt: '2026-08-16T00:00:00.000Z',
    });
    const manifestRef = put('content_revision_manifest', withSelfDigest({
      taskId,
      mapRef,
      mapSemanticDigest: digestOf('map'),
      taskContentRevision: 1,
      manifestPhase: 'finalized',
      entries: [],
      producerPlanSpecRef: null,
      priorManifestRef: null,
      finalizerValidatorAggregateRefs: [fabricatedRef('validator_aggregate', 'manifest-finalizer')],
      finalizerWarningRootRefs: [],
      contentRootDigest: digestOf('content-root'),
      manifestDigest: '',
    }, 'manifestDigest'));
    const reviewBundleRef = put('review_bundle', withSelfDigest({
      settlementCoreRef: fabricatedRef('content_review_settlement_core', 'settlement'),
      mapRef,
      contentRevisionManifestRef: manifestRef,
      reviewWarningCustodyRootRef: fabricatedRef('validation_warning_custody_root', 'review-warning'),
      bundleDigest: '',
    }, 'bundleDigest'));
    const aggregate = (trigger: 'seal_input' | 'seal_output'): BlobRefV2 => {
      const envelopeRef = fabricatedRef('validator_input_envelope', `envelope-${trigger}`);
      return put('validator_aggregate', withSelfDigest({
        trigger,
        executionPhase: null,
        inputRef: envelopeRef,
        inputDigest: envelopeRef.digest,
        registrationSetDigest: digestOf(`registration-${trigger}`),
        validExecutionDigests: [],
        blockingInvalidReceiptRefs: [],
        advisoryReceiptRefs: [],
        infrastructureFailureRefs: [],
        warningRootRef: fabricatedRef('validation_warning_root', `warning-${trigger}`),
        aggregateDigest: '',
        outcome: 'clear',
      }, 'aggregateDigest'));
    };
    const sealInputAggregateRef = aggregate('seal_input');
    const sealOutputAggregateRef = aggregate('seal_output');
    // The real closure's P2#8 advisory custody root: the bundle binds it and the
    // ArtifactStore cross-check resolves it (deleting it must corrupt).
    const warningInputRef = fabricatedRef('validator_input_envelope', 'envelope-seal-warning');
    const sealWarningCustodyRootRef = put('validation_warning_custody_root', withSelfDigest({
      scope: 'seal',
      taskId,
      baseRefs: [reviewBundleRef, sealInputAggregateRef].sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0)),
      entries: [{
        trigger: 'seal_input',
        inputRef: warningInputRef,
        inputDigest: warningInputRef.digest,
        executionScope: { sealWorkItemId },
        validatorAggregateRef: sealInputAggregateRef,
        warningRootRef: fabricatedRef('validation_warning_root', 'warning-seal-warning'),
      }],
      supersessionPolicyVersion: 'seal-warning-v1',
      rootDigest: '',
    }, 'rootDigest'));
    const bundleRef = put('seal_validation_bundle', withSelfDigest({
      sealWorkItemId,
      reviewBundleRef,
      contentRevisionManifestRef: manifestRef,
      sealInputAggregateRef,
      sealOutputAggregateRef,
      sealWarningCustodyRootRef,
      assemblerDigest: digestOf('assembler'),
      artifactRef,
      artifactDigest: artifactRef.digest,
      bundleDigest: '',
    }, 'bundleDigest'));
    const sealRecordRef = put('seal_record', {
      taskId,
      mapRef,
      mapSemanticDigest: digestOf('map'),
      mapReviewBundleRef: fabricatedRef('map_review_bundle', 'map-review'),
      contentRevisionManifestRef: manifestRef,
      contentRootDigest: digestOf('content-root'),
      reviewBundleRef,
      sealValidationBundleRef: bundleRef,
      templateSnapshotHash: TEMPLATE,
      assemblerDigest: digestOf('assembler'),
      artifactRef,
      artifactDigest: artifactRef.digest,
    });
    const custodyRef = put('artifact_custody', withSelfDigest({
      taskId,
      sealWorkItemId,
      artifactRef,
      sealRecordRef,
      templateSnapshotHash: TEMPLATE,
      files: [{ name: 'chapter.md', hash: sha256(CONTENT), byteLength: Buffer.byteLength(CONTENT, 'utf8') }],
      custodyDigest: '',
    }, 'custodyDigest'));
    const deliveryRef = put('system_artifact_delivery', {
      deliveryId: 'delivery-1',
      producer: 'system:structured_seal',
      sealRecordRef,
      sealRecordDigest: sealRecordRef.digest,
      artifactId: 'system-artifact-1',
      artifactRef,
      artifactDigest: artifactRef.digest,
      custodyRef,
      custodyDigest: custodyRef.digest,
      submitterWorkItemId: 'submit-work',
      submitterAgentId: 'submitter',
      templateSnapshotHash: TEMPLATE,
    });
    const effectiveCustody = metaEventCustodyRef ?? custodyRef;
    const stageInput: StageSystemArtifactInputV2 = {
      sealWorkItemId,
      artifactId: 'system-artifact-1',
      title: 'Sealed chapter',
      format: 'markdown',
      producerWorkItemId: sealWorkItemId,
      sealRecordRef,
      artifactRef,
      custodyRef: effectiveCustody,
      templateSnapshotHash: TEMPLATE,
      files: [{ name: 'chapter.md', content: CONTENT }],
    };
    const event: ClosureWorld['event'] = {
      protocolVersion: 2,
      id: 'system-publish-1',
      at: '2026-08-16T00:00:00.000Z',
      type: 'artifact_published_v2',
      artifactId: 'system-artifact-1',
      artifactVersion: 1,
      deliveryRef,
      files: [{ name: 'chapter.md', hash: sha256(CONTENT) }],
      mediaType: 'text/markdown',
      provenance: {
        producerKind: 'system',
        producerWorkItemId: sealWorkItemId,
        sealRecordRef,
        artifactRef,
        custodyRef: effectiveCustody,
      },
    };
    return {
      store,
      put,
      resolver,
      makeStore,
      refs: { artifactRef, sealRecordRef, bundleRef, deliveryRef, custodyRef, sealWarningCustodyRootRef },
      stageInput,
      event,
    };
  }

  async function appendV2Event(world: ClosureWorld): Promise<void> {
    const acquisitionNonce = randomUUID();
    writeFileSync(paths.storeFenceRecordFile(), JSON.stringify({
      ownerPid: process.pid, processStartToken: 'artifact-store-test', processStartTime: null,
      bootId: 'artifact-store-test', leaseEpoch: 1, acquisitionNonce, durableGeneration: 0,
      acquiredAt: '2026-08-16T00:00:00.000Z',
    }), 'utf8');
    const tail = await events.tail(taskId);
    await events.appendBatch(taskId, 'system-publish-1', [world.event], {
      expectedLastSequence: tail.lastSequence,
      fenceProof: {
        ownerPid: process.pid, processStartToken: 'artifact-store-test', leaseEpoch: 1,
        acquisitionNonce, durableGeneration: 0,
      },
    });
  }

  /** Full happy-path publish through the capability: stage -> event -> promote. */
  async function publishClosure(world: ClosureWorld): Promise<ArtifactStore> {
    const store = world.makeStore();
    await store.createSystemSealPublisher().stage(taskId, world.stageInput);
    await appendV2Event(world);
    await store.createSystemSealPublisher().promote(taskId, {
      sealWorkItemId,
      artifactRef: world.refs.artifactRef,
      artifactVersion: 1,
      deliveryRef: world.refs.deliveryRef,
    });
    return store;
  }

  it('resolves the FULL provenance closure on a healthy world: read/list/readFile all green', async () => {
    const world = buildClosureWorld();
    const store = await publishClosure(world);
    const entry = await store.read(taskId, 1);
    expect(entry.meta).toEqual(expect.objectContaining({ authorityKind: 'system_seal_v2', version: 1 }));
    expect(entry.files[0]?.content).toBe(CONTENT);
    expect((await store.list(taskId))[0]?.meta.version).toBe(1);
    expect(await store.readFile(taskId, 1, 'chapter.md')).toBe(CONTENT);
  });

  it.each([
    ['system artifact delivery', (w: ClosureWorld) => w.refs.deliveryRef],
    ['seal record', (w: ClosureWorld) => w.refs.sealRecordRef],
    ['seal validation bundle', (w: ClosureWorld) => w.refs.bundleRef],
    ['seal warning custody root', (w: ClosureWorld) => w.refs.sealWarningCustodyRootRef],
    ['artifact custody', (w: ClosureWorld) => w.refs.custodyRef],
    ['artifact blob', (w: ClosureWorld) => w.refs.artifactRef],
  ])('fails closed when the %s blob is deleted after publish', async (_label, pick) => {
    const world = buildClosureWorld();
    const store = await publishClosure(world);
    const ref = pick(world);
    world.store.delete(`${ref.kind}:${ref.digest}`);
    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await expect(store.list(taskId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('fails closed when the custody blob bytes are swapped at the same digest address', async () => {
    const world = buildClosureWorld();
    const store = await publishClosure(world);
    const key = `artifact_custody:${world.refs.custodyRef.digest}`;
    const original = world.store.get(key) as { files: { name: string; hash: string; byteLength: number }[] };
    world.store.set(key, { ...original, files: [{ name: 'chapter.md', hash: sha256('tampered'), byteLength: 8 }] });
    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('fails closed when meta/event custodyRef is swapped to a DIFFERENT VALID custody while the delivery keeps its own', async () => {
    const world = buildClosureWorld();
    // custody-B is a VALID, self-consistent artifact_custody (its own digest is
    // correct) but its byte content differs from custody-A — so meta/event point
    // at B while the delivery blob still binds A.
    const custodyB = world.put('artifact_custody', withSelfDigest({
      taskId,
      sealWorkItemId,
      artifactRef: world.refs.artifactRef,
      sealRecordRef: world.refs.sealRecordRef,
      templateSnapshotHash: TEMPLATE,
      files: [{ name: 'chapter.md', hash: sha256('tampered'), byteLength: Buffer.byteLength('tampered', 'utf8') }],
      custodyDigest: '',
    }, 'custodyDigest'));
    world.stageInput.custodyRef = custodyB;
    world.event.provenance = { ...world.event.provenance, custodyRef: custodyB };
    const store = world.makeStore();
    await store.createSystemSealPublisher().stage(taskId, world.stageInput);
    await appendV2Event(world);
    await expect(
      store.createSystemSealPublisher().promote(taskId, {
        sealWorkItemId,
        artifactRef: world.refs.artifactRef,
        artifactVersion: 1,
        deliveryRef: world.refs.deliveryRef,
      }),
    ).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('fails closed when meta/event/delivery ALL point at a VALID custody whose file manifest does not match disk', async () => {
    const world = buildClosureWorld();
    // custody-B is valid JSON but claims a file hash/byte length the disk lacks.
    const custodyB = world.put('artifact_custody', withSelfDigest({
      taskId,
      sealWorkItemId,
      artifactRef: world.refs.artifactRef,
      sealRecordRef: world.refs.sealRecordRef,
      templateSnapshotHash: TEMPLATE,
      files: [{ name: 'chapter.md', hash: sha256('tampered'), byteLength: Buffer.byteLength('tampered', 'utf8') }],
      custodyDigest: '',
    }, 'custodyDigest'));
    world.stageInput.custodyRef = custodyB;
    world.event.provenance = { ...world.event.provenance, custodyRef: custodyB };
    world.event.deliveryRef = world.put('system_artifact_delivery', {
      deliveryId: 'delivery-other',
      producer: 'system:structured_seal',
      sealRecordRef: world.refs.sealRecordRef,
      sealRecordDigest: world.refs.sealRecordRef.digest,
      artifactId: 'system-artifact-1',
      artifactRef: world.refs.artifactRef,
      artifactDigest: world.refs.artifactRef.digest,
      custodyRef: custodyB,
      custodyDigest: custodyB.digest,
      submitterWorkItemId: 'submit-work',
      submitterAgentId: 'submitter',
      templateSnapshotHash: TEMPLATE,
    });
    const store = world.makeStore();
    await store.createSystemSealPublisher().stage(taskId, world.stageInput);
    await appendV2Event(world);
    await expect(
      store.createSystemSealPublisher().promote(taskId, {
        sealWorkItemId,
        artifactRef: world.refs.artifactRef,
        artifactVersion: 1,
        deliveryRef: world.event.deliveryRef,
      }),
    ).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('fails closed when the on-disk artifact file bytes are changed after publish', async () => {
    const world = buildClosureWorld();
    const store = await publishClosure(world);
    writeFileSync(join(paths.taskArtifactVersionRoot(taskId, 1), 'chapter.md'), 'tampered', 'utf8');
    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('validates the SAME closure through the REAL blob store (parsed-object re-hash stays ref-identical)', async () => {
    const world = buildClosureWorld();
    const blobStore = new AuthoritativeReviewBlobStore(paths, fullProfileForTests());
    for (const [key, value] of world.store) {
      const kind = key.slice(0, key.indexOf(':')) as AuthoritativeBlobKindV2;
      await blobStore.putJson(taskId, kind, value);
    }
    const store = new ArtifactStore(paths, new EventStore(paths), (t, ref) =>
      blobStore.readJson(t, ref, ref.kind),
    );
    await store.createSystemSealPublisher().stage(taskId, world.stageInput);
    await appendV2Event(world);
    await store.createSystemSealPublisher().promote(taskId, {
      sealWorkItemId,
      artifactRef: world.refs.artifactRef,
      artifactVersion: 1,
      deliveryRef: world.refs.deliveryRef,
    });
    const entry = await store.read(taskId, 1);
    expect(entry.meta).toEqual(expect.objectContaining({ authorityKind: 'system_seal_v2', version: 1 }));
    expect(entry.files[0]?.content).toBe(CONTENT);
  });
});

function proposal(content: string, name = 'content.md'): ArtifactProposal {
  return {
    title: `产物 ${content}`,
    files: [{ name, content }],
    sourceNodeId: randomUUID(),
    format: 'markdown',
  };
}

let paths: CorePaths;
let store: ArtifactStore;
let events: EventStore;
let taskId: string;

beforeEach(async () => {
  const fixture = await catalogWithOneTemplate();
  paths = fixture.paths;
  const tasks = new TaskStore(paths, fixture.catalog);
  taskId = (await tasks.create(validTaskRequest())).id;
  events = new EventStore(paths);
  store = new ArtifactStore(paths, events);
});

afterEach(() => {
  disposeAllTestRoots();
});

/** Publishes through the store AND records the matching event (the committer's job). */
async function publishWithEvent(content: string): Promise<PublishedArtifact> {
  const published = await store.publish(taskId, proposal(content));
  await events.append(taskId, {
    id: randomUUID(),
    at: new Date().toISOString(),
    type: 'artifact_published',
    artifact: {
      version: published.version,
      title: published.title,
      sourceNodeId: published.sourceNodeId,
      format: published.format,
      files: published.files,
      artifactType: null,
      artifactId: published.id,
    },
  });
  return published;
}

/** Records an annotate event for a published version (the committer's job). */
async function recordAnnotateEvent(annotated: {
  version: number;
  file: string;
  contentHash: string;
  turnId: string;
  nodeId: string;
}): Promise<void> {
  await events.append(taskId, {
    id: randomUUID(),
    at: new Date().toISOString(),
    type: 'artifact_annotated',
    version: annotated.version,
    file: annotated.file,
    contentHash: annotated.contentHash,
    turnId: annotated.turnId,
    nodeId: annotated.nodeId,
  });
}

describe('ArtifactStore — v7 publish', () => {
  it('allocates versions from the committed event count (1, 2, …)', async () => {
    const v1 = await publishWithEvent('first');
    const v2 = await publishWithEvent('second');
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await store.read(taskId, 1)).files[0].content).toBe('first');
  });

  it('writes meta without file hashes and returns file hashes', async () => {
    const published = await publishWithEvent('正文内容');
    const versionRoot = paths.taskArtifactVersionRoot(taskId, 1);
    const meta = JSON.parse(readFileSync(join(versionRoot, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      version: 1,
      title: '产物 正文内容',
      format: 'markdown',
      sourceNodeId: published.sourceNodeId,
    });
    expect(meta.id).toMatch(UUID_RE);
    expect('contentHash' in meta).toBe(false); // hashes live on the event
    expect('files' in meta).toBe(false);
    expect(readFileSync(join(versionRoot, 'content.md'), 'utf8')).toBe('正文内容');
    expect(published.files).toEqual([{ name: 'content.md', hash: sha256('正文内容') }]);
    expect(published.id).toBe(meta.id);
  });

  it('ignores a caller-supplied version', async () => {
    const sneaky = { ...proposal('only'), version: 99 } as unknown as ArtifactProposal;
    const published = await store.publish(taskId, sneaky);
    expect(published.version).toBe(1);
  });

  it('writes text-format artifacts as content.txt', async () => {
    const published = await store.publish(taskId, {
      title: 't',
      files: [{ name: 'content.txt', content: 'plain' }],
      sourceNodeId: randomUUID(),
      format: 'text',
    });
    await events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'artifact_published',
      artifact: {
        version: published.version,
        title: published.title,
        sourceNodeId: published.sourceNodeId,
        format: 'text',
        files: published.files,
        artifactType: null,
        artifactId: published.id,
      },
    });
    expect(readdirSync(paths.taskArtifactVersionRoot(taskId, 1)).sort()).toEqual([
      'content.txt',
      'meta.json',
    ]);
  });

  it('rejects malformed proposals before touching disk', async () => {
    const base = proposal('content');
    const invalid: unknown[] = [
      null,
      'not-an-object',
      { ...base, title: '' },
      { ...base, sourceNodeId: '' },
      { ...base, format: 'pdf' },
      { ...base, files: [] },
      { ...base, files: [{ name: 'content.md', content: '' }] },
      { ...base, files: [{ name: 'meta.json', content: 'x' }] },
      { ...base, files: [{ name: '../x.md', content: 'x' }] },
      { ...base, files: [{ name: 'a.md', content: 'x' }, { name: 'a.md', content: 'y' }] },
    ];
    for (const candidate of invalid) {
      await expect(store.publish(taskId, candidate as ArtifactProposal)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
    expect(readdirSync(paths.taskArtifactsRoot(taskId))).toEqual([]);
  });

  it('reserves the custody bookkeeping names so a template file can never collide', async () => {
    for (const reserved of ['meta.json', 'manifest.json', 'seal-record.json']) {
      await expect(store.publish(taskId, proposal('x', reserved))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(
        store.annotate(taskId, {
          version: 1,
          file: reserved,
          content: 'x',
          turnId: 'turn-1',
          nodeId: 'turn-1-result',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(readdirSync(paths.taskArtifactsRoot(taskId))).toEqual([]);
  });
});

describe('ArtifactStore — v7 annotate', () => {
  it('appends a review file to an existing version and is readable', async () => {
    await publishWithEvent('正文');
    const annotated = await store.annotate(taskId, {
      version: 1,
      file: 'review.md',
      content: 'verdict: pass',
      turnId: 'turn-1',
      nodeId: 'turn-1-result',
    });
    expect(annotated.contentHash).toBe(sha256('verdict: pass'));
    await recordAnnotateEvent(annotated);
    const entry = await store.read(taskId, 1);
    const review = entry.files.find((file) => file.name === 'review.md');
    expect(review?.content).toBe('verdict: pass');
  });

  it('rejects a second annotation of the same (version, file) by a different turn', async () => {
    await publishWithEvent('正文');
    const first = await store.annotate(taskId, {
      version: 1,
      file: 'review.md',
      content: 'verdict: pass',
      turnId: 'turn-1',
      nodeId: 'turn-1-result',
    });
    await recordAnnotateEvent(first);
    await expect(
      store.annotate(taskId, {
        version: 1,
        file: 'review.md',
        content: 'verdict: reject',
        turnId: 'turn-2',
        nodeId: 'turn-2-result',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('treats a replay of the same turn as idempotent (self-exclusion)', async () => {
    await publishWithEvent('正文');
    const annotateProposal: AnnotateProposal = {
      version: 1,
      file: 'review.md',
      content: 'verdict: pass',
      turnId: 'turn-1',
      nodeId: 'turn-1-result',
    };
    const first = await store.annotate(taskId, annotateProposal);
    // Replay: the same turn re-annotating the same file is idempotent.
    const replay = await store.annotate(taskId, annotateProposal);
    expect(replay.contentHash).toBe(first.contentHash);
  });

  it('is idempotent when the file already matches the disk content', async () => {
    await publishWithEvent('正文');
    const annotated = await store.annotate(taskId, {
      version: 1,
      file: 'review.md',
      content: 'verdict: pass',
      turnId: 'turn-1',
      nodeId: 'turn-1-result',
    });
    await recordAnnotateEvent(annotated);
    const replay = await store.annotate(taskId, {
      version: 1,
      file: 'review.md',
      content: 'verdict: pass',
      turnId: 'turn-1',
      nodeId: 'turn-1-result',
    });
    expect(replay.contentHash).toBe(annotated.contentHash);
  });

  it('rejects annotating an unknown version', async () => {
    await expect(
      store.annotate(taskId, {
        version: 99,
        file: 'review.md',
        content: 'x',
        turnId: 't',
        nodeId: 'n',
      }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });
});

describe('ArtifactStore — v7 cross-check and recovery', () => {
  it('fails loud when a production file no longer matches the event hash', async () => {
    await publishWithEvent('first');
    const versionRoot = paths.taskArtifactVersionRoot(taskId, 1);
    writeFileSync(join(versionRoot, 'content.md'), 'tampered', 'utf8');
    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await expect(store.list(taskId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('fails loud when an annotate file has no backing event', async () => {
    await publishWithEvent('first');
    writeFileSync(join(paths.taskArtifactVersionRoot(taskId, 1), 'review.md'), 'orphan', 'utf8');
    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('claims a staged sibling when the event exists but the directory is missing', async () => {
    const published = await publishWithEvent('first');
    const artifactsRoot = paths.taskArtifactsRoot(taskId);
    // Simulate the crash window: the event is committed but the rename never
    // landed, so the final directory is gone and only the staging remains.
    rmSync(paths.taskArtifactVersionRoot(taskId, 1), { recursive: true, force: true });
    const stageDir = join(artifactsRoot, `.tmp-v001-${randomUUID()}`);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(
      join(stageDir, 'meta.json'),
      `${JSON.stringify(
        {
          id: published.id,
          version: 1,
          title: published.title,
          sourceNodeId: published.sourceNodeId,
          format: published.format,
          createdAt: published.createdAt,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(join(stageDir, 'content.md'), 'first', 'utf8');
    expect(readdirSync(artifactsRoot).includes('v001')).toBe(false);

    const entry = await store.read(taskId, 1);
    expect(entry.files[0].content).toBe('first');
    expect(readdirSync(artifactsRoot).includes('v001')).toBe(true);
    expect(readdirSync(artifactsRoot).some((name) => name.startsWith('.tmp-v001'))).toBe(false);
  });

  it('reclaims an orphan final directory (event crashed) on the next publish', async () => {
    const orphan = await store.publish(taskId, proposal('orphan-content'));
    expect(orphan.version).toBe(1);
    // The orphan (no backing event) is not listed.
    expect(await store.list(taskId)).toEqual([]);

    // A real publish of the same content reclaims version 1 by hash.
    const reclaimed = await store.publish(taskId, proposal('orphan-content'));
    expect(reclaimed.version).toBe(1);
    expect(reclaimed.id).toBe(orphan.id);
    await events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'artifact_published',
      artifact: {
        version: 1,
        title: reclaimed.title,
        sourceNodeId: reclaimed.sourceNodeId,
        format: reclaimed.format,
        files: reclaimed.files,
        artifactType: null,
        artifactId: reclaimed.id,
      },
    });
    const listed = await store.list(taskId);
    expect(listed.map((item) => item.meta.version)).toEqual([1]);
  });

  it('rejects a re-publication of the same version with different content', async () => {
    await store.publish(taskId, proposal('orphan-content'));
    await expect(store.publish(taskId, proposal('different-content'))).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
  });

  it('reads a single file via readFile', async () => {
    await publishWithEvent('正文');
    expect(await store.readFile(taskId, 1, 'content.md')).toBe('正文');
    await expect(store.readFile(taskId, 1, 'missing.md')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('skips staging residue and malformed names when listing', async () => {
    await publishWithEvent('first');
    const artifactsRoot = paths.taskArtifactsRoot(taskId);
    mkdirSync(join(artifactsRoot, `.tmp-v002-${randomUUID()}`), { recursive: true });
    writeFileSync(join(artifactsRoot, 'notes.txt'), 'irrelevant', 'utf8');
    const listed = await store.list(taskId);
    expect(listed.map((item) => item.meta.version)).toEqual([1]);
  });
});

describe('ArtifactStore — structured custody (Task 16)', () => {
  const CONTENT_IDENTITY = 'c'.repeat(64);

  function sealRecord(artifactId: string, version: number): SealRecord {
    return {
      sealId: 'seal-1',
      caseId: taskId,
      scaffoldId: 'scaffold-1',
      scaffoldRevision: 1,
      scaffoldTreeHash: 'a'.repeat(64),
      templateId: 'tpl',
      templateVersion: 'v1',
      snapshotHash: 'snap',
      assemblerId: 'asm',
      assemblerVersion: 'asm-v1',
      artifactVersionRef: { artifactId, version },
      outputs: [
        { routeId: 'out-1', path: 'content.md', mediaType: 'text/markdown; charset=utf-8', byteLength: 11, sha256: sha256('sealed body') },
      ],
      sealedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  function custodyInput(content = 'sealed body'): PrepareStructuredVersionInput {
    return {
      contentIdentity: CONTENT_IDENTITY,
      files: [{ name: 'content.md', content }],
      meta: { title: 'Sealed', sourceNodeId: 'turn-1-result', format: 'markdown' },
      sealRecord: sealRecord('', 0), // the store stamps artifactId/version
    };
  }

  function custodyRoot(): string {
    return join(paths.taskStructuredCustodyRoot(taskId), CONTENT_IDENTITY);
  }

  it('stages an unreferenced custody candidate; list/read ignore it until the batch', async () => {
    const prepared = await store.prepareStructuredVersion(taskId, custodyInput());
    expect(prepared.version).toBe(1); // allocated from the (empty) event stream
    expect(prepared.artifactId).toMatch(UUID_RE);
    expect(prepared.sealRecord.artifactVersionRef).toEqual({
      artifactId: prepared.artifactId,
      version: 1,
    });
    expect(prepared.files).toEqual([{ name: 'content.md', sha256: sha256('sealed body'), byteLength: 11 }]);

    // The custody directory exists but no event references it.
    expect(readdirSync(custodyRoot()).sort()).toEqual(['content.md', 'manifest.json', 'meta.json', 'seal-record.json']);
    // list/read ignore the unreferenced staging.
    expect(await store.list(taskId)).toEqual([]);
    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it('crash before promote: the custody orphan is reused or removed by digest', async () => {
    const first = await store.prepareStructuredVersion(taskId, custodyInput('sealed body'));
    expect(readdirSync(custodyRoot()).length).toBe(4);

    // Re-prepare with the SAME digest reuses the same artifact identity/version.
    const reused = await store.prepareStructuredVersion(taskId, {
      ...custodyInput('sealed body'),
      artifactId: first.artifactId,
    });
    expect(reused.version).toBe(1);
    expect(reused.artifactId).toBe(first.artifactId);

    // A re-prepare with a DIFFERENT digest removes the old orphan before staging.
    const changed = await store.prepareStructuredVersion(taskId, {
      ...custodyInput('changed body'),
      artifactId: first.artifactId,
    });
    expect(changed.version).toBe(1);
    expect(readdirSync(custodyRoot()).sort()).toEqual(['content.md', 'manifest.json', 'meta.json', 'seal-record.json']);
    expect(readFileSync(join(custodyRoot(), 'content.md'), 'utf8')).toBe('changed body');
  });

  it('crash after promote/before batch: the final directory is an unreferenced orphan', async () => {
    const prepared = await store.prepareStructuredVersion(taskId, custodyInput());
    await store.promotePreparedVersion(taskId, prepared);

    const artifactsRoot = paths.taskArtifactsRoot(taskId);
    expect(readdirSync(artifactsRoot).includes('v001')).toBe(true);
    // No event yet: list/read still ignore the promoted directory.
    expect(await store.list(taskId)).toEqual([]);
    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });

    // Recovery reconciles the orphan: the final dir is removed and the custody
    // candidate (kept intact by promote) is reused by digest.
    const recovery = await store.recoverStructuredCustody(taskId, {
      contentIdentity: CONTENT_IDENTITY,
      expectedArtifactId: prepared.artifactId,
      expectedVersion: 1,
      expectedFiles: [{ name: 'content.md', sha256: sha256('sealed body') }],
    });
    expect(recovery.status).toBe('orphan_reused');
    expect(recovery.handle?.version).toBe(1);
    expect(readdirSync(artifactsRoot).includes('v001')).toBe(false);
  });

  it('after the batch: all files + the SealRecord are readable and verified', async () => {
    const prepared = await store.prepareStructuredVersion(taskId, custodyInput());
    await store.promotePreparedVersion(taskId, prepared);
    // The committer's ONE batch: artifact_published references the promoted version.
    await events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'artifact_published',
      artifact: {
        version: prepared.version,
        title: prepared.title,
        sourceNodeId: prepared.sourceNodeId,
        format: prepared.format,
        files: prepared.files.map((file) => ({ name: file.name, hash: file.sha256 })),
        artifactType: null,
        artifactId: prepared.artifactId,
      },
    });

    const listed = await store.list(taskId);
    expect(listed.map((item) => item.meta.version)).toEqual([1]);
    expect((await store.read(taskId, 1)).files[0].content).toBe('sealed body');

    const recovery = await store.recoverStructuredCustody(taskId, {
      contentIdentity: CONTENT_IDENTITY,
      expectedArtifactId: prepared.artifactId,
      expectedVersion: 1,
      expectedFiles: [{ name: 'content.md', sha256: sha256('sealed body') }],
    });
    expect(recovery.status).toBe('referenced');
    expect(recovery.handle?.sealRecord.artifactVersionRef).toEqual({
      artifactId: prepared.artifactId,
      version: 1,
    });
    // The SealRecord is readable from the promoted version directory.
    const onDisk = JSON.parse(
      readFileSync(join(paths.taskArtifactVersionRoot(taskId, 1), 'seal-record.json'), 'utf8'),
    );
    expect(onDisk.sealId).toBe('seal-1');
  });

  it('hash mismatch fails with ARTIFACT_INTEGRITY_FAILED and is never absorbed', async () => {
    const prepared = await store.prepareStructuredVersion(taskId, custodyInput('sealed body'));
    // Tamper with the staged file BEFORE promote.
    writeFileSync(join(custodyRoot(), 'content.md'), 'tampered', 'utf8');
    await expect(store.promotePreparedVersion(taskId, prepared)).rejects.toMatchObject({
      code: 'ARTIFACT_INTEGRITY_FAILED',
    });

    // A tampered final directory after the batch is also ARTIFACT_INTEGRITY_FAILED
    // through the recovery path.
    const second = await store.prepareStructuredVersion(taskId, custodyInput('sealed body'));
    await store.promotePreparedVersion(taskId, second);
    await events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'artifact_published',
      artifact: {
        version: 1,
        title: second.title,
        sourceNodeId: second.sourceNodeId,
        format: second.format,
        files: second.files.map((file) => ({ name: file.name, hash: file.sha256 })),
        artifactType: null,
        artifactId: second.artifactId,
      },
    });
    writeFileSync(join(paths.taskArtifactVersionRoot(taskId, 1), 'content.md'), 'tampered', 'utf8');
    await expect(
      store.recoverStructuredCustody(taskId, {
        contentIdentity: CONTENT_IDENTITY,
        expectedArtifactId: second.artifactId,
        expectedVersion: 1,
        expectedFiles: [{ name: 'content.md', sha256: sha256('sealed body') }],
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
  });

  it('a future prepare removes a DIFFERENT unreferenced final-dir orphan', async () => {
    // Crash window: promoted to v001 but the event never landed.
    const prepared = await store.prepareStructuredVersion(taskId, custodyInput('sealed body'));
    await store.promotePreparedVersion(taskId, prepared);
    expect(readdirSync(paths.taskArtifactsRoot(taskId)).includes('v001')).toBe(true);

    // A new prepare (different content identity) allocates the same version 1
    // and must prove no event references it before replacing the orphan.
    const otherIdentity = 'd'.repeat(64);
    const next = await store.prepareStructuredVersion(taskId, {
      ...custodyInput('sealed body'),
      contentIdentity: otherIdentity,
    });
    expect(next.version).toBe(1);
    expect(readdirSync(paths.taskArtifactsRoot(taskId)).includes('v001')).toBe(false);
    expect(readdirSync(join(paths.taskStructuredCustodyRoot(taskId), otherIdentity)).length).toBe(4);
  });
});
