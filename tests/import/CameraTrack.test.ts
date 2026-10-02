import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { CAMERA_TRACK_FORMAT, CameraTrack, type CameraPose } from '../../src/import/CameraTrack';

function pose(): CameraPose {
  return { position: new Vector3(), target: new Vector3(), fov: 0 };
}

describe('CameraTrack', () => {
  it('keeps keys sorted and merges keys within the tolerance', () => {
    const t = new CameraTrack();
    t.add({ t: 2, position: [0, 0, 2], target: [0, 1, 0], fov: 35 });
    t.add({ t: 0, position: [0, 0, 0], target: [0, 1, 0], fov: 35 });
    t.add({ t: 1, position: [0, 0, 1], target: [0, 1, 0], fov: 35 });
    expect(t.keys.map((k) => k.t)).toEqual([0, 1, 2]);
    const idx = t.add({ t: 1.01, position: [9, 9, 9], target: [0, 1, 0], fov: 50 });
    expect(idx).toBe(1);
    expect(t.length).toBe(3);
    expect(t.keys[1].t).toBe(1);
    expect(t.keys[1].position).toEqual([9, 9, 9]);
    expect(t.keys[1].fov).toBe(50);
    expect(t.nearest(1.9)).toBe(2);
    expect(t.nearest(5, 0.5)).toBe(-1);
    expect(t.nextKeyTime(1)).toBe(2);
    expect(t.prevKeyTime(1)).toBe(0);
    expect(t.removeAt(2)).toBe(true);
    expect(t.length).toBe(2);
  });

  it('holds outside the keys and interpolates linearly between two keys', () => {
    const t = new CameraTrack([
      { t: 0, position: [0, 1, 4], target: [0, 1, 0], fov: 30, ease: 'linear' },
      { t: 2, position: [4, 1, 0], target: [0, 1, 0], fov: 50, ease: 'linear' },
    ]);
    const out = pose();
    expect(t.evaluate(-1, out)!.position.toArray()).toEqual([0, 1, 4]);
    expect(t.evaluate(5, out)!.fov).toBe(50);
    const mid = t.evaluate(1, out)!;
    expect(mid.position.x).toBeCloseTo(2, 6);
    expect(mid.position.z).toBeCloseTo(2, 6);
    expect(mid.fov).toBeCloseTo(40, 6);
    const q = t.evaluate(0.5, pose())!;
    expect(q.position.x).toBeCloseTo(1, 6);
  });

  it('eases smoothly and honours cuts', () => {
    const smooth = new CameraTrack([
      { t: 0, position: [0, 0, 0], target: [0, 0, 0], fov: 35, ease: 'smooth' },
      { t: 1, position: [10, 0, 0], target: [0, 0, 0], fov: 35, ease: 'smooth' },
    ]);
    expect(smooth.evaluate(0.25, pose())!.position.x).toBeCloseTo(10 * (3 * 0.0625 - 2 * 0.015625), 6);
    expect(smooth.evaluate(0.5, pose())!.position.x).toBeCloseTo(5, 6);
    const cut = new CameraTrack([
      { t: 0, position: [0, 0, 0], target: [0, 0, 0], fov: 35, ease: 'cut' },
      { t: 1, position: [10, 0, 0], target: [0, 0, 0], fov: 35, ease: 'cut' },
    ]);
    expect(cut.evaluate(0.99, pose())!.position.x).toBe(0);
    expect(cut.evaluate(1, pose())!.position.x).toBe(10);
  });

  it('passes through every key on a spline with three or more keys', () => {
    const keys = [
      { t: 0, position: [0, 0, 3] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 35, ease: 'linear' as const },
      { t: 1, position: [3, 0, 0] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 35, ease: 'linear' as const },
      { t: 2, position: [0, 0, -3] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 35, ease: 'linear' as const },
    ];
    const t = new CameraTrack(keys);
    for (const k of keys) {
      const p = t.evaluate(k.t, pose())!.position;
      expect(p.distanceTo(new Vector3(...k.position))).toBeLessThan(1e-6);
    }
    // Midway between the first two keys the spline bulges outward (stays near the circle), unlike a chord.
    const mid = t.evaluate(0.5, pose())!.position;
    expect(mid.length()).toBeGreaterThan(2.1);
  });

  it('serializes and parses, skipping malformed keys', () => {
    const t = new CameraTrack([{ t: 0.5, position: [1, 2, 3], target: [0, 1, 0], fov: 40, ease: 'cut' }]);
    const json = JSON.parse(JSON.stringify(t.toJSON()));
    expect(json.format).toBe(CAMERA_TRACK_FORMAT);
    json.keys.push({ t: 'bad' }, { t: 2, position: [0, 0, 1], target: [0, 0, 0] });
    const back = CameraTrack.fromJSON(json);
    expect(back.length).toBe(2);
    expect(back.keys[0]).toEqual({ t: 0.5, position: [1, 2, 3], target: [0, 1, 0], fov: 40, ease: 'cut' });
    expect(back.keys[1].fov).toBe(35);
    expect(back.keys[1].ease).toBe('smooth');
    expect(() => CameraTrack.fromJSON({ format: 'nope' })).toThrow(/format/);
    expect(() => CameraTrack.fromJSON(null)).toThrow();
  });

  it('generates an orbit shot around the character', () => {
    const t = CameraTrack.orbit({ center: [0, 0, 0], radius: 3, height: 1.2, durationSec: 6, turns: 1, count: 9, lookAtHeight: 0.9 });
    expect(t.length).toBe(9);
    expect(t.keys[0].t).toBe(0);
    expect(t.keys[8].t).toBeCloseTo(6, 9);
    for (const k of t.keys) {
      expect(Math.hypot(k.position[0], k.position[2])).toBeCloseTo(3, 6);
      expect(k.position[1]).toBeCloseTo(1.2, 6);
      expect(k.target).toEqual([0, 0.9, 0]);
    }
    // Starts in front (+Z) and is behind the character half-way round.
    expect(t.keys[0].position[2]).toBeCloseTo(3, 6);
    expect(t.evaluate(3, pose())!.position.z).toBeCloseTo(-3, 1);
    t.shift(1);
    expect(t.keys[0].t).toBe(1);
  });
});
