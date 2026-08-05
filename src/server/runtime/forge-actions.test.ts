// @vitest-environment node
/**
 * Forge action contract tests for the production/dispatch turn contract
 * (plan 2026-08-04 Task 1 Step 1, spec §4.3/§5.1/§5.2).
 *
 * The closed registry gains `finish_production`: the one action that seals
 * the turn's production package. Dispatch actions (`send_message`,
 * `publish_artifact`, `submit_final_artifact`) carry no content or metadata
 * anymore — only `productionPackageRef: 'current'` plus their target/intent
 * fields; everything delivered comes from the sealed package. Validation
 * stays shape-only: phase order, route and contract checks belong to the
 * ActionBuffer and the ActionCommitter. Platform module, zero business
 * vocabulary (iron rule 1).
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_VALIDATION_CODES,
  FORGE_ACTION_LIMITS,
  FORGE_ACTION_NAME_SET,
  FORGE_ACTION_NAMES,
  ForgeActionValidationError,
  PUBLISH_WORKSPACE_FILE_MAX_LENGTH,
  validateForgeAction,
  type ForgeAction,
} from './forge-actions';

/** The exact action shapes the plan Task 1 Step 1 pins (verbatim). */
const planShapes: ForgeAction[] = [
  { type: 'finish_production', source: 'inline', content: 'review', format: 'text', artifactType: null, title: null },
  { type: 'finish_production', source: 'workspace_file', workspaceFile: 'draft/chapter.md', format: 'markdown', artifactType: 'chapter_markdown', title: '第一章' },
  { type: 'finish_production', source: 'current_input_artifact' },
  { type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current' },
  { type: 'publish_artifact', productionPackageRef: 'current' },
  { type: 'submit_final_artifact', productionPackageRef: 'current' },
];

const validSamples: Record<string, ForgeAction> = {
  load_skill: { type: 'load_skill', skillId: 'skill-alpha' },
  finish_inline: planShapes[0],
  finish_workspace: planShapes[1],
  finish_input_artifact: planShapes[2],
  send_message: planShapes[3],
  publish_artifact: planShapes[4],
  submit_final_artifact: planShapes[5],
  request_human_input: { type: 'request_human_input', question: 'Which variant should continue?' },
};

describe('closed action registry (spec §5, plan Task 1)', () => {
  it('exposes exactly six Forge action names including finish_production', () => {
    expect([...FORGE_ACTION_NAMES].sort()).toEqual([
      'finish_production', 'load_skill', 'publish_artifact', 'request_human_input',
      'send_message', 'submit_final_artifact',
    ]);
  });

  it('locks membership in a read-only six-name set', () => {
    expect(FORGE_ACTION_NAME_SET.size).toBe(6);
    for (const name of FORGE_ACTION_NAMES) {
      expect(FORGE_ACTION_NAME_SET.has(name)).toBe(true);
    }
    expect(FORGE_ACTION_NAME_SET.has('execute_command' as never)).toBe(false);
    // Workspace tools stay separate platform tools, never Forge actions.
    expect(FORGE_ACTION_NAMES).not.toContain('write_workspace');
    expect(FORGE_ACTION_NAMES).not.toContain('read_workspace');
    expect(FORGE_ACTION_NAMES).not.toContain('list_workspace');
  });
});

describe('plan Task 1 Step 1 verbatim shapes', () => {
  it('accepts every pinned shape unchanged', () => {
    for (const shape of planShapes) {
      expect(validateForgeAction(shape)).toEqual(shape);
    }
  });

  it('accepts load_skill and request_human_input unchanged', () => {
    expect(validateForgeAction(validSamples.load_skill)).toEqual(validSamples.load_skill);
    expect(validateForgeAction(validSamples.request_human_input))
      .toEqual(validSamples.request_human_input);
  });
});

describe('finish_production validation (spec §4.3/§5.1)', () => {
  it('accepts inline, workspace_file and current_input_artifact sources', () => {
    expect(validateForgeAction({ type: 'finish_production', source: 'inline', content: 'body' }))
      .toMatchObject({ source: 'inline', content: 'body', artifactType: null, title: null });
    expect(validateForgeAction({
      type: 'finish_production', source: 'workspace_file', workspaceFile: 'draft/v1.md',
    })).toMatchObject({ source: 'workspace_file', workspaceFile: 'draft/v1.md' });
    expect(validateForgeAction({ type: 'finish_production', source: 'current_input_artifact' }))
      .toEqual({ type: 'finish_production', source: 'current_input_artifact' });
  });

  it('rejects unknown sources', () => {
    expect(() => validateForgeAction({ type: 'finish_production', source: 'latest' }))
      .toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({ type: 'finish_production' }))
      .toThrowError('ACTION_FIELD_INVALID');
  });

  it('rejects unknown formats for inline and workspace_file packages', () => {
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', content: 'body', format: 'html',
    })).toThrowError('ACTION_FIELD_INVALID');
  });

  it('accepts inline content up to exactly 2 MiB and rejects beyond', () => {
    const exact = 'x'.repeat(FORGE_ACTION_LIMITS.content);
    expect(validateForgeAction({ type: 'finish_production', source: 'inline', content: exact }).type)
      .toBe('finish_production');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', content: `${exact}x`,
    })).toThrowError('ACTION_FIELD_INVALID');
  });

  it('rejects empty or non-string inline content', () => {
    expect(() => validateForgeAction({ type: 'finish_production', source: 'inline', content: '' }))
      .toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({ type: 'finish_production', source: 'inline', content: 7 }))
      .toThrowError('ACTION_FIELD_INVALID');
  });

  it('keeps artifactType/title nullable and bounded when present', () => {
    const exactId = 'a'.repeat(FORGE_ACTION_LIMITS.id);
    const exactTitle = 't'.repeat(FORGE_ACTION_LIMITS.shortText);
    expect(validateForgeAction({
      type: 'finish_production', source: 'inline', content: 'body',
      artifactType: exactId, title: exactTitle,
    })).toMatchObject({ artifactType: exactId, title: exactTitle });
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', content: 'body', artifactType: `${exactId}a`,
    })).toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', content: 'body', title: `${exactTitle}t`,
    })).toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', content: 'body', artifactType: '',
    })).toThrowError('ACTION_FIELD_INVALID');
  });

  it('rejects content or format keys on a current_input_artifact package', () => {
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'current_input_artifact', content: 'body',
    })).toThrowError('ACTION_UNKNOWN_KEY');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'current_input_artifact', format: 'markdown',
    })).toThrowError('ACTION_UNKNOWN_KEY');
  });

  it('rejects workspaceFile refs that are absolute, escaping or oversized', () => {
    const base = { type: 'finish_production', source: 'workspace_file' } as const;
    expect(() => validateForgeAction({ ...base, workspaceFile: '/abs/draft.md' }))
      .toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({ ...base, workspaceFile: 'a/../b.md' }))
      .toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({ ...base, workspaceFile: '' }))
      .toThrowError('ACTION_FIELD_INVALID');
    const exact = `draft/${'x'.repeat(PUBLISH_WORKSPACE_FILE_MAX_LENGTH - 'draft/'.length)}`;
    expect(exact.length).toBe(PUBLISH_WORKSPACE_FILE_MAX_LENGTH);
    expect(validateForgeAction({ ...base, workspaceFile: exact }))
      .toMatchObject({ workspaceFile: exact });
    expect(() => validateForgeAction({ ...base, workspaceFile: `${exact}x` }))
      .toThrowError('ACTION_FIELD_INVALID');
  });

  it('rejects a workspace_file package without a workspaceFile ref', () => {
    expect(() => validateForgeAction({ type: 'finish_production', source: 'workspace_file' }))
      .toThrowError('ACTION_FIELD_INVALID');
  });
});

describe('dispatch actions reference the sealed package (spec §5.2)', () => {
  it.each([
    ['send_message', { type: 'send_message', targetAgentId: 'writer' }],
    ['publish_artifact', { type: 'publish_artifact' }],
    ['submit_final_artifact', { type: 'submit_final_artifact' }],
  ] as Array<[string, Record<string, unknown>]>)(
    '%s requires productionPackageRef to be exactly current',
    (_name, action) => {
      expect(() => validateForgeAction(action)).toThrowError('ACTION_FIELD_INVALID');
      expect(() => validateForgeAction({ ...action, productionPackageRef: 'latest' }))
        .toThrowError('ACTION_FIELD_INVALID');
      expect(validateForgeAction({ ...action, productionPackageRef: 'current' }))
        .toMatchObject({ productionPackageRef: 'current' });
    },
  );

  it('rejects legacy content/metadata fields on dispatch actions', () => {
    expect(() => validateForgeAction({
      type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current', message: 'x',
    })).toThrowError('ACTION_UNKNOWN_KEY');
    expect(() => validateForgeAction({
      type: 'publish_artifact', productionPackageRef: 'current', content: 'body',
    })).toThrowError('ACTION_UNKNOWN_KEY');
    expect(() => validateForgeAction({
      type: 'submit_final_artifact', productionPackageRef: 'current', artifactRef: 'latest',
    })).toThrowError('ACTION_UNKNOWN_KEY');
  });

  it('keeps send_message targetAgentId bounded', () => {
    const exact = 'a'.repeat(FORGE_ACTION_LIMITS.id);
    expect(validateForgeAction({
      type: 'send_message', targetAgentId: exact, productionPackageRef: 'current',
    })).toMatchObject({ targetAgentId: exact });
    expect(() => validateForgeAction({
      type: 'send_message', targetAgentId: `${exact}a`, productionPackageRef: 'current',
    })).toThrowError('ACTION_FIELD_INVALID');
  });

  it('keeps request_human_input question bounded at 16 KiB', () => {
    const exact = 'x'.repeat(FORGE_ACTION_LIMITS.shortText);
    expect(validateForgeAction({ type: 'request_human_input', question: exact }).type)
      .toBe('request_human_input');
    expect(() => validateForgeAction({ type: 'request_human_input', question: `${exact}x` }))
      .toThrowError('ACTION_FIELD_INVALID');
  });
});

describe('action boundary invariants (spec §6.2, unchanged)', () => {
  it.each(['taskId', 'eventId', 'version', 'timestamp', 'path', 'filePath', 'contentPath'])(
    'rejects runtime actions carrying the engineering key %s',
    (key) => {
      expect(() => validateForgeAction({ ...validSamples.send_message, [key]: 'x' }))
        .toThrowError('ACTION_FORBIDDEN_KEY');
      expect(() => validateForgeAction({ ...validSamples.finish_inline, [key]: undefined }))
        .toThrowError('ACTION_FORBIDDEN_KEY');
      // Presence counts, even with an undefined value.
      expect(() => validateForgeAction({ ...validSamples.publish_artifact, [key]: undefined }))
        .toThrowError('ACTION_FORBIDDEN_KEY');
    },
  );

  it('rejects unknown actions, unknown keys and non-objects with typed codes', () => {
    const caught: ForgeActionValidationError[] = [];
    const attempt = (value: unknown) => {
      try {
        validateForgeAction(value);
      } catch (error) {
        expect(error).toBeInstanceOf(ForgeActionValidationError);
        caught.push(error as ForgeActionValidationError);
      }
    };
    attempt({ type: 'delete_history' });
    attempt({ type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current', trace: 'y' });
    attempt(null);
    attempt('send_message');
    attempt([]);
    expect(caught.map((error) => error.code)).toEqual([
      ACTION_VALIDATION_CODES.ACTION_TYPE_UNKNOWN,
      ACTION_VALIDATION_CODES.ACTION_UNKNOWN_KEY,
      ACTION_VALIDATION_CODES.ACTION_NOT_OBJECT,
      ACTION_VALIDATION_CODES.ACTION_NOT_OBJECT,
      ACTION_VALIDATION_CODES.ACTION_NOT_OBJECT,
    ]);
  });
});
