import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MemoryStorage, createFixedClock } from '../mock/mock-fixtures';
import { createMockGateway } from '../mock/mock-gateway';
import { GatewayProvider, useDevelopmentGateway, useForgeCoreGateway } from './gateway-context';

describe('GatewayProvider', () => {
  it('throws a public setup error outside the provider', () => {
    const failures: unknown[] = [];
    for (const useHook of [useForgeCoreGateway, useDevelopmentGateway]) {
      try {
        renderHook(() => useHook());
      } catch (error) {
        failures.push(error);
      }
    }
    expect(failures).toHaveLength(2);
    for (const error of failures) {
      expect((error as { code?: unknown }).code).toBe('GATEWAY_NOT_CONFIGURED');
      expect(typeof (error as { message?: unknown }).message).toBe('string');
    }
  });

  it('provides the injected gateways to consumers', () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GatewayProvider core={gateway} development={gateway}>
        {children}
      </GatewayProvider>
    );

    const core = renderHook(() => useForgeCoreGateway(), { wrapper });
    const development = renderHook(() => useDevelopmentGateway(), { wrapper });
    expect(core.result.current).toBe(gateway);
    expect(development.result.current).toBe(gateway);
  });
});
