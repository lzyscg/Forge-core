/**
 * Phase A capability registry (plan Task 7 Step 3, verbatim). The development
 * progress page, the evidence mapping and the verify-ui gate all derive their
 * capability ids from this single list; order is the matrix display order.
 */
export const CAPABILITIES = [
  ['templates', '模板列表与详情'],
  ['template_reload', '显式重新加载模板'],
  ['task_creation', '新建任务与冻结配置'],
  ['task_recovery', '任务列表与状态恢复'],
  ['workspace', '动态 Agent 画布'],
  ['lifecycle', '停止、继续与人工输入'],
  ['retry', '自动与手动重试'],
  ['skills', 'Skill 按需加载展示'],
  ['artifacts', '产物版本链与正文预览'],
  ['final_output', '最终产物系统校验演示'],
  ['process_trace', '执行过程浮窗（思维/工具/正文）'],
  ['agent_workspace', 'Agent 临时工作区'],
  ['task_clone', '同输入克隆重跑'],
] as const;

export type CapabilityId = (typeof CAPABILITIES)[number][0];

/**
 * Phase B backend gate subset (plan Task 6): the capabilities the persistent
 * HTTP browser gate proves `backend_connected`. lifecycle/retry/skills/
 * final_output stay `not_started` until the Phase C runtime and Phase D real
 * acceptance own them. The Gate B ceiling is backend_connected — no id in
 * this list (or anywhere) may ever be mapped to `verified` by Phase B.
 */
export const BACKEND_CONNECTED_PHASE_B: readonly CapabilityId[] = [
  'templates',
  'template_reload',
  'task_creation',
  'task_recovery',
  'workspace',
  'artifacts',
];

/**
 * Phase E backend subset (plan Task E4): the three capabilities the Phase E
 * backend proof slice adds on top of Phase B — exactly three ids, awarded by
 * the process-trace e2e gate once its spec exists (plan Task E6) and carried
 * by verify-backend/verify-runtime alongside the Phase B six.
 */
export const BACKEND_CONNECTED_PHASE_E: readonly CapabilityId[] = [
  'process_trace',
  'agent_workspace',
  'task_clone',
];
