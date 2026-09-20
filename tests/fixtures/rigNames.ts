/**
 * Name / hierarchy fixtures for the auto-mapper tests (docs/DESIGN.md §13):
 * a T-pose fixture builder that turns parent lists into a bind-pose
 * {@link SkeletonGraph} (and optionally a three.js Bone tree), with positions
 * taken from a canonical T-pose template per humanoid role. Helper bones
 * (twists, correctives, markers, IK) are placed with a small DSL:
 *
 *   'leftUpperArm'                      – the template position of a role / key
 *   'leftUpperArm>leftLowerArm@0.5'     – interpolation between two keys
 *   'hips+0,-0.02,0'                    – offset from a key
 *   [x, y, z]                           – explicit position
 *
 * Every fixture records the expected humanoid map next to the bones.
 */
import { Bone, Object3D, Quaternion, Vector3 } from 'three';
import type { HumanoidBone, HumanoidMap, Vec3Tuple } from '../../src/core/types';
import { finalizeGraph, type SkeletonGraph, type SkeletonNode } from '../../src/rig/skeletonGraph';

export type Position = Vec3Tuple | string;

export interface FixtureBone {
  name: string;
  parent: string | null;
  /** Position key or explicit position (defaults to the role's template position). */
  at?: Position;
  /** Expected humanoid role of this bone (also its default position). */
  role?: HumanoidBone;
  /** Summed skin weight (default 1; 0 for markers and unweighted helpers). */
  weight?: number;
  /** Whether the node is a skin joint (default true; false for armature/empties). */
  joint?: boolean;
}

export interface RigFixture {
  name: string;
  bones: FixtureBone[];
  expect: HumanoidMap;
  /** Names that must never appear in the map (helpers, markers, controls). */
  helpers: string[];
}

// ---------------------------------------------------------------------------
// Canonical T-pose template (meters, Y up, facing +Z, left at +X)
// ---------------------------------------------------------------------------

const T: Record<string, Vec3Tuple> = {
  root: [0, 0, 0],
  hips: [0, 0.95, 0],
  spine: [0, 1.05, 0],
  chest: [0, 1.2, 0],
  upperChest: [0, 1.32, 0],
  neck: [0, 1.45, 0],
  head: [0, 1.55, 0],
  headTop: [0, 1.72, 0],
  headFront: [0, 1.55, 0.1],
  jaw: [0, 1.56, 0.05],
};
function sided(role: string, s: number, p: Vec3Tuple): void {
  T[role] = [s * p[0], p[1], p[2]];
}
const DIGITS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
for (const side of ['left', 'right'] as const) {
  const s = side === 'left' ? 1 : -1;
  sided(`${side}Eye`, s, [0.03, 1.62, 0.08]);
  sided(`${side}Shoulder`, s, [0.04, 1.42, 0]);
  sided(`${side}UpperArm`, s, [0.18, 1.42, 0]);
  sided(`${side}LowerArm`, s, [0.46, 1.42, 0]);
  sided(`${side}Hand`, s, [0.72, 1.42, 0]);
  sided(`${side}HandTail`, s, [0.9, 1.42, 0]);
  DIGITS.forEach((d, k) => {
    const z = 0.04 - 0.02 * k;
    if (d === 'Thumb') {
      sided(`${side}ThumbMetacarpal`, s, [0.74, 1.41, 0.03]);
      sided(`${side}ThumbProximal`, s, [0.78, 1.4, 0.06]);
      sided(`${side}ThumbDistal`, s, [0.81, 1.39, 0.08]);
      sided(`${side}ThumbTip`, s, [0.84, 1.38, 0.1]);
    } else {
      sided(`${side}${d}Metacarpal`, s, [0.76, 1.42, z]);
      sided(`${side}${d}Proximal`, s, [0.8, 1.42, z]);
      sided(`${side}${d}Intermediate`, s, [0.84, 1.42, z]);
      sided(`${side}${d}Distal`, s, [0.88, 1.42, z]);
      sided(`${side}${d}Tip`, s, [0.91, 1.42, z]);
    }
  });
  sided(`${side}UpperLeg`, s, [0.1, 0.9, 0]);
  sided(`${side}LowerLeg`, s, [0.1, 0.48, 0]);
  sided(`${side}Foot`, s, [0.1, 0.08, 0]);
  sided(`${side}Toes`, s, [0.1, 0.02, 0.12]);
  sided(`${side}ToesTail`, s, [0.1, 0.02, 0.2]);
  sided(`${side}Heel`, s, [0.1, 0.0, -0.05]);
}
export const TEMPLATE: Readonly<Record<string, Vec3Tuple>> = T;

export function resolvePosition(at: Position): Vec3Tuple {
  if (Array.isArray(at)) return [at[0], at[1], at[2]];
  const lerp = /^([A-Za-z0-9]+)>([A-Za-z0-9]+)@([0-9.]+)$/.exec(at);
  if (lerp) {
    const a = resolvePosition(lerp[1]);
    const b = resolvePosition(lerp[2]);
    const t = parseFloat(lerp[3]);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  const off = /^([A-Za-z0-9]+)\+(-?[0-9.]+),(-?[0-9.]+),(-?[0-9.]+)$/.exec(at);
  if (off) {
    const a = resolvePosition(off[1]);
    return [a[0] + parseFloat(off[2]), a[1] + parseFloat(off[3]), a[2] + parseFloat(off[4])];
  }
  const p = T[at];
  if (!p) throw new Error(`Unknown template position '${at}'`);
  return [p[0], p[1], p[2]];
}

export interface BuildOptions {
  /** Applied to every position (e.g. a rotation into a Z-up or -Z-facing frame). */
  transform?: (v: Vector3) => Vector3;
  /** Report skin weights (default true). */
  weights?: boolean;
}

function positionOf(b: FixtureBone, opts: BuildOptions): Vec3Tuple {
  const p = resolvePosition(b.at ?? (b.role as string));
  if (!opts.transform) return p;
  const v = opts.transform(new Vector3(p[0], p[1], p[2]));
  return [v.x, v.y, v.z];
}

/** Parent-first order of the bones (a fixture may list children before parents). */
function ordered(bones: FixtureBone[]): FixtureBone[] {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const out: FixtureBone[] = [];
  const seen = new Set<string>();
  const visit = (b: FixtureBone): void => {
    if (seen.has(b.name)) return;
    if (b.parent) {
      const p = byName.get(b.parent);
      if (!p) throw new Error(`Fixture bone '${b.name}' has unknown parent '${b.parent}'`);
      visit(p);
    }
    seen.add(b.name);
    out.push(b);
  };
  for (const b of bones) visit(b);
  return out;
}

/** Builds the bind-pose graph of a fixture. */
export function buildFixtureGraph(bones: FixtureBone[], opts: BuildOptions = {}): SkeletonGraph {
  const list = ordered(bones);
  const index = new Map<string, number>();
  list.forEach((b, i) => index.set(b.name, i));
  const nodes: SkeletonNode[] = list.map((b, i) => ({
    index: i,
    name: b.name,
    parent: b.parent ? index.get(b.parent)! : -1,
    children: [],
    restPos: positionOf(b, opts),
    restQuat: [0, 0, 0, 1],
    isJoint: b.joint !== false,
    weight: opts.weights === false ? (b.joint !== false ? 1 : 0) : (b.weight ?? (b.joint !== false ? 1 : 0)),
  }));
  const graph = finalizeGraph(nodes);
  graph.hasSkinWeights = opts.weights !== false;
  graph.skinnedMeshCount = 1;
  return graph;
}

/** Builds a three.js tree (Bones for joints, Object3Ds for empties) with the fixture's world positions. */
export function buildFixtureObject(bones: FixtureBone[], opts: BuildOptions = {}): { root: Object3D; nodes: Map<string, Object3D> } {
  const root = new Object3D();
  root.name = 'FixtureRoot';
  const nodes = new Map<string, Object3D>();
  const world = new Map<string, Vector3>();
  for (const b of ordered(bones)) {
    const p = positionOf(b, opts);
    const node = b.joint === false ? new Object3D() : new Bone();
    node.name = b.name;
    const wp = new Vector3(p[0], p[1], p[2]);
    const parentPos = b.parent ? world.get(b.parent)! : new Vector3();
    node.position.copy(wp).sub(parentPos);
    node.quaternion.copy(new Quaternion());
    (b.parent ? nodes.get(b.parent)! : root).add(node);
    nodes.set(b.name, node);
    world.set(b.name, wp);
  }
  root.updateMatrixWorld(true);
  return { root, nodes };
}

// ---------------------------------------------------------------------------
// Fixture builder helper
// ---------------------------------------------------------------------------

class Fx {
  bones: FixtureBone[] = [];
  expect: HumanoidMap = {};
  helpers: string[] = [];
  constructor(public name: string) {}
  /** A role bone (positioned by its role, recorded in the expected map). */
  role(name: string, parent: string | null, role: HumanoidBone, extra: Partial<FixtureBone> = {}): this {
    this.bones.push({ name, parent, role, ...extra });
    this.expect[role] = name;
    return this;
  }
  /** A helper / marker / control bone that must stay unmapped. */
  helper(name: string, parent: string | null, at: Position, extra: Partial<FixtureBone> = {}): this {
    this.bones.push({ name, parent, at, ...extra });
    this.helpers.push(name);
    return this;
  }
  /** An unmapped intermediate that is a real bone (not asserted absent from the map). */
  node(name: string, parent: string | null, at: Position, extra: Partial<FixtureBone> = {}): this {
    this.bones.push({ name, parent, at, ...extra });
    return this;
  }
  done(): RigFixture {
    return { name: this.name, bones: this.bones, expect: this.expect, helpers: this.helpers };
  }
}

type SideKey = 'left' | 'right';
const SIDES: SideKey[] = ['left', 'right'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Mixamo (prefixed / colon-less / unprefixed) and Ready Player Me
// ---------------------------------------------------------------------------

export interface MixamoOptions {
  prefix: string;
  /** Include *_End markers and finger tips (Thumb4...) (65-bone Mixamo export). */
  ends?: boolean;
  fingers?: boolean;
  eyes?: boolean;
  /** Non-joint Armature root above the hips. */
  armature?: boolean;
}

export function mixamoFixture(name: string, o: MixamoOptions): RigFixture {
  const P = o.prefix;
  const f = new Fx(name);
  let hipsParent: string | null = null;
  if (o.armature) {
    f.node('Armature', null, 'root', { joint: false, weight: 0 });
    hipsParent = 'Armature';
  }
  f.role(`${P}Hips`, hipsParent, 'hips');
  f.role(`${P}Spine`, `${P}Hips`, 'spine');
  f.role(`${P}Spine1`, `${P}Spine`, 'chest');
  f.role(`${P}Spine2`, `${P}Spine1`, 'upperChest');
  f.role(`${P}Neck`, `${P}Spine2`, 'neck');
  f.role(`${P}Head`, `${P}Neck`, 'head');
  if (o.ends) f.helper(`${P}HeadTop_End`, `${P}Head`, 'headTop', { weight: 0 });
  if (o.eyes) {
    f.role(`${P}LeftEye`, `${P}Head`, 'leftEye');
    f.role(`${P}RightEye`, `${P}Head`, 'rightEye');
  }
  for (const side of SIDES) {
    const S = cap(side);
    f.role(`${P}${S}Shoulder`, `${P}Spine2`, `${side}Shoulder`);
    f.role(`${P}${S}Arm`, `${P}${S}Shoulder`, `${side}UpperArm`);
    f.role(`${P}${S}ForeArm`, `${P}${S}Arm`, `${side}LowerArm`);
    f.role(`${P}${S}Hand`, `${P}${S}ForeArm`, `${side}Hand`);
    if (o.fingers) {
      const digits: [string, (typeof DIGITS)[number]][] = [
        ['Thumb', 'Thumb'],
        ['Index', 'Index'],
        ['Middle', 'Middle'],
        ['Ring', 'Ring'],
        ['Pinky', 'Little'],
      ];
      for (const [mx, d] of digits) {
        const segs: string[] = d === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
        let parent = `${P}${S}Hand`;
        segs.forEach((seg, k) => {
          const n = `${P}${S}Hand${mx}${k + 1}`;
          f.role(n, parent, `${side}${d}${seg}` as HumanoidBone);
          parent = n;
        });
        if (o.ends) f.helper(`${P}${S}Hand${mx}4`, parent, `${side}${d}Tip`, { weight: 0 });
      }
    }
    f.role(`${P}${S}UpLeg`, `${P}Hips`, `${side}UpperLeg`);
    f.role(`${P}${S}Leg`, `${P}${S}UpLeg`, `${side}LowerLeg`);
    f.role(`${P}${S}Foot`, `${P}${S}Leg`, `${side}Foot`);
    f.role(`${P}${S}ToeBase`, `${P}${S}Foot`, `${side}Toes`);
    if (o.ends) f.helper(`${P}${S}Toe_End`, `${P}${S}ToeBase`, `${side}ToesTail`, { weight: 0 });
  }
  return f.done();
}

export const MIXAMO_PREFIXED = mixamoFixture('mixamo (mixamorig: prefix, 65 bones)', { prefix: 'mixamorig:', ends: true, fingers: true });
export const MIXAMO_FBX = mixamoFixture('mixamo (colon-less FBX form)', { prefix: 'mixamorig', ends: true, fingers: true });
export const READY_PLAYER_ME = mixamoFixture('Ready Player Me', { prefix: '', fingers: true, eyes: true, armature: true });

// ---------------------------------------------------------------------------
// Meshy sample names
// ---------------------------------------------------------------------------

export const MESHY = ((): RigFixture => {
  const f = new Fx('Meshy sample names');
  f.node('BaseArmature', null, 'root', { joint: false, weight: 0 });
  f.role('Hips', 'BaseArmature', 'hips');
  f.role('Spine02', 'Hips', 'spine');
  f.role('Spine01', 'Spine02', 'chest');
  f.role('Spine', 'Spine01', 'upperChest');
  f.role('neck', 'Spine', 'neck');
  f.role('Head', 'neck', 'head');
  f.helper('head_end', 'Head', 'headTop', { weight: 0 });
  f.helper('headfront', 'Head', 'headFront', { weight: 0 });
  for (const side of SIDES) {
    const S = cap(side);
    f.role(`${S}Shoulder`, 'Spine', `${side}Shoulder`);
    f.role(`${S}Arm`, `${S}Shoulder`, `${side}UpperArm`);
    f.role(`${S}ForeArm`, `${S}Arm`, `${side}LowerArm`);
    f.role(`${S}Hand`, `${S}ForeArm`, `${side}Hand`);
    f.role(`${S}UpLeg`, 'Hips', `${side}UpperLeg`);
    f.role(`${S}Leg`, `${S}UpLeg`, `${side}LowerLeg`);
    f.role(`${S}Foot`, `${S}Leg`, `${side}Foot`);
    f.role(`${S}ToeBase`, `${S}Foot`, `${side}Toes`);
  }
  return f.done();
})();

// ---------------------------------------------------------------------------
// UE5 Mannequin
// ---------------------------------------------------------------------------

export const UE5_MANNEQUIN = ((): RigFixture => {
  const f = new Fx('UE5 Mannequin');
  f.node('root', null, 'root', { weight: 0 });
  f.role('pelvis', 'root', 'hips');
  f.role('spine_01', 'pelvis', 'spine', { at: 'hips>upperChest@0.2' });
  f.node('spine_02', 'spine_01', 'hips>upperChest@0.4');
  f.role('spine_03', 'spine_02', 'chest', { at: 'hips>upperChest@0.6' });
  f.node('spine_04', 'spine_03', 'hips>upperChest@0.8');
  f.helper('spine_04_latissimus_l', 'spine_04', 'chest+0.12,0.04,-0.05');
  f.helper('spine_04_latissimus_r', 'spine_04', 'chest+-0.12,0.04,-0.05');
  f.role('spine_05', 'spine_04', 'upperChest');
  f.role('neck_01', 'spine_05', 'neck');
  f.node('neck_02', 'neck_01', 'neck>head@0.5');
  f.role('head', 'neck_02', 'head');
  for (const side of SIDES) {
    const s = side === 'left' ? 'l' : 'r';
    f.role(`clavicle_${s}`, 'spine_05', `${side}Shoulder`);
    f.helper(`clavicle_out_${s}`, `clavicle_${s}`, `${side}Shoulder+0,0.03,-0.03`);
    f.helper(`clavicle_scap_${s}`, `clavicle_${s}`, `${side}Shoulder+0,-0.03,-0.06`);
    f.helper(`clavicle_pec_${s}`, `clavicle_${s}`, `${side}Shoulder+0,-0.05,0.06`);
    f.role(`upperarm_${s}`, `clavicle_${s}`, `${side}UpperArm`);
    f.helper(`upperarm_twist_01_${s}`, `upperarm_${s}`, `${side}UpperArm>${side}LowerArm@0.33`);
    f.helper(`upperarm_twist_02_${s}`, `upperarm_${s}`, `${side}UpperArm>${side}LowerArm@0.66`);
    f.helper(`upperarm_correctiveRoot_${s}`, `upperarm_${s}`, `${side}UpperArm+0,0,0.001`);
    f.helper(`upperarm_bicep_${s}`, `upperarm_correctiveRoot_${s}`, `${side}UpperArm>${side}LowerArm@0.5`, { at: `${side}UpperArm+0.14,0,0.05` });
    f.helper(`upperarm_tricep_${s}`, `upperarm_correctiveRoot_${s}`, `${side}UpperArm+0.14,0,-0.05`);
    f.helper(`upperarm_out_${s}`, `upperarm_correctiveRoot_${s}`, `${side}UpperArm+0.02,0.05,0`);
    f.helper(`upperarm_in_${s}`, `upperarm_correctiveRoot_${s}`, `${side}UpperArm+0.02,-0.05,0`);
    f.helper(`upperarm_fwd_${s}`, `upperarm_correctiveRoot_${s}`, `${side}UpperArm+0.02,0,0.05`);
    f.helper(`upperarm_bck_${s}`, `upperarm_correctiveRoot_${s}`, `${side}UpperArm+0.02,0,-0.05`);
    f.role(`lowerarm_${s}`, `upperarm_${s}`, `${side}LowerArm`);
    f.helper(`lowerarm_twist_01_${s}`, `lowerarm_${s}`, `${side}LowerArm>${side}Hand@0.33`);
    f.helper(`lowerarm_twist_02_${s}`, `lowerarm_${s}`, `${side}LowerArm>${side}Hand@0.66`);
    f.helper(`lowerarm_correctiveRoot_${s}`, `lowerarm_${s}`, `${side}LowerArm+0,0,0.001`);
    f.helper(`lowerarm_out_${s}`, `lowerarm_correctiveRoot_${s}`, `${side}LowerArm+0.02,0.04,0`);
    f.helper(`lowerarm_in_${s}`, `lowerarm_correctiveRoot_${s}`, `${side}LowerArm+0.02,-0.04,0`);
    f.helper(`lowerarm_fwd_${s}`, `lowerarm_correctiveRoot_${s}`, `${side}LowerArm+0.02,0,0.04`);
    f.helper(`lowerarm_bck_${s}`, `lowerarm_correctiveRoot_${s}`, `${side}LowerArm+0.02,0,-0.04`);
    f.role(`hand_${s}`, `lowerarm_${s}`, `${side}Hand`);
    f.helper(`wrist_inner_${s}`, `hand_${s}`, `${side}Hand+0,-0.02,0.02`);
    f.helper(`wrist_outer_${s}`, `hand_${s}`, `${side}Hand+0,0.02,-0.02`);
    const digits: [string, (typeof DIGITS)[number]][] = [
      ['index', 'Index'],
      ['middle', 'Middle'],
      ['ring', 'Ring'],
      ['pinky', 'Little'],
    ];
    f.role(`thumb_01_${s}`, `hand_${s}`, `${side}ThumbMetacarpal`);
    f.role(`thumb_02_${s}`, `thumb_01_${s}`, `${side}ThumbProximal`);
    f.role(`thumb_03_${s}`, `thumb_02_${s}`, `${side}ThumbDistal`);
    for (const [ue, d] of digits) {
      f.node(`${ue}_metacarpal_${s}`, `hand_${s}`, `${side}${d}Metacarpal`);
      f.role(`${ue}_01_${s}`, `${ue}_metacarpal_${s}`, `${side}${d}Proximal`);
      f.role(`${ue}_02_${s}`, `${ue}_01_${s}`, `${side}${d}Intermediate` as HumanoidBone);
      f.role(`${ue}_03_${s}`, `${ue}_02_${s}`, `${side}${d}Distal`);
    }
    f.role(`thigh_${s}`, 'pelvis', `${side}UpperLeg`);
    f.helper(`thigh_twist_01_${s}`, `thigh_${s}`, `${side}UpperLeg>${side}LowerLeg@0.33`);
    f.helper(`thigh_twist_02_${s}`, `thigh_${s}`, `${side}UpperLeg>${side}LowerLeg@0.66`);
    f.helper(`thigh_correctiveRoot_${s}`, `thigh_${s}`, `${side}UpperLeg+0,-0.001,0`);
    f.helper(`thigh_fwd_${s}`, `thigh_correctiveRoot_${s}`, `${side}UpperLeg+0,-0.05,0.06`);
    f.helper(`thigh_bck_${s}`, `thigh_correctiveRoot_${s}`, `${side}UpperLeg+0,-0.05,-0.06`);
    f.helper(`thigh_out_${s}`, `thigh_correctiveRoot_${s}`, `${side}UpperLeg+0.06,-0.05,0`);
    f.helper(`thigh_in_${s}`, `thigh_correctiveRoot_${s}`, `${side}UpperLeg+-0.06,-0.05,0`);
    f.role(`calf_${s}`, `thigh_${s}`, `${side}LowerLeg`);
    f.helper(`calf_twist_01_${s}`, `calf_${s}`, `${side}LowerLeg>${side}Foot@0.33`);
    f.helper(`calf_twist_02_${s}`, `calf_${s}`, `${side}LowerLeg>${side}Foot@0.66`);
    f.helper(`calf_correctiveRoot_${s}`, `calf_${s}`, `${side}LowerLeg+0,-0.001,0`);
    f.helper(`calf_knee_${s}`, `calf_correctiveRoot_${s}`, `${side}LowerLeg+0,0,0.06`);
    f.helper(`calf_kneeBack_${s}`, `calf_correctiveRoot_${s}`, `${side}LowerLeg+0,0,-0.06`);
    f.role(`foot_${s}`, `calf_${s}`, `${side}Foot`);
    f.helper(`ankle_fwd_${s}`, `foot_${s}`, `${side}Foot+0,0,0.05`);
    f.helper(`ankle_bck_${s}`, `foot_${s}`, `${side}Foot+0,0,-0.05`);
    f.role(`ball_${s}`, `foot_${s}`, `${side}Toes`);
  }
  f.helper('ik_foot_root', 'root', 'root', { weight: 0 });
  f.helper('ik_foot_l', 'ik_foot_root', 'leftFoot', { weight: 0 });
  f.helper('ik_foot_r', 'ik_foot_root', 'rightFoot', { weight: 0 });
  f.helper('ik_hand_root', 'root', 'root', { weight: 0 });
  f.helper('ik_hand_gun', 'ik_hand_root', 'rightHand', { weight: 0 });
  f.helper('ik_hand_l', 'ik_hand_gun', 'leftHand', { weight: 0 });
  f.helper('ik_hand_r', 'ik_hand_gun', 'rightHand', { weight: 0 });
  f.helper('interaction', 'root', 'root', { weight: 0 });
  f.helper('center_of_mass', 'root', 'hips', { weight: 0 });
  return f.done();
})();

// ---------------------------------------------------------------------------
// Rigify (DEF-only, full) and the Blender metarig
// ---------------------------------------------------------------------------

function rigifyDef(f: Fx, parentOfSpine: string | null): void {
  f.role('DEF-spine', parentOfSpine, 'hips');
  f.role('DEF-spine.001', 'DEF-spine', 'spine');
  f.role('DEF-spine.002', 'DEF-spine.001', 'chest');
  f.role('DEF-spine.003', 'DEF-spine.002', 'upperChest');
  f.role('DEF-spine.004', 'DEF-spine.003', 'neck');
  f.node('DEF-spine.005', 'DEF-spine.004', 'neck>head@0.5');
  f.role('DEF-spine.006', 'DEF-spine.005', 'head');
  f.role('DEF-jaw', 'DEF-spine.006', 'jaw');
  for (const side of SIDES) {
    const L = side === 'left' ? 'L' : 'R';
    f.helper(`DEF-pelvis.${L}`, 'DEF-spine', `hips+${side === 'left' ? 0.08 : -0.08},0.02,0`);
    f.helper(`DEF-breast.${L}`, 'DEF-spine.003', `upperChest+${side === 'left' ? 0.1 : -0.1},-0.05,0.1`);
    f.role(`DEF-eye.${L}`, 'DEF-spine.006', `${side}Eye`);
    f.role(`DEF-shoulder.${L}`, 'DEF-spine.003', `${side}Shoulder`);
    f.role(`DEF-upper_arm.${L}`, `DEF-shoulder.${L}`, `${side}UpperArm`);
    f.helper(`DEF-upper_arm.${L}.001`, `DEF-upper_arm.${L}`, `${side}UpperArm>${side}LowerArm@0.5`);
    f.role(`DEF-forearm.${L}`, `DEF-upper_arm.${L}.001`, `${side}LowerArm`);
    f.helper(`DEF-forearm.${L}.001`, `DEF-forearm.${L}`, `${side}LowerArm>${side}Hand@0.5`);
    f.role(`DEF-hand.${L}`, `DEF-forearm.${L}.001`, `${side}Hand`);
    f.role(`DEF-thumb.01.${L}`, `DEF-hand.${L}`, `${side}ThumbMetacarpal`);
    f.role(`DEF-thumb.02.${L}`, `DEF-thumb.01.${L}`, `${side}ThumbProximal`);
    f.role(`DEF-thumb.03.${L}`, `DEF-thumb.02.${L}`, `${side}ThumbDistal`);
    const digits: [string, string, (typeof DIGITS)[number]][] = [
      ['01', 'index', 'Index'],
      ['02', 'middle', 'Middle'],
      ['03', 'ring', 'Ring'],
      ['04', 'pinky', 'Little'],
    ];
    for (const [palm, fn, d] of digits) {
      f.node(`DEF-palm.${palm}.${L}`, `DEF-hand.${L}`, `${side}${d}Metacarpal`);
      f.role(`DEF-f_${fn}.01.${L}`, `DEF-palm.${palm}.${L}`, `${side}${d}Proximal`);
      f.role(`DEF-f_${fn}.02.${L}`, `DEF-f_${fn}.01.${L}`, `${side}${d}Intermediate` as HumanoidBone);
      f.role(`DEF-f_${fn}.03.${L}`, `DEF-f_${fn}.02.${L}`, `${side}${d}Distal`);
    }
    f.role(`DEF-thigh.${L}`, 'DEF-spine', `${side}UpperLeg`);
    f.helper(`DEF-thigh.${L}.001`, `DEF-thigh.${L}`, `${side}UpperLeg>${side}LowerLeg@0.5`);
    f.role(`DEF-shin.${L}`, `DEF-thigh.${L}.001`, `${side}LowerLeg`);
    f.helper(`DEF-shin.${L}.001`, `DEF-shin.${L}`, `${side}LowerLeg>${side}Foot@0.5`);
    f.role(`DEF-foot.${L}`, `DEF-shin.${L}.001`, `${side}Foot`);
    f.role(`DEF-toe.${L}`, `DEF-foot.${L}`, `${side}Toes`);
    f.helper(`heel.02.${L}`, `DEF-foot.${L}`, `${side}Heel`, { weight: 0 });
  }
}

export const RIGIFY_DEF = ((): RigFixture => {
  const f = new Fx('Rigify DEF-only');
  f.node('root', null, 'root', { joint: false, weight: 0 });
  rigifyDef(f, 'root');
  return f.done();
})();

export const RIGIFY_FULL = ((): RigFixture => {
  const f = new Fx('Rigify full (DEF + ORG + MCH + controls)');
  f.node('root', null, 'root', { weight: 0 });
  rigifyDef(f, 'root');
  // ORG- duplicates of the deform hierarchy (zero weight, same positions).
  f.helper('ORG-spine', 'root', 'hips', { weight: 0 });
  f.helper('ORG-spine.001', 'ORG-spine', 'spine', { weight: 0 });
  f.helper('ORG-spine.002', 'ORG-spine.001', 'chest', { weight: 0 });
  f.helper('ORG-spine.003', 'ORG-spine.002', 'upperChest', { weight: 0 });
  f.helper('ORG-spine.004', 'ORG-spine.003', 'neck', { weight: 0 });
  f.helper('ORG-spine.006', 'ORG-spine.004', 'head', { weight: 0 });
  for (const side of SIDES) {
    const L = side === 'left' ? 'L' : 'R';
    f.helper(`ORG-shoulder.${L}`, 'ORG-spine.003', `${side}Shoulder`, { weight: 0 });
    f.helper(`ORG-upper_arm.${L}`, `ORG-shoulder.${L}`, `${side}UpperArm`, { weight: 0 });
    f.helper(`ORG-forearm.${L}`, `ORG-upper_arm.${L}`, `${side}LowerArm`, { weight: 0 });
    f.helper(`ORG-hand.${L}`, `ORG-forearm.${L}`, `${side}Hand`, { weight: 0 });
    f.helper(`ORG-thigh.${L}`, 'ORG-spine', `${side}UpperLeg`, { weight: 0 });
    f.helper(`ORG-shin.${L}`, `ORG-thigh.${L}`, `${side}LowerLeg`, { weight: 0 });
    f.helper(`ORG-foot.${L}`, `ORG-shin.${L}`, `${side}Foot`, { weight: 0 });
    f.helper(`ORG-toe.${L}`, `ORG-foot.${L}`, `${side}Toes`, { weight: 0 });
    // Controls and mechanism bones.
    f.helper(`MCH-thigh_ik.${L}`, 'root', `${side}UpperLeg`, { weight: 0 });
    f.helper(`MCH-shin_ik.${L}`, `MCH-thigh_ik.${L}`, `${side}LowerLeg`, { weight: 0 });
    f.helper(`foot_ik.${L}`, 'root', `${side}Foot`, { weight: 0 });
    f.helper(`thigh_fk.${L}`, 'root', `${side}UpperLeg`, { weight: 0 });
    f.helper(`shin_fk.${L}`, `thigh_fk.${L}`, `${side}LowerLeg`, { weight: 0 });
    f.helper(`hand_ik.${L}`, 'root', `${side}Hand`, { weight: 0 });
    f.helper(`upper_arm_fk.${L}`, 'root', `${side}UpperArm`, { weight: 0 });
    f.helper(`forearm_fk.${L}`, `upper_arm_fk.${L}`, `${side}LowerArm`, { weight: 0 });
    f.helper(`shoulder.${L}`, 'root', `${side}Shoulder`, { weight: 0 });
    f.helper(`upper_arm_ik_target.${L}`, 'root', `${side}LowerArm+0,0,-0.4`, { weight: 0 });
  }
  f.helper('torso', 'root', 'hips', { weight: 0 });
  f.helper('hips', 'torso', 'hips', { weight: 0 });
  f.helper('chest', 'torso', 'chest', { weight: 0 });
  f.helper('neck', 'torso', 'neck', { weight: 0 });
  f.helper('head', 'torso', 'head', { weight: 0 });
  f.helper('MCH-torso.parent', 'root', 'hips', { weight: 0 });
  f.helper('tweak_spine', 'MCH-torso.parent', 'spine', { weight: 0 });
  return f.done();
})();

export const BLENDER_METARIG = ((): RigFixture => {
  const f = new Fx('Blender metarig');
  f.role('spine', null, 'hips');
  f.role('spine.001', 'spine', 'spine');
  f.role('spine.002', 'spine.001', 'chest');
  f.role('spine.003', 'spine.002', 'upperChest');
  f.role('spine.004', 'spine.003', 'neck');
  f.node('spine.005', 'spine.004', 'neck>head@0.5');
  f.role('spine.006', 'spine.005', 'head');
  f.node('face', 'spine.006', 'headFront');
  f.node('nose', 'face', 'headFront+0,0.02,0.02');
  f.role('jaw', 'face', 'jaw');
  for (const side of SIDES) {
    const L = side === 'left' ? 'L' : 'R';
    f.role(`eye.${L}`, 'face', `${side}Eye`);
    f.helper(`pelvis.${L}`, 'spine', `hips+${side === 'left' ? 0.08 : -0.08},0.02,0`);
    f.helper(`breast.${L}`, 'spine.003', `upperChest+${side === 'left' ? 0.1 : -0.1},-0.05,0.1`);
    f.role(`shoulder.${L}`, 'spine.003', `${side}Shoulder`);
    f.role(`upper_arm.${L}`, `shoulder.${L}`, `${side}UpperArm`);
    f.role(`forearm.${L}`, `upper_arm.${L}`, `${side}LowerArm`);
    f.role(`hand.${L}`, `forearm.${L}`, `${side}Hand`);
    f.role(`thumb.01.${L}`, `hand.${L}`, `${side}ThumbMetacarpal`);
    f.role(`thumb.02.${L}`, `thumb.01.${L}`, `${side}ThumbProximal`);
    f.role(`thumb.03.${L}`, `thumb.02.${L}`, `${side}ThumbDistal`);
    const digits: [string, string, (typeof DIGITS)[number]][] = [
      ['01', 'index', 'Index'],
      ['02', 'middle', 'Middle'],
      ['03', 'ring', 'Ring'],
      ['04', 'pinky', 'Little'],
    ];
    for (const [palm, fn, d] of digits) {
      f.node(`palm.${palm}.${L}`, `hand.${L}`, `${side}${d}Metacarpal`);
      f.role(`f_${fn}.01.${L}`, `palm.${palm}.${L}`, `${side}${d}Proximal`);
      f.role(`f_${fn}.02.${L}`, `f_${fn}.01.${L}`, `${side}${d}Intermediate` as HumanoidBone);
      f.role(`f_${fn}.03.${L}`, `f_${fn}.02.${L}`, `${side}${d}Distal`);
    }
    f.role(`thigh.${L}`, 'spine', `${side}UpperLeg`);
    f.role(`shin.${L}`, `thigh.${L}`, `${side}LowerLeg`);
    f.role(`foot.${L}`, `shin.${L}`, `${side}Foot`);
    f.role(`toe.${L}`, `foot.${L}`, `${side}Toes`);
    f.helper(`heel.02.${L}`, `foot.${L}`, `${side}Heel`, { weight: 0 });
  }
  return f.done();
})();

// ---------------------------------------------------------------------------
// VRoid (J_Bip_ / J_Sec_ / J_Adj_)
// ---------------------------------------------------------------------------

export const VROID = ((): RigFixture => {
  const f = new Fx('VRoid');
  f.node('Root', null, 'root', { joint: false, weight: 0 });
  f.role('J_Bip_C_Hips', 'Root', 'hips');
  f.role('J_Bip_C_Spine', 'J_Bip_C_Hips', 'spine');
  f.role('J_Bip_C_Chest', 'J_Bip_C_Spine', 'chest');
  f.role('J_Bip_C_UpperChest', 'J_Bip_C_Chest', 'upperChest');
  f.role('J_Bip_C_Neck', 'J_Bip_C_UpperChest', 'neck');
  f.role('J_Bip_C_Head', 'J_Bip_C_Neck', 'head');
  f.helper('J_Adj_L_FaceEye', 'J_Bip_C_Head', 'leftEye', { weight: 0 });
  f.helper('J_Adj_R_FaceEye', 'J_Bip_C_Head', 'rightEye', { weight: 0 });
  f.helper('J_Sec_Hair1_01', 'J_Bip_C_Head', 'headTop+0,0,-0.02');
  f.helper('J_Sec_Hair1_02', 'J_Sec_Hair1_01', 'headTop+0,-0.15,-0.1');
  f.helper('J_Sec_Hair1_03', 'J_Sec_Hair1_02', 'headTop+0,-0.35,-0.14');
  for (const side of SIDES) {
    const L = side === 'left' ? 'L' : 'R';
    const x = side === 'left' ? 0.08 : -0.08;
    f.helper(`J_Sec_${L}_Bust1`, 'J_Bip_C_UpperChest', `upperChest+${x},-0.06,0.1`);
    f.helper(`J_Sec_${L}_Bust2`, `J_Sec_${L}_Bust1`, `upperChest+${x},-0.08,0.14`);
    f.helper(`J_Sec_Skirt_${L}_01`, 'J_Bip_C_Hips', `hips+${x * 2},-0.05,0.05`);
    f.helper(`J_Sec_Skirt_${L}_02`, `J_Sec_Skirt_${L}_01`, `hips+${x * 2.2},-0.3,0.06`);
    f.helper(`J_Sec_Skirt_${L}_03`, `J_Sec_Skirt_${L}_02`, `hips+${x * 2.4},-0.55,0.07`);
    f.role(`J_Bip_${L}_Shoulder`, 'J_Bip_C_UpperChest', `${side}Shoulder`);
    f.role(`J_Bip_${L}_UpperArm`, `J_Bip_${L}_Shoulder`, `${side}UpperArm`);
    f.role(`J_Bip_${L}_LowerArm`, `J_Bip_${L}_UpperArm`, `${side}LowerArm`);
    f.role(`J_Bip_${L}_Hand`, `J_Bip_${L}_LowerArm`, `${side}Hand`);
    for (const d of DIGITS) {
      const segs: string[] = d === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      let parent = `J_Bip_${L}_Hand`;
      segs.forEach((seg, k) => {
        const n = `J_Bip_${L}_${d}${k + 1}`;
        f.role(n, parent, `${side}${d}${seg}` as HumanoidBone);
        parent = n;
      });
    }
    f.role(`J_Bip_${L}_UpperLeg`, 'J_Bip_C_Hips', `${side}UpperLeg`);
    f.role(`J_Bip_${L}_LowerLeg`, `J_Bip_${L}_UpperLeg`, `${side}LowerLeg`);
    f.role(`J_Bip_${L}_Foot`, `J_Bip_${L}_LowerLeg`, `${side}Foot`);
    f.role(`J_Bip_${L}_ToeBase`, `J_Bip_${L}_Foot`, `${side}Toes`);
  }
  return f.done();
})();

// ---------------------------------------------------------------------------
// Character Creator 4
// ---------------------------------------------------------------------------

export const CC4 = ((): RigFixture => {
  const f = new Fx('Character Creator 4');
  f.node('CC_Base_BoneRoot', null, 'root', { weight: 0 });
  f.role('CC_Base_Hip', 'CC_Base_BoneRoot', 'hips');
  f.node('CC_Base_Pelvis', 'CC_Base_Hip', 'hips+0,-0.02,0');
  f.role('CC_Base_Waist', 'CC_Base_Hip', 'spine');
  f.role('CC_Base_Spine01', 'CC_Base_Waist', 'chest');
  f.role('CC_Base_Spine02', 'CC_Base_Spine01', 'upperChest');
  f.role('CC_Base_NeckTwist01', 'CC_Base_Spine02', 'neck');
  f.node('CC_Base_NeckTwist02', 'CC_Base_NeckTwist01', 'neck>head@0.5');
  f.role('CC_Base_Head', 'CC_Base_NeckTwist02', 'head');
  f.node('CC_Base_FacialBone', 'CC_Base_Head', 'headFront+0,-0.02,0');
  f.role('CC_Base_JawRoot', 'CC_Base_FacialBone', 'jaw');
  f.node('CC_Base_UpperJaw', 'CC_Base_FacialBone', 'jaw+0,0.02,0');
  f.role('CC_Base_L_Eye', 'CC_Base_FacialBone', 'leftEye');
  f.role('CC_Base_R_Eye', 'CC_Base_FacialBone', 'rightEye');
  for (const side of SIDES) {
    const L = side === 'left' ? 'L' : 'R';
    const x = side === 'left' ? 0.1 : -0.1;
    f.helper(`CC_Base_${L}_Breast`, 'CC_Base_Spine02', `upperChest+${x},-0.05,0.1`);
    f.helper(`CC_Base_${L}_RibsTwist`, 'CC_Base_Spine02', `upperChest+${x},-0.1,0`);
    f.role(`CC_Base_${L}_Clavicle`, 'CC_Base_Spine02', `${side}Shoulder`);
    f.role(`CC_Base_${L}_Upperarm`, `CC_Base_${L}_Clavicle`, `${side}UpperArm`);
    f.helper(`CC_Base_${L}_UpperarmTwist01`, `CC_Base_${L}_Upperarm`, `${side}UpperArm>${side}LowerArm@0.33`);
    f.helper(`CC_Base_${L}_UpperarmTwist02`, `CC_Base_${L}_Upperarm`, `${side}UpperArm>${side}LowerArm@0.66`);
    f.role(`CC_Base_${L}_Forearm`, `CC_Base_${L}_Upperarm`, `${side}LowerArm`);
    f.helper(`CC_Base_${L}_ForearmTwist01`, `CC_Base_${L}_Forearm`, `${side}LowerArm>${side}Hand@0.33`);
    f.helper(`CC_Base_${L}_ForearmTwist02`, `CC_Base_${L}_Forearm`, `${side}LowerArm>${side}Hand@0.66`);
    f.role(`CC_Base_${L}_Hand`, `CC_Base_${L}_Forearm`, `${side}Hand`);
    const digits: [string, (typeof DIGITS)[number]][] = [
      ['Thumb', 'Thumb'],
      ['Index', 'Index'],
      ['Mid', 'Middle'],
      ['Ring', 'Ring'],
      ['Pinky', 'Little'],
    ];
    for (const [cc, d] of digits) {
      const segs: string[] = d === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      let parent = `CC_Base_${L}_Hand`;
      segs.forEach((seg, k) => {
        const n = `CC_Base_${L}_${cc}${k + 1}`;
        f.role(n, parent, `${side}${d}${seg}` as HumanoidBone);
        parent = n;
      });
    }
    f.role(`CC_Base_${L}_Thigh`, 'CC_Base_Pelvis', `${side}UpperLeg`);
    f.helper(`CC_Base_${L}_ThighTwist01`, `CC_Base_${L}_Thigh`, `${side}UpperLeg>${side}LowerLeg@0.33`);
    f.helper(`CC_Base_${L}_ThighTwist02`, `CC_Base_${L}_Thigh`, `${side}UpperLeg>${side}LowerLeg@0.66`);
    f.role(`CC_Base_${L}_Calf`, `CC_Base_${L}_Thigh`, `${side}LowerLeg`);
    f.helper(`CC_Base_${L}_CalfTwist01`, `CC_Base_${L}_Calf`, `${side}LowerLeg>${side}Foot@0.33`);
    f.helper(`CC_Base_${L}_CalfTwist02`, `CC_Base_${L}_Calf`, `${side}LowerLeg>${side}Foot@0.66`);
    f.role(`CC_Base_${L}_Foot`, `CC_Base_${L}_Calf`, `${side}Foot`);
    f.role(`CC_Base_${L}_ToeBase`, `CC_Base_${L}_Foot`, `${side}Toes`);
    f.node(`CC_Base_${L}_BigToe1`, `CC_Base_${L}_ToeBase`, `${side}ToesTail+${side === 'left' ? -0.03 : 0.03},0,0`);
    f.node(`CC_Base_${L}_IndexToe1`, `CC_Base_${L}_ToeBase`, `${side}ToesTail+${side === 'left' ? -0.01 : 0.01},0,0`);
    f.node(`CC_Base_${L}_MidToe1`, `CC_Base_${L}_ToeBase`, `${side}ToesTail`);
    f.node(`CC_Base_${L}_RingToe1`, `CC_Base_${L}_ToeBase`, `${side}ToesTail+${side === 'left' ? 0.01 : -0.01},0,0`);
    f.node(`CC_Base_${L}_PinkyToe1`, `CC_Base_${L}_ToeBase`, `${side}ToesTail+${side === 'left' ? 0.03 : -0.03},0,0`);
  }
  return f.done();
})();

// ---------------------------------------------------------------------------
// Daz Genesis 8
// ---------------------------------------------------------------------------

export const GENESIS8 = ((): RigFixture => {
  const f = new Fx('Daz Genesis 8');
  f.node('Genesis8Female', null, 'root', { joint: false, weight: 0 });
  f.role('hip', 'Genesis8Female', 'hips');
  f.node('pelvis', 'hip', 'hips+0,-0.03,0');
  f.role('abdomenLower', 'hip', 'spine');
  f.node('abdomenUpper', 'abdomenLower', 'spine>chest@0.5');
  f.role('chestLower', 'abdomenUpper', 'chest');
  f.role('chestUpper', 'chestLower', 'upperChest');
  f.role('neckLower', 'chestUpper', 'neck');
  f.node('neckUpper', 'neckLower', 'neck>head@0.5');
  f.role('head', 'neckUpper', 'head');
  f.node('upperJaw', 'head', 'jaw+0,0.02,0');
  f.role('lowerJaw', 'head', 'jaw');
  f.role('lEye', 'head', 'leftEye');
  f.role('rEye', 'head', 'rightEye');
  for (const side of SIDES) {
    const l = side === 'left' ? 'l' : 'r';
    const x = side === 'left' ? 0.1 : -0.1;
    f.helper(`${l}Pectoral`, 'chestLower', `chest+${x},0.05,0.1`);
    f.role(`${l}Collar`, 'chestUpper', `${side}Shoulder`);
    f.role(`${l}ShldrBend`, `${l}Collar`, `${side}UpperArm`);
    f.helper(`${l}ShldrTwist`, `${l}ShldrBend`, `${side}UpperArm>${side}LowerArm@0.5`);
    f.role(`${l}ForearmBend`, `${l}ShldrTwist`, `${side}LowerArm`);
    f.helper(`${l}ForearmTwist`, `${l}ForearmBend`, `${side}LowerArm>${side}Hand@0.5`);
    f.role(`${l}Hand`, `${l}ForearmTwist`, `${side}Hand`);
    const digits: [string, (typeof DIGITS)[number]][] = [
      ['Thumb', 'Thumb'],
      ['Index', 'Index'],
      ['Mid', 'Middle'],
      ['Ring', 'Ring'],
      ['Pinky', 'Little'],
    ];
    for (const [dz, d] of digits) {
      const segs: string[] = d === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      let parent = `${l}Hand`;
      segs.forEach((seg, k) => {
        const n = `${l}${dz}${k + 1}`;
        f.role(n, parent, `${side}${d}${seg}` as HumanoidBone);
        parent = n;
      });
    }
    f.role(`${l}ThighBend`, 'pelvis', `${side}UpperLeg`);
    f.helper(`${l}ThighTwist`, `${l}ThighBend`, `${side}UpperLeg>${side}LowerLeg@0.5`);
    f.role(`${l}Shin`, `${l}ThighTwist`, `${side}LowerLeg`);
    f.role(`${l}Foot`, `${l}Shin`, `${side}Foot`);
    f.node(`${l}Metatarsals`, `${l}Foot`, `${side}Foot>${side}Toes@0.5`);
    f.role(`${l}Toe`, `${l}Metatarsals`, `${side}Toes`);
    f.node(`${l}BigToe`, `${l}Toe`, `${side}ToesTail+${side === 'left' ? -0.03 : 0.03},0,0`);
    f.node(`${l}SmallToe1`, `${l}Toe`, `${side}ToesTail+${side === 'left' ? -0.01 : 0.01},0,0`);
    f.node(`${l}SmallToe2`, `${l}Toe`, `${side}ToesTail`);
    f.node(`${l}SmallToe3`, `${l}Toe`, `${side}ToesTail+${side === 'left' ? 0.01 : -0.01},0,0`);
    f.node(`${l}SmallToe4`, `${l}Toe`, `${side}ToesTail+${side === 'left' ? 0.03 : -0.03},0,0`);
  }
  return f.done();
})();

// ---------------------------------------------------------------------------
// SMPL-style joint names
// ---------------------------------------------------------------------------

export const SMPL = ((): RigFixture => {
  const f = new Fx('SMPL joint names');
  f.role('pelvis', null, 'hips');
  f.role('spine1', 'pelvis', 'spine');
  f.role('spine2', 'spine1', 'chest');
  f.role('spine3', 'spine2', 'upperChest');
  f.role('neck', 'spine3', 'neck');
  f.role('head', 'neck', 'head');
  for (const side of SIDES) {
    f.role(`${side}_collar`, 'spine3', `${side}Shoulder`);
    f.role(`${side}_shoulder`, `${side}_collar`, `${side}UpperArm`);
    f.role(`${side}_elbow`, `${side}_shoulder`, `${side}LowerArm`);
    f.role(`${side}_wrist`, `${side}_elbow`, `${side}Hand`);
    f.role(`${side}_hip`, 'pelvis', `${side}UpperLeg`);
    f.role(`${side}_knee`, `${side}_hip`, `${side}LowerLeg`);
    f.role(`${side}_ankle`, `${side}_knee`, `${side}Foot`);
    f.role(`${side}_foot`, `${side}_ankle`, `${side}Toes`);
  }
  return f.done();
})();

// ---------------------------------------------------------------------------
// Nameless Bone.NNN rig (topology only)
// ---------------------------------------------------------------------------

export const NAMELESS = ((): RigFixture => {
  const f = new Fx('nameless Bone.NNN rig');
  let n = 0;
  const next = () => (n === 0 ? 'Bone' : `Bone.${String(n).padStart(3, '0')}`);
  const add = (parent: string | null, role: HumanoidBone): string => {
    const name = next();
    n++;
    f.role(name, parent, role);
    return name;
  };
  const hips = add(null, 'hips');
  const spine = add(hips, 'spine');
  const chest = add(spine, 'chest');
  const neck = add(chest, 'neck');
  const head = add(neck, 'head');
  f.helper(next(), head, 'headTop', { weight: 0 });
  n++;
  for (const side of SIDES) {
    const ua = add(chest, `${side}UpperArm`);
    const la = add(ua, `${side}LowerArm`);
    const hand = add(la, `${side}Hand`);
    f.helper(next(), hand, `${side}HandTail`, { weight: 0 });
    n++;
    const ul = add(hips, `${side}UpperLeg`);
    const ll = add(ul, `${side}LowerLeg`);
    const foot = add(ll, `${side}Foot`);
    const toes = add(foot, `${side}Toes`);
    f.helper(next(), toes, `${side}ToesTail`, { weight: 0 });
    n++;
  }
  return f.done();
})();

/** All name fixtures in the canonical frame. */
export const NAME_FIXTURES: RigFixture[] = [
  MIXAMO_PREFIXED,
  MIXAMO_FBX,
  READY_PLAYER_ME,
  MESHY,
  UE5_MANNEQUIN,
  RIGIFY_DEF,
  RIGIFY_FULL,
  BLENDER_METARIG,
  VROID,
  CC4,
  GENESIS8,
  SMPL,
  NAMELESS,
];

// ---------------------------------------------------------------------------
// Frame transforms for the axis fixtures
// ---------------------------------------------------------------------------

/** Faces -Z with the left side at -X (rotated 180° about Y). */
export const FACING_NEG_Z = (v: Vector3): Vector3 => new Vector3(-v.x, v.y, -v.z);
/** Z-up, facing -Y, left at +X (Blender world axes: +90° about X). */
export const Z_UP = (v: Vector3): Vector3 => new Vector3(v.x, -v.z, v.y);
