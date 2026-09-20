/**
 * Test helpers for the retargeting layer: synthetic three.js Bone rigs with a
 * chosen bind pose and local-axis convention, the matching RigAnalysis
 * (rest directions and up references estimated with the SAME core/math
 * estimators as DESIGN §6.2 auto mode), and FilteredPose objects built from
 * syntheticHuman PoseFrames.
 */
import { Bone, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { FilteredPose } from '../../src/core/pose';
import type {
  BoneSettings,
  FramingFit,
  HeightTable,
  HipsMode,
  HumanoidBone,
  PoseFrame,
  RigAnalysis,
  RigBoneAnalysis,
  SmoothingSettings,
} from '../../src/core/types';
import { DEFAULT_SETTINGS, HUMANOID_PARENT } from '../../src/core/types';
import { DEG2RAD, angleBetween, flexionUp, kneecapUp, perpendicularComponent } from '../../src/core/math';
import { canonicalDeviationDeg, isAnatomical } from '../../src/retarget/canonical';
import { BodyModel, type BodyModelResult } from '../../src/retarget/bodyModel';
import { fitFraming } from '../../src/retarget/framing';
import { Retargeter, type SolveResult } from '../../src/retarget/solver';
import { LM, POSE_LANDMARK_COUNT } from '../../src/tracking/landmarks';
import { SYNTHETIC_PRESETS, computeLandmarkPositions, toPoseFrame } from '../../src/testing/syntheticHuman';

export const SMOOTHING: SmoothingSettings = { ...DEFAULT_SETTINGS.smoothing, poseHoldMs: { ...DEFAULT_SETTINGS.smoothing.poseHoldMs } };

// ---------------------------------------------------------------------------
// Rig specification
// ---------------------------------------------------------------------------

export type RigPose = 'tpose' | 'apose' | 'armsDown' | 'noKnee';
export type AxisConvention = 'y' | 'x' | 'identity';

export interface RigOptions {
  pose: RigPose;
  /** Which local axis runs along the bone in the bind pose. */
  axis: AxisConvention;
  /** Transform of the armature node above the hips (e.g. +90° about X, scale 0.01 for a Z-up cm rig). */
  armature?: { quaternion: Quaternion; scale: number };
  /** Insert unmapped intermediate nodes (a pelvis helper below the spine and a twist node in each upper arm). */
  intermediates?: boolean;
  /** Include clavicle bones. */
  shoulders?: boolean;
  /** Include an upperChest bone between chest and neck (22 mapped roles with shoulders). */
  upperChest?: boolean;
}

/** Joint name -> world position (final scene frame) and parent joint. */
interface JointSpec {
  pos: Vector3;
  parent: string | null;
  role?: HumanoidBone;
}

export interface BuiltRig {
  name: string;
  root: Object3D;
  armature: Object3D;
  bones: Partial<Record<HumanoidBone, Object3D>>;
  nodes: Record<string, Object3D>;
  /** End-marker child of a role (leaf bones), for world-direction checks. */
  tailOf: Partial<Record<HumanoidBone, Object3D>>;
  analysis: RigAnalysis;
  boneSettings: Partial<Record<HumanoidBone, BoneSettings>>;
}

function v(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z);
}

function jointSpecs(opts: RigOptions): Record<string, JointSpec> {
  const J: Record<string, JointSpec> = {};
  const add = (name: string, pos: Vector3, parent: string | null, role?: HumanoidBone): void => {
    J[name] = { pos, parent, role };
  };
  add('hips', v(0, 0.95, 0), null, 'hips');
  let spineParent = 'hips';
  if (opts.intermediates) {
    add('pelvisHelper', v(0, 0.98, 0), 'hips');
    spineParent = 'pelvisHelper';
  }
  add('spine', v(0, 1.05, 0), spineParent, 'spine');
  add('chest', v(0, 1.2, 0), 'spine', 'chest');
  let neckParent = 'chest';
  if (opts.upperChest) {
    add('upperChest', v(0, 1.32, 0), 'chest', 'upperChest');
    neckParent = 'upperChest';
  }
  add('neck', v(0, 1.45, 0), neckParent, 'neck');
  add('head', v(0, 1.55, 0), 'neck', 'head');
  add('headEnd', v(0, 1.72, 0), 'head');

  for (const side of ['left', 'right'] as const) {
    const s = side === 'left' ? 1 : -1;
    const S = side === 'left' ? 'left' : 'right';
    const torsoTop = opts.upperChest ? 'upperChest' : 'chest';
    const armParent = opts.shoulders ? `${side}Shoulder` : torsoTop;
    if (opts.shoulders) add(`${side}Shoulder`, v(s * 0.04, 1.42, 0), torsoTop, `${S}Shoulder` as HumanoidBone);
    const ua = v(s * 0.18, 1.42, 0);
    let uaDir: Vector3;
    let laDir: Vector3;
    if (opts.pose === 'apose') {
      uaDir = v(s * Math.cos(45 * DEG2RAD), -Math.sin(45 * DEG2RAD), 0);
      laDir = uaDir.clone();
    } else if (opts.pose === 'armsDown') {
      uaDir = v(0, -1, 0);
      laDir = v(0, -Math.cos(20 * DEG2RAD), Math.sin(20 * DEG2RAD));
    } else {
      uaDir = v(s, 0, 0);
      laDir = uaDir.clone();
    }
    const elbow = ua.clone().addScaledVector(uaDir, 0.28);
    const wrist = elbow.clone().addScaledVector(laDir, 0.26);
    const handEnd = wrist.clone().addScaledVector(laDir, 0.18);
    add(`${side}UpperArm`, ua, armParent, `${S}UpperArm` as HumanoidBone);
    let laParent = `${side}UpperArm`;
    if (opts.intermediates) {
      add(`${side}ArmTwist`, ua.clone().addScaledVector(uaDir, 0.14), `${side}UpperArm`);
      laParent = `${side}ArmTwist`;
    }
    add(`${side}LowerArm`, elbow, laParent, `${S}LowerArm` as HumanoidBone);
    add(`${side}Hand`, wrist, `${side}LowerArm`, `${S}Hand` as HumanoidBone);
    add(`${side}HandEnd`, handEnd, `${side}Hand`);

    const hip = v(s * 0.1, 0.9, 0);
    add(`${side}UpperLeg`, hip, 'hips', `${S}UpperLeg` as HumanoidBone);
    if (opts.pose === 'noKnee') {
      // 0.1 m stub thigh pointing up and outward; the shin runs from its tip to the ankle.
      const stubTip = hip.clone().add(v(s * 0.05, 0.0866, 0));
      add(`${side}LowerLeg`, stubTip, `${side}UpperLeg`, `${S}LowerLeg` as HumanoidBone);
    } else {
      add(`${side}LowerLeg`, v(s * 0.1, 0.48, 0), `${side}UpperLeg`, `${S}LowerLeg` as HumanoidBone);
    }
    add(`${side}Foot`, v(s * 0.1, 0.08, 0), `${side}LowerLeg`, `${S}Foot` as HumanoidBone);
    add(`${side}Toes`, v(s * 0.1, 0.02, 0.12), `${side}Foot`, `${S}Toes` as HumanoidBone);
    add(`${side}ToesEnd`, v(s * 0.1, 0.02, 0.2), `${side}Toes`);
  }
  return J;
}

/** First child joint of `name` in the spec (for the "along the bone" axis). */
function childOf(J: Record<string, JointSpec>, name: string): string | null {
  for (const [n, j] of Object.entries(J)) if (j.parent === name) return n;
  return null;
}

/** World quaternion for a bone with `dir` along the requested local axis and a deterministic roll. */
function worldQuatFor(dir: Vector3, axis: AxisConvention, seed: number): Quaternion {
  if (axis === 'identity') return new Quaternion();
  const d = dir.clone().normalize();
  // Roll reference: something not parallel to d, varied per bone so no rig axis is accidentally "nice".
  const ref = new Vector3(Math.sin(seed * 1.7), Math.cos(seed * 0.9) + 0.3, Math.sin(seed * 2.3) + 0.5);
  let w = perpendicularComponent(ref, d) ?? new Vector3(0, 0, 1);
  if (Math.abs(w.dot(d)) > 0.99) w = new Vector3(1, 0, 0);
  const third = new Vector3().crossVectors(d, w).normalize();
  const m = new Matrix4();
  if (axis === 'y') m.makeBasis(w, d, third.clone().negate()); // x = w, y = d, z = -third (right-handed: x × y = z)
  else m.makeBasis(d, third, w); // x = d, y = third, z = w  (d × third = w)
  // Fix handedness: makeBasis does not enforce det = +1; recompute z = x × y.
  const cx = new Vector3().setFromMatrixColumn(m, 0);
  const cy = new Vector3().setFromMatrixColumn(m, 1);
  const cz = new Vector3().crossVectors(cx, cy).normalize();
  m.makeBasis(cx, cy, cz);
  return new Quaternion().setFromRotationMatrix(m);
}

export function buildRig(opts: RigOptions): BuiltRig {
  const J = jointSpecs(opts);
  const root = new Object3D();
  root.name = 'Wrapper';
  const armature = new Object3D();
  armature.name = 'Armature';
  if (opts.armature) {
    armature.quaternion.copy(opts.armature.quaternion);
    armature.scale.setScalar(opts.armature.scale);
  }
  root.add(armature);
  root.updateMatrixWorld(true);
  const S = opts.armature?.scale ?? 1;
  const nodes: Record<string, Object3D> = {};
  const worldMats: Record<string, Matrix4> = {};
  const order = Object.keys(J);
  let seed = 1;
  for (const name of order) {
    const j = J[name];
    const node = j.role || name.endsWith('End') || name === 'pelvisHelper' || name.endsWith('Twist') ? new Bone() : new Object3D();
    node.name = name;
    const child = childOf(J, name);
    const dir = child ? J[child].pos.clone().sub(j.pos) : J[j.parent!].pos.clone().sub(j.pos).negate();
    if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
    const q = worldQuatFor(dir, opts.axis, seed++);
    const world = new Matrix4().compose(j.pos, q, new Vector3(S, S, S));
    worldMats[name] = world;
    const parentWorld = j.parent ? worldMats[j.parent] : armature.matrixWorld;
    const local = new Matrix4().copy(parentWorld).invert().multiply(world);
    local.decompose(node.position, node.quaternion, node.scale);
    // Snap the local scale to 1 (the decomposition is exact up to rounding).
    node.scale.set(1, 1, 1);
    (j.parent ? nodes[j.parent] : armature).add(node);
    nodes[name] = node;
  }
  root.updateMatrixWorld(true);
  const bones: Partial<Record<HumanoidBone, Object3D>> = {};
  const tailOf: Partial<Record<HumanoidBone, Object3D>> = {};
  for (const [name, j] of Object.entries(J)) {
    if (j.role) bones[j.role] = nodes[name];
  }
  tailOf.head = nodes.headEnd;
  tailOf.leftHand = nodes.leftHandEnd;
  tailOf.rightHand = nodes.rightHandEnd;
  tailOf.leftToes = nodes.leftToesEnd;
  tailOf.rightToes = nodes.rightToesEnd;
  const analysis = analyzeRig(opts, J, nodes, bones, tailOf);
  const boneSettings: Partial<Record<HumanoidBone, BoneSettings>> = {};
  for (const [role, bs] of Object.entries(analysis.defaultBones)) boneSettings[role as HumanoidBone] = { ...bs! };
  return {
    name: `${opts.pose}-${opts.axis}${opts.armature ? '-armature' : ''}${opts.intermediates ? '-inter' : ''}${opts.shoulders ? '-sh' : ''}${opts.upperChest ? '-uc' : ''}`,
    root,
    armature,
    bones,
    nodes,
    tailOf,
    analysis,
    boneSettings,
  };
}

// ---------------------------------------------------------------------------
// Rig analysis (mirrors DESIGN §5.5 / §6.2 auto mode with the core/math estimators)
// ---------------------------------------------------------------------------

const BIND_BEND_MIN_DEG = 12;

function worldPos(node: Object3D): Vector3 {
  return new Vector3().setFromMatrixPosition(node.matrixWorld);
}

/**
 * Up reference of a role from bind joint positions, using the same estimators
 * as the body model (DESIGN §6.2 auto): torso/neck/head/shoulder = model +Z;
 * upperArm = flexion direction when the bind elbow bends > 12°; upperLeg =
 * kneecap direction when the bind knee bends > 12°; lowerLeg = foot forward
 * perpendicular to the shin; foot/toes = ankle->knee perpendicular to the
 * foot; lowerArm/hand = null (no finger geometry defines the dorsal normal).
 */
export function estimateRestUp(role: HumanoidBone, P: Partial<Record<HumanoidBone, Vector3>>, tail: Partial<Record<HumanoidBone, Vector3>>): Vector3 | null {
  const side = role.startsWith('left') ? 'left' : role.startsWith('right') ? 'right' : null;
  const g = (r: string): Vector3 | undefined => P[r as HumanoidBone];
  switch (role) {
    case 'hips':
    case 'spine':
    case 'chest':
    case 'upperChest':
    case 'neck':
    case 'head':
    case 'leftShoulder':
    case 'rightShoulder':
      return new Vector3(0, 0, 1);
    case 'leftUpperArm':
    case 'rightUpperArm': {
      const sh = g(`${side}UpperArm`);
      const el = g(`${side}LowerArm`);
      const wr = g(`${side}Hand`);
      if (!sh || !el || !wr) return null;
      const d = el.clone().sub(sh);
      const c = wr.clone().sub(el);
      if (angleBetween(d, c) < BIND_BEND_MIN_DEG * DEG2RAD) return null;
      return flexionUp(d, c);
    }
    case 'leftLowerArm':
    case 'rightLowerArm':
    case 'leftHand':
    case 'rightHand':
      return null;
    case 'leftUpperLeg':
    case 'rightUpperLeg': {
      const hip = g(`${side}UpperLeg`);
      const knee = g(`${side}LowerLeg`);
      const ankle = g(`${side}Foot`);
      if (!hip || !knee || !ankle) return null;
      const d = knee.clone().sub(hip);
      const c = ankle.clone().sub(knee);
      if (angleBetween(d, c) < BIND_BEND_MIN_DEG * DEG2RAD) return null;
      return kneecapUp(d, c);
    }
    case 'leftLowerLeg':
    case 'rightLowerLeg': {
      const knee = g(`${side}LowerLeg`);
      const ankle = g(`${side}Foot`);
      const toes = g(`${side}Toes`) ?? tail[`${side}Foot` as HumanoidBone];
      if (!knee || !ankle || !toes) return null;
      return perpendicularComponent(toes.clone().sub(ankle), ankle.clone().sub(knee).normalize());
    }
    case 'leftFoot':
    case 'rightFoot':
    case 'leftToes':
    case 'rightToes': {
      const knee = g(`${side}LowerLeg`);
      const ankle = g(`${side}Foot`);
      const toes = g(`${side}Toes`);
      const footDir = role.endsWith('Foot') ? (toes ?? tail[role])?.clone().sub(ankle!) : tail[role]?.clone().sub(toes!);
      if (!knee || !ankle || !footDir) return null;
      return perpendicularComponent(knee.clone().sub(ankle), footDir.normalize());
    }
    default:
      return null;
  }
}

function analyzeRig(
  opts: RigOptions,
  J: Record<string, JointSpec>,
  nodes: Record<string, Object3D>,
  bones: Partial<Record<HumanoidBone, Object3D>>,
  tailOf: Partial<Record<HumanoidBone, Object3D>>,
): RigAnalysis {
  const P: Partial<Record<HumanoidBone, Vector3>> = {};
  const tail: Partial<Record<HumanoidBone, Vector3>> = {};
  for (const [role, node] of Object.entries(bones)) P[role as HumanoidBone] = worldPos(node!);
  for (const [role, node] of Object.entries(tailOf)) tail[role as HumanoidBone] = worldPos(node!);
  const mappedParent = (role: HumanoidBone): HumanoidBone | null => {
    let p = HUMANOID_PARENT[role];
    while (p && !bones[p]) p = HUMANOID_PARENT[p];
    return p;
  };
  const mappedChild = (role: HumanoidBone): HumanoidBone | null => {
    for (const [r, b] of Object.entries(bones)) {
      if (!b) continue;
      if (mappedParent(r as HumanoidBone) === role) {
        // Prefer the chain child (torso chain for hips), not a leg.
        if (role === 'hips' && !(r as string).match(/^(spine|chest|upperChest|neck|head)$/)) continue;
        return r as HumanoidBone;
      }
    }
    return null;
  };
  const analysis: Partial<Record<HumanoidBone, RigBoneAnalysis>> = {};
  const defaultBones: Partial<Record<HumanoidBone, BoneSettings>> = {};
  const noKnee = { left: opts.pose === 'noKnee', right: opts.pose === 'noKnee' };
  for (const [roleStr, node] of Object.entries(bones)) {
    const role = roleStr as HumanoidBone;
    const pos = P[role]!;
    const q = new Quaternion();
    node!.matrixWorld.decompose(new Vector3(), q, new Vector3());
    const child = mappedChild(role);
    let target: Vector3 | null = child ? P[child]! : tail[role] ? tail[role]! : null;
    if (!target) target = pos.clone().add(new Vector3(0, 0.1, 0));
    const dirV = target.clone().sub(pos);
    const length = dirV.length();
    dirV.normalize();
    const up = estimateRestUp(role, P, tail);
    const isTorso = /^(hips|spine|chest|upperChest|neck|head)$/.test(role);
    let mode: BoneSettings['mode'] = isTorso ? 'relative' : 'auto';
    if ((role === 'leftUpperLeg' || role === 'rightUpperLeg') && opts.pose === 'noKnee') mode = 'follow';
    defaultBones[role] = { mode, rollOffsetDeg: 0 };
    analysis[role] = {
      name: node!.name,
      restDir: [dirV.x, dirV.y, dirV.z],
      restUp: up ? [up.x, up.y, up.z] : null,
      restQuat: [q.x, q.y, q.z, q.w],
      restPos: [pos.x, pos.y, pos.z],
      length,
      canonicalDeviationDeg: canonicalDeviationDeg(role, dirV),
      anatomical: isAnatomical(role, dirV),
      parentRole: mappedParent(role),
      childRole: child,
      intermediateCount: 0,
    };
  }
  const heightTable: HeightTable = {
    floor: 0,
    ankles: P.leftFoot!.y,
    knees: opts.pose === 'noKnee' ? P.leftUpperLeg!.y + 0.55 * (P.leftFoot!.y - P.leftUpperLeg!.y) : P.leftLowerLeg!.y,
    hips: P.hips!.y,
    shoulders: P.leftUpperArm!.y,
    eyes: P.head!.y + 0.1,
    headTop: tail.head!.y,
  };
  void J;
  void nodes;
  return {
    familyKey: 'test',
    instanceKey: 'test-' + opts.pose,
    displayName: 'test rig',
    family: 'unknown',
    map: Object.fromEntries(Object.entries(bones).map(([r, b]) => [r, b!.name])),
    confidence: {},
    warnings: [],
    axes: { up: [0, 1, 0], forward: [0, 0, 1], facingSource: 'assumed' },
    rootCorrection: [0, 0, 0, 1],
    scale: 1,
    sourceHeight: 1.72,
    analysis,
    heightTable,
    noKnee,
    noElbow: { left: false, right: false },
    hasForearmTwist: { left: false, right: false },
    defaultBones,
    boneCount: Object.keys(nodes).length,
    skinnedMeshCount: 0,
    unrigged: false,
  };
}

// ---------------------------------------------------------------------------
// FilteredPose from a synthetic PoseFrame
// ---------------------------------------------------------------------------

export interface FilteredOptions {
  /** Media time in seconds (defaults to frame.t / 1000). */
  t?: number;
  /** Per-landmark visibility overrides. */
  visibility?: Partial<Record<number, number>>;
  face?: Quaternion | null;
  present?: boolean;
  absentFor?: number;
  mirror?: boolean;
}

/**
 * Builds a FilteredPose from a raw PoseFrame: world (x, -y, -z), image as is,
 * inFrame with the 3 % margin, gated = in frame and visibility > 0.5,
 * confidence = visibility when gated else 0, hands/face null unless given.
 */
export function filteredFromFrame(frame: PoseFrame, opts: FilteredOptions = {}): FilteredPose {
  const world: Vector3[] = [];
  const image: Vector3[] = [];
  const visibility: number[] = [];
  const inFrame: boolean[] = [];
  const gated: boolean[] = [];
  const confidence: number[] = [];
  const present = opts.present ?? frame.pose !== null;
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    const w = frame.pose?.world[i] ?? [0, 0, 0, 0];
    const im = frame.pose?.image[i] ?? [0, 0, 0, 0];
    world.push(new Vector3(w[0], -w[1], -w[2]));
    image.push(new Vector3(im[0], im[1], im[2]));
    let vis = present ? Math.min(w[3], im[3]) : 0;
    const ov = opts.visibility?.[i];
    if (ov !== undefined) vis = Math.min(vis, ov);
    const inside = im[0] >= -0.03 && im[0] <= 1.03 && im[1] >= -0.03 && im[1] <= 1.03;
    const g = present && inside && vis > 0.5;
    visibility.push(vis);
    inFrame.push(inside);
    gated.push(g);
    confidence.push(g ? vis : 0);
  }
  return {
    t: opts.t ?? frame.t / 1000,
    now: NaN,
    present,
    absentFor: present ? 0 : (opts.absentFor ?? 0),
    reacquireRamp: 1,
    size: frame.size,
    mirror: opts.mirror ?? false,
    world,
    image,
    visibility,
    inFrame,
    gated,
    confidence,
    hands: { left: null, right: null },
    face: opts.face !== undefined ? (opts.face ? { blendshapes: {}, rotation: opts.face } : null) : null,
  };
}

/** World direction of a bone from three.js matrices (child world position minus bone world position). */
export function worldDirection(bone: Object3D, child: Object3D): Vector3 {
  const a = new Vector3();
  const b = new Vector3();
  bone.getWorldPosition(a);
  child.getWorldPosition(b);
  return b.sub(a).normalize();
}

/** The node whose position defines the tail of `role` in a built rig: the mapped child or the end marker. */
export function tailNode(rig: BuiltRig, role: HumanoidBone): Object3D | null {
  const a = rig.analysis.analysis[role];
  if (a?.childRole && rig.bones[a.childRole]) return rig.bones[a.childRole]!;
  return rig.tailOf[role] ?? null;
}

export function degrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Pipeline: BodyModel -> framing -> Retargeter on a built rig
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  hipsMode?: HipsMode;
  cameraVfovDeg?: number;
  depthTranslation?: boolean;
  settings?: SmoothingSettings;
}

export interface Pipeline {
  rig: BuiltRig;
  model: BodyModel;
  retargeter: Retargeter;
  fit: FramingFit | null;
  last: { result: BodyModelResult; solve: SolveResult; fit: FramingFit } | null;
  /** One frame: body model, framing fit and solve. */
  step(pose: FilteredPose, dt: number): { result: BodyModelResult; solve: SolveResult; fit: FramingFit };
  /** Repeats the same frame until the bones have converged (dt = 0.1 s x 30 by default). */
  converge(pose: FilteredPose, iterations?: number, dt?: number): { result: BodyModelResult; solve: SolveResult; fit: FramingFit };
}

/** The synthetic presets use a 60° vertical FOV camera. */
export const SYNTHETIC_VFOV_DEG = 60;

export function makePipeline(rig: BuiltRig, opts: PipelineOptions = {}): Pipeline {
  const settings = opts.settings ?? SMOOTHING;
  const model = new BodyModel(settings);
  const retargeter = new Retargeter({
    bones: rig.bones,
    analysis: rig.analysis,
    settings,
    boneSettings: rig.boneSettings,
    hipsMode: opts.hipsMode ?? 'horizontal',
    cameraVfovDeg: opts.cameraVfovDeg ?? SYNTHETIC_VFOV_DEG,
    depthTranslation: opts.depthTranslation ?? true,
  });
  const pipe: Pipeline = {
    rig,
    model,
    retargeter,
    fit: null,
    last: null,
    step(pose, dt) {
      const fit = fitFraming(pose, pipe.fit, dt);
      pipe.fit = fit;
      const result = model.update(pose, dt, {
        framing: fit.state,
        noKnee: rig.analysis.noKnee,
        noElbow: rig.analysis.noElbow,
        mirror: pose.mirror,
      });
      const solve = retargeter.solve(result, pose, dt, fit);
      pipe.last = { result, solve, fit };
      return pipe.last;
    },
    converge(pose, iterations = 30, dt = 0.1) {
      let out = pipe.step(pose, dt);
      for (let i = 1; i < iterations; i++) out = pipe.step(pose, dt);
      return out;
    },
  };
  return pipe;
}

/** Frames of a synthetic preset at evenly spaced times (fractions of its duration). */
export function presetFrames(name: string, fractions: readonly number[] = [0, 0.25, 0.5, 0.75]): PoseFrame[] {
  const preset = SYNTHETIC_PRESETS[name];
  if (!preset) throw new Error(`unknown preset ${name}`);
  return fractions.map((f) => {
    const t = f * preset.durationSec;
    const pose = preset.poseAt(t);
    const cam = preset.cameraAt ? preset.cameraAt(t) : preset.camera;
    return toPoseFrame(computeLandmarkPositions(pose), cam, Math.round(t * 1000), { visibilityOverride: pose.visibilityOverride });
  });
}

/**
 * Ground-truth measured directions per DESIGN §6.1 computed directly from
 * landmark positions (three.js coords), independent of the BodyModel.
 */
export function groundTruthDirections(P: Vector3[]): Partial<Record<HumanoidBone, Vector3>> {
  const mid = (a: number, b: number) => P[a].clone().add(P[b]).multiplyScalar(0.5);
  const dir = (a: Vector3, b: Vector3) => b.clone().sub(a).normalize();
  const midHip = mid(LM.LEFT_HIP, LM.RIGHT_HIP);
  const midShoulder = mid(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  const midEar = mid(LM.LEFT_EAR, LM.RIGHT_EAR);
  const midEye = mid(LM.LEFT_EYE, LM.RIGHT_EYE);
  const earAxis = P[LM.RIGHT_EAR].clone().sub(P[LM.LEFT_EAR]).normalize();
  const fwd = perpendicularComponent(midEye.clone().sub(midEar), earAxis)!;
  const out: Partial<Record<HumanoidBone, Vector3>> = {
    hips: dir(midHip, midShoulder),
    neck: dir(midShoulder, midEar),
    head: new Vector3().crossVectors(earAxis, fwd).normalize(),
  };
  for (const side of ['left', 'right'] as const) {
    const L = side === 'left';
    const S = (l: number, r: number) => (L ? l : r);
    const shoulder = P[S(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER)];
    const elbow = P[S(LM.LEFT_ELBOW, LM.RIGHT_ELBOW)];
    const wrist = P[S(LM.LEFT_WRIST, LM.RIGHT_WRIST)];
    const index = P[S(LM.LEFT_INDEX, LM.RIGHT_INDEX)];
    const pinky = P[S(LM.LEFT_PINKY, LM.RIGHT_PINKY)];
    const hip = P[S(LM.LEFT_HIP, LM.RIGHT_HIP)];
    const knee = P[S(LM.LEFT_KNEE, LM.RIGHT_KNEE)];
    const ankle = P[S(LM.LEFT_ANKLE, LM.RIGHT_ANKLE)];
    const heel = P[S(LM.LEFT_HEEL, LM.RIGHT_HEEL)];
    const foot = P[S(LM.LEFT_FOOT_INDEX, LM.RIGHT_FOOT_INDEX)];
    out[`${side}Shoulder`] = dir(midShoulder, shoulder);
    out[`${side}UpperArm`] = dir(shoulder, elbow);
    out[`${side}LowerArm`] = dir(elbow, wrist);
    out[`${side}Hand`] = dir(wrist, index.clone().add(pinky).multiplyScalar(0.5));
    out[`${side}UpperLeg`] = dir(hip, knee);
    out[`${side}LowerLeg`] = dir(knee, ankle);
    out[`${side}Foot`] = dir(ankle, foot);
    const toes = foot.clone().sub(heel);
    toes.y = 0;
    out[`${side}Toes`] = toes.normalize();
  }
  return out;
}

/** World rotation of a bone relative to its bind world rotation (the solver's world delta). */
export function worldDelta(rig: BuiltRig, role: HumanoidBone, out = new Quaternion()): Quaternion {
  const bone = rig.bones[role]!;
  const rest = new Quaternion().fromArray(rig.analysis.analysis[role]!.restQuat);
  bone.getWorldQuaternion(out);
  return out.multiply(rest.invert());
}

/** Yaw (degrees) of a bone's forward axis: the bind +Z rotated by the world delta, projected on the ground plane. */
export function forwardYawDeg(rig: BuiltRig, role: HumanoidBone): number {
  const f = new Vector3(0, 0, 1).applyQuaternion(worldDelta(rig, role));
  return degrees(Math.atan2(f.x, f.z));
}

export function assertFinite(rig: BuiltRig): void {
  for (const node of Object.values(rig.nodes)) {
    const q = node.quaternion;
    const p = node.position;
    for (const v of [q.x, q.y, q.z, q.w, p.x, p.y, p.z]) if (!Number.isFinite(v)) throw new Error(`${node.name} is not finite`);
    if (Math.abs(q.length() - 1) > 1e-4) throw new Error(`${node.name} quaternion is not unit (${q.length()})`);
  }
}

/** Tiny deterministic PRNG for jitter tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
