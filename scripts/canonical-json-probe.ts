#!/usr/bin/env node
/**
 * HIDDEN child helper for the canonical-json perf/RSS regression test
 * (Task 19 remediation Task A). Spawned in a FRESH process so the measurement
 * is isolated; builds a large content-root object, canonicalizes + hashes it
 * ONCE through `canonicalJsonSha256` (the exact production path the
 * `content-root-64mib` benchmark case exercises) and prints a single
 * machine-readable `canonical-json-probe` JSON line with the OS high-water
 * mark and wall time.
 *
 * This is a test helper only — it is NOT part of the production server.
 */
import { performance } from 'node:perf_hooks';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';

/** OS high-water mark in BYTES (self-calibrating ru_maxrss: see benchmark harness). */
function osMaxRssBytes(): number {
  const raw = process.resourceUsage().maxRSS;
  const currentRss = process.memoryUsage().rss;
  if (raw > 0 && raw < currentRss) {
    return raw * 1024;
  }
  return raw;
}

/**
 * The exact canonical UTF-8 byte length of the probe content root for a given
 * payload size, WITHOUT re-serializing (the regression must measure ONE
 * serialization). The content root is the fixed shape used by the benchmark:
 * `{"version":1,"root":{"slotId":"root","typeId":"document","contentPresence":"set","content":"<n bytes>"}}`.
 * The constant JSON scaffolding length (with an EMPTY content string) is
 * measured once; every payload byte adds exactly one canonical byte.
 */
const CONTENT_ROOT_CONST_BYTES = Buffer.byteLength(
  '{"version":1,"root":{"slotId":"root","typeId":"document","contentPresence":"set","content":""}}',
  'utf8',
);

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
  const digest = canonicalJsonSha256(contentRoot);
  const wallMs = performance.now() - started;
  if (digest.length !== 64 || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('CANONICAL_JSON_PROBE_FAILED: bad digest');
  }
  process.stdout.write(
    `${JSON.stringify({
      event: 'canonical-json-probe',
      bytes: CONTENT_ROOT_CONST_BYTES + payloadBytes,
      payloadBytes,
      wallMs: Math.round(wallMs * 100) / 100,
      peakRssBytes: osMaxRssBytes(),
      digest,
    })}\n`,
  );
}

main();
