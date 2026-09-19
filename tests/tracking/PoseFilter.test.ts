import { describe, expect, it } from 'vitest';
import { PoseFilter } from '../../src/tracking/PoseFilter';
import { LM, POSE_MIRROR_INDEX } from '../../src/tracking/landmarks';
import { makePoseFrame, SMOOTHING } from './fixtures';

describe('PoseFilter conversion', () => {
  it('converts MediaPipe world coords to three.js (x, -y, -z) and keeps image coords', () => {
    const f = new PoseFilter(SMOOTHING, false);
    const frame = makePoseFrame(0);
    const out = f.process(frame);
    expect(out.present).toBe(true);
    expect(out.t).toBe(0);
    expect(out.mirror).toBe(false);
    expect(out.size).toEqual([640, 480]);
    const i = 5;
    expect(out.world[i].x).toBeCloseTo(0.01 * i, 9);
    expect(out.world[i].y).toBeCloseTo(-0.02 * i, 9);
    expect(out.world[i].z).toBeCloseTo(-0.03 * i, 9);
    expect(out.image[i].x).toBeCloseTo(frame.pose!.image[i][0], 9);
    expect(out.image[i].y).toBeCloseTo(frame.pose!.image[i][1], 9);
    expect(out.image[i].z).toBeCloseTo(frame.pose!.image[i][2], 9);
    expect(out.world).toHaveLength(33);
    expect(out.visible).toHaveLength(33);
  });

  it('mirror mode swaps left/right landmarks, negates world x and mirrors image x to 1-x', () => {
    const plain = new PoseFilter(SMOOTHING, false).process(makePoseFrame(0));
    const mirrored = new PoseFilter(SMOOTHING, true).process(makePoseFrame(0));
    expect(mirrored.mirror).toBe(true);
    const L = LM.LEFT_WRIST;
    const R = LM.RIGHT_WRIST;
    expect(POSE_MIRROR_INDEX[L]).toBe(R);
    // The mirrored left wrist is the plain right wrist with x negated.
    expect(mirrored.world[L].x).toBeCloseTo(-plain.world[R].x, 9);
    expect(mirrored.world[L].y).toBeCloseTo(plain.world[R].y, 9);
    expect(mirrored.world[L].z).toBeCloseTo(plain.world[R].z, 9);
    expect(mirrored.image[L].x).toBeCloseTo(1 - plain.image[R].x, 9);
    expect(mirrored.image[L].y).toBeCloseTo(plain.image[R].y, 9);
    // Center landmarks map to themselves.
    expect(mirrored.world[LM.NOSE].x).toBeCloseTo(-plain.world[LM.NOSE].x, 9);
    expect(mirrored.image[LM.NOSE].x).toBeCloseTo(1 - plain.image[LM.NOSE].x, 9);
  });

  it('mirror mode swaps hands and negates their x, and mirrors the face', () => {
    const hand = (k: number) => ({
      world: Array.from({ length: 21 }, (_, i) => [k + i * 0.001, 0.2, 0.3] as [number, number, number]),
      image: Array.from({ length: 21 }, () => [0.5, 0.5, 0] as [number, number, number]),
      score: 0.9,
    });
    const frame = makePoseFrame(0, {
      hands: { left: hand(1), right: hand(2) },
      face: { blendshapes: { eyeBlinkLeft: 0.8, eyeBlinkRight: 0.1, jawOpen: 0.5 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0.2, 0.3, 1] },
    });
    const plain = new PoseFilter(SMOOTHING, false).process(frame);
    expect(plain.hands.left![0].x).toBeCloseTo(1, 9);
    expect(plain.hands.left![0].y).toBeCloseTo(-0.2, 9);
    expect(plain.hands.left![0].z).toBeCloseTo(-0.3, 9);
    expect(plain.hands.right![0].x).toBeCloseTo(2, 9);
    expect(plain.face!.blendshapes.eyeBlinkLeft).toBe(0.8);

    const mirrored = new PoseFilter(SMOOTHING, true).process(frame);
    expect(mirrored.hands.left![0].x).toBeCloseTo(-2, 9);
    expect(mirrored.hands.right![0].x).toBeCloseTo(-1, 9);
    expect(mirrored.hands.right![0].y).toBeCloseTo(-0.2, 9);
    expect(mirrored.face!.blendshapes.eyeBlinkLeft).toBe(0.1);
    expect(mirrored.face!.blendshapes.eyeBlinkRight).toBe(0.8);
    expect(mirrored.face!.blendshapes.jawOpen).toBe(0.5);
    expect(mirrored.face!.matrix![12]).toBeCloseTo(-0.5, 9);
    expect(mirrored.face!.matrix![13]).toBeCloseTo(0.2, 9);
  });

  it('returns null hands/face when the frame has none', () => {
    const out = new PoseFilter(SMOOTHING, true).process(makePoseFrame(0));
    expect(out.hands).toEqual({ left: null, right: null });
    expect(out.face).toBeNull();
  });
});

describe('PoseFilter gating', () => {
  it('opens when visibility is high and closes only after the hold time', () => {
    const f = new PoseFilter({ ...SMOOTHING, holdMs: 250, visibilityOn: 0.65, visibilityOff: 0.45 }, false);
    // Several visible frames: low-pass converges and the gate opens.
    let out = f.process(makePoseFrame(0, {}, 1));
    for (let t = 33; t <= 330; t += 33) out = f.process(makePoseFrame(t, {}, 1));
    expect(out.visible.every((v) => v)).toBe(true);
    expect(out.visibility[0]).toBeGreaterThan(0.9);

    // Visibility drops to zero: within the hold window the gate stays open.
    out = f.process(makePoseFrame(363, {}, 0));
    out = f.process(makePoseFrame(400, {}, 0));
    expect(out.visible[0]).toBe(true);
    // Past the hold time it closes.
    out = f.process(makePoseFrame(700, {}, 0));
    expect(out.visible[0]).toBe(false);
    expect(out.visibility[0]).toBeLessThan(0.45);
  });

  it('does not flicker in the hysteresis band', () => {
    const f = new PoseFilter({ ...SMOOTHING, holdMs: 0 }, false);
    let out = f.process(makePoseFrame(0, {}, 1));
    for (let t = 33; t < 400; t += 33) out = f.process(makePoseFrame(t, {}, 1));
    expect(out.visible[0]).toBe(true);
    for (let t = 400; t < 1000; t += 33) {
      out = f.process(makePoseFrame(t, {}, 0.55)); // between off and on thresholds
      expect(out.visible[0]).toBe(true);
    }
  });

  it('keeps the last arrays without NaN when the pose is null and closes gates after the hold', () => {
    const f = new PoseFilter({ ...SMOOTHING, holdMs: 100 }, true);
    let out = f.process(makePoseFrame(0));
    for (let t = 33; t < 300; t += 33) out = f.process(makePoseFrame(t));
    const lastWorld = out.world.map((v) => v.clone());
    expect(out.visible.every((v) => v)).toBe(true);

    out = f.process({ v: 2, t: 333, src: 'test', size: [640, 480], pose: null });
    expect(out.present).toBe(false);
    for (let i = 0; i < 33; i++) {
      expect(Number.isFinite(out.world[i].x)).toBe(true);
      expect(Number.isFinite(out.world[i].y)).toBe(true);
      expect(Number.isFinite(out.world[i].z)).toBe(true);
      expect(Number.isFinite(out.image[i].x)).toBe(true);
      expect(Number.isFinite(out.visibility[i])).toBe(true);
      expect(out.world[i].distanceTo(lastWorld[i])).toBeLessThan(1e-12);
    }
    // Still inside the hold: gates open.
    expect(out.visible[0]).toBe(true);
    out = f.process({ v: 2, t: 600, src: 'test', size: [640, 480], pose: null });
    expect(out.visible.every((v) => !v)).toBe(true);
    for (let i = 0; i < 33; i++) expect(Number.isFinite(out.world[i].x)).toBe(true);
  });

  it('resets filters after a long absence so the new pose snaps in without lag', () => {
    const f = new PoseFilter(SMOOTHING, false);
    for (let t = 0; t < 500; t += 33) f.process(makePoseFrame(t));
    for (let t = 533; t < 2000; t += 33) f.process({ v: 2, t, src: 'test', size: [640, 480], pose: null });
    // A very different pose after > 1 s absence: output equals the input exactly (no residual smoothing).
    const shifted = makePoseFrame(2100);
    for (const p of shifted.pose!.world) p[0] += 5;
    const out = f.process(shifted);
    expect(out.present).toBe(true);
    expect(out.world[3].x).toBeCloseTo(5 + 0.03, 9);
  });
});

describe('PoseFilter smoothing', () => {
  it('reduces alternating noise while preserving the mean', () => {
    const f = new PoseFilter({ ...SMOOTHING, oneEuroMinCutoff: 1.0, oneEuroBeta: 0.0 }, false);
    const amp = 0.05;
    let maxDev = 0;
    let sum = 0;
    let count = 0;
    for (let k = 0; k < 120; k++) {
      const t = k * 33;
      const frame = makePoseFrame(t);
      const noise = k % 2 === 0 ? amp : -amp;
      for (const p of frame.pose!.world) p[0] += noise;
      const out = f.process(frame);
      if (k >= 30) {
        const dev = Math.abs(out.world[0].x - 0);
        maxDev = Math.max(maxDev, dev);
        sum += out.world[0].x;
        count++;
      }
    }
    expect(maxDev).toBeLessThan(amp * 0.5);
    expect(Math.abs(sum / count)).toBeLessThan(amp * 0.1);
  });

  it('setMirror resets the filters and switches convention immediately', () => {
    const f = new PoseFilter(SMOOTHING, false);
    for (let t = 0; t < 300; t += 33) f.process(makePoseFrame(t));
    f.setMirror(true);
    expect(f.isMirrored).toBe(true);
    const out = f.process(makePoseFrame(333));
    const plain = new PoseFilter(SMOOTHING, true).process(makePoseFrame(333));
    expect(out.world[LM.LEFT_ELBOW].x).toBeCloseTo(plain.world[LM.LEFT_ELBOW].x, 9);
  });

  it('setSettings updates gate thresholds', () => {
    const f = new PoseFilter(SMOOTHING, false);
    f.setSettings({ ...SMOOTHING, visibilityOn: 0.99, visibilityOff: 0.98, holdMs: 0 });
    let out = f.process(makePoseFrame(0, {}, 0.9));
    for (let t = 33; t < 500; t += 33) out = f.process(makePoseFrame(t, {}, 0.9));
    expect(out.visible[0]).toBe(false);
    expect(f.getSettings().visibilityOn).toBe(0.99);
  });
});
