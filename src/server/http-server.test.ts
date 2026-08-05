// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createForgeCoreServer } from './http-server';
import { disposeAllTestRoots, testServerOptions } from './test-support';

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
});
