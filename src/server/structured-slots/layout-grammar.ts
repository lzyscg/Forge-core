/**
 * Deterministic LayoutGrammar v1 compiler + single-pass matcher
 * (design §8.6/§8.6.1/§8.6.2, spec §4.3, design §25.5 F03/F04).
 *
 * The compiler reads only the structured production AST (slot / sequence /
 * choice / optional / repeat / empty) and never business vocabulary. It:
 *
 * - validates every node (six closed kinds, exact fields, legal cardinalities)
 *   and resolves rootType, every production key and every `slot.type` into the
 *   declared type set;
 * - rejects `empty` anywhere except as the whole children of a production;
 * - rejects nullable `repeat.item` (LAYOUT_GRAMMAR_NULLABLE_REPEAT);
 * - proves termination (design §8.6.1): a least fixed point over the type
 *   dependency graph marks every type that can yield at least one finite,
 *   complete subtree; every type reachable from rootType must be generatable,
 *   otherwise LAYOUT_GRAMMAR_NON_TERMINATING. Unreachable productions are
 *   rejected separately and never used to hide a non-generatable type;
 * - proves static determinism (design §8.6.2): nullable / min | max
 *   consumption / FIRST / FOLLOW (with an EOF production-end marker that is
 *   never a typeId), rejecting nullable choice branches, pairwise-overlapping
 *   choice FIRST, nullable optional items or optional FIRST/FOLLOW conflicts,
 *   and (for min < max) repeat FIRST/FOLLOW conflicts;
 * - bounds every production's max consumption by
 *   `limits.structure.maxChildrenPerSlot`;
 * - returns an immutable, deep-frozen compiled structure exposing the exact
 *   normalized AST and the per-production static summary.
 *
 * `matchProduction` is the Structure Gate primitive: one pass, left to right,
 * no backtracking. At choice/optional/repeat boundaries it decides only from
 * the next child typeId (or EOF when children are exhausted); it never
 * inspects a farther child and never prefers declaration order. On the first
 * failure it returns exactly one bounded STRUCTURE_PRODUCTION_MISMATCH issue
 * placed at the matching entry of the `locations` argument.
 */
import type {
  IssueLocation,
  JsonObject,
  StructuredIssueV1,
  StructuredSlotLimitsV1,
} from '../../shared/structured-slots';
import { makeStructuredIssue } from './issues';

/** The six closed LayoutGrammar v1 node kinds (design §8.6 / spec §4.3). */
export type GrammarNode =
  | { kind: 'slot'; type: string }
  | { kind: 'sequence'; items: GrammarNode[] }
  | { kind: 'choice'; items: GrammarNode[] }
  | { kind: 'optional'; item: GrammarNode }
  | { kind: 'repeat'; min: number; max: number; item: GrammarNode }
  | { kind: 'empty' };

/** Author-facing LayoutGrammar v1 shape (spec §4.3). */
export interface LayoutGrammarV1 {
  rootType: string;
  productions: Record<string, { children: GrammarNode }>;
}

/**
 * Immutable compiled production: the exact normalized children AST plus the
 * static summary the Structure Gate consumes. `first` is the set of typeIds
 * this production can consume first.
 */
export interface CompiledProductionV1 {
  readonly children: GrammarNode;
  readonly nullable: boolean;
  readonly minConsumption: number;
  readonly maxConsumption: number;
  readonly first: ReadonlySet<string>;
  readonly generatable: boolean;
}

/** Immutable compiled grammar; safe to reuse across many matches (deep-frozen). */
export interface CompiledLayoutGrammarV1 {
  readonly rootType: string;
  readonly productions: Readonly<Record<string, CompiledProductionV1>>;
  /** @internal per-production matching tree (immutable after compile). */
  readonly _match: Readonly<Record<string, MatchNode>>;
}

/** EOF production-end marker; never a template-referencable typeId. */
const EOF_SENTINEL: unique symbol = Symbol('layout-grammar-eof');
type FollowSet = ReadonlySet<string | typeof EOF_SENTINEL>;

/** Internal per-node analysis tree used by the matcher and static checks. */
interface MatchNode {
  kind: GrammarNode['kind'];
  type?: string; // slot
  items?: MatchNode[]; // sequence / choice
  item?: MatchNode; // optional / repeat
  min?: number; // repeat
  max?: number; // repeat
  nullable: boolean;
  minConsumption: number;
  maxConsumption: number;
  first: ReadonlySet<string>;
  follow: FollowSet;
}

type MatchResult = { ok: true; pos: number } | { ok: false; pos: number; expected: JsonObject };

function nodeInvalid(reason: string): never {
  throw new Error(`LAYOUT_GRAMMAR_NODE_INVALID: ${reason}`);
}
function referenceUnknown(reason: string): never {
  throw new Error(`LAYOUT_GRAMMAR_REFERENCE_UNKNOWN: ${reason}`);
}
function productionUnreachable(reason: string): never {
  throw new Error(`LAYOUT_GRAMMAR_PRODUCTION_UNREACHABLE: ${reason}`);
}
function nullableRepeat(reason: string): never {
  throw new Error(`LAYOUT_GRAMMAR_NULLABLE_REPEAT: ${reason}`);
}
function nonTerminating(reason: string): never {
  throw new Error(`LAYOUT_GRAMMAR_NON_TERMINATING: ${reason}`);
}
function choiceAmbiguous(reason: string): never {
  throw new Error(`LAYOUT_GRAMMAR_CHOICE_AMBIGUOUS: ${reason}`);
}
function optionalFollowConflict(reason: string): never {
  throw new Error(`LAYOUT_GRAMMAR_OPTIONAL_FOLLOW_CONFLICT: ${reason}`);
}
function repeatFollowConflict(reason: string): never {
  throw new Error(`LAYOUT_GRAMMAR_REPEAT_FOLLOW_CONFLICT: ${reason}`);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function rejectUnknownFields(record: JsonObject, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) nodeInvalid(`unknown field '${key}' on node at ${where}`);
  }
}

function unionInto(target: Set<string>, source: ReadonlySet<string>): void {
  for (const item of source) target.add(item);
}

function setsOverlap(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
  for (const item of a) if (b.has(item)) return true;
  return false;
}

/**
 * Validate one node bottom-up, resolve its slot references, and compute its
 * nullable / min | max consumption / FIRST. Nested `empty` nodes are rejected
 * here; nullable `repeat.item` is rejected at the repeat node.
 */
function normalizeNode(raw: unknown, where: string, typeIds: ReadonlySet<string>): MatchNode {
  if (!isPlainObject(raw)) nodeInvalid(`node at ${where} must be a plain object`);
  const record = raw;
  const kind = record['kind'];
  if (typeof kind !== 'string') nodeInvalid(`node at ${where} is missing a string 'kind'`);

  switch (kind) {
    case 'slot': {
      rejectUnknownFields(record, ['kind', 'type'], where);
      const type = record['type'];
      if (!isNonEmptyString(type)) nodeInvalid(`slot.type at ${where} must be a non-empty string`);
      if (!typeIds.has(type)) referenceUnknown(`slot.type '${type}' at ${where} is not a declared type`);
      return {
        kind,
        type,
        nullable: false,
        minConsumption: 1,
        maxConsumption: 1,
        first: new Set([type]),
        follow: new Set(),
      };
    }
    case 'sequence': {
      rejectUnknownFields(record, ['kind', 'items'], where);
      const rawItems = record['items'];
      if (!Array.isArray(rawItems)) nodeInvalid(`sequence.items at ${where} must be an array`);
      if (rawItems.length < 1) nodeInvalid(`sequence.items at ${where} must contain at least one item`);
      const children = rawItems.map((item, i) => {
        const child = normalizeNode(item, `${where}/items/${i}`, typeIds);
        if (child.kind === 'empty') {
          nodeInvalid(`empty may only be the whole children of a production (nested at ${where}/items/${i})`);
        }
        return child;
      });
      const first = new Set<string>();
      for (const child of children) {
        unionInto(first, child.first);
        if (!child.nullable) break;
      }
      return {
        kind,
        items: children,
        nullable: children.every((c) => c.nullable),
        minConsumption: children.reduce((acc, c) => acc + c.minConsumption, 0),
        maxConsumption: children.reduce((acc, c) => acc + c.maxConsumption, 0),
        first,
        follow: new Set(),
      };
    }
    case 'choice': {
      rejectUnknownFields(record, ['kind', 'items'], where);
      const rawItems = record['items'];
      if (!Array.isArray(rawItems)) nodeInvalid(`choice.items at ${where} must be an array`);
      if (rawItems.length < 2) nodeInvalid(`choice.items at ${where} must contain at least two items`);
      const children = rawItems.map((item, i) => {
        const child = normalizeNode(item, `${where}/items/${i}`, typeIds);
        if (child.kind === 'empty') {
          nodeInvalid(`empty may only be the whole children of a production (nested at ${where}/items/${i})`);
        }
        return child;
      });
      const first = new Set<string>();
      for (const child of children) unionInto(first, child.first);
      return {
        kind,
        items: children,
        nullable: children.some((c) => c.nullable),
        minConsumption: Math.min(...children.map((c) => c.minConsumption)),
        maxConsumption: Math.max(...children.map((c) => c.maxConsumption)),
        first,
        follow: new Set(),
      };
    }
    case 'optional': {
      rejectUnknownFields(record, ['kind', 'item'], where);
      const rawItem = record['item'];
      if (rawItem === undefined) nodeInvalid(`optional.item at ${where} must be present`);
      const item = normalizeNode(rawItem, `${where}/item`, typeIds);
      if (item.kind === 'empty') {
        nodeInvalid(`empty may only be the whole children of a production (nested at ${where}/item)`);
      }
      return {
        kind,
        item,
        nullable: true,
        minConsumption: 0,
        maxConsumption: item.maxConsumption,
        first: new Set(item.first),
        follow: new Set(),
      };
    }
    case 'repeat': {
      rejectUnknownFields(record, ['kind', 'min', 'max', 'item'], where);
      const min = record['min'];
      const max = record['max'];
      if (!isNonNegativeSafeInteger(min)) nodeInvalid(`repeat.min at ${where} must be a non-negative safe integer`);
      if (!isNonNegativeSafeInteger(max) || max === 0) {
        nodeInvalid(`repeat.max at ${where} must be a positive safe integer`);
      }
      if (min > max) nodeInvalid(`repeat.min must not exceed repeat.max at ${where}`);
      const rawItem = record['item'];
      if (rawItem === undefined) nodeInvalid(`repeat.item at ${where} must be present`);
      const item = normalizeNode(rawItem, `${where}/item`, typeIds);
      if (item.kind === 'empty') {
        nodeInvalid(`empty may only be the whole children of a production (nested at ${where}/item)`);
      }
      if (item.nullable) nullableRepeat(`repeat.item at ${where} must not be nullable`);
      return {
        kind,
        min,
        max,
        item,
        nullable: min === 0,
        minConsumption: min * item.minConsumption,
        maxConsumption: max * item.maxConsumption,
        first: new Set(item.first),
        follow: new Set(),
      };
    }
    case 'empty': {
      rejectUnknownFields(record, ['kind'], where);
      return { kind, nullable: true, minConsumption: 0, maxConsumption: 0, first: new Set(), follow: new Set() };
    }
    default:
      nodeInvalid(`unknown node kind '${String(kind)}' at ${where}`);
  }
}

/** Rebuild the clean, exact normalized AST from an analyzed node. */
function cleanNode(node: MatchNode): GrammarNode {
  switch (node.kind) {
    case 'slot':
      return { kind: 'slot', type: node.type! };
    case 'empty':
      return { kind: 'empty' };
    case 'sequence':
    case 'choice':
      return { kind: node.kind, items: node.items!.map(cleanNode) };
    case 'optional':
      return { kind: 'optional', item: cleanNode(node.item!) };
    case 'repeat':
      return { kind: 'repeat', min: node.min!, max: node.max!, item: cleanNode(node.item!) };
  }
}

/** Bounded, platform-normalized summary of an expected node (design F04). */
function summarizeNode(node: GrammarNode): JsonObject {
  switch (node.kind) {
    case 'slot':
      return { kind: 'slot', type: node.type };
    case 'empty':
      return { kind: 'empty' };
    case 'sequence':
      return { kind: 'sequence', itemCount: node.items.length };
    case 'choice':
      return { kind: 'choice', itemCount: node.items.length };
    case 'optional':
      return { kind: 'optional' };
    case 'repeat':
      return { kind: 'repeat', min: node.min, max: node.max };
  }
}

function forEachSlotType(node: MatchNode, visit: (type: string) => void): void {
  switch (node.kind) {
    case 'slot':
      visit(node.type!);
      break;
    case 'sequence':
    case 'choice':
      for (const child of node.items!) forEachSlotType(child, visit);
      break;
    case 'optional':
    case 'repeat':
      forEachSlotType(node.item!, visit);
      break;
    case 'empty':
      break;
  }
}

/** Types whose production is reachable from rootType through slot references. */
function computeReachable(rootType: string, roots: Map<string, MatchNode>): Set<string> {
  const reachable = new Set<string>();
  const stack = [rootType];
  while (stack.length > 0) {
    const typeId = stack.pop()!;
    if (reachable.has(typeId)) continue;
    reachable.add(typeId);
    const root = roots.get(typeId);
    if (!root) continue;
    forEachSlotType(root, (ref) => {
      if (!reachable.has(ref)) stack.push(ref);
    });
  }
  return reachable;
}

/**
 * Least fixed point over the type dependency graph (design §8.6.1): a type is
 * generatable when its production can yield at least one finite, complete
 * subtree. Iteration converges because the domain is finite and monotone.
 */
function computeGeneratable(roots: Map<string, MatchNode>): Map<string, boolean> {
  const generatable = new Map<string, boolean>();
  for (const typeId of roots.keys()) generatable.set(typeId, false);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [typeId, root] of roots) {
      const value = nodeGeneratable(root, generatable);
      if (value !== generatable.get(typeId)) {
        generatable.set(typeId, value);
        changed = true;
      }
    }
  }
  return generatable;
}

function nodeGeneratable(node: MatchNode, generatable: Map<string, boolean>): boolean {
  switch (node.kind) {
    case 'empty':
      return true;
    case 'slot':
      return generatable.get(node.type!)!;
    case 'sequence':
      return node.items!.every((c) => nodeGeneratable(c, generatable));
    case 'choice':
      return node.items!.some((c) => nodeGeneratable(c, generatable));
    case 'optional':
      return true;
    case 'repeat':
      return node.min === 0 ? true : nodeGeneratable(node.item!, generatable);
  }
}

/**
 * Top-down FOLLOW propagation within one production. The production end is the
 * EOF marker; FOLLOW flows through nullable sequence suffixes, choice branches,
 * optional bodies and repeat bodies (where another occurrence adds FIRST).
 */
function computeFollows(node: MatchNode, follow: FollowSet): void {
  node.follow = new Set(follow);
  switch (node.kind) {
    case 'sequence': {
      const items = node.items!;
      let rest = new Set<string | typeof EOF_SENTINEL>(follow);
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        computeFollows(item, rest);
        const leftRest = new Set<string | typeof EOF_SENTINEL>(item.first);
        if (item.nullable) for (const f of rest) leftRest.add(f);
        rest = leftRest;
      }
      break;
    }
    case 'choice':
      for (const branch of node.items!) computeFollows(branch, follow);
      break;
    case 'optional':
      computeFollows(node.item!, node.follow);
      break;
    case 'repeat': {
      const item = node.item!;
      const itemFollow = new Set<string | typeof EOF_SENTINEL>(follow);
      // An occurrence can be non-last only when the repeat can iterate twice.
      if (node.max! >= 2) for (const f of item.first) itemFollow.add(f);
      computeFollows(item, itemFollow);
      break;
    }
    case 'slot':
    case 'empty':
      break;
  }
}

/** Static determinism checks (design §8.6.2), run after FOLLOW is known. */
function checkAmbiguity(node: MatchNode, where: string): void {
  switch (node.kind) {
    case 'choice': {
      const branches = node.items!;
      for (const branch of branches) {
        if (branch.nullable) choiceAmbiguous(`choice branch at ${where} must not be nullable`);
      }
      for (let i = 0; i < branches.length; i++) {
        for (let j = i + 1; j < branches.length; j++) {
          if (setsOverlap(branches[i].first, branches[j].first)) {
            choiceAmbiguous(`choice branches at ${where} have overlapping FIRST sets`);
          }
        }
      }
      break;
    }
    case 'optional': {
      const item = node.item!;
      if (item.nullable) optionalFollowConflict(`optional.item at ${where} must not be nullable`);
      if (setsOverlap(item.first, node.follow)) {
        optionalFollowConflict(`optional FIRST overlaps FOLLOW at ${where}`);
      }
      break;
    }
    case 'repeat': {
      const item = node.item!;
      // A nullable repeat.item is rejected earlier as LAYOUT_GRAMMAR_NULLABLE_REPEAT.
      if (node.min! < node.max! && setsOverlap(item.first, node.follow)) {
        repeatFollowConflict(`repeat FIRST overlaps FOLLOW at ${where}`);
      }
      break;
    }
    case 'slot':
    case 'empty':
      break;
  }
  if (node.kind === 'sequence' || node.kind === 'choice') {
    node.items!.forEach((child, i) => checkAmbiguity(child, `${where}/items/${i}`));
  } else if (node.kind === 'optional' || node.kind === 'repeat') {
    checkAmbiguity(node.item!, `${where}/item`);
  }
}

/**
 * Compile and validate a LayoutGrammar v1. Throws a LAYOUT_GRAMMAR_* error
 * (message contains the stable code) on any static failure, and returns an
 * immutable, deep-frozen `CompiledLayoutGrammarV1` on success.
 */
export function compileLayoutGrammarV1(
  grammar: LayoutGrammarV1,
  typeIds: ReadonlySet<string>,
  limits: StructuredSlotLimitsV1,
): CompiledLayoutGrammarV1 {
  if (!isPlainObject(grammar)) nodeInvalid('grammar must be a plain object');
  rejectUnknownFields(grammar, ['rootType', 'productions'], 'grammar');
  const rootType = grammar.rootType;
  if (!isNonEmptyString(rootType)) nodeInvalid('grammar.rootType must be a non-empty string');
  const productionsRaw = grammar.productions;
  if (!isPlainObject(productionsRaw)) nodeInvalid('grammar.productions must be a plain object');

  if (!typeIds.has(rootType)) referenceUnknown(`rootType '${rootType}' is not a declared type`);
  const productionKeys = Object.keys(productionsRaw);
  for (const key of productionKeys) {
    if (!typeIds.has(key)) referenceUnknown(`production '${key}' is not a declared type`);
  }
  for (const typeId of typeIds) {
    if (!(typeId in productionsRaw)) nodeInvalid(`declared type '${typeId}' has no production`);
  }

  const roots = new Map<string, MatchNode>();
  for (const key of productionKeys) {
    const prod = productionsRaw[key];
    if (!isPlainObject(prod)) nodeInvalid(`production '${key}' must be a plain object`);
    rejectUnknownFields(prod, ['children'], `productions/${key}`);
    const rawChildren = prod['children'];
    if (rawChildren === undefined) nodeInvalid(`production '${key}' is missing children`);
    roots.set(key, normalizeNode(rawChildren, `productions/${key}/children`, typeIds));
  }

  const reachable = computeReachable(rootType, roots);
  for (const [typeId] of roots) {
    if (!reachable.has(typeId)) productionUnreachable(`production '${typeId}' is unreachable from rootType`);
  }

  const generatable = computeGeneratable(roots);
  for (const typeId of reachable) {
    if (!generatable.get(typeId)) nonTerminating(`type '${typeId}' has no finite complete subtree`);
  }

  for (const root of roots.values()) computeFollows(root, new Set([EOF_SENTINEL]));

  for (const [typeId, root] of roots) checkAmbiguity(root, `productions/${typeId}/children`);

  for (const [typeId, root] of roots) {
    if (root.maxConsumption > limits.structure.maxChildrenPerSlot) {
      nodeInvalid(
        `production '${typeId}' max consumption ${root.maxConsumption} exceeds maxChildrenPerSlot ${limits.structure.maxChildrenPerSlot}`,
      );
    }
  }

  const productions: Record<string, CompiledProductionV1> = {};
  const match: Record<string, MatchNode> = {};
  for (const key of productionKeys) {
    const root = roots.get(key)!;
    productions[key] = {
      children: cleanNode(root),
      nullable: root.nullable,
      minConsumption: root.minConsumption,
      maxConsumption: root.maxConsumption,
      first: root.first,
      generatable: generatable.get(key)!,
    };
    match[key] = root;
  }

  return deepFreeze({ rootType, productions, _match: match }) as unknown as CompiledLayoutGrammarV1;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    if (value instanceof Set) {
      for (const item of value) deepFreeze(item);
      return value;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Match one production's children expression against the ordered child typeIds
 * of an instance. Single-pass, left-to-right, non-backtracking: at
 * choice/optional/repeat boundaries only the next child typeId (or EOF when
 * children are exhausted) is inspected. Returns `[]` on a full match, or
 * exactly one bounded STRUCTURE_PRODUCTION_MISMATCH issue placed at the
 * corresponding `locations` entry (the trailing entry is used for
 * end-of-children failures; pass the container location when there are no
 * children).
 */
export function matchProduction(
  compiled: CompiledLayoutGrammarV1,
  parentTypeId: string,
  childTypeIds: readonly string[],
  locations: readonly IssueLocation[],
): StructuredIssueV1[] {
  const root = compiled._match[parentTypeId];
  if (!root) throw new Error(`UNKNOWN_PARENT_TYPE: ${parentTypeId}`);

  const result = matchNode(root, childTypeIds, 0);
  if (result.ok && result.pos === childTypeIds.length) return [];

  if (locations.length === 0) {
    throw new Error('MATCH_LOCATIONS_EMPTY: pass at least the container location for end-of-children failures');
  }

  const pos = result.pos;
  const expected = result.ok ? summarizeNode(cleanNode(root)) : result.expected;
  const actual = pos < childTypeIds.length ? childTypeIds[pos] : 'eof';
  const index = Math.min(pos, locations.length - 1);

  return [
    makeStructuredIssue('STRUCTURE_PRODUCTION_MISMATCH', 'structure', locations[index], {
      parentTypeId,
      position: pos,
      expected,
      actual,
    }),
  ];
}

function matchNode(node: MatchNode, children: readonly string[], pos: number): MatchResult {
  switch (node.kind) {
    case 'empty':
      return { ok: true, pos };
    case 'slot': {
      const type = node.type!;
      if (pos < children.length && children[pos] === type) return { ok: true, pos: pos + 1 };
      return { ok: false, pos, expected: { kind: 'slot', type } };
    }
    case 'sequence': {
      let p = pos;
      for (const item of node.items!) {
        const result = matchNode(item, children, p);
        if (!result.ok) return result;
        p = result.pos;
      }
      return { ok: true, pos: p };
    }
    case 'choice': {
      // EOF is represented by null; it is never a member of any FIRST set.
      const next = pos < children.length ? children[pos] : null;
      for (const branch of node.items!) {
        if (next !== null && branch.first.has(next)) return matchNode(branch, children, pos);
      }
      return { ok: false, pos, expected: { kind: 'choice', itemCount: node.items!.length } };
    }
    case 'optional': {
      const next = pos < children.length ? children[pos] : null;
      if (next !== null && node.item!.first.has(next)) return matchNode(node.item!, children, pos);
      return { ok: true, pos };
    }
    case 'repeat': {
      const item = node.item!;
      const min = node.min!;
      const max = node.max!;
      let p = pos;
      let count = 0;
      while (count < min) {
        if (p >= children.length) return { ok: false, pos: p, expected: { kind: 'repeat', min, max } };
        const result = matchNode(item, children, p);
        if (!result.ok) return result;
        p = result.pos;
        count += 1;
      }
      while (count < max && p < children.length && item.first.has(children[p])) {
        const result = matchNode(item, children, p);
        if (!result.ok) return result;
        p = result.pos;
        count += 1;
      }
      return { ok: true, pos: p };
    }
  }
}
