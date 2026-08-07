// @vitest-environment node
/**
 * PiAgentRuntime tests (plan Phase C Task 2 Steps 1/7).
 *
 * Every test runs against an injected `createSession` factory via
 * `createPiHarness` (test-support): no real Provider is ever contacted. The
 * harness records the exact `createAgentSession` options, exposes the
 * in-memory SettingsManager and scripts the assistant/tool event sequence.
 *
 * Coverage: the verbatim plan Step 1 adapter-configuration assertions
 * (in-memory session, built-in tools disabled, exactly five custom tools,
 * compaction on / retry off), Turn completion through the ActionBuffer, failure
 * and abort boundaries, public-history replay with Forge-owned skill prompt
 * messages, hidden-thinking/secret exclusion, the buffer-only tool factory
 * and the no-discovery resource loader.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { ActionBuffer } from './action-buffer';
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';
import { FORGE_ACTION_NAMES, FORGE_ACTION_NAME_SET } from './forge-actions';
import type { GateRunner } from './gate-runner';
import {
  MAX_CORRECTIVE_NUDGES,
  PI_RUNTIME_ERROR_CODES,
  parsePiModelSpec,
  sealedPhaseReminder,
  type PiAgentRuntime,
} from './pi-agent-runtime';
import { assertNoDiscoveredResources, createForgeResourceLoader } from './pi-resource-loader';
import { createForgeToolDefinitions } from './pi-tool-factory';
import { SKILL_SECTION_TOOL_NAMES } from './pi-tool-factory';
import { WORKSPACE_TOOL_NAMES, WORKSPACE_TOOL_NAME_SET } from './workspace-tools';
import {
  createDeferred,
  createPiHarness,
  finishProductionProposal,
  publishPackageProposal,
  publisherContract,
  reviewerContract,
  sampleTurnInput,
  sendMessageProposal,
} from './test-support';

const tempRoots: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pi-runtime-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('adapter configuration (plan Phase E Task 2: five production + three workspace + one section tool)', () => {
  it('creates an in-memory Pi session with exactly nine custom tools', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(harness.sessionOptions.sessionManager.isPersisted()).toBe(false);
    expect(harness.sessionOptions.noTools).toBe('builtin');
    const names = harness.sessionOptions.customTools.map((tool) => tool.name);
    expect(names).toHaveLength(
      FORGE_ACTION_NAMES.length + WORKSPACE_TOOL_NAMES.length + SKILL_SECTION_TOOL_NAMES.length,
    );
    expect(names.sort()).toEqual(
      [...FORGE_ACTION_NAMES, ...WORKSPACE_TOOL_NAMES, ...SKILL_SECTION_TOOL_NAMES].sort(),
    );
    expect(harness.settings.getCompactionEnabled()).toBe(true);
    expect(harness.settings.getRetryEnabled()).toBe(false);
    // Phase 3 (within-turn context compression): Pi auto-compaction is on and
    // the runtime explicitly enables it on the live session.
    expect(harness.session.autoCompactionCalls).toContain(true);
  });

  it('splits the custom tools into the production, workspace and section sets', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    const names = harness.sessionOptions.customTools.map((tool) => tool.name);
    const production = names.filter((name) => FORGE_ACTION_NAME_SET.has(name as never));
    const workspace = names.filter((name) => WORKSPACE_TOOL_NAME_SET.has(name as never));
    const sections = names.filter((name) =>
      (SKILL_SECTION_TOOL_NAMES as readonly string[]).includes(name),
    );
    expect(production.sort()).toEqual(Array.from(FORGE_ACTION_NAMES).sort());
    expect(workspace.sort()).toEqual([...WORKSPACE_TOOL_NAMES].sort());
    expect(sections.sort()).toEqual([...SKILL_SECTION_TOOL_NAMES].sort());
    // The three sets are disjoint and cover every custom tool.
    expect(production.length + workspace.length + sections.length).toBe(names.length);
  });

  it('injects a temp-root WorkspaceStore into the runtime via the harness', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    expect(harness.workspaces).toBeDefined();
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    // The workspace tools really write through the injected store.
    const list = harness.sessionOptions.customTools.find((tool) => tool.name === 'list_workspace');
    expect(list).toBeDefined();
  });

  it('disables prompt template expansion and forwards the turn input verbatim', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    const input = sampleTurnInput({ inputText: 'neutral verbatim input' });
    await harness.runtime.run(input, freshSignal());
    // The turn input rides verbatim; the text-only reply leaves the phase
    // incomplete, so the bounded corrective nudges follow — every prompt
    // call keeps template expansion disabled.
    expect(harness.session.promptCalls[0]).toEqual({
      text: 'neutral verbatim input',
      options: { expandPromptTemplates: false },
    });
    expect(harness.session.promptCalls).toHaveLength(1 + MAX_CORRECTIVE_NUDGES);
    for (const call of harness.session.promptCalls) {
      expect(call.options).toEqual({ expandPromptTemplates: false });
    }
    expect(harness.session.promptCalls[1].text).toContain('finish_production');
  });

  it('resolves the frozen agent model spec through the injected resolver', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(harness.resolvedModelSpecs).toEqual(['configured/test-model']);
    expect(harness.sessionOptions.model.provider).toBe('configured');
    expect(harness.sessionOptions.model.id).toBe('test-model');
  });

  it('exposes a resource loader with zero discovered resources and the frozen system prompt', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    const input = sampleTurnInput();
    await harness.runtime.run(input, freshSignal());
    const loader = harness.sessionOptions.resourceLoader;
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getSkills().diagnostics).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSystemPrompt()).toBe(input.agent.systemPrompt);
  });

  it('creates a fresh in-memory session for every run', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    await harness.runtime.run(sampleTurnInput({ turnId: 'turn-2' }), freshSignal());
    expect(harness.sessionCount).toBe(2);
    const [first, second] = harness.sessionOptionsList;
    expect(first.sessionManager.isPersisted()).toBe(false);
    expect(second.sessionManager.isPersisted()).toBe(false);
    expect(first.sessionManager).not.toBe(second.sessionManager);
    expect(first.sessionManager.getSessionId()).not.toBe(second.sessionManager.getSessionId());
  });

  it('parses provider/model specs and rejects malformed ones', () => {
    expect(parsePiModelSpec('configured/test-model'))
      .toEqual({ providerId: 'configured', modelId: 'test-model' });
    expect(parsePiModelSpec('gateway/deep/model-id'))
      .toEqual({ providerId: 'gateway', modelId: 'deep/model-id' });
    for (const bad of ['', 'no-slash', '/leading', 'trailing/']) {
      expect(() => parsePiModelSpec(bad)).toThrowError(PI_RUNTIME_ERROR_CODES.MODEL_SPEC_INVALID);
    }
  });
});

describe('turn completion', () => {
  it('returns public text, buffered actions and usage for a successful turn', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          {
            name: 'finish_production',
            args: { source: 'inline', files: [{ name: 'content.md', content: 'sealed body' }], format: 'text' },
          },
          { name: 'send_message', args: { targetAgentId: 'agent-beta', summary: 'neutral coordination message' } },
        ],
        text: 'public final answer',
        usage: { input: 12, output: 34 },
      }],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(result.turnId).toBe('turn-1');
    expect(result.publicText).toBe('public final answer');
    expect(result.actions).toEqual([
      finishProductionProposal({ files: [{ name: 'content.md', content: 'sealed body' }], format: 'text' }),
      sendMessageProposal(),
    ]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
  });

  it('preserves proposal order across multiple tool calls', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          {
            name: 'finish_production',
            args: { source: 'inline', files: [{ name: 'content.md', content: 'sealed' }], format: 'text' },
          },
          { name: 'send_message', args: { targetAgentId: 'agent-beta', summary: 'neutral coordination message' } },
        ],
        text: 'done',
      }],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(result.actions.map((action) => action.type))
      .toEqual(['finish_production', 'send_message']);
  });

  it('returns null usage when the provider reports none', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      // One entry per prompt: the text-only replies draw the two corrective
      // nudges, and none of the responses reports usage.
      script: [
        { text: 'done', omitUsage: true },
        { text: 'done', omitUsage: true },
        { text: 'done', omitUsage: true },
      ],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(result.usage).toBeNull();
  });

  it('keeps invalid proposals out of the buffer without failing the turn', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          {
            name: 'finish_production',
            args: { source: 'inline', files: [{ name: 'content.md', content: 'sealed' }], format: 'text' },
          },
          { name: 'send_message', args: { targetAgentId: '', summary: 'neutral coordination message' } },
          { name: 'send_message', args: { targetAgentId: 'agent-beta', summary: 'neutral coordination message' } },
        ],
        text: 'done',
      }],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(result.actions).toEqual([
      finishProductionProposal({ files: [{ name: 'content.md', content: 'sealed' }], format: 'text' }),
      sendMessageProposal(),
    ]);
    const rejected = harness.toolExecutions[1];
    expect(rejected.resultText).toContain('rejected');
    expect(rejected.resultText).toContain('ACTION_FIELD_INVALID');
  });
});

describe('workspace write gating once sealed (review F1)', () => {
  it('rejects write_workspace after finish_production so the resolved content stays sealed', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          { name: 'write_workspace', args: { path: 'draft/v1.md', content: '封存时刻内容' } },
          {
            name: 'finish_production',
            args: {
              source: 'workspace_file',
              files: [{ name: 'v1.md', workspaceFile: 'draft/v1.md' }],
              format: 'text',
              artifactType: 'draft',
              title: '草稿',
            },
          },
          // The model tries to mutate the sealed file in the same turn.
          { name: 'write_workspace', args: { path: 'draft/v1.md', content: '封存后篡改' } },
          { name: 'publish_artifact', args: {} },
        ],
        text: 'done',
      }],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());

    const lateWrite = harness.toolExecutions.find(
      (execution) =>
        execution.name === 'write_workspace' && execution.args.content === '封存后篡改',
    );
    expect(lateWrite?.accepted).toBe(false);
    expect(lateWrite?.resultText).toContain('WORKSPACE_WRITE_AFTER_SEAL');

    // The store still carries exactly the content sealed by finish_production,
    // so the runner's pre-commit resolution commits the sealed-at content.
    expect(await harness.workspaces.readFile('task-1', 'agent-alpha', 'draft/v1.md'))
      .toBe('封存时刻内容');
    expect(result.actions.map((action) => action.type))
      .toEqual(['finish_production', 'publish_artifact']);
  });
});

describe('failure and abort boundaries', () => {
  it('throws a typed RuntimeFailure and discards buffered actions when the prompt rejects', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          {
            name: 'finish_production',
            args: { source: 'inline', files: [{ name: 'content.md', content: 'lost' }], format: 'text' },
          },
          { name: 'send_message', args: { targetAgentId: 'agent-beta', summary: 'neutral coordination message' } },
        ],
        promptError: new Error('provider disconnected'),
      }],
    });
    await expect(harness.runtime.run(sampleTurnInput(), freshSignal()))
      .rejects.toMatchObject({
        name: 'RuntimeFailure',
        code: PI_RUNTIME_ERROR_CODES.PROVIDER_REQUEST_FAILED,
        retryable: true,
      });
    expect(harness.session.abortCount).toBe(1);
    expect(harness.session.disposeCount).toBe(1);
  });

  it('throws a typed failure when the provider stops with an error', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{ text: 'partial', stopReason: 'error', errorMessage: 'provider exploded' }],
    });
    await expect(harness.runtime.run(sampleTurnInput(), freshSignal()))
      .rejects.toMatchObject({
        name: 'RuntimeFailure',
        code: PI_RUNTIME_ERROR_CODES.PROVIDER_ERROR,
      });
  });

  it('throws a typed failure when no assistant response arrives', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{ noAssistant: true }],
    });
    await expect(harness.runtime.run(sampleTurnInput(), freshSignal()))
      .rejects.toMatchObject({ code: PI_RUNTIME_ERROR_CODES.PROVIDER_NO_RESPONSE });
  });

  it('surfaces a pre-aborted signal without creating a session', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    const controller = new AbortController();
    controller.abort();
    await expect(harness.runtime.run(sampleTurnInput(), controller.signal))
      .rejects.toBeInstanceOf(RuntimeAbortedError);
    expect(harness.sessionCount).toBe(0);
  });

  it('aborts and disposes the session when the signal fires mid turn', async () => {
    const deferred = createDeferred<void>();
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{ deferred, text: 'never returned' }],
    });
    const controller = new AbortController();
    const pending = harness.runtime.run(sampleTurnInput(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RuntimeAbortedError);
    expect(harness.session.abortCount).toBeGreaterThanOrEqual(1);
    expect(harness.session.disposeCount).toBe(1);
  });

  it('treats a provider-aborted final message as an abort', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{ text: 'cut short', stopReason: 'aborted' }],
    });
    await expect(harness.runtime.run(sampleTurnInput(), freshSignal()))
      .rejects.toBeInstanceOf(RuntimeAbortedError);
  });

  it('rejects a second concurrent turn for the same agent', async () => {
    const deferred = createDeferred<void>();
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      // The deferred text-only reply draws the two corrective nudges; every
      // scripted response keeps the same public text.
      script: [
        { deferred, text: 'first' },
        { text: 'first' },
        { text: 'first' },
      ],
    });
    const first = harness.runtime.run(sampleTurnInput(), freshSignal());
    await expect(harness.runtime.run(sampleTurnInput({ turnId: 'turn-2' }), freshSignal()))
      .rejects.toMatchObject({ code: PI_RUNTIME_ERROR_CODES.AGENT_TURN_ALREADY_RUNNING });
    deferred.resolve();
    await expect(first).resolves.toMatchObject({ publicText: 'first' });
  });

  it('disposeAgent aborts and disposes the live session', async () => {
    const deferred = createDeferred<void>();
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{ deferred, text: 'never returned' }],
    });
    const pending = harness.runtime.run(sampleTurnInput(), freshSignal());
    await harness.runtime.disposeAgent('task-1', 'agent-alpha');
    await expect(pending).rejects.toBeInstanceOf(RuntimeAbortedError);
    expect(harness.session.disposeCount).toBeGreaterThanOrEqual(1);
  });

  it('disposeAll prevents further turns', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    await harness.runtime.disposeAll();
    await expect(harness.runtime.run(sampleTurnInput(), freshSignal()))
      .rejects.toMatchObject({
        code: PI_RUNTIME_ERROR_CODES.RUNTIME_DISPOSED,
        retryable: false,
      });
  });
});

describe('public history replay and skill injection', () => {
  it('replays public history in chronological order before the prompt', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    const messages = harness.sessionOptions.sessionManager.buildSessionContext().messages;
    expect(messages[0].role).toBe('user');
    expect(JSON.stringify(messages[0])).toContain('neutral opening instruction');
    expect(messages[1].role).toBe('assistant');
    expect(JSON.stringify(messages[1])).toContain('neutral acknowledgement');
  });

  it('replays tool-role history as forge-owned context, not fabricated assistant turns', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    const input = sampleTurnInput({
      publicHistory: [
        { role: 'user', text: 'opening' },
        { role: 'assistant', text: 'calling a tool' },
        { role: 'tool', text: 'neutral tool result body' },
      ],
    });
    await harness.runtime.run(input, freshSignal());
    const messages = harness.sessionOptions.sessionManager.buildSessionContext().messages;
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain('neutral tool result body');
    const toolContext = messages.find((message) => JSON.stringify(message).includes('neutral tool result body'));
    // Forge-owned custom context message (user context at request time),
    // never a fabricated assistant turn.
    expect(toolContext?.role).toBe('custom');
  });

  it('injects available skill summaries and loaded skill contents as forge-owned prompt messages', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    const input = sampleTurnInput({
      availableSkills: [
        { id: 'skill-alpha', name: 'Skill Alpha', description: 'Neutral skill summary.' },
      ],
      loadedSkills: [{ id: 'skill-alpha', content: 'NEUTRAL_SKILL_BODY', versionHash: 'hash-1' }],
    });
    await harness.runtime.run(input, freshSignal());
    const context = JSON.stringify(harness.sessionOptions.sessionManager.buildSessionContext().messages);
    expect(context).toContain('skill-alpha');
    expect(context).toContain('Skill Alpha');
    expect(context).toContain('Neutral skill summary.');
    expect(context).toContain('NEUTRAL_SKILL_BODY');
    expect(context).toContain('hash-1');
  });
});

describe('hidden thinking and secret exclusion (plan Phase E Task 2 rewrite)', () => {
  const SENTINEL = 'SECRET_SENTINEL';
  const THINKING_MARKER = 'reasoning_content';

  it('keeps thinking out of every durable surface including the trace', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          {
            name: 'finish_production',
            args: { source: 'inline', files: [{ name: 'content.md', content: 'sealed' }], format: 'text' },
          },
          { name: 'publish_artifact', args: {} },
        ],
        text: 'public answer',
        extraContent: [{
          type: 'thinking',
          thinking: `${SENTINEL} hidden chain with ${THINKING_MARKER}`,
          thinkingSignature: 'sig-hidden-1',
        }],
        usage: { input: 3, output: 4 },
      }],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(result.publicText).toBe('public answer');
    // The public surface (publicText/actions/usage) never carries the sentinel.
    const publicOnly = JSON.stringify({
      publicText: result.publicText,
      actions: result.actions,
      usage: result.usage,
    });
    expect(publicOnly).not.toContain(SENTINEL);
    expect(publicOnly).not.toContain('thinkingSignature');
    // The durable trace never carries raw provider thinking (semantic audit
    // P0, plan 2026-08-07): only public text and tool steps survive.
    expect(JSON.stringify(result.trace)).not.toContain(SENTINEL);
    expect(JSON.stringify(result.trace)).not.toContain(THINKING_MARKER);
    expect(result.trace.map((entry) => entry.kind)).toEqual([
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'text',
    ]);
    expect(JSON.stringify(result.trace)).not.toContain('thinkingSignature');
  });

  it('keeps captured logs free of hidden sentinels', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        text: 'public answer',
        extraContent: [{ type: 'thinking', thinking: `${SENTINEL} ${THINKING_MARKER}`, thinkingSignature: 'sig-2' }],
      }],
    });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(harness.logs.length).toBeGreaterThan(0);
    for (const line of harness.logs) {
      expect(line).not.toContain(SENTINEL);
      expect(line).not.toContain(THINKING_MARKER);
    }
  });

  it('does not leak the raw provider failure cause', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{ promptError: new Error(`${SENTINEL} credential leak in raw cause`) }],
    });
    let caught: unknown;
    try {
      await harness.runtime.run(sampleTurnInput(), freshSignal());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeFailure);
    expect((caught as Error).message).not.toContain(SENTINEL);
    for (const line of harness.logs) {
      expect(line).not.toContain(SENTINEL);
    }
  });

  it('returns the frozen AgentTurnResult shape including the trace array', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{ text: 'public answer', usage: { input: 7, output: 9 } }],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(Object.keys(result).sort()).toEqual(['actions', 'publicText', 'trace', 'turnId', 'usage']);
    expect(Object.keys(result.usage ?? {}).sort()).toEqual(['inputTokens', 'outputTokens']);
    expect(Array.isArray(result.trace)).toBe(true);
  });
});

describe('turn trace capture (plan Phase E Task 2)', () => {
  it('orders a single turn trace as tool_call -> tool_result -> text', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      // The workspace-only reply leaves the phase incomplete, so the two
      // corrective nudges append their scripted text replies to the trace.
      script: [
        {
          toolCalls: [{ name: 'write_workspace', args: { path: 'draft/v1.md', content: '正文' } }],
          text: 'public final answer',
          extraContent: [{ type: 'thinking', thinking: 'planning the draft' }],
        },
        { text: 'correcting' },
        { text: 'correcting' },
      ],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    // Chronological: tools execute before the final message; the provider
    // thinking block is never durable, so only tool/text entries survive
    // (semantic audit P0, plan 2026-08-07).
    expect(result.trace.map((entry) => entry.kind))
      .toEqual(['tool_call', 'tool_result', 'text', 'text', 'text']);
    expect(result.trace[0]).toEqual({
      kind: 'tool_call',
      toolName: 'write_workspace',
      params: { path: 'draft/v1.md', content: '正文' },
    });
    expect(result.trace[1]).toMatchObject({ kind: 'tool_result', toolName: 'write_workspace' });
    expect((result.trace[1] as { text: string }).text).toContain('draft/v1.md');
    expect(result.trace[2]).toEqual({ kind: 'text', text: 'public final answer' });
  });

  it('keeps provider thinking out of the trace while keeping public text', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [
        {
          intermediateThinking: ['planning before tool one', 'reasoning between tools'],
          toolCalls: [{ name: 'write_workspace', args: { path: 'a.md', content: 'one' } }],
          text: 'final answer',
        },
        // Corrective-nudge replies: text-only.
        { text: 'correcting' },
        { text: 'correcting' },
      ],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    // The intermediate thinking blocks never reach the durable trace (the
    // trace carries only text + tool kinds; the sentinel markers stay absent).
    expect(result.trace.map((entry) => entry.kind)).toEqual([
      'tool_call',
      'tool_result',
      'text',
      'text',
      'text',
    ]);
    const texts = result.trace
      .filter((entry) => entry.kind === 'text')
      .map((entry) => (entry as { text: string }).text);
    expect(texts).toEqual(['final answer', 'correcting', 'correcting']);
  });

  it('collects an independent ordered trace for each of two turns', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      // Each run's fresh session replays the same script: the workspace-only
      // reply plus the two corrective-nudge replies.
      script: [
        {
          toolCalls: [{ name: 'write_workspace', args: { path: 'a.md', content: 'one' } }],
          text: 'turn reply',
          extraContent: [{ type: 'thinking', thinking: 'turn thinking' }],
        },
        { text: 'correcting' },
        { text: 'correcting' },
      ],
    });
    const first = await harness.runtime.run(sampleTurnInput({ turnId: 'turn-1' }), freshSignal());
    const second = await harness.runtime.run(sampleTurnInput({ turnId: 'turn-2' }), freshSignal());
    expect(first.trace.map((entry) => entry.kind))
      .toEqual(['tool_call', 'tool_result', 'text', 'text', 'text']);
    expect(second.trace.map((entry) => entry.kind))
      .toEqual(['tool_call', 'tool_result', 'text', 'text', 'text']);
    // The two traces are distinct array instances, not a shared reference.
    expect(first.trace).not.toBe(second.trace);
  });

  it('returns a text-only trace for a plain reply and an empty trace stays empty', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      // One entry per prompt: the plain replies draw the two corrective
      // nudges, and every assistant message stays text-only.
      script: [
        { text: 'just text' },
        { text: 'just text' },
        { text: 'just text' },
      ],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(result.trace).toEqual([
      { kind: 'text', text: 'just text' },
      { kind: 'text', text: 'just text' },
      { kind: 'text', text: 'just text' },
    ]);
  });

  it('captures production tool calls in the trace too', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          {
            name: 'finish_production',
            args: { source: 'inline', files: [{ name: 'content.md', content: 'sealed' }], format: 'text' },
          },
          { name: 'send_message', args: { targetAgentId: 'agent-beta', summary: 'neutral coordination message' } },
        ],
        text: 'routed',
      }],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(result.trace.map((entry) => entry.kind)).toEqual([
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'text',
    ]);
    expect(result.trace[4]).toEqual({ kind: 'text', text: 'routed' });
    expect(result.trace[2]).toEqual({
      kind: 'tool_call',
      toolName: 'send_message',
      params: { targetAgentId: 'agent-beta', summary: 'neutral coordination message' },
    });
  });
});

describe('forge tool factory', () => {
  it('creates exactly the closed registry tools', () => {
    const tools = createForgeToolDefinitions(new ActionBuffer('turn-tool'));
    expect(tools.map((tool) => tool.name).sort()).toEqual(Array.from(FORGE_ACTION_NAMES).sort());
  });

  it('validates and buffers a proposal, returning a short public acknowledgement', async () => {
    const buffer = new ActionBuffer('turn-tool');
    const tools = createForgeToolDefinitions(buffer);
    const finish = tools.find((tool) => tool.name === 'finish_production');
    const send = tools.find((tool) => tool.name === 'send_message');
    expect(finish).toBeDefined();
    expect(send).toBeDefined();
    const sealed = await finish?.execute(
      'tc-0',
      { source: 'inline', files: [{ name: 'content.md', content: 'sealed body' }], format: 'text' },
      undefined,
      undefined,
      {} as never,
    );
    expect(sealed?.content[0]?.type === 'text' && sealed.content[0].text).toContain('accepted');
    const result = await send?.execute(
      'tc-1',
      { targetAgentId: 'agent-beta', summary: 'neutral coordination message' },
      undefined,
      undefined,
      {} as never,
    );
    const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('accepted');
    expect(text).not.toContain('taskId');
    expect(text).not.toContain('version');
    expect(buffer.snapshot()).toEqual([
      finishProductionProposal({ files: [{ name: 'content.md', content: 'sealed body' }], format: 'text' }),
      sendMessageProposal(),
    ]);
  });

  it('rejects invalid proposals with a stable code and leaves the buffer untouched', async () => {
    const buffer = new ActionBuffer('turn-tool');
    const tools = createForgeToolDefinitions(buffer);
    const finish = tools.find((tool) => tool.name === 'finish_production');
    await finish?.execute(
      'tc-1',
      { source: 'inline', files: [{ name: 'content.md', content: 'sealed' }], format: 'text' },
      undefined,
      undefined,
      {} as never,
    );
    const send = tools.find((tool) => tool.name === 'send_message');
    const result = await send?.execute(
      'tc-2',
      { targetAgentId: '', summary: 'neutral coordination message' },
      undefined,
      undefined,
      {} as never,
    );
    const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('rejected');
    expect(text).toContain('ACTION_FIELD_INVALID');
    expect(buffer.snapshot()).toEqual([
      finishProductionProposal({ files: [{ name: 'content.md', content: 'sealed' }], format: 'text' }),
    ]);
  });

  it('rejects proposals once the buffer is sealed', async () => {
    const buffer = new ActionBuffer('turn-tool');
    buffer.succeed('sealed', null);
    const tools = createForgeToolDefinitions(buffer);
    const finish = tools.find((tool) => tool.name === 'finish_production');
    const result = await finish?.execute(
      'tc-3',
      { source: 'inline', files: [{ name: 'content.md', content: 'late' }], format: 'text' },
      undefined,
      undefined,
      {} as never,
    );
    const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('rejected');
    expect(text).toContain('BUFFER_NOT_OPEN');
  });

  it('returns the full skill content in load_skill when a reader is wired', async () => {
    const buffer = new ActionBuffer('turn-skill');
    const tools = createForgeToolDefinitions(buffer, {
      readSkillContent: async () => ({ content: 'SKILL_FULL_BODY', versionHash: 'a'.repeat(64) }),
    });
    const load = tools.find((tool) => tool.name === 'load_skill');
    const result = await load?.execute(
      'tc-skill-ok',
      { skillId: 'skill-alpha' },
      undefined,
      undefined,
      {} as never,
    );
    const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('SKILL_FULL_BODY');
    expect(text).toContain('@aaaa');
    expect(buffer.snapshot()).toEqual([{ type: 'load_skill', skillId: 'skill-alpha' }]);
  });

  it('rejects load_skill without proposing when the reader returns null', async () => {
    const buffer = new ActionBuffer('turn-skill');
    const tools = createForgeToolDefinitions(buffer, {
      readSkillContent: async () => null,
    });
    const load = tools.find((tool) => tool.name === 'load_skill');
    const result = await load?.execute(
      'tc-skill-null',
      { skillId: 'ghost-skill' },
      undefined,
      undefined,
      {} as never,
    );
    const details = (result as { details?: { accepted: boolean; code?: string } })?.details;
    expect(details).toMatchObject({ accepted: false, code: 'SKILL_NOT_AUTHORIZED' });
    expect(buffer.snapshot()).toEqual([]);
  });

  it('keeps the legacy short acknowledgement for load_skill when no reader is wired', async () => {
    const buffer = new ActionBuffer('turn-skill');
    const tools = createForgeToolDefinitions(buffer);
    const load = tools.find((tool) => tool.name === 'load_skill');
    const result = await load?.execute(
      'tc-skill-legacy',
      { skillId: 'skill-alpha' },
      undefined,
      undefined,
      {} as never,
    );
    const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toBe('load_skill proposal accepted');
    expect(buffer.snapshot()).toEqual([{ type: 'load_skill', skillId: 'skill-alpha' }]);
  });
});

describe('load_skill tool result carries the full skill body in-turn', () => {
  it('returns the wired skill body in the load_skill tool_result trace entry', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [{ name: 'load_skill', args: { skillId: 'skill-alpha' } }],
        text: 'acted on the loaded skill',
      }],
    });
    harness.runtime.setSkillContentReader(async () => ({
      content: 'SKILL_FULL_BODY',
      versionHash: 'a'.repeat(64),
    }));
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    const loadResult = result.trace.find(
      (entry) => entry.kind === 'tool_result' && entry.toolName === 'load_skill',
    );
    expect(loadResult).toBeDefined();
    expect((loadResult as { text: string }).text).toContain('SKILL_FULL_BODY');
  });
});

describe('read_skill_section tool wiring (plan 2026-08-07 Phase 1)', () => {
  it('rejects the section read with SKILL_SECTION_NOT_AUTHORIZED when no reader is wired', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          { name: 'read_skill_section', args: { skillId: 'skill-alpha', sectionPath: 'a.md' } },
        ],
        text: 'acted on nothing',
      }],
    });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    const execution = harness.toolExecutions.find((entry) => entry.name === 'read_skill_section');
    expect(execution?.accepted).toBe(false);
    expect(execution?.resultText).toContain('SKILL_SECTION_NOT_AUTHORIZED');
  });

  it('returns the wired section body in the tool result and trace', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          { name: 'read_skill_section', args: { skillId: 'skill-alpha', sectionPath: 'a.md' } },
        ],
        text: 'acted on the section',
      }],
    });
    harness.runtime.setSkillSectionReader(async (_taskId, _agentId, _skillId, _sectionPath) => ({
      content: 'SECTION_BODY',
      versionHash: 'v1',
    }));
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    const execution = harness.toolExecutions.find((entry) => entry.name === 'read_skill_section');
    expect(execution?.accepted).toBe(true);
    expect(execution?.resultText).toContain('SECTION_BODY');
    const traceEntry = result.trace.find(
      (entry) => entry.kind === 'tool_result' && entry.toolName === 'read_skill_section',
    );
    expect(traceEntry).toBeDefined();
    expect((traceEntry as { text: string }).text).toContain('SECTION_BODY');
  });

  it('passes a typed RuntimeFailure through to the rejected acknowledgement', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [
          { name: 'read_skill_section', args: { skillId: 'skill-alpha', sectionPath: 'a.md' } },
        ],
        text: 'no section',
      }],
    });
    harness.runtime.setSkillSectionReader(async () => {
      throw new RuntimeFailure('SKILL_SECTION_MISSING', 'section missing', false);
    });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    const execution = harness.toolExecutions.find((entry) => entry.name === 'read_skill_section');
    expect(execution?.accepted).toBe(false);
    expect(execution?.resultText).toContain('SKILL_SECTION_MISSING');
  });
});

describe('no-discovery resource loader', () => {
  it('constructs a loader with zero discovered resources even with decoy files present', async () => {
    const cwd = tempCwd();
    writeFileSync(join(cwd, 'AGENTS.md'), 'decoy context file');
    mkdirSync(join(cwd, 'skills', 'decoy'), { recursive: true });
    writeFileSync(join(cwd, 'skills', 'decoy', 'SKILL.md'), '---\nname: decoy\n---\ndecoy body');
    const loader = await createForgeResourceLoader({
      cwd,
      agentDir: join(cwd, '.forge-agent'),
      systemPrompt: 'frozen system prompt',
    });
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSystemPrompt()).toBe('frozen system prompt');
  });

  it('fails loud when a loader has discovered resources', async () => {
    const cwd = tempCwd();
    writeFileSync(join(cwd, 'AGENTS.md'), 'discovered context file');
    const leaking = new DefaultResourceLoader({ cwd, agentDir: join(cwd, '.forge-agent') });
    await leaking.reload();
    expect(leaking.getAgentsFiles().agentsFiles.length).toBeGreaterThan(0);
    expect(() => assertNoDiscoveredResources(leaking))
      .toThrowError(PI_RUNTIME_ERROR_CODES.RESOURCE_DISCOVERY_LEAK);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(true);
  });
});

describe('runtime type surface', () => {
  it('implements the frozen AgentRuntime contract', () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    const runtime: PiAgentRuntime = harness.runtime;
    expect(typeof runtime.run).toBe('function');
    expect(typeof runtime.disposeAgent).toBe('function');
    expect(typeof runtime.disposeAll).toBe('function');
  });
});

describe('live streaming patches (plan C realtime streaming)', () => {
  it('streams cumulative public text patches around tool calls and ends with finished', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        streaming: { thinkingChunks: ['hmm'], textChunks: ['he', 'llo'] },
        // Finish + dispatch complete the phase, so no corrective nudge runs
        // and the patch stream stays exactly the scripted shape. Provider
        // thinking is never streamed to the live buffer (semantic audit P0).
        toolCalls: [
          {
            name: 'finish_production',
            args: { source: 'inline', files: [{ name: 'content.md', content: 'sealed body' }], format: 'text' },
          },
          { name: 'publish_artifact', args: {} },
        ],
        text: 'hello',
      }],
    });
    const patches: Array<Record<string, unknown>> = [];
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal(), {
      onLive: (patch) => patches.push({ ...patch }),
    });
    expect(result.publicText).toBe('hello');
    expect(patches).toEqual([
      { agentId: 'agent-alpha', turnId: 'turn-1', text: '' },
      { agentId: 'agent-alpha', turnId: 'turn-1', text: 'he' },
      { agentId: 'agent-alpha', turnId: 'turn-1', text: 'hello' },
      { agentId: 'agent-alpha', turnId: 'turn-1', toolStarted: 'finish_production' },
      { agentId: 'agent-alpha', turnId: 'turn-1', toolFinished: 'finish_production' },
      { agentId: 'agent-alpha', turnId: 'turn-1', toolStarted: 'publish_artifact' },
      { agentId: 'agent-alpha', turnId: 'turn-1', toolFinished: 'publish_artifact' },
      { agentId: 'agent-alpha', turnId: 'turn-1', finished: true },
    ]);
  });

  it('emits the finished patch when the provider request fails', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{ promptError: new Error('provider down'), text: 'never' }],
    });
    const patches: Array<Record<string, unknown>> = [];
    await expect(
      harness.runtime.run(sampleTurnInput(), freshSignal(), {
        onLive: (patch) => patches.push({ ...patch }),
      }),
    ).rejects.toThrowError(PI_RUNTIME_ERROR_CODES.PROVIDER_REQUEST_FAILED);
    expect(patches).toEqual([{ agentId: 'agent-alpha', turnId: 'turn-1', finished: true }]);
  });

  it('emits the finished patch when the turn is aborted mid-flight', async () => {
    const deferred = createDeferred<void>();
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{ deferred, text: 'never streamed' }],
    });
    const controller = new AbortController();
    const patches: Array<Record<string, unknown>> = [];
    const runPromise = harness.runtime.run(sampleTurnInput(), controller.signal, {
      onLive: (patch) => patches.push({ ...patch }),
    });
    await controller.abort();
    deferred.resolve();
    await expect(runPromise).rejects.toThrowError(RuntimeAbortedError);
    expect(patches).toEqual([{ agentId: 'agent-alpha', turnId: 'turn-1', finished: true }]);
  });

  it('runs unchanged when no onLive sink is supplied', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      // One entry per prompt: the text-only replies draw the two corrective
      // nudges; the final public text stays the scripted one.
      script: [
        { streaming: { textChunks: ['he', 'llo'] }, text: 'hello' },
        { text: 'hello' },
        { text: 'hello' },
      ],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(result.publicText).toBe('hello');
  });
});

describe('corrective nudge loop (plan 2026-08-06)', () => {
  const finishOnlyCall = {
    name: 'finish_production',
    args: { source: 'inline', files: [{ name: 'content.md', content: 'sealed body' }], format: 'text' },
  };
  const publishCall = {
    name: 'publish_artifact',
    args: {},
  };

  it('seals the reminder text: generic for null contracts, contract-named otherwise', () => {
    const generic = sealedPhaseReminder(null);
    expect(generic).toContain('send_message');
    expect(generic).toContain('publish_artifact');
    expect(generic).toContain('submit_final_artifact');
    expect(generic).toContain('request_human_input');

    const publisher = sealedPhaseReminder(publisherContract('agent-beta'));
    expect(publisher).toContain('publish_artifact');
    expect(publisher).toContain('request_human_input');
    expect(publisher).not.toContain('send_message');
    expect(publisher).not.toContain('submit_final_artifact');

    const reviewer = sealedPhaseReminder(reviewerContract('agent-alpha'));
    expect(reviewer).toContain('send_message');
    expect(reviewer).toContain('submit_final_artifact');
    expect(reviewer).not.toContain('publish_artifact');
  });

  it('re-prompts a text-only turn at most MAX_CORRECTIVE_NUDGES times', async () => {
    expect(MAX_CORRECTIVE_NUDGES).toBe(2);
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [
        { text: 'I wrote the content.', usage: { input: 10, output: 20 } },
        { text: 'Still just talking.', usage: { input: 10, output: 20 } },
        { text: 'Talking again.', usage: { input: 10, output: 20 } },
      ],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    // One initial prompt plus exactly MAX_CORRECTIVE_NUDGES corrective nudges.
    expect(harness.session.promptCalls).toHaveLength(1 + MAX_CORRECTIVE_NUDGES);
    expect(harness.session.promptCalls[1].text).toContain('finish_production');
    // The Turn still completes; the empty action set is the runner's problem.
    expect(result.publicText).toBe('Talking again.');
    expect(result.actions).toEqual([]);
  });

  it('stops nudging once the turn completes its dispatch', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [
        { text: 'Content without actions.', usage: { input: 10, output: 20 } },
        { toolCalls: [finishOnlyCall, publishCall], text: 'done', usage: { input: 10, output: 20 } },
      ],
    });
    const result = await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(harness.session.promptCalls).toHaveLength(2);
    expect(result.actions).toEqual([
      finishProductionProposal({ files: [{ name: 'content.md', content: 'sealed body' }], format: 'text' }),
      publishPackageProposal(),
    ]);
  });

  it('the sealed-phase reminder names only the contract-allowed dispatch actions', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [
        { toolCalls: [finishOnlyCall], text: 'sealed, not dispatched', usage: { input: 10, output: 20 } },
        { text: 'Still hesitating.', usage: { input: 10, output: 20 } },
        { toolCalls: [publishCall], text: 'done', usage: { input: 10, output: 20 } },
      ],
    });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    expect(harness.session.promptCalls).toHaveLength(3);
    const nudge = harness.session.promptCalls[1].text;
    // sampleTurnInput carries the publisher contract: publish_artifact is the
    // only allowed dispatch, plus the always-legal request_human_input.
    expect(nudge).toContain('publish_artifact');
    expect(nudge).toContain('request_human_input');
    expect(nudge).not.toContain('send_message');
  });

  it('falls back to the generic sealed reminder when the contract is null', async () => {
    const input = sampleTurnInput();
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [
        { toolCalls: [finishOnlyCall], text: 'sealed', usage: { input: 10, output: 20 } },
        { text: 'Hesitating.', usage: { input: 10, output: 20 } },
        { toolCalls: [publishCall], text: 'done', usage: { input: 10, output: 20 } },
      ],
    });
    await harness.runtime.run(
      sampleTurnInput({ agent: { ...input.agent, turnContract: null } }),
      freshSignal(),
    );
    const nudge = harness.session.promptCalls[1].text;
    expect(nudge).toContain('send_message');
    expect(nudge).toContain('submit_final_artifact');
  });
});

describe('validate_artifact tool wiring (plan 2026-08-07 Phase 2, spec §4.4)', () => {
  /** The sample turn agent with a declared self_check gate. */
  function gatedTurnInput() {
    return sampleTurnInput({
      agent: {
        ...sampleTurnInput().agent,
        gate: {
          validator: 'gates/validate.cjs',
          artifactType: 'chapter_markdown',
          mode: ['self_check'],
        },
      },
    });
  }

  const stubGateRunner = {
    run: async () => ({ pass: true, issues: [] }),
  } as unknown as GateRunner;

  it('keeps the closed tool set when the agent declares no gate', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    await harness.runtime.run(sampleTurnInput(), freshSignal());
    const names = harness.sessionOptions.customTools.map((tool) => tool.name);
    expect(names).not.toContain('validate_artifact');
    expect(names).toHaveLength(
      FORGE_ACTION_NAMES.length + WORKSPACE_TOOL_NAMES.length + SKILL_SECTION_TOOL_NAMES.length,
    );
  });

  it('registers validate_artifact when the gate includes self_check and a runner is wired', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    harness.runtime.setGateRunner(stubGateRunner);
    await harness.runtime.run(gatedTurnInput(), freshSignal());
    const names = harness.sessionOptions.customTools.map((tool) => tool.name);
    expect(names).toContain('validate_artifact');
    expect(names).toHaveLength(
      FORGE_ACTION_NAMES.length + WORKSPACE_TOOL_NAMES.length + SKILL_SECTION_TOOL_NAMES.length + 1,
    );
  });

  it('registers no validate_artifact when the gate runner is not wired', async () => {
    const harness = createPiHarness({ coreCwd: tempCwd() });
    await harness.runtime.run(gatedTurnInput(), freshSignal());
    const names = harness.sessionOptions.customTools.map((tool) => tool.name);
    expect(names).not.toContain('validate_artifact');
    expect(names).toHaveLength(
      FORGE_ACTION_NAMES.length + WORKSPACE_TOOL_NAMES.length + SKILL_SECTION_TOOL_NAMES.length,
    );
  });

  it('executes validate_artifact through the harness and proposes nothing', async () => {
    const harness = createPiHarness({
      coreCwd: tempCwd(),
      script: [{
        toolCalls: [{ name: 'validate_artifact', args: { source: 'inline', content: 'clean' } }],
        text: 'checked',
      }],
    });
    harness.runtime.setGateRunner(stubGateRunner);
    const result = await harness.runtime.run(gatedTurnInput(), freshSignal());
    const execution = harness.toolExecutions.find((entry) => entry.name === 'validate_artifact');
    expect(execution?.accepted).toBe(true);
    expect(execution?.resultText).toContain('"pass":true');
    // Read-only: the validator run never proposes anything to the buffer.
    expect(result.actions).toEqual([]);
  });
});
