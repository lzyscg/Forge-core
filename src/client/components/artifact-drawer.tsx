import type { ArtifactFile, ArtifactVersion, TaskWorkspace } from '../../shared/contracts';

export interface ArtifactDrawerProps {
  workspace: TaskWorkspace;
  selectedVersion: number | null;
  /** Selects the version and locates/highlights its source node. */
  onLocateArtifact: (artifact: ArtifactVersion) => void;
  /** Closes the overlay panel (mirrors the config drawer). */
  onClose: () => void;
}

/**
 * Display label for a template-declared extract slot (spec §5.1, semantic
 * audit P1 plan 2026-08-07): known slots get their product label, and an
 * unknown template-declared extract renders its own name instead of being
 * mislabeled as 正文.
 */
function extractLabel(extract: string): string {
  if (extract === 'content') return '正文';
  if (extract === 'review') return '审核意见';
  if (extract === 'revision') return '修订说明';
  return extract;
}

/**
 * Display-layer verdict parse (spec §3.2/§10): review.md carries a YAML-ish
 * frontmatter `verdict: pass|reject`. The platform never gates on it — the
 * controller model consumes the semantics — the drawer only renders the badge.
 */
function parseReviewVerdict(content: string): 'pass' | 'reject' | null {
  const match = /^---\s*\r?\n\s*verdict\s*:\s*(pass|reject)\s*\r?\n---/i.exec(content.trim());
  return match !== null ? ((match[1]?.toLowerCase() as 'pass' | 'reject') ?? null) : null;
}

/** One extract slot of the selected version, rendered as labeled paragraphs. */
function FileSlot({ file }: { file: ArtifactFile }) {
  const verdict = file.extract === 'review' ? parseReviewVerdict(file.content) : null;
  return (
    <section className="fc-artifact-slot">
      <h4 className="fc-artifact-slot__title">
        <span>{extractLabel(file.extract)}</span>
        <span className="fc-artifact-slot__filename">{file.name}</span>
        {verdict !== null ? (
          <span
            className={
              verdict === 'pass'
                ? 'fc-verdict fc-verdict--pass'
                : 'fc-verdict fc-verdict--reject'
            }
          >
            审核结论：{verdict === 'pass' ? '通过' : '打回'}
          </span>
        ) : null}
      </h4>
      <div className="fc-artifact-preview" data-testid="artifact-preview">
        {file.content.split(/\n{2,}/).map((paragraph: string, index: number) => (
          // Paragraph index keys are fine: the chain is append-only.
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    </section>
  );
}

/**
 * Append-only artifact version chain (V1..Vn) above, extract-slot preview below
 * (spec §5.1/§10): each version's content/revision/review files render under
 * their declared extract labels, with the review verdict badge parsed from the
 * review.md frontmatter (display layer only — never a gate). Temporary files
 * and failed attempts never appear because the Gateway workspace excludes
 * them. Markdown renders as lightweight paragraphs — no markdown library in
 * phase A.
 */
export function ArtifactDrawer({
  workspace,
  selectedVersion,
  onLocateArtifact,
  onClose,
}: ArtifactDrawerProps) {
  const artifacts = workspace.artifacts;
  const selected =
    artifacts.find((artifact) => artifact.version === selectedVersion) ??
    (artifacts.length > 0 ? artifacts[artifacts.length - 1] : null);

  return (
    <aside className="fc-drawer fc-drawer--artifacts" role="complementary" aria-label="产物版本">
      <div className="fc-drawer__header">
        <h2 className="fc-drawer__title">产物版本</h2>
        <button
          type="button"
          className="fc-drawer__close"
          aria-label="关闭产物抽屉"
          onClick={onClose}
        >
          关闭
        </button>
      </div>
      {artifacts.length === 0 ? (
        <p className="fc-artifact-empty">尚无已发布的产物版本。</p>
      ) : (
        <>
          <ol className="fc-version-chain">
            {artifacts.map((artifact) => {
              const isCurrent = selected !== null && selected.id === artifact.id;
              return (
                <li
                  key={artifact.id}
                  id={`artifact-${artifact.id}`}
                  className={
                    isCurrent ? 'fc-version-item fc-version-item--current' : 'fc-version-item'
                  }
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className="fc-version-item__button"
                    onClick={() => onLocateArtifact(artifact)}
                  >
                    V{artifact.version}
                  </button>
                  {artifact.final ? <span className="fc-version-item__final">终稿</span> : null}
                </li>
              );
            })}
          </ol>
          {selected !== null ? (
            <div className="fc-artifact-preview-wrap">
              <h3 className="fc-artifact-title">{selected.title}</h3>
              {selected.files.map((file) => (
                <FileSlot key={file.name} file={file} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
