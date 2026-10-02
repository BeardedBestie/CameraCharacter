import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { HeightTable } from '../../src/core/types';
import { SHOT_NAMES, shotFor } from '../../src/import/cameraShots';

const TABLE: HeightTable = { floor: 0, ankles: 0.08, knees: 0.5, hips: 0.95, shoulders: 1.45, eyes: 1.62, headTop: 1.75 };

describe('shotFor', () => {
  it('frames the whole body from the front at a sensible distance', () => {
    const s = shotFor('front', TABLE, { fov: 35 });
    expect(s.target.y).toBeCloseTo(0.875, 6);
    expect(s.position.x).toBeCloseTo(0, 6);
    expect(s.position.z).toBeGreaterThan(2.5);
    expect(s.position.z).toBeLessThan(4);
    expect(s.position.y).toBeCloseTo(s.target.y, 6);
    expect(s.fov).toBe(35);
  });

  it('places side and back shots around the character and the close-up nearer', () => {
    const left = shotFor('sideLeft', TABLE);
    expect(left.position.x).toBeGreaterThan(2);
    expect(Math.abs(left.position.z)).toBeLessThan(1e-6);
    const back = shotFor('back', TABLE);
    expect(back.position.z).toBeLessThan(-2);
    const close = shotFor('closeUp', TABLE);
    const front = shotFor('front', TABLE);
    expect(close.position.z).toBeLessThan(front.position.z);
    expect(close.target.y).toBeGreaterThan(front.target.y);
  });

  it('keeps the framing distance for low and high angles and honours the origin', () => {
    const origin = new Vector3(2, 0.5, -1);
    const front = shotFor('front', TABLE, { origin });
    const low = shotFor('low', TABLE, { origin });
    const high = shotFor('high', TABLE, { origin });
    expect(front.target.x).toBe(2);
    expect(front.target.z).toBe(-1);
    expect(low.position.y).toBeLessThan(front.position.y);
    expect(high.position.y).toBeGreaterThan(front.position.y);
    expect(low.position.distanceTo(low.target)).toBeCloseTo(front.position.distanceTo(front.target), 3);
    expect(high.position.distanceTo(high.target)).toBeCloseTo(front.position.distanceTo(front.target), 3);
    for (const name of SHOT_NAMES) {
      const s = shotFor(name, TABLE);
      for (const v of [s.position.x, s.position.y, s.position.z, s.target.y]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('survives a degenerate height table', () => {
    const s = shotFor('front', { floor: 0, ankles: 0, knees: 0, hips: 0, shoulders: 0, eyes: 0, headTop: 0 });
    expect(Number.isFinite(s.position.z)).toBe(true);
    expect(s.position.z).toBeGreaterThan(1);
  });
});
