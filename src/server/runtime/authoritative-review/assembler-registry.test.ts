import { describe, expect, it } from 'vitest';

import {
  type AssemblerHandlerV2,
  AssemblerRegistryError,
  AssemblerRegistryV2,
  ZHIHU_CHAPTER_ASSEMBLER_EXPORT_NAME,
  ZHIHU_CHAPTER_ASSEMBLER_HANDLER_KEY,
  ZHIHU_CHAPTER_ASSEMBLER_IMPLEMENTATION_DIGEST,
  ZHIHU_CHAPTER_ASSEMBLER_MODULE_ID,
  ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION,
  builtinAssemblerImplementationDigest,
} from './assembler-registry';
import type { AssemblerRegistrationV2 } from '../../template/structured-slot-contract-v2';
import { assembleZhihuChapterV1 } from './builtin-assemblers/zhihu-chapter-v1';
import { zhihuAssemblerFixture } from './builtin-assemblers/zhihu-chapter-v1.test';

describe('AssemblerRegistryV2', () => {
  const assemble = (registration = ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION, input = zhihuAssemblerFixture()) =>
    new AssemblerRegistryV2().assemble(registration, input, input.authority);

  it('freezes the exact production identity and derives a stable source digest', async () => {
    expect(ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION).toEqual({
      abi: 'forge-assembler/v2',
      handlerKey: ZHIHU_CHAPTER_ASSEMBLER_HANDLER_KEY,
      implementationDigest: ZHIHU_CHAPTER_ASSEMBLER_IMPLEMENTATION_DIGEST,
      implementationRef: { kind: 'builtin', moduleId: ZHIHU_CHAPTER_ASSEMBLER_MODULE_ID, exportName: ZHIHU_CHAPTER_ASSEMBLER_EXPORT_NAME },
      budget: { timeoutMs: 5000, maxInputBytes: 67_108_864, maxOutputBytes: 8_388_608 },
      routes: [{ id: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown' }],
    });
    expect(ZHIHU_CHAPTER_ASSEMBLER_IMPLEMENTATION_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(builtinAssemblerImplementationDigest(assembleZhihuChapterV1)).toBe(ZHIHU_CHAPTER_ASSEMBLER_IMPLEMENTATION_DIGEST);
    await expect(assemble())
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ artifactFile: 'chapter.md' })]));
  });

  it.each([
    ['handlerKey', 'unknown'],
    ['implementationDigest', '0'.repeat(64)],
  ] as const)('rejects a %s identity mismatch', async (field, value) => {
    const registration = { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION, [field]: value };
    await expect(assemble(registration))
      .rejects.toBeInstanceOf(AssemblerRegistryError);
  });

  it('rejects module/export/budget/route and v1 ABI substitution', async () => {
    const registry = new AssemblerRegistryV2();
    const variants = [
      { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION, abi: 'forge-assembler/v1' as never },
      { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION, implementationRef: { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION.implementationRef, moduleId: 'x' } },
      { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION, implementationRef: { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION.implementationRef, exportName: 'x' } },
      { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION, budget: { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION.budget, maxOutputBytes: 1 } },
      { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION, routes: [{ id: 'chapter-markdown', artifactFile: '../escape.md', mediaType: 'text/markdown' as const }] },
    ];
    for (const variant of variants) {
      const input = zhihuAssemblerFixture();
      await expect(registry.assemble(variant, input, input.authority)).rejects.toBeInstanceOf(AssemblerRegistryError);
    }
  });

  it('rejects input authority drift and treats ambient-I/O-looking content as inert bytes', async () => {
    const input = zhihuAssemblerFixture();
    await expect(new AssemblerRegistryV2().assemble(
      ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION,
      input,
      { ...input.authority, templateSnapshotHash: 'other' },
    )).rejects.toMatchObject({ code: 'ASSEMBLER_INPUT_AUTHORITY_MISMATCH' });
    const inert = structuredClone(input);
    inert.tree[2]!.content = '${Date.now()} fetch(process.env.SECRET) Math.random()';
    const outputs = await assemble(ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION, inert);
    expect(outputs[0]?.content).toContain('${Date.now()} fetch(process.env.SECRET) Math.random()');
  });

  const installed = (
    key: string,
    handler: AssemblerHandlerV2,
    overrides: Partial<AssemblerRegistrationV2> = {},
  ) => {
    const registration: AssemblerRegistrationV2 = {
      ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION,
      handlerKey: key,
      implementationDigest: builtinAssemblerImplementationDigest(handler),
      implementationRef: { kind: 'builtin', moduleId: `test/${key}`, exportName: 'assemble' },
      ...overrides,
    };
    const registry = new AssemblerRegistryV2([{ registration, handler }]);
    const input = zhihuAssemblerFixture();
    return { registration, run: () => registry.assemble(registration, input, input.authority) };
  };

  it('rejects duplicate installed handler keys without replacing the production builtin', () => {
    expect(() => new AssemblerRegistryV2([{
      registration: ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION,
      handler: assembleZhihuChapterV1,
    }])).toThrowError(AssemblerRegistryError);
  });

  it.each([
    ['network', (() => { void fetch('https://invalid.example'); return []; }) as AssemblerHandlerV2],
    ['clock', (() => [{ routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown', content: String(Date.now()) }]) as AssemblerHandlerV2],
    ['random', (() => [{ routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown', content: String(Math.random()) }]) as AssemblerHandlerV2],
    ['process', (() => [{ routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown', content: String(process.pid) }]) as AssemblerHandlerV2],
    ['timer', (() => { setTimeout(() => undefined, 0); return []; }) as AssemblerHandlerV2],
  ])('fails closed when an allowlisted attack handler attempts %s I/O', async (name, handler) => {
    await expect(installed(`attack-${name}`, handler).run()).rejects.toBeTruthy();
  });

  it('isolates the evaluator from host task globals', async () => {
    const host = globalThis as typeof globalThis & { taskSecret?: string };
    host.taskSecret = 'must-not-leak';
    try {
      const handler = (() => [{
        routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown',
        content: String((globalThis as { taskSecret?: string }).taskSecret),
      }]) as AssemblerHandlerV2;
      await expect(installed('attack-task-global', handler).run())
        .resolves.toEqual([expect.objectContaining({ content: 'undefined' })]);
    } finally {
      delete host.taskSecret;
    }
  });

  it.each([
    ['path escape', (() => [{ routeId: 'chapter-markdown', artifactFile: '../escape.md', mediaType: 'text/markdown', content: 'x' }]) as AssemblerHandlerV2],
    ['media mismatch', (() => [{ routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/plain', content: 'x' }]) as AssemblerHandlerV2],
    ['duplicate route', (() => [
      { routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown', content: 'x' },
      { routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown', content: 'x' },
    ]) as AssemblerHandlerV2],
  ])('rejects invalid production output: %s', async (name, handler) => {
    await expect(installed(`bad-output-${name}`, handler).run())
      .rejects.toMatchObject({ code: 'ASSEMBLER_OUTPUT_INVALID' });
  });

  it('rejects duplicate output names across distinct routes and enforces the byte budget', async () => {
    const duplicate = (() => [
      { routeId: 'a', artifactFile: 'same.md', mediaType: 'text/markdown', content: 'a' },
      { routeId: 'b', artifactFile: 'same.md', mediaType: 'text/markdown', content: 'b' },
    ]) as AssemblerHandlerV2;
    const duplicateRoutes = [
      { id: 'a', artifactFile: 'same.md', mediaType: 'text/markdown' as const },
      { id: 'b', artifactFile: 'same.md', mediaType: 'text/markdown' as const },
    ];
    await expect(installed('duplicate-files', duplicate, { routes: duplicateRoutes }).run())
      .rejects.toMatchObject({ code: 'ASSEMBLER_OUTPUT_INVALID' });

    const oversized = (() => [{
      routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown', content: 'xx',
    }]) as AssemblerHandlerV2;
    await expect(installed('oversized', oversized, {
      budget: { ...ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION.budget, maxOutputBytes: 1 },
    }).run()).rejects.toMatchObject({ code: 'ASSEMBLER_OUTPUT_TOO_LARGE' });
  });
});
