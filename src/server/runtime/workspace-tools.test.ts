// @vitest-environment node
/**
 * Workspace tool definitions tests (plan Phase E Task 2 Step 1).
 *
 * The three agent-workspace file tools (`write_workspace` / `read_workspace`
 * / `list_workspace`) are exposed as Pi ToolDefinitions bound to a closed
 * `{workspaces, taskId, agentId}` context. They take effect immediately and
 * NEVER pass through the ActionBuffer or the event union (plan Global
 * Constraint 6): a write is visible to a following read/list in the same
 * Turn, and an ActionBuffer constructed alongside stays empty. Every store
 * failure surfaces as a `rejected` acknowledgement (stable code), never a
 * throw, so the model Turn can recover.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionBuffer } from './action-buffer';
import { RuntimeFailure } from './agent-runtime';
import { disposeAllTestRoots, makeTempCorePaths } from '../test-support';
import type { CorePaths } from '../storage/core-paths';
import { WorkspaceStore, WORKSPACE_LIMITS } from './workspace-store';
import {
  createWorkspaceToolDefinitions,
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_TOOL_NAME_SET,
} from './workspace-tools';

const TASK = 'task-1';
const AGENT = 'agent-alpha';

let paths: CorePaths;
let store: WorkspaceStore;

beforeEach(() => {
  ({ paths } = makeTempCorePaths('forge-core-wstools-'));
  store = new WorkspaceStore(paths);
});

afterEach(() => {
  disposeAllTestRoots();
});

function definitions(isProductionPhase: () => boolean = () => true) {
  return createWorkspaceToolDefinitions({
    workspaces: store,
    taskId: TASK,
    agentId: AGENT,
    isProductionPhase,
  });
}

function findTool(name: string, isProductionPhase?: () => boolean) {
  return definitions(isProductionPhase).find((tool) => tool.name === name);
}

async function execute(tool: ReturnType<typeof findTool>, params: Record<string, unknown>) {
  const result = await tool?.execute('tc-1', params, undefined, undefined, {} as never);
  const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
  const details = result?.details as { accepted?: boolean; code?: string } | undefined;
  return { text, accepted: details?.accepted === true, code: details?.code };
}

describe('workspace tool registry (plan Phase E Task 2)', () => {
  it('exposes exactly the three workspace tool names', () => {
    expect(WORKSPACE_TOOL_NAMES).toEqual(['write_workspace', 'read_workspace', 'list_workspace']);
    expect(WORKSPACE_TOOL_NAME_SET.size).toBe(3);
    for (const name of WORKSPACE_TOOL_NAMES) {
      expect(WORKSPACE_TOOL_NAME_SET.has(name)).toBe(true);
    }
    expect(WORKSPACE_TOOL_NAME_SET.has('publish_artifact' as never)).toBe(false);
  });

  it('creates exactly three tool definitions named by the workspace registry', () => {
    const tools = definitions();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...WORKSPACE_TOOL_NAMES].sort());
  });

  it('declares every workspace tool as sequential', () => {
    for (const tool of definitions()) {
      expect(tool.executionMode).toBe('sequential');
    }
  });
});

describe('workspace tool execution', () => {
  it('round-trips write -> read -> list with immediate effect', async () => {
    const write = await execute(findTool('write_workspace'), { path: 'draft/v1.md', content: '初稿正文' });
    expect(write.accepted).toBe(true);
    expect(write.text).toBe('draft/v1.md (12 bytes)');

    const read = await execute(findTool('read_workspace'), { path: 'draft/v1.md' });
    expect(read.accepted).toBe(true);
    expect(read.text).toBe('初稿正文');

    const list = await execute(findTool('list_workspace'), {});
    expect(list.accepted).toBe(true);
    expect(list.text).toBe('draft/v1.md (12 bytes)');
  });

  it('lists an untouched workspace as empty', async () => {
    const list = await execute(findTool('list_workspace'), {});
    expect(list.accepted).toBe(true);
    expect(list.text).toBe('empty workspace');
  });

  it('rejects an unsafe path with a stable code instead of throwing', async () => {
    const write = await execute(findTool('write_workspace'), { path: '../escape.md', content: 'x' });
    expect(write.accepted).toBe(false);
    expect(write.code).toBe('WORKSPACE_PATH_UNSAFE');
    expect(write.text).toContain('rejected');
    expect(write.text).toContain('WORKSPACE_PATH_UNSAFE');
  });

  it('rejects a read of a missing file without throwing', async () => {
    const read = await execute(findTool('read_workspace'), { path: 'nope.md' });
    expect(read.accepted).toBe(false);
    expect(read.code).toBe('WORKSPACE_FILE_NOT_FOUND');
  });

  it('rejects a file beyond the byte limit without throwing', async () => {
    const oversize = 'x'.repeat(WORKSPACE_LIMITS.maxFileBytes + 1);
    const write = await execute(findTool('write_workspace'), { path: 'big.md', content: oversize });
    expect(write.accepted).toBe(false);
    expect(write.code).toBe('WORKSPACE_FILE_TOO_LARGE');
  });

  it('never proposes anything to a concurrent ActionBuffer', async () => {
    const buffer = new ActionBuffer('turn-ws');
    // The workspace tools receive only the store context — no buffer handle.
    await execute(findTool('write_workspace'), { path: 'a.md', content: 'one' });
    await execute(findTool('write_workspace'), { path: 'b.md', content: 'two' });
    await execute(findTool('read_workspace'), { path: 'a.md' });
    await execute(findTool('list_workspace'), {});
    expect(buffer.snapshot()).toEqual([]);
    // And the store really did take effect outside any buffer.
    expect(await store.readFile(TASK, AGENT, 'a.md')).toBe('one');
  });

  it('surfaces RuntimeFailure codes from the store verbatim', async () => {
    // Depth beyond the limit is a store-level path-safety rejection.
    const write = await execute(findTool('write_workspace'), {
      path: 'a/b/c/d/e.md',
      content: 'deep',
    });
    expect(write.accepted).toBe(false);
    expect(write.code).toBe('WORKSPACE_PATH_UNSAFE');
    // The rejection is an acknowledgement, not a thrown RuntimeFailure.
    expect(write.text).not.toContain('RuntimeFailure');
  });
});

describe('workspace write gating once the turn leaves production (review F1)', () => {
  const sealed = () => false;

  it('rejects write_workspace after sealing with a stable code and leaves files untouched', async () => {
    // Production-phase write succeeds first (the sealed content baseline).
    const before = await execute(findTool('write_workspace'), {
      path: 'draft/v1.md',
      content: '封存时刻内容',
    });
    expect(before.accepted).toBe(true);

    // Once the turn sealed its package, writes are refused — the file the
    // sealed workspace_file package refers to must never change underneath.
    const overwrite = await execute(findTool('write_workspace', sealed), {
      path: 'draft/v1.md',
      content: '封存后篡改',
    });
    expect(overwrite.accepted).toBe(false);
    expect(overwrite.code).toBe('WORKSPACE_WRITE_AFTER_SEAL');
    expect(overwrite.text).toContain('rejected');
    expect(await store.readFile(TASK, AGENT, 'draft/v1.md')).toBe('封存时刻内容');

    // A brand-new path is refused just the same.
    const fresh = await execute(findTool('write_workspace', sealed), {
      path: 'late.md',
      content: '晚来的写入',
    });
    expect(fresh.accepted).toBe(false);
    expect(fresh.code).toBe('WORKSPACE_WRITE_AFTER_SEAL');
    await expect(store.readFile(TASK, AGENT, 'late.md')).rejects.toMatchObject({
      code: 'WORKSPACE_FILE_NOT_FOUND',
    });
  });

  it('keeps read_workspace and list_workspace available after sealing', async () => {
    await execute(findTool('write_workspace'), { path: 'draft/v1.md', content: '正文' });
    const read = await execute(findTool('read_workspace', sealed), { path: 'draft/v1.md' });
    expect(read.accepted).toBe(true);
    expect(read.text).toBe('正文');
    const list = await execute(findTool('list_workspace', sealed), {});
    expect(list.accepted).toBe(true);
    expect(list.text).toBe('draft/v1.md (6 bytes)');
  });

  it('accepts writes again while the phase probe reports production', async () => {
    const write = await execute(findTool('write_workspace', () => true), {
      path: 'ok.md',
      content: '可写',
    });
    expect(write.accepted).toBe(true);
    expect(await store.readFile(TASK, AGENT, 'ok.md')).toBe('可写');
  });

  it('documents the sealing gate in the write tool description', () => {
    const write = findTool('write_workspace');
    expect(write?.description).toContain('sealed');
  });
});
