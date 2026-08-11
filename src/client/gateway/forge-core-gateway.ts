import type {
  HumanDecision,
  SealRecord,
  SkillContent,
  StructuredIssuePageV1,
  StructuredSlotOutlinePageV1,
  StructuredSlotPublicContractV1,
  StructuredSlotReadResponseV1,
  TaskSummary,
  TaskWorkspace,
  TemplateDetail,
  TemplateSummary,
  TurnTrace,
} from '../../shared/contracts';
import type { StructuredSlotTreeCursorV1 } from '../../shared/structured-slots';

/**
 * 正式页面唯一的生产数据接口。页面不得直接访问 localStorage、
 * 拼接未来 API 地址或判断 mock/http；全部生产操作经由此接口。
 * 后续 HttpGateway 必须替换相同接口，不允许重写页面或保留模拟分支。
 *
 * Phase E display reads (plan Task E5): getTurnTrace/getSkillContent are
 * display-only windows into a Turn's observable process and the frozen Skill
 * snapshot — never part of the authoritative event union and never read by
 * gates; cloneTask reruns the same frozen input on the current template
 * version and returns the fresh task summary.
 *
 * Turn phase (plan 2026-08-04 Task 6): getTurnTrace returns the TurnTrace
 * with its optional display-only final `phase`; historical traces without
 * the field stay legal and every implementation passes it through untouched.
 */
export interface ForgeCoreGateway {
  listTemplates(): Promise<TemplateSummary[]>;
  getTemplate(templateId: string): Promise<TemplateDetail>;
  reloadTemplate(templateId: string): Promise<TemplateDetail>;
  createTask(request: {
    templateId: string;
    name: string;
    input: Record<string, string>;
  }): Promise<TaskSummary>;
  listTasks(): Promise<TaskSummary[]>;
  getWorkspace(taskId: string): Promise<TaskWorkspace>;
  startTask(taskId: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  resumeTask(taskId: string): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  answerHuman(taskId: string, answer: string): Promise<void>;
  /**
   * Submits a structured human decision (spec §11.1): `continue`/`accept`/`stop`
   * for a `progress_guard` question. The plain `answerHuman` text path remains
   * the channel for `agent_request` questions.
   */
  submitHumanDecision(taskId: string, decision: HumanDecision): Promise<void>;
  watchTask(taskId: string, listener: () => void): () => void;
  getTurnTrace(taskId: string, turnId: string): Promise<TurnTrace>;
  getSkillContent(taskId: string, skillId: string): Promise<SkillContent>;
  cloneTask(taskId: string): Promise<TaskSummary>;
  /**
   * Permanently deletes one task in ANY status, including corrupt ones: the
   * task's whole local record (frozen input, snapshot, history and outputs)
   * is removed and the deletion cannot be undone. A task that is still
   * running is stopped first, so no execution survives the deletion.
   * Unknown ids reject with TASK_NOT_FOUND.
   */
  deleteTask(taskId: string): Promise<void>;
  /**
   * Public contract projection of the structured-slot contract (spec §14).
   * The owner projection never includes implementation paths, validators,
   * accessProfiles or the resource manifest. Basic tasks reject with
   * STRUCTURED_NOT_ACTIVE.
   */
  getStructuredContract(taskId: string): Promise<StructuredSlotPublicContractV1>;
  /**
   * Paged owner slot outline (spec §14). The cursor is the signed, bound tree
   * cursor; a stale cursor rejects with CURSOR_INVALID. Basic tasks reject
   * with STRUCTURED_NOT_ACTIVE.
   */
  listStructuredSlots(
    taskId: string,
    cursor: StructuredSlotTreeCursorV1 | null,
    limit: number,
  ): Promise<StructuredSlotOutlinePageV1>;
  /**
   * The authorized owner projection of one slot (spec §14). Missing and hidden
   * slots return the IDENTICAL SLOT_NOT_VISIBLE envelope.
   */
  getStructuredSlot(taskId: string, slotId: string): Promise<StructuredSlotReadResponseV1>;
  /**
   * Paged owner-visible issues (spec §14). Basic tasks reject with
   * STRUCTURED_NOT_ACTIVE.
   */
  listStructuredIssues(
    taskId: string,
    cursor: StructuredSlotTreeCursorV1 | null,
    limit: number,
  ): Promise<StructuredIssuePageV1>;
  /** The immutable SealRecord of the sealed scaffold (design §17.2). */
  getStructuredSeal(taskId: string): Promise<SealRecord>;
}
