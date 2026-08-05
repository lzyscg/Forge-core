/**
 * Real Pi boundary probe (plan Phase C Task 2 Step 8).
 *
 * Runs ONE inexpensive Turn against a real Provider through the constrained
 * PiAgentRuntime and verifies the Phase C boundary holds end-to-end:
 *
 *   - exactly five Forge custom tools, Pi built-in tools disabled;
 *   - no built-in tool call is ever executed;
 *   - the session is in-memory (isPersisted() === false);
 *   - Pi compaction and retry are disabled and observable;
 *   - no Pi resources are discovered (extensions/skills/prompts/themes/
 *     context files all empty);
 *   - prompt template expansion is disabled;
 *   - zero secret/hidden-thinking findings in the turn result and probe log.
 *
 * The report written to `--report` is sanitized: model identifiers, tool
 * name counts and boolean boundary conclusions only — never credentials,
 * headers, hidden thinking or full message bodies. This probe is not the
 * production acceptance (Phase D).
 *
 * Exit codes: 0 = every boundary check passed; 1 = boundary violation or
 * provider failure; 2 = missing/unknown CLI arguments (checked BEFORE any
 * session or runtime is constructed).
 *
 * Usage:
 *   npm run probe:pi -- --provider <providerId> --model <modelId> --report <path>
 */
import { config as loadDotenv } from 'dotenv';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORGE_ACTION_NAMES,
  FORGE_ACTION_NAME_SET,
} from '../src/server/runtime/forge-actions';
import {
  PiAgentRuntime,
  defaultPiSessionFactory,
  type PiSessionEventLike,
  type PiSessionHandle,
} from '../src/server/runtime/pi-agent-runtime';
import { assertNoDiscoveredResources } from '../src/server/runtime/pi-resource-loader';
import type { AgentTurnInput } from '../src/server/runtime/agent-runtime';
import { CorePaths } from '../src/server/storage/core-paths';
import { WorkspaceStore } from '../src/server/runtime/workspace-store';
import {
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_TOOL_NAME_SET,
} from '../src/server/runtime/workspace-tools';

/**
 * Repo root derived from this script's location (the project root/scripts →
 * three levels up). Relative `--report` paths resolve against the repo root —
 * NOT the process cwd — because `npm run -w` pins cwd to the workspace while
 * the sanitized evidence tree (`forge-core-overnight/evidence/...`) lives at
 * the repo root next to phase-b.json. Absolute `--report` paths still win.
 */
const PROBE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface PiProbeArgs {
  provider: string;
  model: string;
  report: string;
}

/** Pure argument parser: null when any required flag is missing/unknown. */
export function parsePiRuntimeProbeArgs(argv: readonly string[]): PiProbeArgs | null {
  const parsed: Partial<PiProbeArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--provider' && value) {
      parsed.provider = value;
      index += 1;
    } else if (flag === '--model' && value) {
      parsed.model = value;
      index += 1;
    } else if (flag === '--report' && value) {
      parsed.report = value;
      index += 1;
    } else {
      return null;
    }
  }
  if (!parsed.provider || !parsed.model || !parsed.report) {
    return null;
  }
  return parsed as PiProbeArgs;
}

/** Markers that must never appear in public outputs or probe logs. */
const FORBIDDEN_MARKERS = [
  'thinkingSignature',
  'thoughtSignature',
  'reasoning_content',
  'SECRET',
  'apiKey',
  'authorization',
] as const;

function countMarkerFindings(...texts: string[]): number {
  let findings = 0;
  for (const text of texts) {
    for (const marker of FORBIDDEN_MARKERS) {
      let from = 0;
      while (true) {
        const at = text.indexOf(marker, from);
        if (at === -1) {
          break;
        }
        findings += 1;
        from = at + marker.length;
      }
    }
  }
  return findings;
}

function usage(): void {
  process.stderr.write(
    'usage: pi-runtime-probe --provider <providerId> --model <modelId> --report <path>\n',
  );
}

/**
 * Loads the nearest `.env` walking up from the current working directory into
 * process.env (values are never read, echoed or returned here — dotenv owns
 * the parse). The deepseek provider resolves its API key from
 * `DEEPSEEK_API_KEY` at request time, so the probe only needs the variable
 * present in the environment; the key itself stays inside the runtime.
 */
function loadRepoEnvFile(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

interface RecordedSessionOptions {
  noTools?: string;
  customToolNames: string[];
  sessionPersisted: boolean | null;
  compactionEnabled: boolean | null;
  retryEnabled: boolean | null;
  loaderClean: boolean;
  loaderLeakDetail: string;
}

async function main(): Promise<void> {
  const args = parsePiRuntimeProbeArgs(process.argv.slice(2));
  if (args === null) {
    usage();
    process.exit(2);
  }

  // Everything below this line may construct runtime state; argument
  // validation above must stay the only gate that runs before it.
  // Provider auth arrives through the environment (never logged/returned).
  loadRepoEnvFile();
  const probeLogs: string[] = [];
  const toolCallCounts: Record<string, number> = {};
  const promptOptionsSeen: Array<{ expandPromptTemplates?: boolean } | undefined> = [];
  const recorded: RecordedSessionOptions = {
    customToolNames: [],
    sessionPersisted: null,
    compactionEnabled: null,
    retryEnabled: null,
    loaderClean: false,
    loaderLeakDetail: '',
  };

  // Isolated temp-root workspace store: the probe agent never writes a
  // workspace file, but the runtime requires the store to expose the three
  // workspace tools. Kept out of cwd so no workspace residue is left behind.
  const probeWorkspaceRoot = mkdtempSync(join(tmpdir(), 'forge-pi-probe-workspaces-'));
  const probeWorkspaces = new WorkspaceStore(
    CorePaths.create({ dataRoot: probeWorkspaceRoot, templateRoot: probeWorkspaceRoot }),
  );

  const runtime = new PiAgentRuntime({
    coreCwd: process.cwd(),
    workspaces: probeWorkspaces,
    log: (line) => {
      probeLogs.push(line);
      process.stdout.write(`${line}\n`);
    },
    createSession: async (options) => {
      recorded.noTools = options.noTools;
      recorded.customToolNames = (options.customTools ?? []).map((tool) => tool.name);
      recorded.sessionPersisted = options.sessionManager?.isPersisted() ?? null;
      recorded.compactionEnabled = options.settingsManager?.getCompactionEnabled() ?? null;
      recorded.retryEnabled = options.settingsManager?.getRetryEnabled() ?? null;
      try {
        if (options.resourceLoader) {
          assertNoDiscoveredResources(options.resourceLoader);
        }
        recorded.loaderClean = true;
      } catch (error) {
        recorded.loaderLeakDetail = error instanceof Error ? error.message : 'unknown leak';
      }
      const session = await defaultPiSessionFactory(options);
      const wrapped: PiSessionHandle = {
        prompt: (text, promptOptions) => {
          promptOptionsSeen.push(promptOptions);
          return session.prompt(text, promptOptions);
        },
        subscribe: (listener) =>
          session.subscribe((event) => {
            if ((event as { type?: unknown })?.type === 'tool_execution_start') {
              const toolName = String((event as { toolName?: unknown }).toolName ?? 'unknown');
              toolCallCounts[toolName] = (toolCallCounts[toolName] ?? 0) + 1;
            }
            listener(event as PiSessionEventLike);
          }),
        abort: () => session.abort(),
        dispose: () => session.dispose(),
        setAutoCompactionEnabled: (enabled) => session.setAutoCompactionEnabled(enabled),
      };
      return wrapped;
    },
  });

  const input: AgentTurnInput = {
    taskId: 'probe-task',
    turnId: 'probe-turn-1',
    agent: {
      id: 'probe-agent',
      name: 'Probe Agent',
      description: 'Neutral boundary probe agent.',
      systemPrompt:
        'You are a neutral platform probe agent. You may only use the provided Forge tools.',
      model: `${args.provider}/${args.model}`,
      skills: [],
      turnContract: {
        version: 1,
        production: {
          completionAction: 'finish_production',
          output: { formats: ['text'], sources: ['inline'] },
        },
        dispatch: {
          cardinality: 'single',
          allowedActions: ['send_message'],
          targets: { send_message: 'probe-peer' },
          productionPackageRef: 'current',
        },
      },
    },
    inputNodeId: 'probe-input-1',
    inputText:
      'First call finish_production exactly once with source "inline", a short neutral ' +
      'content text and format "text". Then call the send_message tool exactly once with ' +
      "targetAgentId 'probe-peer' and productionPackageRef 'current'. Do not call any other " +
      'tool. Then reply with the single word DONE.',
    publicHistory: [],
    availableSkills: [],
    loadedSkills: [],
  };

  const violations: string[] = [];
  let outcome: 'succeeded' | 'failed' = 'failed';
  let actionsCommitted = 0;
  let resultJson = '';
  let publicTextLength = 0;
  let usageSeen: { inputTokens: number; outputTokens: number } | null = null;
  let traceThinkingEntries = 0;
  let traceToolCallEntries = 0;

  const signal = AbortSignal.timeout(120_000);
  try {
    const result = await runtime.run(input, signal);
    outcome = 'succeeded';
    actionsCommitted = result.actions.length;
    publicTextLength = result.publicText.length;
    usageSeen = result.usage;
    // Marker scanning is limited to the public surface (publicText/actions/
    // usage) plus the probe log: the trace is display-only and may carry
    // thinking text, so it is deliberately never scanned for markers.
    resultJson = JSON.stringify({
      publicText: result.publicText,
      actions: result.actions,
      usage: result.usage,
    });
    traceThinkingEntries = result.trace.filter((entry) => entry.kind === 'thinking').length;
    traceToolCallEntries = result.trace.filter((entry) => entry.kind === 'tool_call').length;
    if (!result.actions.some((action) => action.type === 'finish_production')) {
      violations.push('NO_LEGAL_CUSTOM_ACTION: the turn committed no finish_production action');
    }
    if (!result.actions.some((action) => action.type === 'send_message')) {
      violations.push('NO_LEGAL_CUSTOM_ACTION: the turn committed no send_message action');
    }
    for (const action of result.actions) {
      if (!FORGE_ACTION_NAME_SET.has(action.type)) {
        violations.push(`UNKNOWN_ACTION_TYPE: ${action.type}`);
      }
    }
  } catch (error) {
    outcome = 'failed';
    const code =
      error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'UNKNOWN';
    violations.push(`TURN_FAILED: ${code}`);
  } finally {
    await runtime.disposeAll().catch(() => undefined);
  }

  // Boundary checks recorded during session construction. The session exposes
  // exactly the five production actions plus the three workspace tools.
  const expectedToolCount = FORGE_ACTION_NAMES.length + WORKSPACE_TOOL_NAMES.length;
  if (recorded.customToolNames.length !== expectedToolCount) {
    violations.push(`CUSTOM_TOOL_COUNT: expected ${expectedToolCount}, saw ${recorded.customToolNames.length}`);
  }
  for (const name of recorded.customToolNames) {
    const isProduction = FORGE_ACTION_NAME_SET.has(name as (typeof FORGE_ACTION_NAMES)[number]);
    const isWorkspace = WORKSPACE_TOOL_NAME_SET.has(name as (typeof WORKSPACE_TOOL_NAMES)[number]);
    if (!isProduction && !isWorkspace) {
      violations.push(`CUSTOM_TOOL_UNKNOWN: ${name}`);
    }
  }
  if (recorded.noTools !== 'builtin') {
    violations.push(`BUILTIN_TOOLS_NOT_DISABLED: noTools=${recorded.noTools ?? 'unset'}`);
  }
  if (recorded.sessionPersisted !== false) {
    violations.push(`SESSION_PERSISTED: isPersisted=${String(recorded.sessionPersisted)}`);
  }
  if (recorded.compactionEnabled !== false) {
    violations.push(`COMPACTION_ENABLED: ${String(recorded.compactionEnabled)}`);
  }
  if (recorded.retryEnabled !== false) {
    violations.push(`RETRY_ENABLED: ${String(recorded.retryEnabled)}`);
  }
  if (recorded.loaderClean !== true) {
    violations.push(`RESOURCE_DISCOVERY_LEAK: ${recorded.loaderLeakDetail}`);
  }
  for (const [toolName, count] of Object.entries(toolCallCounts)) {
    const isProduction = FORGE_ACTION_NAME_SET.has(toolName as (typeof FORGE_ACTION_NAMES)[number]);
    const isWorkspace = WORKSPACE_TOOL_NAME_SET.has(toolName as (typeof WORKSPACE_TOOL_NAMES)[number]);
    if (!isProduction && !isWorkspace) {
      violations.push(`BUILTIN_TOOL_CALL: ${toolName} x${count}`);
    }
  }
  if (!promptOptionsSeen.every((seen) => seen?.expandPromptTemplates === false)) {
    violations.push('PROMPT_TEMPLATES_NOT_DISABLED');
  }

  const joinedLog = probeLogs.join('\n');
  const secretFindings = countMarkerFindings(resultJson, joinedLog);

  // The isolated workspace root is no longer needed; remove it best-effort.
  try {
    rmSync(probeWorkspaceRoot, { recursive: true, force: true });
  } catch {
    // Temp residue under the OS tmpdir is harmless if removal races.
  }

  const customToolNameSet = new Set(recorded.customToolNames);
  const productionToolNames = recorded.customToolNames.filter((name) =>
    FORGE_ACTION_NAME_SET.has(name as (typeof FORGE_ACTION_NAMES)[number]),
  );
  const workspaceToolNames = recorded.customToolNames.filter((name) =>
    WORKSPACE_TOOL_NAME_SET.has(name as (typeof WORKSPACE_TOOL_NAMES)[number]),
  );
  const noCustomToolViolations = violations.every(
    (violation) => !violation.startsWith('CUSTOM_TOOL'),
  );
  const isCustomToolName = (name: string): boolean =>
    FORGE_ACTION_NAME_SET.has(name as (typeof FORGE_ACTION_NAMES)[number]) ||
    WORKSPACE_TOOL_NAME_SET.has(name as (typeof WORKSPACE_TOOL_NAMES)[number]);

  const report = {
    probe: 'pi-runtime-boundary',
    phase: 'phase-e-task-2',
    provider: args.provider,
    model: args.model,
    outcome,
    checks: {
      fiveProductionActionsOnly:
        productionToolNames.length === FORGE_ACTION_NAMES.length &&
        FORGE_ACTION_NAMES.every((name) => customToolNameSet.has(name)) &&
        noCustomToolViolations,
      threeWorkspaceToolsOnly:
        workspaceToolNames.length === WORKSPACE_TOOL_NAMES.length &&
        WORKSPACE_TOOL_NAMES.every((name) => customToolNameSet.has(name)) &&
        noCustomToolViolations,
      builtinToolsDisabled: recorded.noTools === 'builtin',
      noBuiltInToolCalls: violations.every((violation) => !violation.startsWith('BUILTIN_TOOL_CALL')),
      inMemorySession: recorded.sessionPersisted === false,
      compactionDisabled: recorded.compactionEnabled === false,
      retryDisabled: recorded.retryEnabled === false,
      noDiscoveredResources: recorded.loaderClean === true,
      promptTemplatesDisabled: promptOptionsSeen.every((seen) => seen?.expandPromptTemplates === false),
      legalCustomActionObserved: outcome === 'succeeded' && actionsCommitted > 0,
    },
    counts: {
      turns: 1,
      actionsCommitted,
      customToolNames: recorded.customToolNames,
      customToolCalls: Object.fromEntries(
        Object.entries(toolCallCounts).filter(([name]) => isCustomToolName(name)),
      ),
      builtInToolCalls: Object.entries(toolCallCounts)
        .filter(([name]) => !isCustomToolName(name))
        .reduce((sum, [, count]) => sum + count, 0),
      secretFindings,
      thinkingFindings: secretFindings,
      traceThinkingEntries,
      traceToolCallEntries,
      publicTextLength,
    },
    usage: usageSeen,
    boundaryViolations: violations,
  };

  const reportPath = resolve(PROBE_REPO_ROOT, args.report);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`report written to ${reportPath}\n`);

  if (secretFindings > 0) {
    violations.push(`SECRET_OR_THINKING_FINDINGS: ${secretFindings}`);
  }
  if (violations.length > 0) {
    process.stderr.write(`BOUNDARY VIOLATIONS (${violations.length}):\n`);
    for (const violation of violations) {
      process.stderr.write(`  - ${violation}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('GO: constrained Pi runtime boundary holds.\n');
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`probe crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
