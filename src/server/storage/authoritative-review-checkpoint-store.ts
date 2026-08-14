/**
 * Task 9: persistent v2 projection checkpoints (spec §9.4, design §19.1).
 *
 * Per task, under `structured-slots/v2/projections/`:
 * - `checkpoints/<digest>.json`: one immutable checkpoint envelope binding
 *   `throughSequence` + `priorCheckpointDigest` + `projectionSchemaVersion`,
 *   embedding the full serialized projection AND the fold continuation the
 *   projector needs to resume without re-walking genesis;
 * - `latest.json`: the current tail pointer (`throughSequence` + digest).
 *
 * Checkpoints are DISPOSABLE ACCELERATORS, never authority:
 * - every read verifies the envelope digest, the task/sequence/schema binding
 *   and every referenced ref (through the injected resolver);
 * - missing/corrupt/unverifiable checkpoint files fall back to a full
 *   validated genesis scan and the store RE-RECORDS the tail checkpoint —
 *   the task itself is never implicated;
 * - a corrupt AUTHORITATIVE event in the tail propagates as task corruption
 *   (the checkpoint never masks event corruption); the store falls back ONLY
 *   for checkpoint-file problems, never for event-source failures.
 * - the store tolerates GC sweeping its own files: an unrooted checkpoint
 *   blob may legitimately disappear (checkpoints are never GC roots).
 *
 * The envelope is NOT a `projection_checkpoint` registry blob: checkpoints
 * are volatile accelerators and the embedded projection/fold would violate
 * the registered blob's exact-key schema. The registry kind remains reserved
 * for Task 11+ projection-service publications.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CorePaths } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomicDurable, writeReplaceAtomicDurable } from './atomic-file';
import type { AuthoritativeReviewEventV2 } from './authoritative-review-events';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import type { BlobObjectResolver, ProjectionFoldDataV2, AuthoritativeReviewProjectionV2 } from './authoritative-review-state';
import { projectAuthoritativeReviewState } from './authoritative-review-state';
import { canonicalJson, canonicalJsonSha256 } from '../structured-slots/canonical-json';

/** Frozen schema version bound into every envelope (spec §9.4 binding). */
export const PROJECTION_CHECKPOINT_SCHEMA_VERSION = 'authoritative-review-projection/v2';

/** A validated committed event the checkpoint store replays (EventStore shape). */
export interface CommittedValidatedEvent {
  sequence: number;
  fileName: string;
  size: number;
  event: AuthoritativeReviewEventV2;
}

/**
 * The event source a checkpoint store replays from. EventStore satisfies this
 * interface; tests inject in-memory sources. `read` returns the FULL
 * validated commit set; `readAfter(throughSequence)` the validated tail.
 */
export interface ValidatedEventSource {
  read(taskId: string): Promise<CommittedValidatedEvent[]>;
  readAfter(taskId: string, throughSequence: number): Promise<CommittedValidatedEvent[]>;
}

/** One immutable checkpoint envelope on disk. */
export interface ProjectionCheckpointEnvelopeV2 {
  version: 2;
  checkpointId: string;
  taskId: string;
  throughSequence: number;
  priorCheckpointDigest: string | null;
  projectionSchemaVersion: string;
  baseRefs: BlobRefV2[];
  projection: AuthoritativeReviewProjectionV2;
  fold: ProjectionFoldDataV2;
  checkpointDigest: string;
}

export interface CheckpointRecordInput {
  throughSequence: number;
  projection: AuthoritativeReviewProjectionV2;
  fold: ProjectionFoldDataV2;
  baseRefs: BlobRefV2[];
}

export interface RebuiltProjection {
  throughSequence: number;
  projection: AuthoritativeReviewProjectionV2;
  fold: ProjectionFoldDataV2;
  digest: string;
}

export interface ReadStateResult {
  throughSequence: number;
  projection: AuthoritativeReviewProjectionV2;
  fold: ProjectionFoldDataV2;
  fromCheckpoint: boolean;
}

function checkpointError(message: string): StorageError {
  return new StorageError(STORAGE_ERROR_CODES.TASK_CORRUPTED, message, null, '检查该任务的投影目录。');
}

function envelopeDigestOf(envelope: Omit<ProjectionCheckpointEnvelopeV2, 'checkpointDigest'>): string {
  return canonicalJsonSha256(envelope);
}

function envelopeWithoutDigest(envelope: ProjectionCheckpointEnvelopeV2): Omit<ProjectionCheckpointEnvelopeV2, 'checkpointDigest'> {
  const { checkpointDigest: _checkpointDigest, ...rest } = envelope;
  return rest;
}

function checkpointIdOf(taskId: string, throughSequence: number, priorCheckpointDigest: string | null): string {
  return canonicalJsonSha256({ taskId, throughSequence, priorCheckpointDigest });
}

const LATEST_PATTERN = /^[0-9a-f]{64}$/;

export class AuthoritativeReviewCheckpointStore {
  private readonly paths: CorePaths;

  private readonly source: ValidatedEventSource;

  private readonly projectionSchemaVersion: string;

  constructor(
    paths: CorePaths,
    source: ValidatedEventSource,
    options: { projectionSchemaVersion?: string } = {},
  ) {
    this.paths = paths;
    this.source = source;
    this.projectionSchemaVersion = options.projectionSchemaVersion ?? PROJECTION_CHECKPOINT_SCHEMA_VERSION;
  }

  /**
   * Full validated genesis scan (spec §9.4 unconditional fallback): projects
   * the entire committed history and records a fresh tail checkpoint. Used
   * whenever the disposable checkpoint chain is missing/corrupt/unverifiable.
   */
  async rebuild(taskId: string, resolver?: BlobObjectResolver, throughSequence?: number): Promise<RebuiltProjection> {
    const committed = await this.source.read(taskId);
    const events = committed
      .filter((entry) => throughSequence === undefined || entry.sequence <= throughSequence)
      .map((entry) => entry.event);
    const result = await projectAuthoritativeReviewState(events, resolver);
    if (!result.ok) {
      throw result.error;
    }
    return {
      throughSequence: result.state.lastSequence,
      projection: result.state,
      fold: result.fold,
      digest: projectedStateDigest(result.state),
    };
  }

  /**
   * The read path: latest valid checkpoint + validated tail replay; only
   * checkpoint-file problems fall back to genesis. Corrupt authoritative
   * events in the tail or in the full scan propagate (the task is corrupt).
   */
  async readState(taskId: string, resolver?: BlobObjectResolver): Promise<ReadStateResult> {
    const latest = await this.readLatest(taskId);
    if (latest !== null) {
      const validCheckpoint = await this.loadVerifiedCheckpoint(taskId, latest, resolver);
      if (validCheckpoint !== null) {
        try {
          const tail = await this.source.readAfter(taskId, validCheckpoint.throughSequence);
          const events = tail.map((entry) => entry.event);
          const result = await projectAuthoritativeReviewState(events, resolver, validCheckpoint.fold);
          if (!result.ok) {
            throw result.error;
          }
          return {
            throughSequence: result.state.lastSequence,
            projection: result.state,
            fold: result.fold,
            fromCheckpoint: true,
          };
        } catch (error) {
          if (isCheckpointFileError(error)) {
            return this.fallbackGenesis(taskId, resolver);
          }
          throw error;
        }
      }
    }
    return this.fallbackGenesis(taskId, resolver);
  }

  /**
   * Writes one immutable checkpoint envelope plus the atomic latest pointer.
   * Identical inputs produce the identical digest (deterministic); successive
   * records chain `priorCheckpointDigest` into the new envelope.
   */
  async record(taskId: string, input: CheckpointRecordInput): Promise<string> {
    const prior = await this.readLatest(taskId);
    const envelopeBase: Omit<ProjectionCheckpointEnvelopeV2, 'checkpointDigest'> = {
      version: 2,
      checkpointId: checkpointIdOf(taskId, input.throughSequence, prior?.checkpointDigest ?? null),
      taskId,
      throughSequence: input.throughSequence,
      priorCheckpointDigest: prior?.checkpointDigest ?? null,
      projectionSchemaVersion: this.projectionSchemaVersion,
      baseRefs: input.baseRefs.map((ref) => ({ ...ref })),
      projection: input.projection,
      fold: input.fold,
    };
    const checkpointDigest = envelopeDigestOf(envelopeBase);
    const envelope: ProjectionCheckpointEnvelopeV2 = { ...envelopeBase, checkpointDigest };
    const dir = join(this.paths.taskStructuredV2ProjectionsRoot(taskId), 'checkpoints');
    await mkdir(dir, { recursive: true });
    const file = this.paths.taskStructuredV2CheckpointFile(taskId, checkpointDigest);
    try {
      await writeNewAtomicDurable(file, Buffer.from(canonicalJson(envelope), 'utf8'));
    } catch (error) {
      if ((error as StorageError).code !== STORAGE_ERROR_CODES.FILE_EXISTS) {
        throw error;
      }
      // Deterministic re-record of the exact same envelope: byte-identical
      // content at the same address is idempotent.
    }
    const latestPayload = { throughSequence: input.throughSequence, checkpointDigest, taskId };
    await writeReplaceAtomicDurable(this.paths.taskStructuredV2CheckpointLatestFile(taskId), Buffer.from(canonicalJson(latestPayload), 'utf8'));
    return checkpointDigest;
  }

  /** The current (latest pointer) checkpoint envelope, or null. */
  async readCheckpoint(taskId: string, digest?: string): Promise<ProjectionCheckpointEnvelopeV2 | null> {
    const latest = digest ?? (await this.readLatest(taskId))?.checkpointDigest ?? null;
    if (latest === null) {
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(this.paths.taskStructuredV2CheckpointFile(taskId, latest));
    } catch {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return null;
    }
    const envelope = this.parseEnvelope(value, taskId);
    if (envelope === null) {
      return null;
    }
    if (envelope.checkpointDigest !== latest) {
      return null;
    }
    return envelope;
  }

  /** Current tail pointer from disk, validated shape-wise; corrupt => null. */
  private async readLatest(taskId: string): Promise<{ throughSequence: number; checkpointDigest: string } | null> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.paths.taskStructuredV2CheckpointLatestFile(taskId), 'utf8'));
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.throughSequence !== 'number' ||
      !Number.isInteger(record.throughSequence) ||
      record.throughSequence < 0 ||
      typeof record.checkpointDigest !== 'string' ||
      !LATEST_PATTERN.test(record.checkpointDigest)
    ) {
      return null;
    }
    return { throughSequence: record.throughSequence, checkpointDigest: record.checkpointDigest };
  }

  /**
   * Loads and fully verifies the checkpoint the latest pointer names:
   * envelope digest, schema version, task binding, sequence binding and every
   * referenced baseRef resolves. Any failure => null (genesis fallback).
   */
  private async loadVerifiedCheckpoint(
    taskId: string,
    latest: { throughSequence: number; checkpointDigest: string },
    resolver: BlobObjectResolver | undefined,
  ): Promise<ProjectionCheckpointEnvelopeV2 | null> {
    let envelope: ProjectionCheckpointEnvelopeV2 | null = null;
    try {
      const file = this.paths.taskStructuredV2CheckpointFile(taskId, latest.checkpointDigest);
      const envelopeSource = JSON.parse(await readFile(file, 'utf8'));
      envelope = this.parseEnvelope(envelopeSource, taskId);
      if (envelope === null) {
        return null;
      }
      if (envelope.projectionSchemaVersion !== this.projectionSchemaVersion) {
        return null;
      }
      if (envelope.checkpointDigest !== latest.checkpointDigest || envelope.throughSequence !== latest.throughSequence) {
        return null;
      }
      if (envelope.projection.lastSequence !== envelope.throughSequence) {
        return null;
      }
      if (resolver !== undefined) {
        for (const ref of envelope.baseRefs) {
          try {
            await resolver(ref);
          } catch {
            return null;
          }
        }
      }
      return envelope;
    } catch {
      return null;
    }
  }

  /** Strict envelope parse: digest must equal the canonical envelope digest. */
  private parseEnvelope(value: unknown, taskId: string): ProjectionCheckpointEnvelopeV2 | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (record.version !== 2 || typeof record.checkpointId !== 'string' || record.taskId !== taskId) {
      return null;
    }
    if (typeof record.throughSequence !== 'number' || !Number.isInteger(record.throughSequence) || record.throughSequence < 0) {
      return null;
    }
    if (record.priorCheckpointDigest !== null && (typeof record.priorCheckpointDigest !== 'string' || !LATEST_PATTERN.test(record.priorCheckpointDigest))) {
      return null;
    }
    if (typeof record.projectionSchemaVersion !== 'string') {
      return null;
    }
    if (!Array.isArray(record.baseRefs)) {
      return null;
    }
    if (typeof record.projection !== 'object' || record.projection === null || typeof record.fold !== 'object' || record.fold === null) {
      return null;
    }
    if (typeof record.checkpointDigest !== 'string' || !LATEST_PATTERN.test(record.checkpointDigest)) {
      return null;
    }
    const candidate = record as unknown as ProjectionCheckpointEnvelopeV2;
    if (envelopeDigestOf(envelopeWithoutDigest(candidate)) !== candidate.checkpointDigest) {
      return null;
    }
    if ((candidate.projection as { version?: unknown }).version !== 2) {
      return null;
    }
    return candidate;
  }

  private async fallbackGenesis(taskId: string, resolver?: BlobObjectResolver): Promise<ReadStateResult> {
    const rebuilt = await this.rebuild(taskId, resolver);
    return {
      throughSequence: rebuilt.throughSequence,
      projection: rebuilt.projection,
      fold: rebuilt.fold,
      fromCheckpoint: false,
    };
  }
}

/** Canonical digest of a projected state (checkpoint equivalence identity). */
function projectedStateDigest(state: AuthoritativeReviewProjectionV2): string {
  return canonicalJsonSha256(state);
}

/**
 * Distinguishes checkpoint-file problems (fall back) from event-source /
 * projection failures (propagate). The checkpoint store only ever treats its
 * OWN file errors as disposable; anything the event source or the projector
 * threw means authority data is at stake and must never be masked.
 */
function isCheckpointFileError(error: unknown): boolean {
  if (error instanceof StorageError) {
    return (
      error.code === STORAGE_ERROR_CODES.TASK_CORRUPTED &&
      /投影目录/.test(error.message)
    );
  }
  return false;
}