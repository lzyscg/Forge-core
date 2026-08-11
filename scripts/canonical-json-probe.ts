#!/usr/bin/env node
/**
 * HIDDEN child helper for the canonical-json perf/RSS regression test
 * (Task 19 remediation Task A). Spawned in a FRESH process so the measurement
 * is isolated; builds a large content-root object, canonicalizes + hashes it
 * ONCE through `canonicalJsonBytesAndSha256` (the exact one-pass production
 * path the `content-root-64mib` benchmark case exercises) and prints a single
 * machine-readable `canonical-json-probe` JSON line with the OS high-water
 * mark and wall time.
 *
 * This is a test helper only — it is NOT part of the production server.
 */
import { performance } from 'node:perf_hooks';
import { canonicalJsonBytesAndSha256 } from '../src/server/structured-slots/canonical-json';

/** OS high-water mark in BYTES (self-calibrating ru_maxrss: see benchmark harness). */
function osMaxRssBytes(): number {
  const raw = process.resourceUsage().maxRSS;
  const currentRss = process.memoryUsage().rss;
  if (raw > 0 && raw < currentRss) {
    return raw * 1024;
  }
  return raw;
}

function parseArgs(argv: readonly string[]): { payloadBytes: number } {
  let payloadBytes = 0;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--payload-bytes') {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error('CANONICAL_JSON_PROBE_USAGE: --payload-bytes requires a value');
      payloadBytes = Number(raw);
    }
  }
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new Error(`CANONICAL_JSON_PROBE_USAGE: invalid --payload-bytes '${payloadBytes}'`);
  }
  return { payloadBytes };
}

function main(): void {
  const { payloadBytes } = parseArgs(process.argv.slice(2));
  const contentRoot = {
    version: 1,
    root: {
      slotId: 'root',
      typeId: 'document',
      contentPresence: 'set',
      content: 'x'.repeat(payloadBytes),
    },
  };
  const started = performance.now();
  const { bytes, sha256 } = canonicalJsonBytesAndSha256(contentRoot);
  const wallMs = performance.now() - started;
  if (sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('CANONICAL_JSON_PROBE_FAILED: bad digest');
  }
  process.stdout.write(
    `${JSON.stringify({
      event: 'canonical-json-probe',
      bytes: bytes.length,
      payloadBytes,
      wallMs: Math.round(wallMs * 100) / 100,
      peakRssBytes: osMaxRssBytes(),
      digest: sha256,
    })}\n`,
  );
}

main();
