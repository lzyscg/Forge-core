import { createContext, useContext, type ReactNode } from 'react';
import { CORE_ERROR_CODES, CoreError } from './core-errors';
import type { DevelopmentGateway } from './development-gateway';
import type { ForgeCoreGateway } from './forge-core-gateway';

const ForgeCoreGatewayContext = createContext<ForgeCoreGateway | null>(null);
const DevelopmentGatewayContext = createContext<DevelopmentGateway | null>(null);

export interface GatewayProviderProps {
  core: ForgeCoreGateway;
  development: DevelopmentGateway;
  children: ReactNode;
}

/**
 * Composition-root injection point. Pages consume the two gateways through
 * hooks only and never decide which implementation they receive.
 */
export function GatewayProvider({ core, development, children }: GatewayProviderProps) {
  return (
    <ForgeCoreGatewayContext.Provider value={core}>
      <DevelopmentGatewayContext.Provider value={development}>
        {children}
      </DevelopmentGatewayContext.Provider>
    </ForgeCoreGatewayContext.Provider>
  );
}

export function useForgeCoreGateway(): ForgeCoreGateway {
  const gateway = useContext(ForgeCoreGatewayContext);
  if (!gateway) {
    throw new CoreError(
      CORE_ERROR_CODES.GATEWAY_NOT_CONFIGURED,
      'ForgeCoreGateway 尚未配置。',
      'useForgeCoreGateway',
      '在应用组合根用 GatewayProvider 注入 Gateway。',
    );
  }
  return gateway;
}

export function useDevelopmentGateway(): DevelopmentGateway {
  const gateway = useContext(DevelopmentGatewayContext);
  if (!gateway) {
    throw new CoreError(
      CORE_ERROR_CODES.GATEWAY_NOT_CONFIGURED,
      'DevelopmentGateway 尚未配置。',
      'useDevelopmentGateway',
      '在应用组合根用 GatewayProvider 注入 Gateway。',
    );
  }
  return gateway;
}
