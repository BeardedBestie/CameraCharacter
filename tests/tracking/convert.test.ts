import { describe, expect, it } from 'vitest';
import type { LandmarkTuple, PointTuple } from '../../src/core/types';
import {
  assignHandSides,
  blendshapesToRecord,
  landmarksToTuples,
  matrixToArray,
  mirrorBlendshapeName,
  mirrorFaceFrame,
  mirrorMatrixYZ,
  swapHandednessLabel,
} from '../../src/tracking/convert';
import { LM } from '../../src/tracking/landmarks';

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
    // Both hands closer to the left wrist, but one must take the right.
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
    // Conflict: both labelled Left → the higher score keeps "right", the other becomes "left".
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
    // Column-major M with distinct entries.
    const m = Array.from({ length: 16 }, (_, i) => i + 1);
    const out = mirrorMatrixYZ(m);
    // Compute S·M·S explicitly (column-major: M[r][c] = m[c*4 + r]).
    const S = [-1, 1, 1, 1];
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        expect(out[c * 4 + r]).toBe(S[r] * m[c * 4 + r] * S[c]);
      }
    }
    expect(mirrorMatrixYZ(out)).toEqual(m);
  });

  it('mirrors a yaw rotation and translation across the YZ plane', () => {
    // Rotation about Y by +30° (column-major), translation (0.5, 0.2, 0.3).
    const a = Math.PI / 6;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const m = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0.5, 0.2, 0.3, 1];
    const out = mirrorMatrixYZ(m);
    // Yaw flips sign: rotation about Y by -30°.
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
