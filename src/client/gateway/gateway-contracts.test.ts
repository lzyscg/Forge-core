import { expectTypeOf, it } from 'vitest';
import type { DevelopmentGateway } from './development-gateway';
import type { ForgeCoreGateway } from './forge-core-gateway';

it('keeps production and development controls in separate contracts', () => {
  expectTypeOf<ForgeCoreGateway>().toHaveProperty('createTask');
  expectTypeOf<ForgeCoreGateway>().toHaveProperty('deleteTask');
  expectTypeOf<ForgeCoreGateway>().not.toHaveProperty('setNextScenario');
  expectTypeOf<DevelopmentGateway>().toHaveProperty('setNextScenario');
  expectTypeOf<DevelopmentGateway>().toHaveProperty('resetMockData');
});
