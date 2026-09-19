/**
 * Pure conversion helpers between MediaPipe Tasks results and the PoseFrame v2
 * protocol, plus the hand side assignment and face mirroring rules. This file
 * deliberately does not import `@mediapipe/tasks-vision` (it needs a browser)
 * so the helpers are testable in Node; the structural types below match the
 * fields of `Landmark`, `NormalizedLandmark`, `Category` and `Matrix` from
 * `@mediapipe/tasks-vision/vision.d.ts`.
 */
import type { FaceFrame, HandFrame, LandmarkTuple, PointTuple } from '../core/types';
import { HL, LM } from './landmarks';

/** Structural subset of MediaPipe `Landmark` / `NormalizedLandmark`. */
export interface LandmarkLike {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** Structural subset of MediaPipe `Category`. */
export interface CategoryLike {
  categoryName: string;
  score: number;
}

/** Structural subset of MediaPipe `Matrix`. */
export interface MatrixLike {
  rows: number;
  columns: number;
  data: number[];
}

/** Pose landmark list → [x, y, z, visibility] tuples (raw MediaPipe conventions). */
export function landmarksToTuples(landmarks: readonly LandmarkLike[]): LandmarkTuple[] {
  const out: LandmarkTuple[] = new Array<LandmarkTuple>(landmarks.length);
  for (let i = 0; i < landmarks.length; i++) {
    const l = landmarks[i];
    const v = l.visibility;
    out[i] = [l.x, l.y, l.z, typeof v === 'number' && Number.isFinite(v) ? v : 1];
  }
  return out;
}

/** Hand landmark list → [x, y, z] tuples. */
export function pointsToTuples(landmarks: readonly LandmarkLike[]): PointTuple[] {
  const out: PointTuple[] = new Array<PointTuple>(landmarks.length);
  for (let i = 0; i < landmarks.length; i++) {
    const l = landmarks[i];
    out[i] = [l.x, l.y, l.z];
  }
  return out;
}

/** Blendshape categories → { name: score }. */
export function blendshapesToRecord(categories: readonly CategoryLike[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!categories) return out;
  for (const c of categories) {
    if (typeof c.categoryName === 'string' && Number.isFinite(c.score)) out[c.categoryName] = c.score;
  }
  return out;
}

/** Facial transformation matrix → flat 16-number array, or null when absent/malformed. */
export function matrixToArray(m: MatrixLike | undefined | null): number[] | null {
  if (!m || !Array.isArray(m.data) || m.data.length !== 16) return null;
  for (const n of m.data) if (!Number.isFinite(n)) return null;
  return m.data.slice();
}

// ---------------------------------------------------------------------------
// Hand side assignment
// ---------------------------------------------------------------------------

export type HandSide = 'left' | 'right';

/** One detected hand as needed for side assignment. */
export interface DetectedHandLike {
  /** 21 normalized image landmarks (index 0 = wrist). */
  image: readonly PointTuple[];
  /** MediaPipe handedness label: 'Left' or 'Right' (assumes a mirrored/selfie image). */
  handedness: string;
  /** Handedness score, 0..1. */
  score: number;
}

/**
 * MediaPipe's handedness label assumes a horizontally mirrored (selfie) image.
 * The app feeds the un-flipped camera frame, so the label names the *opposite*
 * anatomical side of the subject.
 */
export function swapHandednessLabel(label: string): HandSide {
  return label.trim().toLowerCase() === 'left' ? 'right' : 'left';
}

/** Minimum pose wrist visibility for the wrist to be used as an anchor. */
export const HAND_ANCHOR_MIN_VISIBILITY = 0.2;

/**
 * Assign each detected hand to the subject's anatomical side.
 *
 * Primary rule: nearest pose wrist in normalized image space (hand landmark 0
 * vs pose landmarks 15 = left wrist and 16 = right wrist). With two hands the
 * pairing with the lower total distance wins, so both hands never land on the
 * same side. Wrists with visibility below {@link HAND_ANCHOR_MIN_VISIBILITY}
 * are not used as anchors.
 *
 * Fallback (no pose, or no usable wrists): the swapped handedness label; when
 * two hands claim the same side the higher score keeps it.
 *
 * Returns the index into `hands` for each side, or null.
 */
export function assignHandSides(
  hands: readonly DetectedHandLike[],
  poseImage: readonly LandmarkTuple[] | null,
): { left: number | null; right: number | null } {
  const result: { left: number | null; right: number | null } = { left: null, right: null };
  if (hands.length === 0) return result;

  // Keep at most the two highest-scoring hands.
  const order = hands.map((h, i) => i).sort((a, b) => hands[b].score - hands[a].score).slice(0, 2);

  const lw = poseImage ? poseImage[LM.LEFT_WRIST] : undefined;
  const rw = poseImage ? poseImage[LM.RIGHT_WRIST] : undefined;
  const leftOk = !!lw && lw[3] >= HAND_ANCHOR_MIN_VISIBILITY;
  const rightOk = !!rw && rw[3] >= HAND_ANCHOR_MIN_VISIBILITY;

  const dist = (h: DetectedHandLike, w: LandmarkTuple): number => {
    const p = h.image[HL.WRIST];
    return Math.hypot(p[0] - w[0], p[1] - w[1]);
  };

  if (leftOk || rightOk) {
    if (order.length === 1) {
      const h = hands[order[0]];
      const dl = leftOk && lw ? dist(h, lw) : Infinity;
      const dr = rightOk && rw ? dist(h, rw) : Infinity;
      if (dl < dr) result.left = order[0];
      else if (dr < dl) result.right = order[0];
      else result[swapHandednessLabel(h.handedness)] = order[0];
      return result;
    }
    const a = hands[order[0]];
    const b = hands[order[1]];
    if (leftOk && rightOk && lw && rw) {
      // Optimal 2x2 assignment.
      const costAB = dist(a, lw) + dist(b, rw); // a→left, b→right
      const costBA = dist(b, lw) + dist(a, rw); // b→left, a→right
      if (costAB <= costBA) {
        result.left = order[0];
        result.right = order[1];
      } else {
        result.left = order[1];
        result.right = order[0];
      }
      return result;
    }
    // Only one usable wrist: the nearer hand takes that side, the other the opposite.
    const anchor = leftOk && lw ? lw : (rw as LandmarkTuple);
    const anchorSide: HandSide = leftOk ? 'left' : 'right';
    const otherSide: HandSide = anchorSide === 'left' ? 'right' : 'left';
    if (dist(a, anchor) <= dist(b, anchor)) {
      result[anchorSide] = order[0];
      result[otherSide] = order[1];
    } else {
      result[anchorSide] = order[1];
      result[otherSide] = order[0];
    }
    return result;
  }

  // Fallback: swapped handedness labels, ties resolved by score.
  for (const i of order) {
    const side = swapHandednessLabel(hands[i].handedness);
    if (result[side] === null) {
      result[side] = i;
    } else {
      const other: HandSide = side === 'left' ? 'right' : 'left';
      if (result[other] === null) result[other] = i;
    }
  }
  return result;
}

/** Build a HandFrame from raw landmark lists. */
export function makeHandFrame(
  world: readonly LandmarkLike[],
  image: readonly LandmarkLike[],
  score: number,
): HandFrame {
  return {
    world: pointsToTuples(world),
    image: pointsToTuples(image),
    score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 1,
  };
}

// ---------------------------------------------------------------------------
// Face mirroring
// ---------------------------------------------------------------------------

/** Swap the Left/Right suffix of an ARKit blendshape name (browDownLeft ↔ browDownRight). */
export function mirrorBlendshapeName(name: string): string {
  if (name.endsWith('Left')) return name.slice(0, -4) + 'Right';
  if (name.endsWith('Right')) return name.slice(0, -5) + 'Left';
  return name;
}

/**
 * Mirror a 4x4 matrix across the YZ plane: M' = S·M·S with S = diag(-1,1,1,1).
 * Entry (r,c) is negated when exactly one of r, c is 0, which is the same
 * pattern in row- and column-major storage.
 */
export function mirrorMatrixYZ(m: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      const idx = c * 4 + r;
      const flip = (r === 0) !== (c === 0);
      out[idx] = flip ? -m[idx] : m[idx];
    }
  }
  // Normalize negative zero so serialized output stays clean.
  for (let i = 0; i < 16; i++) if (out[i] === 0) out[i] = 0;
  return out;
}

/** Mirror a face frame: swap Left/Right blendshapes and mirror the transform. */
export function mirrorFaceFrame(face: FaceFrame): FaceFrame {
  const blendshapes: Record<string, number> = {};
  for (const [name, score] of Object.entries(face.blendshapes)) {
    blendshapes[mirrorBlendshapeName(name)] = score;
  }
  return {
    blendshapes,
    matrix: face.matrix && face.matrix.length === 16 ? mirrorMatrixYZ(face.matrix) : null,
  };
}
