// @vitest-environment node
/**
 * Task 18 finding-service tests (design §11.8/§11.9/§11.5, spec §13.3): the
 * Finding lifecycle, classification (content|map|mixed, mixed Map-first),
 * verification stages (resolved|still_present), the finding-stage root, the
 * deterministic repair route, and the reviewer/system-validator source rules.
 */
import { describe, expect, it } from 'vitest';
import type { FindingV2 } from '../../authoritative-review/authority-types';
import {
  buildFindingStageRoot,
  findingStageEntriesOf,
  projectFindingLifecycle,
  repairRouteOf,
  verificationStagesOf,
  classifyCrossScopeObligation,
  REQUIRED_STAGES_BY_DEFECT,
  type ProjectedFindingLifecycleV2,
} from './finding-service';

function lifecycle(overrides: Partial<ProjectedFindingLifecycleV2> = {}): ProjectedFindingLifecycleV2 {
  return {
    findingId: 'f-1',
    defectClass: 'content',
    severity: 'blocking',
    source: 'reviewer',
    status: 'open',
    addressStages: [],
    verifiedStages: [],
    closed: false,
    blockingUnclosed: true,
    ...overrides,
  };
}

describe('finding lifecycle (design §11.8)', () => {
  it('a fresh blocking reviewer finding is open and blocks settlement', () => {
    const f = projectFindingLifecycle({ finding: { findingId: 'f-1', defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'open', addressStages: [], verifiedStages: [] } });
    expect(f.status).toBe('open');
    expect(f.blockingUnclosed).toBe(true);
    expect(f.closed).toBe(false);
  });

  it('a committed stage (addressed) is not closed until verified', () => {
    const f = projectFindingLifecycle({ finding: { findingId: 'f-1', defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [] } });
    expect(f.status).toBe('addressed');
    expect(f.blockingUnclosed).toBe(true);
  });

  it('an advisory finding is never blocking even when open', () => {
    const f = projectFindingLifecycle({ finding: { findingId: 'f-1', defectClass: 'content', severity: 'advisory', source: 'reviewer', state: 'open', addressStages: [], verifiedStages: [] } });
    expect(f.blockingUnclosed).toBe(false);
  });

  it('a finding closes only when ALL required stages are verified (mixed needs map THEN content)', () => {
    const mapOnly = projectFindingLifecycle({ finding: { findingId: 'f-1', defectClass: 'mixed', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['map'], verifiedStages: ['map'] } });
    expect(mapOnly.closed).toBe(false);
    expect(mapOnly.status).toBe('addressed');
    const all = projectFindingLifecycle({ finding: { findingId: 'f-1', defectClass: 'mixed', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['map', 'content'], verifiedStages: ['map', 'content'] } });
    expect(all.closed).toBe(true);
    expect(all.status).toBe('verified_closed');
    expect(all.blockingUnclosed).toBe(false);
  });

  it('mixed always requires the Map stage FIRST (required-stage order)', () => {
    expect(REQUIRED_STAGES_BY_DEFECT.mixed).toEqual(['map', 'content']);
    expect(REQUIRED_STAGES_BY_DEFECT.content).toEqual(['content']);
    expect(REQUIRED_STAGES_BY_DEFECT.map).toEqual(['map']);
  });

  it('a still_present verdict does not verify the stage (the finding stays open, blocking remains)', () => {
    // The projection's verifiedStages only records `resolved` verdicts
    // (applyFindingVerification pushes on verdict === 'resolved').
    const stillPresent = projectFindingLifecycle({ finding: { findingId: 'f-1', defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [] } });
    expect(stillPresent.status).toBe('addressed');
    expect(stillPresent.closed).toBe(false);
    expect(stillPresent.blockingUnclosed).toBe(true);
    // A resolved verdict on the SAME stage closes the content-only finding.
    const resolved = projectFindingLifecycle({ finding: { findingId: 'f-1', defectClass: 'content', severity: 'blocking', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: ['content'] } });
    expect(resolved.closed).toBe(true);
    expect(resolved.blockingUnclosed).toBe(false);
  });

  it('system-validator findings are verified by validator rerun — never reviewer verification targets', () => {
    const findings: ProjectedFindingLifecycleV2[] = [
      lifecycle({ findingId: 'f-sv', source: 'system_validator', defectClass: 'content', addressStages: ['content'], verifiedStages: [] }),
      lifecycle({ findingId: 'f-r', source: 'reviewer', defectClass: 'content', addressStages: ['content'], verifiedStages: [] }),
    ];
    expect(verificationStagesOf(findings)).toEqual(['f-r:content']);
  });
});

describe('verification stages + finding-stage root', () => {
  it('verification stages name reviewer-source addressed-but-unverified stages only', () => {
    const findings: ProjectedFindingLifecycleV2[] = [
      lifecycle({ findingId: 'f-1', source: 'reviewer', addressStages: ['content'], verifiedStages: [] }),
      lifecycle({ findingId: 'f-2', source: 'system_validator', addressStages: ['content'], verifiedStages: [] }),
      lifecycle({ findingId: 'f-3', source: 'reviewer', addressStages: ['content'], verifiedStages: ['content'] }),
    ];
    expect(verificationStagesOf(findings)).toEqual(['f-1:content']);
  });

  it('the finding-stage root is deterministic and sorted; verified stages become verified', () => {
    const findings: ProjectedFindingLifecycleV2[] = [
      lifecycle({ findingId: 'f-1', source: 'reviewer', addressStages: ['content'], verifiedStages: ['content'] }),
      lifecycle({ findingId: 'f-2', source: 'reviewer', defectClass: 'mixed', addressStages: ['map'], verifiedStages: [] }),
    ];
    const entries = findingStageEntriesOf(findings);
    expect(entries).toEqual([
      { findingId: 'f-1', repairStage: 'content', state: 'verified' },
      { findingId: 'f-2', repairStage: 'map', state: 'committed' },
      { findingId: 'f-2', repairStage: 'content', state: 'pending' },
    ]);
    const root = buildFindingStageRoot('r-1', entries);
    expect(root.roundId).toBe('r-1');
    expect(root.entries).toEqual(entries);
    expect(root.rootDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deterministic repair route (design §11.5 / spec §13.3)', () => {
  it('any map/mixed blocking finding routes Map repair FIRST', () => {
    const findings = [lifecycle({ defectClass: 'mixed', severity: 'blocking' })];
    expect(repairRouteOf(findings, 'clear')).toBe('map_repair');
    expect(repairRouteOf([lifecycle({ defectClass: 'map', severity: 'blocking' })], 'clear')).toBe('map_repair');
  });

  it('content-only blocking routes content repair; advisory-only stays clear', () => {
    expect(repairRouteOf([lifecycle({ defectClass: 'content', severity: 'blocking' })], 'clear')).toBe('content_repair');
    expect(repairRouteOf([lifecycle({ severity: 'advisory' })], 'clear')).toBe('clear');
  });

  it('infrastructure failure dominates every finding route', () => {
    expect(repairRouteOf([lifecycle({ defectClass: 'mixed', severity: 'blocking' })], 'infrastructure_failure')).toBe('infrastructure_failure');
  });
});

describe('cross-scope routing obligations (spec §11.3)', () => {
  it('an unreviewed primary target routes to the deterministic successor; a reviewed primary enters the whole-decision set', () => {
    expect(classifyCrossScopeObligation({ finding: { severity: 'blocking', status: 'open' }, primaryReviewed: false })).toBe('unreviewed_primary');
    expect(classifyCrossScopeObligation({ finding: { severity: 'blocking', status: 'open' }, primaryReviewed: true })).toBe('reviewed_primary_whole_decision');
  });
});

describe('finding lifecycle status strings are legal FindingV2 statuses', () => {
  it('every projected status is one of the FindingV2 closed union', () => {
    const legal: readonly FindingV2['status'][] = ['open', 'repair_planned', 'repair_dispatched', 'addressed', 'verified_closed'];
    const statuses = [
      projectFindingLifecycle({ finding: { findingId: 'f', defectClass: 'content', severity: 'advisory', source: 'reviewer', state: 'open', addressStages: [], verifiedStages: [] } }).status,
      projectFindingLifecycle({ finding: { findingId: 'f', defectClass: 'content', severity: 'advisory', source: 'reviewer', state: 'addressed', addressStages: ['content'], verifiedStages: [] } }).status,
    ];
    for (const status of statuses) expect(legal).toContain(status);
  });
});
