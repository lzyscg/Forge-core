/**
 * The generated qualification outputs of the structured-slot runtime
 * (Task 19 two-phase qualification). These four files are DERIVED products of
 * the qualification chain (integrated benchmark → final profile → profile
 * evidence → release evidence → enabled capability manifest), NOT product
 * source. Each is certified by its own digest in the one-way chain
 * (source/runner -> profile evidence -> final profile -> release evidence ->
 * capability manifest), so they must be EXCLUDED from the "clean source
 * digest" — the source digest certifies the SOURCE CODE, which does not
 * change across integrated-qualify → qualify → promote. Excluding them keeps
 * `cleanSourceDigest()` stable before and after promotion.
 *
 * Both `scripts/verify-structured-slots.ts` and
 * `scripts/benchmark-structured-slots.ts` use this shared definition so the
 * source digest and the dirty-tree allowlist stay consistent.
 */

/** The four repo-relative generated qualification output paths. */
export const QUALIFICATION_GENERATED_OUTPUTS: readonly string[] = [
  'src/server/structured-slots/platform-profile-v1.json',
  'src/server/structured-slots/runtime-capability-v1.json',
  'docs/evidence/structured-slot-platform-profile-v1.json',
  'docs/evidence/structured-slot-release-v1.json',
];

const GENERATED_SET: ReadonlySet<string> = new Set(QUALIFICATION_GENERATED_OUTPUTS);

/** True when a repo-relative path is one of the generated qualification outputs. */
export function isQualificationGeneratedOutput(relativePath: string): boolean {
  return GENERATED_SET.has(relativePath);
}
