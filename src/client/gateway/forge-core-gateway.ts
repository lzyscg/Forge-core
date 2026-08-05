import type {
  SkillContent,
  TaskSummary,
  TaskWorkspace,
  TemplateDetail,
  TemplateSummary,
  TurnTrace,
} from '../../shared/contracts';

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
}
