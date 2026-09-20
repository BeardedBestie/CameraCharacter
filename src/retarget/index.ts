/** Retargeting layer (docs/DESIGN.md §6 and §7). */
export * from './canonical';
export {
  BodyModel,
  RunningMedian,
  twoBoneJoint,
  blendUnit,
  makeBasis,
  copyBasis,
  MEASURED_ROLES,
  MIN_SEGMENT_SAMPLES,
  TWO_BONE_R_MIN,
  TWO_BONE_R_MAX,
  TWO_BONE_MAX_Z,
  NORMAL_DECAY_SEC,
  HIPS_LOST_EASE_SEC,
  HOLD_FADE_SEC,
} from './bodyModel';
export type { BasisSource, MeasuredBasis, BodyModelResult, BodyModelOptions } from './bodyModel';
export { fitFraming, fitHeightLine, stateForSpan, emptyFramingFit, FRAMING_BOUNDS } from './framing';
export {
  StandingBaseline,
  PoseCalibrationCapture,
  referenceBasisFor,
  applyRollOffset,
  canonicalUpMinRotated,
  effectiveTorsoBaseline,
  toBasisRecord,
  BASELINE_MIN_CONFIDENCE,
} from './calibration';
export {
  Retargeter,
  makeTakeHeader,
  SHOULDER_SWING_FRACTION,
  DEFAULT_LOWER_ARM_TWIST_FRACTION,
  Z_REF_WINDOW_SEC,
} from './solver';
export type { RetargeterOptions, SolveResult, SolveRoleResult } from './solver';
