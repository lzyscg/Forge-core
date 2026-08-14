/**
 * Shared validation helpers of the per-kind blob schema parsers
 * (`object-schema-parsers-1/2`, assembled in `object-schemas.ts`). All
 * helpers stay pure; every rejection is a stable `SchemaError`.
 */
import {
  SchemaError,
  assertArray,
  assertBlobRef,
  assertBoolean,
  assertEnum,
  assertExactKeys,
  assertInteger,
  assertNonNegativeInteger,
  assertNullableBlobRef,
  assertOptionalInteger,
  assertOptionalString,
  assertRecord,
  assertRefArray,
  assertSha256Hex,
  assertString,
  assertStringArray,
  type ReviewEvidenceV2,
  type MapPositionNodeV2,
  type MapRelationV2,
} from './authority-types';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../shared/authoritative-review-v2';

export type R = Record<string, unknown>;
export const rec = (v: unknown, w: string): R => assertRecord(v, w);
export const str = (v: unknown, w: string): string => assertString(v, w);
export const oStr = (v: unknown, w: string): string | null => assertOptionalString(v, w);
export const int = (v: unknown, w: string): number => assertInteger(v, w);
export const onn = (v: unknown, w: string): number => assertNonNegativeInteger(v, w);
export const oInt = (v: unknown, w: string): number | null => assertOptionalInteger(v, w);
export const bl = (v: unknown, w: string): boolean => assertBoolean(v, w);
export const rf = (v: unknown, w: string): BlobRefV2 => assertBlobRef(v, w);
export const rfn = (v: unknown, w: string): BlobRefV2 | null => assertNullableBlobRef(v, w);
export const rfa = (v: unknown, w: string): BlobRefV2[] => assertRefArray(v, w);
export const ex = (o: R, ks: readonly string[], w: string): void => assertExactKeys(o, ks, w);
export const hx = (v: unknown, w: string): string => assertSha256Hex(v, w);
export const en = <T extends string>(v: unknown, allowed: readonly T[], w: string): T => assertEnum(v, allowed, w);
export const sa = (v: unknown, w: string): string[] => assertStringArray(v, w);

export const SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab';

/**
 * Self-digest rule: the trailing digest field covers the canonical object
 * minus itself. `record` is the NORMALIZED payload (without relying on the
 * raw input's key spread), `declared` the digest carried by the input.
 */
export function hs(record: object, declared: unknown, k: string, w: string): string {
  const expected = hx(declared, `${w}.${k}`);
  const copy = { ...record } as Record<string, unknown>;
  delete copy[k];
  const computed = canonicalJsonSha256(copy);
  if (expected !== computed) {
    throw new SchemaError(`${w}.${k} does not match canonical bytes minus that field`);
  }
  return expected;
}

export function rfKind(v: unknown, kind: AuthoritativeBlobKindV2, w: string): BlobRefV2 {
  const ref = rf(v, w);
  if (ref.kind !== kind) throw new SchemaError(`${w} must be a ${kind} ref, got '${ref.kind}'`);
  return ref;
}

export function rfKindN(v: unknown, kinds: readonly AuthoritativeBlobKindV2[], w: string): BlobRefV2 {
  const ref = rf(v, w);
  if (!kinds.includes(ref.kind)) {
    throw new SchemaError(`${w} must be one of ${kinds.join('|')}, got '${ref.kind}'`);
  }
  return ref;
}

export function rfaKind(v: unknown, kind: AuthoritativeBlobKindV2, w: string): BlobRefV2[] {
  return rfa(v, w).map((ref, i) => rfKind(ref, kind, `${w}[${i}]`));
}

export function assertSortedStrings(values: readonly string[], w: string): void {
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] >= values[i]) {
      throw new SchemaError(`${w} must be strictly sorted (canonical order)`);
    }
  }
}

export function assertRefsSortedByDigest(refs: readonly BlobRefV2[], w: string): void {
  for (let i = 1; i < refs.length; i++) {
    if (refs[i - 1].digest >= refs[i].digest) {
      throw new SchemaError(`${w} must be sorted by ref digest (canonical order)`);
    }
  }
}

export function assertPlainObject(value: unknown, w: string): R {
  const o = rec(value, w);
  for (const key of Object.keys(o)) {
    const v = o[key];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new SchemaError(`${w}.${key} is not a plain object`);
      }
    }
  }
  return o;
}

/** Frozen trigger order used by the custody-root canonical sort (design §9). */
export const TRIGGER_ORDER: readonly string[] = [
  'map_candidate_commit',
  'map_review_settlement',
  'map_activation',
  'content_commit',
  'review_settlement',
  'seal_input',
  'seal_output',
];

export function compareTrigger(a: string, b: string): number {
  return TRIGGER_ORDER.indexOf(a) - TRIGGER_ORDER.indexOf(b);
}

export function parseEvidenceList(value: unknown, w: string): readonly ReviewEvidenceV2[] {
  return assertArray(value, w).map((v, i) => {
    const o = rec(v, `${w}[${i}]`);
    ex(o, ['evidenceDigest', 'text', 'refs'], `${w}[${i}]`);
    const entry = {
      evidenceDigest: hx(o.evidenceDigest, `${w}[${i}].evidenceDigest`),
      text: str(o.text, `${w}[${i}].text`),
      refs: rfa(o.refs, `${w}[${i}].refs`),
    };
    assertRefsSortedByDigest(entry.refs, `${w}[${i}].refs`);
    return entry;
  });
}

export function parsePositionNodes(value: unknown, w: string): readonly MapPositionNodeV2[] {
  const nodes = assertArray(value, w).map((v, i) => {
    const o = rec(v, `${w}[${i}]`);
    ex(o, ['slotId', 'slotType', 'contentBearing', 'parentSlotId', 'documentOrder', 'siblingOrder', 'nodeSpecDigest'], `${w}[${i}]`);
    return {
      slotId: str(o.slotId, `${w}[${i}].slotId`),
      slotType: str(o.slotType, `${w}[${i}].slotType`),
      contentBearing: bl(o.contentBearing, `${w}[${i}].contentBearing`),
      parentSlotId: oStr(o.parentSlotId, `${w}[${i}].parentSlotId`),
      documentOrder: int(o.documentOrder, `${w}[${i}].documentOrder`),
      siblingOrder: int(o.siblingOrder, `${w}[${i}].siblingOrder`),
      nodeSpecDigest: str(o.nodeSpecDigest, `${w}[${i}].nodeSpecDigest`),
    };
  });
  const ids = nodes.map((n) => n.slotId);
  if (new Set(ids).size !== ids.length) throw new SchemaError(`${w} has duplicate slotId`);
  const roots = nodes.filter((n) => n.parentSlotId === null);
  if (roots.length !== 1) throw new SchemaError(`${w} must have exactly one root (parentSlotId null)`);
  const byId = new Map(nodes.map((n) => [n.slotId, n]));
  for (const n of nodes) {
    if (n.parentSlotId !== null && !byId.has(n.parentSlotId as string)) {
      throw new SchemaError(`${w}[${n.slotId}].parentSlotId references an unknown node`);
    }
  }
  return nodes;
}

export function parseMapRelations(value: unknown, w: string): readonly MapRelationV2[] {
  const relations = assertArray(value, w).map((v, i) => {
    const o = rec(v, `${w}[${i}]`);
    ex(o, ['relationId', 'typeId', 'fromSlotId', 'toSlotId', 'attributes', 'relationDigest'], `${w}[${i}]`);
    return {
      relationId: str(o.relationId, `${w}[${i}].relationId`),
      typeId: str(o.typeId, `${w}[${i}].typeId`),
      fromSlotId: str(o.fromSlotId, `${w}[${i}].fromSlotId`),
      toSlotId: str(o.toSlotId, `${w}[${i}].toSlotId`),
      attributes: assertPlainObject(o.attributes, `${w}[${i}].attributes`),
      relationDigest: str(o.relationDigest, `${w}[${i}].relationDigest`),
    };
  });
  const ids = relations.map((r) => r.relationId);
  if (new Set(ids).size !== ids.length) throw new SchemaError(`${w} has duplicate relationId`);
  for (const r of relations) {
    if (r.fromSlotId === r.toSlotId) throw new SchemaError(`${w}[${r.relationId}] is a self loop`);
  }
  return relations;
}

/**
 * Full relation-graph check shared by map blob parsers: endpoints must exist
 * in the node set, and the directed graph must be acyclic (design §10.3:
 * "平台禁止的环").
 */
export function checkRelationEndpointsAndCycles(
  relations: readonly MapRelationV2[],
  nodeIds: readonly string[],
  w: string,
): void {
  const ids = new Set(nodeIds);
  for (const r of relations) {
    if (!ids.has(r.fromSlotId)) throw new SchemaError(`${w}[${r.relationId}].fromSlotId is not a node`);
    if (!ids.has(r.toSlotId)) throw new SchemaError(`${w}[${r.relationId}].toSlotId is not a node`);
  }
  // directed cycle detection (DFS; relations are stored forward from->to)
  const out = new Map<string, string[]>();
  for (const r of relations) {
    const list = out.get(r.fromSlotId) ?? [];
    list.push(r.toSlotId);
    out.set(r.fromSlotId, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];
  for (const start of nodeIds) {
    if (done.has(start)) continue;
    stack.push(start);
    while (stack.length > 0) {
      const cur = stack[stack.length - 1];
      if (!visiting.has(cur)) visiting.add(cur);
      let advanced = false;
      for (const next of out.get(cur) ?? []) {
        if (visiting.has(next)) {
          throw new SchemaError(`${w} contains a directed cycle through '${next}'`);
        }
        if (!done.has(next)) {
          stack.push(next);
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        stack.pop();
        visiting.delete(cur);
        done.add(cur);
      }
    }
  }
}

/** Collect every embedded ref-shaped value in canonical JSON order. */
export function everyEmbeddedRef(value: unknown, out: BlobRefV2[]): void {
  if (Array.isArray(value)) {
    for (const v of value) everyEmbeddedRef(v, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const o = value as R;
  if (typeof o.kind === 'string' && typeof o.digest === 'string' && typeof o.byteLength === 'number') {
    out.push(assertBlobRef(o, 'embedded ref'));
    return;
  }
  for (const key of Object.keys(o)) everyEmbeddedRef(o[key], out);
}