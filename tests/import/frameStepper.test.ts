import { describe, expect, it } from 'vitest';
import { MonotonicTimestamps, estimateRemainingMs, formatClock, planSamples, sampleTime } from '../../src/import/frameStepper';

describe('planSamples', () => {
  it('samples a clip at the requested rate, one sample per frame period', () => {
    const plan = planSamples(10, 30);
    expect(plan.count).toBe(300);
    expect(plan.fps).toBe(30);
    expect(sampleTime(plan, 0)).toBe(0);
    expect(sampleTime(plan, 150)).toBeCloseTo(5, 9);
    // The last sample never lands past the final decodable frame.
    expect(sampleTime(plan, plan.count - 1)).toBeLessThanOrEqual(10 - 0.5 / 30 + 1e-9);
  });

  it('honours in/out points and clamps them to the clip', () => {
    const plan = planSamples(10, 10, { startSec: 2, endSec: 4 });
    expect(plan.startSec).toBe(2);
    expect(plan.endSec).toBe(4);
    expect(plan.count).toBe(20);
    expect(sampleTime(plan, 0)).toBe(2);
    const clamped = planSamples(10, 10, { startSec: -5, endSec: 50 });
    expect(clamped.startSec).toBe(0);
    expect(clamped.endSec).toBe(10);
  });

  it('lowers the rate to respect the frame cap and copes with degenerate input', () => {
    const capped = planSamples(100, 60, { maxFrames: 100 });
    expect(capped.count).toBe(100);
    expect(capped.fps).toBeCloseTo(0.99, 6);
    expect(sampleTime(capped, 99)).toBeLessThanOrEqual(100);
    expect(planSamples(0, 30).count).toBe(0);
    expect(planSamples(NaN, 30).count).toBe(0);
    expect(planSamples(0.01, 30).count).toBe(1);
    expect(planSamples(5, NaN).fps).toBe(30);
  });
});

describe('MonotonicTimestamps', () => {
  it('rounds to integers and never repeats or goes backwards', () => {
    const m = new MonotonicTimestamps();
    expect(m.next(0)).toBe(0);
    expect(m.next(0.2)).toBe(1);
    expect(m.next(33.3)).toBe(33);
    expect(m.next(33.4)).toBe(34);
    expect(m.next(10)).toBe(35);
    expect(m.next(NaN)).toBe(36);
    m.reset();
    expect(m.next(5)).toBe(5);
  });
});

describe('progress helpers', () => {
  it('estimates the remaining time linearly', () => {
    expect(estimateRemainingMs(0, 100, 0)).toBeNull();
    expect(estimateRemainingMs(50, 100, 1000)).toBe(1000);
    expect(estimateRemainingMs(100, 100, 1000)).toBeNull();
  });

  it('formats clocks as m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(61_400)).toBe('1:01');
    expect(formatClock(-5)).toBe('0:00');
  });
});
