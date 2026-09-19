import { describe, expect, it } from 'vitest';
import type { LandmarkTuple, PointTuple, PoseFrame } from '../../src/core/types';
import {
  assignHandSides,
  blendshapesToRecord,
  landmarksToTuples,
  makeHandFrame,
  matrixToArray,
  mirrorBlendshapeName,
  mirrorFaceFrame,
  mirrorHandFrame,
  mirrorMatrixYZ,
  mirrorPoseFrame,
  normalizeHandednessLabel,
  swapHandednessLabel,
} from '../../src/tracking/convert';
import { LM, POSE_MIRROR_INDEX } from '../../src/tracking/landmarks';
import { makeHand, makePoseFrame, yawMatrix } from './fixtures';

function hand(wristX: number, wristY: number, handedness: string, score = 0.9) {
  const image: PointTuple[] = Array.from({ length: 21 }, (_, i) => [wristX + i * 0.001, wristY, 0]);
  return { image, handedness, score };
}

function poseWithWrists(left: [number, number, number], right: [number, number, number]): LandmarkTuple[] {
  const pose: LandmarkTuple[] = Array.from({ length: 33 }, () => [0.5, 0.5, 0, 1]);
  pose[LM.LEFT_WRIST] = [left[0], left[1], 0, left[2]];
  pose[LM.RIGHT_WRIST] = [right[0], right[1], 0, right[2]];
  return pose;
}

/** Deep numeric comparison with a tolerance (1 − (1 − x) is not exact in floating point). */
function expectDeepClose(a: unknown, b: unknown, path = 'root'): void {
  if (typeof a === 'number' && typeof b === 'number') {
    expect(Math.abs(a - b), path).toBeLessThan(1e-12);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    expect(a.length, path).toBe(b.length);
    for (let i = 0; i < a.length; i++) expectDeepClose(a[i], b[i], `${path}[${i}]`);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    expect(ka, path).toEqual(kb);
    for (const k of ka) expectDeepClose((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  expect(a, path).toEqual(b);
}

describe('assignHandSides', () => {
  it('assigns by nearest pose wrist regardless of the handedness label', () => {
    // Subject faces the camera un-flipped: their left wrist is on the image right (x=0.7).
    const pose = poseWithWrists([0.7, 0.6, 1], [0.3, 0.6, 1]);
    const hands = [hand(0.31, 0.62, 'Left'), hand(0.69, 0.58, 'Left')];
    const sides = assignHandSides(hands, pose);
    expect(sides.right).toBe(0);
    expect(sides.left).toBe(1);
  });

  it('never puts two hands on the same side (optimal pairing)', () => {
    const pose = poseWithWrists([0.7, 0.6, 1], [0.3, 0.6, 1]);
    const hands = [hand(0.66, 0.6, 'Right'), hand(0.6, 0.6, 'Right')];
    const sides = assignHandSides(hands, pose);
    expect(sides.left).toBe(0);
    expect(sides.right).toBe(1);
  });

  it('single hand picks the nearer wrist', () => {
    const pose = poseWithWrists([0.7, 0.6, 1], [0.3, 0.6, 1]);
    expect(assignHandSides([hand(0.28, 0.6, 'Left')], pose)).toEqual({ left: null, right: 0 });
    expect(assignHandSides([hand(0.72, 0.6, 'Right')], pose)).toEqual({ left: 0, right: null });
  });

  it('ignores wrists with low visibility and uses the remaining anchor', () => {
    const pose = poseWithWrists([0.7, 0.6, 0.05], [0.3, 0.6, 1]);
    const hands = [hand(0.7, 0.6, 'Left'), hand(0.3, 0.6, 'Left')];
    const sides = assignHandSides(hands, pose);
    expect(sides.right).toBe(1);
    expect(sides.left).toBe(0);
  });

  it('falls back to the swapped handedness label without a pose', () => {
    expect(swapHandednessLabel('Left')).toBe('right');
    expect(swapHandednessLabel('Right')).toBe('left');
    const sides = assignHandSides([hand(0.2, 0.5, 'Left'), hand(0.8, 0.5, 'Right')], null);
    expect(sides.right).toBe(0);
    expect(sides.left).toBe(1);
    const conflict = assignHandSides([hand(0.2, 0.5, 'Left', 0.6), hand(0.8, 0.5, 'Left', 0.95)], null);
    expect(conflict.right).toBe(1);
    expect(conflict.left).toBe(0);
  });

  it('returns nulls for no hands and keeps only the two best of many', () => {
    expect(assignHandSides([], null)).toEqual({ left: null, right: null });
    const sides = assignHandSides([hand(0.2, 0.5, 'Left', 0.3), hand(0.8, 0.5, 'Right', 0.9), hand(0.5, 0.5, 'Left', 0.8)], null);
    expect(sides.left).toBe(1);
    expect(sides.right).toBe(2);
  });
});

describe('conversion helpers', () => {
  it('landmarksToTuples copies x,y,z and defaults visibility', () => {
    const out = landmarksToTuples([{ x: 1, y: 2, z: 3, visibility: 0.4 }, { x: 4, y: 5, z: 6 }]);
    expect(out).toEqual([[1, 2, 3, 0.4], [4, 5, 6, 1]]);
  });

  it('makeHandFrame re-centres the world points on their mean, clamps the score and keeps a valid handedness', () => {
    const world = Array.from({ length: 21 }, (_, i) => ({ x: 0.1 + i * 0.01, y: 5, z: -2 + i * 0.001 }));
    const image = Array.from({ length: 21 }, (_, i) => ({ x: 0.5, y: 0.5 + i * 0.01, z: 0 }));
    const h = makeHandFrame(world, image, 1.7, 'Right');
    expect(h.local).toHaveLength(21);
    expect(h.image).toHaveLength(21);
    expect(h.score).toBe(1);
    expect(h.handedness).toBe('Right');
    const mean = [0, 1, 2].map((k) => h.local.reduce((s, p) => s + p[k], 0) / 21);
    for (const m of mean) expect(Math.abs(m)).toBeLessThan(1e-12);
    expect(h.local[1][0] - h.local[0][0]).toBeCloseTo(0.01, 12);
    expect(h.image[3]).toEqual([0.5, 0.53, 0]);
    expect(makeHandFrame(world, image, 0.5, 'bogus').handedness).toBeUndefined();
    expect(makeHandFrame(world, image, 0.5).handedness).toBeUndefined();
    expect(normalizeHandednessLabel(' left ')).toBe('Left');
    expect(normalizeHandednessLabel(3)).toBeUndefined();
  });

  it('blendshapesToRecord and matrixToArray', () => {
    expect(blendshapesToRecord([{ categoryName: 'jawOpen', score: 0.3 }, { categoryName: 'eyeBlinkLeft', score: 0.1 }])).toEqual({
      jawOpen: 0.3,
      eyeBlinkLeft: 0.1,
    });
    expect(blendshapesToRecord(undefined)).toEqual({});
    const data = Array.from({ length: 16 }, (_, i) => i);
    expect(matrixToArray({ rows: 4, columns: 4, data })).toEqual(data);
    expect(matrixToArray({ rows: 3, columns: 3, data: [1, 2, 3] })).toBeNull();
    expect(matrixToArray(undefined)).toBeNull();
  });
});

describe('face mirroring', () => {
  it('swaps Left/Right blendshape names', () => {
    expect(mirrorBlendshapeName('browDownLeft')).toBe('browDownRight');
    expect(mirrorBlendshapeName('mouthSmileRight')).toBe('mouthSmileLeft');
    expect(mirrorBlendshapeName('jawOpen')).toBe('jawOpen');
    expect(mirrorBlendshapeName('_neutral')).toBe('_neutral');
  });

  it('mirrorMatrixYZ equals S·M·S with S = diag(-1,1,1,1) and is an involution', () => {
    const m = Array.from({ length: 16 }, (_, i) => i + 1);
    const out = mirrorMatrixYZ(m);
    const S = [-1, 1, 1, 1];
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        expect(out[c * 4 + r]).toBe(S[r] * m[c * 4 + r] * S[c]);
      }
    }
    expect(mirrorMatrixYZ(out)).toEqual(m);
  });

  it('mirrors a yaw rotation and translation across the YZ plane', () => {
    const a = Math.PI / 6;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const out = mirrorMatrixYZ(yawMatrix(a, 0.5, 0.2, 0.3));
    expect(out[0]).toBeCloseTo(c, 12);
    expect(out[2]).toBeCloseTo(s, 12);
    expect(out[8]).toBeCloseTo(-s, 12);
    expect(out[10]).toBeCloseTo(c, 12);
    expect(out[12]).toBeCloseTo(-0.5, 12);
    expect(out[13]).toBeCloseTo(0.2, 12);
    expect(out[14]).toBeCloseTo(0.3, 12);
    expect(out[15]).toBe(1);
  });

  it('mirrorFaceFrame swaps names and mirrors the matrix, null matrix stays null', () => {
    const f = mirrorFaceFrame({ blendshapes: { eyeBlinkLeft: 1, eyeBlinkRight: 0, jawOpen: 0.5 }, matrix: null });
    expect(f).toEqual({ blendshapes: { eyeBlinkRight: 1, eyeBlinkLeft: 0, jawOpen: 0.5 }, matrix: null });
  });
});

describe('mirrorPoseFrame', () => {
  const full = (): PoseFrame =>
    makePoseFrame(42, {
      now: 7,
      hands: { left: makeHand(1, 'Right'), right: makeHand(2, 'Left') },
      face: { blendshapes: { eyeBlinkLeft: 0.8, eyeBlinkRight: 0.1, jawOpen: 0.5 }, matrix: yawMatrix(0.4, 0.5, 0.2, 0.3) },
    });

  it('mirrors world/image landmarks with the index swap, hands and face', () => {
    const src = full();
    const m = mirrorPoseFrame(src);
    const L = LM.LEFT_WRIST;
    const R = LM.RIGHT_WRIST;
    expect(POSE_MIRROR_INDEX[L]).toBe(R);
    expect(m.pose!.world[L][0]).toBeCloseTo(-src.pose!.world[R][0], 12);
    expect(m.pose!.world[L][1]).toBe(src.pose!.world[R][1]);
    expect(m.pose!.world[L][3]).toBe(src.pose!.world[R][3]);
    expect(m.pose!.image[L][0]).toBeCloseTo(1 - src.pose!.image[R][0], 12);
    expect(m.pose!.image[L][2]).toBe(src.pose!.image[R][2]);
    // Hands swapped, local x negated, image x mirrored, label flipped.
    expect(m.hands!.left!.local[0][0]).toBeCloseTo(-2, 12);
    expect(m.hands!.right!.local[0][0]).toBeCloseTo(-1, 12);
    expect(m.hands!.left!.image[0][0]).toBeCloseTo(1 - 0.5, 12);
    expect(m.hands!.left!.handedness).toBe('Right');
    expect(m.hands!.right!.handedness).toBe('Left');
    expect(m.face!.blendshapes.eyeBlinkLeft).toBe(0.1);
    expect(m.face!.matrix![12]).toBeCloseTo(-0.5, 12);
    // Scalars untouched; the input is not aliased.
    expect(m.t).toBe(42);
    expect(m.now).toBe(7);
    expect(m.src).toBe('test');
    expect(m.pose!.world).not.toBe(src.pose!.world);
    expect(src.pose!.world[L][0]).toBe(0.01 * L);
  });

  it('is an involution on world, image, hands and face', () => {
    const src = full();
    expectDeepClose(mirrorPoseFrame(mirrorPoseFrame(src)), src);
    // Also with null pose/hands/face and with absent optional fields.
    const bare = makePoseFrame(1);
    expectDeepClose(mirrorPoseFrame(mirrorPoseFrame(bare)), bare);
    const nulls: PoseFrame = { v: 2, t: 1, src: 'x', size: [1, 1], pose: null, hands: null, face: null };
    expectDeepClose(mirrorPoseFrame(mirrorPoseFrame(nulls)), nulls);
    const oneHand = makePoseFrame(2, { hands: { left: makeHand(3), right: null } });
    expectDeepClose(mirrorPoseFrame(mirrorPoseFrame(oneHand)), oneHand);
    expect(mirrorPoseFrame(oneHand).hands!.right!.local[0][0]).toBeCloseTo(-3, 12);
    expect(mirrorPoseFrame(oneHand).hands!.left).toBeNull();
    expect(mirrorHandFrame(mirrorHandFrame(makeHand(5, 'Left')))).toEqual(makeHand(5, 'Left'));
  });
});
