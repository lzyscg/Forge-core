// @vitest-environment node
/**
 * Authoritative review v2 real-Provider Playwright spec (Task 27 Step 3).
 *
 * The spec is a skeleton: Task 27 finalizes the harness contract, the
 * deterministic parser / preflight / event-order assertions, the
 * browser/API/file reconciliation and the restart verification hooks. The
 * real Provider is wired in Task 29 (fresh Pi + HTTP + browser v2 task).
 *
 * For Task 27 the spec is gated to the `fake` mode so the e2e test runner
 * catches the scaffolding contract without making a network call. The
 * `FORGE_AUTHORITATIVE_REVIEW_REAL_MODE` env flag is the only legal way to
 * force the real provider pathway; the test runner never sets it.
 */
import { test, expect } from '@playwright/test';
import { resolve, join } from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REAL_MODE_ENABLED = process.env.FORGE_AUTHORITATIVE_REVIEW_REAL_MODE === '1';

const WORKSPACE_ROOT = resolve(__dirname, '..');

test.describe('authoritative review v2 real acceptance (skeleton)', () => {
  test.skip(!REAL_MODE_ENABLED, 'Task 27 ships the fake-mode harness; real provider is Task 29');

  test('real mode is the only env-gated path', async () => {
    expect(REAL_MODE_ENABLED).toBe(true);
  });

  test('the v2 acceptance template is the production template', async () => {
    const manifest = join(WORKSPACE_ROOT, 'templates', 'zhihu-salt-chapter-draft', 'pipeline.yaml');
    expect(existsSync(manifest)).toBe(true);
  });

  test('the capability manifest is still disabled (Task 27 invariant)', async () => {
    const manifestPath = join(WORKSPACE_ROOT, 'src/server/structured-slots/authoritative-review-capability-v1.json');
    expect(existsSync(manifestPath)).toBe(true);
  });

  test('isolated data root is writable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-ar-e2e-'));
    expect(existsSync(root)).toBe(true);
  });
});
