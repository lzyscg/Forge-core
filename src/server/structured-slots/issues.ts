/**
 * Closed issue code registry and authorized projection for the structured-slot
 * engine v1 (design §25.5 F02/F03/F06, §19.1).
 *
 * The registry pins every code's `{ source, phases, severity, locations }`
 * and cannot be extended by templates or Agents. `makeStructuredIssue` is the
 * only legal constructor and rejects any unregistered code / phase / location
 * combination. `projectStructuredVerdict` applies the F06 pipeline: filter
 * hidden related locations, suppress issues with a hidden primary location
 * (never null fields out), stable-sort, apply the public count cap and
 * recompute the summary from the visible projection.
 *
 * This module is pure domain logic (no storage, no runtime).
 */
import type {
  StructuredIssueV1,
  StructuredVerdictV1,
  IssueLocation,
  IssuePhase,
  JsonObject,
} from '../../shared/structured-slots';
import { canonicalJson } from './canonical-json';

/** The six closed IssueLocation kinds (design §19.2). */
export const ALL_LOCATION_KINDS = [
  'contract',
  'template_resource',
  'proposal',
  'slot',
  'artifact',
  'operation',
] as const;

/** Source/phase/severity/location contract of one registered code. */
export type StructuredIssueRegistryEntry = {
  source: StructuredIssueV1['source'];
  phases: readonly IssuePhase[];
  severity: 'error' | 'warning';
  locations: readonly IssueLocation['kind'][];
};

/**
 * v1 minimum code set frozen in design §25.5 F03. Names are UPPER_SNAKE_CASE
 * and public: never re-purpose a code, only add new ones with a version bump.
 */
export const STRUCTURED_ISSUE_REGISTRY = {
  // contract domain (F03 "contract")
  SLOTS_CONTRACT_INVALID: {
    source: 'template_loader',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract', 'template_resource'],
  },
  SLOTS_REFERENCE_UNKNOWN: {
    source: 'template_loader',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract', 'template_resource'],
  },
  SLOTS_RESOURCE_INVALID: {
    source: 'template_loader',
    phases: ['template_load'],
    severity: 'error',
    locations: ['template_resource'],
  },
  // compatibility domain (F03 "compatibility")
  TEMPLATE_RUNTIME_UNAVAILABLE: {
    source: 'template_loader',
    phases: ['template_load'],
    severity: 'error',
    locations: ['template_resource', 'operation'],
  },
  // slot schema domain (F03 "Slot Schema")
  SPEC_SCHEMA_INVALID: {
    source: 'slot_schema',
    phases: ['structure', 'merge', 'seal_input'],
    severity: 'error',
    locations: ['proposal', 'slot'],
  },
  CONTENT_SCHEMA_INVALID: {
    source: 'slot_schema',
    phases: ['draft', 'merge', 'seal_input'],
    severity: 'error',
    locations: ['proposal', 'slot'],
  },
  CONTENT_REQUIRED: {
    source: 'slot_schema',
    phases: ['draft', 'merge', 'seal_input'],
    severity: 'error',
    locations: ['slot'],
  },
  CONTENT_FORBIDDEN: {
    source: 'slot_schema',
    phases: ['draft', 'merge', 'seal_input'],
    severity: 'error',
    locations: ['slot'],
  },
  // grammar static reference domain (F03 "grammar_ref")
  LAYOUT_GRAMMAR_NODE_INVALID: {
    source: 'layout_grammar',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract'],
  },
  LAYOUT_GRAMMAR_REFERENCE_UNKNOWN: {
    source: 'layout_grammar',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract'],
  },
  LAYOUT_GRAMMAR_PRODUCTION_UNREACHABLE: {
    source: 'layout_grammar',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract'],
  },
  // grammar static termination domain (F03 "grammar_term")
  LAYOUT_GRAMMAR_NULLABLE_REPEAT: {
    source: 'layout_grammar',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract'],
  },
  LAYOUT_GRAMMAR_NON_TERMINATING: {
    source: 'layout_grammar',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract'],
  },
  // grammar static ambiguity domain (F03 "grammar_ambig")
  LAYOUT_GRAMMAR_CHOICE_AMBIGUOUS: {
    source: 'layout_grammar',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract'],
  },
  LAYOUT_GRAMMAR_OPTIONAL_FOLLOW_CONFLICT: {
    source: 'layout_grammar',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract'],
  },
  LAYOUT_GRAMMAR_REPEAT_FOLLOW_CONFLICT: {
    source: 'layout_grammar',
    phases: ['template_load'],
    severity: 'error',
    locations: ['contract'],
  },
  // structure / Proposal instance domain (F03 "structure")
  PROPOSAL_CLIENT_KEY_DUPLICATE: {
    source: 'lifecycle',
    phases: ['structure'],
    severity: 'error',
    locations: ['proposal'],
  },
  STRUCTURE_ROOT_TYPE_INVALID: {
    source: 'layout_grammar',
    phases: ['structure', 'seal_input'],
    severity: 'error',
    locations: ['proposal', 'slot'],
  },
  STRUCTURE_PRODUCTION_MISMATCH: {
    source: 'layout_grammar',
    phases: ['structure', 'seal_input'],
    severity: 'error',
    locations: ['proposal', 'slot'],
  },
  // access domain (F03 "access")
  SLOT_CAPABILITY_REQUIRED: {
    source: 'access_control',
    phases: ['structure', 'draft', 'seal_input'],
    severity: 'error',
    locations: ['operation'],
  },
  SLOT_NOT_VISIBLE: {
    source: 'access_control',
    phases: ['draft', 'merge', 'seal_input'],
    severity: 'error',
    locations: ['operation'],
  },
  SLOT_WRITE_FORBIDDEN: {
    source: 'access_control',
    phases: ['draft'],
    severity: 'error',
    locations: ['slot', 'operation'],
  },
  // lifecycle domain (F03 "lifecycle")
  PROPOSAL_NOT_OPEN: {
    source: 'lifecycle',
    phases: ['structure'],
    severity: 'error',
    locations: ['proposal', 'operation'],
  },
  DRAFT_NOT_OPEN: {
    source: 'lifecycle',
    phases: ['draft', 'merge'],
    severity: 'error',
    locations: ['slot', 'operation'],
  },
  DRAFT_STALE: {
    source: 'lifecycle',
    phases: ['draft', 'merge', 'seal_input'],
    severity: 'error',
    locations: ['slot', 'operation'],
  },
  SCAFFOLD_NOT_ACTIVE: {
    source: 'lifecycle',
    phases: ['structure', 'draft', 'merge', 'seal_input'],
    severity: 'error',
    locations: ['operation'],
  },
  COMMIT_CANDIDATE_STALE: {
    source: 'lifecycle',
    phases: ['merge', 'seal_input', 'publish'],
    severity: 'error',
    locations: ['operation'],
  },
  // limits / idempotency domain (F03 "limits/idemp")
  RESOURCE_LIMIT_EXCEEDED: {
    source: 'resource_limits',
    phases: [
      'template_load',
      'structure',
      'draft',
      'merge',
      'seal_input',
      'assemble',
      'seal_output',
      'publish',
    ],
    severity: 'error',
    locations: ['operation'],
  },
  IDEMPOTENCY_CONFLICT: {
    source: 'resource_limits',
    phases: ['draft', 'merge', 'seal_input', 'publish'],
    severity: 'error',
    locations: ['operation'],
  },
  // validator domain (F03 "validator")
  VALIDATOR_REJECTED: {
    source: 'validator',
    phases: ['merge', 'seal_input'],
    severity: 'error',
    locations: ['slot', 'operation'],
  },
  VALIDATOR_ADVISORY: {
    source: 'validator',
    phases: ['merge', 'seal_input'],
    severity: 'warning',
    locations: ['slot', 'operation'],
  },
  VALIDATOR_UNAVAILABLE: {
    source: 'validator',
    phases: ['merge', 'seal_input'],
    severity: 'error',
    locations: ['slot', 'operation'],
  },
  VALIDATOR_RESULT_INVALID: {
    source: 'validator',
    phases: ['merge', 'seal_input'],
    severity: 'error',
    locations: ['slot', 'operation'],
  },
  // assembler domain (F03 "assembler")
  ASSEMBLER_FAILED: {
    source: 'assembler',
    phases: ['seal_input', 'assemble'],
    severity: 'error',
    locations: ['operation'],
  },
  ASSEMBLER_UNAVAILABLE: {
    source: 'assembler',
    phases: ['assemble'],
    severity: 'error',
    locations: ['operation'],
  },
  ASSEMBLER_RESULT_INVALID: {
    source: 'assembler',
    phases: ['assemble'],
    severity: 'error',
    locations: ['artifact', 'operation'],
  },
  // artifact / publish domain (F03 "artifact")
  ARTIFACT_SCHEMA_MISMATCH: {
    source: 'artifact_validator',
    phases: ['seal_output', 'publish'],
    severity: 'error',
    locations: ['artifact'],
  },
  ARTIFACT_INTEGRITY_FAILED: {
    source: 'artifact_validator',
    phases: ['seal_output', 'publish'],
    severity: 'error',
    locations: ['artifact'],
  },
  PUBLISH_FAILED: {
    source: 'publisher',
    phases: ['publish'],
    severity: 'error',
    locations: ['artifact', 'operation'],
  },
} as const;

/** Closed union of all registered public issue codes. */
export type StructuredIssueCode = keyof typeof STRUCTURED_ISSUE_REGISTRY;

/**
 * Authorization visibility for one projection subject (design §19.1/F06).
 * v1 subjects are the Agent Grant (kind-level visibility) and the local
 * `task_owner` audit view (all kinds, see ALL_LOCATION_KINDS).
 */
export interface VerdictVisibilityV1 {
  /** Location kinds the subject may see. Everything else is hidden. */
  visibleLocationKinds: readonly IssueLocation['kind'][];
  /**
   * Public issue list cap (F06 "公开数量上限"). Issues beyond the cap are
   * dropped and `truncated` is set. Omit (or Infinity) for no cap. The
   * summary always counts the full visible projection.
   */
  maxIssues?: number;
}

const ISSUE_FIELDS: Record<string, ReadonlySet<string>> = {
  contract: new Set(['kind', 'pointer']),
  template_resource: new Set(['kind', 'resourcePath', 'span']),
  proposal: new Set(['kind', 'clientKey', 'instancePath', 'field', 'valuePointer']),
  slot: new Set(['kind', 'slotId', 'field', 'valuePointer']),
  artifact: new Set(['kind', 'routeId', 'artifactPath', 'valuePointer']),
  operation: new Set(['kind']),
};

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTextSpan(value: unknown): value is { start: { line: number; column: number }; end: { line: number; column: number } } {
  if (typeof value !== 'object' || value === null) return false;
  const span = value as {
    start?: unknown;
    end?: unknown;
  };
  const start = span.start as { line?: unknown; column?: unknown } | undefined;
  const end = span.end as { line?: unknown; column?: unknown } | undefined;
  if (!start || !end) return false;
  if (!isNonNegativeInteger(start.line) || !isNonNegativeInteger(start.column)) return false;
  if (!isNonNegativeInteger(end.line) || !isNonNegativeInteger(end.column)) return false;
  // end must not precede start (design §19.2).
  if (end.line < start.line) return false;
  if (end.line === start.line && end.column < start.column) return false;
  return true;
}

/**
 * Structural validator for the six-variant closed IssueLocation union
 * (design §19.2). Unknown kinds, missing fields and extra fields are invalid.
 */
export function isIssueLocation(value: unknown): value is IssueLocation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !(kind in ISSUE_FIELDS)) return false;
  const allowed = ISSUE_FIELDS[kind];
  const actual = new Set(Object.keys(record));
  if (actual.size !== allowed.size) return false;
  for (const key of actual) if (!allowed.has(key)) return false;

  switch (kind) {
    case 'contract':
      return typeof record['pointer'] === 'string';
    case 'template_resource':
      return (
        typeof record['resourcePath'] === 'string' &&
        (record['span'] === null || isTextSpan(record['span']))
      );
    case 'proposal':
      return (
        typeof record['clientKey'] === 'string' &&
        typeof record['instancePath'] === 'string' &&
        ['node', 'typeId', 'spec', 'children'].includes(record['field'] as string) &&
        typeof record['valuePointer'] === 'string'
      );
    case 'slot':
      return (
        typeof record['slotId'] === 'string' &&
        ['node', 'spec', 'content', 'children'].includes(record['field'] as string) &&
        typeof record['valuePointer'] === 'string'
      );
    case 'artifact':
      return (
        typeof record['routeId'] === 'string' &&
        typeof record['artifactPath'] === 'string' &&
        typeof record['valuePointer'] === 'string'
      );
    case 'operation':
      return true;
    default:
      // Unreachable: `kind` was validated against the closed ISSUE_FIELDS.
      return false;
  }
}

function getRegistryEntry(code: string): StructuredIssueRegistryEntry {
  const entry = (STRUCTURED_ISSUE_REGISTRY as Record<string, StructuredIssueRegistryEntry | undefined>)[code];
  if (!entry) throw new Error(`UNREGISTERED_ISSUE_CODE: ${code}`);
  return entry;
}

function assertRegisteredCombo(
  code: string,
  phase: IssuePhase,
  location: IssueLocation,
): void {
  const entry = getRegistryEntry(code);
  if (!(entry.phases as readonly string[]).includes(phase)) {
    throw new Error(`UNREGISTERED_ISSUE_PHASE: code '${code}' does not allow phase '${phase}'`);
  }
  const kind = location.kind;
  if (!(entry.locations as readonly string[]).includes(kind)) {
    throw new Error(`UNREGISTERED_ISSUE_LOCATION: code '${code}' does not allow location kind '${kind}'`);
  }
  if (!isIssueLocation(location)) {
    throw new Error(`INVALID_ISSUE_LOCATION: code '${code}' carries a malformed ${kind} location`);
  }
}

function assertJsonObjectDetails(value: unknown): asserts value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('INVALID_ISSUE_DETAILS: details must be a plain JSON object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('INVALID_ISSUE_DETAILS: details must be a plain JSON object');
  }
  // Guarantee bounded, serializable JSON (no cycles / surrogates / undefined).
  canonicalJson(value);
}

/**
 * Sole legal constructor of a StructuredIssueV1 against the closed registry.
 * Rejects unregistered code / phase / location combinations.
 *
 * `message` is generated deterministically from the code and phase; it is a
 * readable rendering only and is never parsed for decisions (design §19.1).
 */
export function makeStructuredIssue(
  code: StructuredIssueCode,
  phase: IssuePhase,
  location: IssueLocation,
  details: JsonObject,
  relatedLocations: IssueLocation[] = [],
): StructuredIssueV1 {
  const entry = getRegistryEntry(code);
  assertRegisteredCombo(code, phase, location);
  for (const related of relatedLocations) {
    assertRegisteredCombo(code, phase, related);
  }
  assertJsonObjectDetails(details);
  return {
    version: 1,
    code,
    severity: entry.severity,
    phase,
    source: entry.source,
    message: `${code} (${phase})`,
    primaryLocation: location,
    relatedLocations: [...relatedLocations],
    details,
  };
}

/** Deterministic, locale-independent public order: phase, then code. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareIssuesForProjection(a: StructuredIssueV1, b: StructuredIssueV1): number {
  return compareStrings(a.phase, b.phase) || compareStrings(a.code, b.code);
}

function assertProjectionCap(cap: number): void {
  if (cap !== Infinity && (!Number.isSafeInteger(cap) || cap < 0)) {
    throw new Error(`INVALID_VERDICT_VISIBILITY: maxIssues must be a non-negative safe integer or Infinity`);
  }
}

/**
 * Authorized projection of an internal verdict (design §25.5 F06):
 *
 * 1. validate every input issue against the closed registry;
 * 2. filter: drop hidden related locations; suppress the whole issue when its
 *    primary location kind is hidden (never emit nulled-out fields);
 * 3. stable-sort by (phase, code) — equal keys keep input order;
 * 4. apply the public count cap, setting `truncated` when issues are dropped;
 * 5. recompute `summary` from the full visible projection.
 *
 * The verdict `status` is authoritative and is preserved; hidden errors still
 * block operations even though they are not shown.
 */
export function projectStructuredVerdict(
  verdict: StructuredVerdictV1,
  visibility: VerdictVisibilityV1,
): StructuredVerdictV1 {
  const visible = new Set<IssueLocation['kind']>(visibility.visibleLocationKinds);
  const cap = visibility.maxIssues ?? Infinity;
  assertProjectionCap(cap);

  const visibleIssues: StructuredIssueV1[] = [];
  for (const issue of verdict.issues) {
    assertRegisteredCombo(issue.code, issue.phase, issue.primaryLocation);
    for (const related of issue.relatedLocations) {
      assertRegisteredCombo(issue.code, issue.phase, related);
    }
    if (!visible.has(issue.primaryLocation.kind)) {
      // Hidden primary: suppress the entire issue — never null out fields.
      continue;
    }
    visibleIssues.push({
      ...issue,
      relatedLocations: issue.relatedLocations.filter((loc) => visible.has(loc.kind)),
    });
  }

  // Array.prototype.sort is stable (ES2019+), so equal keys keep input order.
  visibleIssues.sort(compareIssuesForProjection);

  let errors = 0;
  let warnings = 0;
  for (const issue of visibleIssues) {
    if (issue.severity === 'error') errors += 1;
    else warnings += 1;
  }

  const truncated = verdict.truncated || visibleIssues.length > cap;
  const projected = visibleIssues.length > cap ? visibleIssues.slice(0, cap) : visibleIssues;

  return {
    version: 1,
    status: verdict.status,
    issues: projected,
    truncated,
    summary: { errors, warnings },
  };
}
