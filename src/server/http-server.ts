/**
 * One-process Forge Core server (plan Phase B Task 1).
 *
 * A single Node `http` server owns the JSON API and — depending on mode —
 * either the Vite dev middleware (development) or the built client under
 * `dist/client` (production). Test mode installs API routes only: no Vite,
 * no static files. All errors leave as the public error envelope; request
 * metadata and configured roots never do.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { CoreService } from './core-service';
import { createApiRouter } from './api/router';
import { CorePaths } from './storage/core-paths';

export interface ForgeCoreServerOptions {
  mode: 'development' | 'production' | 'test';
  dataRoot: string;
  templateRoot: string;
  /**
   * Optional injected service (API tests). When omitted the server builds
   * and initializes its own CoreService over the configured roots.
   */
  coreService?: CoreService;
}

export interface ForgeCoreServer {
  /** Binds `127.0.0.1` on the given port (0 = ephemeral) and resolves the base URL. */
  listen(port: number): Promise<string>;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';

const NOT_FOUND_MESSAGE = 'forge-core: no resource at this path';

/**
 * the project root — located by walking up from this module until the
 * workspace package root (the directory owning package.json + index.html).
 * Works identically from `src/server/*.ts` (tsx dev, two levels below) and
 * from `dist/server/server/*.js` (compiled artifact, three levels below),
 * so production static roots resolve the same way regardless of how the
 * server was started. Resolved lazily: only development/production modes
 * touch it, so test-mode consumers (and non-file module URL schemes) never
 * evaluate it.
 */
let cachedAppRoot: string | null = null;

function findAppRoot(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'index.html'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return startDir;
}

function appRoot(): string {
  if (cachedAppRoot === null) {
    cachedAppRoot = findAppRoot(dirname(fileURLToPath(new URL(import.meta.url))));
  }
  return cachedAppRoot;
}

function clientDist(): string {
  return resolve(appRoot(), 'dist', 'client');
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendPublicError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify({ error: { code, message, location: null, action: null } });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** Resolves a request path inside the client dist, or null when it escapes. */
function resolveClientFile(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) {
    return null;
  }
  const dist = clientDist();
  const candidate = resolve(dist, `.${decoded}`);
  if (candidate !== dist && !candidate.startsWith(dist + sep)) {
    return null;
  }
  return candidate;
}

function streamFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    sendPublicError(res, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    return;
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => {
    stream.destroy();
    if (!res.headersSent) {
      sendPublicError(res, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function serveClientFile(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendPublicError(res, 405, 'METHOD_NOT_ALLOWED', 'forge-core: static files accept GET only', {
      Allow: 'GET, HEAD',
    });
    return;
  }
  const candidate = resolveClientFile(pathname);
  if (candidate !== null && existsSync(candidate) && statSync(candidate).isFile()) {
    streamFile(req, res, candidate);
    return;
  }
  // Extension-less paths fall back to the SPA entry; the client owns routing.
  if (!basename(pathname).includes('.')) {
    const indexFile = resolve(clientDist(), 'index.html');
    if (existsSync(indexFile)) {
      streamFile(req, res, indexFile);
      return;
    }
  }
  sendPublicError(res, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
}

export async function createForgeCoreServer(
  options: ForgeCoreServerOptions,
): Promise<ForgeCoreServer> {
  if (!options.dataRoot || !options.templateRoot) {
    throw new Error('forge-core: createForgeCoreServer requires explicit dataRoot and templateRoot');
  }
  mkdirSync(options.dataRoot, { recursive: true });

  // One CoreService per server: injected by API tests, otherwise built and
  // initialized over the configured roots before the first request lands.
  let service = options.coreService;
  if (service === undefined) {
    const paths = CorePaths.create({
      dataRoot: options.dataRoot,
      templateRoot: options.templateRoot,
    });
    service = new CoreService(paths);
    await service.initialize();
  }
  // Startup recovery (plan Task 5 Step 6, spec §7.2): before any start
  // request can be accepted, every active task left without a terminal event
  // by an abnormal exit becomes `interrupted`; the user resumes explicitly.
  await service.scheduler.recoverInterruptedTasks();
  const apiRouter = createApiRouter(service);

  let vite: ViteDevServer | null = null;

  // One Node server owns the JSON API, the client files AND — in development
  // mode — the Vite HMR websocket. Vite must attach its `upgrade` handling to
  // this exact server (`hmr.server`): without it every Vite instance
  // self-binds the shared default HMR port (24678), so any instance after the
  // first loses its ws channel and the browser client falls into an endless
  // "server connection lost -> reload" loop (observed in the Phase B browser
  // gate; the reload storm also wipes page state mid-test).
  const httpServer = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', `http://${HOST}`).pathname;
    } catch {
      sendPublicError(res, 400, 'BAD_REQUEST', 'forge-core: the request URL is invalid');
      return;
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      apiRouter.handle(req, res, pathname);
      return;
    }
    if (options.mode === 'development' && vite !== null) {
      vite.middlewares(req, res, () => {
        sendPublicError(res, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
      });
      return;
    }
    if (options.mode === 'production') {
      serveClientFile(req, res, pathname);
      return;
    }
    // Test mode deliberately serves no client files; the API stays mounted.
    sendPublicError(res, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
  });

  if (options.mode === 'development') {
    // Lazy import: only development mode pays for Vite, so test/API consumers
    // never load the dev-server dependency chain.
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      root: appRoot(),
      configFile: resolve(appRoot(), 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: 'spa',
    });
  }

  return {
    listen(port: number): Promise<string> {
      return new Promise((resolveListen, rejectListen) => {
        const onError = (error: Error): void => {
          rejectListen(error);
        };
        httpServer.once('error', onError);
        httpServer.listen(port, HOST, () => {
          httpServer.off('error', onError);
          const address = httpServer.address();
          if (address === null || typeof address === 'string') {
            rejectListen(new Error('forge-core: the server did not report a bound address'));
            return;
          }
          resolveListen(`http://${HOST}:${address.port}`);
        });
      });
    },
    async close(): Promise<void> {
      // Scheduler first: abort the active Turn, wait bounded disposal and
      // append task_interrupted when no terminal event exists — before the
      // HTTP surface goes away (plan Phase C Task 4 Step 5).
      await service.shutdown();
      // Vite next: its HMR websocket clients hold upgraded sockets attached
      // to this http server (hmr.server), and httpServer.close() would wait
      // on them forever; vite.close() terminates those clients.
      if (vite !== null) {
        await vite.close();
        vite = null;
      }
      httpServer.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        httpServer.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
