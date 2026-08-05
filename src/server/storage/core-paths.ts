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
  const match = EVENT_FILE_NAME.exec(fileName);
  if (match === null) {
    return null;
  }
  return { sequence: Number(match[1]), eventId: match[2] };
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
    if (!EVENT_FILE_NAME.test(fileName)) {
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
}
