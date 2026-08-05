// @vitest-environment node
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CorePaths, formatEventFileName, isSafeSegment, parseEventFileName } from './core-paths';

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
