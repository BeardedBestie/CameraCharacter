/**
 * Diagnostics contracts (docs/DESIGN.md §7, §12).
 *
 * The diagnostics modules never import the solver: they consume a
 * `SolveResultLike`, an interface that mirrors exactly what
 * `src/retarget/solver.ts` produces as `SolveResult`, so the two modules can
 * be developed independently and the diagnostics can be unit tested on
 * hand-built inputs.
 */
import type { Quaternion, Vector3 } from 'three';
import type { BoneRefMode, FramingState, HumanoidBone, RefBasisRecord } from '../core/types';

export interface SolveRoleResultLike {
  /** Solved world quaternion of the bone (final scene frame). */
  worldQuat: Quaternion;
  /** Solved local quaternion (what was written to `bone.quaternion`). */
  localQuat: Quaternion;
  /** Measured unit direction `d` (or the chord for chord-driven bones), or null when nothing was measured. */
  measuredDir: Vector3 | null;
  /** Actual world direction of the bone after solving, or null when unknown. */
  solvedDir: Vector3 | null;
  /** Angle (degrees) between `measuredDir` and `solvedDir`, or null when either is missing. */
  errorDeg: number | null;
  /** Landmark confidence `c`, 0..1. */
  confidence: number;
  /** Up-reference confidence `c_u`, 0..1. */
  cU: number;
  mode: BoneRefMode;
  /** Where the measured basis came from ('measured', 'fallback', 'chord', 'twoBone', 'hold', ...). */
  source: string;
}

export type ChainName = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export const CHAIN_NAMES: readonly ChainName[] = ['leftArm', 'rightArm', 'leftLeg', 'rightLeg'];

export interface SolveResultLike {
  /** Roles that were solved this frame, in solve order. */
  roles: HumanoidBone[];
  perRole: Partial<Record<HumanoidBone, SolveRoleResultLike>>;
  /** Per-chain angular error (hip→ankle, shoulder→wrist), degrees, or null when unavailable. */
  chainErrorDeg: Record<ChainName, number | null>;
  hipsWorldPos: Vector3;
  /** Estimated camera distance of the subject (meters), or null. */
  depthZ: number | null;
  framing: FramingState;
}

/**
 * Measured basis per role as produced by the body model (docs/DESIGN.md §6.1).
 * Optional input to the snapshot bundle: the solver result alone carries `d`,
 * `c` and `c_u` but not the up reference `u`.
 */
export interface MeasuredBasisLike {
  d: Vector3;
  u: Vector3;
  c: number;
  cU: number;
  source: string;
}

export type MeasuredBasesLike = Partial<Record<HumanoidBone, MeasuredBasisLike>>;

/** Reference bases per role (`d_ref`, `u_ref`) as used by the solver this frame. */
export type ReferenceBasesLike = Partial<Record<HumanoidBone, RefBasisRecord>>;

/** Per-bone error is flagged when it exceeds this many degrees ... */
export const FLAG_ERROR_DEG = 5;
/** ... on a bone whose landmark confidence exceeds this. */
export const FLAG_CONFIDENCE = 0.5;

export interface FlagThresholds {
  errorDeg: number;
  confidence: number;
}

export const DEFAULT_FLAG_THRESHOLDS: FlagThresholds = { errorDeg: FLAG_ERROR_DEG, confidence: FLAG_CONFIDENCE };
