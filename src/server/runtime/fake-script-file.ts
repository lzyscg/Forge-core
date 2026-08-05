/**
 * File-backed FakeAgentRuntime scripts (plan Phase C Task 6).
 *
 * The local entry point (`main.ts`) selects the deterministic fake runtime
 * through the environment-only switch `FORGE_CORE_RUNTIME=fake` (e2e/tests
 * only; the switch never reaches the UI or the HTTP API). A child process
 * cannot receive in-memory scripts, so the fake behaviors are read from the
 * JSON file named by `FORGE_CORE_FAKE_SCRIPTS`:
 *
 * ```json
 * {
 *   "agent-alpha": [
 *     { "kind": "result", "publicText": "...", "actions": [...] },
 *     { "kind": "failure", "code": "HTTP_503", "retryable": true },
 *     { "kind": "result", "pause": true }
 *   ]
 * }
 * ```
 *
 * `pause: true` holds the Turn on a never-resolving deferred — the process
 * can be killed while the Turn is in flight (process-recovery gate).
 * Validation fails loud before any step is accepted; action payloads stay
 * opaque here and are validated by the ActionCommitter like any runtime
 * proposal.
 */
import { readFileSync } from 'node:fs';
import {
  RuntimeFailure,
  type Deferred,
  type FakeScriptStep,
  type FakeWorkspaceWrite,
} from './fake-agent-runtime';
import type { ForgeAction } from './forge-actions';

function scriptError(message: string): Error {
  return new Error(`forge-core: fake script file invalid — ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function neverResolvingDeferred(): Deferred<unknown> {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function parseStep(agentId: string, index: number, raw: unknown): FakeScriptStep {
  if (!isRecord(raw)) {
    throw scriptError(`${agentId}[${index}] must be an object`);
  }
  const deferred = raw.pause === true ? neverResolvingDeferred() : undefined;
  if (raw.kind === 'failure') {
    if (typeof raw.code !== 'string' || raw.code.length === 0) {
      throw scriptError(`${agentId}[${index}] failure needs a non-empty code`);
    }
    if (typeof raw.retryable !== 'boolean') {
      throw scriptError(`${agentId}[${index}] failure needs a boolean retryable`);
    }
    const message = raw.message === undefined ? raw.code : raw.message;
    if (typeof message !== 'string') {
      throw scriptError(`${agentId}[${index}] failure message must be a string`);
    }
    return {
      kind: 'failure',
      failure: new RuntimeFailure(raw.code, message, raw.retryable),
      ...(deferred !== undefined ? { deferred } : {}),
    };
  }
  if (raw.kind === 'result') {
    const publicText = raw.publicText ?? '';
    if (typeof publicText !== 'string') {
      throw scriptError(`${agentId}[${index}] publicText must be a string`);
    }
    const actions = raw.actions ?? [];
    if (!Array.isArray(actions)) {
      throw scriptError(`${agentId}[${index}] actions must be an array`);
    }
    const thinking = raw.thinking;
    if (thinking !== undefined && typeof thinking !== 'string') {
      throw scriptError(`${agentId}[${index}] thinking must be a string`);
    }
    const workspaceWrites = parseWorkspaceWrites(agentId, index, raw.workspaceWrites);
    return {
      kind: 'result',
      publicText,
      // Opaque proposals: the ActionCommitter validates them at commit time.
      actions: actions as ForgeAction[],
      ...(thinking !== undefined ? { thinking } : {}),
      ...(workspaceWrites !== undefined ? { workspaceWrites } : {}),
      ...(deferred !== undefined ? { deferred } : {}),
    };
  }
  throw scriptError(`${agentId}[${index}] kind must be 'result' or 'failure'`);
}

/** Parses the optional `workspaceWrites` list, failing loud on any bad shape. */
function parseWorkspaceWrites(
  agentId: string,
  index: number,
  raw: unknown,
): FakeWorkspaceWrite[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw scriptError(`${agentId}[${index}] workspaceWrites must be an array`);
  }
  return raw.map((entry, writeIndex) => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.content !== 'string') {
      throw scriptError(
        `${agentId}[${index}] workspaceWrites[${writeIndex}] must be an object with string path and content`,
      );
    }
    return { path: entry.path, content: entry.content };
  });
}

/** Parses one serialized script map; throws with a diagnostic when invalid. */
export function parseFakeScripts(json: string): Record<string, FakeScriptStep[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw scriptError('the file is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw scriptError('the top level must be an object keyed by agent id');
  }
  const scripts: Record<string, FakeScriptStep[]> = {};
  for (const [agentId, rawSteps] of Object.entries(parsed)) {
    if (!Array.isArray(rawSteps)) {
      throw scriptError(`${agentId} must map to a list of steps`);
    }
    scripts[agentId] = rawSteps.map((raw, index) => parseStep(agentId, index, raw));
  }
  return scripts;
}

/** Reads and parses the script file at `path` (fails loud, never guesses). */
export function loadFakeScriptsFromFile(path: string): Record<string, FakeScriptStep[]> {
  let json: string;
  try {
    json = readFileSync(path, 'utf8');
  } catch {
    throw scriptError(`cannot read ${path}`);
  }
  return parseFakeScripts(json);
}
