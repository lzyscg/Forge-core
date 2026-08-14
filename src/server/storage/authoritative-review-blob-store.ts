/**
 * Task 6 authoritative review blob store — per-task canonical BlobRefV2
 * storage (spec §7.1/§8, design §19.1).
 *
 * Every v2 object is an immutable, content-addressed blob under the task root:
 * `structured-slots/v2/blobs/<kind>/<first2>/<digest>` (first2 = first two hex
 * chars of the lowercase SHA-256 of the exact canonical bytes; the digest is
 * the filename). The kind, media type, schema version, strict parser,
 * child-ref extractor and max-bytes policy all come from the Task 3 closed
 * registry (`object-registry.ts`) — this store adds no schema of its own.
 *
 * Visibility follows put-before-append (§8): a caller publishes the blob
 * BEFORE any event may reference it. No pins, no generation barrier, no GC
 * here — those land in Task 8.
 *
 * Fail-closed rules implemented here:
 * - Same-ref idempotency: if the exact bytes already exist at the address, the
 *   same ref is returned and nothing is rewritten.
 * - Same digest at the address with DIFFERENT bytes is storage corruption
 *   (TASK_CORRUPTED) — never last-writer-wins, never an overwrite.
 * - A missing, byte-length-mismatched, not-JSON, schema-invalid or
 *   ref-mismatching blob fails closed as TASK_CORRUPTED; a read never returns
 *   partial data.
 * - Wrong kind/media/schema/size at put time is rejected as INVALID_INPUT
 *   before any byte lands on disk.
 * - Task/path containment: task ids and kinds are validated as safe path
 *   segments by CorePaths; digests must be lowercase 64-hex.
 *
 * The profile parameter is the task-bound frozen profile the caller resolves
 * (Task 5 module / Task 11 archive seam). `profile_snapshot` deliberately
 * sizes against the registry's profile-independent bootstrap maximum instead.
 *
 * Durable parent-directory fsync after rename is a Task 8 atomic-file upgrade;
 * the writes here use the existing same-filesystem atomic primitives.
 */
import { readFile } from 'node:fs/promises';
import type { CorePaths } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomic } from './atomic-file';
import { canonicalJsonBytesAndSha256 } from '../structured-slots/canonical-json';
import {
  assertNoSelfReference,
  childRefsForBlob,
  isRegisteredKind,
  maxBytesForBlob,
  mediaTypeOf,
  parseBlob,
  schemaVersionOf,
} from '../authoritative-review/object-registry';
import { assertBlobRef, SchemaError } from '../authoritative-review/authority-types';
import type { AuthoritativeReviewProfile } from '../authoritative-review/authority-types';
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../shared/authoritative-review-v2';

/**
 * Stable closure identity of one ref: `<kind>:<digest>`. Two refs with equal
 * semantic/root digests but different BlobRef digests map to different keys.
 */
export function refKey(ref: BlobRefV2): string {
  return `${ref.kind}:${ref.digest}`;
}

/**
 * Result of `resolveClosure`: every resolved object and every resolved ref
 * identity (roots + registered child refs, walked recursively), keyed by
 * `refKey`. Objects with equal semantic/root digests but different BlobRef
 * digests are distinct entries; a shared child resolves once.
 */
export interface ResolvedClosure {
  objects: ReadonlyMap<string, unknown>;
  refs: ReadonlySet<string>;
}

function corrupt(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    message,
    null,
    '修复或重建该任务。',
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

export class AuthoritativeReviewBlobStore {
  private readonly paths: CorePaths;

  private readonly profile: AuthoritativeReviewProfile;

  constructor(paths: CorePaths, profile: AuthoritativeReviewProfile) {
    this.paths = paths;
    this.profile = profile;
  }

  /**
   * Canonicalize `value` under `kind`, validate it against the registry
   * (profile max-bytes, strict schema parse, embedded-ref/self-ref checks) and
   * durably write it at `blobs/<kind>/<first2>/<digest>`. Identical bytes at
   * the address return the same ref without rewriting; different bytes at the
   * same address fail closed as corruption.
   */
  async putJson<K extends AuthoritativeBlobKindV2>(
    taskId: string,
    kind: K,
    value: unknown,
  ): Promise<BlobRefV2> {
    if (!isRegisteredKind(kind)) {
      throw invalidInput(`未注册的 v2 blob kind '${kind}'。`);
    }
    const max = maxBytesForBlob(kind, this.profile);

    // One canonicalization + one UTF-8 encode + one hash (never canonicalize
    // the same payload twice in this module).
    let bytes: Buffer;
    let sha256: string;
    try {
      ({ bytes, sha256 } = canonicalJsonBytesAndSha256(value));
    } catch (error) {
      if ((error as { code?: string }).code === CANONICAL_JSON_INVALID) {
        throw invalidInput(`v2 blob ${kind} 载荷不可规范化: ${(error as Error).message}`);
      }
      throw error;
    }
    if (bytes.length > max) {
      throw invalidInput(`v2 blob ${kind} 超出该任务 profile 的大小上限 (${bytes.length} > ${max} 字节)。`);
    }

    // Full schema parse + embedded-ref checks, with the ref derived from the
    // bytes above cross-verified against the registry's own canonicalization.
    let stored: BlobRefV2;
    try {
      const pending: BlobRefV2 = {
        kind,
        digest: sha256,
        byteLength: bytes.length,
        mediaType: mediaTypeOf(kind),
        schemaVersion: schemaVersionOf(kind),
      };
      const parsed = parseBlob(kind, value, pending);
      assertNoSelfReference(kind, value);
      stored = parsed.ref;
    } catch (error) {
      if (error instanceof SchemaError || (error as { code?: string }).code === CANONICAL_JSON_INVALID) {
        throw invalidInput(`v2 blob ${kind} 校验失败: ${(error as Error).message}`);
      }
      throw error;
    }

    const destination = this.paths.taskStructuredV2BlobFile(taskId, kind, stored.digest);
    try {
      await writeNewAtomic(destination, bytes);
    } catch (error) {
      if ((error as StorageError).code === STORAGE_ERROR_CODES.FILE_EXISTS) {
        await this.assertSameAddressBytes(destination, bytes, kind);
      } else {
        throw error;
      }
    }
    return stored;
  }

  /**
   * Resolve `ref` and return the parsed object of exactly `expectedKind`.
   * Missing/mismatched/unparseable blobs fail closed as corruption; a
   * malformed ref argument is rejected as invalid input.
   */
  async readJson<T>(
    taskId: string,
    ref: BlobRefV2,
    expectedKind: AuthoritativeBlobKindV2,
  ): Promise<T> {
    const validated = this.assertRefShape(ref);
    if (validated.kind !== expectedKind) {
      throw corrupt(`v2 blob 引用 kind '${validated.kind}' 与期望 '${expectedKind}' 不一致。`);
    }
    const { object } = await this.readParsed(taskId, validated);
    return object as T;
  }

  /**
   * Recursively resolve `roots` and every registered child ref (fail-closed on
   * any missing/mismatched child). Returns the resolved object map and ref set
   * keyed by `refKey`.
   */
  async resolveClosure(taskId: string, roots: readonly BlobRefV2[]): Promise<ResolvedClosure> {
    const objects = new Map<string, unknown>();
    const refs = new Set<string>();
    const queue: BlobRefV2[] = roots.map((root) => this.assertRefShape(root));
    while (queue.length > 0) {
      const ref = queue.shift() as BlobRefV2;
      const key = refKey(ref);
      if (refs.has(key)) continue;
      refs.add(key);
      const { object } = await this.readParsed(taskId, ref);
      objects.set(key, object);
      let children: readonly BlobRefV2[];
      try {
        children = childRefsForBlob(ref.kind, object);
      } catch (error) {
        if (error instanceof SchemaError) {
          throw corrupt(`v2 blob ${ref.kind} 的子引用提取失败: ${error.message}`);
        }
        throw error;
      }
      queue.push(...children);
    }
    return { objects, refs };
  }

  /** Shape + registration validation of a caller-supplied ref (INVALID_INPUT). */
  private assertRefShape(ref: BlobRefV2): BlobRefV2 {
    let validated: BlobRefV2;
    try {
      validated = assertBlobRef(ref, 'ref');
    } catch (error) {
      if (error instanceof SchemaError) {
        throw invalidInput(`v2 blob 引用格式无效: ${error.message}`);
      }
      throw error;
    }
    if (!isRegisteredKind(validated.kind)) {
      throw invalidInput(`v2 blob 引用携带未注册的 kind '${validated.kind}'。`);
    }
    return validated;
  }

  /** Same-digest-address reuse guard: exact byte equality or TASK_CORRUPTED. */
  private async assertSameAddressBytes(
    path: string,
    bytes: Buffer,
    kind: AuthoritativeBlobKindV2,
  ): Promise<void> {
    let existing: Buffer;
    try {
      existing = await readFile(path);
    } catch {
      throw corrupt(`v2 blob ${kind} 同一摘要地址的既有文件不可读，任务已损坏。`);
    }
    if (!existing.equals(bytes)) {
      throw corrupt(`v2 blob ${kind} 同一摘要地址存在不同字节，任务已损坏。`);
    }
  }

  /**
   * Read the file at the ref address and verify everything the ref asserts:
   * presence, exact byte length, parseable JSON, strict schema, and ref
   * equality with the canonical bytes (digest/media/schema/kind). Any
   * mismatch is TASK_CORRUPTED — partial data is never returned.
   */
  private async readParsed(
    taskId: string,
    ref: BlobRefV2,
  ): Promise<{ object: unknown; ref: BlobRefV2 }> {
    let file: Buffer;
    try {
      file = await readFile(this.paths.taskStructuredV2BlobFile(taskId, ref.kind, ref.digest));
    } catch {
      throw corrupt(`引用的 v2 blob (${ref.kind}:${ref.digest.slice(0, 12)}…) 缺失，任务已损坏。`);
    }
    if (file.length !== ref.byteLength) {
      throw corrupt('v2 blob 文件字节长度与引用 byteLength 不一致。');
    }
    let value: unknown;
    try {
      value = JSON.parse(file.toString('utf8'));
    } catch {
      throw corrupt('v2 blob 内容不是有效 JSON。');
    }
    try {
      return parseBlob(ref.kind, value, ref);
    } catch (error) {
      if (error instanceof SchemaError || (error as { code?: string }).code === CANONICAL_JSON_INVALID) {
        throw corrupt(`v2 blob 内容与引用不一致: ${(error as Error).message}`);
      }
      throw error;
    }
  }
}

/** Stable code of the canonical JSON rejection (canonical-json module). */
const CANONICAL_JSON_INVALID = 'CANONICAL_JSON_INVALID';