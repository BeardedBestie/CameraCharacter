import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { PoseFrame, SmoothingSettings } from '../../src/core/types';
import { FACE_BASIS_CHANGE, PoseFilter, faceRotationFromMatrix, landmarkGroup } from '../../src/tracking/PoseFilter';
import { mirrorMatrixYZ } from '../../src/tracking/convert';
import { LM, POSE_MIRROR_INDEX } from '../../src/tracking/landmarks';
import { SMOOTHING, makeHand, makePoseFrame, yawMatrix } from './fixtures';

const DT = 33;
/** First frame time at which a gate opened with the default 150 ms dwell (frames at 0, 33, …). */
const OPEN_T = 165;

function runStatic(f: PoseFilter, from: number, to: number, visibility = 1, mutate?: (fr: PoseFrame) => void) {
  let out = f.process(makePoseFrame(from, {}, visibility));
  for (let t = from + DT; t <= to; t += DT) {
    const fr = makePoseFrame(t, {}, visibility);
    mutate?.(fr);
    out = f.process(fr);
  }
  return out;
}

function nullFrame(t: number): PoseFrame {
  return { v: 2, t, src: 'test', size: [640, 480], pose: null };
}

describe('PoseFilter conversion', () => {
  it('produces the FilteredPose contract in three.js coords with image coords kept', () => {
    const f = new PoseFilter(SMOOTHING, false);
    const frame = makePoseFrame(0, { now: 12345.5 });
    const out = f.process(frame);
    expect(out.present).toBe(true);
    expect(out.t).toBe(0);
    expect(out.now).toBe(12345.5);
    expect(out.absentFor).toBe(0);
    expect(out.mirror).toBe(false);
    expect(out.size).toEqual([640, 480]);
    const i = 5;
    expect(out.world[i].x).toBeCloseTo(0.01 * i, 9);
    expect(out.world[i].y).toBeCloseTo(-0.02 * i, 9);
    expect(out.world[i].z).toBeCloseTo(-0.03 * i, 9);
    expect(out.image[i].x).toBeCloseTo(frame.pose!.image[i][0], 9);
    expect(out.image[i].y).toBeCloseTo(frame.pose!.image[i][1], 9);
    expect(out.image[i].z).toBeCloseTo(frame.pose!.image[i][2], 9);
    for (const key of ['world', 'image', 'visibility', 'inFrame', 'gated', 'confidence'] as const) {
      expect(out[key]).toHaveLength(33);
    }
    expect(out.inFrame.every((v) => v)).toBe(true);
    expect(out.hands).toEqual({ left: null, right: null });
    expect(out.face).toBeNull();
    // `now` is NaN when the frame has none.
    expect(Number.isNaN(f.process(makePoseFrame(DT)).now)).toBe(true);
  });

  it('mirror mode swaps left/right landmarks, negates world x and mirrors image x to 1-x', () => {
    const plain = new PoseFilter(SMOOTHING, false).process(makePoseFrame(0));
    const mirrored = new PoseFilter(SMOOTHING, true).process(makePoseFrame(0));
    expect(mirrored.mirror).toBe(true);
    const L = LM.LEFT_WRIST;
    const R = LM.RIGHT_WRIST;
    expect(POSE_MIRROR_INDEX[L]).toBe(R);
    expect(mirrored.world[L].x).toBeCloseTo(-plain.world[R].x, 9);
    expect(mirrored.world[L].y).toBeCloseTo(plain.world[R].y, 9);
    expect(mirrored.world[L].z).toBeCloseTo(plain.world[R].z, 9);
    expect(mirrored.image[L].x).toBeCloseTo(1 - plain.image[R].x, 9);
    expect(mirrored.image[L].y).toBeCloseTo(plain.image[R].y, 9);
    expect(mirrored.world[LM.NOSE].x).toBeCloseTo(-plain.world[LM.NOSE].x, 9);
    expect(mirrored.image[LM.NOSE].x).toBeCloseTo(1 - plain.image[LM.NOSE].x, 9);
  });

  it('converts hands to three.js local coords and swaps + negates them in mirror mode', () => {
    const frame = makePoseFrame(0, { hands: { left: makeHand(1), right: makeHand(2) } });
    const plain = new PoseFilter(SMOOTHING, false).process(frame);
    expect(plain.hands.left!.local[0].x).toBeCloseTo(1, 9);
    expect(plain.hands.left!.local[0].y).toBeCloseTo(-0.2, 9);
    expect(plain.hands.left!.local[0].z).toBeCloseTo(-0.3, 9);
    expect(plain.hands.left!.image[0].x).toBeCloseTo(0.4, 9);
    expect(plain.hands.right!.local[0].x).toBeCloseTo(2, 9);
    expect(plain.hands.right!.score).toBe(0.9);

    const mirrored = new PoseFilter(SMOOTHING, true).process(frame);
    expect(mirrored.hands.left!.local[0].x).toBeCloseTo(-2, 9);
    expect(mirrored.hands.right!.local[0].x).toBeCloseTo(-1, 9);
    expect(mirrored.hands.right!.local[0].y).toBeCloseTo(-0.2, 9);
    expect(mirrored.hands.right!.image[0].x).toBeCloseTo(1 - 0.4, 9);
    expect(mirrored.hands.left!.image[0].x).toBeCloseTo(1 - 0.5, 9);
  });

  it('mirrors face blendshape names and conjugates the head rotation by diag(-1,1,1)', () => {
    const yaw = Math.PI / 6;
    const frame = makePoseFrame(0, {
      face: { blendshapes: { eyeBlinkLeft: 0.8, eyeBlinkRight: 0.1, jawOpen: 0.5 }, matrix: yawMatrix(yaw, 0.5, 0.2, 0.3) },
    });
    const plain = new PoseFilter(SMOOTHING, false).process(frame);
    expect(plain.face!.blendshapes.eyeBlinkLeft).toBe(0.8);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    expect(Math.abs(plain.face!.rotation!.dot(expected))).toBeCloseTo(1, 9);

    const mirrored = new PoseFilter(SMOOTHING, true).process(frame);
    expect(mirrored.face!.blendshapes.eyeBlinkLeft).toBe(0.1);
    expect(mirrored.face!.blendshapes.eyeBlinkRight).toBe(0.8);
    expect(mirrored.face!.blendshapes.jawOpen).toBe(0.5);
    const expectedMirror = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -yaw);
    expect(Math.abs(mirrored.face!.rotation!.dot(expectedMirror))).toBeCloseTo(1, 9);
  });

  it('face rotation: identity matrix → identity quaternion; determinant stays +1 after mirroring', () => {
    expect(FACE_BASIS_CHANGE.equals(new Quaternion())).toBe(true);
    const id = new Matrix4().identity().toArray();
    const q = faceRotationFromMatrix(id)!;
    expect(q.x).toBeCloseTo(0, 12);
    expect(q.y).toBeCloseTo(0, 12);
    expect(q.z).toBeCloseTo(0, 12);
    expect(Math.abs(q.w)).toBeCloseTo(1, 12);
    const rot = yawMatrix(0.7, 1, 2, 3);
    const mirrored = mirrorMatrixYZ(rot);
    const det = new Matrix4().fromArray(mirrored).extractRotation(new Matrix4().fromArray(mirrored)).determinant();
    expect(det).toBeCloseTo(1, 9);
    const qm = faceRotationFromMatrix(mirrored)!;
    const back = new Matrix4().makeRotationFromQuaternion(qm).toArray();
    for (const idx of [0, 1, 2, 4, 5, 6, 8, 9, 10]) expect(back[idx]).toBeCloseTo(mirrored[idx], 9);
    // Malformed matrices yield null.
    expect(faceRotationFromMatrix(null)).toBeNull();
    expect(faceRotationFromMatrix([1, 2, 3])).toBeNull();
    expect(faceRotationFromMatrix(new Array(16).fill(0))).toBeNull();
    expect(faceRotationFromMatrix(new Array(16).fill(NaN))).toBeNull();
  });
});

describe('PoseFilter gating', () => {
  it('groups landmarks: face 0-10, feet 27-32, body otherwise', () => {
    expect(landmarkGroup(0)).toBe('face');
    expect(landmarkGroup(10)).toBe('face');
    expect(landmarkGroup(11)).toBe('body');
    expect(landmarkGroup(26)).toBe('body');
    expect(landmarkGroup(27)).toBe('feet');
    expect(landmarkGroup(32)).toBe('feet');
  });

  it('opens only after the dwell time and a single visibility spike never opens it', () => {
    const f = new PoseFilter(SMOOTHING, false);
    let out = f.process(makePoseFrame(0, {}, 1));
    expect(out.gated.every((g) => !g)).toBe(true);
    for (let t = DT; t < SMOOTHING.gateDwellMs; t += DT) {
      out = f.process(makePoseFrame(t, {}, 1));
      expect(out.gated[LM.NOSE]).toBe(false);
    }
    out = f.process(makePoseFrame(OPEN_T, {}, 1));
    expect(out.gated.every((g) => g)).toBe(true);
    expect(out.visibility[0]).toBeGreaterThan(0.9);

    const spike = new PoseFilter(SMOOTHING, false);
    spike.process(makePoseFrame(0, {}, 1));
    let o = spike.process(makePoseFrame(DT, {}, 0));
    for (let t = 2 * DT; t < 1000; t += DT) {
      o = spike.process(makePoseFrame(t, {}, 0));
      expect(o.gated.some((g) => g)).toBe(false);
    }
    expect(o.confidence.every((c) => c === 0)).toBe(true);
  });

  it('releases after outOfFrameReleaseMs when the landmark leaves the frame (visibility still high)', () => {
    const f = new PoseFilter(SMOOTHING, false);
    let out = runStatic(f, 0, 330);
    expect(out.gated[LM.LEFT_WRIST]).toBe(true);
    const leave = (fr: PoseFrame) => {
      fr.pose!.image[LM.LEFT_WRIST][0] = 1.1; // outside the 3 % margin
    };
    const t0 = 363;
    for (let t = t0; t < t0 + SMOOTHING.outOfFrameReleaseMs; t += DT) {
      const fr = makePoseFrame(t);
      leave(fr);
      out = f.process(fr);
      expect(out.inFrame[LM.LEFT_WRIST]).toBe(false);
      expect(out.gated[LM.LEFT_WRIST]).toBe(true);
    }
    const fr = makePoseFrame(t0 + 4 * DT);
    leave(fr);
    out = f.process(fr);
    expect(out.gated[LM.LEFT_WRIST]).toBe(false);
    expect(out.confidence[LM.LEFT_WRIST]).toBe(0);
    // Neighbours stay open; a landmark just inside the margin counts as in frame.
    expect(out.gated[LM.RIGHT_WRIST]).toBe(true);
    const edge = makePoseFrame(t0 + 5 * DT);
    edge.pose!.image[LM.RIGHT_WRIST][0] = 1.02;
    expect(f.process(edge).inFrame[LM.RIGHT_WRIST]).toBe(true);
  });

  it('applies feet thresholds to ankles/heels/toes and face thresholds to face landmarks', () => {
    const f = new PoseFilter(SMOOTHING, false);
    // 0.55 is above the feet `on` (0.5) but below body (0.65) and face (0.8).
    const out = runStatic(f, 0, 600, 0.55);
    for (let i = 27; i <= 32; i++) expect(out.gated[i]).toBe(true);
    for (let i = 11; i <= 26; i++) expect(out.gated[i]).toBe(false);
    for (let i = 0; i <= 10; i++) expect(out.gated[i]).toBe(false);

    const g = new PoseFilter(SMOOTHING, false);
    const out2 = runStatic(g, 0, 600, 0.7);
    for (let i = 0; i <= 10; i++) expect(out2.gated[i]).toBe(false);
    for (let i = 11; i <= 32; i++) expect(out2.gated[i]).toBe(true);
  });

  it('does not flicker in the hysteresis band', () => {
    const f = new PoseFilter(SMOOTHING, false);
    let out = runStatic(f, 0, 400);
    expect(out.gated[LM.NOSE]).toBe(true);
    for (let t = 433; t < 2000; t += DT) {
      out = f.process(makePoseFrame(t, {}, 0.7)); // between face off (0.6) and on (0.8)
      expect(out.gated[LM.NOSE]).toBe(true);
    }
  });

  it('freezes the filters while a gate is closed and restarts from the true position on reopen', () => {
    const f = new PoseFilter(SMOOTHING, false);
    let out = runStatic(f, 0, 500);
    const held = out.world[LM.LEFT_ELBOW].clone();
    // Visibility collapses (still in frame): the gate releases after gateReleaseMs once ema <= off.
    let t = 533;
    while (out.gated[LM.LEFT_ELBOW]) {
      out = f.process(makePoseFrame(t, {}, 0));
      t += DT;
      expect(t).toBeLessThan(2000);
    }
    // While closed the landmark moves far away: the output stays frozen.
    for (let k = 0; k < 10; k++, t += DT) {
      const fr = makePoseFrame(t, {}, 0);
      fr.pose!.world[LM.LEFT_ELBOW][0] += 1;
      out = f.process(fr);
      expect(out.world[LM.LEFT_ELBOW].distanceTo(held)).toBeLessThan(1e-12);
      expect(out.confidence[LM.LEFT_ELBOW]).toBe(0);
    }
    // Visibility returns at the new position: after the dwell the gate reopens exactly at the true position.
    let reopened: number | null = null;
    for (let k = 0; k < 20; k++, t += DT) {
      const fr = makePoseFrame(t, {}, 1);
      fr.pose!.world[LM.LEFT_ELBOW][0] += 1;
      out = f.process(fr);
      if (out.gated[LM.LEFT_ELBOW]) {
        reopened = t;
        break;
      }
      expect(out.world[LM.LEFT_ELBOW].distanceTo(held)).toBeLessThan(1e-12);
    }
    expect(reopened).not.toBeNull();
    expect(out.world[LM.LEFT_ELBOW].x).toBeCloseTo(0.01 * LM.LEFT_ELBOW + 1, 9);
  });

  it('uses the larger finite visibility of the world and image arrays', () => {
    const f = new PoseFilter(SMOOTHING, false);
    let out = f.process(makePoseFrame(0));
    for (let t = DT; t <= 400; t += DT) {
      const fr = makePoseFrame(t);
      for (const p of fr.pose!.world) p[3] = 0;
      for (const p of fr.pose!.image) p[3] = 1;
      out = f.process(fr);
    }
    expect(out.visibility[LM.NOSE]).toBeGreaterThan(0.9);
    expect(out.gated.every((g) => g)).toBe(true);

    const g = new PoseFilter(SMOOTHING, false);
    for (let t = 0; t <= 400; t += DT) {
      const fr = makePoseFrame(t);
      for (const p of fr.pose!.world) p[3] = NaN;
      for (const p of fr.pose!.image) p[3] = 0.9;
      out = g.process(fr);
    }
    expect(out.visibility[LM.LEFT_HIP]).toBeCloseTo(0.9, 6);
  });
});

describe('PoseFilter confidence and presence', () => {
  it('soft confidence is a smoothstep between off and on, times the re-acquire ramp', () => {
    const settings: SmoothingSettings = { ...SMOOTHING, gateBody: { on: 0.9, off: 0.5 } };
    const f = new PoseFilter(settings, false);
    let out = f.process(makePoseFrame(0, {}, 1));
    expect(out.reacquireRamp).toBe(0);
    out = f.process(makePoseFrame(OPEN_T, {}, 1));
    expect(out.gated[LM.LEFT_HIP]).toBe(true);
    expect(out.reacquireRamp).toBeCloseTo(OPEN_T / SMOOTHING.reacquireRampMs, 9);
    expect(out.confidence[LM.LEFT_HIP]).toBeCloseTo(OPEN_T / SMOOTHING.reacquireRampMs, 9);
    out = runStatic(f, 198, 1000);
    expect(out.reacquireRamp).toBe(1);
    expect(out.confidence[LM.LEFT_HIP]).toBeCloseTo(1, 9);
    // Visibility settles at 0.7: halfway between off and on → smoothstep(0.5) = 0.5, gate still open.
    out = runStatic(f, 1033, 3000, 0.7);
    expect(out.gated[LM.LEFT_HIP]).toBe(true);
    expect(out.visibility[LM.LEFT_HIP]).toBeCloseTo(0.7, 3);
    expect(out.confidence[LM.LEFT_HIP]).toBeCloseTo(0.5, 2);
  });

  it('keeps finite arrays when the pose is null, counts absence, releases gates and restarts the ramp on return', () => {
    const f = new PoseFilter(SMOOTHING, true);
    let out = runStatic(f, 0, 500);
    const lastWorld = out.world.map((v) => v.clone());
    const lastPresentMs = out.t * 1000;
    expect(out.gated.every((g) => g)).toBe(true);

    out = f.process(nullFrame(533));
    expect(out.present).toBe(false);
    expect(out.absentFor).toBeCloseTo((533 - lastPresentMs) / 1000, 9);
    expect(out.reacquireRamp).toBe(0);
    expect(out.confidence.every((c) => c === 0)).toBe(true);
    for (let i = 0; i < 33; i++) {
      expect(Number.isFinite(out.world[i].x + out.world[i].y + out.world[i].z)).toBe(true);
      expect(Number.isFinite(out.image[i].x + out.image[i].y + out.image[i].z)).toBe(true);
      expect(Number.isFinite(out.visibility[i])).toBe(true);
      expect(out.world[i].distanceTo(lastWorld[i])).toBeLessThan(1e-12);
      expect(out.inFrame[i]).toBe(false);
    }
    // Within the out-of-frame release window the gates stay open; past it they close.
    expect(out.gated[0]).toBe(true);
    out = f.process(nullFrame(566));
    out = f.process(nullFrame(600));
    out = f.process(nullFrame(633));
    expect(out.gated.every((g) => !g)).toBe(true);
    for (let t = 666; t < 3000; t += DT) out = f.process(nullFrame(t));
    expect(out.absentFor).toBeCloseTo((2966 - lastPresentMs) / 1000, 9);
    for (let i = 0; i < 33; i++) expect(Number.isFinite(out.world[i].x)).toBe(true);

    // The pose returns: ramp restarts from 0 and reaches 1 after reacquireRampMs.
    out = f.process(makePoseFrame(3000));
    expect(out.present).toBe(true);
    expect(out.absentFor).toBe(0);
    expect(out.reacquireRamp).toBe(0);
    out = runStatic(f, 3033, 3000 + SMOOTHING.reacquireRampMs);
    expect(out.reacquireRamp).toBe(1);
    expect(out.gated.every((g) => g)).toBe(true);
  });

  it('a first frame without a subject reports the time since the first frame', () => {
    const f = new PoseFilter(SMOOTHING, false);
    expect(f.process(nullFrame(100)).absentFor).toBe(0);
    expect(f.process(nullFrame(1100)).absentFor).toBeCloseTo(1, 9);
  });
});

describe('PoseFilter smoothing', () => {
  it('scale-free step: 90 % within 3 frames with beta 30, more than 8 frames with beta 0', () => {
    const settle = (beta: number): number => {
      const f = new PoseFilter({ ...SMOOTHING, oneEuroBeta: beta }, false);
      runStatic(f, 0, 500);
      let frames = 0;
      for (let t = 533; t < 5000; t += DT) {
        const fr = makePoseFrame(t);
        fr.pose!.world[LM.LEFT_WRIST][0] += 0.3;
        const out = f.process(fr);
        frames++;
        if (out.world[LM.LEFT_WRIST].x - 0.01 * LM.LEFT_WRIST >= 0.27) return frames;
      }
      return Infinity;
    };
    expect(settle(30)).toBeLessThanOrEqual(3);
    expect(settle(0)).toBeGreaterThan(8);
  });

  it('reduces alternating noise while preserving the mean', () => {
    const f = new PoseFilter({ ...SMOOTHING, oneEuroMinCutoff: 1.0, oneEuroBeta: 0.0 }, false);
    const amp = 0.05;
    let maxDev = 0;
    let sum = 0;
    let count = 0;
    for (let k = 0; k < 120; k++) {
      const t = k * DT;
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
    runStatic(f, 0, 300);
    f.setMirror(true);
    expect(f.isMirrored).toBe(true);
    const out = f.process(makePoseFrame(333));
    const plain = new PoseFilter(SMOOTHING, true).process(makePoseFrame(333));
    expect(out.world[LM.LEFT_ELBOW].x).toBeCloseTo(plain.world[LM.LEFT_ELBOW].x, 9);
  });

  it('setSettings updates gate thresholds and reset() clears the state', () => {
    const f = new PoseFilter(SMOOTHING, false);
    f.setSettings({ ...SMOOTHING, gateBody: { on: 0.99, off: 0.98 }, gateFace: { on: 0.99, off: 0.98 }, gateFeet: { on: 0.99, off: 0.98 } });
    const out = runStatic(f, 0, 500, 0.9);
    expect(out.gated.some((g) => g)).toBe(false);
    expect(f.getSettings().gateBody.on).toBe(0.99);

    const g = new PoseFilter(SMOOTHING, false);
    runStatic(g, 0, 500);
    g.reset();
    const fresh = g.process(makePoseFrame(1000));
    expect(fresh.gated.some((x) => x)).toBe(false);
    expect(fresh.reacquireRamp).toBe(0);
    expect(fresh.absentFor).toBe(0);
  });
});
