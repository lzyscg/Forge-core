// @vitest-environment node
/**
 * Finding-domain tests (Task 3 brief Step 1): mixed routes Map first, pure
 * classification, severity derivation, lifecycle transitions, verification
 * stage binding and deterministic repair routing (§13/§11.8/§11.9).
 */
import { describe, expect, it } from 'vitest';
import {
  applyFindingVerification,
  assertFindingSeveritySource,
  assertFindingTransition,
  assertFindingVerificationBaseline,
  classifyAndRouteFindings,
  requiredStagesOf,
} from './finding-domain';
import type { FindingV2 } from './authority-types';

function finding(overrides: Partial<FindingV2> = {}): FindingV2 {
  return {
    findingId: 'f1',
    reviewContext: { kind: 'content', roundId: 'r1' },
    primaryLocation: { kind: 'slot', id: 's1' },
    relatedSlotIds: [],
    relatedRelationIds: [],
    defectClass: 'content',
    severity: 'blocking',
    source: 'reviewer',
    evidence: [{ evidenceDigest: 'e1', text: 'evidence', refs: [] }],
    suggestedRepairSlotIds: [],
    status: 'open',
    repairProgress: { map: 'not_required', content: 'pending' },
    openedBy: { kind: 'reviewer', reviewerAttemptId: 'a1' },
    ...overrides,
  };
}

describe('defect classification and routing (§11.8/§13)', () => {
  it('mixed Finding routes Map first; map always precedes content', () => {
    const routed = classifyAndRouteFindings([
      finding({ findingId: 'content-only', defectClass: 'content' }),
      finding({ findingId: 'the-mixed', defectClass: 'mixed', primaryLocation: { kind: 'slot', id: 's2' } }),
    ]);
    expect(routed.route).toBe('map_repair');
    expect(routed.mapFirst).toBe(true);
    expect(routed.mapRepairPlanFindings.map((f) => f.findingId)).toEqual(['the-mixed']);
  });

  it('pure content findings route to content repair', () => {
    const routed = classifyAndRouteFindings([finding()]);
    expect(routed.route).toBe('content_repair');
    expect(routed.mapFirst).toBe(false);
  });

  it('advisory-only findings route to none (no repair plan)', () => {
    const routed = classifyAndRouteFindings([finding({ severity: 'advisory' })]);
    expect(routed.route).toBe('none');
  });

  it('blocking map finding alone forces Map repair first', () => {
    const routed = classifyAndRouteFindings([finding({ defectClass: 'map', primaryLocation: { kind: 'map_node', id: 'n1' } })]);
    expect(routed.route).toBe('map_repair');
  });
});

describe('severity and lifecycle (§11.8)', () => {
  it('slot reject must be blocking; downgrades are rejected', () => {
    expect(() => assertFindingSeveritySource({ severity: 'advisory', verdict: 'reject' })).toThrow('SCHEMA_INVALID');
    expect(() => assertFindingSeveritySource({ severity: 'blocking', verdict: 'reject' })).not.toThrow();
    expect(() => assertFindingSeveritySource({ severity: 'advisory', verdict: 'pass' })).not.toThrow();
  });

  it('transition chain open -> repair_planned -> repair_dispatched -> addressed, then verified_closed', () => {
    expect(() => assertFindingTransition('open', 'repair_planned')).not.toThrow();
    expect(() => assertFindingTransition('repair_planned', 'repair_dispatched')).not.toThrow();
    expect(() => assertFindingTransition('repair_dispatched', 'addressed')).not.toThrow();
    expect(() => assertFindingTransition('addressed', 'verified_closed')).not.toThrow();
    expect(() => assertFindingTransition('open', 'verified_closed')).toThrow('SCHEMA_INVALID');
  });

  it('mixed Finding requires both stages; a pure map Finding only the map stage', () => {
    expect(requiredStagesOf('mixed')).toEqual(['map', 'content']);
    expect(requiredStagesOf('map')).toEqual(['map']);
    expect(requiredStagesOf('content')).toEqual(['content']);
  });

  it('still_present reopens; resolved with stage verified advances; mixed stays open after map stage', () => {
    const mixed = finding({ defectClass: 'mixed', repairProgress: { map: 'committed', content: 'not_required' } });
    // Map stage committed and verified: mixed advances to content stage, NOT closed
    const after = applyFindingVerification(mixed, {
      reviewContext: { kind: 'map', roundId: 'mr' },
      repairStage: 'map',
      verdict: 'resolved',
      mapContextDigests: { map: 'd' },
      evidence: [],
    });
    expect(after.status).toBe('repair_planned');
    expect(after.repairProgress.map).toBe('verified');
    expect(after.repairProgress.content).toBe('pending');

    // content repair commits, the Finding reaches addressed, then verification resolves it
    const contentAddressed = { ...after, status: 'addressed' as const, repairProgress: { ...after.repairProgress, content: 'committed' as const } };
    const contentDone = applyFindingVerification(contentAddressed, {
      reviewContext: { kind: 'content', roundId: 'cr' },
      repairStage: 'content',
      verdict: 'resolved',
      mapContextDigests: { content: 'd2' },
      evidence: [],
    });
    expect(contentDone.status).toBe('verified_closed');
    expect(contentDone.repairProgress.content).toBe('verified');

    const reopened = applyFindingVerification(mixed, {
      reviewContext: { kind: 'map', roundId: 'mr' },
      repairStage: 'map',
      verdict: 'still_present',
      mapContextDigests: { map: 'd' },
      evidence: [],
    });
    expect(reopened.status).toBe('open');
    expect(reopened.repairProgress.map).toBe('pending');
  });
});

describe('finding verification baseline (§11.9)', () => {
  it('map stage verification binds candidateId; content stage binds mapId', () => {
    expect(() =>
      assertFindingVerificationBaseline('map', { candidateId: 'c1', mapId: null }),
    ).not.toThrow();
    expect(() =>
      assertFindingVerificationBaseline('map', { candidateId: null, mapId: 'm1' }),
    ).toThrow('SCHEMA_INVALID');
    expect(() =>
      assertFindingVerificationBaseline('content', { candidateId: null, mapId: 'm1' }),
    ).not.toThrow();
  });
});