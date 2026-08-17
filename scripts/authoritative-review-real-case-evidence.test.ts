// @vitest-environment node
/**
 * Authoritative review v2 real-case evidence schema unit tests (Task 29,
 * design §25.2 + Spec §19.2/§20).
 *
 * Pins the deterministic compliance contract for the real-case evidence
 * BEFORE the production runner tries to use it. The hermetic acceptance
 * (Task 27) does the same trick for the parser / preflight / event-order
 * hooks; this file pins the real-case evidence schema + source-tree
 * digest algorithm + critical-sequence capture + ref-chain invariants.
 *
 * - `validateAuthoritativeReviewRealCaseEvidence` rejects unknown fields,
 *   wrong schemaVersion, mismatched runner identity / pi-preflight / ABI
 *   list, missing critical-sequence members, wrong digest shapes.
 * - `buildAuthoritativeReviewRealCaseEvidence` emits exactly the frozen
 *   field set, in deterministic key order.
 * - `sourceTreeDigest` excludes the four generated outputs (the same
 *   allowlist the verify script uses) and is order-stable.
 * - `captureCriticalEventSequence` extracts the frozen critical-sequence
 *   members in first-seen order from a noisy event stream.
 * - `captureEventTail` returns the trailing N event-types for restart
 *   observation.
 * - `validateRefChainInvariants` rejects aliasing (Map ref reused as
 *   bundle ref, SystemArtifact == FinalArtifact) and missing critical
 *   sequence members.
 *
 * None of these tests touch git, the filesystem, or a provider network —
 * every dependency is injected or replaced with a synthetic map.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHORITATIVE_REVIEW_CRITICAL_EVENT_TYPES,
  AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE,
  AUTHORITATIVE_REVIEW_REAL_CASE_FIELDS,
  AUTHORITATIVE_REVIEW_REAL_CASE_INVALID,
  AUTHORITATIVE_REVIEW_REAL_CASE_SCHEMA_VERSION,
  buildAuthoritativeReviewRealCaseEvidence,
  captureCriticalEventSequence,
  captureEventTail,
  sha256Hex,
  sourceTreeDigest,
  validateAuthoritativeReviewRealCaseEvidence,
  validateRefChainInvariants,
  type AuthoritativeReviewRealCaseEvidence,
} from './authoritative-review-real-case-evidence';
import {
  AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
  AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY,
  AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
  AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS,
} from './authoritative-review-evidence-schema';

function baseFacts(): AuthoritativeReviewRealCaseEvidence {
  return {
    schemaVersion: AUTHORITATIVE_REVIEW_REAL_CASE_SCHEMA_VERSION,
    commit: 'a'.repeat(40),
    sourceTreeDigest: 'b'.repeat(64),
    packageLockDigest: 'c'.repeat(64),
    templateSnapshotHash: 'd'.repeat(64),
    taskId: 'task-v1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    providerMode: 'hermetic-only',
    ports: { api: 4101, ui: 5174 },
    templateIdentity: 'zhihu-salt-chapter-draft',
    capabilityStatus: 'enabled',
    capabilityIdentity: 'forge-authoritative-review/v1',
    capabilityProfileDigest: 'e'.repeat(64),
    capabilityEvidenceDigest: 'f'.repeat(64),
    finalProfileDigest: '1'.repeat(64),
    finalProfilePath: 'src/server/structured-slots/authoritative-review-profile-v1.json',
    releaseEvidencePath: 'docs/evidence/authoritative-review-release-v1.json',
    platformEvidencePath: 'docs/evidence/authoritative-review-platform-profile-v1.json',
    piPreflightCharacterization: AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
    runnerIdentity: AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
    requiredAbis: [...AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY],
    criticalSequence: [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE],
    eventOrderCriticalSequence: [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE],
    eventTail: [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE],
    browserApiFileReconciled: true,
    restartConfirmed: true,
    restartObservation: 'restart observed',
    restartMismatchCount: 0,
    refChain: {
      mapId: 'map-1',
      mapRef: '1'.repeat(64),
      mapReviewBundleRef: '2'.repeat(64),
      contentManifestRef: '3'.repeat(64),
      reviewBundleRef: '4'.repeat(64),
      sealRecordRef: '5'.repeat(64),
      systemArtifactRef: '6'.repeat(64),
      finalArtifactRef: '7'.repeat(64),
    },
    fileHashes: {
      finalArtifactSha256: 'a'.repeat(64),
      sealRecordSha256: 'b'.repeat(64),
      chapterBytesSha256: 'c'.repeat(64),
    },
    publicErrorCodes: [],
    capabilityCheckpointDigest: '0'.repeat(64),
    hermeticReason: 'REAL_PROVIDER_UNAVAILABLE in this environment; hermetic-only path exercised',
  };
}

describe('AUTHORITATIVE_REVIEW_REAL_CASE_FIELDS', () => {
  it('is frozen and includes the schema version + critical sequence fields', () => {
    expect(AUTHORITATIVE_REVIEW_REAL_CASE_FIELDS).toContain('schemaVersion');
    expect(AUTHORITATIVE_REVIEW_REAL_CASE_FIELDS).toContain('criticalSequence');
    expect(AUTHORITATIVE_REVIEW_REAL_CASE_FIELDS).toContain('refChain');
    expect(AUTHORITATIVE_REVIEW_REAL_CASE_FIELDS).toContain('fileHashes');
  });
});

describe('validateAuthoritativeReviewRealCaseEvidence', () => {
  it('accepts the base fact set', () => {
    expect(() => validateAuthoritativeReviewRealCaseEvidence(baseFacts())).not.toThrow();
  });

  it('accepts the canonical report shape built by the helper', () => {
    const report = buildAuthoritativeReviewRealCaseEvidence(baseFacts());
    expect(() => validateAuthoritativeReviewRealCaseEvidence(report)).not.toThrow();
  });

  it('rejects unknown fields', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['rogue'] = 'cannot ship';
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(
      new RegExp(`${AUTHORITATIVE_REVIEW_REAL_CASE_INVALID}.*unknown field 'rogue'`),
    );
  });

  it('rejects wrong schemaVersion', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['schemaVersion'] = 'wrong/1';
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(/schemaVersion/);
  });

  it('rejects wrong runnerIdentity', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['runnerIdentity'] = 'rogue-runner';
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(/runnerIdentity/);
  });

  it('rejects wrong piPreflightCharacterization', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['piPreflightCharacterization'] = 'rogue';
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(/piPreflightCharacterization/);
  });

  it('rejects wrong requiredAbis list', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['requiredAbis'] = ['forge-validator/v1', 'forge-assembler/v2'];
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(/requiredAbis/);
  });

  it('rejects a critical sequence missing a member', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['criticalSequence'] = [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE.slice(0, -1)];
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(/criticalSequence/);
  });

  it('rejects a critical sequence with an out-of-order member', () => {
    const seq = [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE];
    seq[2] = seq[5] as string;
    seq[5] = AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE[2];
    const raw = baseFacts() as Record<string, unknown>;
    raw['criticalSequence'] = seq;
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(/criticalSequence/);
  });

  it('rejects malformed commit digests', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['commit'] = 'not-a-commit';
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(/commit/);
  });

  it('rejects malformed source-tree digests', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['sourceTreeDigest'] = 'short';
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(/sourceTreeDigest/);
  });

  it('rejects hermetic-only without a hermeticReason', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['hermeticReason'] = null;
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(/hermeticReason/);
  });

  it('rejects an enabled capability carrying a null checkpoint digest', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['capabilityCheckpointDigest'] = null;
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(
      /capabilityCheckpointDigest is required when capability is enabled/,
    );
  });

  it('rejects a disabled capability carrying a non-null checkpoint digest', () => {
    const raw = baseFacts() as Record<string, unknown>;
    raw['capabilityStatus'] = 'disabled';
    raw['capabilityCheckpointDigest'] = '0'.repeat(64);
    expect(() => validateAuthoritativeReviewRealCaseEvidence(raw)).toThrow(
      /capabilityCheckpointDigest must be null when capability is disabled/,
    );
  });
});

describe('buildAuthoritativeReviewRealCaseEvidence', () => {
  it('emits exactly the frozen field set', () => {
    const report = buildAuthoritativeReviewRealCaseEvidence(baseFacts());
    expect(Object.keys(report).sort()).toEqual([...AUTHORITATIVE_REVIEW_REAL_CASE_FIELDS].sort());
  });

  it('carries the canonical schemaVersion', () => {
    const report = buildAuthoritativeReviewRealCaseEvidence(baseFacts());
    expect(report['schemaVersion']).toBe(AUTHORITATIVE_REVIEW_REAL_CASE_SCHEMA_VERSION);
  });

  it('deep-copies the ports / refChain / fileHashes maps', () => {
    const facts = baseFacts();
    const report = buildAuthoritativeReviewRealCaseEvidence(facts);
    expect(report['ports']).not.toBe(facts.ports);
    expect(report['refChain']).not.toBe(facts.refChain);
    expect(report['fileHashes']).not.toBe(facts.fileHashes);
    expect(report['ports']).toEqual({ api: facts.ports.api, ui: facts.ports.ui });
  });
});

describe('sourceTreeDigest', () => {
  it('is stable across equal inputs', () => {
    const tracked = ['src/foo.ts', 'src/bar.ts', 'docs/evidence/authoritative-review-real-case-v1.json'];
    const fileMap: Record<string, Buffer> = {
      'src/foo.ts': Buffer.from('foo'),
      'src/bar.ts': Buffer.from('bar'),
      'docs/evidence/authoritative-review-real-case-v1.json': Buffer.from('evidence'),
    };
    const reader = (path: string): Buffer => fileMap[path] ?? Buffer.alloc(0);
    const a = sourceTreeDigest({ trackedFiles: tracked, readTrackedFile: reader });
    const b = sourceTreeDigest({ trackedFiles: [...tracked].reverse(), readTrackedFile: reader });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('excludes the four generated-output allowlist files', () => {
    const tracked = [...AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS];
    const a = sourceTreeDigest({
      trackedFiles: tracked,
      readTrackedFile: () => Buffer.from('content'),
    });
    // All four paths are filtered out, so the digest is the canonical hash of
    // an empty entries map; it must equal the SHA-256 of "{}".
    const expected = sha256Hex('{}');
    expect(a).toBe(expected);
  });

  it('throws when trackedFiles is not provided', () => {
    expect(() =>
      sourceTreeDigest({ readTrackedFile: () => Buffer.from('') }),
    ).toThrow(/sourceTreeDigest requires explicit trackedFiles/);
  });

  it('throws when readTrackedFile is not provided', () => {
    expect(() => sourceTreeDigest({ trackedFiles: ['src/foo.ts'] })).toThrow(
      /sourceTreeDigest requires explicit readTrackedFile/,
    );
  });
});

describe('captureCriticalEventSequence', () => {
  it('extracts the frozen sequence in first-seen order', () => {
    const noisy = [
      'task_created',
      'task_started',
      'noise_a',
      'structured_map_review_round_planned',
      'more_noise',
      'structured_map_review_assignment_committed',
      'structured_map_review_round_completed',
      'structured_map_review_round_settled',
      'structured_map_activated',
      'structured_content_revision_committed',
      'structured_review_round_planned',
      'structured_content_review_assignment_committed',
      'structured_repair_scope_requested',
      'structured_repair_grant_issued',
      'structured_repair_committed',
      'structured_finding_verified_closed',
      'structured_review_round_settled',
      'structured_scaffold_sealed_v2',
      'structured_system_artifact_delivery_created',
      'artifact_published_v2',
    ];
    const captured = captureCriticalEventSequence(noisy);
    expect([...captured]).toEqual([...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE]);
  });

  it('ignores duplicate critical members (first-seen wins)', () => {
    const noisy = [
      'task_started',
      'structured_map_review_round_planned',
      'structured_map_review_round_planned',
      'structured_map_activated',
      'structured_map_activated',
      'structured_scaffold_sealed_v2',
    ];
    const captured = captureCriticalEventSequence(noisy);
    expect(captured).toEqual([
      'task_started',
      'structured_map_review_round_planned',
      'structured_map_activated',
      'structured_scaffold_sealed_v2',
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(captureCriticalEventSequence([])).toEqual([]);
  });

  it('skips every event type not in the frozen critical set', () => {
    const noisy = ['unrelated_1', 'unrelated_2', 'unrelated_3'];
    expect(captureCriticalEventSequence(noisy)).toEqual([]);
  });

  it('AUTHORITATIVE_REVIEW_CRITICAL_EVENT_TYPES mirrors the frozen sequence', () => {
    for (const member of AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE) {
      expect(AUTHORITATIVE_REVIEW_CRITICAL_EVENT_TYPES.has(member)).toBe(true);
    }
  });
});

describe('captureEventTail', () => {
  it('returns the last N event types', () => {
    expect(captureEventTail(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd']);
    expect(captureEventTail(['a', 'b'], 5)).toEqual(['a', 'b']);
    expect(captureEventTail(['a'], 0)).toEqual([]);
    expect(captureEventTail([], 3)).toEqual([]);
  });
});

describe('validateRefChainInvariants', () => {
  function baseRefs(): AuthoritativeReviewRealCaseEvidence['refChain'] {
    return {
      mapId: 'map-1',
      mapRef: '1'.repeat(64),
      mapReviewBundleRef: '2'.repeat(64),
      contentManifestRef: '3'.repeat(64),
      reviewBundleRef: '4'.repeat(64),
      sealRecordRef: '5'.repeat(64),
      systemArtifactRef: '6'.repeat(64),
      finalArtifactRef: '7'.repeat(64),
    };
  }

  function baseHashes(): AuthoritativeReviewRealCaseEvidence['fileHashes'] {
    return {
      finalArtifactSha256: 'a'.repeat(64),
      sealRecordSha256: '5'.repeat(64),
      chapterBytesSha256: 'c'.repeat(64),
    };
  }

  it('accepts a fully distinct ref chain', () => {
    expect(() =>
      validateRefChainInvariants({
        refChain: baseRefs(),
        fileHashes: baseHashes(),
        criticalSequence: [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE],
      }),
    ).not.toThrow();
  });

  it('rejects aliasing between mapRef and mapReviewBundleRef', () => {
    const refs = baseRefs();
    refs.mapReviewBundleRef = refs.mapRef;
    expect(() =>
      validateRefChainInvariants({
        refChain: refs,
        fileHashes: baseHashes(),
        criticalSequence: [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE],
      }),
    ).toThrow(/mapRef must differ from mapReviewBundleRef/);
  });

  it('rejects aliasing between systemArtifactRef and finalArtifactRef', () => {
    const refs = baseRefs();
    refs.systemArtifactRef = refs.finalArtifactRef;
    expect(() =>
      validateRefChainInvariants({
        refChain: refs,
        fileHashes: baseHashes(),
        criticalSequence: [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE],
      }),
    ).toThrow(/systemArtifactRef must differ from finalArtifactRef/);
  });

  it('rejects a critical sequence missing members', () => {
    expect(() =>
      validateRefChainInvariants({
        refChain: baseRefs(),
        fileHashes: baseHashes(),
        criticalSequence: [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE].slice(0, 4),
      }),
    ).toThrow(/criticalSequence does not cover/);
  });

  it('rejects aliasing among sealRecordRef / systemArtifactRef / finalArtifactRef', () => {
    const refs = baseRefs();
    refs.sealRecordRef = refs.systemArtifactRef;
    expect(() =>
      validateRefChainInvariants({
        refChain: refs,
        fileHashes: baseHashes(),
        criticalSequence: [...AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE],
      }),
    ).toThrow(/must be distinct/);
  });
});

describe('sha256Hex', () => {
  it('matches the canonical Node digest for a known input', () => {
    const known = sha256Hex('hello world');
    expect(known).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('accepts Buffer inputs', () => {
    expect(sha256Hex(Buffer.from('hello world'))).toBe(sha256Hex('hello world'));
  });
});
