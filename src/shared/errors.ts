/**
 * 面向页面的统一错误契约：只暴露可展示、可定位、可操作的字段。
 * 原始 cause / 堆栈 / 凭据相关信息不得经由此契约进入页面状态（铁律 6）。
 */
export interface PublicCoreError {
  code: string;
  message: string;
  location: string | null;
  action: string | null;
}

/**
 * Stable public error codes shared across lifecycle surfaces (plan
 * 2026-08-04). `TASK_CONTRACT_INCOMPATIBLE` rejects start/resume/retry of a
 * historical frozen task whose snapshot lacks a supported turn contract —
 * the task stays readable and cloneable only (spec §7.3).
 */
export const TASK_ERROR_CODES = {
  TASK_CONTRACT_INCOMPATIBLE: 'TASK_CONTRACT_INCOMPATIBLE',
} as const;

/** Presentable Chinese message for the incompatibility gate (iron rule 6). */
export const TASK_CONTRACT_INCOMPATIBLE_MESSAGE =
  '该任务冻结于旧版模板契约，无法继续运行，请使用当前模板克隆重建。';

/** Actionable hint paired with the incompatibility gate message. */
export const TASK_CONTRACT_INCOMPATIBLE_ACTION = '查看任务后使用“用当前模板重跑”重建任务。';
