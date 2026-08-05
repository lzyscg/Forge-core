import type { CapabilityEvidence, MockScenarioId } from '../../shared/contracts';

/**
 * 仅开发进度页（/dev/progress）使用的开发控制接口：
 * 能力证据展示、模拟场景选择与模拟数据重置。
 * 正式五个页面不得依赖此接口。
 */
export interface DevelopmentGateway {
  getCapabilities(): Promise<CapabilityEvidence[]>;
  getNextScenario(): Promise<MockScenarioId>;
  setNextScenario(scenario: MockScenarioId): Promise<void>;
  resetMockData(): Promise<void>;
}
