// @vitest-environment node
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CorePaths,
  formatBatchFileName,
  formatEventFileName,
  isSafeSegment,
  parseBatchFileName,
  parseEventFileName,
} from './core-paths';

const ROOTS = { dataRoot: 'D:/core-data', templateRoot: 'D:/templates' };

describe('CorePaths', () => {
  it('keeps source templates, managed cache and tasks in separate roots', () => {
    const paths = CorePaths.create({ dataRoot: 'D:/core-data', templateRoot: 'D:/templates' });
    expect(paths.templateSource('alpha')).toBe(resolve('D:/templates/alpha'));
    expect(paths.templateCacheRoot).toBe(resolve('D:/core-data/template-cache'));
    expect(paths.tasksRoot).toBe(resolve('D:/core-data/tasks'));
  });

  it('derives the managed template cache layout inside the data root only', () => {
    const paths = CorePaths.create(ROOTS);
    expect(paths.templateCacheVersionRoot('alpha', 'abc123')).toBe(
      resolve('D:/core-data/template-cache/alpha/abc123'),
    );
    expect(paths.templateCacheCurrentFile('alpha')).toBe(
      resolve('D:/core-data/template-cache/alpha/current.json'),
    );
  });

  it('derives frozen task, snapshot, event and artifact layouts', () => {
    const paths = CorePaths.create(ROOTS);
    expect(paths.taskRoot('task-1')).toBe(resolve('D:/core-data/tasks/task-1'));
    expect(paths.taskFile('task-1')).toBe(resolve('D:/core-data/tasks/task-1/task.json'));
    expect(paths.taskSnapshotRoot('task-1')).toBe(resolve('D:/core-data/tasks/task-1/snapshot'));
    expect(paths.taskEventsRoot('task-1')).toBe(resolve('D:/core-data/tasks/task-1/events'));
    expect(paths.taskEventFile('task-1', '000001-evt-1.json')).toBe(
      resolve('D:/core-data/tasks/task-1/events/000001-evt-1.json'),
    );
    expect(paths.taskArtifactsRoot('task-1')).toBe(resolve('D:/core-data/tasks/task-1/artifacts'));
    expect(paths.taskArtifactVersionRoot('task-1', 2)).toBe(
      resolve('D:/core-data/tasks/task-1/artifacts/v002'),
    );
  });

  it('formats and parses six-digit sequence event file names', () => {
    expect(formatEventFileName(7, 'evt-1')).toBe('000007-evt-1.json');
    expect(parseEventFileName('000007-evt-1.json')).toEqual({ sequence: 7, eventId: 'evt-1' });
    expect(parseEventFileName('1-evt.json')).toBeNull();
    expect(parseEventFileName('.tmp-000001-evt-1.json')).toBeNull();
    expect(parseEventFileName('000001-evt-1.json.tmp')).toBeNull();
  });

  it('formats and parses batch envelope file names', () => {
    expect(formatBatchFileName(4, 6, 'commit-a')).toBe('000004-000006-commit-a.batch.json');
    expect(parseBatchFileName('000004-000006-commit-a.batch.json')).toEqual({
      firstSequence: 4,
      lastSequence: 6,
      commitId: 'commit-a',
    });
    expect(parseBatchFileName('1-6-commit-a.batch.json')).toBeNull();
    expect(parseBatchFileName('000004-000006-commit-a.json')).toBeNull();
    expect(parseBatchFileName('.tmp-000004-000006-commit-a.batch.json')).toBeNull();
  });

  it('never parses a batch file as a legacy event and vice versa', () => {
    // A batch name ends `.batch.json`, so it must never match the legacy regex.
    expect(parseEventFileName('000004-000006-commit-a.batch.json')).toBeNull();
    expect(parseBatchFileName('000004-evt-1.json')).toBeNull();
  });

  it('routes batch and legacy event files through separate validators', () => {
    const paths = CorePaths.create(ROOTS);
    expect(paths.taskEventFile('task-1', '000001-evt-1.json')).toBe(
      resolve('D:/core-data/tasks/task-1/events/000001-evt-1.json'),
    );
    expect(paths.taskBatchEventFile('task-1', '000001-000003-commit-a.batch.json')).toBe(
      resolve('D:/core-data/tasks/task-1/events/000001-000003-commit-a.batch.json'),
    );
    // A batch file must never slip through the legacy validator (its name also
    // satisfies the legacy six-digit pattern) and vice versa.
    expect(() => paths.taskEventFile('task-1', '000001-000003-commit-a.batch.json')).toThrow(
      /CORE_PATH_INVALID/,
    );
    expect(() => paths.taskBatchEventFile('task-1', '000001-evt-1.json')).toThrow(
      /CORE_PATH_INVALID/,
    );
    expect(() => paths.taskBatchEventFile('task-1', '000001-000003-../x.batch.json')).toThrow(
      /CORE_PATH_INVALID/,
    );
  });

  it('rejects identifiers that could escape their root', () => {
    const paths = CorePaths.create(ROOTS);
    expect(() => paths.templateSource('../escape')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.templateSource('a/b')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.templateSource('')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskRoot('..')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.templateCacheVersionRoot('alpha', 'x/y')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskEventFile('task-1', '../other.json')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskArtifactVersionRoot('task-1', 0)).toThrow(/CORE_PATH_INVALID/);
  });

  it('derives per-task trace and workspace layouts', () => {
    const paths = CorePaths.create(ROOTS);
    expect(paths.taskTracesRoot('task-1')).toBe(resolve('D:/core-data/tasks/task-1/traces'));
    expect(paths.taskTraceFile('task-1', 'turn-1')).toBe(
      resolve('D:/core-data/tasks/task-1/traces/turn-1.json'),
    );
    expect(paths.taskWorkspacesRoot('task-1')).toBe(
      resolve('D:/core-data/tasks/task-1/workspaces'),
    );
    expect(paths.taskWorkspaceRoot('task-1', 'agent-alpha')).toBe(
      resolve('D:/core-data/tasks/task-1/workspaces/agent-alpha'),
    );
  });

  it('rejects unsafe turn and agent identifiers', () => {
    const paths = CorePaths.create(ROOTS);
    expect(() => paths.taskTraceFile('task-1', '../evil')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskTraceFile('task-1', 'turn/1')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskTraceFile('task-1', '')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskWorkspaceRoot('task-1', '..')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskWorkspaceRoot('task-1', 'agent/alpha')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskWorkspaceRoot('task-1', '')).toThrow(/CORE_PATH_INVALID/);
  });

  it('exposes the shared safe-segment predicate', () => {
    expect(isSafeSegment('turn-1')).toBe(true);
    expect(isSafeSegment('agent.alpha_2')).toBe(true);
    expect(isSafeSegment('')).toBe(false);
    expect(isSafeSegment('.')).toBe(false);
    expect(isSafeSegment('..')).toBe(false);
    expect(isSafeSegment('a/b')).toBe(false);
    expect(isSafeSegment('../x')).toBe(false);
    expect(isSafeSegment('a\0b')).toBe(false);
  });
});

describe('CorePaths structured-slots layout', () => {
  it('derives the structured-slots directory tree under the task root', () => {
    const paths = CorePaths.create(ROOTS);
    const root = resolve('D:/core-data/tasks/task-1/structured-slots');
    expect(paths.taskStructuredSlotsRoot('task-1')).toBe(root);
    expect(paths.taskStructuredBlobsRoot('task-1')).toBe(joinPaths(root, 'blobs'));
    expect(paths.taskStructuredGenerationsRoot('task-1')).toBe(joinPaths(root, 'generations'));
    expect(paths.taskStructuredContentRevisionsRoot('task-1')).toBe(
      joinPaths(root, 'content-revisions'),
    );
    expect(paths.taskStructuredProposalsRoot('task-1')).toBe(joinPaths(root, 'proposals'));
    expect(paths.taskStructuredDraftsRoot('task-1')).toBe(joinPaths(root, 'drafts'));
    expect(paths.taskStructuredAttemptsRoot('task-1')).toBe(joinPaths(root, 'attempts'));
    expect(paths.taskStructuredCustodyRoot('task-1')).toBe(joinPaths(root, 'custody'));
  });

  it('derives content-addressed blob, generation, revision and journal files', () => {
    const paths = CorePaths.create(ROOTS);
    const root = resolve('D:/core-data/tasks/task-1/structured-slots');
    const digest = 'ab'.repeat(32);
    expect(paths.taskStructuredBlobFile('task-1', digest)).toBe(
      joinPaths(root, `blobs/ab/${digest}.json`),
    );
    expect(paths.taskStructuredContentRevisionFile('task-1', digest)).toBe(
      joinPaths(root, 'content-revisions', `${digest}.json`),
    );
    const genRoot = joinPaths(root, 'generations/gen-1');
    expect(paths.taskStructuredGenerationRoot('task-1', 'gen-1')).toBe(genRoot);
    expect(paths.taskStructuredGenerationManifestFile('task-1', 'gen-1')).toBe(
      joinPaths(genRoot, 'manifest.json'),
    );
    expect(paths.taskStructuredGenerationSlotsFile('task-1', 'gen-1')).toBe(
      joinPaths(genRoot, 'slots.ndjson'),
    );
    expect(paths.taskStructuredGenerationIndexFile('task-1', 'gen-1')).toBe(
      joinPaths(genRoot, 'index.json'),
    );
    const proposalRoot = joinPaths(root, 'proposals/prop-1');
    expect(paths.taskStructuredProposalRoot('task-1', 'prop-1')).toBe(proposalRoot);
    expect(paths.taskStructuredProposalJournalFile('task-1', 'prop-1')).toBe(
      joinPaths(proposalRoot, 'journal.ndjson'),
    );
    expect(paths.taskStructuredProposalCheckpointFile('task-1', 'prop-1')).toBe(
      joinPaths(proposalRoot, 'checkpoint.json'),
    );
    expect(paths.taskStructuredProposalLifecycleFile('task-1', 'prop-1')).toBe(
      joinPaths(proposalRoot, 'lifecycle.json'),
    );
    const draftRoot = joinPaths(root, 'drafts/draft-1');
    expect(paths.taskStructuredDraftRoot('task-1', 'draft-1')).toBe(draftRoot);
    expect(paths.taskStructuredDraftJournalFile('task-1', 'draft-1')).toBe(
      joinPaths(draftRoot, 'journal.ndjson'),
    );
    expect(paths.taskStructuredDraftCheckpointFile('task-1', 'draft-1')).toBe(
      joinPaths(draftRoot, 'checkpoint.json'),
    );
    expect(paths.taskStructuredDraftLifecycleFile('task-1', 'draft-1')).toBe(
      joinPaths(draftRoot, 'lifecycle.json'),
    );
    expect(paths.taskStructuredAttemptMeterFile('task-1', 'turn-1')).toBe(
      joinPaths(root, 'attempts/turn-1/meter.json'),
    );
  });

  it('rejects unsafe structured identifiers and malformed hashes', () => {
    const paths = CorePaths.create(ROOTS);
    const digest = 'ab'.repeat(32);
    expect(() => paths.taskStructuredBlobFile('task-1', '../evil')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskStructuredBlobFile('task-1', 'xy')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskStructuredBlobFile('task-1', 'GG'.repeat(32))).toThrow(
      /CORE_PATH_INVALID/,
    );
    expect(() => paths.taskStructuredGenerationRoot('task-1', '../gen')).toThrow(
      /CORE_PATH_INVALID/,
    );
    expect(() => paths.taskStructuredProposalRoot('task-1', 'a/b')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskStructuredDraftRoot('task-1', '..')).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskStructuredAttemptMeterFile('task-1', 'turn/1')).toThrow(
      /CORE_PATH_INVALID/,
    );
  });
});

describe('CorePaths v2 blob layout (spec §8)', () => {
  it('derives the v2 blob directory tree under structured-slots/v2', () => {
    const paths = CorePaths.create(ROOTS);
    const root = resolve('D:/core-data/tasks/task-1/structured-slots');
    expect(paths.taskStructuredV2Root('task-1')).toBe(joinPaths(root, 'v2'));
    expect(paths.taskStructuredV2BlobsRoot('task-1')).toBe(joinPaths(root, 'v2/blobs'));
  });

  it('derives content-addressed v2 blob files: blobs/<kind>/<first2>/<digest>', () => {
    const paths = CorePaths.create(ROOTS);
    const root = resolve('D:/core-data/tasks/task-1/structured-slots');
    const digest = 'ab'.repeat(32);
    expect(paths.taskStructuredV2BlobFile('task-1', 'review_fact', digest)).toBe(
      joinPaths(root, 'v2/blobs/review_fact/ab', digest),
    );
    const other = `cd${'12'.repeat(31)}`;
    expect(paths.taskStructuredV2BlobFile('task-1', 'profile_snapshot', other)).toBe(
      joinPaths(root, 'v2/blobs/profile_snapshot/cd', other),
    );
  });

  it('rejects unsafe v2 kinds and malformed digests', () => {
    const paths = CorePaths.create(ROOTS);
    const digest = 'ab'.repeat(32);
    expect(() => paths.taskStructuredV2BlobFile('task-1', '../evil', digest)).toThrow(
      /CORE_PATH_INVALID/,
    );
    expect(() => paths.taskStructuredV2BlobFile('task-1', 'review/fact', digest)).toThrow(
      /CORE_PATH_INVALID/,
    );
    expect(() => paths.taskStructuredV2BlobFile('task-1', '', digest)).toThrow(/CORE_PATH_INVALID/);
    expect(() => paths.taskStructuredV2BlobFile('task-1', 'review_fact', 'xy')).toThrow(
      /CORE_PATH_INVALID/,
    );
    expect(() => paths.taskStructuredV2BlobFile('task-1', 'review_fact', 'GG'.repeat(32))).toThrow(
      /CORE_PATH_INVALID/,
    );
    expect(() => paths.taskStructuredV2BlobFile('../task', 'review_fact', digest)).toThrow(
      /CORE_PATH_INVALID/,
    );
  });
});

function joinPaths(root: string, ...rel: string[]): string {
  return resolve(root, ...rel);
}
