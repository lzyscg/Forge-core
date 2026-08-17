// @vitest-environment node
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createForgeCoreServer } from './http-server';
import { disposeAllTestRoots, makeTempCorePaths, testServerOptions } from './test-support';
import { CoreService } from './core-service';
import { TEMPLATE_ERROR_CODES } from './template/template-schema';

afterEach(() => {
  disposeAllTestRoots();
});

describe('ForgeCoreServer', () => {
  it('serves health from the same process that owns the client', async () => {
    const server = await createForgeCoreServer(testServerOptions());
    const baseUrl = await server.listen(0);
    expect(await (await fetch(`${baseUrl}/api/health`)).json()).toEqual({
      ok: true,
      service: 'forge-core',
      mode: 'http',
    });
    await server.close();
  });

  it('binds the IPv4 loopback and reports the actual port', async () => {
    const server = await createForgeCoreServer(testServerOptions());
    const baseUrl = await server.listen(0);
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await server.close();
  });

  it('answers unknown api routes with a public NOT_FOUND error', async () => {
    const server = await createForgeCoreServer(testServerOptions());
    const baseUrl = await server.listen(0);
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: expect.any(String),
        location: null,
        action: null,
      },
    });
    await server.close();
  });

  it('rejects non-GET health requests with 405 and an Allow header', async () => {
    const server = await createForgeCoreServer(testServerOptions());
    const baseUrl = await server.listen(0);
    const response = await fetch(`${baseUrl}/api/health`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    await server.close();
  });

  it('serves no client files at all in test mode', async () => {
    const server = await createForgeCoreServer(testServerOptions());
    const baseUrl = await server.listen(0);
    expect((await fetch(`${baseUrl}/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/index.html`)).status).toBe(404);
    await server.close();
  });

  it('stops accepting requests after close', async () => {
    const server = await createForgeCoreServer(testServerOptions());
    const baseUrl = await server.listen(0);
    await server.close();
    await expect(fetch(`${baseUrl}/api/health`)).rejects.toThrow();
  });

  it('boots with an explicitly disabled authoritative production capability and gates v2 templates (Task 5 regression)', async () => {
    const { paths, templateRoot } = makeTempCorePaths('forge-core-http-auth-');
    cpSync(
      fileURLToPath(new URL('template/__fixtures__/authoritative-valid', import.meta.url)),
      join(templateRoot, 'authoritative-valid'),
      { recursive: true },
    );
    // Write a synthetic disabled capability file so the production loader
    // rejects the v2 source (the checked-in capability is enabled after
    // Task 28 promotion).
    const disabledCapabilityPath = join(paths.dataRoot, 'disabled-capability-v1.json');
    writeFileSync(
      disabledCapabilityPath,
      `${JSON.stringify({
        version: 1,
        status: 'disabled',
        profileIdentity: null,
        profileDigest: null,
        evidenceDigest: null,
        requiredAbis: ['forge-validator/v2', 'forge-assembler/v2'],
      }, null, 2)}\n`,
      'utf8',
    );
    const { createProductionAuthoritativeReviewEnvironment } = await import(
      './structured-slots/authoritative-review-capability'
    );
    const disabledEnv = createProductionAuthoritativeReviewEnvironment(disabledCapabilityPath);
    const coreService = new CoreService(paths, { authoritativeReviewEnvironment: disabledEnv });
    await coreService.initialize();
    const server = await createForgeCoreServer({
      mode: 'test',
      dataRoot: paths.dataRoot,
      templateRoot,
      coreService,
    });
    const baseUrl = await server.listen(0);
    try {
      expect(await (await fetch(`${baseUrl}/api/health`)).json()).toEqual({
        ok: true,
        service: 'forge-core',
        mode: 'http',
      });
      const templates = await (await fetch(`${baseUrl}/api/templates`)).json();
      expect(templates).toEqual([]);
      expect(coreService.templates.getDiagnostic('authoritative-valid')?.code).toBe(
        TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE,
      );
    } finally {
      await server.close();
    }
  });
});
