import { Value } from 'typebox/value';
import type { CapabilityEvidence, CapabilityStage } from '../../shared/contracts';
import { CAPABILITIES } from './development-capabilities';
import { developmentEvidenceFileSchema } from './mock-schema';

/**
 * Development evidence contract (consumed only by the development progress
 * page through DevelopmentGateway.getCapabilities; React components never
 * read the evidence file themselves).
 *
 * Column ownership: the UI gate (scripts/verify-ui.ts) owns the productShape
 * column; the Phase B backend gate (scripts/verify-backend.ts, refreshed to
 * all ten by scripts/verify-runtime.ts in Phase C) owns the backendConnection
 * column through the optional backend fields below; the Phase D final
 * evidence gate (scripts/write-final-evidence.ts) owns the realAcceptance
 * column through the optional real acceptance fields. Before that gate runs
 * (or when its fields are absent) realAcceptance stays not_started, and no
 * earlier evidence shape can ever map anything to `verified`.
 */
export interface DevelopmentEvidenceFile {
  schemaVersion: 1;
  outcome: 'not_run' | 'passed' | 'failed';
  observedAt: string | null;
  commit: string | null;
  command: string | null;
  passedCapabilities: string[];
  /** Absent until the backend gate has written it (Phase B). */
  backendOutcome?: 'not_run' | 'passed' | 'failed';
  backendConnectedCapabilities?: string[];
  /** Absent until the final evidence gate has written it (Phase D). */
  realAcceptanceOutcome?: 'not_run' | 'passed' | 'failed';
  realAcceptanceVerifiedCapabilities?: string[];
}

export interface DevelopmentEvidenceLoader {
  load(): Promise<DevelopmentEvidenceFile>;
}

/**
 * Seed semantics: no verification run has happened yet. The committed
 * public/development-evidence.json carries the same shape; this constant is
 * also the fallback for missing, stale or corrupted evidence and the default
 * for two-argument createMockGateway callers.
 */
export const DEVELOPMENT_EVIDENCE_SEED: DevelopmentEvidenceFile = {
  schemaVersion: 1,
  outcome: 'not_run',
  observedAt: null,
  commit: null,
  command: 'npm run verify:ui',
  passedCapabilities: [],
};

function cloneSeed(): DevelopmentEvidenceFile {
  return { ...DEVELOPMENT_EVIDENCE_SEED, passedCapabilities: [] };
}

/**
 * Validate unknown input (fetched JSON, injected test payloads) against the
 * evidence schema; anything unusable degrades to not_run seed semantics so a
 * broken evidence file can never fake a green matrix. Valid backend and real
 * acceptance fields survive the parse; invalid ones invalidate the whole
 * file.
 */
export function parseDevelopmentEvidence(payload: unknown): DevelopmentEvidenceFile {
  if (Value.Check(developmentEvidenceFileSchema, payload)) {
    const file = payload as DevelopmentEvidenceFile;
    const parsed: DevelopmentEvidenceFile = {
      schemaVersion: 1,
      outcome: file.outcome,
      observedAt: file.observedAt,
      commit: file.commit,
      command: file.command,
      passedCapabilities: [...file.passedCapabilities],
    };
    if (file.backendOutcome !== undefined) {
      parsed.backendOutcome = file.backendOutcome;
      parsed.backendConnectedCapabilities = [...(file.backendConnectedCapabilities ?? [])];
    }
    if (file.realAcceptanceOutcome !== undefined) {
      parsed.realAcceptanceOutcome = file.realAcceptanceOutcome;
      parsed.realAcceptanceVerifiedCapabilities = [
        ...(file.realAcceptanceVerifiedCapabilities ?? []),
      ];
    }
    return parsed;
  }
  return cloneSeed();
}

/**
 * Merge the loaded evidence with the capability registry.
 *
 * productShape: passed evidence marks listed capabilities mock_ready; failed
 * evidence marks listed capabilities mock_ready and affected cells
 * needs_repair; not_run or stale evidence leaves every cell not_started.
 *
 * backendConnection: passed backend evidence marks listed capabilities
 * backend_connected; failed backend evidence marks the previously proven rows
 * needs_repair (spec §15.3: a failed verification must not stay green);
 * absent backend evidence leaves every cell not_started. The Gate B ceiling
 * is backend_connected — nothing in that dimension can ever produce
 * `verified`.
 *
 * realAcceptance: only the Phase D final evidence gate writes these fields.
 * Passed real acceptance marks listed capabilities verified; failed real
 * acceptance marks the previously proven rows needs_repair; absent fields
 * leave every cell not_started.
 */
export function mapDevelopmentEvidence(
  evidence: DevelopmentEvidenceFile,
): CapabilityEvidence[] {
  const passed = new Set(evidence.passedCapabilities);
  const backendConnected = new Set(evidence.backendConnectedCapabilities ?? []);
  const realVerified = new Set(evidence.realAcceptanceVerifiedCapabilities ?? []);
  return CAPABILITIES.map(([id, label]) => {
    let productShape: CapabilityStage = 'not_started';
    if (evidence.outcome === 'passed' && passed.has(id)) {
      productShape = 'mock_ready';
    } else if (evidence.outcome === 'failed') {
      productShape = passed.has(id) ? 'mock_ready' : 'needs_repair';
    }
    let backendConnection: CapabilityStage = 'not_started';
    if (evidence.backendOutcome === 'passed' && backendConnected.has(id)) {
      backendConnection = 'backend_connected';
    } else if (evidence.backendOutcome === 'failed' && backendConnected.has(id)) {
      backendConnection = 'needs_repair';
    }
    let realAcceptance: CapabilityStage = 'not_started';
    if (evidence.realAcceptanceOutcome === 'passed' && realVerified.has(id)) {
      realAcceptance = 'verified';
    } else if (evidence.realAcceptanceOutcome === 'failed' && realVerified.has(id)) {
      realAcceptance = 'needs_repair';
    }
    return {
      id,
      label,
      productShape,
      backendConnection,
      realAcceptance,
      command: evidence.command,
      observedAt: evidence.observedAt,
    };
  });
}

/**
 * Read-modify-write guard for evidence rewrites (plan Task 6, extended to
 * three dimensions by plan Phase D Task 5): scripts that own one dimension
 * (verify-ui owns the UI fields) must preserve the other dimensions'
 * persisted fields instead of clobbering the whole file. Returns the fresh
 * UI evidence, extended with the persisted backend and real acceptance
 * fields only when they parse cleanly; unusable persisted input contributes
 * nothing.
 */
export function mergeWithPersistedBackendEvidence(
  existingPayload: unknown,
  freshUiEvidence: DevelopmentEvidenceFile,
): DevelopmentEvidenceFile {
  const persisted = parseDevelopmentEvidence(existingPayload);
  const merged: DevelopmentEvidenceFile = { ...freshUiEvidence };
  if (persisted.backendOutcome !== undefined) {
    merged.backendOutcome = persisted.backendOutcome;
    merged.backendConnectedCapabilities = [...(persisted.backendConnectedCapabilities ?? [])];
  }
  if (persisted.realAcceptanceOutcome !== undefined) {
    merged.realAcceptanceOutcome = persisted.realAcceptanceOutcome;
    merged.realAcceptanceVerifiedCapabilities = [
      ...(persisted.realAcceptanceVerifiedCapabilities ?? []),
    ];
  }
  return merged;
}

/**
 * Browser loader: fetches the generated evidence file without caching.
 * Network failures, non-OK responses and invalid payloads all resolve to the
 * not_run seed — the page degrades to "nothing verified yet", never to a
 * claimed state.
 */
export function createBrowserEvidenceLoader(): DevelopmentEvidenceLoader {
  return {
    async load(): Promise<DevelopmentEvidenceFile> {
      try {
        const response = await fetch('/development-evidence.json', { cache: 'no-store' });
        if (!response.ok) return cloneSeed();
        return parseDevelopmentEvidence(await response.json());
      } catch {
        return cloneSeed();
      }
    },
  };
}
