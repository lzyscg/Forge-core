/**
 * Persistent HTTP harness for the Phase B browser gate (plan Task 6).
 *
 * Boots one development-mode core server over a single explicit temporary
 * data root (reused across restarts) with the Task 2 `valid` fixture copied
 * as the only template source. `VITE_FORGE_CORE_MODE=http` is injected into
 * the process environment before the server spawns its Vite middleware, so
 * the client served at harness.url binds the HttpGateway; the config-level
 * 4173 webServer is never touched by this spec.
 *
 * The server keeps one fixed loopback port across restarts so the page can
 * `reload()` after the process-level restart. Seeding flows exclusively
 * through the CoreService test APIs (createTask/appendTestEvent/
 * publishTestArtifact) — committed files are never hand-written to fake
 * history; the only file mutations here are the deliberate damage scenarios
 * (broken template source, corrupt committed event) the isolation case needs.
 */
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { CoreService } from '../src/server/core-service';
import { createForgeCoreServer, type ForgeCoreServer } from '../src/server/http-server';
import { CorePaths } from '../src/server/storage/core-paths';
import {
  ONE_TEMPLATE_ID,
  installValidFixtureTemplate,
  makeEventNode,
  makeEventRoute,
  makeTaskEvent,
} from '../src/server/test-support';

const GATEWAY_MODE_ENV = 'VITE_FORGE_CORE_MODE';

/** Reserves one free loopback port so restarts keep the same origin. */
function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('http-harness: the port probe did not report an address'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

export interface PersistentCoreHarness {
  /** Base URL of the currently running server (stable across restarts). */
  readonly url: string;
  /** Explicit roots shared by every restart; never the committed tree. */
  readonly paths: CorePaths;
  /** The CoreService bound to the currently running server. */
  readonly coreService: CoreService;
  /** Closes the current server, optionally runs work while down, rebuilds. */
  restart(whileStopped?: () => void | Promise<void>): Promise<void>;
  /** Closes the server, restores the environment and removes both roots. */
  close(): Promise<void>;
  /** Creates one task over the API shape and returns its id. */
  createTaskThroughApi(name: string): Promise<string>;
  /** Seeds a confirmed task_started → V1 → review → V2 history (test APIs only). */
  seedConfirmedWorkspaceWithTwoArtifacts(taskId: string): Promise<void>;
  /** Overwrites the fixture template source with unparseable YAML. */
  breakTemplateSource(): void;
  /** Replaces the first committed event file of one task with malformed JSON. */
  corruptFirstCommittedEvent(taskId: string): void;
}

/**
 * Starts the persistent harness: fresh temporary roots, fixture template
 * installed, one development-mode server bound to a fixed port.
 */
export async function startPersistentCoreServer(): Promise<PersistentCoreHarness> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-http-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-core-http-templates-'));
  installValidFixtureTemplate(templateRoot);
  const paths = CorePaths.create({ dataRoot, templateRoot });
  const port = await reserveLoopbackPort();

  const previousMode = process.env[GATEWAY_MODE_ENV];
  // Read by the Vite middleware when it transforms import.meta.env, so the
  // browser served from this origin binds the HttpGateway.
  process.env[GATEWAY_MODE_ENV] = 'http';

  let server: ForgeCoreServer | null = null;
  let service: CoreService | null = null;
  let closed = false;

  async function spawn(): Promise<void> {
    // One fresh CoreService per server: restart must prove the files on disk
    // rebuild the projection, not any in-memory residue.
    service = new CoreService(paths);
    await service.initialize();
    server = await createForgeCoreServer({
      mode: 'development',
      dataRoot,
      templateRoot,
      coreService: service,
    });
    await server.listen(port);
  }

  await spawn();

  return {
    get url(): string {
      return `http://127.0.0.1:${port}`;
    },
    paths,
    get coreService(): CoreService {
      if (service === null) throw new Error('http-harness: the server is not running');
      return service;
    },

    async restart(whileStopped?: () => void | Promise<void>): Promise<void> {
      if (server === null) throw new Error('http-harness: the server is not running');
      await server.close();
      server = null;
      service = null;
      if (whileStopped !== undefined) await whileStopped();
      await spawn();
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (server !== null) {
        await server.close();
        server = null;
        service = null;
      }
      if (previousMode === undefined) delete process.env[GATEWAY_MODE_ENV];
      else process.env[GATEWAY_MODE_ENV] = previousMode;
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(templateRoot, { recursive: true, force: true });
    },

    async createTaskThroughApi(name: string): Promise<string> {
      const created = await this.coreService.createTask({
        templateId: ONE_TEMPLATE_ID,
        name,
        input: {
          'source-material': '通过 API 创建的持久化验收任务素材摘要。',
          'style-note': '保持简洁。',
        },
      });
      return created.id;
    },

    async seedConfirmedWorkspaceWithTwoArtifacts(taskId: string): Promise<void> {
      const current = this.coreService;
      await current.appendTestEvent(taskId, makeTaskEvent({ type: 'task_started' }));
      await current.appendTestEvent(
        taskId,
        makeTaskEvent({
          type: 'agent_input',
          node: makeEventNode({
            sequence: 1,
            agentId: 'writer',
            kind: 'input',
            title: '初稿输入',
            body: '整理任务输入素材，准备生成初稿。',
          }),
        }),
      );
      const writerResult = await current.appendTestEvent(
        taskId,
        makeTaskEvent({
          type: 'agent_result',
          node: makeEventNode({
            sequence: 2,
            agentId: 'writer',
            kind: 'result',
            title: '初稿结果',
            body: '第一版正文草稿。',
            artifactVersion: 1,
          }),
        }),
      );
      await current.publishTestArtifact(taskId, {
        title: '初稿',
        content: '# 初稿（V1）\n\n第一版正文内容。',
        sourceNodeId: writerResult.event.id,
        format: 'markdown',
      });
      const reviewerInput = await current.appendTestEvent(
        taskId,
        makeTaskEvent({
          type: 'agent_input',
          node: makeEventNode({
            sequence: 3,
            agentId: 'reviewer',
            kind: 'input',
            title: '审核输入',
            body: '审核初稿并给出修订意见。',
          }),
        }),
      );
      await current.appendTestEvent(
        taskId,
        makeTaskEvent({
          type: 'route_executed',
          route: makeEventRoute({
            fromNodeId: writerResult.event.id,
            toNodeId: reviewerInput.event.id,
            kind: 'artifact',
            label: '提交初稿',
          }),
        }),
      );
      const reviewerResult = await current.appendTestEvent(
        taskId,
        makeTaskEvent({
          type: 'agent_result',
          node: makeEventNode({
            sequence: 4,
            agentId: 'reviewer',
            kind: 'result',
            title: '审核结果',
            body: '采纳意见后的修订版本。',
            artifactVersion: 2,
          }),
        }),
      );
      await current.publishTestArtifact(taskId, {
        title: '修订稿',
        content: '# 修订稿（V2）\n\n根据审核意见修订后的正文。',
        sourceNodeId: reviewerResult.event.id,
        format: 'markdown',
      });
    },

    breakTemplateSource(): void {
      writeFileSync(
        paths.templateSource(ONE_TEMPLATE_ID) + '/template.yaml',
        'name: [deliberately broken yaml for the Phase B isolation gate\n  - not: valid:::\n',
        'utf8',
      );
    },

    corruptFirstCommittedEvent(taskId: string): void {
      const eventsRoot = paths.taskEventsRoot(taskId);
      const committed = readdirSync(eventsRoot)
        .filter((name) => /^\d{6}-.+\.json$/.test(name))
        .sort();
      if (committed.length === 0) {
        throw new Error(`http-harness: task ${taskId} has no committed events to corrupt`);
      }
      writeFileSync(join(eventsRoot, committed[0] as string), '{ "corrupted": ', 'utf8');
    },
  };
}

/**
 * Walks the formal creation path against the harness origin: template list →
 * detail → new-task form → production page. Returns the created task id
 * (server task ids are plain UUIDs).
 */
export async function createHttpTaskThroughUi(
  page: Page,
  baseUrl: string,
  taskName: string,
): Promise<string> {
  await page.goto(`${baseUrl}/templates`);
  await page.getByRole('link', { name: '双 Agent 协作模板' }).click();
  await page.getByRole('link', { name: '使用此模板创建任务' }).click();
  await page.getByLabel('任务名称').fill(taskName);
  await page.getByLabel('原始素材').fill('用于 HTTP 持久化门禁的素材摘要。');
  await page.getByLabel('风格备注').fill('保持简洁。');
  await page.getByRole('button', { name: '创建任务' }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f]{8}-[0-9a-f-]+$/);
  const taskId = new URL(page.url()).pathname.split('/').pop();
  if (!taskId) throw new Error(`http-harness: 无法从 ${page.url()} 解析任务 id`);
  return taskId;
}
