/**
 * The generated qualification outputs of the authoritative review v2 runtime
 * (Task 27). These four files are DERIVED products of the qualification chain
 * (integrated benchmark -> final profile -> profile evidence -> release
 * evidence -> enabled capability manifest), NOT product source. Each is
 * certified by its own digest in the one-way chain so they must be EXCLUDED
 * from the "clean source digest" — the source digest certifies the SOURCE
 * CODE, which does not change across integrated-qualify -> qualify -> promote.
 *
 * Both `scripts/verify-authoritative-review.ts` and
 * `scripts/benchmark-authoritative-review.ts` use this shared definition so the
 * source digest and the dirty-tree allowlist stay consistent.
 */

export {
  AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS,
  isAuthoritativeReviewGeneratedOutput,
} from './authoritative-review-evidence-schema';
