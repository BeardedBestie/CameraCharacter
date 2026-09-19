/**
 * Core contracts shared by every module (design revision 2.1). Pure types and
 * constants only; no DOM, no three.js runtime objects, so this file is safe to
 * import from tests, scripts and the browser alike.
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

export function isFingerBone(bone: HumanoidBone): boolean {
  return /^(left|right)(Thumb|Index|Middle|Ring|Little)/.test(bone);
}

/** Roles that make up the "body" (everything except fingers, eyes and jaw). */
export const BODY_BONES: readonly HumanoidBone[] = HUMANOID_BONES.filter(
  (b) => !isFingerBone(b) && b !== 'leftEye' && b !== 'rightEye' && b !== 'jaw',
);

/** The torso chain from the hips upward (roles that default to `relative` mode). */
export const TORSO_BONES: readonly HumanoidBone[] = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];

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
  /** 21 hand landmarks in meters relative to the hand's own geometric centre (palm orientation only). */
  local: PointTuple[];
  /** 21 hand landmarks normalized to the image. */
  image: PointTuple[];
  /** Detection score for the hand, 0..1. */
  score: number;
  /** Raw MediaPipe handedness label (assumes a mirrored selfie frame; informational). */
  handedness?: 'Left' | 'Right';
}

export interface FaceFrame {
  /** ARKit-style blendshape coefficients by name, 0..1. */
  blendshapes: Record<string, number>;
  /** 4x4 column-major facial transformation matrix (MediaPipe FaceLandmarker), or null. */
  matrix: number[] | null;
}

export interface PoseFrame {
  v: 2;
  /** Video frame media time in milliseconds, monotonic per source. */
  t: number;
  /** performance.now() at capture (optional; aligns takes with video and clip recorders). */
  now?: number;
  /** Source identifier: "mediapipe-web", "python-opencv", "recording", "synthetic". */
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
  /** Hand landmarks keyed by the subject's ANATOMICAL side, when hand tracking is enabled. */
  hands?: { left: HandFrame | null; right: HandFrame | null } | null;
  /** Face blendshapes and head transform, when face tracking is enabled. */
  face?: FaceFrame | null;
}

export interface CameraMeta {
  deviceLabel?: string;
  facingMode?: string;
  frameRate?: number;
  /** Vertical field of view in degrees (assumed or user-entered). */
  vfovDeg?: number;
}

export interface TrackerMeta {
  lib: string;
  version: string;
  poseModel?: PoseModelVariant;
  delegate?: 'GPU' | 'CPU';
  hands?: boolean;
  face?: boolean;
  minPoseDetectionConfidence?: number;
  minTrackingConfidence?: number;
}

export interface MocapMeta {
  createdAt: string;
  source: string;
  size: [number, number];
  /** Whether the app was in mirror mode when recorded (informational; frames are raw). */
  mirror: boolean;
  /** Approximate camera vertical field of view in degrees if known. */
  fovDeg?: number;
  /** Shared time origin for aligning with video and clip recordings. */
  t0?: { wallclock: string; performanceNow: number };
  camera?: CameraMeta;
  tracker?: TrackerMeta;
  /** Smoothing settings in effect when recorded (frames themselves are unfiltered). */
  smoothing?: SmoothingSettings;
  calibration?: PoseCalibration | null;
  /** The model that was driven while recording, if any. */
  referenceModel?: { familyKey: string; instanceKey?: string; displayName: string } | null;
  notes?: string;
}

export interface MocapRecording {
  format: 'cameracharacter-mocap';
  version: 2;
  meta: MocapMeta;
  frames: PoseFrame[];
}

// ---------------------------------------------------------------------------
// Numbers stored as plain arrays so profiles and takes serialize to JSON.
// ---------------------------------------------------------------------------

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface RefBasisRecord {
  /** Unit direction of the bone in the reference pose, three.js world coords. */
  d: Vec3Tuple;
  /** Unit up reference (perpendicular-ish to d) in the reference pose. */
  u: Vec3Tuple;
}

// ---------------------------------------------------------------------------
// Rig analysis (runtime, recomputed on load) and profile (persisted user intent)
// ---------------------------------------------------------------------------

export type HumanoidMap = Partial<Record<HumanoidBone, string>>;

/**
 * auto       – reference from the rig's bind pose (limbs)
 * relative   – reference = canonical standing rest (torso chain, stub bones)
 * calibrated – reference measured from the user matching the rig's rest pose
 * follow     – no measurement; takes the same world delta as its chain's driven bone
 * off        – keeps the bind pose
 */
export type BoneRefMode = 'auto' | 'relative' | 'calibrated' | 'follow' | 'off';

export interface BoneSettings {
  mode: BoneRefMode;
  /** Twist trim about the bone axis, degrees, applied in every mode. */
  rollOffsetDeg: number;
  /** Optional per-bone smoothing override (multiplier on the global bone rate). */
  smoothing?: number;
}

export type RigFamily = 'mixamo' | 'meshy' | 'game-parts' | 'vrm' | 'rigify' | 'ue' | 'cc' | 'daz' | 'smpl' | 'blender' | 'unknown';

export interface RigBoneAnalysis {
  /** Bone (Object3D) name in the loaded model. */
  name: string;
  /** Rest (bind pose) world direction of the bone, unit, final scene frame. */
  restDir: Vec3Tuple;
  /** Bind-derived up reference (same estimator as the body model), or null when the geometry does not define one. */
  restUp: Vec3Tuple | null;
  /** Rest world quaternion. */
  restQuat: QuatTuple;
  /** Rest world position. */
  restPos: Vec3Tuple;
  /** Bone length toward the humanoid child or the tail estimate, meters after scaling. */
  length: number;
  /** Angle (degrees) between the rest direction and the canonical T-pose direction. */
  canonicalDeviationDeg: number;
  /** True when the rest direction is inside the plausibility cone. */
  anatomical: boolean;
  /** Mapped humanoid parent and child roles (skipping unmapped intermediates). */
  parentRole: HumanoidBone | null;
  childRole: HumanoidBone | null;
  /** Number of unmapped nodes between this bone and its mapped parent. */
  intermediateCount: number;
}

export interface RigAxes {
  /** Detected up and forward axes of the rig in loader space, before correction. */
  up: Vec3Tuple;
  forward: Vec3Tuple;
  /** How facing was decided. */
  facingSource: 'names' | 'toes' | 'marker' | 'assumed' | 'vrm';
}

/** Model heights (meters, after scaling) used by the mirror camera; monotonic. */
export interface HeightTable {
  floor: number;
  ankles: number;
  knees: number;
  hips: number;
  shoulders: number;
  eyes: number;
  headTop: number;
}

export interface RigAnalysis {
  /** Hash of the mapped humanoid subgraph (shared by every rig of the same family). */
  familyKey: string;
  /** familyKey + quantized bind-pose signature (distinguishes characters of a family). */
  instanceKey: string;
  displayName: string;
  family: RigFamily;
  map: HumanoidMap;
  confidence: Partial<Record<HumanoidBone, number>>;
  warnings: string[];
  axes: RigAxes;
  /** Applied to the wrapper group so the rig is Y-up and faces +Z. */
  rootCorrection: QuatTuple;
  /** Applied to the wrapper group so the height matches the target. */
  scale: number;
  /** Original height in loader units (skeleton bind extents, cross-checked with skinned geometry). */
  sourceHeight: number;
  /** FBX unit scale factor when known (cm = 1). */
  unitScaleFactor?: number;
  analysis: Partial<Record<HumanoidBone, RigBoneAnalysis>>;
  heightTable: HeightTable;
  /** Legs/arms without a usable middle joint (driven as one segment). */
  noKnee: { left: boolean; right: boolean };
  noElbow: { left: boolean; right: boolean };
  /** Whether forearm twist helper bones exist (controls how much pronation the lower arm takes). */
  hasForearmTwist: { left: boolean; right: boolean };
  /** Default per-bone settings chosen by the analysis (before the profile diff). */
  defaultBones: Partial<Record<HumanoidBone, BoneSettings>>;
  boneCount: number;
  skinnedMeshCount: number;
  /** True when the model has no skeleton at all (static mesh). */
  unrigged: boolean;
}

export interface SocketOffset {
  position: Vec3Tuple;
  rotation: QuatTuple;
  scale: number;
}

/** Persisted user intent, applied as a diff over the auto analysis. */
export interface RigProfile {
  version: 3;
  familyKey: string;
  instanceKey: string;
  displayName: string;
  updatedAt: string;
  /** role -> bone name corrections made by the user. */
  mapOverrides: HumanoidMap;
  /** Whether the user swapped left/right relative to the auto result. */
  swapSides: boolean;
  bones: Partial<Record<HumanoidBone, BoneSettings>>;
  sockets: Record<string, SocketOffset>;
  calibration: PoseCalibration | null;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export type SegmentName = 'upperArm' | 'lowerArm' | 'upperLeg' | 'lowerLeg' | 'shoulderWidth' | 'hipWidth' | 'torso';

export interface PoseCalibration {
  version: 3;
  createdAt: string;
  /** Per-role reference bases measured while the user matched the model's rest pose. */
  bases: Partial<Record<HumanoidBone, RefBasisRecord>>;
  /** Standing torso basis (d = up, u = forward) used as the torso reference. */
  torsoBaseline: RefBasisRecord | null;
  /** Running-median user segment lengths in meters (world landmarks). */
  segmentLengths: Partial<Record<SegmentName, number>>;
  /** Reference depth (meters) at which the user stood during calibration. */
  zRef: number | null;
  /** Number of frames averaged. */
  frames: number;
}

// ---------------------------------------------------------------------------
// Framing and takes (contracts between retarget, stage, record and diagnostics)
// ---------------------------------------------------------------------------

export type FramingState = 'full' | 'waist' | 'bust' | 'face' | 'none';

/** Least-squares fit of image y against user-proportion body height (docs/DESIGN.md §6.4). */
export interface FramingFit {
  /** y_img = a * h + b, with h in units of the user's height H (0 = floor, 1 = head top). */
  a: number;
  b: number;
  valid: boolean;
  /** Visible body span in height units. */
  visibleTop: number;
  visibleBottom: number;
  span: number;
  state: FramingState;
}

/** One sampled frame of a retargeted take (roles are indexed by `Take.roles`). */
export interface TakeSample {
  /** Seconds since the take started. */
  t: number;
  /** Local quaternions of the mapped bones, 4 per role. */
  local: Float32Array;
  /** World quaternions of the mapped bones, 4 per role. */
  world: Float32Array;
  hipsLocal: Vec3Tuple;
  hipsWorld: Vec3Tuple;
}

export interface Take {
  fps: number;
  roles: HumanoidBone[];
  boneNames: string[];
  /** Bind world quaternions/positions per role (same order as `roles`), final scene frame. */
  bindWorldQuat: QuatTuple[];
  bindWorldPos: Vec3Tuple[];
  /** Mapped parent index per role (-1 for the root). */
  parentIndex: number[];
  /** Bone lengths used for BVH end sites. */
  lengths: number[];
  samples: TakeSample[];
  /** performance.now() at start; shared with the landmark and video recorders. */
  t0: number;
}

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

export type CameraMode = 'mirror' | 'follow' | 'orbit';
export type HipsMode = 'locked' | 'horizontal' | 'full';
export type PoseModelVariant = 'lite' | 'full' | 'heavy';

export interface GateThresholds {
  on: number;
  off: number;
}

export interface SmoothingSettings {
  /** One Euro min cutoff (Hz). Lower = smoother when still. */
  oneEuroMinCutoff: number;
  /** One Euro beta on size-normalized velocity (0..100). Higher = less lag on fast motion. */
  oneEuroBeta: number;
  /** One Euro derivative cutoff (Hz). */
  oneEuroDCutoff: number;
  /** Bone rotation response rate (1/s). */
  boneRate: number;
  /** Extra response added at high angular velocity (1/s per rad/s). */
  boneRateVelocityGain: number;
  /** Visibility gate thresholds per landmark group. */
  gateBody: GateThresholds;
  gateFeet: GateThresholds;
  gateFace: GateThresholds;
  /** A gate opens only after the visibility has been above `on` (and in frame) for this long. */
  gateDwellMs: number;
  /** A gate releases after the visibility has been below `off` for this long. */
  gateReleaseMs: number;
  /** A gate releases after the landmark has been out of frame for this long. */
  outOfFrameReleaseMs: number;
  /** Time a part holds its last pose after tracking loss before relaxing (ms). */
  poseHoldMs: { arms: number; legs: number; torso: number };
  /** Rate (1/s) at which an untracked bone relaxes toward rest. */
  relaxRate: number;
  /** Low-pass time constant (s) of the twist state. */
  twistTau: number;
  /** Fraction of palm-derived twist applied to the lower arm (rest goes to the hand). */
  lowerArmTwistFraction: number;
  /** Confidence ramp after the pose is re-acquired (ms). */
  reacquireRampMs: number;
  /** Seconds of confident full-body tracking used for the standing baseline. */
  standingBaselineSec: number;
}

export interface TrackingSettings {
  poseModel: PoseModelVariant;
  hands: boolean;
  face: boolean;
  /** Run hands/face every N pose frames. */
  auxCadence: number;
  delegate: 'GPU' | 'CPU';
  /** Assumed webcam vertical field of view in degrees (sets the absolute depth scale). */
  cameraVfovDeg: number;
  /** Run the face landmarker at full cadence in bust/face framing even when face tracking is off. */
  closeUpFace: boolean;
}

export interface StageSettings {
  mirror: boolean;
  cameraMode: CameraMode;
  hipsMode: HipsMode;
  targetHeight: number;
  /** Vertical field of view of the mirror camera in degrees. */
  mirrorCameraFovDeg: number;
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
  tracking: {
    poseModel: 'full',
    hands: false,
    face: false,
    auxCadence: 2,
    delegate: 'GPU',
    cameraVfovDeg: 45,
    closeUpFace: true,
  },
  smoothing: {
    oneEuroMinCutoff: 1.0,
    oneEuroBeta: 30,
    oneEuroDCutoff: 1.0,
    boneRate: 14,
    boneRateVelocityGain: 2,
    gateBody: { on: 0.65, off: 0.45 },
    gateFeet: { on: 0.5, off: 0.3 },
    gateFace: { on: 0.8, off: 0.6 },
    gateDwellMs: 150,
    gateReleaseMs: 250,
    outOfFrameReleaseMs: 100,
    poseHoldMs: { arms: 700, legs: 1000, torso: 300 },
    relaxRate: 2,
    twistTau: 0.3,
    lowerArmTwistFraction: 0.5,
    reacquireRampMs: 300,
    standingBaselineSec: 2,
  },
  stage: {
    mirror: true,
    cameraMode: 'mirror',
    hipsMode: 'horizontal',
    targetHeight: 1.7,
    mirrorCameraFovDeg: 35,
    showFloor: true,
    showGrid: true,
    showLandmarkSkeleton: false,
    background: '#15171c',
  },
  diagnostics: false,
};

/** Body heights in units of the user's height H (docs/DESIGN.md §6.4). */
export const USER_PROPORTIONS = {
  eyes: 0.94,
  ears: 0.93,
  nose: 0.93,
  shoulders: 0.82,
  hips: 0.53,
  knees: 0.28,
  ankles: 0.04,
} as const;
