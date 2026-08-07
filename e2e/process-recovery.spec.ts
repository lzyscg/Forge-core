/**
 * Phase C browser gate, part 2 (plan Task 6 Step 2): process-kill recovery.
 *
 * A REAL child process (`tsx src/server/main.ts`) runs over explicit
 * temporary roots with FORGE_CORE_RUNTIME=fake and a scripted-behavior
 * file. Phase A scripts commit alpha's V1 and the beta routes, then hold
 * beta's Turn mid-flight on a never-resolving deferred; the child receives
 * SIGKILL while that Turn is in flight (no terminal event, nothing guessed).
 * A second child boots on the SAME roots: startup recovery marks the task
 * interrupted before any request is served; the public resume route
 * continues from the last confirmed event and completes with beta's V2
 * submission — no duplicate artifact versions, no duplicate or gapped
 * events (spec §7.2).
 */
import { expect, test } from '@playwright/test';
import type { TaskWorkspace } from '../src/shared/contracts';
import {
  prepareChildRoots,
  processAlive,
  readChildFileProjection,
  recoveryPhaseAScripts,
  recoveryPhaseBScripts,
  RUNTIME_INPUT_FIELD_ID,
  RUNTIME_TEMPLATE_ID,
  spawnScriptedCoreChild,
  writeFakeScriptFile,
  type ScriptedChildServer,
} from './runtime-harness';
import { createServer as createNetServer } from 'node:net';

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('process-recovery: the port probe did not report an address'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

async function createAndStartTask(baseUrl: string, name: string): Promise<string> {
  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: RUNTIME_TEMPLATE_ID,
      name,
      input: { [RUNTIME_INPUT_FIELD_ID]: '进程恢复验收的开场输入。' },
    }),
  });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  const started = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(id)}/start`, {
    method: 'POST',
  });
  expect(started.status).toBe(202);
  return id;
}

async function fetchWorkspace(baseUrl: string, taskId: string): Promise<TaskWorkspace> {
  const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/workspace`);
  expect(response.status).toBe(200);
  return (await response.json()) as TaskWorkspace;
}

async function waitForWorkspace(
  baseUrl: string,
  taskId: string,
  predicate: (workspace: TaskWorkspace) => boolean,
  timeoutMs = 25_000,
): Promise<TaskWorkspace> {
  const deadline = Date.now() + timeoutMs;
  let workspace = await fetchWorkspace(baseUrl, taskId);
  while (!predicate(workspace)) {
    if (Date.now() > deadline) {
      throw new Error(
        `process-recovery: workspace condition not met within ${timeoutMs} ms` +
          ` (last status=${workspace.task.status}, artifacts=${workspace.artifacts.length})`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    workspace = await fetchWorkspace(baseUrl, taskId);
  }
  return workspace;
}

test('process recovery: SIGKILL mid-Turn restarts as interrupted and resumes without duplicates', async () => {
  const roots = prepareChildRoots();
  const port = await reserveLoopbackPort();
  let child: ScriptedChildServer | null = null;
  try {
    // ---- Phase A: run until beta's Turn hangs, then SIGKILL the process.
    writeFakeScriptFile(roots.scriptFile, recoveryPhaseAScripts());
    child = await spawnScriptedCoreChild({
      dataRoot: roots.dataRoot,
      templateRoot: roots.templateRoot,
      scriptFile: roots.scriptFile,
      port,
    });
    const taskId = await createAndStartTask(child.url, '进程恢复验收任务');

    // Wait for alpha's committed Turn: V1 published, beta inputs created
    // (the publish auto-routes the artifact hand-off — one executed route).
    await waitForWorkspace(
      child.url,
      taskId,
      (workspace) =>
        workspace.artifacts.length === 1 &&
        workspace.executedRoutes.length >= 1 &&
        workspace.task.status === 'running',
    );
    const midFlightPid = child.child.pid;
    expect(midFlightPid).toBeTruthy();
    // Give the loop the moment it needs to enter beta's paused Turn.
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    expect(processAlive(midFlightPid as number)).toBe(true);

    // Mid-Turn proof: beta owns unprocessed inputs but no committed result.
    const beforeKill = readChildFileProjection(roots, taskId);
    const betaInputs = beforeKill.events.filter(
      (entry) =>
        entry.event.type === 'agent_input' &&
        (entry.event as unknown as { node: { agentId: string } }).node.agentId === 'agent-beta',
    );
    expect(betaInputs.length).toBeGreaterThan(0);
    const betaResults = beforeKill.events.filter(
      (entry) =>
        entry.event.type === 'agent_result' &&
        (entry.event as unknown as { node: { agentId: string } }).node.agentId === 'agent-beta',
    );
    expect(betaResults).toHaveLength(0);
    const eventsBeforeKill = beforeKill.events.length;

    await child.killHard();
    expect(processAlive(midFlightPid as number)).toBe(false);
    child = null;

    // ---- Phase B: restart on the same roots with the continuation script.
    writeFakeScriptFile(roots.scriptFile, recoveryPhaseBScripts());
    child = await spawnScriptedCoreChild({
      dataRoot: roots.dataRoot,
      templateRoot: roots.templateRoot,
      scriptFile: roots.scriptFile,
      port,
    });

    // Startup recovery marks the task interrupted BEFORE any user action.
    const interrupted = await fetchWorkspace(child.url, taskId);
    expect(interrupted.task.status).toBe('interrupted');

    // Explicit public resume continues from the last confirmed event.
    const resumed = await fetch(`${child.url}/api/tasks/${encodeURIComponent(taskId)}/resume`, {
      method: 'POST',
    });
    expect(resumed.status).toBe(202);
    await waitForWorkspace(
      child.url,
      taskId,
      (workspace) => workspace.task.status === 'completed',
    );

    const finalWorkspace = await fetchWorkspace(child.url, taskId);
    // v2: beta is operate-only — the recovered turn annotates + submits the
    // received V1 (zero-copy), so the version chain stays at one version.
    expect(finalWorkspace.artifacts.map((artifact) => artifact.version)).toEqual([1]);
    expect(finalWorkspace.artifacts.find((artifact) => artifact.version === 1)?.final).toBe(true);

    // No duplicate versions: exactly one directory per published version.
    const afterResume = readChildFileProjection(roots, taskId);
    expect(afterResume.artifacts.map((artifact) => artifact.version)).toEqual([1]);

    // Event stream integrity across the crash: contiguous sequences, unique
    // ids, exactly one more result than before the kill (nothing replayed or
    // guessed from the unconfirmed Turn), one final submission.
    const ids = afterResume.events.map((entry) => entry.event.id);
    expect(new Set(ids).size).toBe(ids.length);
    afterResume.events.forEach((entry, index) => {
      expect(entry.sequence, `event sequence at ${entry.fileName}`).toBe(index + 1);
    });
    expect(afterResume.events.length).toBeGreaterThan(eventsBeforeKill);
    const betaResultsAfter = afterResume.events.filter(
      (entry) =>
        entry.event.type === 'agent_result' &&
        (entry.event as unknown as { node: { agentId: string } }).node.agentId === 'agent-beta',
    );
    expect(betaResultsAfter).toHaveLength(1);
    expect(
      afterResume.events.filter((entry) => entry.event.type === 'final_submission_accepted'),
    ).toHaveLength(1);
    expect(
      afterResume.events.filter((entry) => entry.event.type === 'artifact_published'),
    ).toHaveLength(1);
    expect(
      afterResume.events.some((entry) => entry.event.type === 'task_interrupted'),
    ).toBe(true);
    expect(
      afterResume.events.some((entry) => entry.event.type === 'task_resumed'),
    ).toBe(true);
  } finally {
    if (child !== null) {
      await child.stop().catch(() => undefined);
    }
    roots.cleanup();
  }
});
