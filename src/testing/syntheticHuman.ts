/**
 * Synthetic human: a parametric skeleton posed by joint rotations, projected
 * through a pinhole camera into MediaPipe-style pose landmarks (33 world
 * landmarks in meters relative to the hip midpoint, plus normalized image
 * landmarks with visibility). Used by unit tests, end-to-end tests and the
 * webcam-free "Synthetic" source in the app.
 *
 * Frame: three.js coordinates, Y up, the subject faces +Z, subject's left at +X.
 * The camera sits on +Z looking toward -Z, so the subject's left appears on the
 * image's right, exactly as a real webcam sees a person facing it.
 */
import { Quaternion, Vector3 } from 'three';
import type { HumanoidBone, LandmarkTuple, MocapRecording, PoseFrame } from '../core/types';
import { LM, POSE_LANDMARK_COUNT } from '../tracking/landmarks';

export interface HumanDimensions {
  hipHalfWidth: number;
  shoulderHalfWidth: number;
  /** Hip center to shoulder center. */
  torso: number;
  /** Shoulder center to skull base. */
  neck: number;
  upperArm: number;
  foreArm: number;
  hand: number;
  thigh: number;
  shin: number;
  ankleHeight: number;
  footLength: number;
  heelOffset: number;
}

export const DEFAULT_HUMAN: HumanDimensions = {
  hipHalfWidth: 0.1,
  shoulderHalfWidth: 0.19,
  torso: 0.5,
  neck: 0.15,
  upperArm: 0.28,
  foreArm: 0.26,
  hand: 0.17,
  thigh: 0.42,
  shin: 0.42,
  ankleHeight: 0.08,
  footLength: 0.18,
  heelOffset: 0.05,
};

/** Joints that accept a rotation. Rotations are local (relative to the parent joint), T-pose = identity. */
export type SyntheticJoint = Extract<
  HumanoidBone,
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'leftHand'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'rightHand'
  | 'leftUpperLeg'
  | 'leftLowerLeg'
  | 'leftFoot'
  | 'rightUpperLeg'
  | 'rightLowerLeg'
  | 'rightFoot'
>;

export type JointRotations = Partial<Record<SyntheticJoint, Quaternion>>;

export interface SyntheticPose {
  rotations: JointRotations;
  /** Hip midpoint in world space. */
  rootPosition: Vector3;
  /** Yaw of the whole body about +Y, radians (0 = facing +Z). */
  rootYaw: number;
  /** Per-landmark visibility overrides (0..1), e.g. to simulate occlusion. */
  visibilityOverride?: Partial<Record<number, number>>;
}

export interface SyntheticCamera {
  position: Vector3;
  target: Vector3;
  vFovDeg: number;
  aspect: number;
}

export const DEFAULT_CAMERA: SyntheticCamera = {
  position: new Vector3(0, 1.0, 3.2),
  target: new Vector3(0, 1.0, 0),
  vFovDeg: 60,
  aspect: 16 / 9,
};

const Q_ID = new Quaternion();

interface Node {
  pos: Vector3;
  rot: Quaternion;
}

function child(parent: Node, offset: Vector3, local?: Quaternion): Node {
  const pos = offset.clone().applyQuaternion(parent.rot).add(parent.pos);
  const rot = parent.rot.clone().multiply(local ?? Q_ID);
  return { pos, rot };
}

function point(node: Node, offset: Vector3): Vector3 {
  return offset.clone().applyQuaternion(node.rot).add(node.pos);
}

/** Forward kinematics: 33 landmark positions in world space (three.js coords). */
export function computeLandmarkPositions(pose: SyntheticPose, dims: HumanDimensions = DEFAULT_HUMAN): Vector3[] {
  const r = pose.rotations;
  const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), pose.rootYaw);
  const hips: Node = { pos: pose.rootPosition.clone(), rot: yaw.multiply(r.hips ?? Q_ID) };

  const out: Vector3[] = new Array(POSE_LANDMARK_COUNT);

  // Torso chain
  const spine = child(hips, new Vector3(0, dims.torso * 0.2, 0), r.spine);
  const chest = child(spine, new Vector3(0, dims.torso * 0.4, 0), r.chest);
  const upperChest = child(chest, new Vector3(0, dims.torso * 0.4, 0), r.upperChest);
  const neck = child(upperChest, new Vector3(0, dims.neck * 0.35, 0), r.neck);
  const head = child(neck, new Vector3(0, dims.neck * 0.65, 0), r.head);

  out[LM.LEFT_EAR] = point(head, new Vector3(0.075, 0.02, 0));
  out[LM.RIGHT_EAR] = point(head, new Vector3(-0.075, 0.02, 0));
  out[LM.LEFT_EYE_INNER] = point(head, new Vector3(0.015, 0.05, 0.085));
  out[LM.LEFT_EYE] = point(head, new Vector3(0.032, 0.05, 0.08));
  out[LM.LEFT_EYE_OUTER] = point(head, new Vector3(0.048, 0.05, 0.075));
  out[LM.RIGHT_EYE_INNER] = point(head, new Vector3(-0.015, 0.05, 0.085));
  out[LM.RIGHT_EYE] = point(head, new Vector3(-0.032, 0.05, 0.08));
  out[LM.RIGHT_EYE_OUTER] = point(head, new Vector3(-0.048, 0.05, 0.075));
  out[LM.NOSE] = point(head, new Vector3(0, 0.02, 0.11));
  out[LM.MOUTH_LEFT] = point(head, new Vector3(0.02, -0.01, 0.1));
  out[LM.MOUTH_RIGHT] = point(head, new Vector3(-0.02, -0.01, 0.1));

  // Arms
  for (const side of ['left', 'right'] as const) {
    const s = side === 'left' ? 1 : -1;
    const shoulder = child(upperChest, new Vector3(s * dims.shoulderHalfWidth, 0, 0), r[`${side}UpperArm`]);
    const elbow = child(shoulder, new Vector3(s * dims.upperArm, 0, 0), r[`${side}LowerArm`]);
    const wrist = child(elbow, new Vector3(s * dims.foreArm, 0, 0), r[`${side}Hand`]);
    out[side === 'left' ? LM.LEFT_SHOULDER : LM.RIGHT_SHOULDER] = shoulder.pos.clone();
    out[side === 'left' ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW] = elbow.pos.clone();
    out[side === 'left' ? LM.LEFT_WRIST : LM.RIGHT_WRIST] = wrist.pos.clone();
    out[side === 'left' ? LM.LEFT_INDEX : LM.RIGHT_INDEX] = point(wrist, new Vector3(s * dims.hand, 0, 0.02));
    out[side === 'left' ? LM.LEFT_PINKY : LM.RIGHT_PINKY] = point(wrist, new Vector3(s * dims.hand * 0.94, 0, -0.03));
    out[side === 'left' ? LM.LEFT_THUMB : LM.RIGHT_THUMB] = point(wrist, new Vector3(s * dims.hand * 0.45, 0, 0.06));
  }

  // Legs
  for (const side of ['left', 'right'] as const) {
    const s = side === 'left' ? 1 : -1;
    const hip = child(hips, new Vector3(s * dims.hipHalfWidth, 0, 0), r[`${side}UpperLeg`]);
    const knee = child(hip, new Vector3(0, -dims.thigh, 0), r[`${side}LowerLeg`]);
    const ankle = child(knee, new Vector3(0, -dims.shin, 0), r[`${side}Foot`]);
    out[side === 'left' ? LM.LEFT_HIP : LM.RIGHT_HIP] = hip.pos.clone();
    out[side === 'left' ? LM.LEFT_KNEE : LM.RIGHT_KNEE] = knee.pos.clone();
    out[side === 'left' ? LM.LEFT_ANKLE : LM.RIGHT_ANKLE] = ankle.pos.clone();
    out[side === 'left' ? LM.LEFT_HEEL : LM.RIGHT_HEEL] = point(ankle, new Vector3(0, -dims.ankleHeight, -dims.heelOffset));
    out[side === 'left' ? LM.LEFT_FOOT_INDEX : LM.RIGHT_FOOT_INDEX] = point(
      ankle,
      new Vector3(0, -dims.ankleHeight, dims.footLength),
    );
  }

  return out;
}

export interface Projected {
  /** Normalized image coords (x right, y down, in [0,1] when inside the frame). */
  u: number;
  v: number;
  /** Depth in front of the camera (meters). */
  depth: number;
}

export function projectPoint(p: Vector3, cam: SyntheticCamera): Projected {
  const f = cam.target.clone().sub(cam.position).normalize();
  const right = new Vector3().crossVectors(f, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, f).normalize();
  const rel = p.clone().sub(cam.position);
  const xc = rel.dot(right);
  const yc = rel.dot(up);
  const zc = rel.dot(f);
  const fy = 0.5 / Math.tan((cam.vFovDeg * Math.PI) / 360);
  const depth = Math.max(zc, 1e-3);
  return { u: 0.5 + ((xc / depth) * fy) / cam.aspect, v: 0.5 - (yc / depth) * fy, depth };
}

function visibilityFor(u: number, v: number): number {
  const margin = 0.02;
  const dx = Math.max(margin - u, u - (1 - margin), 0);
  const dy = Math.max(margin - v, v - (1 - margin), 0);
  const d = Math.hypot(dx, dy);
  if (d <= 0) return 0.98;
  return Math.max(0.05, 0.98 - d * 8);
}

/**
 * Builds a PoseFrame (raw MediaPipe conventions) from world landmark positions.
 * World landmarks: origin at the hip midpoint, x image-right, y down, z toward
 * the camera negative. Image landmarks: normalized, z in x-units relative to hips.
 */
export function toPoseFrame(
  points: Vector3[],
  cam: SyntheticCamera,
  t: number,
  opts: { size?: [number, number]; src?: string; visibilityOverride?: Partial<Record<number, number>> } = {},
): PoseFrame {
  const size = opts.size ?? [1280, 720];
  const hipMid = points[LM.LEFT_HIP].clone().add(points[LM.RIGHT_HIP]).multiplyScalar(0.5);
  const hipProj = projectPoint(hipMid, cam);
  const fy = 0.5 / Math.tan((cam.vFovDeg * Math.PI) / 360);
  const world: LandmarkTuple[] = [];
  const image: LandmarkTuple[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const pr = projectPoint(p, cam);
    let vis = visibilityFor(pr.u, pr.v);
    const ov = opts.visibilityOverride?.[i];
    if (ov !== undefined) vis = Math.min(vis, ov);
    const rel = p.clone().sub(hipMid);
    world.push([round(rel.x), round(-rel.y), round(-rel.z), round(vis)]);
    const zImg = ((pr.depth - hipProj.depth) * fy) / (cam.aspect * hipProj.depth);
    image.push([round(pr.u), round(pr.v), round(zImg), round(vis)]);
  }
  return { v: 2, t, src: opts.src ?? 'synthetic', size, pose: { world, image } };
}

function round(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}

// ---------------------------------------------------------------------------
// Rotation helpers (degrees) and presets
// ---------------------------------------------------------------------------

const AX = new Vector3(1, 0, 0);
const AY = new Vector3(0, 1, 0);
const AZ = new Vector3(0, 0, 1);
const D2R = Math.PI / 180;

export const rotX = (deg: number): Quaternion => new Quaternion().setFromAxisAngle(AX, deg * D2R);
export const rotY = (deg: number): Quaternion => new Quaternion().setFromAxisAngle(AY, deg * D2R);
export const rotZ = (deg: number): Quaternion => new Quaternion().setFromAxisAngle(AZ, deg * D2R);

/** Lower the arm from the T-pose by `deg` (0 = horizontal, 90 = hanging down). */
export function armDown(side: 'left' | 'right', deg: number): Quaternion {
  return rotZ(side === 'left' ? -deg : deg);
}
/** Swing the arm forward (toward +Z) from wherever it is, about the body's vertical axis. */
export function armForward(side: 'left' | 'right', deg: number): Quaternion {
  return rotY(side === 'left' ? -deg : deg);
}
/** Flex the elbow by `deg`; in a T-pose the forearm swings forward. */
export function elbowFlex(side: 'left' | 'right', deg: number): Quaternion {
  return rotY(side === 'left' ? -deg : deg);
}
/** Hip flexion: thigh swings forward (+Z) by `deg`. */
export function hipFlex(deg: number): Quaternion {
  return rotX(-deg);
}
/** Knee flexion: heel swings backward by `deg`. */
export function kneeFlex(deg: number): Quaternion {
  return rotX(deg);
}
/** Nod the head down by `deg`. */
export function headNod(deg: number): Quaternion {
  return rotX(deg);
}

export interface SyntheticPreset {
  name: string;
  description: string;
  durationSec: number;
  camera: SyntheticCamera;
  poseAt(t: number): SyntheticPose;
  /** Optional camera motion. */
  cameraAt?(t: number): SyntheticCamera;
}

const STAND_Y = DEFAULT_HUMAN.thigh + DEFAULT_HUMAN.shin + DEFAULT_HUMAN.ankleHeight;

function standing(rotations: JointRotations, extra: Partial<SyntheticPose> = {}): SyntheticPose {
  return { rotations, rootPosition: new Vector3(0, STAND_Y, 0), rootYaw: 0, ...extra };
}

function relaxedArms(): JointRotations {
  return {
    leftUpperArm: armDown('left', 75),
    rightUpperArm: armDown('right', 75),
    leftLowerArm: elbowFlex('left', 10),
    rightLowerArm: elbowFlex('right', 10),
  };
}

const ease = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(Math.max(x, 0), 1));

export const SYNTHETIC_PRESETS: Record<string, SyntheticPreset> = {
  tpose: {
    name: 'tpose',
    description: 'Static T-pose, full body in frame',
    durationSec: 4,
    camera: DEFAULT_CAMERA,
    poseAt: () => standing({}),
  },
  apose: {
    name: 'apose',
    description: 'Static A-pose (arms 60° down)',
    durationSec: 4,
    camera: DEFAULT_CAMERA,
    poseAt: () => standing({ leftUpperArm: armDown('left', 60), rightUpperArm: armDown('right', 60) }),
  },
  'arm-raise': {
    name: 'arm-raise',
    description: 'Left arm sweeps from hanging to overhead while the elbow bends; right arm relaxed',
    durationSec: 6,
    camera: DEFAULT_CAMERA,
    poseAt: (t) => {
      const k = ease((Math.sin((t / 6) * Math.PI * 2 - Math.PI / 2) + 1) / 2);
      const down = 75 - 150 * k; // 75 (hanging) -> -75 (overhead)
      return standing({
        ...relaxedArms(),
        leftUpperArm: armDown('left', down),
        leftLowerArm: elbowFlex('left', 10 + 50 * k),
        rightUpperArm: armDown('right', 75),
      });
    },
  },
  squat: {
    name: 'squat',
    description: 'Repeated squats with arms forward for balance',
    durationSec: 6,
    camera: DEFAULT_CAMERA,
    poseAt: (t) => {
      const k = ease((1 - Math.cos((t / 3) * Math.PI * 2)) / 2);
      const theta = 70 * k;
      const c = Math.cos(theta * D2R);
      const y = DEFAULT_HUMAN.ankleHeight + (DEFAULT_HUMAN.thigh + DEFAULT_HUMAN.shin) * c;
      return standing(
        {
          leftUpperLeg: hipFlex(theta),
          rightUpperLeg: hipFlex(theta),
          leftLowerLeg: kneeFlex(2 * theta),
          rightLowerLeg: kneeFlex(2 * theta),
          leftFoot: kneeFlex(-theta),
          rightFoot: kneeFlex(-theta),
          leftUpperArm: armDown('left', 75 - 70 * k).multiply(armForward('left', 80 * k)),
          rightUpperArm: armDown('right', 75 - 70 * k).multiply(armForward('right', 80 * k)),
          spine: rotX(15 * k),
        },
        { rootPosition: new Vector3(0, y, 0) },
      );
    },
  },
  walk: {
    name: 'walk',
    description: 'Walking in place: alternating legs, counter-swinging arms, slight bob',
    durationSec: 6,
    camera: DEFAULT_CAMERA,
    poseAt: (t) => {
      const phase = (t / 1.2) * Math.PI * 2;
      const swing = Math.sin(phase);
      const lHip = 30 * swing;
      const rHip = -30 * swing;
      const lKnee = Math.max(0, 50 * Math.sin(phase + Math.PI / 2)) + 5;
      const rKnee = Math.max(0, 50 * Math.sin(phase + Math.PI / 2 + Math.PI)) + 5;
      const bob = 0.02 * Math.abs(Math.cos(phase));
      return standing(
        {
          leftUpperLeg: hipFlex(lHip),
          rightUpperLeg: hipFlex(rHip),
          leftLowerLeg: kneeFlex(lKnee),
          rightLowerLeg: kneeFlex(rKnee),
          leftUpperArm: armDown('left', 78).multiply(rotX(-25 * -swing)),
          rightUpperArm: armDown('right', 78).multiply(rotX(-25 * swing)),
          leftLowerArm: elbowFlex('left', 20),
          rightLowerArm: elbowFlex('right', 20),
          spine: rotY(6 * swing),
          head: rotY(-4 * swing),
        },
        { rootPosition: new Vector3(0, STAND_Y - bob, 0) },
      );
    },
  },
  turn: {
    name: 'turn',
    description: 'Torso and head twist left and right, arms relaxed',
    durationSec: 6,
    camera: DEFAULT_CAMERA,
    poseAt: (t) => {
      const k = Math.sin((t / 6) * Math.PI * 2);
      return standing({
        ...relaxedArms(),
        spine: rotY(15 * k),
        chest: rotY(15 * k),
        neck: rotY(10 * k),
        head: rotY(15 * k).multiply(headNod(10 * Math.sin((t / 2) * Math.PI * 2))),
      });
    },
  },
  wave: {
    name: 'wave',
    description: 'Right arm raised and waving; left arm relaxed',
    durationSec: 5,
    camera: DEFAULT_CAMERA,
    poseAt: (t) => {
      const k = Math.sin((t / 0.8) * Math.PI * 2);
      return standing({
        ...relaxedArms(),
        rightUpperArm: armDown('right', -40),
        rightLowerArm: elbowFlex('right', 70 + 25 * k),
        rightHand: rotZ(15 * k),
      });
    },
  },
  closeup: {
    name: 'closeup',
    description: 'Camera close: only head, shoulders and upper arms in frame; subject sways and turns the head',
    durationSec: 6,
    camera: { position: new Vector3(0, 1.45, 1.1), target: new Vector3(0, 1.45, 0), vFovDeg: 60, aspect: 16 / 9 },
    poseAt: (t) => {
      const k = Math.sin((t / 4) * Math.PI * 2);
      return standing({
        ...relaxedArms(),
        spine: rotZ(4 * k),
        head: rotY(20 * k).multiply(headNod(6 * Math.sin((t / 1.5) * Math.PI * 2))),
        leftUpperArm: armDown('left', 70 - 10 * k),
        rightUpperArm: armDown('right', 70 + 10 * k),
      });
    },
  },
  approach: {
    name: 'approach',
    description: 'Subject walks toward the camera from full-body framing to a head-and-shoulders close-up',
    durationSec: 8,
    camera: { position: new Vector3(0, 1.2, 3.6), target: new Vector3(0, 1.2, 0), vFovDeg: 60, aspect: 16 / 9 },
    poseAt: (t) => {
      const k = ease(t / 8);
      const z = 2.6 * k;
      const phase = (t / 1.2) * Math.PI * 2;
      const swing = Math.sin(phase);
      return standing(
        {
          leftUpperLeg: hipFlex(25 * swing),
          rightUpperLeg: hipFlex(-25 * swing),
          leftLowerLeg: kneeFlex(Math.max(0, 40 * Math.sin(phase + Math.PI / 2)) + 5),
          rightLowerLeg: kneeFlex(Math.max(0, 40 * Math.sin(phase + 3 * Math.PI / 2)) + 5),
          leftUpperArm: armDown('left', 78).multiply(rotX(20 * swing)),
          rightUpperArm: armDown('right', 78).multiply(rotX(-20 * swing)),
          leftLowerArm: elbowFlex('left', 20),
          rightLowerArm: elbowFlex('right', 20),
        },
        { rootPosition: new Vector3(0, STAND_Y - 0.02 * Math.abs(Math.cos(phase)), z) },
      );
    },
  },
  'occluded-arm': {
    name: 'occluded-arm',
    description: 'Left arm goes behind the back (low visibility) and returns',
    durationSec: 6,
    camera: DEFAULT_CAMERA,
    poseAt: (t) => {
      const k = ease((1 - Math.cos((t / 6) * Math.PI * 2)) / 2);
      const hidden = k > 0.5 ? 0.1 : 0.98;
      return standing(
        {
          ...relaxedArms(),
          leftUpperArm: armDown('left', 80).multiply(armForward('left', -60 * k)),
          leftLowerArm: elbowFlex('left', 10 + 70 * k),
        },
        {
          visibilityOverride: {
            [LM.LEFT_WRIST]: hidden,
            [LM.LEFT_INDEX]: hidden,
            [LM.LEFT_PINKY]: hidden,
            [LM.LEFT_THUMB]: hidden,
            [LM.LEFT_ELBOW]: k > 0.7 ? 0.2 : 0.98,
          },
        },
      );
    },
  },
};

export function listSyntheticPresets(): string[] {
  return Object.keys(SYNTHETIC_PRESETS);
}

/** Generates a full recording for a preset. */
export function generateRecording(
  presetName: string,
  opts: { fps?: number; durationSec?: number; dims?: HumanDimensions } = {},
): MocapRecording {
  const preset = SYNTHETIC_PRESETS[presetName];
  if (!preset) throw new Error(`Unknown synthetic preset: ${presetName}`);
  const fps = opts.fps ?? 30;
  const duration = opts.durationSec ?? preset.durationSec;
  const frames: PoseFrame[] = [];
  const count = Math.max(1, Math.round(duration * fps));
  for (let i = 0; i < count; i++) {
    const t = i / fps;
    const pose = preset.poseAt(t);
    const cam = preset.cameraAt ? preset.cameraAt(t) : preset.camera;
    const points = computeLandmarkPositions(pose, opts.dims ?? DEFAULT_HUMAN);
    frames.push(toPoseFrame(points, cam, Math.round(t * 1000), { visibilityOverride: pose.visibilityOverride }));
  }
  return {
    format: 'cameracharacter-mocap',
    version: 2,
    meta: {
      createdAt: new Date(0).toISOString(),
      source: `synthetic:${preset.name}`,
      size: [1280, 720],
      mirror: false,
      notes: preset.description,
      fovDeg: preset.camera.vFovDeg,
    },
    frames,
  };
}

/** Single frame helper for tests: pose -> PoseFrame with the default camera. */
export function framePose(pose: SyntheticPose, t = 0, cam: SyntheticCamera = DEFAULT_CAMERA): PoseFrame {
  return toPoseFrame(computeLandmarkPositions(pose), cam, t, { visibilityOverride: pose.visibilityOverride });
}

export { standing as standingPose };
