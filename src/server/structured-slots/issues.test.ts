/**
 * Closed issue registry (design §25.5 F02/F03), issue construction and the
 * authorized projection pipeline (§19.1/F06, design §25.5 F06).
 */
import { describe, it, expect } from 'vitest';
import type {
  StructuredIssueV1,
  StructuredVerdictV1,
  IssueLocation,
} from '../../shared/structured-slots';
import {
  STRUCTURED_ISSUE_REGISTRY,
  makeStructuredIssue,
  projectStructuredVerdict,
  isIssueLocation,
  ALL_LOCATION_KINDS,
} from './issues';

/** The v1 minimum code set frozen in design §25.5 F03. */
const F03_CODES = [
  'SLOTS_CONTRACT_INVALID',
  'SLOTS_REFERENCE_UNKNOWN',
  'SLOTS_RESOURCE_INVALID',
  'TEMPLATE_RUNTIME_UNAVAILABLE',
  'SPEC_SCHEMA_INVALID',
  'CONTENT_SCHEMA_INVALID',
  'CONTENT_REQUIRED',
  'CONTENT_FORBIDDEN',
  'LAYOUT_GRAMMAR_NODE_INVALID',
  'LAYOUT_GRAMMAR_REFERENCE_UNKNOWN',
  'LAYOUT_GRAMMAR_PRODUCTION_UNREACHABLE',
  'LAYOUT_GRAMMAR_NULLABLE_REPEAT',
  'LAYOUT_GRAMMAR_NON_TERMINATING',
  'LAYOUT_GRAMMAR_CHOICE_AMBIGUOUS',
  'LAYOUT_GRAMMAR_OPTIONAL_FOLLOW_CONFLICT',
  'LAYOUT_GRAMMAR_REPEAT_FOLLOW_CONFLICT',
  'PROPOSAL_CLIENT_KEY_DUPLICATE',
  'STRUCTURE_ROOT_TYPE_INVALID',
  'STRUCTURE_PRODUCTION_MISMATCH',
  'SLOT_CAPABILITY_REQUIRED',
  'SLOT_NOT_VISIBLE',
  'SLOT_WRITE_FORBIDDEN',
  'PROPOSAL_NOT_OPEN',
  'DRAFT_NOT_OPEN',
  'DRAFT_STALE',
  'SCAFFOLD_NOT_ACTIVE',
  'COMMIT_CANDIDATE_STALE',
  'RESOURCE_LIMIT_EXCEEDED',
  'IDEMPOTENCY_CONFLICT',
  'VALIDATOR_REJECTED',
  'VALIDATOR_ADVISORY',
  'VALIDATOR_UNAVAILABLE',
  'VALIDATOR_RESULT_INVALID',
  'ASSEMBLER_FAILED',
  'ASSEMBLER_UNAVAILABLE',
  'ASSEMBLER_RESULT_INVALID',
  'ARTIFACT_SCHEMA_MISMATCH',
  'ARTIFACT_INTEGRITY_FAILED',
  'PUBLISH_FAILED',
] as const;

const PHASES = [
  'template_load',
  'structure',
  'draft',
  'merge',
  'seal_input',
  'assemble',
  'seal_output',
  'publish',
] as const;

const SOURCES = [
  'template_loader',
  'slot_schema',
  'layout_grammar',
  'access_control',
  'resource_limits',
  'lifecycle',
  'validator',
  'assembler',
  'artifact_validator',
  'publisher',
] as const;

const slotLoc = (slotId = 's1', field: 'node' | 'spec' | 'content' | 'children' = 'content'): IssueLocation => ({
  kind: 'slot',
  slotId,
  field,
  valuePointer: '',
});
const proposalLoc = (clientKey = 'n1'): IssueLocation => ({
  kind: 'proposal',
  clientKey,
  instancePath: '',
  field: 'node',
  valuePointer: '',
});
const operationLoc = (): IssueLocation => ({ kind: 'operation' });

function verdict(issues: StructuredIssueV1[], over: Partial<StructuredVerdictV1> = {}): StructuredVerdictV1 {
  return {
    version: 1,
    status: 'failed',
    issues,
    truncated: false,
    summary: { errors: 0, warnings: 0 },
    ...over,
  };
}

describe('STRUCTURED_ISSUE_REGISTRY — closed v1 code registry', () => {
  it('registers exactly the design §25.5 F03 code set', () => {
    expect(Object.keys(STRUCTURED_ISSUE_REGISTRY).sort()).toEqual([...F03_CODES].sort());
  });

  it('pins the brief CONTENT_SCHEMA_INVALID entry verbatim', () => {
    expect(STRUCTURED_ISSUE_REGISTRY.CONTENT_SCHEMA_INVALID).toEqual({
      source: 'slot_schema',
      phases: ['draft', 'merge', 'seal_input'],
      severity: 'error',
      locations: ['proposal', 'slot'],
    });
  });

  it('pins the brief VALIDATOR_ADVISORY entry verbatim', () => {
    expect(STRUCTURED_ISSUE_REGISTRY.VALIDATOR_ADVISORY).toEqual({
      source: 'validator',
      phases: ['merge', 'seal_input'],
      severity: 'warning',
      locations: ['slot', 'operation'],
    });
  });

  it('has only one warning code (VALIDATOR_ADVISORY)', () => {
    const warnings = Object.entries(STRUCTURED_ISSUE_REGISTRY)
      .filter(([, entry]) => entry.severity === 'warning')
      .map(([code]) => code);
    expect(warnings).toEqual(['VALIDATOR_ADVISORY']);
  });

  it('every entry is well-formed against the closed enums', () => {
    for (const entry of Object.values(STRUCTURED_ISSUE_REGISTRY)) {
      expect(SOURCES).toContain(entry.source);
      expect(['error', 'warning']).toContain(entry.severity);
      expect(entry.phases.length).toBeGreaterThan(0);
      expect(entry.locations.length).toBeGreaterThan(0);
      for (const phase of entry.phases) expect(PHASES).toContain(phase);
      for (const kind of entry.locations) expect(ALL_LOCATION_KINDS).toContain(kind);
    }
  });
});

describe('isIssueLocation — closed six-variant union', () => {
  it('accepts all six canonical variants', () => {
    expect(isIssueLocation({ kind: 'contract', pointer: '' })).toBe(true);
    expect(
      isIssueLocation({
        kind: 'template_resource',
        resourcePath: 'slots/validators/a.js',
        span: null,
      }),
    ).toBe(true);
    expect(
      isIssueLocation({
        kind: 'proposal',
        clientKey: 'n1',
        instancePath: '',
        field: 'spec',
        valuePointer: '/a',
      }),
    ).toBe(true);
    expect(isIssueLocation(slotLoc())).toBe(true);
    expect(
      isIssueLocation({ kind: 'artifact', routeId: 'r1', artifactPath: 'out.md', valuePointer: '' }),
    ).toBe(true);
    expect(isIssueLocation(operationLoc())).toBe(true);
  });

  it('accepts a valid TextSpan and rejects malformed ones', () => {
    const base = { kind: 'template_resource' as const, resourcePath: 'a' };
    expect(
      isIssueLocation({
        ...base,
        span: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
      }),
    ).toBe(true);
    expect(isIssueLocation({ ...base, span: { start: { line: 0, column: 0 }, end: { line: -1, column: 1 } } })).toBe(false);
    expect(isIssueLocation({ ...base, span: { start: { line: 1, column: 0 }, end: { line: 0, column: 1 } } })).toBe(false);
  });

  it('rejects unknown kinds, extra fields and wrong field values', () => {
    expect(isIssueLocation({ kind: 'nope' })).toBe(false);
    expect(isIssueLocation({ kind: 'operation', extra: 1 })).toBe(false);
    expect(isIssueLocation({ kind: 'contract' })).toBe(false);
    expect(isIssueLocation({ kind: 'slot', slotId: 's', field: 'bogus', valuePointer: '' })).toBe(false);
    expect(isIssueLocation({ kind: 'slot', slotId: 's', field: 'content', valuePointer: '', extra: 1 })).toBe(false);
    expect(isIssueLocation(null)).toBe(false);
    expect(isIssueLocation('operation')).toBe(false);
    expect(isIssueLocation([{ kind: 'operation' }])).toBe(false);
  });
});

describe('makeStructuredIssue', () => {
  it('builds a fully populated issue from the registry', () => {
    const issue = makeStructuredIssue(
      'CONTENT_SCHEMA_INVALID',
      'merge',
      slotLoc('s1'),
      { keyword: 'type', expected: 'string' },
      [proposalLoc('n1')],
    );
    expect(issue).toEqual({
      version: 1,
      code: 'CONTENT_SCHEMA_INVALID',
      severity: 'error',
      phase: 'merge',
      source: 'slot_schema',
      message: 'CONTENT_SCHEMA_INVALID (merge)',
      primaryLocation: slotLoc('s1'),
      relatedLocations: [proposalLoc('n1')],
      details: { keyword: 'type', expected: 'string' },
    });
  });

  it('defaults relatedLocations to an empty array', () => {
    const issue = makeStructuredIssue('VALIDATOR_ADVISORY', 'merge', operationLoc(), {});
    expect(issue.relatedLocations).toEqual([]);
    expect(issue.message).toBe('VALIDATOR_ADVISORY (merge)');
  });

  it('rejects unregistered codes', () => {
    expect(() =>
      makeStructuredIssue('NOT_A_CODE' as never, 'merge', operationLoc(), {}),
    ).toThrow('UNREGISTERED_ISSUE_CODE');
  });

  it('rejects a phase the code does not allow', () => {
    expect(() =>
      makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'structure', slotLoc(), {}),
    ).toThrow('UNREGISTERED_ISSUE_PHASE');
  });

  it('rejects a location kind the code does not allow', () => {
    expect(() =>
      makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'merge', operationLoc(), {}),
    ).toThrow('UNREGISTERED_ISSUE_LOCATION');
  });

  it('rejects a related location kind the code does not allow', () => {
    expect(() =>
      makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'merge', slotLoc(), {}, [operationLoc()]),
    ).toThrow('UNREGISTERED_ISSUE_LOCATION');
  });

  it('rejects malformed locations and non-JSON details', () => {
    expect(() =>
      makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'merge', { kind: 'slot', slotId: 's' } as never, {}),
    ).toThrow();
    expect(() =>
      makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'merge', slotLoc(), 'nope' as never),
    ).toThrow();
  });
});

describe('projectStructuredVerdict — authorized projection (F06)', () => {
  it('drops hidden related locations but keeps a visible primary', () => {
    const issue = makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'merge', slotLoc(), {}, [proposalLoc()]);
    const out = projectStructuredVerdict(verdict([issue]), { visibleLocationKinds: ['slot'] });
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].primaryLocation).toEqual(slotLoc());
    expect(out.issues[0].relatedLocations).toEqual([]);
  });

  it('suppresses an issue whose primary location kind is hidden', () => {
    const issue = makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'merge', slotLoc(), {});
    const out = projectStructuredVerdict(verdict([issue]), { visibleLocationKinds: ['operation'] });
    expect(out.issues).toEqual([]);
  });

  it('never emits a location with hidden fields nulled out', () => {
    const issues = [
      makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'merge', slotLoc(), {}),
      makeStructuredIssue('VALIDATOR_ADVISORY', 'merge', operationLoc(), {}, [slotLoc()]),
    ];
    const out = projectStructuredVerdict(verdict(issues), { visibleLocationKinds: ['operation'] });
    for (const issue of out.issues) {
      expect(issue.primaryLocation.kind).toBe('operation');
      for (const loc of issue.relatedLocations) expect(loc.kind).toBe('operation');
    }
  });

  it('sorts stably by phase then code (machine contract order)', () => {
    const issues = [
      makeStructuredIssue('DRAFT_STALE', 'merge', operationLoc(), {}),
      makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'draft', slotLoc('a'), {}),
      makeStructuredIssue('CONTENT_REQUIRED', 'draft', slotLoc('b'), {}),
    ];
    const out = projectStructuredVerdict(verdict(issues), { visibleLocationKinds: ALL_LOCATION_KINDS });
    expect(out.issues.map((i) => i.code)).toEqual([
      'CONTENT_REQUIRED',
      'CONTENT_SCHEMA_INVALID',
      'DRAFT_STALE',
    ]);
  });

  it('preserves input order for equal sort keys (stable)', () => {
    const a = makeStructuredIssue('DRAFT_STALE', 'merge', operationLoc(), { seq: 1 });
    const b = makeStructuredIssue('DRAFT_STALE', 'merge', operationLoc(), { seq: 2 });
    const out = projectStructuredVerdict(verdict([b, a]), { visibleLocationKinds: ALL_LOCATION_KINDS });
    expect(out.issues.map((i) => i.details)).toEqual([{ seq: 2 }, { seq: 1 }]);
  });

  it('applies the public count cap and sets truncated', () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeStructuredIssue('VALIDATOR_ADVISORY', 'merge', operationLoc(), { i }),
    );
    const out = projectStructuredVerdict(
      verdict(issues, { status: 'passed' }),
      { visibleLocationKinds: ALL_LOCATION_KINDS, maxIssues: 2 },
    );
    expect(out.issues).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it('does not truncate when no cap is given', () => {
    const issues = Array.from({ length: 10 }, () =>
      makeStructuredIssue('VALIDATOR_ADVISORY', 'merge', operationLoc(), {}),
    );
    const out = projectStructuredVerdict(verdict(issues), { visibleLocationKinds: ALL_LOCATION_KINDS });
    expect(out.issues).toHaveLength(10);
    expect(out.truncated).toBe(false);
  });

  it('recomputes summary from the visible projection only', () => {
    const hidden = makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'merge', slotLoc(), {});
    const visibleError = makeStructuredIssue('VALIDATOR_REJECTED', 'merge', operationLoc(), {});
    const visibleWarning = makeStructuredIssue('VALIDATOR_ADVISORY', 'merge', operationLoc(), {});
    const out = projectStructuredVerdict(verdict([hidden, visibleError, visibleWarning]), {
      visibleLocationKinds: ['operation'],
    });
    expect(out.issues).toHaveLength(2);
    expect(out.summary).toEqual({ errors: 1, warnings: 1 });
  });

  it('preserves verdict status and ORs truncation', () => {
    const base = verdict([makeStructuredIssue('VALIDATOR_ADVISORY', 'merge', operationLoc(), {})], {
      status: 'incomplete',
      truncated: true,
    });
    const out = projectStructuredVerdict(base, { visibleLocationKinds: ALL_LOCATION_KINDS });
    expect(out.status).toBe('incomplete');
    expect(out.truncated).toBe(true);
  });

  it('rejects an unregistered code inside an input verdict', () => {
    const bad: StructuredIssueV1 = {
      ...makeStructuredIssue('CONTENT_SCHEMA_INVALID', 'merge', slotLoc(), {}),
      code: 'BOGUS',
    };
    expect(() =>
      projectStructuredVerdict(verdict([bad]), { visibleLocationKinds: ALL_LOCATION_KINDS }),
    ).toThrow('UNREGISTERED_ISSUE_CODE');
  });

  it('rejects a malformed public count cap', () => {
    expect(() =>
      projectStructuredVerdict(verdict([]), { visibleLocationKinds: ALL_LOCATION_KINDS, maxIssues: -1 }),
    ).toThrow();
  });
});
