import { createHash } from 'node:crypto';
import { createContext, Script } from 'node:vm';

import type { AssemblerRegistrationV2 } from '../../template/structured-slot-contract-v2';
import { canonicalJson } from '../../structured-slots/canonical-json';
import {
  assembleZhihuChapterV1,
  ZHIHU_CHAPTER_ASSEMBLER_CANONICAL_SOURCE,
  type ZhihuChapterAssemblerInputV1,
  type ZhihuChapterAssemblerOutputV1,
} from './builtin-assemblers/zhihu-chapter-v1';

export const ZHIHU_CHAPTER_ASSEMBLER_MODULE_ID =
  'src/server/runtime/authoritative-review/builtin-assemblers/zhihu-chapter-v1';
export const ZHIHU_CHAPTER_ASSEMBLER_HANDLER_KEY = 'builtin.zhihu_chapter_markdown.v1';
export const ZHIHU_CHAPTER_ASSEMBLER_EXPORT_NAME = 'assembleZhihuChapterV1';

export class AssemblerRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AssemblerRegistryError';
  }
}

export interface AssemblerOutputV2 {
  routeId: string;
  artifactFile: string;
  mediaType: 'application/json' | 'text/markdown' | 'text/plain';
  content: string;
}

export type AssemblerHandlerV2 = (
  input: ZhihuChapterAssemblerInputV1,
) => readonly AssemblerOutputV2[];

export interface InstalledAssemblerV2 {
  registration: AssemblerRegistrationV2;
  handler: AssemblerHandlerV2;
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function normalizedSource(handler: AssemblerHandlerV2): string {
  if (handler === assembleZhihuChapterV1) return ZHIHU_CHAPTER_ASSEMBLER_CANONICAL_SOURCE.replace(/\r\n?/g, '\n').trim();
  return handler.toString().replace(/\r\n?/g, '\n').trim();
}

/**
 * Frozen digest algorithm: LF-normalized UTF-8 implementation source plus a
 * sorted canonical transitive builtin identity list.  It excludes paths
 * resolved by the host, timestamps, build output and process state.
 */
export function builtinAssemblerImplementationDigest(
  handler: AssemblerHandlerV2,
  transitive: readonly { moduleId: string; implementationDigest: string }[] = [],
): string {
  const closure = [...transitive].sort(
    (a, b) => a.moduleId.localeCompare(b.moduleId) || a.implementationDigest.localeCompare(b.implementationDigest),
  );
  return sha256(`${normalizedSource(handler)}\n${canonicalJson(closure)}\n`);
}

export const ZHIHU_CHAPTER_ASSEMBLER_IMPLEMENTATION_DIGEST =
  builtinAssemblerImplementationDigest(assembleZhihuChapterV1);

export const ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION: AssemblerRegistrationV2 = Object.freeze({
  abi: 'forge-assembler/v2',
  handlerKey: ZHIHU_CHAPTER_ASSEMBLER_HANDLER_KEY,
  implementationDigest: ZHIHU_CHAPTER_ASSEMBLER_IMPLEMENTATION_DIGEST,
  implementationRef: {
    kind: 'builtin',
    moduleId: ZHIHU_CHAPTER_ASSEMBLER_MODULE_ID,
    exportName: ZHIHU_CHAPTER_ASSEMBLER_EXPORT_NAME,
  },
  budget: { timeoutMs: 5000, maxInputBytes: 67_108_864, maxOutputBytes: 8_388_608 },
  routes: [{ id: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown' }],
} satisfies AssemblerRegistrationV2);

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function runIsolatedBuiltin(
  source: string,
  input: ZhihuChapterAssemblerInputV1,
  timeoutMs: number,
): readonly AssemblerOutputV2[] {
  const context = createContext({
    input: canonicalClone(input),
    // Explicitly shadow ambient capabilities. The builtin receives canonical
    // input only: no network, process/task globals, clock, random or timers.
    fetch: undefined,
    process: undefined,
    require: undefined,
    Date: undefined,
    performance: undefined,
    crypto: undefined,
    Math: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    console: undefined,
  }, { codeGeneration: { strings: false, wasm: false } });
  const result = new Script(`(${source})(input)`, { filename: ZHIHU_CHAPTER_ASSEMBLER_MODULE_ID })
    .runInContext(context, { timeout: timeoutMs });
  return JSON.parse(JSON.stringify(result)) as readonly AssemblerOutputV2[];
}

function assertSafeFileName(name: string): void {
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new AssemblerRegistryError('ASSEMBLER_OUTPUT_INVALID', `invalid artifact output name '${name}'`);
  }
}

function sameRegistration(actual: AssemblerRegistrationV2, expected: AssemblerRegistrationV2): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

export class AssemblerRegistryV2 {
  private readonly registrations = new Map<string, InstalledAssemblerV2>();

  constructor(additional: readonly InstalledAssemblerV2[] = []) {
    this.registerBuiltin(ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION, assembleZhihuChapterV1);
    for (const installed of additional) {
      this.registerBuiltin(installed.registration, installed.handler);
    }
  }

  private registerBuiltin(registration: AssemblerRegistrationV2, handler: AssemblerHandlerV2): void {
    if (this.registrations.has(registration.handlerKey)) {
      throw new AssemblerRegistryError('ASSEMBLER_DUPLICATE', `duplicate assembler '${registration.handlerKey}'`);
    }
    if (registration.implementationDigest !== builtinAssemblerImplementationDigest(handler)) {
      throw new AssemblerRegistryError(
        'ASSEMBLER_IDENTITY_MISMATCH',
        `assembler '${registration.handlerKey}' implementation digest does not match its handler`,
      );
    }
    this.registrations.set(registration.handlerKey, { registration, handler });
  }

  installedRegistration(handlerKey: string): AssemblerRegistrationV2 | null {
    return this.registrations.get(handlerKey)?.registration ?? null;
  }

  async assemble(
    contractRegistration: AssemblerRegistrationV2,
    input: ZhihuChapterAssemblerInputV1,
    expectedAuthority: ZhihuChapterAssemblerInputV1['authority'],
  ): Promise<readonly AssemblerOutputV2[]> {
    const installed = this.registrations.get(contractRegistration.handlerKey);
    if (installed === undefined) {
      throw new AssemblerRegistryError('ASSEMBLER_UNKNOWN', `assembler '${contractRegistration.handlerKey}' is not installed`);
    }
    if (!sameRegistration(contractRegistration, installed.registration)) {
      throw new AssemblerRegistryError('ASSEMBLER_IDENTITY_MISMATCH', 'assembler registration does not match installed identity');
    }
    if (canonicalJson(input.authority) !== canonicalJson(expectedAuthority)) {
      throw new AssemblerRegistryError('ASSEMBLER_INPUT_AUTHORITY_MISMATCH', 'assembler input authority does not match the current finalized refs');
    }
    const inputBytes = Buffer.byteLength(canonicalJson(input), 'utf8');
    if (inputBytes > contractRegistration.budget.maxInputBytes) {
      throw new AssemblerRegistryError('ASSEMBLER_INPUT_TOO_LARGE', 'assembler input exceeds frozen budget');
    }

    const source = installed.handler === assembleZhihuChapterV1
      ? ZHIHU_CHAPTER_ASSEMBLER_CANONICAL_SOURCE
      : normalizedSource(installed.handler);
    const first = runIsolatedBuiltin(source, input, contractRegistration.budget.timeoutMs);
    const second = runIsolatedBuiltin(source, input, contractRegistration.budget.timeoutMs);
    if (canonicalJson(first) !== canonicalJson(second)) {
      throw new AssemblerRegistryError('ASSEMBLER_NONDETERMINISTIC', 'assembler returned different bytes for identical input');
    }
    const expectedRoutes = new Map(contractRegistration.routes.map((route) => [route.id, route]));
    const seen = new Set<string>();
    const seenFiles = new Set<string>();
    const outputs: AssemblerOutputV2[] = [];
    for (const output of first) {
      if (output === null || typeof output !== 'object') {
        throw new AssemblerRegistryError('ASSEMBLER_OUTPUT_INVALID', 'assembler output must be an object');
      }
      const route = expectedRoutes.get(output.routeId);
      if (route === undefined || seen.has(output.routeId)) {
        throw new AssemblerRegistryError('ASSEMBLER_OUTPUT_INVALID', 'unknown or duplicate assembler route');
      }
      seen.add(output.routeId);
      if (seenFiles.has(output.artifactFile)) {
        throw new AssemblerRegistryError('ASSEMBLER_OUTPUT_INVALID', 'duplicate assembler artifact output name');
      }
      seenFiles.add(output.artifactFile);
      assertSafeFileName(output.artifactFile);
      if (output.artifactFile !== route.artifactFile || output.mediaType !== route.mediaType || typeof output.content !== 'string') {
        throw new AssemblerRegistryError('ASSEMBLER_OUTPUT_INVALID', 'assembler output does not match the frozen route');
      }
      outputs.push({ ...output });
    }
    if (seen.size !== expectedRoutes.size) {
      throw new AssemblerRegistryError('ASSEMBLER_OUTPUT_INVALID', 'assembler did not produce every frozen route');
    }
    const outputBytes = outputs.reduce((sum, output) => sum + Buffer.byteLength(output.content, 'utf8'), 0);
    if (outputBytes > contractRegistration.budget.maxOutputBytes) {
      throw new AssemblerRegistryError('ASSEMBLER_OUTPUT_TOO_LARGE', 'assembler output exceeds frozen budget');
    }
    return Object.freeze(outputs.map((output) => Object.freeze(output)));
  }
}
