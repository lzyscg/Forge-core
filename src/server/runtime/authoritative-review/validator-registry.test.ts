// @vitest-environment node
/**
 * Validator registry tests (Task 14 Step 1, red first).
 *
 * The allowlist resolves a Contract v2 registration to exactly ONE installed
 * registry entry (spec §6.5/design §9): handlerKey + implementationDigest +
 * moduleId + exportName + trigger + phase + ABI + budget. Every reject path is
 * fail-closed: unknown/multiple identity, digest mismatch, non-builtin
 * implementation, invalid trigger/phase, advisory seal-output, budget
 * expansion, contract-version mismatch and v1 CJS registration passed to the
 * v2 surface.
 */
import { describe, expect, it } from 'vitest';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES } from './builtin-validators';
import {
  VALIDATOR_REGISTRY_INVALID,
  ValidatorRegistry,
} from './validator-registry';

const REGISTRY = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);

function testProfile(): AuthoritativeReviewProfileSnapshotV1Body {
  return buildAuthoritativeReviewTestProfileBody();
}

function registration(overrides: Partial<ValidatorRegistrationV2> = {}): ValidatorRegistrationV2 {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES[0]!;
  return {
    validatorId: 'v1',
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: entry.trigger,
    executionPhase: entry.executionPhase,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: entry.inputContractVersion,
    outputContractVersion: entry.outputContractVersion,
    budgetProfileId: entry.budgetProfileId,
    ...overrides,
  };
}

describe('validator registry — exact allowlist resolution', () => {
  it('resolves an exact registration to its one installed entry with the platform budget', () => {
    const profile = testProfile();
    for (const entry of AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES) {
      const resolved = REGISTRY.resolve(
        registration({
          handlerKey: entry.handlerKey,
          implementationDigest: entry.implementationDigest,
          implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
          trigger: entry.trigger,
          executionPhase: entry.executionPhase,
        }),
        profile,
      );
      expect(resolved.entry.handlerKey).toBe(entry.handlerKey);
      expect(resolved.entry.implementationDigest).toBe(entry.implementationDigest);
      expect(resolved.entry.trigger).toBe(entry.trigger);
      expect(resolved.budget).toEqual(profile.budgetProfiles[entry.budgetProfileId]);
      expect(resolved.budget.maxInputBytes).toBeGreaterThan(0);
    }
  });

  it('lookup returns the exact installed entry and lists the full allowlist', () => {
    const first = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES[0]!;
    expect(REGISTRY.lookup(first.handlerKey)).toEqual(first);
    expect(REGISTRY.lookup('ghost.handler')).toBeNull();
    expect(REGISTRY.entries()).toHaveLength(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.length);
  });

  it('rejects an unknown handler identity', () => {
    expect(() => REGISTRY.resolve(registration({ handlerKey: 'ghost.handler' }), testProfile())).toThrow(
      VALIDATOR_REGISTRY_INVALID,
    );
  });

  it('rejects a digest mismatch (same handler key, wrong implementation digest)', () => {
    expect(() =>
      REGISTRY.resolve(registration({ implementationDigest: '0'.repeat(64) }), testProfile()),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects a module/export mismatch', () => {
    expect(() =>
      REGISTRY.resolve(registration({ implementationRef: { kind: 'builtin', moduleId: 'other/module', exportName: 'x' } }), testProfile()),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects a non-builtin implementationRef', () => {
    const base = registration();
    const spoofed = {
      ...base,
      implementationRef: { kind: 'path', path: 'slots/validators/x.cjs' },
    } as unknown as ValidatorRegistrationV2;
    expect(() => REGISTRY.resolve(spoofed, testProfile())).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects a v1 CJS registration passed to the v2 surface', () => {
    const base = registration();
    const v1ish = {
      ...base,
      abi: 'forge-validator/v1',
      implementation: { path: 'slots/validators/x.cjs' },
    } as unknown as ValidatorRegistrationV2;
    expect(() => REGISTRY.resolve(v1ish, testProfile())).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects a trigger that does not match the installed entry', () => {
    const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES[0]!;
    const other = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.trigger !== entry.trigger)!;
    expect(() =>
      REGISTRY.resolve(
        registration({ handlerKey: entry.handlerKey, trigger: other.trigger, executionPhase: other.executionPhase }),
        testProfile(),
      ),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects an executionPhase mismatch and a phase on a non-content trigger', () => {
    const mapEntry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.trigger === 'map_candidate_commit')!;
    expect(() =>
      REGISTRY.resolve(
        registration({ handlerKey: mapEntry.handlerKey, executionPhase: 'batch_commit' }),
        testProfile(),
      ),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
    const contentEntry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.trigger === 'content_commit')!;
    // the installed content_commit builtins are phase-pinned; a phase mismatch rejects
    const wrongPhase = contentEntry.executionPhase === 'batch_commit' ? 'plan_finalize' : 'batch_commit';
    expect(() =>
      REGISTRY.resolve(
        registration({ handlerKey: contentEntry.handlerKey, executionPhase: wrongPhase }),
        testProfile(),
      ),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects an advisory seal_output registration', () => {
    const sealEntry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.trigger === 'seal_output')!;
    expect(() =>
      REGISTRY.resolve(registration({ handlerKey: sealEntry.handlerKey, enforcement: 'advisory' }), testProfile()),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects an unknown budgetProfileId', () => {
    expect(() =>
      REGISTRY.resolve(registration({ budgetProfileId: 'ghost-budget' }), testProfile()),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects budget expansion beyond the platform budget', () => {
    const profile = testProfile();
    const expanded = {
      ...profile.budgetProfiles['authoritative-validator-default']!,
      maxInputBytes: profile.budgetProfiles['authoritative-validator-default']!.maxInputBytes + 1,
    };
    const profileWithExpanded = {
      ...profile,
      budgetProfiles: {
        ...profile.budgetProfiles,
        'authoritative-validator-expanded': expanded,
      },
    } as unknown as AuthoritativeReviewProfileSnapshotV1Body;
    expect(() =>
      REGISTRY.resolve(registration({ budgetProfileId: 'authoritative-validator-expanded' }), profileWithExpanded),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
    // the same (platform) budget id still resolves
    expect(() => REGISTRY.resolve(registration(), profileWithExpanded)).not.toThrow();
  });

  it('rejects a contract-version mismatch', () => {
    expect(() =>
      REGISTRY.resolve(registration({ inputContractVersion: 1, outputContractVersion: 1 }), testProfile()),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
    expect(() =>
      REGISTRY.resolve(registration({ outputContractVersion: 1 }), testProfile()),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects a non-deterministic registration', () => {
    expect(() =>
      REGISTRY.resolve(registration({ deterministic: false as unknown as true }), testProfile()),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
  });

  it('rejects an unknown enforcement value (M-4)', () => {
    expect(() =>
      REGISTRY.resolve(registration({ enforcement: 'fatal' as unknown as 'blocking' }), testProfile()),
    ).toThrow(VALIDATOR_REGISTRY_INVALID);
    expect(() => REGISTRY.resolve(registration({ enforcement: 'advisory' }), testProfile())).not.toThrow();
  });

  it('rejects a malformed implementationRef with a stable registry error, not a TypeError (M-5)', () => {
    const base = registration();
    const malformed = { ...base, implementationRef: undefined } as unknown as ValidatorRegistrationV2;
    expect(() => REGISTRY.resolve(malformed, testProfile())).toThrow(VALIDATOR_REGISTRY_INVALID);
    const nonObject = { ...base, implementationRef: 'builtin' } as unknown as ValidatorRegistrationV2;
    expect(() => REGISTRY.resolve(nonObject, testProfile())).toThrow(VALIDATOR_REGISTRY_INVALID);
  });
});

describe('validator registry — construction', () => {
  it('rejects a duplicate handlerKey (multiple identity is never allowed)', () => {
    const duplicate = [AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES[0]!, AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES[0]!];
    expect(() => new ValidatorRegistry(duplicate)).toThrow(VALIDATOR_REGISTRY_INVALID);
  });
});
