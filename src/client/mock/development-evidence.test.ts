import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityEvidence } from '../../shared/contracts';
import {
  BACKEND_CONNECTED_PHASE_B,
  BACKEND_CONNECTED_PHASE_E,
  CAPABILITIES,
  type CapabilityId,
} from './development-capabilities';
import {
  DEVELOPMENT_EVIDENCE_SEED,
  type DevelopmentEvidenceFile,
  type DevelopmentEvidenceLoader,
  createBrowserEvidenceLoader,
  mapDevelopmentEvidence,
  mergeWithPersistedBackendEvidence,
  parseDevelopmentEvidence,
} from './development-evidence';
import { MemoryStorage, createFixedClock } from './mock-fixtures';
import { createMockGateway } from './mock-gateway';

const ALL_THIRTEEN_IDS: CapabilityId[] = CAPABILITIES.map(([id]) => id);

function evidenceWith(
  overrides: Partial<DevelopmentEvidenceFile> = {},
): DevelopmentEvidenceFile {
  return {
    schemaVersion: 1,
    outcome: 'passed',
    observedAt: '2026-02-01T00:00:00.000Z',
    commit: 'abc1234',
    command: 'npm run core:verify-ui',
    passedCapabilities: [...ALL_THIRTEEN_IDS],
    ...overrides,
  };
}

function loaderOf(file: DevelopmentEvidenceFile): DevelopmentEvidenceLoader {
  return { load: async () => structuredClone(file) };
}

function byId(rows: CapabilityEvidence[], id: CapabilityId): CapabilityEvidence {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`missing capability row ${id}`);
  return row;
}

describe('CAPABILITIES registry', () => {
  it('declares the exact thirteen capabilities in order', () => {
    expect(CAPABILITIES.map(([id, label]) => [id, label])).toEqual([
      ['templates', '模板列表与详情'],
      ['template_reload', '显式重新加载模板'],
      ['task_creation', '新建任务与冻结配置'],
      ['task_recovery', '任务列表与状态恢复'],
      ['workspace', '动态 Agent 画布'],
      ['lifecycle', '停止、继续与人工输入'],
      ['retry', '自动与手动重试'],
      ['skills', 'Skill 按需加载展示'],
      ['artifacts', '产物版本链与正文预览'],
      ['final_output', '最终产物系统校验演示'],
      ['process_trace', '执行过程浮窗（思维/工具/正文）'],
      ['agent_workspace', 'Agent 临时工作区'],
      ['task_clone', '同输入克隆重跑'],
    ]);
  });

  it('declares exactly the three phase E backend-connected capabilities', () => {
    expect([...BACKEND_CONNECTED_PHASE_E]).toEqual([
      'process_trace',
      'agent_workspace',
      'task_clone',
    ]);
    for (const id of BACKEND_CONNECTED_PHASE_E) {
      expect(CAPABILITIES.map(([capability]) => capability)).toContain(id);
    }
  });
});

describe('parseDevelopmentEvidence', () => {
  it('accepts a schema-valid evidence file', () => {
    const file = evidenceWith({ outcome: 'failed', passedCapabilities: ['templates'] });
    expect(parseDevelopmentEvidence(structuredClone(file))).toEqual(file);
  });

  it('accepts the not_run seed shape', () => {
    expect(parseDevelopmentEvidence(structuredClone(DEVELOPMENT_EVIDENCE_SEED))).toEqual(
      DEVELOPMENT_EVIDENCE_SEED,
    );
  });

  it.each([
    ['a stale schema version', { ...evidenceWith(), schemaVersion: 2 }],
    ['an unknown outcome', { ...evidenceWith(), outcome: 'green' }],
    ['a missing field', { schemaVersion: 1, outcome: 'passed' }],
    ['a non-object payload', 'evidence'],
    ['null', null],
  ])('falls back to not_run seed semantics for %s', (_label, payload) => {
    expect(parseDevelopmentEvidence(payload)).toEqual(DEVELOPMENT_EVIDENCE_SEED);
  });
});

describe('mapDevelopmentEvidence', () => {
  it('maps passing evidence to mock_ready product shape only', () => {
    const file = evidenceWith();
    const rows = mapDevelopmentEvidence(file);
    expect(rows.map((row) => row.id)).toEqual([...ALL_THIRTEEN_IDS]);
    for (const row of rows) {
      expect(row.productShape).toBe('mock_ready');
      // Phase A hard-codes both real columns; evidence never moves them.
      expect(row.backendConnection).toBe('not_started');
      expect(row.realAcceptance).toBe('not_started');
      expect(row.command).toBe('npm run core:verify-ui');
      expect(row.observedAt).toBe('2026-02-01T00:00:00.000Z');
    }
    expect(rows[0]).toMatchObject({ id: 'templates', label: '模板列表与详情' });
  });

  it('maps failed evidence: passed suites mock_ready, affected cells needs_repair', () => {
    const rows = mapDevelopmentEvidence(
      evidenceWith({ outcome: 'failed', passedCapabilities: ['templates', 'workspace'] }),
    );
    expect(byId(rows, 'templates').productShape).toBe('mock_ready');
    expect(byId(rows, 'workspace').productShape).toBe('mock_ready');
    expect(byId(rows, 'retry').productShape).toBe('needs_repair');
    expect(byId(rows, 'final_output').productShape).toBe('needs_repair');
    for (const row of rows) {
      expect(row.backendConnection).toBe('not_started');
      expect(row.realAcceptance).toBe('not_started');
    }
  });

  it('maps not_run evidence and unknown ids to not_started', () => {
    const rows = mapDevelopmentEvidence(structuredClone(DEVELOPMENT_EVIDENCE_SEED));
    for (const row of rows) {
      expect(row.productShape).toBe('not_started');
      expect(row.command).toBe('npm run core:verify-ui');
      expect(row.observedAt).toBeNull();
    }
    const withUnknown = mapDevelopmentEvidence(
      evidenceWith({ outcome: 'passed', passedCapabilities: ['not_a_capability'] }),
    );
    for (const row of withUnknown) {
      expect(row.productShape).toBe('not_started');
    }
  });

  it('marks the six proven capabilities backend_connected and never verified', () => {
    const rows = mapDevelopmentEvidence(
      evidenceWith({
        backendOutcome: 'passed',
        backendConnectedCapabilities: [...BACKEND_CONNECTED_PHASE_B],
      }),
    );
    const proven = new Set<string>(BACKEND_CONNECTED_PHASE_B);
    for (const row of rows) {
      expect(row.backendConnection).toBe(
        proven.has(row.id) ? 'backend_connected' : 'not_started',
      );
      // Gate B ceiling: no column ever reaches verified; real acceptance is
      // claimed by Phase D at the earliest.
      expect(row.productShape).not.toBe('verified');
      expect(row.backendConnection).not.toBe('verified');
      expect(row.realAcceptance).toBe('not_started');
    }
    expect(rows.filter((row) => row.backendConnection === 'backend_connected')).toHaveLength(6);
  });

  it('maps all nine proven capabilities when phase B and phase E gates pass', () => {
    const rows = mapDevelopmentEvidence(
      evidenceWith({
        backendOutcome: 'passed',
        backendConnectedCapabilities: [...BACKEND_CONNECTED_PHASE_B, ...BACKEND_CONNECTED_PHASE_E],
      }),
    );
    const proven = new Set<string>([...BACKEND_CONNECTED_PHASE_B, ...BACKEND_CONNECTED_PHASE_E]);
    for (const row of rows) {
      expect(row.backendConnection).toBe(
        proven.has(row.id) ? 'backend_connected' : 'not_started',
      );
      // The backend ceiling holds: phase E rows never reach verified here.
      expect(row.backendConnection).not.toBe('verified');
      expect(row.realAcceptance).toBe('not_started');
    }
    expect(rows.filter((row) => row.backendConnection === 'backend_connected')).toHaveLength(9);
  });

  it('marks proven rows needs_repair when the backend gate fails', () => {
    const rows = mapDevelopmentEvidence(
      evidenceWith({
        outcome: 'passed',
        backendOutcome: 'failed',
        backendConnectedCapabilities: [...BACKEND_CONNECTED_PHASE_B],
      }),
    );
    const proven = new Set<string>(BACKEND_CONNECTED_PHASE_B);
    for (const row of rows) {
      expect(row.productShape).toBe('mock_ready');
      expect(row.backendConnection).toBe(proven.has(row.id) ? 'needs_repair' : 'not_started');
      expect(row.realAcceptance).toBe('not_started');
    }
  });

  it('keeps every backend cell not_started when backend evidence is absent', () => {
    for (const row of mapDevelopmentEvidence(evidenceWith())) {
      expect(row.backendConnection).toBe('not_started');
    }
  });

  it('ignores backend capability ids outside the registry', () => {
    const rows = mapDevelopmentEvidence(
      evidenceWith({
        backendOutcome: 'passed',
        backendConnectedCapabilities: ['not_a_capability', 'templates'],
      }),
    );
    expect(byId(rows, 'templates').backendConnection).toBe('backend_connected');
    expect(rows.filter((row) => row.backendConnection === 'backend_connected')).toHaveLength(1);
  });
});

describe('parseDevelopmentEvidence backend fields', () => {
  it('preserves valid backend fields', () => {
    const file = evidenceWith({
      backendOutcome: 'passed',
      backendConnectedCapabilities: ['templates'],
    });
    expect(parseDevelopmentEvidence(structuredClone(file))).toEqual(file);
  });

  it('falls back to the not_run seed when backend fields are invalid', () => {
    expect(
      parseDevelopmentEvidence({ ...evidenceWith(), backendOutcome: 'green' }),
    ).toEqual(DEVELOPMENT_EVIDENCE_SEED);
    expect(
      parseDevelopmentEvidence({
        ...evidenceWith(),
        backendOutcome: 'passed',
        backendConnectedCapabilities: 'templates',
      }),
    ).toEqual(DEVELOPMENT_EVIDENCE_SEED);
  });
});

describe('mergeWithPersistedBackendEvidence', () => {
  it('preserves valid backend fields when the UI gate rewrites the file', () => {
    const existing = evidenceWith({
      backendOutcome: 'passed',
      backendConnectedCapabilities: [...BACKEND_CONNECTED_PHASE_B],
    });
    const fresh = evidenceWith({
      observedAt: '2026-03-01T00:00:00.000Z',
      commit: 'def456',
    });
    const merged = mergeWithPersistedBackendEvidence(structuredClone(existing), fresh);
    expect(merged.backendOutcome).toBe('passed');
    expect(merged.backendConnectedCapabilities).toEqual([...BACKEND_CONNECTED_PHASE_B]);
    // The UI dimension always comes from the fresh run.
    expect(merged.observedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(merged.commit).toBe('def456');
    expect(merged.passedCapabilities).toEqual(fresh.passedCapabilities);
  });

  it.each([
    ['null', null],
    ['a non-object payload', 'evidence'],
    ['a payload without backend fields', evidenceWith()],
    ['a payload with an invalid backendOutcome', { ...evidenceWith(), backendOutcome: 'green' }],
  ])('leaves fresh evidence without backend fields for %s', (_label, existing) => {
    const fresh = evidenceWith();
    const merged = mergeWithPersistedBackendEvidence(existing, fresh);
    expect(merged).toEqual(fresh);
    expect(merged.backendOutcome).toBeUndefined();
    expect(merged.backendConnectedCapabilities).toBeUndefined();
  });

  it('preserves persisted real acceptance fields alongside both other dimensions', () => {
    const existing = evidenceWith({
      backendOutcome: 'passed',
      backendConnectedCapabilities: [...BACKEND_CONNECTED_PHASE_B],
      realAcceptanceOutcome: 'passed',
      realAcceptanceVerifiedCapabilities: [...ALL_THIRTEEN_IDS],
    });
    const fresh = evidenceWith({ observedAt: '2026-04-01T00:00:00.000Z' });
    const merged = mergeWithPersistedBackendEvidence(structuredClone(existing), fresh);
    expect(merged.backendOutcome).toBe('passed');
    expect(merged.realAcceptanceOutcome).toBe('passed');
    expect(merged.realAcceptanceVerifiedCapabilities).toEqual([...ALL_THIRTEEN_IDS]);
    expect(merged.observedAt).toBe('2026-04-01T00:00:00.000Z');
  });
});

describe('parseDevelopmentEvidence real acceptance fields', () => {
  it('preserves valid real acceptance fields', () => {
    const file = evidenceWith({
      backendOutcome: 'passed',
      backendConnectedCapabilities: [...ALL_THIRTEEN_IDS],
      realAcceptanceOutcome: 'passed',
      realAcceptanceVerifiedCapabilities: ['templates', 'workspace'],
    });
    expect(parseDevelopmentEvidence(structuredClone(file))).toEqual(file);
  });

  it.each([
    ['an unknown realAcceptanceOutcome', { ...evidenceWith(), realAcceptanceOutcome: 'green' }],
    [
      'a non-array verified capability list',
      { ...evidenceWith(), realAcceptanceOutcome: 'passed', realAcceptanceVerifiedCapabilities: 'templates' },
    ],
  ])('falls back to the not_run seed for %s', (_label, payload) => {
    expect(parseDevelopmentEvidence(payload)).toEqual(DEVELOPMENT_EVIDENCE_SEED);
  });
});

describe('mapDevelopmentEvidence real acceptance column', () => {
  it('marks listed capabilities verified when real acceptance passed', () => {
    const rows = mapDevelopmentEvidence(
      evidenceWith({
        backendOutcome: 'passed',
        backendConnectedCapabilities: [...ALL_THIRTEEN_IDS],
        realAcceptanceOutcome: 'passed',
        realAcceptanceVerifiedCapabilities: [...ALL_THIRTEEN_IDS],
      }),
    );
    for (const row of rows) {
      expect(row.realAcceptance).toBe('verified');
    }
  });

  it('leaves unlisted capabilities not_started and ignores unknown ids', () => {
    const rows = mapDevelopmentEvidence(
      evidenceWith({
        realAcceptanceOutcome: 'passed',
        realAcceptanceVerifiedCapabilities: ['templates', 'not_a_capability'],
      }),
    );
    expect(byId(rows, 'templates').realAcceptance).toBe('verified');
    expect(byId(rows, 'retry').realAcceptance).toBe('not_started');
    expect(rows.filter((row) => row.realAcceptance === 'verified')).toHaveLength(1);
  });

  it('marks proven rows needs_repair when real acceptance fails', () => {
    const rows = mapDevelopmentEvidence(
      evidenceWith({
        realAcceptanceOutcome: 'failed',
        realAcceptanceVerifiedCapabilities: ['workspace'],
      }),
    );
    expect(byId(rows, 'workspace').realAcceptance).toBe('needs_repair');
    expect(byId(rows, 'templates').realAcceptance).toBe('not_started');
  });

  it('keeps every real acceptance cell not_started when the fields are absent', () => {
    for (const row of mapDevelopmentEvidence(evidenceWith())) {
      expect(row.realAcceptance).toBe('not_started');
    }
  });
});

describe('createMockGateway evidence wiring', () => {
  it('keeps two-argument callers on the not_run seed semantics', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const rows = await gateway.getCapabilities();
    expect(rows).toHaveLength(13);
    for (const row of rows) {
      expect(row.productShape).toBe('not_started');
      expect(row.backendConnection).toBe('not_started');
      expect(row.realAcceptance).toBe('not_started');
      expect(row.command).toBe('npm run core:verify-ui');
      expect(row.observedAt).toBeNull();
    }
  });

  it('merges injected loader evidence with the registry', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock(), {
      evidenceLoader: loaderOf(evidenceWith()),
    });
    const rows = await gateway.getCapabilities();
    expect(rows).toHaveLength(13);
    for (const row of rows) {
      expect(row.productShape).toBe('mock_ready');
      expect(row.backendConnection).toBe('not_started');
      expect(row.realAcceptance).toBe('not_started');
    }
  });
});

describe('createBrowserEvidenceLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the evidence file without caching and parses valid payloads', async () => {
    const file = evidenceWith();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => structuredClone(file) }));
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await createBrowserEvidenceLoader().load();

    expect(fetchMock).toHaveBeenCalledWith('/development-evidence.json', { cache: 'no-store' });
    expect(loaded).toEqual(file);
  });

  it.each([
    [
      'a network failure',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    ],
    ['a missing file response', vi.fn(async () => ({ ok: false, json: async () => ({}) }))],
    [
      'a corrupted payload',
      vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 9 }) })),
    ],
  ])('returns not_run seed semantics on %s', async (_label, fetchMock) => {
    vi.stubGlobal('fetch', fetchMock);
    expect(await createBrowserEvidenceLoader().load()).toEqual(DEVELOPMENT_EVIDENCE_SEED);
  });
});
