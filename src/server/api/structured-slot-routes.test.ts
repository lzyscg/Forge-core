// @vitest-environment node
/**
 * Read-only structured slot REST route tests (Task 18, spec §14).
 *
 * Every endpoint executes as the built-in `task_owner` subject — the owner
 * sees every formal slot/spec/content of the active scaffold, independent of
 * template AccessProfiles, but never private Proposal/Draft/Grant or
 * implementation resources. The contract projection carries NO implementation
 * paths, accessProfiles or resource manifest. Cursor-invalid maps to a stable
 * public 409; SLOT_NOT_VISIBLE is the identical stable envelope for a missing
 * slot. Any attempt to inject a profile/principal through query parameters is
 * rejected in v1.
 */
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { SealRecord, SlotInstance, StructuredBlobRefV1 } from '../../shared/structured-slots';
import { CoreService } from '../core-service';
import { FakeAgentRuntime } from '../runtime/fake-agent-runtime';
import { createForgeCoreServer } from '../http-server';
import { CorePaths } from '../storage/core-paths';
import { StructuredSlotBlobStore } from '../storage/structured-slot-blob-store';
import { createTestRuntimeEnvironment } from '../structured-slots/runtime-capability';
import { makeTaskEvent, installValidFixtureTemplate, ONE_TEMPLATE_ID, testServerOptions } from '../test-support';
import type { ApiTestClient } from '../test-support';

/** Locates the structured-valid template fixture (node + jsdom fallback). */
function structuredFixtureDir(): string {
  try {
    return fileURLToPath(
      new URL('../template/__fixtures__/structured-valid', import.meta.url),
    );
  } catch {
    return join(process.cwd(), 'src', 'server', 'template', '__fixtures__', 'structured-valid');
  }
}

function blobRef(kind: StructuredBlobRefV1['kind'], seed: string): StructuredBlobRefV1 {
  return { version: 1, kind, sha256: seed.repeat(64), byteLength: 4 };
}

/** Boots one real test server over the structured-valid fixture with the enabled env. */
async function startStructuredApiClient(): Promise<ApiTestClient> {
  const { dataRoot, templateRoot } = testServerOptions();
  // Both fixtures: the basic `valid` template (for STRUCTURED_NOT_ACTIVE) and
  // the structured-valid template (for the owner projection).
  installValidFixtureTemplate(templateRoot);
  cpSync(structuredFixtureDir(), join(templateRoot, 'structured-valid'), { recursive: true });
  const service = new CoreService(CorePaths.create({ dataRoot, templateRoot }), {
    runtimeEnvironment: createTestRuntimeEnvironment(),
    runtime: new FakeAgentRuntime(),
  });
  await service.initialize();
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
    options: { json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; headers: Headers; text: string; body: unknown }> {
    const headers: Record<string, string> = { ...options.headers };
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
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
    get: (path, options = {}) => request('GET', path, options),
    post: (path, json, options = {}) => request('POST', path, { ...options, json }),
    close: () => server.close(),
  };
}

/** Creates a structured task and seeds one committed generation with content. */
async function seedStructuredTask(
  client: ApiTestClient,
  overrides: { slotCount?: number; slotIds?: string[] } = {},
): Promise<{ taskId: string; blobStore: StructuredSlotBlobStore }> {
  const created = await client.service.createTask({
    templateId: 'structured-valid',
    name: 'Structured API Task',
    input: { 'source-text': 'neutral structured source' },
  });
  const taskId = created.id;
  const blobStore = new StructuredSlotBlobStore(client.service.paths, taskId);
  const slotIds = overrides.slotIds ?? ['root', 'title', 'body', 'note'];
  const slots: SlotInstance[] = slotIds.map((slotId, index) => ({
    slotId,
    scaffoldId: 'scaffold-1',
    parentSlotId: slotId === 'root' ? null : 'root',
    order: index,
    typeId: slotId === 'root' ? 'document' : slotId === 'title' ? 'title' : 'body',
    spec: {},
    contentPresence: slotId === 'root' || slotId === 'note' ? 'unset' : 'set',
    ...(slotId === 'title' ? { content: 'The Title' } : {}),
    ...(slotId === 'body' ? { content: 'The body text' } : {}),
  }));
  const manifest = await blobStore.putGeneration({ generationId: 'gen-1', scaffoldId: 'scaffold-1', slots });
  const title = await blobStore.putContentValue('The Title');
  const body = await blobStore.putContentValue('The body text');
  const contentRef = await blobStore.putContentRevision({
    title: title.sha256,
    body: body.sha256,
  });
  await client.service.appendTestEvent(
    taskId,
    makeTaskEvent({
      type: 'structured_scaffold_generation_committed',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      supersedesGenerationId: null,
      rootSlotId: 'root',
      slotCount: overrides.slotCount ?? slotIds.length,
      maxDepth: 2,
      structure: manifest.structure,
      content: contentRef,
      contentRevision: 0,
      proposalId: 'prop-1',
    }),
  );
  return { taskId, blobStore };
}

/** Merges one fill draft that advances the content revision to 1. */
async function seedMergedRevision(client: ApiTestClient, taskId: string): Promise<void> {
  const blobStore = new StructuredSlotBlobStore(client.service.paths, taskId);
  const title = await blobStore.putContentValue('The Title v2');
  const contentRef = await blobStore.putContentRevision({ title: title.sha256 });
  await client.service.appendTestEvent(
    taskId,
    makeTaskEvent({
      type: 'structured_fill_draft_opened',
      draftId: 'draft-1',
      turnId: 'turn-1',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      baseRevision: 0,
    }),
  );
  await client.service.appendTestEvent(
    taskId,
    makeTaskEvent({
      type: 'structured_fill_draft_terminal',
      draftId: 'draft-1',
      turnId: 'turn-1',
      status: 'merged',
      baseRevision: 0,
      resultRevision: 1,
      changeCount: 1,
      content: contentRef,
    }),
  );
}

/** Seeds a stale draft terminal (the one owner-visible issue in v1). */
async function seedStaleDraft(client: ApiTestClient, taskId: string): Promise<void> {
  await client.service.appendTestEvent(
    taskId,
    makeTaskEvent({
      type: 'structured_fill_draft_terminal',
      draftId: 'draft-stale',
      turnId: 'turn-stale',
      status: 'stale',
      baseRevision: 0,
      resultRevision: 0,
      changeCount: 0,
      content: null,
    }),
  );
}

/** Seeds a full seal: seal record blob + the sealed event. */
async function seedSeal(client: ApiTestClient, taskId: string): Promise<void> {
  const blobStore = new StructuredSlotBlobStore(client.service.paths, taskId);
  const sealRecord: SealRecord = {
    sealId: 'seal-1',
    caseId: taskId,
    scaffoldId: 'scaffold-1',
    scaffoldRevision: 1,
    scaffoldTreeHash: 'a'.repeat(64),
    templateId: 'structured-valid',
    templateVersion: 'v1',
    snapshotHash: 'b'.repeat(64),
    assemblerId: 'render',
    assemblerVersion: 'v1',
    artifactVersionRef: { artifactId: 'artifact-1', version: 1 },
    outputs: [
      { routeId: 'document-md', path: 'document.md', mediaType: 'text/markdown; charset=utf-8', byteLength: 120, sha256: 'c'.repeat(64) },
    ],
    sealedAt: '2026-08-05T00:00:00.000Z',
  };
  const sealRef = await blobStore.putJsonBlob(sealRecord, 'seal_record');
  await client.service.appendTestEvent(
    taskId,
    makeTaskEvent({
      type: 'structured_scaffold_sealed',
      sealId: 'seal-1',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      scaffoldRevision: 1,
      sealRecord: sealRef,
      artifactId: 'artifact-1',
      artifactVersion: 1,
    }),
  );
}

describe('structured-slot read-only routes (spec §14, task_owner subject)', () => {
  let client: ApiTestClient;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
  });

  it('exposes the public contract projection without implementation paths or ACL', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);

    const response = await client.get(`/api/tasks/${taskId}/structured-slots/contract`);
    expect(response.status).toBe(200);
    const contract = response.body as {
      version: number;
      slotTypes: Array<{ id: string; specSchema: unknown; content: unknown }>;
      layoutGrammar: { rootType: string };
      semanticDigest: string;
    };
    expect(contract.version).toBe(1);
    expect(contract.slotTypes.map((slot) => slot.id)).toEqual(['document', 'title', 'body']);
    expect(contract.layoutGrammar.rootType).toBe('document');
    expect(typeof contract.semanticDigest).toBe('string');
    // Implementation paths / ACL / host paths never leak into the projection
    // (the ABI identity strings validatorAbi/assemblerAbi are public, but the
    // validator/assembler REGISTRATIONS and their resource paths are not).
    expect(JSON.stringify(response.body)).not.toContain('validators');
    expect(JSON.stringify(response.body)).not.toContain('accessProfiles');
    expect(JSON.stringify(response.body)).not.toContain('resourceManifest');
    expect(JSON.stringify(response.body)).not.toContain('slots/validators');
    expect(JSON.stringify(response.body)).not.toContain('slots/assembler');
    expect(JSON.stringify(response.body)).not.toContain('implementation');
  });

  it('pages the owner outline in document order and reports no totals', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);

    const page1 = await client.get(`/api/tasks/${taskId}/structured-slots/tree?limit=2`);
    expect(page1.status).toBe(200);
    const body1 = page1.body as {
      entries: Array<{ slotId: string; level: string; shell: boolean; spec?: unknown }>;
      nextCursor: unknown;
    };
    expect(body1.entries.map((entry) => entry.slotId)).toEqual(['root', 'title']);
    // Owner level is content and spec is present on every visible entry.
    for (const entry of body1.entries) {
      expect(entry.level).toBe('content');
      expect(entry.spec).toBeDefined();
    }
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await client.get(
      `/api/tasks/${taskId}/structured-slots/tree?limit=2&cursor=${encodeURIComponent(JSON.stringify(body1.nextCursor))}`,
    );
    expect(page2.status).toBe(200);
    const body2 = page2.body as { entries: Array<{ slotId: string }>; nextCursor: unknown };
    expect(body2.entries.map((entry) => entry.slotId)).toEqual(['body', 'note']);
    expect(body2.nextCursor).toBeNull();
  });

  it('reads one slot detail with spec/content and its ancestor shell', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);

    const response = await client.get(`/api/tasks/${taskId}/structured-slots/slots/title`);
    expect(response.status).toBe(200);
    const read = response.body as {
      slot: { slotId: string; typeId: string; contentPresence: string; level: string; spec: unknown; content: unknown; ancestors: Array<{ slotId: string }> };
    };
    expect(read.slot.slotId).toBe('title');
    expect(read.slot.typeId).toBe('title');
    expect(read.slot.contentPresence).toBe('set');
    expect(read.slot.level).toBe('content');
    expect(read.slot.content).toBe('The Title');
    expect(read.slot.spec).toBeDefined();
    expect(read.slot.ancestors.map((ancestor) => ancestor.slotId)).toEqual(['root']);
  });

  it('returns the identical SLOT_NOT_VISIBLE envelope for a missing slot', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);

    const response = await client.get(`/api/tasks/${taskId}/structured-slots/slots/no-such-slot`);
    expect(response.status).toBe(404);
    const envelope = response.body as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('SLOT_NOT_VISIBLE');
    expect(JSON.stringify(envelope.error)).not.toContain('no-such-slot');
  });

  it('rejects a cursor bound to a stale generation/revision with a stable 409', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);

    const page1 = await client.get(`/api/tasks/${taskId}/structured-slots/tree?limit=2`);
    const cursor = (page1.body as { nextCursor: unknown }).nextCursor as Record<string, unknown>;

    // A committed merge advances the content revision: the old cursor is stale.
    await seedMergedRevision(client, taskId);

    const stale = await client.get(
      `/api/tasks/${taskId}/structured-slots/tree?limit=2&cursor=${encodeURIComponent(JSON.stringify(cursor))}`,
    );
    expect(stale.status).toBe(409);
    expect((stale.body as { error: { code: string } }).error.code).toBe('CURSOR_INVALID');
  });

  it('lists owner-visible issues (stale drafts) and rejects a malformed cursor', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);
    await seedStaleDraft(client, taskId);

    const response = await client.get(`/api/tasks/${taskId}/structured-slots/issues?limit=10`);
    expect(response.status).toBe(200);
    const body = response.body as { issues: Array<{ code: string; severity: string }>; nextCursor: unknown };
    expect(body.issues.map((issue) => issue.code)).toEqual(['DRAFT_STALE']);
    expect(body.issues[0]?.severity).toBe('error');
    expect(body.nextCursor).toBeNull();

    const malformed = await client.get(
      `/api/tasks/${taskId}/structured-slots/issues?limit=10&cursor=${encodeURIComponent('{"garbage":true}')}`,
    );
    expect(malformed.status).toBe(409);
    expect((malformed.body as { error: { code: string } }).error.code).toBe('CURSOR_INVALID');
  });

  it('returns the SealRecord for a sealed scaffold', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);
    await seedSeal(client, taskId);

    const response = await client.get(`/api/tasks/${taskId}/structured-slots/seal`);
    expect(response.status).toBe(200);
    const seal = response.body as SealRecord;
    expect(seal.sealId).toBe('seal-1');
    expect(seal.caseId).toBe(taskId);
    expect(seal.artifactVersionRef).toEqual({ artifactId: 'artifact-1', version: 1 });
    expect(seal.outputs[0]?.routeId).toBe('document-md');
  });

  it('returns a stable SEAL_NOT_FOUND for an unsealed scaffold', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);

    const response = await client.get(`/api/tasks/${taskId}/structured-slots/seal`);
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('SEAL_NOT_FOUND');
  });

  it('fails closed when the sealed event references a non-seal blob', async () => {
    client = await startStructuredApiClient();
    const { taskId, blobStore } = await seedStructuredTask(client);
    // A content blob is a valid content-addressed blob but NOT a seal_record:
    // the server must reject the ref rather than return unvalidated bytes.
    const contentBlob = await blobStore.putContentValue('not a seal record');
    await client.service.appendTestEvent(
      taskId,
      makeTaskEvent({
        type: 'structured_scaffold_sealed',
        sealId: 'seal-bad',
        scaffoldId: 'scaffold-1',
        generationId: 'gen-1',
        scaffoldRevision: 1,
        sealRecord: { version: 1, kind: 'content_revision', sha256: contentBlob.sha256, byteLength: contentBlob.byteLength },
        artifactId: 'artifact-1',
        artifactVersion: 1,
      }),
    );

    const response = await client.get(`/api/tasks/${taskId}/structured-slots/seal`);
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('SEAL_NOT_FOUND');
  });

  it('fails closed when the seal-record blob violates the exact schema', async () => {
    client = await startStructuredApiClient();
    const { taskId, blobStore } = await seedStructuredTask(client);
    // A seal_record kind blob whose bytes are NOT a valid SealRecord shape must
    // be rejected server-side, never emitted to the client.
    const garbage = await blobStore.putJsonBlob({ not: 'a seal record' }, 'seal_record');
    await client.service.appendTestEvent(
      taskId,
      makeTaskEvent({
        type: 'structured_scaffold_sealed',
        sealId: 'seal-bad-2',
        scaffoldId: 'scaffold-1',
        generationId: 'gen-1',
        scaffoldRevision: 1,
        sealRecord: garbage,
        artifactId: 'artifact-1',
        artifactVersion: 1,
      }),
    );

    const response = await client.get(`/api/tasks/${taskId}/structured-slots/seal`);
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('SEAL_NOT_FOUND');
  });

  it('rejects profile/principal query parameters on every endpoint (v1)', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);

    const attempts = [
      `/api/tasks/${taskId}/structured-slots/contract?profile=editor`,
      `/api/tasks/${taskId}/structured-slots/tree?limit=2&principal=alice`,
      `/api/tasks/${taskId}/structured-slots/tree?limit=2&accessProfile=editor`,
      `/api/tasks/${taskId}/structured-slots/slots/title?subject=agent`,
      `/api/tasks/${taskId}/structured-slots/issues?limit=5&grant=grant-1`,
      `/api/tasks/${taskId}/structured-slots/seal?profile=editor`,
    ];
    for (const path of attempts) {
      const response = await client.get(path);
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects basic tasks with STRUCTURED_NOT_ACTIVE on every endpoint', async () => {
    client = await startStructuredApiClient();
    const created = await client.service.createTask({
      templateId: ONE_TEMPLATE_ID,
      name: 'Basic Task',
      input: { 'source-material': 'a basic source', 'style-note': 'keep it simple' },
    });
    const basicId = created.id;
    const attempts = [
      `/api/tasks/${basicId}/structured-slots/contract`,
      `/api/tasks/${basicId}/structured-slots/tree?limit=5`,
      `/api/tasks/${basicId}/structured-slots/slots/root`,
      `/api/tasks/${basicId}/structured-slots/issues?limit=5`,
      `/api/tasks/${basicId}/structured-slots/seal`,
    ];
    for (const path of attempts) {
      const response = await client.get(path);
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('STRUCTURED_NOT_ACTIVE');
    }
    // A basic workspace omits the summary entirely.
    const workspace = await client.get(`/api/tasks/${basicId}/workspace`);
    expect((workspace.body as { structuredSlots?: unknown }).structuredSlots).toBeUndefined();
  });

  it('attaches the structured summary to a structured workspace', async () => {
    client = await startStructuredApiClient();
    const { taskId } = await seedStructuredTask(client);
    const workspace = await client.get(`/api/tasks/${taskId}/workspace`);
    const summary = (workspace.body as { structuredSlots?: unknown }).structuredSlots;
    expect(summary).toMatchObject({
      version: 1,
      mode: 'structured_slots',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      contentRevision: 0,
      structureStatus: 'active',
      sealStatus: 'unsealed',
      visibleSlotCount: 4,
      // The seed data commits exactly two set content slots (title, body).
      filledSlotCount: 2,
      issueSummary: { errors: 0, warnings: 0 },
    });
    expect(JSON.stringify(summary)).not.toContain('"tree"');
    expect(JSON.stringify(summary)).not.toContain('"drafts"');
  });

  it('maps unknown tasks to TASK_NOT_FOUND and unknown routes to NOT_FOUND', async () => {
    client = await startStructuredApiClient();
    const notFound = await client.get('/api/tasks/task-missing/structured-slots/contract');
    expect(notFound.status).toBe(404);
    expect((notFound.body as { error: { code: string } }).error.code).toBe('TASK_NOT_FOUND');

    const noRoute = await client.get('/api/tasks/task-missing/structured-slots/unknown');
    expect(noRoute.status).toBe(404);
  });

  it('surfaces a stable TEMPLATE_RUNTIME_UNAVAILABLE for a disabled runtime', async () => {
    // Freeze a structured task under an enabled env, then reopen the SAME
    // roots with the production-default (disabled) environment: the read-only
    // routes fail closed with the stable runtime-unavailable envelope.
    const { dataRoot, templateRoot } = testServerOptions();
    installValidFixtureTemplate(templateRoot);
    cpSync(structuredFixtureDir(), join(templateRoot, 'structured-valid'), { recursive: true });
    const enabled = new CoreService(CorePaths.create({ dataRoot, templateRoot }), {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      runtime: new FakeAgentRuntime(),
    });
    await enabled.initialize();
    const created = await enabled.createTask({
      templateId: 'structured-valid',
      name: 'Structured Snapshot',
      input: { 'source-text': 'x' },
    });

    const disabledService = new CoreService(CorePaths.create({ dataRoot, templateRoot }));
    await disabledService.initialize();
    const server = await createForgeCoreServer({
      mode: 'test',
      dataRoot,
      templateRoot,
      coreService: disabledService,
    });
    try {
      const baseUrl = await server.listen(0);
      const response = await fetch(
        `${baseUrl}/api/tasks/${created.id}/structured-slots/contract`,
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('TEMPLATE_RUNTIME_UNAVAILABLE');
    } finally {
      await server.close();
    }
  });
});
