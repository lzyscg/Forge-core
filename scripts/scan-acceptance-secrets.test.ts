// @vitest-environment node
/**
 * Acceptance secret scanner and report sanitizer (plan Phase D Task 2 Step 7).
 *
 * Pins the redaction contract BEFORE any implementation exists:
 *
 * - `sanitizeAcceptanceReport` removes configured secret sentinels and
 *   hidden-thinking shaped fields from reports (plan Step 1 verbatim case);
 * - the recursive scanner reports ONLY path + finding category for secret
 *   sentinels, auth header shapes, PEM/private-key blocks, known env
 *   assignments and hidden-thinking field NAMES — never the matched text;
 * - a clean tree yields zero findings.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  scanForAcceptanceSecrets,
  sanitizeAcceptanceReport,
  type SecretFinding,
} from './scan-acceptance-secrets';

const createdRoots: string[] = [];

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Plan Step 1 fixture: a report carrying a sentinel and hidden-thinking field. */
function reportWithSentinels(): Record<string, unknown> {
  return {
    schemaVersion: 'forge-core.real-acceptance/1',
    outcome: 'completed',
    note: 'configured sentinel SECRET_SENTINEL leaked here',
    nested: {
      reasoning_content: 'hidden chain-of-thought that must never surface',
      deep: { list: ['SECRET_SENTINEL again', 'public fact'] },
    },
    providerId: 'deepseek',
    secretFindingCount: 0,
  };
}

describe('sanitizeAcceptanceReport', () => {
  it('removes configured secret and hidden-thinking shaped fields from reports', () => {
    const sanitized = sanitizeAcceptanceReport(reportWithSentinels());
    expect(JSON.stringify(sanitized)).not.toContain('SECRET_SENTINEL');
    expect(JSON.stringify(sanitized)).not.toContain('reasoning_content');
  });

  it('keeps public facts intact while redacting secrets at any depth', () => {
    const sanitized = sanitizeAcceptanceReport(reportWithSentinels()) as Record<string, unknown>;
    expect(sanitized.schemaVersion).toBe('forge-core.real-acceptance/1');
    expect(sanitized.outcome).toBe('completed');
    expect(sanitized.providerId).toBe('deepseek');
    expect(sanitized.secretFindingCount).toBe(0);
    const nested = sanitized.nested as Record<string, unknown>;
    expect(nested).toBeDefined();
    const list = (nested as { deep: { list: unknown[] } }).deep.list;
    // The public list entry survives; the sentinel entry is redacted, not removed.
    expect(list).toContain('public fact');
    expect(JSON.stringify(list)).not.toContain('SECRET_SENTINEL');
    // The sanitizer never mutates its input.
    expect(JSON.stringify(reportWithSentinels())).toContain('SECRET_SENTINEL');
  });

  it('redacts credential-shaped strings and explicit sentinels', () => {
    const report = {
      header: 'Authorization: Bearer abc123.def456',
      assignment: 'DEEPSEEK_API_KEY=some-configured-value',
      keyLike: 'sk-abcdef1234567890',
      pem: '-----BEGIN RSA PRIVATE KEY-----',
      customSentinel: 'my-in-memory-sentinel-value',
      clean: 'deepseek/writer-model',
    };
    const sanitized = sanitizeAcceptanceReport(report, ['my-in-memory-sentinel-value']) as Record<
      string,
      unknown
    >;
    expect(sanitized.clean).toBe('deepseek/writer-model');
    for (const field of ['header', 'assignment', 'keyLike', 'pem', 'customSentinel']) {
      expect(sanitized[field]).toBe('[redacted]');
    }
  });

  it('drops every hidden-thinking shaped key regardless of depth or case', () => {
    const sanitized = sanitizeAcceptanceReport({
      thinking: 'x',
      redacted_thinking: 'y',
      thinkingSignature: 'z',
      thoughtSignature: 'w',
      reasoning: 'v',
      wrapper: { Reasoning_Content: 'hidden', kept: 1 },
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(sanitized);
    for (const marker of [
      'thinking',
      'redacted_thinking',
      'thinkingSignature',
      'thoughtSignature',
      'reasoning',
      'Reasoning_Content',
    ]) {
      expect(serialized).not.toContain(marker);
    }
    expect((sanitized.wrapper as Record<string, unknown>).kept).toBe(1);
  });
});

describe('scanForAcceptanceSecrets', () => {
  it('finds every secret shape by path and category without the matched text', async () => {
    const root = freshRoot('forge-secret-scan-');
    mkdirSync(join(root, 'nested'), { recursive: true });
    const bearerSecret = 'Bearer eyJhbGciOi.fake-token-value';
    writeFileSync(join(root, 'request.log'), `GET /api/tasks 200\n${bearerSecret}\n`, 'utf8');
    writeFileSync(join(root, 'nested', 'header.txt'), 'Authorization: Token abc.def\n', 'utf8');
    writeFileSync(join(root, 'key.pem'), '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n', 'utf8');
    writeFileSync(join(root, 'env-copy.txt'), 'DEEPSEEK_API_KEY=configured-example-value\n', 'utf8');
    writeFileSync(join(root, 'sk.txt'), 'the key sk-abcdef1234567890 rotated\n', 'utf8');
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify({ content: 'public', reasoning_content: 'hidden thoughts' }),
      'utf8',
    );
    writeFileSync(join(root, 'config.yaml'), 'model: deepseek/chat\nthinking: enabled\n', 'utf8');

    const findings = await scanForAcceptanceSecrets([root]);
    const byFile = new Map(findings.map((finding) => [finding.path, finding.category]));
    expect(byFile.get('request.log')).toBe('auth_header');
    expect(byFile.get('nested/header.txt')).toBe('auth_header');
    expect(byFile.get('key.pem')).toBe('pem_private_key');
    expect(byFile.get('env-copy.txt')).toBe('env_assignment');
    expect(byFile.get('sk.txt')).toBe('env_assignment');
    expect(byFile.get('result.json')).toBe('hidden_thinking_key');
    expect(byFile.get('config.yaml')).toBe('hidden_thinking_key');

    // Findings carry ONLY path + category — never the matched secret text.
    const serialized = JSON.stringify(findings);
    for (const marker of [
      'eyJhbGciOi.fake-token-value',
      'Token abc.def',
      'MIIE',
      'configured-example-value',
      'sk-abcdef1234567890',
      'hidden thoughts',
    ]) {
      expect(serialized).not.toContain(marker);
    }
    for (const finding of findings) {
      expect(Object.keys(finding).sort()).toEqual(['category', 'path']);
    }
  });

  it('flags configured in-memory secret sentinels without echoing them', async () => {
    const root = freshRoot('forge-secret-sentinel-');
    const sentinel = 'in-memory-configured-sentinel-9f3c';
    writeFileSync(join(root, 'leak.log'), `prefix ${sentinel} suffix\n`, 'utf8');
    writeFileSync(join(root, 'clean.txt'), 'nothing to see here\n', 'utf8');

    const findings = await scanForAcceptanceSecrets([root], { sentinels: [sentinel] });
    expect(findings).toEqual([{ path: 'leak.log', category: 'sentinel' }]);
    expect(JSON.stringify(findings)).not.toContain(sentinel);
  });

  it('reports zero findings on a clean tree', async () => {
    const root = freshRoot('forge-secret-clean-');
    mkdirSync(join(root, 'tasks'), { recursive: true });
    writeFileSync(join(root, 'tasks', 'task.json'), JSON.stringify({ id: 'task-1', status: 'completed' }), 'utf8');
    writeFileSync(join(root, 'report.md'), '# 验收报告\n\n公开结论：通过。\n', 'utf8');
    const findings = await scanForAcceptanceSecrets([root]);
    expect(findings).toEqual([]);
  });

  it('scans individual report files as well as directory roots', async () => {
    const root = freshRoot('forge-secret-file-');
    const reportFile = join(root, 'phase-d-real.json');
    writeFileSync(reportFile, JSON.stringify({ note: 'Authorization: Bearer leaked-token-value' }), 'utf8');
    const findings = await scanForAcceptanceSecrets([reportFile]);
    expect(findings).toEqual([{ path: 'phase-d-real.json', category: 'auth_header' }]);
  });
});
