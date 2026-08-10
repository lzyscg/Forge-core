// @vitest-environment node
/**
 * Structured Slot contract compiler + resource manifest tests (Task 4).
 *
 * Covers: exact top-level contract schema, slot type / access profile /
 * validator / assembler registrations, all 28 limits with cross-field
 * relations and the platform hard-ceiling profile assertion, resource
 * containment (path format, symlink, non-regular, unreferenced, wrong
 * directory), the exact sorted resource manifest, and the semantic digest
 * (changes with contract/validator/assembler bytes, invariant under mtime and
 * the absolute template root).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { StructuredSlotLimitsV1 } from '../../shared/structured-slots';
import { loadStructuredSlotContract, type FrozenStructuredSlotContractV1 } from './structured-slot-contract';

const FIXTURE_ROOT = fileURLToPath(new URL('__fixtures__/structured-valid', import.meta.url));
const CONTRACT_PATH = join(FIXTURE_ROOT, 'slots', 'contract.yaml');

/** Design §25.13 candidate profile — the platform hard ceiling passed to the loader. */
const CANDIDATE_PROFILE: StructuredSlotLimitsV1 = {
  schema: { maxSchemaDepth: 16, maxSchemaNodes: 4096, maxEnumItems: 256, maxPatternLength: 512 },
  structure: { maxSlots: 10_000, maxTreeDepth: 32, maxChildrenPerSlot: 1_000 },
  payload: { maxSpecBytesPerSlot: 65_536, maxContentBytesPerSlot: 1_048_576, maxScaffoldPayloadBytes: 67_108_864 },
  draft: { maxChangedSlots: 2_000, maxDraftBytes: 16_777_216 },
  attempt: {
    maxSlotToolCallsPerAttempt: 512,
    maxValidationRunsPerAttempt: 16,
    maxValidatorInvocationsPerAttempt: 40_000,
    maxAggregateValidatorCpuMsPerAttempt: 240_000,
    maxAggregateValidatorWallClockMsPerAttempt: 480_000,
    maxValidatorOutputBytesPerAttempt: 16_777_216,
    maxAttemptWallClockMs: 600_000,
  },
  validation: {
    maxValidators: 64,
    maxValidatorInvocationsPerGate: 10_000,
    maxAggregateValidatorCpuMsPerGate: 60_000,
    maxAggregateValidatorWallClockMsPerGate: 120_000,
    maxValidatorOutputBytesPerGate: 4_194_304,
    maxIssuesPerRun: 500,
  },
  output: { maxArtifactFiles: 64, maxArtifactBytesPerFile: 16_777_216, maxTotalArtifactBytes: 67_108_864 },
};

function loadAt(root: string): Promise<FrozenStructuredSlotContractV1> {
  return loadStructuredSlotContract(root, CANDIDATE_PROFILE);
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Copy the valid fixture to a fresh temp directory (an arbitrary absolute root). */
async function copyFixtureToTemp(): Promise<string> {
  const dest = await mkdtemp(join(tmpdir(), 'structured-slot-fixture-'));
  await rm(dest, { recursive: true, force: true });
  const { cp } = await import('node:fs/promises');
  await cp(FIXTURE_ROOT, dest, { recursive: true });
  return dest;
}

/** Run `fn` against a temp copy of the fixture, always cleaning up afterwards. */
async function withTempFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await copyFixtureToTemp();
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Run `fn` against a temp copy whose contract.yaml has been mutated via YAML round-trip. */
async function withVariant<T>(
  mutate: (doc: Record<string, unknown>) => void,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  return withTempFixture(async (root) => {
    const doc = parseYaml(await readFile(join(root, 'slots', 'contract.yaml'), 'utf8')) as Record<string, unknown>;
    mutate(doc);
    await writeFile(join(root, 'slots', 'contract.yaml'), stringifyYaml(doc), 'utf8');
    return fn(root);
  });
}

/** Assert that the mutated contract fails to load with the given stable code. */
async function expectInvalid(mutate: (doc: Record<string, unknown>) => void, code: string): Promise<void> {
  await withVariant(mutate, async (root) => {
    await expect(loadAt(root)).rejects.toThrow(code);
  });
}

describe('loadStructuredSlotContract — valid fixture', () => {
  it('compiles the fixture into a fully frozen FrozenStructuredSlotContractV1', async () => {
    const frozen = await loadAt(FIXTURE_ROOT);
    expect(frozen.version).toBe(1);

    expect(frozen.slotTypes.map((s) => s.id)).toEqual(['document', 'title', 'body']);
    expect(frozen.slotTypes[0].content).toEqual({ presence: 'forbidden' });
    expect(frozen.slotTypes[1].content.presence).toBe('required');
    if (frozen.slotTypes[1].content.presence === 'required') {
      expect(frozen.slotTypes[1].content.schema.type).toBe('string');
      expect(frozen.slotTypes[1].content.schema.minLength).toBe(1);
      expect(frozen.slotTypes[1].content.schema.maxLength).toBe(200);
    }
    expect(frozen.slotTypes[1].specSchema.type).toBe('object');
    expect(frozen.slotTypes[1].specSchema.additionalProperties).toBe(false);

    expect(frozen.layoutGrammar.rootType).toBe('document');
    expect(Object.keys(frozen.layoutGrammar.productions).sort()).toEqual(['body', 'document', 'title']);

    expect(frozen.accessProfiles.map((p) => p.id)).toEqual(['editor']);
    expect(frozen.accessProfiles[0].continuity).toEqual({ precedingFilled: false });

    expect(frozen.validators).toHaveLength(1);
    expect(frozen.validators[0].id).toBe('title-check');
    expect(frozen.validators[0].implementation.abi).toBe('forge-validator/v1');
    expect(frozen.validators[0].implementation.path).toBe('slots/validators/validate.js');

    expect(frozen.assembler.id).toBe('render');
    expect(frozen.assembler.implementation.abi).toBe('forge-assembler/v1');
    expect(frozen.assembler.routes).toEqual([{ id: 'document-md', artifactFile: 'document.md' }]);

    expect(frozen.limits.structure.maxSlots).toBe(2500);
    expect(frozen.limits.attempt.maxSlotToolCallsPerAttempt).toBe(128);

    expect(frozen.abiProfileIdentity).toEqual({
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    });
    expect(frozen.semanticDigest).toMatch(/^[0-9a-f]{64}$/);

    // Deep-frozen everywhere.
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.limits)).toBe(true);
    expect(Object.isFrozen(frozen.validators[0])).toBe(true);
    expect(Object.isFrozen(frozen.assembler.routes[0])).toBe(true);
  });

  it('produces an exact resource manifest: every referenced resource once, sorted by logicalPath', async () => {
    const frozen = await loadAt(FIXTURE_ROOT);
    expect(frozen.resourceManifest).toHaveLength(2);
    expect(frozen.resourceManifest.map((e) => e.logicalPath)).toEqual([
      'slots/assembler/render.js',
      'slots/validators/validate.js',
    ]);

    const validateBytes = await readFile(join(FIXTURE_ROOT, 'slots/validators/validate.js'));
    const renderBytes = await readFile(join(FIXTURE_ROOT, 'slots/assembler/render.js'));
    expect(frozen.resourceManifest[0]).toEqual({
      logicalPath: 'slots/assembler/render.js',
      sha256: await sha256OfBytes(renderBytes),
      byteLength: renderBytes.length,
    });
    expect(frozen.resourceManifest[1]).toEqual({
      logicalPath: 'slots/validators/validate.js',
      sha256: await sha256OfBytes(validateBytes),
      byteLength: validateBytes.length,
    });
  });

  it('accepts an empty validators array (when no validator file remains)', async () => {
    await withTempFixture(async (root) => {
      const doc = parseYaml(await readFile(join(root, 'slots', 'contract.yaml'), 'utf8')) as Record<string, unknown>;
      doc['validators'] = [];
      await writeFile(join(root, 'slots', 'contract.yaml'), stringifyYaml(doc), 'utf8');
      // The fixture's validate.js would be unreferenced: remove it so the load is legal.
      await rm(join(root, 'slots/validators/validate.js'));
      const frozen = await loadAt(root);
      expect(frozen.validators).toEqual([]);
      expect(frozen.resourceManifest.map((e) => e.logicalPath)).toEqual(['slots/assembler/render.js']);
    });
  });
});

describe('loadStructuredSlotContract — exact top-level schema (A01)', () => {
  it('rejects a missing required top-level field', async () => {
    await expectInvalid((doc) => delete doc['limits'], 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => delete doc['slotTypes'], 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => delete doc['accessProfiles'], 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => delete doc['validators'], 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => delete doc['assembler'], 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects an unknown extra top-level field', async () => {
    await expectInvalid((doc) => {
      doc['extra'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects an unknown version', async () => {
    await expectInvalid((doc) => {
      doc['version'] = 2;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      doc['version'] = '1';
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects empty slotTypes and empty accessProfiles', async () => {
    await expectInvalid((doc) => {
      doc['slotTypes'] = [];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      doc['accessProfiles'] = [];
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('loadStructuredSlotContract — slot type definitions (spec §4.2)', () => {
  it('rejects duplicate slot type ids', async () => {
    await expectInvalid((doc) => {
      (doc['slotTypes'] as unknown[]).push({ id: 'body', name: 'Body 2', description: 'dup', specSchema: { type: 'object', additionalProperties: false }, content: { presence: 'forbidden' } });
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects specSchema whose root is not an explicit object with additionalProperties false', async () => {
    await expectInvalid((doc) => {
      (doc['slotTypes'] as Array<Record<string, unknown>>)[0]['specSchema'] = { type: 'string' };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['slotTypes'] as Array<Record<string, unknown>>)[0]['specSchema'] = { type: 'object', additionalProperties: true };
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects forbidden presence that declares a schema and required presence without a schema', async () => {
    await expectInvalid((doc) => {
      (doc['slotTypes'] as Array<Record<string, unknown>>)[0]['content'] = { presence: 'forbidden', schema: { type: 'string' } };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['slotTypes'] as Array<Record<string, unknown>>)[1]['content'] = { presence: 'required' };
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects an unknown content presence and unknown slot-type fields', async () => {
    await expectInvalid((doc) => {
      (doc['slotTypes'] as Array<Record<string, unknown>>)[0]['content'] = { presence: 'sometimes' };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['slotTypes'] as Array<Record<string, unknown>>)[0]['extra'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('loadStructuredSlotContract — access profiles and selectors (spec §8.3)', () => {
  it('rejects duplicate access profile ids', async () => {
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as unknown[]).push({
        id: 'editor',
        read: [],
        writeContent: [],
        continuity: { precedingFilled: false },
      });
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects selectors with empty typeIds, duplicate typeIds or unknown types', async () => {
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['writeContent'] = [{ targets: { kind: 'types', typeIds: [] } }];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['writeContent'] = [{ targets: { kind: 'types', typeIds: ['title', 'title'] } }];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['writeContent'] = [{ targets: { kind: 'types', typeIds: ['missing'] } }];
    }, 'SLOTS_REFERENCE_UNKNOWN');
  });

  it('rejects unknown selector kinds, bad target levels and bad context values', async () => {
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['writeContent'] = [{ targets: { kind: 'all', extra: 1 } }];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['writeContent'] = [{ targets: { kind: 'everything' } }];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['read'] = [
        { targets: { kind: 'all' }, targetLevel: 'deep', context: { level: 'content', ancestors: 1, descendants: 1, directSiblings: false } },
      ];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['read'] = [
        { targets: { kind: 'all' }, targetLevel: 'content', context: { level: 'content', ancestors: -1, descendants: 1, directSiblings: false } },
      ];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['accessProfiles'] as Array<Record<string, unknown>>)[0]['read'] = [
        { targets: { kind: 'all' }, targetLevel: 'content', context: { level: 'content', ancestors: 1, descendants: 1, directSiblings: false }, extra: 1 },
      ];
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('loadStructuredSlotContract — validator registration (design E01)', () => {
  const VALIDATOR_INDEX = 0;

  it('rejects a duplicate validator id', async () => {
    await expectInvalid((doc) => {
      (doc['validators'] as unknown[]).push({
        id: 'title-check',
        scope: 'slot',
        trigger: 'seal',
        enforcement: 'advisory',
        selector: { kind: 'all' },
        implementation: { abi: 'forge-validator/v1', path: 'slots/validators/validate.js' },
        budget: { cpuMs: 10, timeoutMs: 100, memoryMiB: 32 },
      });
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects a wrong ABI', async () => {
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[VALIDATOR_INDEX]['implementation'] = { abi: 'forge-validator/v2', path: 'slots/validators/validate.js' };
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects missing enforcement, missing budget and non-positive budget', async () => {
    await expectInvalid((doc) => {
      delete (doc['validators'] as Array<Record<string, unknown>>)[VALIDATOR_INDEX]['enforcement'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      delete (doc['validators'] as Array<Record<string, unknown>>)[VALIDATOR_INDEX]['budget'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[VALIDATOR_INDEX]['budget'] = { cpuMs: 0, timeoutMs: 100, memoryMiB: 32 };
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects an empty selector, an unknown field and a bad scope', async () => {
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[VALIDATOR_INDEX]['selector'] = { kind: 'types', typeIds: [] };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[VALIDATOR_INDEX]['extra'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[VALIDATOR_INDEX]['scope'] = 'tree';
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects more validators than limits.validation.maxValidators', async () => {
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['validation']['maxValidators'] = 1;
      (doc['validators'] as unknown[]).push({
        id: 'second',
        scope: 'slot',
        trigger: 'seal',
        enforcement: 'advisory',
        selector: { kind: 'all' },
        implementation: { abi: 'forge-validator/v1', path: 'slots/validators/validate.js' },
        budget: { cpuMs: 10, timeoutMs: 100, memoryMiB: 32 },
      });
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('loadStructuredSlotContract — assembler registration (design E06)', () => {
  it('rejects a wrong ABI and a missing budget', async () => {
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['implementation'] = { abi: 'forge-assembler/v2', path: 'slots/assembler/render.js' };
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      delete (doc['assembler'] as Record<string, unknown>)['budget'];
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects unsafe artifact file names and duplicate route ids', async () => {
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['routes'] = [{ id: 'a', artifactFile: 'sub/document.md' }];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['routes'] = [{ id: 'a', artifactFile: '../escape.md' }];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['routes'] = [
        { id: 'document-md', artifactFile: 'document.md' },
        { id: 'document-md', artifactFile: 'other.md' },
      ];
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects an unknown assembler field', async () => {
    await expectInvalid((doc) => {
      (doc['assembler'] as Record<string, unknown>)['extra'] = 1;
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('loadStructuredSlotContract — limits (spec §5 / design §7.6)', () => {
  it('rejects missing, zero, negative or non-integer limits fields', async () => {
    await expectInvalid((doc) => {
      delete (doc['limits'] as Record<string, Record<string, unknown>>)['schema']['maxSchemaNodes'];
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['structure']['maxSlots'] = 0;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['output']['maxArtifactFiles'] = -1;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['draft']['maxDraftBytes'] = 1.5;
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects cross-field relation violations', async () => {
    // attempt validator cpu must be >= per-Gate cpu
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['attempt']['maxAggregateValidatorCpuMsPerAttempt'] = 14_000;
    }, 'SLOTS_CONTRACT_INVALID');
    // validation runs must be <= slot tool calls
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['attempt']['maxValidationRunsPerAttempt'] = 200;
    }, 'SLOTS_CONTRACT_INVALID');
    // attempt wall must be >= attempt validator wall
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['attempt']['maxAttemptWallClockMs'] = 100_000;
    }, 'SLOTS_CONTRACT_INVALID');
    // changed slots must be <= max slots
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['draft']['maxChangedSlots'] = 3_000;
    }, 'SLOTS_CONTRACT_INVALID');
    // per-file output must be <= total output
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['output']['maxArtifactBytesPerFile'] = 20_000_000;
    }, 'SLOTS_CONTRACT_INVALID');
  });

  it('rejects template limits that exceed the platform hard ceiling', async () => {
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['structure']['maxSlots'] = 20_000;
    }, 'SLOTS_CONTRACT_INVALID');
    await expectInvalid((doc) => {
      (doc['limits'] as Record<string, Record<string, unknown>>)['schema']['maxSchemaDepth'] = 32;
    }, 'SLOTS_CONTRACT_INVALID');
  });
});

describe('loadStructuredSlotContract — resource containment (spec §3.3 / design A02)', () => {
  it('rejects ../, backslash, absolute and wrong-directory resource paths', async () => {
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['implementation'] = { abi: 'forge-validator/v1', path: 'slots/validators/../assembler/render.js' };
    }, 'SLOTS_RESOURCE_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['implementation'] = { abi: 'forge-validator/v1', path: 'slots\\validators\\validate.js' };
    }, 'SLOTS_RESOURCE_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['implementation'] = { abi: 'forge-validator/v1', path: '/etc/passwd' };
    }, 'SLOTS_RESOURCE_INVALID');
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['implementation'] = { abi: 'forge-validator/v1', path: 'slots/assembler/render.js' };
    }, 'SLOTS_RESOURCE_INVALID');
  });

  it('rejects a missing referenced resource', async () => {
    await expectInvalid((doc) => {
      (doc['validators'] as Array<Record<string, unknown>>)[0]['implementation'] = { abi: 'forge-validator/v1', path: 'slots/validators/nope.js' };
    }, 'SLOTS_RESOURCE_INVALID');
  });

  it('rejects a symlinked resource', async () => {
    await withTempFixture(async (root) => {
      await rm(join(root, 'slots/validators/validate.js'));
      await writeFile(join(root, 'slots/validators/real.js'), 'real', 'utf8');
      await symlink('real.js', join(root, 'slots/validators/validate.js'));
      await expect(loadAt(root)).rejects.toThrow('SLOTS_RESOURCE_INVALID');
    });
  });

  it('rejects a non-regular (directory) resource', async () => {
    await withTempFixture(async (root) => {
      await mkdir(join(root, 'slots/validators/dir'), { recursive: true });
      const doc = parseYaml(await readFile(join(root, 'slots/contract.yaml'), 'utf8')) as Record<string, unknown>;
      (doc['validators'] as Array<Record<string, unknown>>)[0]['implementation'] = { abi: 'forge-validator/v1', path: 'slots/validators/dir' };
      await writeFile(join(root, 'slots/contract.yaml'), stringifyYaml(doc), 'utf8');
      await expect(loadAt(root)).rejects.toThrow('SLOTS_RESOURCE_INVALID');
    });
  });

  it('rejects a file in the allowed directories that the contract does not reference', async () => {
    await withTempFixture(async (root) => {
      await writeFile(join(root, 'slots/validators/unreferenced.js'), 'unreferenced', 'utf8');
      await expect(loadAt(root)).rejects.toThrow('SLOTS_RESOURCE_INVALID');
    });
  });
});

describe('loadStructuredSlotContract — semantic digest (design A03)', () => {
  it('changes when contract semantics change', async () => {
    const base = await loadAt(FIXTURE_ROOT);
    await withVariant(
      (doc) => {
        (doc['limits'] as Record<string, Record<string, unknown>>)['structure']['maxSlots'] = 2_400;
      },
      async (root) => {
        expect((await loadAt(root)).semanticDigest).not.toBe(base.semanticDigest);
      },
    );
    await withVariant(
      (doc) => {
        (doc['slotTypes'] as Array<Record<string, unknown>>)[1]['name'] = 'Renamed';
      },
      async (root) => {
        expect((await loadAt(root)).semanticDigest).not.toBe(base.semanticDigest);
      },
    );
  });

  it('changes when validator bytes change', async () => {
    const base = await loadAt(FIXTURE_ROOT);
    await withTempFixture(async (root) => {
      await writeFile(join(root, 'slots/validators/validate.js'), '// changed\nmodule.exports = () => ({ pass: true, issues: [] });\n', 'utf8');
      expect((await loadAt(root)).semanticDigest).not.toBe(base.semanticDigest);
    });
  });

  it('changes when assembler bytes change', async () => {
    const base = await loadAt(FIXTURE_ROOT);
    await withTempFixture(async (root) => {
      await writeFile(join(root, 'slots/assembler/render.js'), '// changed\nmodule.exports = () => [];\n', 'utf8');
      expect((await loadAt(root)).semanticDigest).not.toBe(base.semanticDigest);
    });
  });

  it('does not change with file mtimes', async () => {
    const before = await loadAt(FIXTURE_ROOT);
    const stamp = new Date(Date.now() + 120_000);
    await utimes(CONTRACT_PATH, stamp, stamp);
    await utimes(join(FIXTURE_ROOT, 'slots/validators/validate.js'), stamp, stamp);
    await utimes(join(FIXTURE_ROOT, 'slots/assembler/render.js'), stamp, stamp);
    const after = await loadAt(FIXTURE_ROOT);
    expect(after.semanticDigest).toBe(before.semanticDigest);
  });

  it('does not change with the absolute template root', async () => {
    const base = await loadAt(FIXTURE_ROOT);
    await withTempFixture(async (root) => {
      expect((await loadAt(root)).semanticDigest).toBe(base.semanticDigest);
    });
  });
});

describe('loadStructuredSlotContract — fixture directory hygiene', () => {
  it('keeps the fixture directories free of stray files', async () => {
    const entries = await readdir(join(FIXTURE_ROOT, 'slots/validators'));
    expect(entries).toEqual(['validate.js']);
    const assemblerEntries = await readdir(join(FIXTURE_ROOT, 'slots/assembler'));
    expect(assemblerEntries).toEqual(['render.js']);
  });
});
