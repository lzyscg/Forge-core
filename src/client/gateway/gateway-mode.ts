/**
 * Page-lifetime gateway mode resolution (plan Phase B Task 5 Step 6).
 *
 * The whole page binds to exactly one Gateway implementation, decided once
 * before React renders (spec §15.4: one task never mixes Mock and HTTP).
 * The mode is read from `VITE_FORGE_CORE_MODE` and stays fixed for the page
 * lifetime; only `/dev/progress` ever displays it — formal pages contain no
 * mode branch.
 */

export type ForgeCoreGatewayMode = 'mock' | 'http';

/** Anything other than the literal 'http' keeps the deterministic mock. */
export function resolveForgeCoreMode(envValue: unknown): ForgeCoreGatewayMode {
  return envValue === 'http' ? 'http' : 'mock';
}
