/**
 * BVH export of a retargeted Take (docs/DESIGN.md §9), plus a small BVH parser
 * and forward-kinematics evaluator used by the round-trip test and usable for
 * re-importing files from DCC tools. Pure: three.js math only.
 *
 * Conventions written:
 * - HIERARCHY of the mapped roles only; names = role names; root = hips.
 * - OFFSET_j = bindWorldPos[j] − bindWorldPos[parent] (root: bindWorldPos[root]),
 *   world Y-up, times `unitScale` (1 = meters, 100 = centimeters).
 * - End Site per leaf: rest direction × lengths[j].
 * - Root CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation;
 *   others CHANNELS 3 Zrotation Xrotation Yrotation. Rotations are the world
 *   delta from bind, made relative to the parent's delta:
 *   D_j = worldQuat_j · conj(bindWorldQuat_j), R_bvh(j) = conj(D_parent) · D_j,
 *   written as three's Euler 'ZXY' in degrees (Rz·Rx·Ry, outermost first).
 * - Root position = the ABSOLUTE hips world position × unitScale (the
 *   Blender convention: position channels replace the offset).
 */
import { Euler, Quaternion, Vector3 } from 'three';
import { RAD2DEG, DEG2RAD } from '../core/math';
import type { Take, Vec3Tuple } from '../core/types';

export interface BvhExportOptions {
  /** Multiplier applied to every length: 1 = meters (default), 100 = centimeters. */
  unitScale?: number;
  /** Seconds per frame; default 1 / take.fps. */
  frameTime?: number;
  /** Decimals written for positions (default 5) and rotations (default 4). */
  positionDecimals?: number;
  rotationDecimals?: number;
}

/** Length used for an End Site whose bone has no usable length (meters). */
const FALLBACK_END_SITE_LENGTH = 0.1;

const _q = new Quaternion();
const _qBind = new Quaternion();
const _qParent = new Quaternion();
const _e = new Euler();
const _v = new Vector3();
const _up = new Vector3(0, 1, 0);

/** Index of the root joint (the `hips` role, or the only joint without a parent). */
function findRoot(take: Take): number {
  const roots: number[] = [];
  for (let i = 0; i < take.roles.length; i++) if (take.parentIndex[i] < 0) roots.push(i);
  if (roots.length === 0) throw new Error('takeToBvh: the take has no root joint');
  if (roots.length > 1) {
    const hips = roots.find((i) => take.roles[i] === 'hips');
    if (hips === undefined) throw new Error(`takeToBvh: ${roots.length} root joints (${roots.map((i) => take.roles[i]).join(', ')})`);
    throw new Error(`takeToBvh: joints without a mapped parent besides hips: ${roots.filter((i) => i !== hips).map((i) => take.roles[i]).join(', ')}`);
  }
  return roots[0];
}

function childrenOf(take: Take): number[][] {
  const children: number[][] = take.roles.map(() => []);
  for (let i = 0; i < take.roles.length; i++) {
    const p = take.parentIndex[i];
    if (p >= 0) {
      if (p >= take.roles.length) throw new Error(`takeToBvh: parentIndex[${i}] = ${p} is out of range`);
      children[p].push(i);
    }
  }
  return children;
}

/**
 * Rest direction of joint `j` in the bind pose: toward the first mapped child
 * when there is one, else the bone's local +Y rotated by its bind world
 * quaternion.
 */
export function restDirection(take: Take, j: number, children?: number[][]): Vector3 {
  const kids = children ? children[j] : take.parentIndex.map((p, i) => (p === j ? i : -1)).filter((i) => i >= 0);
  const out = new Vector3();
  const pj = take.bindWorldPos[j];
  for (const c of kids) {
    const pc = take.bindWorldPos[c];
    out.set(pc[0] - pj[0], pc[1] - pj[1], pc[2] - pj[2]);
    if (out.lengthSq() > 1e-12) return out.normalize();
  }
  const q = take.bindWorldQuat[j];
  return out.copy(_up).applyQuaternion(_q.set(q[0], q[1], q[2], q[3]));
}

/** Depth-first joint order as written in the HIERARCHY (and in every MOTION line). */
export function bvhJointOrder(take: Take): number[] {
  const children = childrenOf(take);
  const order: number[] = [];
  const visit = (j: number) => {
    order.push(j);
    for (const c of children[j]) visit(c);
  };
  visit(findRoot(take));
  return order;
}

/** Serializes a Take as BVH text. */
export function takeToBvh(take: Take, opts: BvhExportOptions = {}): string {
  const unit = opts.unitScale ?? 1;
  const frameTime = opts.frameTime ?? 1 / take.fps;
  const pd = opts.positionDecimals ?? 5;
  const rd = opts.rotationDecimals ?? 4;
  const n = take.roles.length;
  if (take.bindWorldPos.length !== n || take.bindWorldQuat.length !== n || take.parentIndex.length !== n) {
    throw new Error('takeToBvh: roles, bindWorldPos, bindWorldQuat and parentIndex must have the same length');
  }
  const root = findRoot(take);
  const children = childrenOf(take);
  const lines: string[] = [];
  const order: number[] = [];

  const fmtPos = (v: number) => trimNumber(v * unit, pd);
  const fmtRot = (v: number) => trimNumber(v, rd);

  const writeJoint = (j: number, depth: number) => {
    const indent = '\t'.repeat(depth);
    const p = take.parentIndex[j];
    const pos = take.bindWorldPos[j];
    const off: Vec3Tuple = p < 0 ? [pos[0], pos[1], pos[2]] : [pos[0] - take.bindWorldPos[p][0], pos[1] - take.bindWorldPos[p][1], pos[2] - take.bindWorldPos[p][2]];
    lines.push(`${indent}${p < 0 ? 'ROOT' : 'JOINT'} ${jointName(take.roles[j])}`);
    lines.push(`${indent}{`);
    lines.push(`${indent}\tOFFSET ${fmtPos(off[0])} ${fmtPos(off[1])} ${fmtPos(off[2])}`);
    lines.push(
      p < 0
        ? `${indent}\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`
        : `${indent}\tCHANNELS 3 Zrotation Xrotation Yrotation`,
    );
    order.push(j);
    const kids = children[j];
    if (kids.length === 0) {
      let len = take.lengths[j];
      if (!(len > 0)) len = FALLBACK_END_SITE_LENGTH;
      const dir = restDirection(take, j, children).multiplyScalar(len);
      lines.push(`${indent}\tEnd Site`);
      lines.push(`${indent}\t{`);
      lines.push(`${indent}\t\tOFFSET ${fmtPos(dir.x)} ${fmtPos(dir.y)} ${fmtPos(dir.z)}`);
      lines.push(`${indent}\t}`);
    } else {
      for (const c of kids) writeJoint(c, depth + 1);
    }
    lines.push(`${indent}}`);
  };

  lines.push('HIERARCHY');
  writeJoint(root, 0);
  lines.push('MOTION');
  lines.push(`Frames: ${take.samples.length}`);
  lines.push(`Frame Time: ${frameTime.toFixed(6)}`);

  const delta: Quaternion[] = take.roles.map(() => new Quaternion());
  for (const s of take.samples) {
    if (s.world.length < n * 4) throw new Error(`takeToBvh: sample at t=${s.t} has ${s.world.length} world values, expected ${n * 4}`);
    // World deltas from bind for every joint.
    for (let j = 0; j < n; j++) {
      const b = take.bindWorldQuat[j];
      _qBind.set(b[0], b[1], b[2], b[3]).invert();
      delta[j].set(s.world[j * 4], s.world[j * 4 + 1], s.world[j * 4 + 2], s.world[j * 4 + 3]).normalize().multiply(_qBind);
    }
    const values: string[] = [];
    for (const j of order) {
      const p = take.parentIndex[j];
      if (p < 0) {
        values.push(fmtPos(s.hipsWorld[0]), fmtPos(s.hipsWorld[1]), fmtPos(s.hipsWorld[2]));
        _q.copy(delta[j]);
      } else {
        _q.copy(_qParent.copy(delta[p]).invert()).multiply(delta[j]);
      }
      _e.setFromQuaternion(_q, 'ZXY');
      values.push(fmtRot(_e.z * RAD2DEG), fmtRot(_e.x * RAD2DEG), fmtRot(_e.y * RAD2DEG));
    }
    lines.push(values.join(' '));
  }
  return lines.join('\n') + '\n';
}

/** Role names contain neither spaces nor colons; sanitized anyway for safety. */
function jointName(role: string): string {
  return role.replace(/[\s:]+/g, '_');
}

function trimNumber(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(decimals);
  if (s.indexOf('.') < 0) return s;
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '-0' ? '0' : t;
}

// ---------------------------------------------------------------------------
// Parser and forward kinematics
// ---------------------------------------------------------------------------

export type BvhChannel = 'Xposition' | 'Yposition' | 'Zposition' | 'Xrotation' | 'Yrotation' | 'Zrotation';

export interface BvhJoint {
  name: string;
  /** Index of the parent joint, or -1 for a root. */
  parent: number;
  offset: Vec3Tuple;
  channels: BvhChannel[];
  /** End Site offset when the joint is a leaf with one, else null. */
  endSite: Vec3Tuple | null;
}

export interface ParsedBvh {
  joints: BvhJoint[];
  /** One row per frame, all channel values in hierarchy order. */
  frames: number[][];
  frameTime: number;
  /** Total channel count (length of every frame row). */
  channelCount: number;
}

const CHANNEL_NAMES = new Set<string>(['Xposition', 'Yposition', 'Zposition', 'Xrotation', 'Yrotation', 'Zrotation']);

/** Parses BVH text (our own output and Blender/Motion-Builder style files). */
export function parseBvh(text: string): ParsedBvh {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  const peek = () => tokens[i];
  const next = (): string => {
    if (i >= tokens.length) throw new Error('parseBvh: unexpected end of file');
    return tokens[i++];
  };
  const expect = (t: string) => {
    const got = next();
    if (got !== t) throw new Error(`parseBvh: expected "${t}" but found "${got}"`);
  };
  const num = (): number => {
    const t = next();
    const v = Number(t);
    if (!Number.isFinite(v)) throw new Error(`parseBvh: expected a number but found "${t}"`);
    return v;
  };

  const joints: BvhJoint[] = [];
  let channelCount = 0;

  const parseJoint = (parent: number) => {
    const kind = next(); // ROOT | JOINT
    if (kind !== 'ROOT' && kind !== 'JOINT') throw new Error(`parseBvh: expected ROOT or JOINT but found "${kind}"`);
    const name = next();
    const joint: BvhJoint = { name, parent, offset: [0, 0, 0], channels: [], endSite: null };
    const index = joints.length;
    joints.push(joint);
    expect('{');
    while (true) {
      const t = peek();
      if (t === undefined) throw new Error('parseBvh: unexpected end of file inside a joint');
      if (t === '}') {
        next();
        break;
      }
      if (t === 'OFFSET') {
        next();
        joint.offset = [num(), num(), num()];
      } else if (t === 'CHANNELS') {
        next();
        const count = num();
        for (let k = 0; k < count; k++) {
          const c = next();
          if (!CHANNEL_NAMES.has(c)) throw new Error(`parseBvh: unknown channel "${c}"`);
          joint.channels.push(c as BvhChannel);
        }
        channelCount += count;
      } else if (t === 'JOINT') {
        parseJoint(index);
      } else if (t === 'End') {
        next();
        expect('Site');
        expect('{');
        expect('OFFSET');
        joint.endSite = [num(), num(), num()];
        expect('}');
      } else {
        throw new Error(`parseBvh: unexpected token "${t}" in joint "${name}"`);
      }
    }
  };

  expect('HIERARCHY');
  while (peek() === 'ROOT') parseJoint(-1);
  if (joints.length === 0) throw new Error('parseBvh: no ROOT joint');
  expect('MOTION');
  expect('Frames:');
  const frameCount = num();
  // "Frame Time:" tokenizes as "Frame" "Time:".
  expect('Frame');
  expect('Time:');
  const frameTime = num();
  const frames: number[][] = [];
  for (let f = 0; f < frameCount; f++) {
    if (i >= tokens.length) break; // tolerate a truncated file
    const row: number[] = new Array<number>(channelCount);
    for (let c = 0; c < channelCount; c++) row[c] = num();
    frames.push(row);
  }
  return { joints, frames, frameTime, channelCount };
}

export interface BvhJointState {
  /** World position of the joint. */
  pos: Vector3;
  /** World rotation of the joint (the product of the channel rotations along the chain). */
  quat: Quaternion;
  /** World position of the End Site when the joint has one. */
  end?: Vector3;
}

/**
 * Forward kinematics of one frame. Rotations apply in the listed channel
 * order (`Zrotation Xrotation Yrotation` → R = Rz·Rx·Ry). Position channels
 * replace the offset (Blender convention: absolute for the root); joints
 * without position channels use their OFFSET.
 */
export function evaluateBvhFrame(parsed: ParsedBvh, frameIndex: number): Map<string, BvhJointState> {
  const row = parsed.frames[frameIndex];
  if (!row) throw new Error(`evaluateBvhFrame: frame ${frameIndex} does not exist (${parsed.frames.length} frames)`);
  const out = new Map<string, BvhJointState>();
  const states: BvhJointState[] = [];
  let c = 0;
  const axis = new Vector3();
  const qc = new Quaternion();
  for (let j = 0; j < parsed.joints.length; j++) {
    const joint = parsed.joints[j];
    const trans = new Vector3(joint.offset[0], joint.offset[1], joint.offset[2]);
    const rot = new Quaternion();
    let hasPos = false;
    for (const ch of joint.channels) {
      const v = row[c++];
      switch (ch) {
        case 'Xposition':
          if (!hasPos) trans.set(0, 0, 0);
          hasPos = true;
          trans.x = v;
          break;
        case 'Yposition':
          if (!hasPos) trans.set(0, 0, 0);
          hasPos = true;
          trans.y = v;
          break;
        case 'Zposition':
          if (!hasPos) trans.set(0, 0, 0);
          hasPos = true;
          trans.z = v;
          break;
        case 'Xrotation':
          rot.multiply(qc.setFromAxisAngle(axis.set(1, 0, 0), v * DEG2RAD));
          break;
        case 'Yrotation':
          rot.multiply(qc.setFromAxisAngle(axis.set(0, 1, 0), v * DEG2RAD));
          break;
        case 'Zrotation':
          rot.multiply(qc.setFromAxisAngle(axis.set(0, 0, 1), v * DEG2RAD));
          break;
      }
    }
    const parent = joint.parent >= 0 ? states[joint.parent] : null;
    const pos = parent ? _v.copy(trans).applyQuaternion(parent.quat).add(parent.pos).clone() : trans.clone();
    const quat = parent ? parent.quat.clone().multiply(rot) : rot.clone();
    const state: BvhJointState = { pos, quat };
    if (joint.endSite) {
      state.end = new Vector3(joint.endSite[0], joint.endSite[1], joint.endSite[2]).applyQuaternion(quat).add(pos);
    }
    states.push(state);
    out.set(joint.name, state);
  }
  return out;
}
