/**
 * FilteredPose: the contract between the tracking layer (PoseFilter) and the
 * retargeting layer (BodyModel, framing, calibration). three.js math objects
 * are used because every consumer needs vectors; no DOM.
 *
 * Coordinates (docs/DESIGN.md §3): `world` is in three.js coords (x, -y, -z of
 * the MediaPipe world landmarks; meters, hip-centred); `image` keeps normalized
 * image coordinates (x right, y down, both in [0,1] when inside the frame) with
 * MediaPipe's z. Mirror mode has already been applied when `mirror` is true.
 */
import type { Quaternion, Vector3 } from 'three';
import { POSE_LANDMARK_COUNT } from '../tracking/landmarks';

export interface HandPose {
  /** 21 points in three.js coords, meters relative to the hand's own centre. */
  local: Vector3[];
  /** 21 points in normalized image coords. */
  image: Vector3[];
  score: number;
}

export interface FacePose {
  blendshapes: Record<string, number>;
  /** Head rotation in three.js world coords (already mirrored when applicable), or null. */
  rotation: Quaternion | null;
}

export interface FilteredPose {
  /** Media time in seconds. */
  t: number;
  /** performance.now() at capture (ms), or NaN when unknown. */
  now: number;
  /** A subject was detected in this frame. */
  present: boolean;
  /** Seconds since the subject was last present (0 while present). */
  absentFor: number;
  /** Confidence ramp after re-acquisition, 0..1. */
  reacquireRamp: number;
  size: [number, number];
  mirror: boolean;
  /** 33 landmarks, three.js coords, filtered. */
  world: Vector3[];
  /** 33 landmarks, normalized image coords, filtered. */
  image: Vector3[];
  /** 33 smoothed visibilities (EMA). */
  visibility: number[];
  /** 33 flags: the normalized landmark lies inside the frame (with a 3 % margin). */
  inFrame: boolean[];
  /** 33 flags: the hysteresis gate (with dwell) is open. */
  gated: boolean[];
  /** 33 soft confidences 0..1: gate state, smoothstep between off/on thresholds, and the re-acquire ramp. */
  confidence: number[];
  hands: { left: HandPose | null; right: HandPose | null };
  face: FacePose | null;
}

export const FILTERED_LANDMARK_COUNT = POSE_LANDMARK_COUNT;

/** Confidence of a role = min confidence over its landmarks. */
export function minConfidence(pose: FilteredPose, indices: readonly number[]): number {
  let c = 1;
  for (const i of indices) {
    const v = pose.confidence[i] ?? 0;
    if (v < c) c = v;
  }
  return c;
}

/** Whether every listed landmark is gated on. */
export function allGated(pose: FilteredPose, indices: readonly number[]): boolean {
  for (const i of indices) if (!pose.gated[i]) return false;
  return true;
}
