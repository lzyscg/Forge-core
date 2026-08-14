/**
 * Explicit, dependency-free path derivation for Forge Core storage
 * (plan Phase B Task 1).
 *
 * Every helper is a pure resolve/normalize over the two roots handed in by
 * the caller. Nothing here reads process.cwd, touches the filesystem, or
 * decides policy: later modules (template cache, task store, event store,
 * artifact store) reuse these naming helpers so every on-disk location has
 * exactly one derivation site. Identifier-shaped inputs are rejected before
 * they can escape their root.
 */
import { resolve } from 'node:path';

export interface CorePathsOptions {
  dataRoot: string;
  templateRoot: string;
}

/** Public error thrown when an identifier could escape its root. */
export class CorePathError extends Error {
  readonly code = 'CORE_PATH_INVALID';

  constructor(field: string) {
    super(`forge-core: rejected an unsafe path segment for ${field} (CORE_PATH_INVALID)`);
    this.name = 'CorePathError';
  }
}

/**
 * A single path segment: starts alphanumeric, then alphanumeric/dot/underscore/
 * dash. Cannot express `.`, `..`, emptiness, nesting or absolute paths.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Shared predicate so later stores can reuse the exact segment policy. */
export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value);
}

/** Committed event files: `<six-digit-sequence>-<event-id>.json`. */
const EVENT_FILE_NAME = /^(\d{6})-([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

/**
 * Atomic batch envelope files: `<first>-<last>-<commitId>.batch.json` (spec
 * §7.3). Deliberately a superset-shaped name so it also satisfies
 * `EVENT_FILE_NAME`; every parse site must check the batch pattern first (see
 * `parseEventFileName` and `taskEventFile`).
 */
const BATCH_FILE_NAME =
  /^(\d{6})-(\d{6})-([A-Za-z0-9][A-Za-z0-9._-]*)\.batch\.json$/;

/** Full lowercase hex SHA-256 digest used as a structured blob filename. */
const STRUCTURED_SHA256 = /^[0-9a-f]{64}$/;

function assertSafeSegment(field: string, value: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new CorePathError(field);
  }
}

export function formatEventFileName(sequence: number, eventId: string): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999_999) {
    throw new CorePathError('sequence');
  }
  assertSafeSegment('eventId', eventId);
  return `${String(sequence).padStart(6, '0')}-${eventId}.json`;
}

export function parseEventFileName(
  fileName: string,
): { sequence: number; eventId: string } | null {
  if (BATCH_FILE_NAME.test(fileName)) {
    // A genuine batch envelope is never a legacy single-event file (spec
    // §7.3); the batch pattern wins on the ambiguous overlap.
    return null;
  }
  const match = EVENT_FILE_NAME.exec(fileName);
  if (match === null) {
    return null;
  }
  return { sequence: Number(match[1]), eventId: match[2] };
}

/** `<first>-<last>-<commitId>.batch.json` (spec §7.3). */
export function formatBatchFileName(
  firstSequence: number,
  lastSequence: number,
  commitId: string,
): string {
  if (!Number.isInteger(firstSequence) || firstSequence < 1 || firstSequence > 999_999) {
    throw new CorePathError('firstSequence');
  }
  if (!Number.isInteger(lastSequence) || lastSequence < firstSequence || lastSequence > 999_999) {
    throw new CorePathError('lastSequence');
  }
  assertSafeSegment('commitId', commitId);
  return `${String(firstSequence).padStart(6, '0')}-${String(lastSequence).padStart(6, '0')}-${commitId}.batch.json`;
}

export function parseBatchFileName(
  fileName: string,
): { firstSequence: number; lastSequence: number; commitId: string } | null {
  const match = BATCH_FILE_NAME.exec(fileName);
  if (match === null) {
    return null;
  }
  return { firstSequence: Number(match[1]), lastSequence: Number(match[2]), commitId: match[3] };
}

export class CorePaths {
  readonly dataRoot: string;

  readonly templateRoot: string;

  /** Managed cache lives under the data root, never inside the source root. */
  readonly templateCacheRoot: string;

  readonly tasksRoot: string;

  private constructor(options: CorePathsOptions) {
    this.dataRoot = resolve(options.dataRoot);
    this.templateRoot = resolve(options.templateRoot);
    this.templateCacheRoot = resolve(this.dataRoot, 'template-cache');
    this.tasksRoot = resolve(this.dataRoot, 'tasks');
  }

  static create(options: CorePathsOptions): CorePaths {
    return new CorePaths(options);
  }

  /** Source template directory, owned by the user (read-only for the core). */
  templateSource(templateId: string): string {
    assertSafeSegment('templateId', templateId);
    return resolve(this.templateRoot, templateId);
  }

  /** Cached copy of one validated template version: template-cache/<id>/<hash>/. */
  templateCacheVersionRoot(templateId: string, versionHash: string): string {
    assertSafeSegment('templateId', templateId);
    assertSafeSegment('versionHash', versionHash);
    return resolve(this.templateCacheRoot, templateId, versionHash);
  }

  /** Atomic pointer to the current cached version: template-cache/<id>/current.json. */
  templateCacheCurrentFile(templateId: string): string {
    assertSafeSegment('templateId', templateId);
    return resolve(this.templateCacheRoot, templateId, 'current.json');
  }

  taskRoot(taskId: string): string {
    assertSafeSegment('taskId', taskId);
    return resolve(this.tasksRoot, taskId);
  }

  /** Immutable task identity file (frozen inputs + template reference). */
  taskFile(taskId: string): string {
    return resolve(this.taskRoot(taskId), 'task.json');
  }

  /** Full template snapshot copied at task creation. */
  taskSnapshotRoot(taskId: string): string {
    return resolve(this.taskRoot(taskId), 'snapshot');
  }

  /** Append-only committed event directory. */
  taskEventsRoot(taskId: string): string {
    return resolve(this.taskRoot(taskId), 'events');
  }

  taskEventFile(taskId: string, fileName: string): string {
    if (!EVENT_FILE_NAME.test(fileName) || BATCH_FILE_NAME.test(fileName)) {
      throw new CorePathError('fileName');
    }
    return resolve(this.taskEventsRoot(taskId), fileName);
  }

  /** Batch envelope file: `<first>-<last>-<commitId>.batch.json` (spec §7.3). */
  taskBatchEventFile(taskId: string, fileName: string): string {
    if (!BATCH_FILE_NAME.test(fileName)) {
      throw new CorePathError('fileName');
    }
    return resolve(this.taskEventsRoot(taskId), fileName);
  }

  /** Append-only artifact version directories live here. */
  taskArtifactsRoot(taskId: string): string {
    return resolve(this.taskRoot(taskId), 'artifacts');
  }

  /** artifacts/vNNN/ — three-digit zero-padded version directory. */
  taskArtifactVersionRoot(taskId: string, version: number): string {
    if (!Number.isInteger(version) || version < 1 || version > 999) {
      throw new CorePathError('version');
    }
    return resolve(this.taskArtifactsRoot(taskId), `v${String(version).padStart(3, '0')}`);
  }

  /** Per-turn execution trace directory: one append-only file per Turn. */
  taskTracesRoot(taskId: string): string {
    return resolve(this.taskRoot(taskId), 'traces');
  }

  /** traces/<turnId>.json — the turn id must be a single safe segment. */
  taskTraceFile(taskId: string, turnId: string): string {
    assertSafeSegment('turnId', turnId);
    return resolve(this.taskTracesRoot(taskId), `${turnId}.json`);
  }

  /** Per-agent temporary workspace directories live here. */
  taskWorkspacesRoot(taskId: string): string {
    return resolve(this.taskRoot(taskId), 'workspaces');
  }

  /** workspaces/<agentId>/ — the agent id must be a single safe segment. */
  taskWorkspaceRoot(taskId: string, agentId: string): string {
    assertSafeSegment('agentId', agentId);
    return resolve(this.taskWorkspacesRoot(taskId), agentId);
  }

  /** structured-slots/ root under the task root (spec §7.1). */
  taskStructuredSlotsRoot(taskId: string): string {
    return resolve(this.taskRoot(taskId), 'structured-slots');
  }

  /** structured-slots/v2/ — root of the authoritative review protocol v2 (spec §8). */
  taskStructuredV2Root(taskId: string): string {
    return resolve(this.taskStructuredSlotsRoot(taskId), 'v2');
  }

  /** structured-slots/v2/blobs/ — immutable content-addressed v2 blobs (spec §8). */
  taskStructuredV2BlobsRoot(taskId: string): string {
    return resolve(this.taskStructuredV2Root(taskId), 'blobs');
  }

  /** blobs/<kind>/<first2>/<digest> (spec §8) — the 64-hex digest is the filename. */
  taskStructuredV2BlobFile(taskId: string, kind: string, digest: string): string {
    assertSafeSegment('kind', kind);
    if (!STRUCTURED_SHA256.test(digest)) {
      throw new CorePathError('digest');
    }
    return resolve(this.taskStructuredV2BlobsRoot(taskId), kind, digest.slice(0, 2), digest);
  }

  /** structured-slots/blobs/ — content-addressed immutable blobs. */
  taskStructuredBlobsRoot(taskId: string): string {
    return resolve(this.taskStructuredSlotsRoot(taskId), 'blobs');
  }

  /** blobs/<first2>/<sha256>.json — the full 64-hex digest is the filename. */
  taskStructuredBlobFile(taskId: string, sha256: string): string {
    if (!STRUCTURED_SHA256.test(sha256)) {
      throw new CorePathError('sha256');
    }
    return resolve(this.taskStructuredBlobsRoot(taskId), sha256.slice(0, 2), `${sha256}.json`);
  }

  /** structured-slots/generations/ — one indexed generation per id. */
  taskStructuredGenerationsRoot(taskId: string): string {
    return resolve(this.taskStructuredSlotsRoot(taskId), 'generations');
  }

  /** generations/<generationId>/ — the id must be a single safe segment. */
  taskStructuredGenerationRoot(taskId: string, generationId: string): string {
    assertSafeSegment('generationId', generationId);
    return resolve(this.taskStructuredGenerationsRoot(taskId), generationId);
  }

  taskStructuredGenerationManifestFile(taskId: string, generationId: string): string {
    return resolve(this.taskStructuredGenerationRoot(taskId, generationId), 'manifest.json');
  }

  taskStructuredGenerationSlotsFile(taskId: string, generationId: string): string {
    return resolve(this.taskStructuredGenerationRoot(taskId, generationId), 'slots.ndjson');
  }

  taskStructuredGenerationIndexFile(taskId: string, generationId: string): string {
    return resolve(this.taskStructuredGenerationRoot(taskId, generationId), 'index.json');
  }

  /** structured-slots/content-revisions/ — content-addressed revision roots. */
  taskStructuredContentRevisionsRoot(taskId: string): string {
    return resolve(this.taskStructuredSlotsRoot(taskId), 'content-revisions');
  }

  /** content-revisions/<revisionDigest>.json — the digest is the filename. */
  taskStructuredContentRevisionFile(taskId: string, revisionDigest: string): string {
    if (!STRUCTURED_SHA256.test(revisionDigest)) {
      throw new CorePathError('revisionDigest');
    }
    return resolve(this.taskStructuredContentRevisionsRoot(taskId), `${revisionDigest}.json`);
  }

  /** structured-slots/proposals/ — one private journal dir per proposal. */
  taskStructuredProposalsRoot(taskId: string): string {
    return resolve(this.taskStructuredSlotsRoot(taskId), 'proposals');
  }

  taskStructuredProposalRoot(taskId: string, proposalId: string): string {
    assertSafeSegment('proposalId', proposalId);
    return resolve(this.taskStructuredProposalsRoot(taskId), proposalId);
  }

  taskStructuredProposalJournalFile(taskId: string, proposalId: string): string {
    return resolve(this.taskStructuredProposalRoot(taskId, proposalId), 'journal.ndjson');
  }

  taskStructuredProposalCheckpointFile(taskId: string, proposalId: string): string {
    return resolve(this.taskStructuredProposalRoot(taskId, proposalId), 'checkpoint.json');
  }

  /** Optional post-batch lifecycle cache marker (design §18.3), never authority. */
  taskStructuredProposalLifecycleFile(taskId: string, proposalId: string): string {
    return resolve(this.taskStructuredProposalRoot(taskId, proposalId), 'lifecycle.json');
  }

  /** structured-slots/drafts/ — one private journal dir per draft. */
  taskStructuredDraftsRoot(taskId: string): string {
    return resolve(this.taskStructuredSlotsRoot(taskId), 'drafts');
  }

  taskStructuredDraftRoot(taskId: string, draftId: string): string {
    assertSafeSegment('draftId', draftId);
    return resolve(this.taskStructuredDraftsRoot(taskId), draftId);
  }

  taskStructuredDraftJournalFile(taskId: string, draftId: string): string {
    return resolve(this.taskStructuredDraftRoot(taskId, draftId), 'journal.ndjson');
  }

  taskStructuredDraftCheckpointFile(taskId: string, draftId: string): string {
    return resolve(this.taskStructuredDraftRoot(taskId, draftId), 'checkpoint.json');
  }

  /** Optional post-batch lifecycle cache marker (design §18.3), never authority. */
  taskStructuredDraftLifecycleFile(taskId: string, draftId: string): string {
    return resolve(this.taskStructuredDraftRoot(taskId, draftId), 'lifecycle.json');
  }

  /** structured-slots/attempts/ — one persistent meter snapshot per turn. */
  taskStructuredAttemptsRoot(taskId: string): string {
    return resolve(this.taskStructuredSlotsRoot(taskId), 'attempts');
  }

  /** attempts/<turnId>/meter.json — the turn id must be a single safe segment. */
  taskStructuredAttemptMeterFile(taskId: string, turnId: string): string {
    assertSafeSegment('turnId', turnId);
    return resolve(this.taskStructuredAttemptsRoot(taskId), turnId, 'meter.json');
  }

  /** structured-slots/custody/ — sealed artifact custody namespace. */
  taskStructuredCustodyRoot(taskId: string): string {
    return resolve(this.taskStructuredSlotsRoot(taskId), 'custody');
  }

  /* ---------------------------------------------------------------- */
  /* Task 8: data-root-scoped v2 publication pins, store lock, fence   */
  /* record and GC generation counter (design §19.1, spec §8/§8.1)     */
  /* ---------------------------------------------------------------- */

  /** publication-pins/ — one durable pin file per publication. */
  publicationPinsRoot(): string {
    return resolve(this.dataRoot, 'publication-pins');
  }

  /** publication-pins/<pinId>.json — the pin id must be a safe segment. */
  publicationPinFile(pinId: string): string {
    assertSafeSegment('pinId', pinId);
    return resolve(this.publicationPinsRoot(), `${pinId}.json`);
  }

  /**
   * Cross-process exclusive store lock: an atomic `mkdir`-based lock
   * directory. Existence of the directory means the lock is held.
   */
  storeLockDir(): string {
    return resolve(this.dataRoot, '.store-lock');
  }

  /**
   * Durable fencing record of the current lock owner (owner PID, process
   * start token, lease epoch, acquisition nonce, durable generation). Written
   * and fsynced before the lock directory is removed/created; takeover must
   * prove the recorded owner is dead and atomically advance the epoch.
   */
  storeFenceRecordFile(): string {
    return resolve(this.dataRoot, '.store-lock-record.json');
  }

  /** Durable monotonic GC/publication generation counter (spec §8/§8.1). */
  v2GenerationFile(): string {
    return resolve(this.dataRoot, '.v2-generation.json');
  }

  /**
   * Durable per-installation boot identity used by the store lock fence: a
   * fence record from a previous boot session is provably dead even when its
   * PID is (re)used by a live process (design §19.1 epoch takeover rules).
   */
  storeBootIdFile(): string {
    return resolve(this.dataRoot, '.store-boot-id.json');
  }
}
