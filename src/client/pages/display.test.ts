import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '../../shared/contracts';
import {
  artifactFormatLabel,
  formatDateTime,
  nodeKindLabel,
  nodeStatusLabel,
  nodeStatusTone,
  routeKindLabel,
  taskStatusLabel,
  taskStatusTone,
  templateStatusLabel,
  templateStatusTone,
} from './display';

describe('taskStatusLabel', () => {
  const cases: Array<[TaskStatus, string]> = [
    ['draft', '待运行'],
    ['ready', '待运行'],
    ['running', '运行中'],
    ['waiting_human', '等待用户回答'],
    ['retryable_failure', '运行失败、可以重试'],
    ['interrupted', '被中断、可以继续'],
    ['completed', '已完成'],
    ['stopped', '已停止'],
    ['corrupt', '任务文件损坏、只能查看诊断'],
    ['incompatible', '契约不兼容，需使用当前模板重建'],
  ];

  it.each(cases)('maps %s to the public label', (status, label) => {
    expect(taskStatusLabel(status)).toBe(label);
  });

  it('covers every declared task status', () => {
    expect(cases.map(([status]) => status).sort()).toEqual(
      [
        'draft',
        'ready',
        'running',
        'waiting_human',
        'retryable_failure',
        'interrupted',
        'completed',
        'stopped',
        'corrupt',
        'incompatible',
      ].sort(),
    );
  });

  it('assigns a semantic tone to every status', () => {
    expect(taskStatusTone('running')).toBe('info');
    expect(taskStatusTone('completed')).toBe('success');
    expect(taskStatusTone('waiting_human')).toBe('warning');
    expect(taskStatusTone('interrupted')).toBe('warning');
    expect(taskStatusTone('retryable_failure')).toBe('danger');
    expect(taskStatusTone('corrupt')).toBe('danger');
    expect(taskStatusTone('ready')).toBe('neutral');
    expect(taskStatusTone('stopped')).toBe('neutral');
    expect(taskStatusTone('incompatible')).toBe('warning');
  });
});

describe('templateStatusLabel', () => {
  it('distinguishes valid templates from cached invalid ones', () => {
    expect(templateStatusLabel('valid')).toBe('校验通过');
    expect(templateStatusLabel('invalid_using_cache')).toBe('校验失败、使用缓存版本');
    expect(templateStatusTone('valid')).toBe('success');
    expect(templateStatusTone('invalid_using_cache')).toBe('warning');
  });
});

describe('routeKindLabel / artifactFormatLabel', () => {
  it('labels route kinds and artifact formats in product language', () => {
    expect(routeKindLabel('message')).toBe('消息');
    expect(routeKindLabel('artifact')).toBe('产物');
    expect(artifactFormatLabel('markdown')).toBe('Markdown');
    expect(artifactFormatLabel('text')).toBe('纯文本');
  });
});

describe('formatDateTime', () => {
  it('formats ISO timestamps deterministically in zh-CN', () => {
    const expected = new Date('2026-01-02T03:04:05.000Z').toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    });
    expect(formatDateTime('2026-01-02T03:04:05.000Z')).toBe(expected);
  });

  it('returns the raw value when it cannot be parsed', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});

describe('nodeStatusLabel / nodeKindLabel', () => {
  it('labels node status with text, never color alone', () => {
    expect(nodeStatusLabel('confirmed')).toBe('已确认');
    expect(nodeStatusLabel('active')).toBe('进行中');
    expect(nodeStatusLabel('failed')).toBe('失败');
  });

  it('labels node kinds in platform language', () => {
    expect(nodeKindLabel('input')).toBe('输入');
    expect(nodeKindLabel('result')).toBe('结果');
    expect(nodeKindLabel('human_request')).toBe('人工询问');
    expect(nodeKindLabel('human_answer')).toBe('人工回答');
  });

  it('assigns a semantic tone to every node status', () => {
    expect(nodeStatusTone('confirmed')).toBe('success');
    expect(nodeStatusTone('active')).toBe('info');
    expect(nodeStatusTone('failed')).toBe('danger');
  });
});
