import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { GatewayProvider } from './gateway/gateway-context';
import type { DevelopmentGateway } from './gateway/development-gateway';
import type { ForgeCoreGateway } from './gateway/forge-core-gateway';
import { createBrowserEvidenceLoader } from './mock/development-evidence';
import { createMockGateway } from './mock/mock-gateway';
import type { MockClock } from './mock/mock-schema';
import { routes } from './router';

/**
 * Composition root. The entry point (main.tsx) decides once per page
 * lifetime which ForgeCoreGateway implementation to inject (mock or
 * HttpGateway); this module only wires the chosen gateways into the
 * provider. Components never touch storage directly: they only see gateway
 * interfaces.
 */

/** Browser storage access, centralized so components never reach it directly. */
class LocalStorageAdapter {
  get length(): number {
    return window.localStorage.length;
  }

  clear(): void {
    window.localStorage.clear();
  }

  getItem(key: string): string | null {
    return window.localStorage.getItem(key);
  }

  key(index: number): string | null {
    return window.localStorage.key(index);
  }

  removeItem(key: string): void {
    window.localStorage.removeItem(key);
  }

  setItem(key: string, value: string): void {
    window.localStorage.setItem(key, value);
  }
}

/** Non-persistent fallback for environments without usable browser storage. */
class InMemoryStorage {
  readonly #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }

  getItem(key: string): string | null {
    return this.#map.has(key) ? (this.#map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, String(value));
  }
}

function resolveStorage(): Storage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return new LocalStorageAdapter();
    }
  } catch {
    // Storage access can throw (restricted privacy modes); fall back below.
  }
  return new InMemoryStorage();
}

const browserClock: MockClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

/** Browser MockGateway with the generated-evidence loader (dev console). */
export function createBrowserMockGateway(): ForgeCoreGateway & DevelopmentGateway {
  return createMockGateway(resolveStorage(), browserClock, {
    evidenceLoader: createBrowserEvidenceLoader(),
  });
}

const browserRouter = createBrowserRouter(routes);

export interface AppProps {
  core: ForgeCoreGateway;
  development: DevelopmentGateway;
}

export function App({ core, development }: AppProps) {
  return (
    <GatewayProvider core={core} development={development}>
      <RouterProvider router={browserRouter} />
    </GatewayProvider>
  );
}
