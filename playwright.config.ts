import { defineConfig, devices } from '@playwright/test';

/**
 * Phase A browser gate (plan Task 8). The webServer entry boots the vite dev
 * server on a fixed port; two viewport projects — desktop 1440×1000 and mobile
 * 390×844 — run the same specs against it. Playwright already isolates every
 * test in its own browser context (fresh localStorage), and each spec clears
 * only the documented `forge-core:mock:v1:*` namespace before its flow.
 *
 * Expect timeouts are generous (30s) because the deterministic demonstration
 * plays through ~8s of 450–900ms step delays. Per-test artifacts (traces,
 * failure screenshots) land in test-results/artifacts — a subdirectory of the
 * gitignored test-results/ — so the semantic screenshots written into
 * test-results/ui-evidence survive the two separate playwright invocations
 * that scripts/verify-ui.ts performs (each invocation cleans only outputDir).
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/artifacts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'mobile chromium',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    // Runs from the config directory (apps/forge-core). --host pins vite to
    // the IPv4 loopback so it matches the baseURL Playwright polls (without
    // it vite binds ::1 only on this machine). vite serves the public/
    // evidence file and the client at the same origin Playwright targets.
    command: 'npm exec vite -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
