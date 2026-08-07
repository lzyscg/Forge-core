/**
 * Temporary-root helpers shared by server tests (plan Task 1 Step 1).
 *
 * Deliberately imports nothing from vitest: each test file wires
 * `disposeAllTestRoots` into its own `afterEach`, so this module stays usable
 * from non-vitest harnesses later (plan Tasks 5/6 Playwright fixtures).
 *
 * Phase B Task 3 adds template/task fixture helpers so storage tests build on
 * the exact Task 2 `valid` fixture instead of duplicating template content.
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreService } from './core-service';
import type { ForgeCoreServerOptions } from './http-server';
import { createForgeCoreServer } from './http-server';
import { FakeAgentRuntime } from './runtime/fake-agent-runtime';
import { CorePaths } from './storage/core-paths';
// Type-only so this module stays loadable before Task 3 storage modules exist.
import type { CreateTaskRequest } from './storage/task-store';
// Type-only for red-phase purity (Task 3 precedent): the canonical event
// builders below need no runtime import from the Task 4 event union.
import type { EventNode, EventRoute, TaskEvent } from './storage/task-events';
import { TemplateCatalog } from './template/template-catalog';
import { loadTemplateDirectory } from './template/template-loader';

const createdRoots: string[] = [];

/** Creates fresh temporary data/template roots and returns `mode: 'test'` options. */
export function testServerOptions(): ForgeCoreServerOptions {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-core-template-'));
  createdRoots.push(dataRoot, templateRoot);
  return { mode: 'test', dataRoot, templateRoot };
}

/** Creates fresh temporary data/template roots and derives explicit CorePaths. */
export function makeTempCorePaths(prefix = 'forge-core-store-'): {
  paths: CorePaths;
  dataRoot: string;
  templateRoot: string;
} {
  const dataRoot = mkdtempSync(join(tmpdir(), `${prefix}data-`));
  const templateRoot = mkdtempSync(join(tmpdir(), `${prefix}templates-`));
  createdRoots.push(dataRoot, templateRoot);
  return { paths: CorePaths.create({ dataRoot, templateRoot }), dataRoot, templateRoot };
}

/** Template id used when the Task 2 `valid` fixture is installed as the only source. */
export const ONE_TEMPLATE_ID = 'test-template';

/**
 * Locates the `valid` template fixture. Node-environment tests resolve it
 * from this module's URL; browser-like environments (jsdom) expose non-file
 * module URLs, so they fall back to the workspace-relative location (tests
 * always run from the workspace root).
 */
function validFixtureDir(): string {
  try {
    return fileURLToPath(new URL('template/__fixtures__/valid', import.meta.url));
  } catch {
    return resolve(process.cwd(), 'src', 'server', 'template', '__fixtures__', 'valid');
  }
}

/**
 * Version-2 turn contract blocks injected into copies of the legacy `valid`
 * fixture (plan 2026-08-04 Task 3; upgraded to v2 in Phase 7). The committed
 * fixture directories stay legacy (no `turnContract`) so the incompatibility
 * gate has historical snapshots; every EXECUTABLE test template receives
 * these contracts.
 */
const FIXTURE_WRITER_CONTRACT_YAML = [
  'turnContract:',
  '  version: 2',
  '  production:',
  '    files: [content.md]',
  '    sources: [inline, workspace_file]',
  '    formats: [markdown]',
  '  dispatch:',
  '    allowedActions: [publish_artifact]',
  '    targets:',
  '      publish_artifact: reviewer',
  '',
].join('\n');

const FIXTURE_REVIEWER_CONTRACT_YAML = [
  'turnContract:',
  '  version: 2',
  '  annotate:',
  '    files: [review.md]',
  '  dispatch:',
  '    allowedActions: [send_message, submit_final_artifact]',
  '    targets:',
  '      send_message: writer',
  '',
].join('\n');

/** Appends the current turn contracts to every agent file of a copied fixture. */
export function upgradeFixtureContracts(templateDir: string): void {
  const contracts: Record<string, string> = {
    writer: FIXTURE_WRITER_CONTRACT_YAML,
    reviewer: FIXTURE_REVIEWER_CONTRACT_YAML,
  };
  for (const [agentId, contract] of Object.entries(contracts)) {
    const file = join(templateDir, 'agents', `${agentId}.yaml`);
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trimEnd()}\n${contract}`,
      'utf8',
    );
  }
}

/**
 * Copies the Task 2 `valid` fixture into a template root as ONE_TEMPLATE_ID.
 * By default the copy is upgraded to the current turn contract (executable
 * test template); `{ legacy: true }` keeps the historical contract-less
 * shape for the incompatibility gate (plan 2026-08-04 Task 3).
 */
export function installValidFixtureTemplate(
  templateRoot: string,
  options: { legacy?: boolean } = {},
): void {
  const dest = join(templateRoot, ONE_TEMPLATE_ID);
  cpSync(validFixtureDir(), dest, { recursive: true });
  if (!options.legacy) {
    upgradeFixtureContracts(dest);
  }
}

/**
 * Downgrades one frozen task snapshot to the historical contract-less shape
 * (plan 2026-08-04 Task 3 gate tests): strips every `turnContract` block
 * from the snapshot agent files and rewrites `task.json.templateVersion` to
 * the hash the historical loader derives for the stripped snapshot — exactly
 * the on-disk shape of a task frozen before the turn contract existed.
 * The snapshot is never modified through the platform API (spec §7.3: frozen
 * snapshots are immutable in production); this is test-only fixture surgery.
 */
export async function downgradeTaskSnapshotToLegacy(paths: CorePaths, taskId: string): Promise<void> {
  const snapshotRoot = paths.taskSnapshotRoot(taskId);
  const agentsRoot = join(snapshotRoot, 'agents');
  for (const name of readdirSync(agentsRoot)) {
    if (!name.endsWith('.yaml')) {
      continue;
    }
    const file = join(agentsRoot, name);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').replace(/\nturnContract:[\s\S]*$/, ''),
      'utf8',
    );
  }
  const historical = await loadTemplateDirectory(snapshotRoot, { historicalSnapshot: true });
  const taskFile = paths.taskFile(taskId);
  const record = JSON.parse(readFileSync(taskFile, 'utf8')) as Record<string, unknown>;
  record.templateVersion = historical.versionHash;
  writeFileSync(taskFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * Copies the Task 2 `valid` fixture into a fresh temporary template root,
 * initializes a catalog over it and fails loud unless the template is valid
 * and cached. Returns everything storage tests need to freeze a task.
 */
export async function catalogWithOneTemplate(): Promise<{
  paths: CorePaths;
  catalog: TemplateCatalog;
  templateId: string;
}> {
  const { paths, templateRoot } = makeTempCorePaths();
  installValidFixtureTemplate(templateRoot);
  const catalog = new TemplateCatalog(paths);
  await catalog.initialize();
  const detail = catalog.get(ONE_TEMPLATE_ID);
  if (!detail || detail.status !== 'valid') {
    throw new Error('test-support: the one-template fixture did not initialize as valid');
  }
  return { paths, catalog, templateId: ONE_TEMPLATE_ID };
}

/**
 * A task creation request containing exactly the fields declared by the
 * `valid` fixture (`source-material` required, `style-note` optional).
 * Business content lives only here and in fixtures, never in platform code.
 */
export function validTaskRequest(templateId: string = ONE_TEMPLATE_ID): CreateTaskRequest {
  return {
    templateId,
    name: '冻结任务',
    input: {
      'source-material': '一段用于任务冻结测试的素材摘要。',
      'style-note': '保持简洁。',
    },
  };
}

/**
 * The section directory declared on the fixture writer's style-guide skill
 * (plan 2026-08-07 Phase 1). Business vocabulary is confined to fixture data.
 */
export const SECTIONS_TEMPLATE_SECTION_DIR = 'skills/style-guide/references';

/** Section `.md` files written under the fixture section directory. */
export const SECTIONS_TEMPLATE_SECTION_FILES = [
  'skills/style-guide/references/01.md',
  'skills/style-guide/references/sub/02.md',
] as const;

/**
 * Installs the `valid` fixture (contract-upgraded), declares
 * `sectionsPath: skills/style-guide/references` on the writer's style-guide
 * skill and writes two section `.md` files (one nested) under that directory.
 * Returns everything storage tests need to freeze a task whose snapshot
 * carries authorized skill sections.
 */
export async function catalogWithSectionsTemplate(): Promise<{
  paths: CorePaths;
  catalog: TemplateCatalog;
  templateId: string;
}> {
  const { paths, templateRoot } = makeTempCorePaths();
  installValidFixtureTemplate(templateRoot);
  const templateDir = join(templateRoot, ONE_TEMPLATE_ID);
  const writerFile = join(templateDir, 'agents', 'writer.yaml');
  const writerYaml = readFileSync(writerFile, 'utf8').replace(/\r\n?/g, '\n');
  writeFileSync(
    writerFile,
    writerYaml.replace(
      '    contentPath: skills/style-guide/SKILL.md\n',
      `    contentPath: skills/style-guide/SKILL.md\n    sectionsPath: ${SECTIONS_TEMPLATE_SECTION_DIR}\n`,
    ),
    'utf8',
  );
  for (const sectionFile of SECTIONS_TEMPLATE_SECTION_FILES) {
    mkdirSync(join(templateDir, sectionFile, '..'), { recursive: true });
    writeFileSync(join(templateDir, sectionFile), `# ${sectionFile}\n`, 'utf8');
  }
  const catalog = new TemplateCatalog(paths);
  await catalog.initialize();
  const detail = catalog.get(ONE_TEMPLATE_ID);
  if (!detail || detail.status !== 'valid') {
    throw new Error('test-support: the sections template did not initialize as valid');
  }
  return { paths, catalog, templateId: ONE_TEMPLATE_ID };
}

/** Removes every temporary root created by the helpers above in this process. */
export function disposeAllTestRoots(): void {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

/* Phase B Task 4: canonical event payload builders (plan Task 4 decision 1).
 * Node/route identity in the projection derives from the creating event id,
 * so tests build payloads without ids and pin event ids via makeTaskEvent. */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Fills event `id` (uuid) and `at` (ISO) unless the caller pins them. */
export function makeTaskEvent(
  event: DistributiveOmit<TaskEvent, 'id' | 'at'> & { id?: string; at?: string },
): TaskEvent {
  const { id, at, ...rest } = event;
  return {
    ...rest,
    id: id ?? randomUUID(),
    at: at ?? new Date().toISOString(),
  } as TaskEvent;
}

/** A schema-shaped node payload; tests override the fields they assert on. */
export function makeEventNode(overrides: Partial<EventNode> = {}): EventNode {
  return {
    sequence: 1,
    agentId: 'agent-alpha',
    kind: 'input',
    title: '输入节点',
    body: '输入正文',
    status: 'confirmed',
    attemptCount: 1,
    inputVersion: null,
    ...overrides,
  };
}

/** A schema-shaped route payload; tests override the node references. */
export function makeEventRoute(overrides: Partial<EventRoute> = {}): EventRoute {
  return {
    sequence: 1,
    fromNodeId: 'from-node',
    toNodeId: 'to-node',
    kind: 'message',
    label: '路由',
    ...overrides,
  };
}

/* Phase B Task 5: JSON API + HttpGateway fixtures (plan Task 5 Step 1).
 * Each fixture owns fresh temporary roots and a real test-mode server over
 * the one-template fixture, so integration tests and the shared Gateway
 * contract suite exercise the exact production route table. */

export interface ApiRequestOptions {
  /** Serialized as JSON (mutually exclusive with `raw`). */
  json?: unknown;
  /** Sent verbatim; lets tests probe malformed or oversized bodies. */
  raw?: string;
  headers?: Record<string, string>;
}

export interface ApiTestResponse {
  status: number;
  headers: Headers;
  text: string;
  /** JSON-parsed body when parseable, otherwise null. */
  body: unknown;
}

export interface ApiTestClient {
  baseUrl: string;
  dataRoot: string;
  service: CoreService;
  request(method: string, path: string, options?: ApiRequestOptions): Promise<ApiTestResponse>;
  get(path: string, options?: { headers?: Record<string, string> }): Promise<ApiTestResponse>;
  post(
    path: string,
    json?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<ApiTestResponse>;
  close(): Promise<void>;
}

export interface ApiTestClientOptions {
  /** Wraps the freshly initialized service before the server binds to it. */
  decorateService?: (service: CoreService) => CoreService;
  /**
   * Injected runtime (defaults to an unscripted deterministic fake). Tests
   * that drive the loop to a specific rest state script their own fake.
   */
  runtime?: FakeAgentRuntime;
}

/**
 * Boots one real test-mode server over fresh temporary roots with the valid
 * fixture template installed and returns a small fetch wrapper. Roots are
 * registered for `disposeAllTestRoots`; callers additionally `close()` the
 * server when done.
 */
export async function startApiTestClient(
  options: ApiTestClientOptions = {},
): Promise<ApiTestClient> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-api-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-core-api-templates-'));
  createdRoots.push(dataRoot, templateRoot);
  installValidFixtureTemplate(templateRoot);

  // Tests inject the deterministic fake runtime: lifecycle routes drive the
  // real scheduler, but no test ever touches a real Provider (plan Task 4).
  // The default scripts run one legal contract turn per fixture agent, and
  // the service installs the acceptance boundary seam, so the loop rests at
  // a committed boundary with the task projected `running` — the exact rest
  // shape the shared Gateway lifecycle contract probes (plan 2026-08-04: the
  // turn contract removed the old empty-action `running` rest state). Tests
  // that need other behaviors inject their own runtime.
  let service = new CoreService(CorePaths.create({ dataRoot, templateRoot }), {
    runtime:
      options.runtime ??
      new FakeAgentRuntime({
        scripts: {
          writer: [
            {
              kind: 'result',
              publicText: '契约套件初稿完成。',
              actions: [
                {
                  type: 'finish_production',
                  source: 'inline',
                  files: [{ name: 'content.md', content: '契约套件初稿正文' }],
                  format: 'markdown',
                  artifactType: '终稿',
                  title: '契约套件初稿',
                },
                { type: 'publish_artifact' },
              ],
            },
          ],
          reviewer: [
            {
              kind: 'result',
              publicText: '契约套件返修意见。',
              actions: [
                {
                  type: 'send_message',
                  targetAgentId: 'writer',
                  summary: '契约套件返修意见',
                },
              ],
            },
          ],
        },
      }),
    acceptanceStopAfterCommit: () => true,
  });
  await service.initialize();
  if (options.decorateService) {
    service = options.decorateService(service);
  }
  const server = await createForgeCoreServer({
    mode: 'test',
    dataRoot,
    templateRoot,
    coreService: service,
  });
  const baseUrl = await server.listen(0);

  async function request(
    method: string,
    path: string,
    requestOptions: ApiRequestOptions = {},
  ): Promise<ApiTestResponse> {
    const headers: Record<string, string> = { ...requestOptions.headers };
    let body: string | undefined;
    if (requestOptions.raw !== undefined) {
      body = requestOptions.raw;
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    } else if (requestOptions.json !== undefined) {
      body = JSON.stringify(requestOptions.json);
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: response.headers, text, body: parsed };
  }

  return {
    baseUrl,
    dataRoot,
    service,
    request,
    get: (path, requestOptions = {}) => request('GET', path, requestOptions),
    post: (path, json, requestOptions = {}) => request('POST', path, { ...requestOptions, json }),
    close: () => server.close(),
  };
}

export interface HttpGatewayServerFixture {
  baseUrl: string;
  service: CoreService;
  close(): Promise<void>;
}

/**
 * Server half of the HttpGateway contract fixture (plan Task 5 Step 1). The
 * client test constructs the HttpGateway itself against `baseUrl`: server
 * modules never import client code (one-way dependency, iron rule 5), so
 * `startHttpGatewayFixture` here deliberately stops at the server boundary.
 * Seeding flows through the test-only CoreService APIs only.
 */
export async function startHttpGatewayFixture(): Promise<HttpGatewayServerFixture> {
  const client = await startApiTestClient();
  return {
    baseUrl: client.baseUrl,
    service: client.service,
    close: client.close,
  };
}
