// @vitest-environment node
/**
 * Forge action contract tests for the v7 production/operate turn contract
 * (spec §4.3/§5.1/§5.2, plan 2026-08-07 Phase 2).
 *
 * v7 reshapes the v1 sealed-package model into the production/operate split:
 * `finish_production(files)` is the only seal action (production turns only)
 * and seals a multi-file package; dispatch actions carry no
 * `productionPackageRef` and no content of their own. `submit_final_artifact`
 * resolves the submitted version from the input node's `inputVersion`.
 * Validation stays shape-only: phase order, route and contract checks belong
 * to the ActionBuffer and the ActionCommitter. Platform module, zero business
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

/** The exact v7 action shapes the contract pins (verbatim). */
const planShapes: ForgeAction[] = [
  {
    type: 'finish_production',
    source: 'inline',
    files: [{ name: 'content.md', content: 'review' }],
    format: 'text',
    artifactType: null,
    title: null,
  },
  {
    type: 'finish_production',
    source: 'workspace_file',
    files: [{ name: 'chapter.md', workspaceFile: 'draft/chapter.md' }],
    format: 'markdown',
    artifactType: 'chapter_markdown',
    title: '第一章',
  },
  { type: 'annotate_artifact', file: 'review.md', content: '---\nverdict: pass\n---\n意见' },
  { type: 'read_artifact_version', file: 'chapter.md' },
  { type: 'send_message', targetAgentId: 'writer', summary: '返修意见' },
  { type: 'publish_artifact' },
  { type: 'forward_input_version', targetAgentId: 'controller' },
  { type: 'submit_final_artifact' },
];

const validSamples: Record<string, ForgeAction> = {
  load_skill: { type: 'load_skill', skillId: 'skill-alpha' },
  finish_inline: planShapes[0],
  finish_workspace: planShapes[1],
  annotate_artifact: planShapes[2],
  read_artifact_version: planShapes[3],
  send_message: planShapes[4],
  publish_artifact: planShapes[5],
  forward_input_version: planShapes[6],
  submit_final_artifact: planShapes[7],
  request_human_input: { type: 'request_human_input', question: 'Which variant should continue?' },
};

describe('closed action registry (spec §5, plan Task 1)', () => {
  it('exposes exactly nine Forge action names', () => {
    expect([...FORGE_ACTION_NAMES].sort()).toEqual([
      'annotate_artifact', 'finish_production', 'forward_input_version', 'load_skill',
      'publish_artifact', 'read_artifact_version', 'request_human_input',
      'send_message', 'submit_final_artifact',
    ]);
  });

  it('locks membership in a read-only nine-name set', () => {
    expect(FORGE_ACTION_NAME_SET.size).toBe(9);
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
  it('accepts inline and workspace_file sources', () => {
    expect(validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'content.md', content: 'body' }],
    })).toMatchObject({ source: 'inline', artifactType: null, title: null });
    expect(validateForgeAction({
      type: 'finish_production', source: 'workspace_file', files: [{ name: 'v1.md', workspaceFile: 'draft/v1.md' }],
    })).toMatchObject({ source: 'workspace_file' });
  });

  it('rejects unknown sources', () => {
    expect(() => validateForgeAction({ type: 'finish_production', source: 'latest' }))
      .toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({ type: 'finish_production' }))
      .toThrowError('ACTION_FIELD_INVALID');
  });

  it('rejects the removed current_input_artifact source', () => {
    expect(() => validateForgeAction({ type: 'finish_production', source: 'current_input_artifact' }))
      .toThrowError('ACTION_FIELD_INVALID');
  });

  it('rejects unknown formats for inline and workspace_file packages', () => {
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: 'body' }], format: 'html',
    })).toThrowError('ACTION_FIELD_INVALID');
  });

  it('accepts inline content up to exactly 2 MiB and rejects beyond', () => {
    const exact = 'x'.repeat(FORGE_ACTION_LIMITS.content);
    expect(validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: exact }],
    }).type).toBe('finish_production');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: `${exact}x` }],
    })).toThrowError('ACTION_FIELD_INVALID');
  });

  it('rejects empty, non-string or missing inline content', () => {
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: '' }],
    })).toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: 7 }],
    })).toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md' }],
    })).toThrowError('ACTION_FIELD_INVALID');
  });

  it('keeps artifactType/title nullable and bounded when present', () => {
    const exactId = 'a'.repeat(FORGE_ACTION_LIMITS.id);
    const exactTitle = 't'.repeat(FORGE_ACTION_LIMITS.shortText);
    expect(validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: 'body' }],
      artifactType: exactId, title: exactTitle,
    })).toMatchObject({ artifactType: exactId, title: exactTitle });
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: 'body' }], artifactType: `${exactId}a`,
    })).toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: 'body' }], title: `${exactTitle}t`,
    })).toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: 'body' }], artifactType: '',
    })).toThrowError('ACTION_FIELD_INVALID');
  });

  it('requires a non-empty, unique files array', () => {
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [],
    })).toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'inline', files: [{ name: 'a.md', content: 'x' }, { name: 'a.md', content: 'y' }],
    })).toThrowError('ACTION_FIELD_INVALID');
  });

  it('rejects workspaceFile refs that are absolute, escaping or oversized', () => {
    const base = { type: 'finish_production', source: 'workspace_file' } as const;
    expect(() => validateForgeAction({ ...base, files: [{ name: 'a.md', workspaceFile: '/abs/draft.md' }] }))
      .toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({ ...base, files: [{ name: 'a.md', workspaceFile: 'a/../b.md' }] }))
      .toThrowError('ACTION_FIELD_INVALID');
    expect(() => validateForgeAction({ ...base, files: [{ name: 'a.md', workspaceFile: '' }] }))
      .toThrowError('ACTION_FIELD_INVALID');
    const exact = `draft/${'x'.repeat(PUBLISH_WORKSPACE_FILE_MAX_LENGTH - 'draft/'.length)}`;
    expect(exact.length).toBe(PUBLISH_WORKSPACE_FILE_MAX_LENGTH);
    expect(validateForgeAction({ ...base, files: [{ name: 'a.md', workspaceFile: exact }] }))
      .toMatchObject({ source: 'workspace_file' });
    expect(() => validateForgeAction({ ...base, files: [{ name: 'a.md', workspaceFile: `${exact}x` }] }))
      .toThrowError('ACTION_FIELD_INVALID');
  });

  it('rejects a workspace_file package without a workspaceFile ref', () => {
    expect(() => validateForgeAction({
      type: 'finish_production', source: 'workspace_file', files: [{ name: 'a.md' }],
    })).toThrowError('ACTION_FIELD_INVALID');
  });
});

describe('dispatch actions carry no productionPackageRef (spec §5.2)', () => {
  it.each([
    ['send_message', { type: 'send_message', targetAgentId: 'writer', summary: '返修意见' }],
    ['publish_artifact', { type: 'publish_artifact' }],
    ['forward_input_version', { type: 'forward_input_version', targetAgentId: 'controller' }],
    ['submit_final_artifact', { type: 'submit_final_artifact' }],
  ] as Array<[string, Record<string, unknown>]>)(
    '%s accepts the v7 shape and rejects the removed productionPackageRef',
    (_name, action) => {
      expect(validateForgeAction(action)).toEqual(action);
      expect(() => validateForgeAction({ ...action, productionPackageRef: 'current' }))
        .toThrowError('ACTION_UNKNOWN_KEY');
    },
  );

  it('rejects legacy content/metadata fields on dispatch actions', () => {
    expect(() => validateForgeAction({
      type: 'send_message', targetAgentId: 'writer', summary: 'x', message: 'y',
    })).toThrowError('ACTION_UNKNOWN_KEY');
    expect(() => validateForgeAction({ type: 'publish_artifact', content: 'body' }))
      .toThrowError('ACTION_UNKNOWN_KEY');
    expect(() => validateForgeAction({ type: 'submit_final_artifact', artifactRef: 'latest' }))
      .toThrowError('ACTION_UNKNOWN_KEY');
  });

  it('keeps send_message targetAgentId and summary bounded', () => {
    const exact = 'a'.repeat(FORGE_ACTION_LIMITS.id);
    expect(validateForgeAction({ type: 'send_message', targetAgentId: exact, summary: 's' }))
      .toMatchObject({ targetAgentId: exact });
    expect(() => validateForgeAction({ type: 'send_message', targetAgentId: `${exact}a`, summary: 's' }))
      .toThrowError('ACTION_FIELD_INVALID');
    const exactSummary = 'x'.repeat(FORGE_ACTION_LIMITS.shortText);
    expect(validateForgeAction({ type: 'send_message', targetAgentId: 'writer', summary: exactSummary }).type)
      .toBe('send_message');
    expect(() => validateForgeAction({ type: 'send_message', targetAgentId: 'writer', summary: `${exactSummary}x` }))
      .toThrowError('ACTION_FIELD_INVALID');
  });

  it('keeps annotate_artifact content bounded and forward_input_version target bounded', () => {
    const exact = 'x'.repeat(FORGE_ACTION_LIMITS.content);
    expect(validateForgeAction({ type: 'annotate_artifact', file: 'review.md', content: exact }).type)
      .toBe('annotate_artifact');
    expect(() => validateForgeAction({ type: 'annotate_artifact', file: 'review.md', content: `${exact}x` }))
      .toThrowError('ACTION_FIELD_INVALID');
    const exactId = 'a'.repeat(FORGE_ACTION_LIMITS.id);
    expect(validateForgeAction({ type: 'forward_input_version', targetAgentId: exactId }).type)
      .toBe('forward_input_version');
    expect(() => validateForgeAction({ type: 'forward_input_version', targetAgentId: `${exactId}a` }))
      .toThrowError('ACTION_FIELD_INVALID');
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
    attempt({ type: 'send_message', targetAgentId: 'writer', summary: 'x', trace: 'y' });
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