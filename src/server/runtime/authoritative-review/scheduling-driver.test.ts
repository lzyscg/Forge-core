// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { V2SchedulingDriver } from './scheduling-driver';

describe('V2SchedulingDriver', () => {
  it('serializes lifecycle-triggered runNow behind a timer tick', async () => {
    let releaseFirst: (() => void) | undefined;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const tick = async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        firstStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      active -= 1;
      return { pass: {}, outcomes: [] };
    };
    const driver = new V2SchedulingDriver({
      wakeups: { all: async () => [] },
      tick,
      clock: () => '2026-08-18T00:00:00.000Z',
    });

    driver.start();
    await firstStartedPromise;
    const secondRun = driver.runNow('2026-08-18T00:00:01.000Z');
    expect(calls).toBe(1);

    releaseFirst!();
    await secondRun;
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    await driver.stop();
  });
});
