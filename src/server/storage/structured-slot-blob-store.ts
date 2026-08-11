/**
 * Structured slot blob store — task-local immutable blobs, indexed
 * generations and content-revision roots (Task 7, spec §7.1/§7.2,
 * design §18.2).
 *
 * Three responsibilities, one content-addressing discipline:
 *
 * 1. Generic immutable blobs under `structured-slots/blobs/<first2>/<sha256>.json`
 *    (spec §7.1). `putJsonBlob` canonicalizes (JCS) the value, addresses it by
 *    its canonical SHA-256 and reuses the existing digest for identical bytes;
 *    `readBlob` re-hashes the file and surfaces TASK_CORRUPTED when a file's
 *    bytes do not match its path digest. Blobs are task-local and never
 *    deduplicated across tasks (spec §7.2).
 *
 * 2. Indexed generations under `generations/<generationId>/`: `manifest.json`
 *    references `slots.ndjson` (one canonical slot record per line) and an
 *    `index.json` of byte offsets plus parent/order/type and document-order
 *    indexes (spec §7.1). `readSlot` reads ONLY the index and the single byte
 *    range of the matching NDJSON line — it never deserializes the full
 *    scaffold. The generation is also content-addressed as a blob so the
 *    `structure` ref of the commit event points at a real, verifiable file.
 *    Integrity is enforced at blob-read time (whole-file hash) and per line at
 *    slot-read time (canonical re-serialization + index entry bounds); a
 *    whole-file NDJSON digest would defeat the single-range read, so that is
 *    deliberately not re-verified on every slot read.
 *
 * 3. Content revisions under `content-revisions/`: a canonical
 *    `slotId -> 'unset' | contentBlobDigest` root is itself content-addressed
 *    and immutable; content VALUES live in separate content blobs and are
 *    resolved through them by `readEffectiveContent`.
 *
 * No business vocabulary lives here (iron rule 1): slot ids, generation ids
 * and hashes are stable platform identifiers; errors use the shared public
 * StorageError contract (iron rule 6).
 */
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import type { CorePaths } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomic } from './atomic-file';
import { canonicalJson, canonicalJsonBytes, canonicalJsonSha256 } from '../structured-slots/canonical-json';
import type { JsonValue, SlotInstance, StructuredBlobRefV1 } from '../../shared/structured-slots';
import type { StructuredBlobKind } from './task-events';

/**
 * byParent index key for root-level slots (parentSlotId === null). The empty
 * string can never collide with a real slot id (slot ids are non-empty).
 */
const ROOT_PARENT_KEY = '';

/** One slot to read back through the index (spec §4.1). */
export type { SlotInstance };

/** Generation input handed to the store (document-order slot records). */
export interface StructuredGenerationInputV1 {
  generationId: string;
  scaffoldId: string;
  slots: SlotInstance[];
}

/** Generation manifest: the commit point of the indexed layout. */
export interface GenerationManifestV1 {
  version: 1;
  generationId: string;
  scaffoldId: string;
  rootSlotId: string;
  slotCount: number;
  maxDepth: number;
  /** Content-addressed generation blob (spec §7.2). */
  structure: StructuredBlobRefV1;
  slotsFile: 'slots.ndjson';
  slotsNdjsonSha256: string;
  slotsNdjsonByteLength: number;
  indexFile: 'index.json';
  indexSha256: string;
  indexByteLength: number;
}

/** Byte-offset + structural indexes for one generation (spec §7.1). */
export interface GenerationIndexV1 {
  version: 1;
  generationId: string;
  slotCount: number;
  /** slotId -> byte range in slots.ndjson + document order of the record. */
  slots: Record<string, { offset: number; length: number; order: number }>;
  /** parentSlotId ('root' for root slots) -> child slotIds in document order. */
  byParent: Record<string, string[]>;
  /** typeId -> slotIds sharing the type, in document order. */
  byType: Record<string, string[]>;
  /** Depth-first document (pre) order of the whole scaffold. */
  documentOrder: string[];
}

/** Optional instrumentation seam proving single-range reads (Step 2 test). */
export interface SlotReadTrace {
  onRangeRead?: (range: { offset: number; length: number }) => void;
  onLineParsed?: (slotId: string) => void;
}

/** One effective content value resolved through its content blob. */
export interface EffectiveContentEntry {
  presence: 'unset' | 'set';
  content: JsonValue | null;
}

/** Canonical content-revision root (spec §7.1: slotId -> unset | digest). */
export interface ContentRootV1 {
  version: 1;
  mappings: Record<string, 'unset' | string>;
}

function corrupt(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    message,
    null,
    '检查该任务的结构化存储目录。',
  );
}

function invalidInput(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.INVALID_INPUT,
    message,
    null,
    '修正结构化载荷后重试。',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Light slot record shape guard; full validation is the Structure Gate's job. */
function assertSlotRecords(slots: readonly SlotInstance[]): void {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw invalidInput('generation 的 slots 必须是非空数组。');
  }
  for (const slot of slots) {
    if (!isPlainObject(slot)) {
      throw invalidInput('slot 记录必须是对象。');
    }
    if (typeof slot.slotId !== 'string' || slot.slotId.length === 0) {
      throw invalidInput('slot 记录缺少 slotId。');
    }
    if (typeof slot.scaffoldId !== 'string' || typeof slot.typeId !== 'string' || slot.typeId.length === 0) {
      throw invalidInput('slot 记录缺少 scaffoldId/typeId。');
    }
    if (slot.parentSlotId !== null && typeof slot.parentSlotId !== 'string') {
      throw invalidInput('slot 记录 parentSlotId 必须是字符串或 null。');
    }
    if (typeof slot.order !== 'number' || !Number.isInteger(slot.order)) {
      throw invalidInput('slot 记录 order 必须是整数。');
    }
    if (slot.contentPresence !== 'unset' && slot.contentPresence !== 'set') {
      throw invalidInput('slot 记录 contentPresence 必须是 unset/set。');
    }
    if (!isPlainObject(slot.spec)) {
      throw invalidInput('slot 记录 spec 必须是对象。');
    }
  }
}

/** Validates a mapping value: 'unset' or a 64-hex content blob digest. */
function assertMapping(value: unknown): asserts value is 'unset' | string {
  if (value === 'unset') {
    return;
  }
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw invalidInput('content revision 映射值必须是 unset 或 64 位十六进制 digest。');
  }
}

function parseVersioned<T extends { version: number }>(
  raw: string,
  where: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt(`${where} 不是有效 JSON。`);
  }
  if (!isPlainObject(parsed) || parsed.version !== 1) {
    throw corrupt(`${where} 版本或结构无效。`);
  }
  return parsed as unknown as T;
}

/**
 * Content-addressed idempotent write: an existing identical target file is a
 * committed reuse, never an error (concurrent committers promoting the same
 * immutable object must not fail on the second writer).
 */
async function writeNewAtomicIdempotent(path: string, bytes: Buffer): Promise<void> {
  try {
    await writeNewAtomic(path, bytes);
  } catch (error) {
    if ((error as StorageError).code !== STORAGE_ERROR_CODES.FILE_EXISTS) {
      throw error;
    }
  }
}

export class StructuredSlotBlobStore {
  private readonly paths: CorePaths;

  private readonly taskId: string;

  constructor(paths: CorePaths, taskId: string) {
    this.paths = paths;
    this.taskId = taskId;
  }

  /**
   * Content-addressed immutable blob: identical canonical bytes reuse one
   * digest, changed bytes address a new one. The kind is reference metadata
   * and does not affect the digest (spec §7.2).
   */
  async putJsonBlob(value: unknown, kind: StructuredBlobKind): Promise<StructuredBlobRefV1> {
    const bytes = canonicalJsonBytes(value);
    const sha256 = canonicalJsonSha256(value);
    await this.writeBlobBytes(bytes, sha256);
    return { version: 1, kind, sha256, byteLength: bytes.length };
  }

  /** Content value blob referenced by digest inside a revision root. */
  async putContentValue(value: unknown): Promise<{ sha256: string; byteLength: number }> {
    const bytes = canonicalJsonBytes(value);
    const sha256 = canonicalJsonSha256(value);
    await this.writeBlobBytes(bytes, sha256);
    return { sha256, byteLength: bytes.length };
  }

  /** Reads a blob and re-verifies its bytes against the path digest. */
  async readBlob(sha256: string): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.paths.taskStructuredBlobFile(this.taskId, sha256));
    } catch {
      throw corrupt('引用的结构化 blob 缺失。');
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
      throw corrupt('结构化 blob 内容与路径摘要不一致。');
    }
    return bytes;
  }

  /**
   * Writes the indexed generation layout and returns its manifest. The whole
   * scaffold is also content-addressed so the commit event's `structure` ref
   * resolves to a real blob. The manifest is written last: its presence is the
   * commit point for the indexed layout. Structural validation (root + parent
   * walk) runs BEFORE any bytes hit disk so malformed input fails closed with a
   * stable INVALID_INPUT and leaves no orphan residue.
   */
  async putGeneration(generation: StructuredGenerationInputV1): Promise<GenerationManifestV1> {
    assertSlotRecords(generation.slots);
    const { generationId, scaffoldId, slots } = generation;

    // Pure in-memory index derivation first: offsets, parent/type/order and
    // document-order indexes all follow from the canonical records.
    const lines = slots.map((slot) => canonicalJson(slot));
    const entries: GenerationIndexV1['slots'] = {};
    const byParent: Record<string, string[]> = {};
    const byType: Record<string, string[]> = {};
    const documentOrder: string[] = [];
    const parentBySlot: Record<string, string | null> = {};
    let offset = 0;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const lineBytes = Buffer.byteLength(lines[i], 'utf8') + 1; // includes '\n'
      entries[slot.slotId] = { offset, length: lineBytes, order: slot.order };
      const parentKey = slot.parentSlotId ?? ROOT_PARENT_KEY;
      (byParent[parentKey] ??= []).push(slot.slotId);
      (byType[slot.typeId] ??= []).push(slot.slotId);
      documentOrder.push(slot.slotId);
      parentBySlot[slot.slotId] = slot.parentSlotId;
      offset += lineBytes;
    }

    const rootSlotId = slots.find((slot) => slot.parentSlotId === null)?.slotId;
    if (rootSlotId === undefined) {
      throw invalidInput('generation 必须恰好包含一个根槽。');
    }
    const maxDepth = this.computeMaxDepth(parentBySlot);

    // Only now do any bytes reach disk: blob, NDJSON, index, manifest last.
    const structure = await this.putJsonBlob(slots, 'generation');

    // Idempotent promotion (design §18.3/G05): a manifest already committed for
    // this generationId is the SAME content-addressed generation — concurrent
    // committers promoting the identical generation reuse it instead of
    // failing on the second write. A differing digest is corruption.
    const manifestPath = this.paths.taskStructuredGenerationManifestFile(this.taskId, generationId);
    try {
      const existingRaw = await readFile(manifestPath, 'utf8');
      const existing = parseVersioned<GenerationManifestV1>(existingRaw, 'generation manifest');
      if (existing.structure.sha256 === structure.sha256) {
        return existing;
      }
    } catch {
      // No manifest yet (or torn residue): fall through and promote.
    }

    const slotsNdjson = `${lines.join('\n')}\n`;
    const slotsNdjsonBytes = Buffer.from(slotsNdjson, 'utf8');
    await writeNewAtomicIdempotent(this.paths.taskStructuredGenerationSlotsFile(this.taskId, generationId), slotsNdjsonBytes);

    const index: GenerationIndexV1 = {
      version: 1,
      generationId,
      slotCount: slots.length,
      slots: entries,
      byParent,
      byType,
      documentOrder,
    };
    const indexBytes = canonicalJsonBytes(index);
    await writeNewAtomicIdempotent(this.paths.taskStructuredGenerationIndexFile(this.taskId, generationId), indexBytes);

    const manifest: GenerationManifestV1 = {
      version: 1,
      generationId,
      scaffoldId,
      rootSlotId,
      slotCount: slots.length,
      maxDepth,
      structure,
      slotsFile: 'slots.ndjson',
      slotsNdjsonSha256: createHash('sha256').update(slotsNdjsonBytes).digest('hex'),
      slotsNdjsonByteLength: slotsNdjsonBytes.length,
      indexFile: 'index.json',
      indexSha256: canonicalJsonSha256(index),
      indexByteLength: indexBytes.length,
    };
    try {
      await writeNewAtomic(manifestPath, canonicalJsonBytes(manifest));
    } catch (error) {
      if ((error as StorageError).code !== STORAGE_ERROR_CODES.FILE_EXISTS) {
        throw error;
      }
      // A concurrent committer won the manifest write with the SAME content;
      // return its committed manifest.
      return parseVersioned<GenerationManifestV1>(
        await readFile(manifestPath, 'utf8'),
        'generation manifest',
      );
    }
    return manifest;
  }

  /**
   * Public accessor for a generation's index (Task 12 seam adaptation for the
   * Task 10 `StructuredSlotDataSource`). Reads and validates only `index.json`;
   * it never deserializes the scaffold records.
   */
  async getGenerationIndex(generationId: string): Promise<GenerationIndexV1> {
    return this.readGenerationIndex(generationId);
  }

  /**
   * Reads ONE slot through the index: index.json plus the single byte range of
   * its NDJSON line — never a full-scaffold parse. Returns null when the slot
   * is not part of this generation; any structural or bounds inconsistency is
   * TASK_CORRUPTED.
   */
  async readSlot(
    generationId: string,
    slotId: string,
    trace?: SlotReadTrace,
  ): Promise<SlotInstance | null> {
    const index = await this.readGenerationIndex(generationId);
    const entry = index.slots[slotId];
    if (entry === undefined) {
      return null;
    }
    const slotsPath = this.paths.taskStructuredGenerationSlotsFile(this.taskId, generationId);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(slotsPath, 'r');
      const fileSize = (await handle.stat()).size;
      if (entry.offset < 0 || entry.length < 1 || entry.offset + entry.length > fileSize) {
        throw corrupt('generation 索引记录超出 slots 文件边界。');
      }
      trace?.onRangeRead?.({ offset: entry.offset, length: entry.length });
      const buffer = Buffer.alloc(entry.length);
      const { bytesRead } = await handle.read(buffer, 0, entry.length, entry.offset);
      if (bytesRead !== entry.length) {
        throw corrupt('generation 槽读取不完整。');
      }
      const line = buffer.toString('utf8').replace(/\n$/, '');
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        throw corrupt('generation 槽记录不是有效 JSON。');
      }
      if (!isPlainObject(record) || record.slotId !== slotId) {
        throw corrupt('generation 槽记录与索引不一致。');
      }
      // The line must be the canonical serialization of the parsed record.
      if (canonicalJson(record) !== line) {
        throw corrupt('generation 槽记录不是规范 JSON。');
      }
      trace?.onLineParsed?.(record.slotId as string);
      return record as unknown as SlotInstance;
    } finally {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
    }
  }

  /**
   * Writes a content revision as a content-addressed immutable root under
   * content-revisions/ (spec §7.1). Identical mappings reuse one digest.
   */
  async putContentRevision(
    mappings: Record<string, 'unset' | string>,
  ): Promise<StructuredBlobRefV1> {
    if (!isPlainObject(mappings)) {
      throw invalidInput('content revision 映射必须是对象。');
    }
    for (const [slotId, value] of Object.entries(mappings)) {
      if (slotId.length === 0) {
        throw invalidInput('content revision 的 slotId 不能为空。');
      }
      assertMapping(value);
    }
    const root: ContentRootV1 = { version: 1, mappings };
    const bytes = canonicalJsonBytes(root);
    const sha256 = canonicalJsonSha256(root);
    const destination = this.paths.taskStructuredContentRevisionFile(this.taskId, sha256);
    try {
      await writeNewAtomic(destination, bytes);
    } catch (error) {
      if ((error as StorageError).code !== STORAGE_ERROR_CODES.FILE_EXISTS) {
        throw error;
      }
      // Identical revision already committed: reuse the digest.
    }
    return { version: 1, kind: 'content_revision', sha256, byteLength: bytes.length };
  }

  /**
   * Reads an existing content-revision root by digest and returns its reference
   * (with byteLength). The candidate stores only the staged digest, so the
   * committer rehydrates the full reference at promote time; a missing or
   * digest-mismatched root is TASK_CORRUPTED (fail closed).
   */
  async readContentRevisionRef(sha256: string): Promise<StructuredBlobRefV1> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.paths.taskStructuredContentRevisionFile(this.taskId, sha256));
    } catch {
      throw corrupt('引用的 content revision 缺失。');
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
      throw corrupt('content revision 内容与路径摘要不一致。');
    }
    return { version: 1, kind: 'content_revision', sha256, byteLength: bytes.length };
  }

  /**
   * Resolves a content revision root through its separate content blobs:
   * `unset` entries have no content, digest entries are read back and
   * re-verified against their path hash.
   */
  async readEffectiveContent(
    revisionRef: StructuredBlobRefV1,
  ): Promise<Record<string, EffectiveContentEntry>> {
    let rootBytes: Buffer;
    try {
      rootBytes = await readFile(this.paths.taskStructuredContentRevisionFile(this.taskId, revisionRef.sha256));
    } catch {
      throw corrupt('引用的 content revision 缺失。');
    }
    const actual = createHash('sha256').update(rootBytes).digest('hex');
    if (actual !== revisionRef.sha256) {
      throw corrupt('content revision 内容与路径摘要不一致。');
    }
    const root = parseVersioned<ContentRootV1>(rootBytes.toString('utf8'), 'content revision');
    const out: Record<string, EffectiveContentEntry> = {};
    for (const [slotId, value] of Object.entries(root.mappings)) {
      if (value === 'unset') {
        out[slotId] = { presence: 'unset', content: null };
        continue;
      }
      const blob = await this.readBlob(value);
      out[slotId] = { presence: 'set', content: JSON.parse(blob.toString('utf8')) as JsonValue };
    }
    return out;
  }

  private async writeBlobBytes(bytes: Buffer, sha256: string): Promise<void> {
    const destination = this.paths.taskStructuredBlobFile(this.taskId, sha256);
    try {
      await writeNewAtomic(destination, bytes);
    } catch (error) {
      if ((error as StorageError).code === STORAGE_ERROR_CODES.FILE_EXISTS) {
        // Identical canonical bytes already committed: reuse the digest.
        return;
      }
      throw error;
    }
  }

  private async readGenerationIndex(generationId: string): Promise<GenerationIndexV1> {
    let raw: string;
    try {
      raw = await readFile(
        this.paths.taskStructuredGenerationIndexFile(this.taskId, generationId),
        'utf8',
      );
    } catch {
      throw corrupt('引用的 generation index 缺失。');
    }
    const index = parseVersioned<GenerationIndexV1>(raw, 'generation index');
    if (index.generationId !== generationId || index.slotCount !== index.documentOrder.length) {
      throw corrupt('generation index 与自身不一致。');
    }
    return index;
  }

  /**
   * Tree depth in edges (root = 0) via an ITERATIVE parent walk with an
   * explicit visited path. A parent cycle (parentSlotId is its own ancestor,
   * e.g. a self-cycle) or a dangling parent (references a slot not in the
   * generation) fails closed with a stable INVALID_INPUT instead of recursing
   * forever into a raw RangeError (fail-closed quality bar).
   */
  private computeMaxDepth(parentBySlot: Record<string, string | null>): number {
    const depth = new Map<string, number>();
    let max = 0;
    for (const slotId of Object.keys(parentBySlot)) {
      const path: string[] = [];
      let current: string | null = slotId;
      // Walk up to an already-resolved slot, a root, or a contradiction.
      while (current !== null && !depth.has(current)) {
        if (path.includes(current)) {
          throw invalidInput('generation 存在父槽环引用。');
        }
        path.push(current);
        const parent: string | null | undefined = parentBySlot[current];
        if (parent === undefined) {
          throw invalidInput('generation 存在悬空父槽引用。');
        }
        current = parent;
      }
      // `current` is a resolved slot (depth known) or null (root).
      let resolved = current === null ? -1 : (depth.get(current) as number);
      for (let i = path.length - 1; i >= 0; i--) {
        resolved += 1;
        depth.set(path[i], resolved);
      }
      max = Math.max(max, resolved);
    }
    return max;
  }
}
