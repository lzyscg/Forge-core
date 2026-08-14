/**
 * Authoritative review TEST-ONLY registry and environment (Task 5).
 *
 * `createAuthoritativeReviewTestEnvironment()` is the ONLY way to build an
 * enabled authoritative review environment at this stage: it injects the
 * checked-in test-support handler registry, a `qualificationState: test_only`
 * profile and an enabled capability. Production callers never use it — there
 * is no environment-variable bypass and production manifest loading rejects
 * the test-only identities on every enabled path.
 *
 * The test profile body satisfies the pure-domain `AuthoritativeReviewProfile`
 * interface and the first-release capacity floor (maxSlots >= 10,000, 256
 * primary targets, 1,024 total objects per assignment, one active lease); its
 * template ceilings sit at or above every value of the checked-in
 * `authoritative-valid` contract fixture so that fixture loads green.
 */
import type { AuthoritativeReviewCapabilityV1 } from '../authoritative-review-capability';
import {
  createAuthoritativeReviewRuntimeEnvironment,
  isAuthoritativeReviewRunnable,
} from '../authoritative-review-capability';
import type { AuthoritativeReviewHandlerRegistryV1 } from '../authoritative-review-capability';
import type {
  AuthoritativeReviewProfileSnapshotV1Body,
  AssemblerBudgetCeilingV1,
  InstalledHandlerIdentitiesV1,
  TemplateLimitCeilingsV1,
  ValidatorBudgetProfileV1,
} from '../authoritative-review-profile';
import {
  AUTHORITATIVE_REVIEW_PROFILE_IDENTITY,
  validateAuthoritativeReviewProfile,
} from '../authoritative-review-profile';
import { canonicalJsonSha256 } from '../canonical-json';
import { AuthoritativeReviewProfileArchive } from '../authoritative-review-profile-archive';
import { AUTHORITATIVE_BLOB_KINDS_V2 } from '../../../shared/authoritative-review-v2';
import {
  AUTHORITATIVE_REVIEW_TEST_ASSEMBLER_IDENTITY,
  AUTHORITATIVE_REVIEW_TEST_VALIDATOR_IDENTITIES,
} from './authoritative-review-test-handlers';
import {
  AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_IDENTITIES,
  AUTHORITATIVE_REVIEW_BUILTIN_BUDGET_PROFILE_ID,
} from '../../runtime/authoritative-review/builtin-validators';

/** The single checked-in test-only validator budget profile (design §9). */
export const AUTHORITATIVE_REVIEW_TEST_VALIDATOR_DEFAULT_BUDGET: ValidatorBudgetProfileV1 = {
  maxInputBytes: 16 * 1024 * 1024,
  maxSelectedTargets: 256,
  maxDurationMs: 30_000,
  maxOutputBytes: 4 * 1024 * 1024,
  maxIssues: 125,
  maxMemoryMiB: 256,
};

/** The checked-in test-only assembler budget ceiling (spec §13.5). */
export const AUTHORITATIVE_REVIEW_TEST_ASSEMBLER_BUDGET: AssemblerBudgetCeilingV1 = {
  maxTimeoutMs: 60_000,
  maxInputBytes: 256 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
};

/**
 * The checked-in test profile's default per-kind byte caps (4 MiB each,
 * matching the object-registry test default; the profile_snapshot kind uses
 * the profile-independent bootstrap maximum instead). Derived from the closed
 * kind registry so the record can never drift from it.
 */
export function defaultAuthoritativeReviewMaxBytesByKind(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of AUTHORITATIVE_BLOB_KINDS_V2) {
    out[kind] = 4 * 1024 * 1024;
  }
  return out;
}

/** The checked-in test template ceilings — at or above every `authoritative-valid` value. */
export function defaultAuthoritativeReviewTestTemplateCeilings(): TemplateLimitCeilingsV1 {
  return {
    schema: { maxSchemaDepth: 8, maxSchemaNodes: 4096, maxEnumItems: 128, maxPatternLength: 512 },
    structure: { maxSlots: 10_000, maxTreeDepth: 32, maxChildrenPerSlot: 1_000 },
    payload: { maxSpecBytesPerSlot: 65_536, maxContentBytesPerSlot: 1_048_576, maxScaffoldPayloadBytes: 67_108_864 },
    draft: { maxChangedSlots: 2_000, maxDraftBytes: 16_777_216 },
    attempt: {
      maxSlotToolCallsPerAttempt: 512,
      maxValidationRunsPerAttempt: 16,
      maxValidatorInvocationsPerAttempt: 40_000,
      maxAggregateValidatorCpuMsPerAttempt: 240_000,
      maxAggregateValidatorWallClockMsPerAttempt: 480_000,
      maxValidatorOutputBytesPerAttempt: 16_777_216,
      maxAttemptWallClockMs: 600_000,
    },
    validation: {
      maxValidators: 64,
      maxValidatorInvocationsPerGate: 10_000,
      maxAggregateValidatorCpuMsPerGate: 60_000,
      maxAggregateValidatorWallClockMsPerGate: 120_000,
      maxValidatorOutputBytesPerGate: 4_194_304,
      maxIssuesPerRun: 500,
    },
    output: { maxArtifactFiles: 64, maxArtifactBytesPerFile: 16_777_216, maxTotalArtifactBytes: 67_108_864 },
    relations: { maxRelationsPerMap: 4_000, maxRelationsPerSlot: 64, maxRelationImpactHops: 8, maxRelationClosureNodes: 512 },
    authoritative: {
      maxAssignmentsPerRound: 1_024,
      maxPlannedWorkItemsPerRound: 16_000,
      maxConsecutiveAttemptsWithoutProgress: 12,
      maxFindingsPerSlot: 64,
      maxFindingsPerRelation: 32,
      maxFindingsPerRound: 4_000,
      maxEvidenceBytesPerItem: 8_192,
      maxEvidenceBytesTotal: 4_194_304,
      maxWriteSlotsPerRepairGrant: 256,
      maxScopeExpansionsPerRound: 16,
    },
  };
}

/** The checked-in test-only installed-handler identities (exact registry identities). */
export const AUTHORITATIVE_REVIEW_TEST_HANDLER_IDENTITIES: InstalledHandlerIdentitiesV1 = {
  validators: [...AUTHORITATIVE_REVIEW_TEST_VALIDATOR_IDENTITIES].sort((a, b) => {
    const keyA = `${a.handlerKey}:${a.implementationDigest}:${a.trigger}:${String(a.executionPhase)}`;
    const keyB = `${b.handlerKey}:${b.implementationDigest}:${b.trigger}:${String(b.executionPhase)}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  }) as typeof AUTHORITATIVE_REVIEW_TEST_VALIDATOR_IDENTITIES,
  assembler: AUTHORITATIVE_REVIEW_TEST_ASSEMBLER_IDENTITY,
};

/**
 * The installed PROVISIONAL handler identities (Task 14 rotation): the real
 * platform builtin validator identities + the still-test assembler identity.
 * The assembler is not part of this rotation (no assembler builtin exists yet);
 * its identity stays the test `renderSeal` entry so the fixture assembler
 * registration keeps resolving.
 */
export const AUTHORITATIVE_REVIEW_BUILTIN_HANDLER_IDENTITIES: InstalledHandlerIdentitiesV1 = {
  validators: [...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_IDENTITIES].sort((a, b) => {
    const keyA = `${a.handlerKey}:${a.implementationDigest}:${a.trigger}:${String(a.executionPhase)}`;
    const keyB = `${b.handlerKey}:${b.implementationDigest}:${b.trigger}:${String(b.executionPhase)}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  }) as typeof AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_IDENTITIES,
  assembler: AUTHORITATIVE_REVIEW_TEST_ASSEMBLER_IDENTITY,
};

/**
 * The PROVISIONAL handler registry (loading is not part of it — no bypass).
 * Matches the provisional profile's installedHandlers exactly.
 */
export function createAuthoritativeReviewTestHandlerRegistry(): AuthoritativeReviewHandlerRegistryV1 {
  return {
    validators: [...AUTHORITATIVE_REVIEW_BUILTIN_HANDLER_IDENTITIES.validators],
    assembler: AUTHORITATIVE_REVIEW_BUILTIN_HANDLER_IDENTITIES.assembler,
  };
}

/** Shared profile-body construction for both the prior and provisional revisions. */
function buildAuthoritativeReviewProfileBody(options: {
  qualificationState: 'test_only' | 'provisional';
  profileVersion: number;
  installedHandlers: InstalledHandlerIdentitiesV1;
}): AuthoritativeReviewProfileSnapshotV1Body {
  const runtime = {
    maxBytesByKind: defaultAuthoritativeReviewMaxBytesByKind() as AuthoritativeReviewProfileSnapshotV1Body['runtime']['maxBytesByKind'],
    maxSlots: 10_000,
    maxRelationTotal: 4_000,
    maxRelationsPerSlot: 64,
    maxRelationHops: 8,
    maxClosureNodes: 512,
    assignmentMaxPrimaryTargets: 256,
    assignmentMaxTotalObjects: 1_024,
    maxFindingsPerPrimaryTarget: 64,
    maxFindingsPerRound: 4_000,
    evidenceMaxBytesPerItem: 8_192,
    evidenceMaxBytesTotal: 4_194_304,
    maxRepairGrantWriteSlots: 256,
    maxScopeExpansionsPerRound: 16,
    maxRoundsPerTrack: 32,
    maxPlannedWorkItemsPerRound: 16_000,
    maxConsecutiveAttemptsWithoutProgress: 12,
    maxActiveLeasesPerTask: 1,
    mapChunkMaxNodes: 1_024,
    mapChunkMaxRelations: 256,
  };
  const body: Record<string, unknown> = {
    schemaVersion: 1,
    profileIdentity: AUTHORITATIVE_REVIEW_PROFILE_IDENTITY,
    profileVersion: options.profileVersion,
    qualificationState: options.qualificationState,
    profileDigest: '',
    abi: {
      validatorAbi: 'forge-validator/v2',
      assemblerAbi: 'forge-assembler/v2',
      profileAbi: 'forge-authoritative-review/v1',
    },
    runtime,
    template: defaultAuthoritativeReviewTestTemplateCeilings(),
    installedHandlers: options.installedHandlers,
    budgetProfiles: {
      'authoritative-validator-default': AUTHORITATIVE_REVIEW_TEST_VALIDATOR_DEFAULT_BUDGET,
    },
    assemblerBudget: AUTHORITATIVE_REVIEW_TEST_ASSEMBLER_BUDGET,
  };
  // profileDigest = sha256(canonical bytes with the field omitted); compute
  // first so the registered parser can verify the declared digest.
  delete body.profileDigest;
  const digest = canonicalJsonSha256(body);
  body.profileDigest = digest;
  return validateAuthoritativeReviewProfile(body);
}

/**
 * The CURRENT canonical enabled profile body (Task 14 rotation):
 * `qualificationState: provisional` with the REAL installed platform builtin
 * validator identities. The checked-in `authoritative-review-profile-v1.json`
 * is a byte-identical copy of this body — nothing may diverge without failing
 * the profile tests.
 */
export function buildAuthoritativeReviewTestProfileBody(): AuthoritativeReviewProfileSnapshotV1Body {
  return buildAuthoritativeReviewProfileBody({
    qualificationState: 'provisional',
    profileVersion: 2,
    installedHandlers: AUTHORITATIVE_REVIEW_BUILTIN_HANDLER_IDENTITIES,
  });
}

/**
 * The PRIOR immutable profile revision (Task 5, all-aaaa test-only identities,
 * `qualificationState: test_only`, version 1). Task 14 rotates it out of the
 * checked-in file: its exact bytes stay archived (never edited) and it can no
 * longer load a Contract naming the production builtins.
 */
export function buildAuthoritativeReviewPriorTestOnlyProfileBody(): AuthoritativeReviewProfileSnapshotV1Body {
  return buildAuthoritativeReviewProfileBody({
    qualificationState: 'test_only',
    profileVersion: 1,
    installedHandlers: AUTHORITATIVE_REVIEW_TEST_HANDLER_IDENTITIES,
  });
}

/** Builds a runnable enabled environment from one profile body. */
function environmentFrom(
  profile: AuthoritativeReviewProfileSnapshotV1Body,
  registry: AuthoritativeReviewHandlerRegistryV1,
  archive?: AuthoritativeReviewProfileArchive,
): ReturnType<typeof createAuthoritativeReviewRuntimeEnvironment> {
  const capability: AuthoritativeReviewCapabilityV1 = {
    version: 1,
    status: 'enabled',
    profileIdentity: AUTHORITATIVE_REVIEW_PROFILE_IDENTITY,
    profileDigest: profile.profileDigest,
    // Test-only evidence placeholder: production loading never sees it.
    evidenceDigest: '0'.repeat(64),
    requiredAbis: ['forge-validator/v2', 'forge-assembler/v2'],
  };
  const environment = createAuthoritativeReviewRuntimeEnvironment(
    capability,
    profile,
    registry,
    archive ?? new AuthoritativeReviewProfileArchive(),
  );
  if (!isAuthoritativeReviewRunnable(environment)) {
    throw new Error('test support: the injected test environment must be runnable');
  }
  return environment;
}

/**
 * Test/dev-only enabled environment (spec §4.3: development fixtures inject an
 * enabled provisional/test environment explicitly). Production callers never
 * use this — explicit injection only, never an implicit fallback and never an
 * environment-variable bypass. `archive` may be shared across environments to
 * prove archived task-bound profiles survive current-profile changes.
 */
export function createAuthoritativeReviewTestEnvironment(
  options: { archive?: AuthoritativeReviewProfileArchive } = {},
): ReturnType<typeof createAuthoritativeReviewRuntimeEnvironment> {
  return environmentFrom(
    buildAuthoritativeReviewTestProfileBody(),
    createAuthoritativeReviewTestHandlerRegistry(),
    options.archive,
  );
}

/**
 * The PRIOR test-only environment (Task 14 rotation proof): a runnable enabled
 * environment frozen to the OLD all-aaaa test-only registry. A Contract naming
 * the new production builtin digests MUST fail to load under it.
 */
export function createAuthoritativeReviewPriorTestOnlyEnvironment(
  options: { archive?: AuthoritativeReviewProfileArchive } = {},
): ReturnType<typeof createAuthoritativeReviewRuntimeEnvironment> {
  return environmentFrom(
    buildAuthoritativeReviewPriorTestOnlyProfileBody(),
    {
      validators: [...AUTHORITATIVE_REVIEW_TEST_HANDLER_IDENTITIES.validators],
      assembler: AUTHORITATIVE_REVIEW_TEST_HANDLER_IDENTITIES.assembler,
    },
    options.archive,
  );
}