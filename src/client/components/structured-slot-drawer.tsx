import { useCallback, useEffect, useState } from 'react';
import type {
  SealRecord,
  StructuredIssuePageV1,
  StructuredSlotOutlinePageV1,
  StructuredSlotPublicContractV1,
  StructuredSlotReadV1,
  TaskWorkspace,
} from '../../shared/contracts';
import type { PublicCoreError } from '../../shared/errors';
import { useForgeCoreGateway } from '../gateway/gateway-context';
import { toPublicCoreError } from '../hooks/use-gateway-query';

export interface StructuredSlotDrawerProps {
  workspace: TaskWorkspace;
  /** Closes the overlay panel (mirrors the artifact drawer). */
  onClose: () => void;
}

interface DrawerData {
  contract: StructuredSlotPublicContractV1;
  outline: StructuredSlotOutlinePageV1;
  issues: StructuredIssuePageV1;
  seal: SealRecord | null;
}

/** Read-only page cap for the outline/issues walks (v1 UI). */
const MAX_PAGE_WALK_ENTRIES = 1000;

/** Pretty-prints a JSON value for the read-only spec/content panels. */
function jsonPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/**
 * Read-only "结构" drawer (spec §14 / design I04): a tree outline, one slot's
 * type/spec/content/status on selection, owner-visible issues and the sealed
 * artifact link. There is NO textbox, drag handle, save or merge control — the
 * human UI never writes slots in v1. The drawer reuses the existing task
 * watch (the workspace summary refreshes through the page's poll) and fetches
 * pages/details on demand.
 */
export function StructuredSlotDrawer({
  workspace,
  onClose,
}: StructuredSlotDrawerProps) {
  const gateway = useForgeCoreGateway();
  const taskId = workspace.task.id;
  const summary = workspace.structuredSlots;

  const [data, setData] = useState<DrawerData | null>(null);
  const [loadError, setLoadError] = useState<PublicCoreError | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [slot, setSlot] = useState<StructuredSlotReadV1 | null>(null);
  const [slotError, setSlotError] = useState<PublicCoreError | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setLoadError(null);
    setSelectedSlotId(null);
    setSlot(null);
    setSlotError(null);

    const collectOutline = async (): Promise<StructuredSlotOutlinePageV1> => {
      const entries: StructuredSlotOutlinePageV1['entries'] = [];
      let cursor: Parameters<typeof gateway.listStructuredSlots>[1] = null;
      for (;;) {
        const page = await gateway.listStructuredSlots(taskId, cursor, 200);
        entries.push(...page.entries);
        if (page.nextCursor === null || entries.length >= MAX_PAGE_WALK_ENTRIES) {
          return { entries, nextCursor: null };
        }
        cursor = page.nextCursor;
      }
    };

    Promise.all([
      gateway.getStructuredContract(taskId),
      collectOutline(),
      gateway.listStructuredIssues(taskId, null, 200),
      // An unsealed scaffold is a normal read-only state, not a drawer error.
      gateway.getStructuredSeal(taskId).catch(() => null),
    ])
      .then(([contract, outline, issues, seal]) => {
        if (!active) return;
        setData({ contract, outline, issues, seal });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(toPublicCoreError(error));
      });

    return () => {
      active = false;
    };
  }, [gateway, taskId]);

  /** Loads ONE slot detail on selection (never the whole tree). */
  const handleSelectSlot = useCallback(
    async (slotId: string) => {
      setSelectedSlotId(slotId);
      setSlot(null);
      setSlotError(null);
      try {
        const read = await gateway.getStructuredSlot(taskId, slotId);
        setSlot(read.slot);
      } catch (error) {
        setSlotError(toPublicCoreError(error));
      }
    },
    [gateway, taskId],
  );

  const selectedEntry =
    selectedSlotId !== null
      ? (data?.outline.entries.find((entry) => entry.slotId === selectedSlotId) ?? null)
      : null;

  return (
    <aside className="fc-drawer fc-drawer--structured" role="complementary" aria-label="结构">
      <div className="fc-drawer__header">
        <h2 className="fc-drawer__title">结构</h2>
        <button
          type="button"
          className="fc-drawer__close"
          aria-label="关闭结构抽屉"
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      {summary !== undefined ? (
        <section className="fc-struct-summary" aria-label="结构摘要">
          <span className="fc-struct-summary__status">
            结构：{summary.structureStatus === 'active' ? '已建立' : '未建立'}
          </span>
          <span className="fc-struct-summary__status">
            封存：{summary.sealStatus === 'sealed' ? '已封存' : '未封存'}
          </span>
          <span>
            可见槽 {summary.visibleSlotCount} / 已填 {summary.filledSlotCount}
          </span>
          <span>
            Issue {summary.issueSummary.errors} 错误 · {summary.issueSummary.warnings} 警告
          </span>
        </section>
      ) : null}

      {loadError !== null ? (
        <p className="fc-struct-error" role="alert">
          {loadError.message}
        </p>
      ) : null}

      {data !== null ? (
        <>
          <section className="fc-struct-outline" aria-label="槽位大纲">
            <h3 className="fc-struct-heading">槽位</h3>
            <ul className="fc-struct-tree">
              {data.outline.entries.map((entry) => (
                <li key={entry.slotId} className="fc-struct-tree__item">
                  <button
                    type="button"
                    className="fc-struct-tree__button"
                    aria-expanded={selectedSlotId === entry.slotId}
                    onClick={() => void handleSelectSlot(entry.slotId)}
                  >
                    <span className="fc-struct-tree__type">{entry.typeId}</span>
                    <span className="fc-struct-tree__presence">{entry.contentPresence}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {selectedEntry !== null ? (
            <section className="fc-struct-slot" aria-label={`槽位 ${selectedSlotId}`}>
              <h3 className="fc-struct-heading">槽位 {selectedSlotId}</h3>
              {slot !== null ? (
                <>
                  <p className="fc-struct-slot__status">
                    content: {slot.contentPresence} · level: {slot.level}
                  </p>
                  <h4 className="fc-struct-slot__label">Spec</h4>
                  <pre className="fc-struct-slot__json">{jsonPreview(slot.spec)}</pre>
                  {slot.contentPresence === 'set' && slot.content !== undefined ? (
                    <>
                      <h4 className="fc-struct-slot__label">Content</h4>
                      <pre className="fc-struct-slot__json">{jsonPreview(slot.content)}</pre>
                    </>
                  ) : null}
                </>
              ) : slotError !== null ? (
                <p className="fc-struct-error" role="alert">
                  {slotError.message}
                </p>
              ) : (
                <p className="fc-loading-note" role="status">
                  正在加载槽位…
                </p>
              )}
            </section>
          ) : null}

          <section className="fc-struct-issues" aria-label="问题列表">
            <h3 className="fc-struct-heading">问题</h3>
            {data.issues.issues.length === 0 ? (
              <p className="fc-struct-issues__empty">无公开问题。</p>
            ) : (
              <ul className="fc-struct-issues__list">
                {data.issues.issues.map((issue) => (
                  <li key={`${issue.code}-${issue.phase}`} className="fc-struct-issues__item">
                    <span className="fc-struct-issues__code">{issue.code}</span>
                    <span className="fc-struct-issues__severity">{issue.severity}</span>
                    <span className="fc-struct-issues__phase">{issue.phase}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.seal !== null ? (
            <section className="fc-struct-seal" aria-label="封存记录">
              <h3 className="fc-struct-heading">封存</h3>
              <p className="fc-struct-seal__line">
                交付版本：
                <a
                  className="fc-struct-seal__link"
                  href={`#artifact-${data.seal.artifactVersionRef.artifactId}`}
                >
                  V{data.seal.artifactVersionRef.version}
                </a>
              </p>
              <p className="fc-struct-seal__line">Assembler: {data.seal.assemblerId}</p>
            </section>
          ) : null}
        </>
      ) : loadError === null ? (
        <p className="fc-loading-note" role="status">
          正在加载结构…
        </p>
      ) : null}
    </aside>
  );
}
