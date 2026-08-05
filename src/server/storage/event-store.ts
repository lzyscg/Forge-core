/**
 * Append-only committed event store (plan Phase B Task 3; tightened to the
 * canonical task event union in plan Phase B Task 4).
 *
 * One committed event = one immutable file `events/<six-digit-sequence>-<event-id>.json`
 * (spec §8.1): a torn tail can never poison the whole history. The single
 * process allocates the next sequence by scanning committed filenames
 * (ignoring `.tmp-*` residue and malformed names), validates every payload
 * against the canonical union in `task-events.ts` before writing, and
 * serializes appends per task through a mutex queue so concurrent callers can
 * never race a sequence. A duplicate event id is idempotent only when its
 * canonical JSON bytes match the committed copy — anything else is an
 * EVENT_ID_CONFLICT. Reading re-validates every committed file: malformed
 * JSON, payloads outside the canonical union and sequence gaps all fail loud
 * (TASK_CORRUPTED); isolating them into a diagnostic summary is the
 * projector's job in plan Task 4 (spec §8.3).
 *
 * No business vocabulary lives here (iron rule 1): the union member names are
 * stable platform identifiers; semantic folding belongs to the projection.
 */
import { readdir, readFile } from 'node:fs/promises';
import type { CorePaths } from './core-paths';
import { parseEventFileName } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomic } from './atomic-file';
import { validateTaskEvent, type TaskEvent } from './task-events';

const TMP_PREFIX = '.tmp-';

/** One committed event plus the on-disk metadata projections need. */
export interface CommittedEvent {
  sequence: number;
  fileName: string;
  /** Byte length of the committed canonical JSON file. */
  size: number;
  event: TaskEvent;
}

function corrupt(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    message,
    null,
    '检查该任务的本地事件目录。',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Deterministic JSON: object keys sorted recursively. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      ordered[key] = canonicalize(value[key]);
    }
    return ordered;
  }
  return value;
}

function canonicalJson(event: TaskEvent): string {
  return JSON.stringify(canonicalize(event));
}

interface ScannedEvent extends CommittedEvent {
  canonical: string;
}

/**
 * Reads and validates one committed file. Malformed JSON, a payload outside
 * the canonical union, or a filename/payload id mismatch all fail loud: the
 * store never guesses over damaged history.
 */
async function readCommittedFile(
  eventsRoot: string,
  fileName: string,
  parsed: { sequence: number; eventId: string },
): Promise<ScannedEvent> {
  let bytes: Buffer;
  try {
    bytes = await readFile(`${eventsRoot}/${fileName}`);
  } catch {
    throw corrupt('已提交事件文件不可读。');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw corrupt('已提交事件文件不是有效 JSON。');
  }
  if (!isPlainObject(value) || typeof value.id !== 'string') {
    throw corrupt('已提交事件缺少 id。');
  }
  if (value.id !== parsed.eventId) {
    throw corrupt('已提交事件文件名与事件 id 不一致。');
  }
  let event: TaskEvent;
  try {
    event = validateTaskEvent(value);
  } catch {
    throw corrupt('已提交事件未通过规范事件校验。');
  }
  return {
    sequence: parsed.sequence,
    fileName,
    size: bytes.length,
    event,
    canonical: canonicalJson(event),
  };
}

export class EventStore {
  private readonly paths: CorePaths;

  /** Per-task append/read serialization within this single process. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(paths: CorePaths) {
    this.paths = paths;
  }

  /**
   * Appends one committed event to the task history after validating it
   * against the canonical union (invalid payloads never touch the filesystem
   * and never advance the sequence). Duplicate ids replay the prior commit
   * when canonical bytes match; conflicting bytes fail.
   */
  async append(taskId: string, event: TaskEvent): Promise<CommittedEvent> {
    const validated = validateTaskEvent(event);
    return this.enqueue(taskId, () => this.appendExclusive(taskId, validated));
  }

  /** Returns committed events in sequence order; unknown tasks read empty. */
  read(taskId: string): Promise<CommittedEvent[]> {
    return this.enqueue(taskId, async () =>
      (await this.scanCommitted(taskId)).map(({ canonical: _canonical, ...committed }) => committed),
    );
  }

  /** Runs work behind the per-task mutex; failures never jam the queue. */
  private enqueue<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.queues.set(
      taskId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async appendExclusive(taskId: string, event: TaskEvent): Promise<CommittedEvent> {
    const canonical = canonicalJson(event);
    const committed = await this.scanCommitted(taskId);
    const prior = committed.find((entry) => entry.event.id === event.id);
    if (prior !== undefined) {
      if (prior.canonical !== canonical) {
        throw new StorageError(
          STORAGE_ERROR_CODES.EVENT_ID_CONFLICT,
          '同一事件 id 提交了不同的内容。',
          null,
          '使用新的事件 id 追加新事件。',
        );
      }
      const { canonical: _canonical, ...replay } = prior;
      return replay;
    }
    const sequence = (committed[committed.length - 1]?.sequence ?? 0) + 1;
    const fileName = `${String(sequence).padStart(6, '0')}-${event.id}.json`;
    const bytes = Buffer.from(canonical, 'utf8');
    await writeNewAtomic(this.paths.taskEventFile(taskId, fileName), bytes);
    const { canonical: _canonical, ...result } = {
      sequence,
      fileName,
      size: bytes.length,
      event,
      canonical,
    };
    return result;
  }

  /**
   * Scans committed event files from disk on every access: the plan allocates
   * sequences "after scanning committed filenames", and rescanning also makes
   * out-of-band damage (corruption while the server is stopped, spec §8.3)
   * fail loud on the very next access instead of hiding behind a cache.
   * Committed sequences must form a contiguous run starting at 1; duplicates
   * and gaps both fail loud as corruption.
   */
  private async scanCommitted(taskId: string): Promise<ScannedEvent[]> {
    const eventsRoot = this.paths.taskEventsRoot(taskId);
    let names: string[];
    try {
      names = await readdir(eventsRoot);
    } catch {
      return [];
    }
    const scanned: ScannedEvent[] = [];
    for (const name of names) {
      if (name.startsWith(TMP_PREFIX)) {
        continue; // Temporary residue never counts as committed (spec §8.2).
      }
      const parsed = parseEventFileName(name);
      if (parsed === null) {
        continue; // Malformed names are ignored, never projected.
      }
      scanned.push(await readCommittedFile(eventsRoot, name, parsed));
    }
    scanned.sort((a, b) => a.sequence - b.sequence);
    for (let index = 0; index < scanned.length; index += 1) {
      if (scanned[index]?.sequence !== index + 1) {
        throw corrupt('已提交事件序列不连续。');
      }
    }
    return scanned;
  }
}
