/**
 * Profile bootstrap constants used by the per-kind registrations:
 * `profile_snapshot` sizes itself against a profile-INDEPENDENT bootstrap
 * maximum (spec §7.1/§4.3), never against a profile-owned limit.
 *
 * This file is the single source for the canonical `profile_snapshot` body
 * schema (Task 5): exact group keys and exact per-group field lists that the
 * registered parser (object-schema-parsers-3) and the profile module
 * (structured-slots/authoritative-review-profile) both consume — one schema,
 * two validators. Importing modules must never widen these lists.
 */
export const AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

/** The five closed limit/policy groups of the canonical profile body (Task 5). */
export const PROFILE_SNAPSHOT_GROUP_KEYS = [
  'runtime',
  'template',
  'installedHandlers',
  'budgetProfiles',
  'assemblerBudget',
] as const;

/**
 * Exact field list of the `runtime` group — the concrete limits that satisfy
 * the pure-domain `AuthoritativeReviewProfile` interface (design §22 / §12.3 /
 * §16.1). `maxBytesByKind` is a per-kind record (closed kind registry), not a
 * named scalar, and is asserted separately.
 */
export const PROFILE_RUNTIME_FIELDS = [
  'maxBytesByKind',
  'maxSlots',
  'maxRelationTotal',
  'maxRelationsPerSlot',
  'maxRelationHops',
  'maxClosureNodes',
  'assignmentMaxPrimaryTargets',
  'assignmentMaxTotalObjects',
  'maxFindingsPerPrimaryTarget',
  'maxFindingsPerRound',
  'evidenceMaxBytesPerItem',
  'evidenceMaxBytesTotal',
  'maxRepairGrantWriteSlots',
  'maxScopeExpansionsPerRound',
  'maxRoundsPerTrack',
  'maxPlannedWorkItemsPerRound',
  'maxConsecutiveAttemptsWithoutProgress',
  'maxActiveLeasesPerTask',
  'mapChunkMaxNodes',
  'mapChunkMaxRelations',
] as const;

/**
 * Exact field names of the `template` group — ceilings over every one of the
 * 42 Contract v2 limit fields (Task 4's closed set), so a template can only
 * tighten, never expand (design §22.2: "模板只能收紧").
 */
export const PROFILE_TEMPLATE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  schema: ['maxSchemaDepth', 'maxSchemaNodes', 'maxEnumItems', 'maxPatternLength'],
  structure: ['maxSlots', 'maxTreeDepth', 'maxChildrenPerSlot'],
  payload: ['maxSpecBytesPerSlot', 'maxContentBytesPerSlot', 'maxScaffoldPayloadBytes'],
  draft: ['maxChangedSlots', 'maxDraftBytes'],
  attempt: [
    'maxSlotToolCallsPerAttempt',
    'maxValidationRunsPerAttempt',
    'maxValidatorInvocationsPerAttempt',
    'maxAggregateValidatorCpuMsPerAttempt',
    'maxAggregateValidatorWallClockMsPerAttempt',
    'maxValidatorOutputBytesPerAttempt',
    'maxAttemptWallClockMs',
  ],
  validation: [
    'maxValidators',
    'maxValidatorInvocationsPerGate',
    'maxAggregateValidatorCpuMsPerGate',
    'maxAggregateValidatorWallClockMsPerGate',
    'maxValidatorOutputBytesPerGate',
    'maxIssuesPerRun',
  ],
  output: ['maxArtifactFiles', 'maxArtifactBytesPerFile', 'maxTotalArtifactBytes'],
  relations: ['maxRelationsPerMap', 'maxRelationsPerSlot', 'maxRelationImpactHops', 'maxRelationClosureNodes'],
  authoritative: [
    'maxAssignmentsPerRound',
    'maxPlannedWorkItemsPerRound',
    'maxConsecutiveAttemptsWithoutProgress',
    'maxFindingsPerSlot',
    'maxFindingsPerRelation',
    'maxFindingsPerRound',
    'maxEvidenceBytesPerItem',
    'maxEvidenceBytesTotal',
    'maxWriteSlotsPerRepairGrant',
    'maxScopeExpansionsPerRound',
  ],
};

/** Installed-handler identity fields (spec §6.5, design §9). */
export const PROFILE_VALIDATOR_IDENTITY_FIELDS = [
  'handlerKey',
  'implementationDigest',
  'moduleId',
  'exportName',
  'trigger',
  'executionPhase',
] as const;
export const PROFILE_ASSEMBLER_IDENTITY_FIELDS = ['handlerKey', 'implementationDigest', 'moduleId', 'exportName'] as const;

/** Validator budget-profile fields (design §9: bytes/targets/duration/output/issues/memory). */
export const PROFILE_BUDGET_PROFILE_FIELDS = [
  'maxInputBytes',
  'maxSelectedTargets',
  'maxDurationMs',
  'maxOutputBytes',
  'maxIssues',
  'maxMemoryMiB',
] as const;

/** Assembler budget ceiling fields (spec §13.5 frozen identity fields). */
export const PROFILE_ASSEMBLER_BUDGET_FIELDS = ['maxTimeoutMs', 'maxInputBytes', 'maxOutputBytes'] as const;