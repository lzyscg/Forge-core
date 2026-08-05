import type { ArtifactVersion, TaskWorkspace } from '../../shared/contracts';

export interface ArtifactDrawerProps {
  workspace: TaskWorkspace;
  selectedVersion: number | null;
  /** Selects the version and locates/highlights its source node. */
  onLocateArtifact: (artifact: ArtifactVersion) => void;
  /** Closes the overlay panel (mirrors the config drawer). */
  onClose: () => void;
}

/**
 * Append-only artifact version chain (V1..Vn) above, full body preview below.
 * Temporary files and failed attempts never appear because the Gateway
 * workspace excludes them. Markdown renders as lightweight paragraphs — no
 * markdown library in phase A.
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
              <div className="fc-artifact-preview" data-testid="artifact-preview">
                {selected.content.split(/\n{2,}/).map((paragraph, index) => (
                  // Paragraph index keys are fine: the chain is append-only.
                  <p key={index}>{paragraph}</p>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
