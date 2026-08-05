/**
 * The three agent-workspace file tools as Pi ToolDefinitions (plan Phase E
 * Task 2).
 *
 * The workspace is each agent's file-only scratch area (plan Global
 * Constraint 6): `write_workspace` / `read_workspace` / `list_workspace`, no
 * shell. Writes take effect immediately through the `WorkspaceStore` and never
 * pass through the ActionBuffer or the event union — they are scratch, not
 * committed history. The tool callbacks close over ONLY the store context
 * `{workspaces, taskId, agentId}` plus one READ-ONLY phase probe
 * (`isProductionPhase`, review F1): no ActionBuffer mutation handle,
 * EventStore, CoreService or scheduler handle is ever injected. The probe
 * gates `write_workspace` once the Turn seals or dispatches its package, so
 * sealed workspace content can never be mutated underneath the commit.
 *
 * Every store failure is a typed, non-retryable `RuntimeFailure`; the tools
 * convert it into a short `rejected` acknowledgement (stable code) instead of
 * throwing, so the model Turn can recover. Successful calls return a short
 * public receipt: write `<path> (<bytes> bytes)`, read the content itself,
 * list one line per file or `empty workspace`.
 *
 * No business vocabulary lives here (iron rule 1).
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type Static, type TSchema } from 'typebox';
import { RuntimeFailure } from './agent-runtime';
import type { WorkspaceStore } from './workspace-store';
import { WORKSPACE_LIMITS } from './workspace-store';

/** The closed three-name workspace tool registry. */
export const WORKSPACE_TOOL_NAMES = ['write_workspace', 'read_workspace', 'list_workspace'] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

/** Frozen membership view of the closed workspace registry. */
export const WORKSPACE_TOOL_NAME_SET: ReadonlySet<WorkspaceToolName> = new Set(WORKSPACE_TOOL_NAMES);

/** Fallback code for a workspace tool failure that is not a RuntimeFailure. */
export const WORKSPACE_TOOL_FAILED = 'WORKSPACE_TOOL_FAILED';

/**
 * Stable rejection code for `write_workspace` once the Turn left the
 * production phase (review F1): after sealing or dispatching, scratch writes
 * must never mutate the content a sealed `workspace_file` package refers to.
 */
export const WORKSPACE_WRITE_AFTER_SEAL = 'WORKSPACE_WRITE_AFTER_SEAL';

/** The closed context the workspace tools may close over. */
export interface WorkspaceToolContext {
  workspaces: WorkspaceStore;
  taskId: string;
  agentId: string;
  /**
   * Read-only probe over the SAME ActionBuffer the forge tools propose to
   * (review F1): true exactly while the Turn is still in the production
   * phase. Once the package is sealed or dispatched, `write_workspace`
   * rejects with WORKSPACE_WRITE_AFTER_SEAL; read/list stay available.
   */
  isProductionPhase: () => boolean;
}

interface WorkspaceToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: { accepted: boolean; code?: string };
}

function accepted(receipt: string): WorkspaceToolResult {
  return { content: [{ type: 'text', text: receipt }], details: { accepted: true } };
}

function rejected(code: string, name: WorkspaceToolName): WorkspaceToolResult {
  return {
    content: [{ type: 'text', text: `${name} rejected: ${code}` }],
    details: { accepted: false, code },
  };
}

/** A relative workspace path reference (bounded, non-empty). */
const pathField = () => Type.String({ minLength: 1, maxLength: WORKSPACE_LIMITS.maxPathLength });

const WRITE_WORKSPACE_PARAMETERS = Type.Object({
  path: pathField(),
  content: Type.String(),
});

const READ_WORKSPACE_PARAMETERS = Type.Object({
  path: pathField(),
});

const LIST_WORKSPACE_PARAMETERS = Type.Object({});

function failureCode(error: unknown): string {
  if (error instanceof RuntimeFailure) {
    return error.code;
  }
  return WORKSPACE_TOOL_FAILED;
}

/**
 * Creates the closed three-tool set bound to one agent's workspace. A fresh
 * set is created per Turn; the callbacks never outlive their context, never
 * mutate the ActionBuffer or EventStore, and only consult the read-only
 * phase probe to gate writes after sealing.
 */
export function createWorkspaceToolDefinitions(ctx: WorkspaceToolContext): ToolDefinition[] {
  const write = async (params: Static<typeof WRITE_WORKSPACE_PARAMETERS>): Promise<WorkspaceToolResult> => {
    if (!ctx.isProductionPhase()) {
      // Sealed/dispatched turns keep their sealed content immutable (F1).
      return rejected(WORKSPACE_WRITE_AFTER_SEAL, 'write_workspace');
    }
    const entry = await ctx.workspaces.writeFile(ctx.taskId, ctx.agentId, params.path, params.content);
    return accepted(`${entry.path} (${entry.bytes} bytes)`);
  };
  const read = async (params: Static<typeof READ_WORKSPACE_PARAMETERS>): Promise<WorkspaceToolResult> => {
    const content = await ctx.workspaces.readFile(ctx.taskId, ctx.agentId, params.path);
    return accepted(content);
  };
  const list = async (): Promise<WorkspaceToolResult> => {
    const entries = await ctx.workspaces.listFiles(ctx.taskId, ctx.agentId);
    if (entries.length === 0) {
      return accepted('empty workspace');
    }
    return accepted(entries.map((entry) => `${entry.path} (${entry.bytes} bytes)`).join('\n'));
  };

  const wrap = (
    name: WorkspaceToolName,
    run: (params: Record<string, unknown>) => Promise<WorkspaceToolResult>,
  ) => async (_toolCallId: string, params: Static<TSchema>): Promise<WorkspaceToolResult> => {
    try {
      return await run((params ?? {}) as Record<string, unknown>);
    } catch (error) {
      return rejected(failureCode(error), name);
    }
  };

  return [
    {
      name: 'write_workspace',
      label: 'write_workspace',
      description:
        'Write or overwrite one scratch file in your private workspace. Takes effect immediately; the file is not a committed artifact. Only allowed while the production package is not sealed yet; once finish_production sealed the package (or a dispatch ran), writes are rejected so the sealed content stays unchanged.',
      promptSnippet: 'write_workspace(path, content) — write one scratch file in your workspace',
      parameters: WRITE_WORKSPACE_PARAMETERS,
      executionMode: 'sequential' as const,
      execute: wrap('write_workspace', (params) =>
        write(params as unknown as Static<typeof WRITE_WORKSPACE_PARAMETERS>),
      ),
    },
    {
      name: 'read_workspace',
      label: 'read_workspace',
      description: 'Read one scratch file from your private workspace as text.',
      promptSnippet: 'read_workspace(path) — read one scratch file from your workspace',
      parameters: READ_WORKSPACE_PARAMETERS,
      executionMode: 'sequential' as const,
      execute: wrap('read_workspace', (params) =>
        read(params as unknown as Static<typeof READ_WORKSPACE_PARAMETERS>),
      ),
    },
    {
      name: 'list_workspace',
      label: 'list_workspace',
      description: 'List every scratch file in your private workspace with its byte size.',
      promptSnippet: 'list_workspace() — list the scratch files in your workspace',
      parameters: LIST_WORKSPACE_PARAMETERS,
      executionMode: 'sequential' as const,
      execute: wrap('list_workspace', () => list()),
    },
  ];
}
