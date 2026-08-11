/**
 * Subprocess canonical-json perf/RSS regression (Task 19 remediation Task A).
 *
 * Root cause locked: `serializeString` in
 * `src/server/structured-slots/canonical-json.ts` builds the serialized string
 * with per-character `out +=`, so a large content root makes V8 accumulate a
 * giant rope (one ConsString concat node per character) that blows up peak RSS
 * and the eventual flatten cost. Measured on this host:
 *
 *   payload    peak RSS (osMaxRssBytes)   wall (canonicalJsonSha256 once)
 *   8 MiB      392 MB                      336 ms
 *   16 MiB     693 MB                      654 ms
 *   32 MiB     1.36 GB                     1.59 s
 *
 * A native single-pass JSON encode + Buffer + sha256 of a 64 MiB payload is
 * ~173 ms / ~380 MB RSS, so the 512 MiB gate is reachable after the fix.
 *
 * The child (scripts/canonical-json-probe.ts) runs in a FRESH process under the
 * tsx CLI (the same spawn pattern as the benchmark harness's alloc-probe) and
 * reports its own OS high-water mark (`osMaxRssBytes`). The large-payload test
 * FAILS on the current code (32 MiB peaks above the 1 GiB guard) — that RED is
 * the regression lock that Tasks B/C/D must turn green. The small-payload
 * sanity test must PASS before AND after (the fast path must not regress).
 *
 * This is a test-only file; it changes no production behavior.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

interface CanonicalJsonProbeResult {
  event: 'canonical-json-probe';
  bytes: number;
  payloadBytes: number;
  wallMs: number;
  peakRssBytes: number;
  digest: string;
}

/** Spawns the probe child for one payload and returns its parsed single line. */
function runProbe(payloadBytes: number): CanonicalJsonProbeResult {
  const tsxCli = resolve(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const scriptPath = resolve(SCRIPT_DIR, 'canonical-json-probe.ts');
  const child = spawnSync(
    process.execPath,
    [tsxCli, scriptPath, '--payload-bytes', String(payloadBytes)],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  );
  expect(child.status, `child stderr: ${child.stderr ?? ''}`).toBe(0);
  const lines = (child.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const parsed = JSON.parse(lines[lines.length - 1]!) as CanonicalJsonProbeResult;
  expect(parsed.event).toBe('canonical-json-probe');
  return parsed;
}

describe('canonicalJson large-payload perf/RSS regression (subprocess)', () => {
  it('a 32 MiB content root stays under the 1 GiB peak-RSS guard (RED on the rope blowup)', () => {
    const result = runProbe(32 * MIB);
    // Machine-readable observation so reports can compare child vs bound.
    process.stdout.write(`${JSON.stringify({ event: 'canonical-json-probe-observed', ...result })}\n`);
    // Wall-time guard: generous (a 32 MiB payload currently flattens in ~1.6 s;
    // a native single-pass encoder is ~100x faster). Protects against a
    // re-introduced pathological serialization dominating a benchmark case.
    expect(result.wallMs).toBeLessThan(10_000);
    // Peak-RSS guard: the per-character `out +=` rope blowup exceeds 1 GiB on
    // the current implementation (~1.36 GB measured); a single-pass encoder
    // stays far below. THIS assertion is the RED against the current code.
    expect(result.peakRssBytes).toBeLessThan(GIB);
  });

  it('a small 1 KiB payload stays cheap (fast-path sanity: must pass before and after)', () => {
    const result = runProbe(1024);
    process.stdout.write(`${JSON.stringify({ event: 'canonical-json-probe-small', ...result })}\n`);
    expect(result.bytes).toBeGreaterThan(1024);
    expect(result.peakRssBytes).toBeLessThan(512 * MIB);
    expect(result.wallMs).toBeLessThan(1_000);
  });
});
