/**
 * Forge Core local entry point (plan Phase B Task 1; runtime switch Task 6).
 *
 * Reads explicit roots from the environment and fails loud without echoing
 * any configured value. Run with tsx: `npm run dev` in the workspace (or
 * `npm run core:dev` from the repository root).
 *
 * Environment-only switches (never exposed through the UI or the HTTP API):
 * - `FORGE_CORE_MODE` development | production | test (test = API routes
 *   only, no client files — used by the process-recovery e2e children).
 * - `FORGE_CORE_RUNTIME` pi | fake (default pi). `fake` selects the
 *   deterministic scripted FakeAgentRuntime for e2e/tests, reading its
 *   scripts from the JSON file named by `FORGE_CORE_FAKE_SCRIPTS`; a child
 *   process cannot receive in-memory scripts. Production stays on the
 *   constrained PiAgentRuntime.
 * - `FORGE_CORE_ACCEPTANCE_SIGNAL_DIR` (acceptance process harness only,
 *   plan Phase D Task 4): installs the recovery boundary hook — the loop
 *   pauses at each confirmed artifact/message boundary and waits for the
 *   runner's release file, strictly before the next Agent is scheduled.
 *   Never read by the production API/UI.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { CoreService } from './core-service';
import {
  BOUNDARY_SHUTDOWN_FILE_NAME,
  createAcceptanceBoundaryHook,
} from './acceptance-boundary';
import { createForgeCoreServer, type ForgeCoreServerOptions } from './http-server';
import { CorePaths } from './storage/core-paths';
import type { AgentRuntime } from './runtime/agent-runtime';
import { FakeAgentRuntime } from './runtime/fake-agent-runtime';
import { loadFakeScriptsFromFile } from './runtime/fake-script-file';
import { PiAgentRuntime } from './runtime/pi-agent-runtime';
import { WorkspaceStore } from './runtime/workspace-store';

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    console.error(
      `forge-core: required environment variable ${name} is not set (provide an absolute directory; configured values are never logged)`,
    );
    process.exit(1);
  }
  return value;
}

function resolveMode(raw: string | undefined): 'development' | 'production' | 'test' {
  const value = raw ?? 'development';
  if (value !== 'development' && value !== 'production' && value !== 'test') {
    console.error('forge-core: FORGE_CORE_MODE must be development, production or test');
    process.exit(1);
  }
  return value;
}

function resolvePort(raw: string | undefined): number {
  const value = raw ?? '3000';
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error('forge-core: FORGE_CORE_PORT must be an integer between 0 and 65535');
    process.exit(1);
  }
  return port;
}

function resolveRuntimeKind(raw: string | undefined): 'fake' | 'pi' {
  const value = raw ?? 'pi';
  if (value !== 'fake' && value !== 'pi') {
    console.error('forge-core: FORGE_CORE_RUNTIME must be either fake or pi');
    process.exit(1);
  }
  return value;
}

/** Builds the runtime selected by FORGE_CORE_RUNTIME (default: Pi). */
function buildRuntime(kind: 'fake' | 'pi', paths: CorePaths): AgentRuntime {
  if (kind === 'fake') {
    const scriptFile = process.env.FORGE_CORE_FAKE_SCRIPTS;
    if (scriptFile === undefined || scriptFile.trim() === '') {
      console.error(
        'forge-core: FORGE_CORE_RUNTIME=fake requires FORGE_CORE_FAKE_SCRIPTS to name a script file',
      );
      process.exit(1);
    }
    try {
      return new FakeAgentRuntime({ scripts: loadFakeScriptsFromFile(scriptFile) });
    } catch (error) {
      console.error(
        `forge-core: ${error instanceof Error ? error.message : 'the fake script file is unusable'}`,
      );
      process.exit(1);
    }
  }
  return new PiAgentRuntime({
    coreCwd: paths.dataRoot,
    workspaces: new WorkspaceStore(paths),
  });
}

async function main(): Promise<void> {
  const dataRoot = requireEnv('FORGE_CORE_DATA_ROOT', process.env.FORGE_CORE_DATA_ROOT);
  const templateRoot = requireEnv('FORGE_CORE_TEMPLATE_ROOT', process.env.FORGE_CORE_TEMPLATE_ROOT);
  const mode = resolveMode(process.env.FORGE_CORE_MODE);
  const runtimeKind = resolveRuntimeKind(process.env.FORGE_CORE_RUNTIME);

  // Acceptance-only recovery boundary (plan Phase D Task 4): present ONLY in
  // the acceptance process harness through this environment switch, never in
  // the production API/UI. When set, the loop pauses at each confirmed
  // artifact/message boundary so the runner can interrupt and reconcile.
  const signalDir = process.env.FORGE_CORE_ACCEPTANCE_SIGNAL_DIR;
  const serviceHolder: { service: CoreService | null } = { service: null };
  const acceptanceStopAfterCommit =
    signalDir !== undefined && signalDir.trim() !== ''
      ? createAcceptanceBoundaryHook({
          signalDir,
          readCounts: async (taskId) => {
            const service = serviceHolder.service;
            if (service === null) {
              throw new Error('forge-core: the acceptance boundary hook ran before the service');
            }
            const workspace = await service.getWorkspace(taskId);
            return {
              artifacts: workspace.artifacts.length,
              messageRoutes: workspace.executedRoutes.filter(
                (route) => route.kind === 'message',
              ).length,
            };
          },
        })
      : undefined;

  // One explicit CoreService so the runtime selection stays visible at the
  // entry point; the server receives it pre-initialized.
  const paths = CorePaths.create({ dataRoot, templateRoot });
  const coreService = new CoreService(paths, {
    runtime: buildRuntime(runtimeKind, paths),
    ...(acceptanceStopAfterCommit !== undefined ? { acceptanceStopAfterCommit } : {}),
  });
  serviceHolder.service = coreService;
  await coreService.initialize();

  const options: ForgeCoreServerOptions = {
    mode,
    dataRoot,
    templateRoot,
    coreService,
  };
  const port = resolvePort(process.env.FORGE_CORE_PORT);
  const server = await createForgeCoreServer(options);
  const url = await server.listen(port);
  console.log(`forge-core: listening on ${url} (mode=${options.mode}, runtime=${runtimeKind})`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await server.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Acceptance-only graceful-shutdown coordination (plan 2026-08-04): POSIX
  // signals never reach detached child-process handlers on Windows, so the
  // runner drops a `shutdown` file into the signal directory instead. This
  // watcher exists ONLY behind the acceptance environment switch — the
  // production server never polls anything.
  if (signalDir !== undefined && signalDir.trim() !== '') {
    const shutdownFile = join(signalDir, BOUNDARY_SHUTDOWN_FILE_NAME);
    const shutdownWatch = setInterval(() => {
      try {
        statSync(shutdownFile);
      } catch {
        return; // No shutdown request yet.
      }
      clearInterval(shutdownWatch);
      void shutdown();
    }, 200);
    shutdownWatch.unref();
  }
}

main().catch((error: unknown) => {
  console.error(
    `forge-core: failed to start (${error instanceof Error ? error.name : 'unknown error'}). Check that the configured directories exist and are writable.`,
  );
  process.exit(1);
});
