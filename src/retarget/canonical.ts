/**
 * Canonical humanoid conventions used by rig analysis and the retargeting solver.
 *
 * Frame: three.js world coordinates, Y up, the character faces +Z, the
 * character's LEFT side is at +X (glTF / three.js humanoid convention).
 *
 * For every bone role we define, in a T-pose:
 *   dir  – the direction from the bone's head to its tail (toward its child)
 *   up   – the "up reference": the direction the bone's secondary axis points.
 *          The measured up reference is built the same way by the body model
 *          (see docs/DESIGN.md §6.1), so the pairing (dir, up) fully fixes the
 *          bone's orientation, including twist:
 *            hips/spine/neck/head/shoulders : forward (+Z)
 *            upperArm / upperLeg            : the joint's bend direction, i.e. the
 *                                             component of the child's direction
 *                                             perpendicular to this bone (elbows
 *                                             flex forward, knees flex backward)
 *            lowerArm / hand                : the dorsal (back-of-hand) direction
 *            lowerLeg                       : the foot's forward direction
 *            foot / toes                    : up
 *   coneDeg – maximum angle between a rig's bind-pose direction and `dir` for the
 *          bind pose to count as anatomical (see docs/DESIGN.md §4).
 *   restDir / restUp – the same basis for a relaxed human standing at rest (arms
 *          hanging), used by the `relative` reference mode.
 */
import { Vector3 } from 'three';
import type { HumanoidBone, Vec3Tuple } from '../core/types';
import { HUMANOID_BONES, boneSide } from '../core/types';

export interface CanonicalBone {
  dir: Vec3Tuple;
  up: Vec3Tuple;
  coneDeg: number;
  restDir: Vec3Tuple;
  restUp: Vec3Tuple;
}

const n = (x: number, y: number, z: number): Vec3Tuple => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

const UP: Vec3Tuple = [0, 1, 0];
const DOWN: Vec3Tuple = [0, -1, 0];
const FWD: Vec3Tuple = [0, 0, 1];
const BACK: Vec3Tuple = [0, 0, -1];

function sideX(bone: HumanoidBone): number {
  return boneSide(bone) === 'right' ? -1 : 1;
}

const FOOT_DIR = n(0, -0.5, 0.85);

function torso(): CanonicalBone {
  return { dir: UP, up: FWD, coneDeg: 60, restDir: UP, restUp: FWD };
}

function build(bone: HumanoidBone): CanonicalBone {
  const s = sideX(bone);
  const along: Vec3Tuple = [s, 0, 0];
  switch (bone) {
    case 'hips':
    case 'spine':
    case 'chest':
    case 'upperChest':
      return torso();
    case 'neck':
    case 'head':
      return { dir: UP, up: FWD, coneDeg: 70, restDir: UP, restUp: FWD };
    case 'jaw':
      return { dir: n(0, -0.4, 1), up: UP, coneDeg: 90, restDir: n(0, -0.4, 1), restUp: UP };
    case 'leftEye':
    case 'rightEye':
      return { dir: FWD, up: UP, coneDeg: 90, restDir: FWD, restUp: UP };
    case 'leftShoulder':
    case 'rightShoulder':
      return { dir: along, up: FWD, coneDeg: 75, restDir: n(s, -0.1, 0), restUp: FWD };
    case 'leftUpperArm':
    case 'rightUpperArm':
      // Elbow flexes forward in a T-pose; a hanging arm still flexes forward.
      return { dir: along, up: FWD, coneDeg: 110, restDir: n(0.2 * s, -0.98, 0), restUp: FWD };
    case 'leftLowerArm':
    case 'rightLowerArm':
      // Dorsal side faces up with palms down in a T-pose; faces outward when hanging.
      return { dir: along, up: UP, coneDeg: 120, restDir: n(0.15 * s, -0.98, 0.1), restUp: [s, 0, 0] };
    case 'leftHand':
    case 'rightHand':
      return { dir: along, up: UP, coneDeg: 120, restDir: n(0.1 * s, -0.99, 0.1), restUp: [s, 0, 0] };
    case 'leftUpperLeg':
    case 'rightUpperLeg':
      // Knee flexes backward.
      return { dir: DOWN, up: BACK, coneDeg: 60, restDir: DOWN, restUp: BACK };
    case 'leftLowerLeg':
    case 'rightLowerLeg':
      // Foot points forward relative to the shin.
      return { dir: DOWN, up: FWD, coneDeg: 70, restDir: DOWN, restUp: FWD };
    case 'leftFoot':
    case 'rightFoot':
      // Ankle -> ball of the foot: forward and down.
      return { dir: FOOT_DIR, up: UP, coneDeg: 80, restDir: FOOT_DIR, restUp: UP };
    case 'leftToes':
    case 'rightToes':
      return { dir: FWD, up: UP, coneDeg: 80, restDir: FWD, restUp: UP };
    default: {
      // Fingers: along the hand, dorsal up. Thumb metacarpal points forward-ish.
      if (bone.includes('Thumb')) {
        const d = n(0.7 * s, -0.2, 0.7);
        return { dir: d, up: n(0.5 * s, 1, 0), coneDeg: 90, restDir: d, restUp: n(0.5 * s, 1, 0) };
      }
      return { dir: along, up: UP, coneDeg: 90, restDir: along, restUp: UP };
    }
  }
}

export const CANONICAL: Readonly<Record<HumanoidBone, CanonicalBone>> = (() => {
  const out = {} as Record<HumanoidBone, CanonicalBone>;
  for (const b of HUMANOID_BONES) out[b] = build(b);
  return out;
})();

export function canonicalDir(bone: HumanoidBone, out = new Vector3()): Vector3 {
  return out.fromArray(CANONICAL[bone].dir);
}

export function canonicalUp(bone: HumanoidBone, out = new Vector3()): Vector3 {
  return out.fromArray(CANONICAL[bone].up);
}

export function canonicalRestDir(bone: HumanoidBone, out = new Vector3()): Vector3 {
  return out.fromArray(CANONICAL[bone].restDir);
}

export function canonicalRestUp(bone: HumanoidBone, out = new Vector3()): Vector3 {
  return out.fromArray(CANONICAL[bone].restUp);
}

/** Angle in degrees between a rest direction and the canonical direction. */
export function canonicalDeviationDeg(bone: HumanoidBone, restDir: Vector3): number {
  const c = canonicalDir(bone, _tmp);
  const d = Math.max(-1, Math.min(1, c.dot(restDir) / (restDir.length() || 1)));
  return (Math.acos(d) * 180) / Math.PI;
}

export function isAnatomical(bone: HumanoidBone, restDir: Vector3): boolean {
  return canonicalDeviationDeg(bone, restDir) <= CANONICAL[bone].coneDeg;
}

const _tmp = new Vector3();

/** Ordered spine chain roles from the hips upward (excluding hips). */
export const SPINE_CHAIN: readonly HumanoidBone[] = ['spine', 'chest', 'upperChest'];
