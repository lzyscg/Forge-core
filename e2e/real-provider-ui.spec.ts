/**
 * Real Provider UI reconciliation gate (plan Phase D Task 4 Step 3).
 *
 * Reconciles the THREE views of the REAL recovery run over the acceptance
 * data root named by `FORGE_CORE_RECOVERY_DATA_ROOT`:
 *
 *   1. committed event/artifact FILES on disk;
 *   2. the HTTP `TaskWorkspace` projection served by the restarted server;
 *   3. the rendered DOM (node elements, route arrows, artifact version chain,
 *      preview text) the production page displays.
 *
 * An in-process DEVELOPMENT-mode server boots over the very roots the real
 * run used (`VITE_FORGE_CORE_MODE=http` makes the served client bind the
 * HttpGateway, exactly like the Phase B harness); the task is read-only — it
 * is already `completed`, so this spec never starts or resumes anything.
 * Any node/route/artifact mismatch between the views fails the acceptance.
 *
 * The spec SKIPS (not fails) when the environment does not point at a real
 * recovery data root, so the standing `core:e2e` gate stays green without a
 * real run; the orchestrator runs it with the root exported right after
 * `core:acceptance:recovery` completes.
 */
import { existsSync, readdirSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CoreService } from '../src/server/core-service';
import { createForgeCoreServer, type ForgeCoreServer } from '../src/server/http-server';
import { CorePaths } from '../src/server/storage/core-paths';
import type { TaskWorkspace } from '../src/shared/contracts';
import { readRecoveryFileProjection } from '../scripts/real-recovery-acceptance';

const GATEWAY_MODE_ENV = 'VITE_FORGE_CORE_MODE';
const ACCEPTANCE_TEMPLATE_SOURCE_DIRNAME = 'acceptance-template-source';

const NODE_EVENT_TYPES = new Set([
  'agent_input',
  'agent_result',
  'human_requested',
  'human_answered',
  // Phase E Task 3 parity: the server projector folds skill_loaded events
  // into skill nodes, so the file side must count them too.
  'skill_loaded',
]);

/**
 * CSS-ident escaper for element ids (Node has no global `CSS`): committed
 * node ids only ever carry `[A-Za-z0-9._-]` (CorePaths SAFE_SEGMENT), so
 * escaping every character outside the ident-safe set is complete here.
 */
function cssEscapeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('real-provider-ui: the port probe did not report an address'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

interface RecoveryRoots {
  dataRoot: string;
  templateRoot: string;
  taskId: string;
}

/**
 * Resolves the real recovery run under test, or null when the environment is
 * not pointing at a usable data root (the spec then skips).
 */
function resolveRecoveryRoots(): RecoveryRoots | null {
  const dataRoot = process.env.FORGE_CORE_RECOVERY_DATA_ROOT;
  if (dataRoot === undefined || dataRoot.trim() === '') {
    return null;
  }
  const templateRoot = join(dataRoot, ACCEPTANCE_TEMPLATE_SOURCE_DIRNAME);
  const paths = CorePaths.create({ dataRoot, templateRoot });
  if (!existsSync(paths.tasksRoot)) {
    return null;
  }
  // The real recovery run creates exactly one task; pick the first task whose
  // committed history already carries a confirmed final submission.
  for (const taskId of readdirSync(paths.tasksRoot).sort()) {
    let projection;
    try {
      projection = readRecoveryFileProjection(dataRoot, templateRoot, taskId);
    } catch {
      continue;
    }
    const hasFinal = projection.events.some(
      (entry) => entry.event.type === 'final_submission_accepted',
    );
    if (hasFinal && projection.artifacts.length >= 2) {
      return { dataRoot, templateRoot, taskId };
    }
  }
  return null;
}

const roots = resolveRecoveryRoots();

test.describe('real provider UI reconciliation (plan Phase D Task 4)', () => {
  test.skip(
    roots === null,
    'real provider UI reconciliation needs FORGE_CORE_RECOVERY_DATA_ROOT pointing at a completed real recovery run',
  );

  test('the UI nodes, route arrows and version chain match files and HTTP projection', async ({
    page,
  }) => {
    // Narrowed by the describe-level skip above.
    const active = roots as RecoveryRoots;
    const paths = CorePaths.create({ dataRoot: active.dataRoot, templateRoot: active.templateRoot });

    const previousMode = process.env[GATEWAY_MODE_ENV];
    process.env[GATEWAY_MODE_ENV] = 'http';
    let server: ForgeCoreServer | null = null;
    let baseUrl = '';
    try {
      const service = new CoreService(paths);
      await service.initialize();
      server = await createForgeCoreServer({
        mode: 'development',
        dataRoot: active.dataRoot,
        templateRoot: active.templateRoot,
        coreService: service,
      });
      const port = await reserveLoopbackPort();
      baseUrl = await server.listen(port);

      // View 2: the HTTP projection.
      const workspaceResponse = await fetch(
        `${baseUrl}/api/tasks/${encodeURIComponent(active.taskId)}/workspace`,
      );
      expect(workspaceResponse.status).toBe(200);
      const workspace = (await workspaceResponse.json()) as TaskWorkspace;
      expect(workspace.task.status).toBe('completed');

      // View 1: the committed files.
      const projection = readRecoveryFileProjection(
        active.dataRoot,
        active.templateRoot,
        active.taskId,
      );
      const fileNodeIds = projection.events
        .filter((entry) => NODE_EVENT_TYPES.has(entry.event.type))
        .map((entry) => entry.event.id)
        .sort();
      const fileRoutes = projection.events.filter((entry) => entry.event.type === 'route_executed');
      const fileArtifactRoutes = fileRoutes.filter(
        (entry) => (entry.event as unknown as { route: { kind: string } }).route.kind === 'artifact',
      );
      const fileMessageRoutes = fileRoutes.filter(
        (entry) => (entry.event as unknown as { route: { kind: string } }).route.kind === 'message',
      );

      // Files <-> HTTP projection: identical node and route identities.
      expect(workspace.nodes.map((node) => node.id).sort()).toEqual(fileNodeIds);
      expect(workspace.executedRoutes.length).toBe(fileRoutes.length);
      expect(
        workspace.executedRoutes.filter((route) => route.kind === 'artifact').length,
      ).toBe(fileArtifactRoutes.length);
      expect(
        workspace.executedRoutes.filter((route) => route.kind === 'message').length,
      ).toBe(fileMessageRoutes.length);
      expect(workspace.artifacts.map((artifact) => artifact.version)).toEqual(
        projection.artifacts.map((artifact) => artifact.version),
      );

      // View 3: the rendered DOM over the same served origin.
      await page.goto(`${baseUrl}/tasks/${encodeURIComponent(active.taskId)}`);
      await page.waitForSelector('[data-testid="workspace-canvas"]');
      await expect(page.getByText('已完成').first()).toBeVisible();

      // Nodes: one canvas element per committed node, identity by element id.
      const domNodes = page.locator('[data-testid="workspace-node"]');
      await expect(domNodes).toHaveCount(workspace.nodes.length);
      for (const nodeId of fileNodeIds) {
        await expect(page.locator(`#node-${cssEscapeId(nodeId)}`)).toHaveCount(1);
      }

      // Route arrows: one flow path per executed route, by kind.
      await expect(page.locator('.fc-flow-path--artifact')).toHaveCount(
        fileArtifactRoutes.length,
      );
      await expect(page.locator('.fc-flow-path--message')).toHaveCount(fileMessageRoutes.length);

      // Version chain: one item per committed artifact, in version order, with
      // exactly one final marker on the accepted final version.
      const versionItems = page.locator('.fc-version-item');
      await expect(versionItems).toHaveCount(projection.artifacts.length);
      for (const artifact of projection.artifacts) {
        await expect(
          versionItems.filter({ hasText: `V${artifact.version}` }),
        ).toHaveCount(1);
      }
      await expect(page.locator('.fc-version-item__final')).toHaveCount(1);

      // Artifact preview: selecting the final version shows exactly the
      // committed final content (paragraph-for-paragraph).
      const finalArtifact = projection.artifacts.find((candidate) => {
        const finals = projection.events.filter(
          (entry) => entry.event.type === 'final_submission_accepted',
        );
        const finalVersion = finals.length
          ? Number((finals[0].event as unknown as { version: unknown }).version)
          : null;
        return candidate.version === finalVersion;
      });
      expect(finalArtifact).toBeDefined();
      await versionItems
        .filter({ hasText: `V${(finalArtifact as { version: number }).version}` })
        .locator('button')
        .click();
      const preview = page.locator('[data-testid="artifact-preview"]');
      await expect(preview).toBeVisible();
      const domParagraphs = (await preview.locator('p').allInnerTexts())
        .map((text) => text.trim())
        .filter((text) => text.length > 0);
      const fileParagraphs = (finalArtifact as { content: string }).content
        .split(/\n{2,}/)
        .map((text) => text.trim())
        .filter((text) => text.length > 0);
      expect(domParagraphs).toEqual(fileParagraphs);
    } finally {
      if (server !== null) {
        await server.close();
      }
      if (previousMode === undefined) delete process.env[GATEWAY_MODE_ENV];
      else process.env[GATEWAY_MODE_ENV] = previousMode;
    }
  });
});
