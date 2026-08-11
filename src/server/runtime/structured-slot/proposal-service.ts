/**
 * StructureProposal service — the structure-session layer of the structured
 * slot engine (Task 12, design §9, spec §9.1).
 *
 * Five context-bound operations, all bound to a StructureSessionGrantV1
 * (snapshot + Proposal only, no scaffold):
 *
 * - `getContract`    — the declarative structure projection (I05): creatable
 *                     types + specSchemas + grammar + limits + safety notes.
 *                     NEVER implementation paths, validator/assembler sources,
 *                     ACL, host paths, event ids, grant ids or internal
 *                     compile state. Business-neutral.
 * - `putProposal`    — storage-safe WHOLE-TREE replace: JSON-serializable,
 *                     every node's spec an object, size/depth/node-count within
 *                     the frozen limits, clientKey unique, no forbidden
 *                     engineering fields (design §9.2 exact ProposalNode
 *                     shape). It ALLOWS temporarily schema/grammar-invalid
 *                     trees. Rejections carry stable PROPOSAL_* codes plus
 *                     registered StructuredIssueV1 where the closed registry
 *                     permits.
 * - `getProposal`    — read back the stored tree (or null) + lifecycle.
 * - `validateProposal` — ADVISORY schema+grammar check returning a
 *                     StructuredVerdictV1; never locks, never changes
 *                     authority.
 * - `submitProposal` — the full Structure Gate (schema + root type + grammar).
 *                     On success it allocates DETERMINISTIC slotIds from
 *                     `scaffoldId + generationId + instancePath` (NEVER
 *                     clientKey — design §9.3/§15), freezes the
 *                     `clientKey -> slotId` mapping in a turn-bound
 *                     StructureCommitCandidate, stores it in private state and
 *                     LOCKS the Proposal. A failed gate leaves the Proposal
 *                     OPEN (no lock). Replay returns the same candidate.
 *
 * The model-facing surface is ONLY the safe receipt
 * `{kind:'structure', status, changeCount, issueSummary}` — no blob, Grant,
 * revision or internal id ever leaves this service.
 *
 * This module carries zero business vocabulary (iron rule 1).
 */
import type {
  FrozenStructuredSlotContractV1,
} from '../../template/structured-slot-contract';
import type { GrammarNode } from '../../structured-slots/layout-grammar';
import { matchProduction } from '../../structured-slots/layout-grammar';
import type { CompiledSlotSchemaV1 } from '../../structured-slots/slot-schema';
import { validateSlotValue } from '../../structured-slots/slot-schema';
import { canonicalJson, canonicalJsonBytes, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { makeStructuredIssue } from '../../structured-slots/issues';
import type {
  IssueLocation,
  JsonObject,
  JsonValue,
  StructuredIssueV1,
  StructuredSlotLimitsV1,
  StructureSessionGrantV1,
  StructuredVerdictV1,
} from '../../../shared/structured-slots';
import {
  StructuredSlotPrivateStore,
  type ProposalLifecycle,
  type ProposalNode,
  type ProposalView,
  type StructureCommitCandidate,
} from '../../storage/structured-slot-private-store';
import type { TaskEvent } from '../../storage/task-events';
import type { GrantResolutionErrorCode } from './grant-service';

/** Stable operation codes for the structure Proposal layer. */
export type ProposalOperationCode =
  | GrantResolutionErrorCode
  | 'PROPOSAL_NOT_OPEN'
  | 'PROPOSAL_EMPTY'
  | 'PROPOSAL_ALREADY_SUBMITTED'
  | 'PROPOSAL_MALFORMED'
  | 'PROPOSAL_SPEC_NOT_OBJECT'
  | 'PROPOSAL_CLIENT_KEY_DUPLICATE'
  | 'PROPOSAL_FORBIDDEN_FIELD'
  | 'PROPOSAL_LIMIT_EXCEEDED'
  | 'PROPOSAL_GATE_REJECTED';

/** Structure session lifecycle status (design §11.3). */
export type StructureSessionStatus = 'open' | 'candidate_created' | 'committed' | 'abandoned';

/** Typed failure for the structure Proposal operations. */
export interface ProposalFailure {
  ok: false;
  code: ProposalOperationCode;
  reason: string;
  issues?: StructuredIssueV1[];
  /** Present when a Structure Gate rejected a submission. */
  verdict?: StructuredVerdictV1;
}

/** Safe model-facing receipt (design §9.3 / §11.3): no internal ids. */
export interface StructureSafeReceiptV1 {
  kind: 'structure';
  status: StructureSessionStatus;
  changeCount: number;
  issueSummary: { errors: number; warnings: number };
}

/** Declarative projection of one creatable slot type (design I05). */
export interface StructureSlotTypeProjectionV1 {
  id: string;
  name: string;
  description: string;
  specSchema: JsonObject;
  contentPresence: 'forbidden' | 'optional' | 'required';
}

/** Isomorphic declarative grammar projection — never internal compile state. */
export interface StructureLayoutGrammarProjectionV1 {
  rootType: string;
  productions: Record<string, { children: GrammarNode }>;
}

/** The whole `get_structure_contract` projection (design §8.6 / I05). */
export interface StructureContractProjectionV1 {
  version: 1;
  slotTypes: StructureSlotTypeProjectionV1[];
  layoutGrammar: StructureLayoutGrammarProjectionV1;
  limits: {
    structure: StructuredSlotLimitsV1['structure'];
    payload: Pick<StructuredSlotLimitsV1['payload'], 'maxSpecBytesPerSlot' | 'maxScaffoldPayloadBytes'>;
  };
  safetyNotes: readonly string[];
}

/** Platform-derived identity of the generation to be created at commit. */
export interface SubmitStructureContext {
  /** Platform identity of the future scaffold (never model-supplied). */
  scaffoldId: string;
  /** Platform identity of the generation to be committed (design §15). */
  generationId: string;
}

export type GetContractResult =
  | { ok: true; contract: StructureContractProjectionV1 }
  | { ok: false; code: GrantResolutionErrorCode; reason: string };

export type PutProposalResult = { ok: true } | ProposalFailure;

export type GetProposalResult =
  | { ok: true; tree: ProposalNode | null; lifecycle: ProposalLifecycle; locked: boolean }
  | ProposalFailure;

export type ValidateProposalResult = { ok: true; verdict: StructuredVerdictV1 } | ProposalFailure;

export type SubmitProposalResult =
  | { ok: true; candidate: StructureCommitCandidate; receipt: StructureSafeReceiptV1; verdict: StructuredVerdictV1 }
  | ProposalFailure;

export interface ProposalServiceOptions {
  taskId: string;
  snapshotHash: string;
  contract: FrozenStructuredSlotContractV1;
  store: StructuredSlotPrivateStore;
  events: () => Promise<readonly TaskEvent[]>;
}

/** The exact ProposalNode shape (design §9.2) — nothing else is allowed. */
const PROPOSAL_NODE_FIELDS = new Set(['clientKey', 'typeId', 'spec', 'children']);

/** Platform safety statements for the structure session (design I05). */
const STRUCTURE_SAFETY_NOTES: readonly string[] = [
  'spec must always be a JSON object; use {} when there is no intent',
  'a proposal carries typeId + spec + tree only; content is written in a separate fill phase',
  'clientKey is a local identifier for error positioning and is never used to derive slot identity',
  'put accepts temporarily schema- or grammar-invalid trees; only submission runs the full gate',
  'validate is advisory and never changes authority or locks the proposal',
  'a successful submission freezes the proposal: no further writes or resubmission',
  'slot ids are platform-derived from the frozen generation identity, never from model-supplied values',
];

function fail(
  code: ProposalOperationCode,
  reason: string,
  extra: Partial<ProposalFailure> = {},
): ProposalFailure {
  return { ok: false, code, reason, ...extra };
}

function failGrant(code: GrantResolutionErrorCode, reason: string): { ok: false; code: GrantResolutionErrorCode; reason: string } {
  return { ok: false, code, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** RFC 6901 instance path of the `i`-th child of a node at `instancePath`. */
function childPath(instancePath: string, index: number): string {
  return instancePath === '' ? `/children/${index}` : `${instancePath}/children/${index}`;
}

/** `proposal`-located IssueLocation for a node (design §19.2). */
function proposalLoc(
  node: ProposalNode,
  instancePath: string,
  field: 'node' | 'typeId' | 'spec' | 'children',
): IssueLocation {
  return { kind: 'proposal', clientKey: node.clientKey, instancePath, field, valuePointer: '' };
}

/**
 * Deterministic slot identity for the generation to be committed (design
 * §9.3/§15): derived from `scaffoldId + generationId + instancePath`, NEVER
 * from clientKey. A new generation gets all-new slotIds. The output is a
 * safe-segment canonical SHA-256.
 */
export function deriveSlotId(scaffoldId: string, generationId: string, instancePath: string): string {
  return canonicalJsonSha256({ v: 1, scaffoldId, generationId, instancePath });
}

/** Declarative projection of a compiled slot schema (drops internal state). */
function projectCompiledSchema(schema: CompiledSlotSchemaV1): JsonObject {
  const out: Record<string, JsonValue> = { type: schema.type };
  if (schema.description !== undefined) out.description = schema.description;
  if (schema.enum !== undefined) out.enum = [...schema.enum];
  if (schema.const !== undefined) out.const = schema.const;
  if (schema.minLength !== undefined) out.minLength = schema.minLength;
  if (schema.maxLength !== undefined) out.maxLength = schema.maxLength;
  if (schema.pattern !== undefined) out.pattern = schema.pattern.pattern;
  if (schema.minimum !== undefined) out.minimum = schema.minimum;
  if (schema.maximum !== undefined) out.maximum = schema.maximum;
  if (schema.exclusiveMinimum !== undefined) out.exclusiveMinimum = schema.exclusiveMinimum;
  if (schema.exclusiveMaximum !== undefined) out.exclusiveMaximum = schema.exclusiveMaximum;
  if (schema.properties !== undefined) {
    const properties: Record<string, JsonValue> = {};
    for (const [name, child] of Object.entries(schema.properties)) {
      properties[name] = projectCompiledSchema(child);
    }
    out.properties = properties;
  }
  if (schema.required !== undefined) out.required = [...schema.required];
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties = schema.additionalProperties === false ? false : projectCompiledSchema(schema.additionalProperties);
  }
  if (schema.minProperties !== undefined) out.minProperties = schema.minProperties;
  if (schema.maxProperties !== undefined) out.maxProperties = schema.maxProperties;
  if (schema.items !== undefined) out.items = projectCompiledSchema(schema.items);
  if (schema.minItems !== undefined) out.minItems = schema.minItems;
  if (schema.maxItems !== undefined) out.maxItems = schema.maxItems;
  if (schema.uniqueItems !== undefined) out.uniqueItems = schema.uniqueItems;
  return out;
}

function projectContract(contract: FrozenStructuredSlotContractV1): StructureContractProjectionV1 {
  const slotTypes = contract.slotTypes.map((type) => ({
    id: type.id,
    name: type.name,
    description: type.description,
    specSchema: projectCompiledSchema(type.specSchema),
    contentPresence: type.content.presence,
  }));
  const productions: Record<string, { children: GrammarNode }> = {};
  for (const [typeId, production] of Object.entries(contract.layoutGrammar.productions)) {
    productions[typeId] = { children: production.children };
  }
  return {
    version: 1,
    slotTypes,
    layoutGrammar: { rootType: contract.layoutGrammar.rootType, productions },
    limits: {
      structure: { ...contract.limits.structure },
      payload: {
        maxSpecBytesPerSlot: contract.limits.payload.maxSpecBytesPerSlot,
        maxScaffoldPayloadBytes: contract.limits.payload.maxScaffoldPayloadBytes,
      },
    },
    safetyNotes: STRUCTURE_SAFETY_NOTES,
  };
}

/**
 * Storage boundary of `put_structure_proposal` (design §9.3): JSON shape, the
 * exact ProposalNode field set, spec-is-object, clientKey uniqueness, depth /
 * node count / per-slot and total payload bytes within the frozen limits, and
 * whole-tree JSON-serializability. Returns the first violation or null.
 * Schema/grammar are deliberately NOT validated here.
 */
function assertStorageSafeTree(tree: ProposalNode, limits: StructuredSlotLimitsV1): ProposalFailure | null {
  if (!isPlainObject(tree)) {
    return fail('PROPOSAL_MALFORMED', 'the proposal tree must be a plain object');
  }
  const seenKeys = new Set<string>();
  let nodes = 0;
  let maxDepth = 0;
  let totalSpecBytes = 0;

  const walk = (node: ProposalNode, depth: number, instancePath: string): ProposalFailure | null => {
    // Short-circuit INSIDE the walk BEFORE recursing further (FIX_BEFORE_HANDOFF):
    // an over-deep / over-large proposal tree must fail with the stable
    // PROPOSAL_LIMIT_EXCEEDED, never a raw RangeError from the unbounded
    // recursion that the post-walk bounds would otherwise never reach.
    if (depth > limits.structure.maxTreeDepth) {
      return fail(
        'PROPOSAL_LIMIT_EXCEEDED',
        `tree depth ${depth} exceeds maxTreeDepth ${limits.structure.maxTreeDepth}`,
        {
          issues: [
            makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'structure', { kind: 'operation' }, { limit: 'maxTreeDepth', depth }),
          ],
        },
      );
    }
    nodes += 1;
    if (nodes > limits.structure.maxSlots) {
      return fail(
        'PROPOSAL_LIMIT_EXCEEDED',
        `tree has ${nodes} nodes, exceeding maxSlots ${limits.structure.maxSlots}`,
        {
          issues: [
            makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'structure', { kind: 'operation' }, { limit: 'maxSlots', nodes }),
          ],
        },
      );
    }
    maxDepth = Math.max(maxDepth, depth);
    if (!isPlainObject(node)) {
      return fail('PROPOSAL_MALFORMED', 'every proposal node must be a plain object');
    }
    for (const key of Object.keys(node)) {
      if (!PROPOSAL_NODE_FIELDS.has(key)) {
        return fail('PROPOSAL_FORBIDDEN_FIELD', `node '${String(node.clientKey)}' carries the forbidden field '${key}'`);
      }
    }
    if (typeof node.clientKey !== 'string' || node.clientKey.length === 0) {
      return fail('PROPOSAL_MALFORMED', 'every proposal node needs a non-empty clientKey');
    }
    if (typeof node.typeId !== 'string' || node.typeId.length === 0) {
      return fail('PROPOSAL_MALFORMED', `node '${node.clientKey}' needs a non-empty typeId`);
    }
    if (!isPlainObject(node.spec)) {
      return fail(
        'PROPOSAL_SPEC_NOT_OBJECT',
        `spec of node '${node.clientKey}' must be a JSON object`,
        {
          issues: [
            makeStructuredIssue(
              'SPEC_SCHEMA_INVALID',
              'structure',
              proposalLoc(node, instancePath, 'spec'),
              { keyword: 'type', expected: 'object' },
            ),
          ],
        },
      );
    }
    if (!Array.isArray(node.children)) {
      return fail('PROPOSAL_MALFORMED', `children of node '${node.clientKey}' must be an array`);
    }
    if (seenKeys.has(node.clientKey)) {
      return fail(
        'PROPOSAL_CLIENT_KEY_DUPLICATE',
        `clientKey '${node.clientKey}' appears more than once`,
        {
          issues: [
            makeStructuredIssue(
              'PROPOSAL_CLIENT_KEY_DUPLICATE',
              'structure',
              proposalLoc(node, instancePath, 'node'),
              {},
            ),
          ],
        },
      );
    }
    seenKeys.add(node.clientKey);

    let specBytes: number;
    try {
      specBytes = canonicalJsonBytes(node.spec).length;
    } catch {
      return fail('PROPOSAL_MALFORMED', `spec of node '${node.clientKey}' is not JSON-serializable`);
    }
    totalSpecBytes += specBytes;
    if (specBytes > limits.payload.maxSpecBytesPerSlot) {
      return fail('PROPOSAL_LIMIT_EXCEEDED', `spec of node '${node.clientKey}' exceeds maxSpecBytesPerSlot`, {
        issues: [
          makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'structure', { kind: 'operation' }, { limit: 'maxSpecBytesPerSlot', node: node.clientKey, bytes: specBytes }),
        ],
      });
    }
    if (node.children.length > limits.structure.maxChildrenPerSlot) {
      return fail('PROPOSAL_LIMIT_EXCEEDED', `children of node '${node.clientKey}' exceed maxChildrenPerSlot`, {
        issues: [
          makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'structure', { kind: 'operation' }, { limit: 'maxChildrenPerSlot', node: node.clientKey }),
        ],
      });
    }
    for (let i = 0; i < node.children.length; i += 1) {
      const childResult = walk(node.children[i], depth + 1, childPath(instancePath, i));
      if (childResult !== null) return childResult;
    }
    return null;
  };

  const rootResult = walk(tree, 1, '');
  if (rootResult !== null) return rootResult;

  if (maxDepth > limits.structure.maxTreeDepth) {
    return fail('PROPOSAL_LIMIT_EXCEEDED', `tree depth ${maxDepth} exceeds maxTreeDepth ${limits.structure.maxTreeDepth}`, {
      issues: [makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'structure', { kind: 'operation' }, { limit: 'maxTreeDepth', depth: maxDepth })],
    });
  }
  if (nodes > limits.structure.maxSlots) {
    return fail('PROPOSAL_LIMIT_EXCEEDED', `tree has ${nodes} nodes, exceeding maxSlots ${limits.structure.maxSlots}`, {
      issues: [makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'structure', { kind: 'operation' }, { limit: 'maxSlots', nodes })],
    });
  }
  if (totalSpecBytes > limits.payload.maxScaffoldPayloadBytes) {
    return fail('PROPOSAL_LIMIT_EXCEEDED', `total spec payload ${totalSpecBytes} exceeds maxScaffoldPayloadBytes`, {
      issues: [makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'structure', { kind: 'operation' }, { limit: 'maxScaffoldPayloadBytes', bytes: totalSpecBytes })],
    });
  }
  try {
    canonicalJson(tree);
  } catch {
    return fail('PROPOSAL_MALFORMED', 'the proposal tree is not JSON-serializable');
  }
  return null;
}

/**
 * The full Structure Gate (design §9.3/§14.3-adjacent): clientKey uniqueness,
 * root-type conformance, per-node specSchema validation and LayoutGrammar
 * matchProduction of every node's children. Pure; returns the issue list.
 */
function runStructureGate(contract: FrozenStructuredSlotContractV1, tree: ProposalNode): StructuredIssueV1[] {
  const issues: StructuredIssueV1[] = [];
  const typeById = new Map(contract.slotTypes.map((type) => [type.id, type]));
  const seen = new Set<string>();
  let nodes = 0;

  const walk = (node: ProposalNode, instancePath: string, depth: number): void => {
    // Short-circuit INSIDE the walk BEFORE recursing further (FIX_BEFORE_HANDOFF):
    // an over-deep / over-large proposal tree must surface the stable
    // RESOURCE_LIMIT_EXCEEDED issue, never a raw RangeError from the unbounded
    // recursion. (The storage boundary already rejects such trees at put time;
    // this guard protects validate/submit against any over-limit tree that
    // predates that check.)
    if (depth > contract.limits.structure.maxTreeDepth || nodes >= contract.limits.structure.maxSlots) {
      issues.push(
        makeStructuredIssue(
          'RESOURCE_LIMIT_EXCEEDED',
          'structure',
          { kind: 'operation' },
          depth > contract.limits.structure.maxTreeDepth
            ? { limit: 'maxTreeDepth', depth }
            : { limit: 'maxSlots', nodes },
        ),
      );
      return;
    }
    nodes += 1;
    if (seen.has(node.clientKey)) {
      issues.push(
        makeStructuredIssue('PROPOSAL_CLIENT_KEY_DUPLICATE', 'structure', proposalLoc(node, instancePath, 'node'), {}),
      );
      return;
    }
    seen.add(node.clientKey);

    const type = typeById.get(node.typeId);
    if (instancePath === '' && node.typeId !== contract.layoutGrammar.rootType) {
      issues.push(
        makeStructuredIssue(
          'STRUCTURE_ROOT_TYPE_INVALID',
          'structure',
          proposalLoc(node, instancePath, 'typeId'),
          { actual: node.typeId, expected: contract.layoutGrammar.rootType },
        ),
      );
    }
    if (type !== undefined) {
      const schemaIssues = validateSlotValue(type.specSchema, node.spec, proposalLoc(node, instancePath, 'spec'), 'structure');
      issues.push(...schemaIssues);
    }

    const childTypeIds = node.children.map((child) => child.typeId);
    const childLocations = node.children.map((child, i) => proposalLoc(child, childPath(instancePath, i), 'node'));
    const containerLocation = proposalLoc(node, instancePath, 'children');
    const locations = childLocations.length > 0 ? [...childLocations, containerLocation] : [containerLocation];
    if (type !== undefined) {
      const grammarIssues = matchProduction(contract.layoutGrammar, node.typeId, childTypeIds, locations);
      issues.push(...grammarIssues);
    }

    for (let i = 0; i < node.children.length; i += 1) {
      walk(node.children[i], childPath(instancePath, i), depth + 1);
    }
  };

  walk(tree, '', 1);
  issues.sort((a, b) => {
    if (a.phase !== b.phase) return a.phase < b.phase ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return 0;
  });
  return issues;
}

function buildVerdict(issues: StructuredIssueV1[]): StructuredVerdictV1 {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return {
    version: 1,
    status: errors > 0 ? 'failed' : 'passed',
    issues,
    truncated: false,
    summary: { errors, warnings: issues.length - errors },
  };
}

function passedVerdict(): StructuredVerdictV1 {
  return { version: 1, status: 'passed', issues: [], truncated: false, summary: { errors: 0, warnings: 0 } };
}

function candidateReceipt(candidate: StructureCommitCandidate): StructureSafeReceiptV1 {
  return {
    kind: 'structure',
    status: 'candidate_created',
    changeCount: candidate.slotCount,
    issueSummary: { errors: 0, warnings: 0 },
  };
}

/** Canonical-forms the tree: normalized, ordered, storage-safe clone. */
function normalizeTree(tree: ProposalNode): ProposalNode {
  return JSON.parse(canonicalJson(tree)) as ProposalNode;
}

/**
 * StructureProposal service bound to one production case (task) and its frozen
 * contract. Operations return typed results and never throw; the grant is
 * re-validated at every operation boundary (design D06).
 */
export class StructuredSlotProposalService {
  private readonly taskId: string;

  private readonly snapshotHash: string;

  private readonly contract: FrozenStructuredSlotContractV1;

  private readonly store: StructuredSlotPrivateStore;

  private readonly events: () => Promise<readonly TaskEvent[]>;

  constructor(options: ProposalServiceOptions) {
    this.taskId = options.taskId;
    this.snapshotHash = options.snapshotHash;
    this.contract = options.contract;
    this.store = options.store;
    this.events = options.events;
  }

  /**
   * Declarative structure projection (design §8.6 / I05): creatable types,
   * specSchemas, grammar, limits and safety notes. Business-neutral; never
   * exposes implementation paths, sources, ACL, host paths, event ids or grant
   * ids.
   */
  getContract(grant: StructureSessionGrantV1): GetContractResult {
    const shape = this.assertGrantShape(grant);
    if (!shape.ok) return { ok: false, code: shape.code, reason: shape.reason };
    return { ok: true, contract: projectContract(this.contract) };
  }

  /** Storage-safe whole-tree replace (design §9.3). Advisory on schema/grammar. */
  async putProposal(grant: StructureSessionGrantV1, tree: ProposalNode): Promise<PutProposalResult> {
    const view = await this.store.readProposal(grant.proposalId, await this.events());
    const grantCheck = this.assertGrantForProposal(grant, view);
    if (!grantCheck.ok) return { ok: false, code: grantCheck.code, reason: grantCheck.reason };
    if (view.lifecycle !== 'open') return fail('PROPOSAL_NOT_OPEN', 'the proposal is not open');
    if (view.locked) return fail('PROPOSAL_ALREADY_SUBMITTED', 'the proposal is locked by a formed candidate');

    const storageCheck = assertStorageSafeTree(tree, this.contract.limits);
    if (storageCheck !== null) return storageCheck;

    await this.store.replaceProposal(grant.proposalId, tree);
    return { ok: true };
  }

  /** Read back the stored tree (or null) and its event-derived lifecycle. */
  async getProposal(grant: StructureSessionGrantV1): Promise<GetProposalResult> {
    const view = await this.store.readProposal(grant.proposalId, await this.events());
    const grantCheck = this.assertGrantForProposal(grant, view);
    if (!grantCheck.ok) return { ok: false, code: grantCheck.code, reason: grantCheck.reason };
    return { ok: true, tree: view.tree, lifecycle: view.lifecycle, locked: view.locked };
  }

  /**
   * ADVISORY structure check (design §9.3): schema + grammar, no authority
   * change, no lock. Rejected once a candidate exists (no re-running the Gate).
   */
  async validateProposal(grant: StructureSessionGrantV1): Promise<ValidateProposalResult> {
    const view = await this.store.readProposal(grant.proposalId, await this.events());
    const grantCheck = this.assertGrantForProposal(grant, view);
    if (!grantCheck.ok) return { ok: false, code: grantCheck.code, reason: grantCheck.reason };
    if (view.lifecycle !== 'open') return fail('PROPOSAL_NOT_OPEN', 'the proposal is not open');
    if (view.locked) return fail('PROPOSAL_ALREADY_SUBMITTED', 'a candidate has been formed; the gate cannot be re-run');
    if (view.tree === null) return fail('PROPOSAL_EMPTY', 'no proposal tree has been stored yet');

    const issues = runStructureGate(this.contract, view.tree);
    return { ok: true, verdict: buildVerdict(issues) };
  }

  /**
   * Full Structure Gate + candidate freeze (design §9.3/§11.3): schema + root
   * type + grammar; on success allocate deterministic slotIds (scaffoldId +
   * generationId + instancePath), store the turn-bound candidate in private
   * state and LOCK the proposal. A failed gate leaves the proposal open (no
   * lock). Replay returns the same candidate (idempotent).
   */
  async submitProposal(
    grant: StructureSessionGrantV1,
    context: SubmitStructureContext,
  ): Promise<SubmitProposalResult> {
    const view = await this.store.readProposal(grant.proposalId, await this.events());
    const grantCheck = this.assertGrantForProposal(grant, view);
    if (!grantCheck.ok) return { ok: false, code: grantCheck.code, reason: grantCheck.reason };
    if (view.lifecycle !== 'open') return fail('PROPOSAL_NOT_OPEN', 'the proposal is not open');

    // Idempotent replay (design §22.2): a frozen candidate is returned as-is.
    if (view.candidate !== null) {
      if (!view.locked) {
        await this.store.lockProposal(grant.proposalId);
      }
      return { ok: true, candidate: view.candidate, receipt: candidateReceipt(view.candidate), verdict: passedVerdict() };
    }
    if (view.locked) return fail('PROPOSAL_ALREADY_SUBMITTED', 'the proposal is locked by a formed candidate');
    if (view.tree === null) return fail('PROPOSAL_EMPTY', 'no proposal tree has been stored yet');

    const gateIssues = runStructureGate(this.contract, view.tree);
    const verdict = buildVerdict(gateIssues);
    if (verdict.status !== 'passed') {
      return fail('PROPOSAL_GATE_REJECTED', 'the structure gate rejected the proposal', { issues: gateIssues, verdict });
    }

    const normalizedTree = normalizeTree(view.tree);
    const slotIdByClientKey: Record<string, string> = {};
    let rootSlotId: string | undefined;
    let slotCount = 0;
    const walk = (node: ProposalNode, instancePath: string): void => {
      const slotId = deriveSlotId(context.scaffoldId, context.generationId, instancePath);
      slotIdByClientKey[node.clientKey] = slotId;
      if (instancePath === '') rootSlotId = slotId;
      slotCount += 1;
      for (let i = 0; i < node.children.length; i += 1) {
        walk(node.children[i], childPath(instancePath, i));
      }
    };
    walk(normalizedTree, '');

    const candidate: StructureCommitCandidate = {
      taskId: this.taskId,
      turnId: grant.turnId,
      proposalId: grant.proposalId,
      snapshotHash: this.snapshotHash,
      generationId: context.generationId,
      rootSlotId,
      slotCount,
      slotIdByClientKey,
      normalizedTree,
      contentRevision: 0,
    };

    // Freeze into private state: the candidate first, then the submission lock
    // (the store rejects writes after the lock; a crash between the two is
    // repaired by the idempotent replay path above).
    await this.store.storeProposalCandidate(grant.proposalId, candidate);
    await this.store.lockProposal(grant.proposalId);

    return { ok: true, candidate, receipt: candidateReceipt(candidate), verdict };
  }

  private assertGrantShape(grant: StructureSessionGrantV1): { ok: true } | { ok: false; code: GrantResolutionErrorCode; reason: string } {
    if (grant.kind !== 'structure') return failGrant('GRANT_INVALID', 'the grant is not a structure grant');
    if (grant.caseId !== this.taskId) return failGrant('GRANT_INVALID', 'the grant is bound to a different task');
    if (grant.snapshotHash !== this.snapshotHash) {
      return failGrant('GRANT_INVALID', 'the grant is bound to a different snapshot');
    }
    return { ok: true };
  }

  private assertGrantForProposal(
    grant: StructureSessionGrantV1,
    view: ProposalView,
  ): { ok: true } | { ok: false; code: GrantResolutionErrorCode; reason: string } {
    const shape = this.assertGrantShape(grant);
    if (!shape.ok) return shape;
    if (grant.proposalId !== view.proposalId) {
      return failGrant('GRANT_INVALID', 'the grant is bound to a different proposal');
    }
    if (grant.turnId !== view.turnId) {
      return failGrant('GRANT_INVALID', 'the grant is bound to a different attempt');
    }
    return { ok: true };
  }
}
