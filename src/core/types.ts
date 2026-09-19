/**
 * Core contracts shared by every module. Pure types and constants only; no DOM,
 * no three.js runtime objects, so this file is safe to import from tests,
 * scripts and the browser alike.
 */

// ---------------------------------------------------------------------------
// Humanoid bone roles (VRM humanoid naming, a superset of Mixamo's skeleton)
// ---------------------------------------------------------------------------

export const HUMANOID_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'jaw',
  'leftEye',
  'rightEye',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToes',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToes',
  'leftThumbMetacarpal',
  'leftThumbProximal',
  'leftThumbDistal',
  'leftIndexProximal',
  'leftIndexIntermediate',
  'leftIndexDistal',
  'leftMiddleProximal',
  'leftMiddleIntermediate',
  'leftMiddleDistal',
  'leftRingProximal',
  'leftRingIntermediate',
  'leftRingDistal',
  'leftLittleProximal',
  'leftLittleIntermediate',
  'leftLittleDistal',
  'rightThumbMetacarpal',
  'rightThumbProximal',
  'rightThumbDistal',
  'rightIndexProximal',
  'rightIndexIntermediate',
  'rightIndexDistal',
  'rightMiddleProximal',
  'rightMiddleIntermediate',
  'rightMiddleDistal',
  'rightRingProximal',
  'rightRingIntermediate',
  'rightRingDistal',
  'rightLittleProximal',
  'rightLittleIntermediate',
  'rightLittleDistal',
] as const;

export type HumanoidBone = (typeof HUMANOID_BONES)[number];

/** Canonical parent of each role. Chains skip optional roles when they are unmapped. */
export const HUMANOID_PARENT: Record<HumanoidBone, HumanoidBone | null> = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  upperChest: 'chest',
  neck: 'upperChest',
  head: 'neck',
  jaw: 'head',
  leftEye: 'head',
  rightEye: 'head',
  leftShoulder: 'upperChest',
  leftUpperArm: 'leftShoulder',
  leftLowerArm: 'leftUpperArm',
  leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest',
  rightUpperArm: 'rightShoulder',
  rightLowerArm: 'rightUpperArm',
  rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg',
  leftFoot: 'leftLowerLeg',
  leftToes: 'leftFoot',
  rightUpperLeg: 'hips',
  rightLowerLeg: 'rightUpperLeg',
  rightFoot: 'rightLowerLeg',
  rightToes: 'rightFoot',
  leftThumbMetacarpal: 'leftHand',
  leftThumbProximal: 'leftThumbMetacarpal',
  leftThumbDistal: 'leftThumbProximal',
  leftIndexProximal: 'leftHand',
  leftIndexIntermediate: 'leftIndexProximal',
  leftIndexDistal: 'leftIndexIntermediate',
  leftMiddleProximal: 'leftHand',
  leftMiddleIntermediate: 'leftMiddleProximal',
  leftMiddleDistal: 'leftMiddleIntermediate',
  leftRingProximal: 'leftHand',
  leftRingIntermediate: 'leftRingProximal',
  leftRingDistal: 'leftRingIntermediate',
  leftLittleProximal: 'leftHand',
  leftLittleIntermediate: 'leftLittleProximal',
  leftLittleDistal: 'leftLittleIntermediate',
  rightThumbMetacarpal: 'rightHand',
  rightThumbProximal: 'rightThumbMetacarpal',
  rightThumbDistal: 'rightThumbProximal',
  rightIndexProximal: 'rightHand',
  rightIndexIntermediate: 'rightIndexProximal',
  rightIndexDistal: 'rightIndexIntermediate',
  rightMiddleProximal: 'rightHand',
  rightMiddleIntermediate: 'rightMiddleProximal',
  rightMiddleDistal: 'rightMiddleIntermediate',
  rightRingProximal: 'rightHand',
  rightRingIntermediate: 'rightRingProximal',
  rightRingDistal: 'rightRingIntermediate',
  rightLittleProximal: 'rightHand',
  rightLittleIntermediate: 'rightLittleProximal',
  rightLittleDistal: 'rightLittleIntermediate',
};

/** Roles that must be mapped for the body to be driven at all. */
export const REQUIRED_BONES: readonly HumanoidBone[] = [
  'hips',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'rightUpperArm',
  'rightLowerArm',
  'leftUpperLeg',
  'leftLowerLeg',
  'rightUpperLeg',
  'rightLowerLeg',
];

/** Roles that make up the "body" (everything except fingers, eyes and jaw). */
export const BODY_BONES: readonly HumanoidBone[] = HUMANOID_BONES.filter(
  (b) => !isFingerBone(b) && b !== 'leftEye' && b !== 'rightEye' && b !== 'jaw',
);

export function isFingerBone(bone: HumanoidBone): boolean {
  return /^(left|right)(Thumb|Index|Middle|Ring|Little)/.test(bone);
}

export type Side = 'left' | 'right' | 'center';

export function boneSide(bone: HumanoidBone): Side {
  if (bone.startsWith('left')) return 'left';
  if (bone.startsWith('right')) return 'right';
  return 'center';
}

/** Mirror a role across the body (leftUpperArm <-> rightUpperArm). */
export function mirrorBone(bone: HumanoidBone): HumanoidBone {
  if (bone.startsWith('left')) return ('right' + bone.slice(4)) as HumanoidBone;
  if (bone.startsWith('right')) return ('left' + bone.slice(5)) as HumanoidBone;
  return bone;
}

/** Solve order: parents before children. */
export const HUMANOID_SOLVE_ORDER: readonly HumanoidBone[] = (() => {
  const order: HumanoidBone[] = [];
  const visit = (b: HumanoidBone) => {
    if (order.includes(b)) return;
    const p = HUMANOID_PARENT[b];
    if (p) visit(p);
    order.push(b);
  };
  for (const b of HUMANOID_BONES) visit(b);
  return order;
})();

// ---------------------------------------------------------------------------
// Pose frame protocol (v2). Raw MediaPipe conventions; see docs/DESIGN.md §10.
// ---------------------------------------------------------------------------

/** [x, y, z, visibility] in raw MediaPipe conventions. */
export type LandmarkTuple = [number, number, number, number];

/** [x, y, z] for hand landmarks (MediaPipe hands have no visibility). */
export type PointTuple = [number, number, number];

export interface HandFrame {
  /** 21 hand landmarks in meters relative to the hand's geometric center. */
  world: PointTuple[];
  /** 21 hand landmarks normalized to the image. */
  image: PointTuple[];
  /** Detection score for the hand, 0..1. */
  score: number;
}

export interface FaceFrame {
  /** ARKit-style blendshape coefficients by name, 0..1. */
  blendshapes: Record<string, number>;
  /** 4x4 column-major facial transformation matrix (MediaPipe FaceLandmarker), or null. */
  matrix: number[] | null;
}

export interface PoseFrame {
  v: 2;
  /** Timestamp in milliseconds, monotonic per source. */
  t: number;
  /** Source identifier, e.g. "mediapipe-web", "python-opencv", "recording". */
  src: string;
  /** Capture size in pixels [width, height]. */
  size: [number, number];
  /** 33 pose landmarks, or null when no subject was detected. */
  pose: {
    /** Metric landmarks (meters), origin at hip midpoint. */
    world: LandmarkTuple[];
    /** Normalized image landmarks in [0,1]; z roughly in x units. */
    image: LandmarkTuple[];
  } | null;
  /** Hand landmarks keyed by the subject's anatomical side, when hand tracking is enabled. */
  hands?: { left: HandFrame | null; right: HandFrame | null } | null;
  /** Face blendshapes and head transform, when face tracking is enabled. */
  face?: FaceFrame | null;
}

export interface MocapRecording {
  format: 'cameracharacter-mocap';
  version: 2;
  meta: {
    createdAt: string;
    source: string;
    size: [number, number];
    /** Whether the app was in mirror mode when recorded (informational; frames are raw). */
    mirror: boolean;
    /** Free-form notes / device info. */
    notes?: string;
    /** Approximate camera vertical field of view in degrees if known. */
    fovDeg?: number;
    /** Snapshot of the pose calibration active during the recording, if any. */
    calibration?: PoseCalibration | null;
  };
  frames: PoseFrame[];
}

// ---------------------------------------------------------------------------
// Rig profile
// ---------------------------------------------------------------------------

export type HumanoidMap = Partial<Record<HumanoidBone, string>>;

export type BoneRefMode = 'auto' | 'relative' | 'calibrated' | 'off';

export interface BoneSettings {
  mode: BoneRefMode;
  /** Twist trim about the bone axis, degrees. */
  rollOffsetDeg: number;
  /** Optional per-bone smoothing override (0..1 fraction of the global rate). */
  smoothing?: number;
}

/** Numbers stored as plain arrays so profiles serialize to JSON. */
export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface RefBasisRecord {
  /** Unit direction of the bone in the reference pose, three.js world coords. */
  d: Vec3Tuple;
  /** Unit up reference (perpendicular-ish to d) in the reference pose. */
  u: Vec3Tuple;
}

export interface PoseCalibration {
  version: 2;
  createdAt: string;
  /** Per-role reference bases measured while the user matched the model's rest pose. */
  bases: Partial<Record<HumanoidBone, RefBasisRecord>>;
  /** Shoulder width in meters from world landmarks. */
  shoulderWidth: number;
  /** Torso length (mid-shoulder to mid-hip) in meters. */
  torsoLength: number;
  /** Hip midpoint image y (0..1) while standing at the calibration distance. */
  standingHipsImageY: number;
  /** Apparent torso length in normalized image units at the calibration distance. */
  torsoImageLength: number;
  /** Number of frames averaged. */
  frames: number;
}

export interface RigBoneAnalysis {
  /** Bone (Object3D) name in the loaded model. */
  name: string;
  /** Rest (bind pose) world direction of the bone, unit, three.js coords, after root correction. */
  restDir: Vec3Tuple;
  /** Rest world quaternion. */
  restQuat: QuatTuple;
  /** Rest world position. */
  restPos: Vec3Tuple;
  /** Bone length toward the humanoid child or the tail estimate, model units after scaling. */
  length: number;
  /** Angle (degrees) between the rest direction and the canonical direction. */
  canonicalDeviationDeg: number;
  /** True when the rest direction is inside the plausibility cone. */
  anatomical: boolean;
}

export interface RigProfile {
  version: 2;
  /** Hash of the bone hierarchy (sorted "child<parent" pairs). */
  fingerprint: string;
  displayName: string;
  /** Detected rig family, for presets and diagnostics. */
  family: 'mixamo' | 'meshy' | 'vrm' | 'rigify' | 'ue' | 'cc' | 'daz' | 'blender' | 'unknown';
  map: HumanoidMap;
  confidence: Partial<Record<HumanoidBone, number>>;
  warnings: string[];
  /** Applied to the model root so the rig is Y-up and faces +Z. */
  rootCorrection: QuatTuple;
  /** Applied to the model root so the height matches the target. */
  scale: number;
  /** Original model height (model units, before scale). */
  sourceHeight: number;
  /** Per-bone rest analysis, keyed by role. */
  analysis: Partial<Record<HumanoidBone, RigBoneAnalysis>>;
  /** Per-bone user settings. */
  bones: Partial<Record<HumanoidBone, BoneSettings>>;
  calibration?: PoseCalibration | null;
}

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

export type CameraMode = 'mirror' | 'follow' | 'orbit';
export type HipsMode = 'locked' | 'horizontal' | 'full';
export type PoseModelVariant = 'lite' | 'full' | 'heavy';

export interface SmoothingSettings {
  /** One Euro min cutoff (Hz). Lower = smoother when still. */
  oneEuroMinCutoff: number;
  /** One Euro beta. Higher = less lag on fast motion. */
  oneEuroBeta: number;
  /** Bone rotation response rate (1/s). */
  boneRate: number;
  /** Extra response added at high angular velocity (1/s per rad/s). */
  boneRateVelocityGain: number;
  /** Visibility gate thresholds. */
  visibilityOn: number;
  visibilityOff: number;
  /** Time a limb holds its last pose after tracking loss before relaxing (ms). */
  holdMs: number;
  /** Rate (1/s) at which an untracked bone relaxes toward rest. */
  relaxRate: number;
}

export interface TrackingSettings {
  poseModel: PoseModelVariant;
  hands: boolean;
  face: boolean;
  /** Run hands/face every N pose frames. */
  auxCadence: number;
  delegate: 'GPU' | 'CPU';
}

export interface StageSettings {
  mirror: boolean;
  cameraMode: CameraMode;
  hipsMode: HipsMode;
  targetHeight: number;
  showFloor: boolean;
  showGrid: boolean;
  showLandmarkSkeleton: boolean;
  background: string;
}

export interface AppSettings {
  tracking: TrackingSettings;
  smoothing: SmoothingSettings;
  stage: StageSettings;
  diagnostics: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  tracking: { poseModel: 'full', hands: false, face: false, auxCadence: 2, delegate: 'GPU' },
  smoothing: {
    oneEuroMinCutoff: 1.0,
    oneEuroBeta: 0.02,
    boneRate: 14,
    boneRateVelocityGain: 2,
    visibilityOn: 0.65,
    visibilityOff: 0.45,
    holdMs: 250,
    relaxRate: 2,
  },
  stage: {
    mirror: true,
    cameraMode: 'mirror',
    hipsMode: 'horizontal',
    targetHeight: 1.7,
    showFloor: true,
    showGrid: true,
    showLandmarkSkeleton: false,
    background: '#15171c',
  },
  diagnostics: false,
};
