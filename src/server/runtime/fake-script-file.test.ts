// @vitest-environment node
/**
 * Fake script file parsing tests for the Phase E thinking/workspace fields
 * (plan Phase E Task 2 Step 1).
 *
 * `parseFakeScripts` stays fail-loud: a `result` step may carry optional
 * `thinking` (string) and `workspaceWrites` (list of `{path, content}`) and
 * any other shape is rejected before the step is accepted.
 */
import { describe, expect, it } from 'vitest';
import { parseFakeScripts } from './fake-script-file';

function json(agent: string, step: Record<string, unknown>): string {
  return JSON.stringify({ [agent]: [step] });
}

describe('parseFakeScripts Phase E fields (fail loud)', () => {
  it('accepts a result step carrying thinking and workspaceWrites', () => {
    const scripts = parseFakeScripts(json('agent-alpha', {
      kind: 'result',
      publicText: 'done',
      thinking: 'plan first',
      workspaceWrites: [{ path: 'draft/v1.md', content: '初稿' }],
    }));
    const step = scripts['agent-alpha'][0];
    expect(step.kind).toBe('result');
    if (step.kind === 'result') {
      expect(step.thinking).toBe('plan first');
      expect(step.workspaceWrites).toEqual([{ path: 'draft/v1.md', content: '初稿' }]);
    }
  });

  it('treats thinking and workspaceWrites as optional', () => {
    const scripts = parseFakeScripts(json('agent-alpha', { kind: 'result', publicText: 'done' }));
    const step = scripts['agent-alpha'][0];
    if (step.kind === 'result') {
      expect(step.thinking).toBeUndefined();
      expect(step.workspaceWrites).toBeUndefined();
    }
  });

  it('rejects a non-string thinking', () => {
    expect(() => parseFakeScripts(json('agent-alpha', { kind: 'result', thinking: 42 })))
      .toThrowError(/thinking must be a string/);
  });

  it('rejects a non-array workspaceWrites', () => {
    expect(() => parseFakeScripts(json('agent-alpha', { kind: 'result', workspaceWrites: 'x' })))
      .toThrowError(/workspaceWrites must be an array/);
  });

  it('rejects workspaceWrites entries that are not {path, content} objects', () => {
    expect(() => parseFakeScripts(json('agent-alpha', { kind: 'result', workspaceWrites: [{ path: 'a' }] })))
      .toThrowError(/workspaceWrites/);
    expect(() => parseFakeScripts(json('agent-alpha', {
      kind: 'result', workspaceWrites: [{ path: 1, content: 'x' }],
    }))).toThrowError(/workspaceWrites/);
    expect(() => parseFakeScripts(json('agent-alpha', { kind: 'result', workspaceWrites: ['a.md'] })))
      .toThrowError(/workspaceWrites/);
  });
});
