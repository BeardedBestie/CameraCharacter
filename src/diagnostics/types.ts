/**
 * Diagnostics contracts (docs/DESIGN.md §7, §12).
 *
 * The diagnostics consume the solver's real result types
 * (`SolveResult` / `SolveRoleResult` from `src/retarget/solver.ts`) and the
 * body model's `MeasuredBasis`; everything shared with other modules
 * (RigAnalysis, RigProfile, FramingFit, HumanoidBone, ...) comes from
 * `src/core/types.ts`. This file only adds the diagnostics' own output shapes.
 */
import type { BoneRefMode, HumanoidBone } from '../core/types';

export type ChainName = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export const CHAIN_NAMES: readonly ChainName[] = ['leftArm', 'rightArm', 'leftLeg', 'rightLeg'];

/** Per-bone error is flagged when it exceeds this many degrees ... */
export const FLAG_ERROR_DEG = 5;
/** ... on a bone whose landmark confidence exceeds this ... */
export const FLAG_CONFIDENCE = 0.5;
/** ... and whose reference comes from a measured/bind geometry (`auto` or `calibrated`; DESIGN §7 self-check). */
export const FLAGGABLE_MODES: readonly BoneRefMode[] = ['auto', 'calibrated'];

export interface FlagThresholds {
  errorDeg: number;
  confidence: number;
}

export const DEFAULT_FLAG_THRESHOLDS: FlagThresholds = { errorDeg: FLAG_ERROR_DEG, confidence: FLAG_CONFIDENCE };

export interface BoneErrorEntry {
  role: HumanoidBone;
  /** Mapped bone name, or null when the analysis is unknown or the role is unmapped. */
  bone: string | null;
  /** Angle (degrees) between the measured and the solved bone direction, or null when nothing was measured. */
  errorDeg: number | null;
  /** Landmark confidence `c`, 0..1. */
  confidence: number;
  /** Up-reference confidence `c_u`, 0..1. */
  cU: number;
  mode: BoneRefMode;
  /** Where the measured basis came from ('measured', 'fallback', 'chord', 'twoBone', 'hold', ...). */
  source: string;
  /** errorDeg > FLAG_ERROR_DEG on a confident bone in `auto` or `calibrated` mode. */
  flagged: boolean;
}

export interface ChainErrorEntry {
  name: ChainName;
  errorDeg: number | null;
}

export interface BoneErrorSummary {
  /** One entry per solved role, in solve order. */
  perBone: BoneErrorEntry[];
  chains: ChainErrorEntry[];
  /** Confident bone with the largest error, or null when no confident bone reported an error. */
  worst: HumanoidBone | null;
  maxErrorDeg: number | null;
  /** Mean error over confident bones (confidence > FLAG_CONFIDENCE) that reported an error. */
  meanErrorDeg: number | null;
  /** True when no bone is flagged. */
  ok: boolean;
}

export interface RoleErrorStats {
  mean: number;
  max: number;
  /** Number of frames in the window that carried an error for this role. */
  n: number;
}
