/**
 * Shared frontmatter-verdict validation for `annotate_artifact` content
 * (semantic audit P1, plan 2026-08-07). The review verdict lives in a YAML
 * frontmatter block at the very start of the annotation content:
 *
 *   ---
 *   verdict: pass|reject
 *   ---
 *
 * The model-facing tool layer uses it to reject malformed content with a
 * stable, correctable code in the same Turn; the ActionCommitter re-checks it
 * as the non-bypassable boundary (FakeRuntime / direct-commit paths never go
 * through the Pi tool layer). This is a FORMAT contract only — it never turns
 * the verdict into a delivery gate (platform code does not decide what
 * pass/reject means for routing).
 */
export const ANNOTATE_FRONTMATTER_INVALID = 'ANNOTATE_FRONTMATTER_INVALID';

/** A leading YAML frontmatter block: `---\n<lines>\n---`. */
const FRONTMATTER_BLOCK = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** A `verdict: pass|reject` line inside the block. */
const VERDICT_LINE = /^verdict:\s*(pass|reject)\s*$/m;

/**
 * Parses the frontmatter verdict of one annotation body. Returns the verdict
 * when the content carries a valid leading frontmatter block with a `verdict`
 * line; null for missing frontmatter, an unknown verdict value (e.g. `maybe`),
 * or any malformed shape.
 */
export function parseAnnotateVerdict(content: string): 'pass' | 'reject' | null {
  if (typeof content !== 'string' || content.length === 0) {
    return null;
  }
  const block = FRONTMATTER_BLOCK.exec(content);
  if (block === null) {
    return null;
  }
  const verdict = VERDICT_LINE.exec(block[1]);
  if (verdict === null) {
    return null;
  }
  return verdict[1] as 'pass' | 'reject';
}
