import { describe, expect, it } from 'vitest';
import { ScaleFreeOneEuro, ScaleFreeOneEuro3 } from '../../src/tracking/scaleFreeOneEuro';

const DT = 0.033;

function framesToReach(beta: number, scale: number, step = 0.3, target = 0.9): number {
  const f = new ScaleFreeOneEuro({ minCutoff: 1, beta, dCutoff: 1 });
  let t = 0;
  for (let i = 0; i < 30; i++, t += DT) f.filter(0, t, scale);
  for (let n = 1; n <= 100; n++, t += DT) {
    if (f.filter(step, t, scale) >= target * step) return n;
  }
  return Infinity;
}

describe('ScaleFreeOneEuro', () => {
  it('DESIGN §11 step test: 0.3 units in 33 ms at subject size 0.25', () => {
    expect(framesToReach(30, 0.25)).toBeLessThanOrEqual(3);
    expect(framesToReach(0, 0.25)).toBeGreaterThan(8);
  });

  it('is scale-free: the same step relative to the subject size settles in the same number of frames', () => {
    // 0.3 at size 0.25 (image units) vs 0.6 at size 0.5 (meters).
    expect(framesToReach(30, 0.25, 0.3)).toBe(framesToReach(30, 0.5, 0.6));
    // A tiny subject makes the same absolute step "fast" and settles at least as quickly.
    expect(framesToReach(30, 0.05, 0.3)).toBeLessThanOrEqual(framesToReach(30, 0.5, 0.3));
  });

  it('passes the first sample through, resets cleanly and never returns NaN for a bad scale', () => {
    const f = new ScaleFreeOneEuro({ minCutoff: 1, beta: 30, dCutoff: 1 });
    expect(f.hasValue()).toBe(false);
    expect(f.filter(0.7, 0, 0.25)).toBe(0.7);
    expect(f.last()).toBe(0.7);
    expect(Number.isFinite(f.filter(0.9, DT, NaN))).toBe(true);
    expect(Number.isFinite(f.filter(0.9, 2 * DT, 0))).toBe(true);
    // Non-advancing time reinitialises.
    expect(f.filter(5, 2 * DT, 0.25)).toBe(5);
    f.reset();
    expect(f.hasValue()).toBe(false);
    expect(f.filter(-1, 0, 0.25)).toBe(-1);
  });

  it('ScaleFreeOneEuro3 filters three components with a separate z parameter set', () => {
    const p = { minCutoff: 1, beta: 0, dCutoff: 1 };
    const f = new ScaleFreeOneEuro3(p, { ...p, minCutoff: 0.5 });
    const out: number[] = [];
    f.filter(0, 0, 0, 0, 0.25, out);
    f.filter(1, 1, 1, DT, 0.25, out);
    // Lower cutoff on z lags more than x/y.
    expect(out[0]).toBeCloseTo(out[1], 12);
    expect(out[2]).toBeLessThan(out[0]);
    expect(f.hasValue()).toBe(true);
    f.reset();
    expect(f.hasValue()).toBe(false);
  });
});
