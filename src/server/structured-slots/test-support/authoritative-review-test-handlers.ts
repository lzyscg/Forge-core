/**
 * Authoritative review TEST-ONLY installed handlers (Task 5).
 *
 * The first valid v2 fixture resolves ONLY these checked-in test-support
 * handler identities (spec §6.5/§13.5): production manifest loading rejects
 * them on every path (`qualificationState: test_only` and the test registry
 * identities can never satisfy production). The loader matches contract
 * implementation identities against the installed registry exactly; the
 * runtime execution of these handlers is Task 14's validator engine — this
 * module freezes the identities and provides deterministic identity stubs
 * only, never a validation bypass.
 */
import { createHash } from 'node:crypto';
import type { InstalledAssemblerHandlerIdentityV1, InstalledValidatorHandlerIdentityV1 } from '../authoritative-review-profile';

/** The platform-neutral module namespace of the installed test handlers. */
export const AUTHORITATIVE_REVIEW_TEST_HANDLER_MODULE = '@forge/authoritative-review';

/** Exact installed validator identities (trigger/phase frozen per spec §6.5). */
export const AUTHORITATIVE_REVIEW_TEST_VALIDATOR_IDENTITIES: readonly InstalledValidatorHandlerIdentityV1[] = [
  {
    handlerKey: 'authoritative.review.completeness',
    implementationDigest: 'a'.repeat(64),
    moduleId: AUTHORITATIVE_REVIEW_TEST_HANDLER_MODULE,
    exportName: 'completeness',
    trigger: 'map_candidate_commit',
    executionPhase: null,
  },
  {
    handlerKey: 'authoritative.review.slotSchema',
    implementationDigest: 'b'.repeat(64),
    moduleId: AUTHORITATIVE_REVIEW_TEST_HANDLER_MODULE,
    exportName: 'slotSchema',
    trigger: 'content_commit',
    executionPhase: 'batch_commit',
  },
  {
    handlerKey: 'authoritative.review.coverage',
    implementationDigest: 'c'.repeat(64),
    moduleId: AUTHORITATIVE_REVIEW_TEST_HANDLER_MODULE,
    exportName: 'coverage',
    trigger: 'content_commit',
    executionPhase: 'plan_finalize',
  },
];

/** The single installed assembler identity (spec §13.5: forge-assembler/v2). */
export const AUTHORITATIVE_REVIEW_TEST_ASSEMBLER_IDENTITY: InstalledAssemblerHandlerIdentityV1 = {
  handlerKey: 'authoritative.seal.render',
  implementationDigest: 'd'.repeat(64),
  moduleId: AUTHORITATIVE_REVIEW_TEST_HANDLER_MODULE,
  exportName: 'renderSeal',
};

/**
 * Test handlers are sorted by identity so the profile body and the registry
 * canonicalize identically (design §9 ordering).
 */
export const AUTHORITATIVE_REVIEW_TEST_HANDLER_IDENTITIES = {
  validators: [...AUTHORITATIVE_REVIEW_TEST_VALIDATOR_IDENTITIES].sort((a, b) => {
    const keyA = `${a.handlerKey}:${a.implementationDigest}:${a.trigger}:${String(a.executionPhase)}`;
    const keyB = `${b.handlerKey}:${b.implementationDigest}:${b.trigger}:${String(b.executionPhase)}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  }),
  assembler: AUTHORITATIVE_REVIEW_TEST_ASSEMBLER_IDENTITY,
} as const;

export type TestHandlerTrigger = 'map_candidate_commit' | 'content_commit';

/**
 * Deterministic handler stubs keyed by handlerKey. They compute a stable
 * execution digest over the canonical input envelope — the validator engine
 * (Task 14) replaces them with the allowlisted isolated implementations;
 * until then no loader or runtime path executes them.
 */
function stubHandler(input: Record<string, unknown>): { status: 'valid'; executionDigest: string } {
  return {
    status: 'valid',
    executionDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  };
}

export const AUTHORITATIVE_REVIEW_TEST_HANDLER_STUBS: Readonly<
  Record<string, (input: Record<string, unknown>) => { status: 'valid'; executionDigest: string }>
> = {
  'authoritative.review.completeness': stubHandler,
  'authoritative.review.slotSchema': stubHandler,
  'authoritative.review.coverage': stubHandler,
};