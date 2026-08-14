/**
 * Task 14 validator registry: the allowlisted deterministic handler allowlist
 * (spec §6.5/§12, design §9/§16.3).
 *
 * First-release v2 validators are INSTALLED platform builtins only — never
 * template-supplied code. The registry maps one installed handler identity to
 * exactly one frozen implementation: handlerKey + implementationDigest +
 * moduleId + exportName + trigger + executionPhase + ABI + budget. A Contract
 * v2 registration resolves against it and fails closed when the identity is
 * unknown, ambiguous, digest-mismatched, non-builtin, phase-illegal,
 * advisory-on-seal_output, budget-expanding, contract-version-mismatched, or
 * when a v1 CJS registration is passed to the v2 surface.
 *
 * The registry carries ZERO business vocabulary and no filesystem/EventStore/
 * clock/random access (pure module, matching the runtime boundary rules).
 */
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type { ValidatorTriggerV2 } from '../../authoritative-review/authority-types';
import type { ValidatorBudgetProfileV1 } from '../../structured-slots/authoritative-review-profile';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import { ValidatorExecutionPhaseV2 } from '../../structured-slots/authoritative-review-profile';

/** Stable registry reject code shared by every reject path. */
export const VALIDATOR_REGISTRY_INVALID = 'VALIDATOR_REGISTRY_INVALID';

export class ValidatorRegistryError extends Error {
  readonly code = VALIDATOR_REGISTRY_INVALID;

  constructor(reason: string) {
    super(`${VALIDATOR_REGISTRY_INVALID}: ${reason}`);
    this.name = 'ValidatorRegistryError';
  }
}

function reject(reason: string): never {
  throw new ValidatorRegistryError(reason);
}

export type { ValidatorExecutionPhaseV2 };

/** The seven v2 triggers re-exported for the registry surface. */
export type { ValidatorTriggerV2 };

/**
 * One installed allowlisted handler identity (spec §6.5). The frozen platform
 * budget is referenced by `budgetProfileId` (resolved against the active
 * profile's `budgetProfiles`); a template registration can only tighten it.
 */
export interface InstalledValidatorEntry {
  handlerKey: string;
  implementationDigest: string;
  moduleId: string;
  exportName: string;
  trigger: ValidatorTriggerV2;
  executionPhase: ValidatorExecutionPhaseV2;
  abi: 'forge-validator/v2';
  /** The platform-frozen budget profile id (never template-writable). */
  budgetProfileId: string;
  /** The exact ABI contract versions this implementation speaks. */
  inputContractVersion: number;
  outputContractVersion: number;
}

/** One registration resolved against its exactly-one installed entry. */
export interface ResolvedValidator {
  entry: InstalledValidatorEntry;
  registration: ValidatorRegistrationV2;
  /** The resolved platform budget (template may only tighten). */
  budget: ValidatorBudgetProfileV1;
}

function sameBudget(
  registration: ValidatorBudgetProfileV1,
  platform: ValidatorBudgetProfileV1,
  where: string,
): boolean {
  return (
    registration.maxInputBytes <= platform.maxInputBytes &&
    registration.maxSelectedTargets <= platform.maxSelectedTargets &&
    registration.maxDurationMs <= platform.maxDurationMs &&
    registration.maxOutputBytes <= platform.maxOutputBytes &&
    registration.maxIssues <= platform.maxIssues &&
    registration.maxMemoryMiB <= platform.maxMemoryMiB
  );
}

/**
 * The allowlisted handler registry. Seeded from `builtin-validators.ts` (the
 * installed production builtins); the active profile's `installedHandlers`
 * must equal the registry identities (the environment constructor verifies
 * registry identity equality), so resolution re-checks against the profile
 * body itself.
 */
export class ValidatorRegistry {
  private readonly byHandlerKey = new Map<string, InstalledValidatorEntry>();

  constructor(entries: readonly InstalledValidatorEntry[]) {
    for (const entry of entries) {
      if (this.byHandlerKey.has(entry.handlerKey)) {
        reject(`multiple installed entries share handlerKey '${entry.handlerKey}'`);
      }
      this.byHandlerKey.set(entry.handlerKey, entry);
    }
  }

  /** The exact installed entries (frozen identity closure of the allowlist). */
  entries(): readonly InstalledValidatorEntry[] {
    return [...this.byHandlerKey.values()];
  }

  /** Exact installed entry lookup by handlerKey; null when not installed. */
  lookup(handlerKey: string): InstalledValidatorEntry | null {
    return this.byHandlerKey.get(handlerKey) ?? null;
  }

  /**
   * Resolves ONE Contract v2 registration against exactly one installed entry
   * (spec §6.5). Every reject path below is fail-closed — unknown/multiple
   * identity, digest mismatch, non-builtin implementation, module/export
   * mismatch, invalid trigger/phase, advisory seal-output, budget expansion,
   * contract-version mismatch and v1 CJS registration are all load failures.
   */
  resolve(
    registration: ValidatorRegistrationV2,
    profile: AuthoritativeReviewProfileSnapshotV1Body,
  ): ResolvedValidator {
    if (!isPlainObject(registration)) {
      reject('a validator registration must be a plain object');
    }
    if (!isPlainObject(registration.implementationRef)) {
      reject(`validator ${registration.validatorId} implementationRef must be a plain object`);
    }
    if (registration.implementationRef.kind !== 'builtin') {
      reject(
        `validator ${registration.validatorId} implementation is not a builtin (v2 accepts only installed allowlisted builtins)`,
      );
    }
    if (registration.abi !== undefined) {
      // The v1 CJS registration shape carries `abi`/`implementation.path`;
      // the v2 registration carries no top-level abi field.
      reject(`validator ${registration.validatorId} carries a v1 CJS ABI field`);
    }
    if (registration.deterministic !== true) {
      reject(`validator ${registration.validatorId} must be deterministic`);
    }
    if (registration.enforcement !== 'blocking' && registration.enforcement !== 'advisory') {
      reject(`validator ${registration.validatorId} enforcement must be blocking|advisory`);
    }
    const entry = this.byHandlerKey.get(registration.handlerKey);
    if (entry === undefined) {
      reject(`handlerKey '${registration.handlerKey}' is not an installed validator`);
    }
    if (entry.implementationDigest !== registration.implementationDigest) {
      reject(
        `validator ${registration.validatorId} implementationDigest does not match the installed entry '${registration.handlerKey}'`,
      );
    }
    if (entry.moduleId !== registration.implementationRef.moduleId) {
      reject(`validator ${registration.validatorId} moduleId does not match the installed entry`);
    }
    if (entry.exportName !== registration.implementationRef.exportName) {
      reject(`validator ${registration.validatorId} exportName does not match the installed entry`);
    }
    if (entry.trigger !== registration.trigger) {
      reject(
        `validator ${registration.validatorId} trigger ${registration.trigger} does not match the installed entry trigger ${entry.trigger}`,
      );
    }
    if (entry.executionPhase !== registration.executionPhase) {
      reject(
        `validator ${registration.validatorId} executionPhase does not match the installed entry for '${registration.handlerKey}'`,
      );
    }
    if (registration.executionPhase !== null && registration.trigger !== 'content_commit') {
      reject(
        `validator ${registration.validatorId} executionPhase is only legal for content_commit`,
      );
    }
    if (registration.trigger === 'seal_output' && registration.enforcement === 'advisory') {
      reject(`validator ${registration.validatorId} seal_output advisory registrations are rejected`);
    }
    if (registration.inputContractVersion !== entry.inputContractVersion) {
      reject(
        `validator ${registration.validatorId} inputContractVersion ${registration.inputContractVersion} does not match the installed entry ${entry.inputContractVersion}`,
      );
    }
    if (registration.outputContractVersion !== entry.outputContractVersion) {
      reject(
        `validator ${registration.validatorId} outputContractVersion ${registration.outputContractVersion} does not match the installed entry ${entry.outputContractVersion}`,
      );
    }
    const platformBudget = profile.budgetProfiles[entry.budgetProfileId];
    if (platformBudget === undefined) {
      reject(`the installed entry '${registration.handlerKey}' references unknown budgetProfileId '${entry.budgetProfileId}'`);
    }
    const registrationBudget = profile.budgetProfiles[registration.budgetProfileId];
    if (registrationBudget === undefined) {
      reject(`validator ${registration.validatorId} references unknown budgetProfileId '${registration.budgetProfileId}'`);
    }
    if (!sameBudget(registrationBudget, platformBudget, registration.budgetProfileId)) {
      reject(`validator ${registration.validatorId} budget profile '${registration.budgetProfileId}' expands the platform budget`);
    }
    return { entry, registration, budget: registrationBudget };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
