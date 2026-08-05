import type {
  NodeKind,
  RouteKind,
  TaskStatus,
  TemplateSummary,
  WorkspaceNode,
} from '../../shared/contracts';
import type { StatusChipTone } from '../components/status-chip';

/**
 * Pure presentation mappings shared by product pages. Platform-neutral: every
 * label comes from the public contract enum, never from business vocabulary,
 * and the functions are side-effect free so pages and tests can reuse them.
 */

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '待运行',
  ready: '待运行',
  running: '运行中',
  waiting_human: '等待用户回答',
  retryable_failure: '运行失败、可以重试',
  interrupted: '被中断、可以继续',
  completed: '已完成',
  stopped: '已停止',
  corrupt: '任务文件损坏、只能查看诊断',
  incompatible: '契约不兼容，需使用当前模板重建',
};

const TASK_STATUS_TONES: Record<TaskStatus, StatusChipTone> = {
  draft: 'neutral',
  ready: 'neutral',
  running: 'info',
  waiting_human: 'warning',
  retryable_failure: 'danger',
  interrupted: 'warning',
  completed: 'success',
  stopped: 'neutral',
  corrupt: 'danger',
  incompatible: 'warning',
};

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status];
}

export function taskStatusTone(status: TaskStatus): StatusChipTone {
  return TASK_STATUS_TONES[status];
}

export function templateStatusLabel(status: TemplateSummary['status']): string {
  return status === 'valid' ? '校验通过' : '校验失败、使用缓存版本';
}

export function templateStatusTone(status: TemplateSummary['status']): StatusChipTone {
  return status === 'valid' ? 'success' : 'warning';
}

export function routeKindLabel(kind: RouteKind): string {
  return kind === 'message' ? '消息' : '产物';
}

const NODE_STATUS_LABELS: Record<WorkspaceNode['status'], string> = {
  confirmed: '已确认',
  active: '进行中',
  failed: '失败',
};

const NODE_KIND_LABELS: Record<NodeKind, string> = {
  input: '输入',
  result: '结果',
  human_request: '人工询问',
  human_answer: '人工回答',
  skill: '技能',
};

/** Node status as text so state never relies on color alone. */
export function nodeStatusLabel(status: WorkspaceNode['status']): string {
  return NODE_STATUS_LABELS[status];
}

const NODE_STATUS_TONES: Record<WorkspaceNode['status'], StatusChipTone> = {
  confirmed: 'success',
  active: 'info',
  failed: 'danger',
};

/** Semantic chip tone for node/turn statuses. */
export function nodeStatusTone(status: WorkspaceNode['status']): StatusChipTone {
  return NODE_STATUS_TONES[status];
}

export function nodeKindLabel(kind: NodeKind): string {
  return NODE_KIND_LABELS[kind];
}

export function artifactFormatLabel(format: 'markdown' | 'text'): string {
  return format === 'markdown' ? 'Markdown' : '纯文本';
}

/** Deterministic UTC rendering so timestamps read identically in every zone. */
export function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
}
