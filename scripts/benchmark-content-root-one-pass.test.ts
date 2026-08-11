// @vitest-environment node
/**
 * Task 19 remediation Task B — the `content-root-64mib` benchmark case must
 * canonicalize its content root ONCE (encode + digest in a single pass), never
 * the old pair of `canonicalJsonSha256` + `canonicalJson` on the same value
 * (which serialized the payload twice and made the 64 MiB case ~40x the
 * necessary allocation).
 *
 * The canonical-json module is mocked with call-counting wrappers that still
 * delegate to the real implementation, so the one-pass helper's behavior is
 * exact while its single-serialization property is observable. This is the
 * non-brittle "spies on the module exports" lock the task asks for.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/server/structured-slots/canonical-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/structured-slots/canonical-json')>();
  return {
    canonicalJson: vi.fn(actual.canonicalJson),
    canonicalJsonBytes: vi.fn(actual.canonicalJsonBytes),
    canonicalJsonSha256: vi.fn(actual.canonicalJsonSha256),
    canonicalJsonBytesAndSha256: vi.fn(actual.canonicalJsonBytesAndSha256),
  };
});

import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonSha256,
  canonicalJsonBytesAndSha256,
} from '../src/server/structured-slots/canonical-json';
import { measureContentRootOnePass } from './benchmark-structured-slots';

describe('content-root-64mib single-canonicalization lock', () => {
  it('measures through ONE canonicalJsonBytesAndSha256 call and never the double-canonicalization pair', () => {
    const contentRoot = {
      version: 1,
      root: {
        slotId: 'root',
        typeId: 'document',
        contentPresence: 'set',
        content: 'x'.repeat(4096),
      },
    };

    vi.mocked(canonicalJson).mockClear();
    vi.mocked(canonicalJsonBytes).mockClear();
    vi.mocked(canonicalJsonSha256).mockClear();
    vi.mocked(canonicalJsonBytesAndSha256).mockClear();

    const measured = measureContentRootOnePass(contentRoot, 4096);

    // The case's unit now does exactly ONE canonicalization.
    expect(vi.mocked(canonicalJsonBytesAndSha256)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(canonicalJson)).not.toHaveBeenCalled();
    expect(vi.mocked(canonicalJsonBytes)).not.toHaveBeenCalled();
    expect(vi.mocked(canonicalJsonSha256)).not.toHaveBeenCalled();

    // The one-pass result is byte-exact: same digest as the standalone sha256
    // and the same byte length as the standalone bytes.
    expect(measured.digest).toBe(canonicalJsonSha256(contentRoot));
    expect(measured.byteLength).toBe(canonicalJsonBytes(contentRoot).length);
  });

  it('fails closed on a too-small payload (BENCHMARK_CONTENT_ROOT_FAILED)', () => {
    const contentRoot = { version: 1, root: { content: 'tiny' } };
    expect(() => measureContentRootOnePass(contentRoot, 1 << 20)).toThrow('BENCHMARK_CONTENT_ROOT_FAILED');
  });
});
