/**
 * Bind-pose analysis of a mapped rig (docs/DESIGN.md §5.3): axes and root
 * correction, unit scale, and per-role rest direction / plausibility.
 *
 * Works on any three.js `Object3D` hierarchy (bones or plain nodes) and needs
 * no renderer, so it runs in Node on the output of `readGlbSkeleton` as well
 * as on a `GLTFLoader` scene in the browser.
 */
import { Bone, Box3, Matrix4, Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three';
import type { HumanoidBone, HumanoidMap, QuatTuple, RigBoneAnalysis, Vec3Tuple } from '../core/types';
import { HUMANOID_BONES, HUMANOID_PARENT, REQUIRED_BONES, boneSide, isFingerBone } from '../core/types';
import { CANONICAL, canonicalDeviationDeg, canonicalDir, isAnatomical } from '../retarget/canonical';
import { isHelperBone, isTailMarker } from './boneNames';
import { applyBindPose } from './skeletonGraph';
import { axesFromRoles, type RigAxes } from './topology';

export interface AnalyzeRigOptions {
  /** Height the model will be scaled to (meters). */
  targetHeight: number;
  /** Override the measured source height (model units). */
  sourceHeight?: number;
  /** Override the detected axes (e.g. from the auto mapper). */
  axes?: RigAxes;
  /** Skip putting skeletons into their bind pose (when the caller already did). */
  skipBindPose?: boolean;
}

export interface RigAnalysisResult {
  analysis: Partial<Record<HumanoidBone, RigBoneAnalysis>>;
  /** Applied to the model root so the rig is Y-up and faces +Z. */
  rootCorrection: QuatTuple;
  /** Applied to the model root so the height matches `targetHeight`. */
  scale: number;
  /** Measured model height in source units along the detected up axis. */
  sourceHeight: number;
  /** Detected axes in the source (uncorrected) space. */
  axes: RigAxes;
  warnings: string[];
  boneByRole: Partial<Record<HumanoidBone, Object3D>>;
}

/** Preferred humanoid children used for the rest direction of each role. */
const DIR_CHILDREN: Partial<Record<HumanoidBone, HumanoidBone[]>> = {
  hips: ['spine', 'chest', 'upperChest', 'neck', 'head'],
  spine: ['chest', 'upperChest', 'neck', 'head'],
  chest: ['upperChest', 'neck', 'head'],
  upperChest: ['neck', 'head'],
  neck: ['head'],
  leftShoulder: ['leftUpperArm'],
  leftUpperArm: ['leftLowerArm'],
  leftLowerArm: ['leftHand'],
  leftHand: ['leftMiddleProximal', 'leftIndexProximal', 'leftRingProximal'],
  rightShoulder: ['rightUpperArm'],
  rightUpperArm: ['rightLowerArm'],
  rightLowerArm: ['rightHand'],
  rightHand: ['rightMiddleProximal', 'rightIndexProximal', 'rightRingProximal'],
  leftUpperLeg: ['leftLowerLeg'],
  leftLowerLeg: ['leftFoot'],
  leftFoot: ['leftToes'],
  rightUpperLeg: ['rightLowerLeg'],
  rightLowerLeg: ['rightFoot'],
  rightFoot: ['rightToes'],
};

function fingerChild(role: HumanoidBone): HumanoidBone | null {
  for (const b of HUMANOID_BONES) if (HUMANOID_PARENT[b] === role && isFingerBone(b)) return b;
  return null;
}

/** Quaternion mapping `axes.up` to +Y and `axes.forward` to +Z (left = up × forward ends at +X). */
export function rootCorrectionFromAxes(axes: RigAxes): Quaternion {
  const up = new Vector3().fromArray(axes.up).normalize();
  let fwd = new Vector3().fromArray(axes.forward);
  fwd.addScaledVector(up, -fwd.dot(up));
  if (fwd.length() < 1e-6) fwd = Math.abs(up.y) > 0.7 ? new Vector3(0, 0, 1) : new Vector3(0, -1, 0).addScaledVector(up, -up.y * -1);
  fwd.normalize();
  const left = new Vector3().crossVectors(up, fwd).normalize();
  const m = new Matrix4().makeBasis(left, up, fwd); // canonical -> rig
  return new Quaternion().setFromRotationMatrix(m).invert(); // rig -> canonical
}

/** Objects by name; `Bone`s win over plain nodes when names repeat. */
export function indexObjectsByName(root: Object3D): Map<string, Object3D> {
  const byName = new Map<string, Object3D>();
  root.traverse((o) => {
    if (!o.name) return;
    const prev = byName.get(o.name);
    if (!prev || (!(prev as Bone).isBone && (o as Bone).isBone)) byName.set(o.name, o);
  });
  return byName;
}

const _v = new Vector3();

export function analyzeRig(root: Object3D, map: HumanoidMap, opts: AnalyzeRigOptions): RigAnalysisResult {
  const warnings: string[] = [];
  if (!opts.skipBindPose) applyBindPose(root);
  root.updateMatrixWorld(true);

  const byName = indexObjectsByName(root);
  const boneByRole: Partial<Record<HumanoidBone, Object3D>> = {};
  for (const role of HUMANOID_BONES) {
    const name = map[role];
    if (!name) continue;
    const obj = byName.get(name);
    if (obj) boneByRole[role] = obj;
    else warnings.push(`Mapped bone '${name}' for ${role} was not found in the model.`);
  }
  for (const role of REQUIRED_BONES) if (!boneByRole[role]) warnings.push(`Required role '${role}' is not mapped.`);

  const worldPos = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3());
  const posOf = (role: HumanoidBone): Vec3Tuple | undefined => {
    const o = boneByRole[role];
    return o ? (worldPos(o).toArray() as Vec3Tuple) : undefined;
  };

  // ------------------------------------------------------------- axes
  let axes: RigAxes;
  if (opts.axes) {
    axes = opts.axes;
  } else {
    const feet: [Vec3Tuple, Vec3Tuple][] = [];
    for (const side of ['left', 'right'] as const) {
      const f = posOf(`${side}Foot`);
      const t = posOf(`${side}Toes`);
      if (f && t) feet.push([f, t]);
    }
    const topRole = (['head', 'neck', 'upperChest', 'chest', 'spine'] as HumanoidBone[]).find((r) => boneByRole[r]);
    const r = axesFromRoles({
      hips: posOf('hips'),
      head: posOf('head'),
      top: topRole ? posOf(topRole) : undefined,
      leftUpperLeg: posOf('leftUpperLeg'),
      rightUpperLeg: posOf('rightUpperLeg'),
      leftUpperArm: posOf('leftUpperArm'),
      rightUpperArm: posOf('rightUpperArm'),
      feet,
    });
    axes = r.axes;
    for (const w of r.warnings) warnings.push(w);
  }
  const up = new Vector3().fromArray(axes.up).normalize();
  const correction = rootCorrectionFromAxes(axes);
  const rootCorrection: QuatTuple = [correction.x, correction.y, correction.z, correction.w];

  // ------------------------------------------------------------- height and scale
  let sourceHeight = opts.sourceHeight ?? 0;
  if (!(sourceHeight > 0)) sourceHeight = measureHeight(root, up, boneByRole);
  if (!(sourceHeight > 0)) {
    warnings.push('Could not measure the model height; assuming 1 unit.');
    sourceHeight = 1;
  }
  const scale = opts.targetHeight / sourceHeight;
  if (sourceHeight > 4 && sourceHeight < 40) warnings.push(`Unusual model height ${sourceHeight.toFixed(2)} units (decimeters?); scaled to ${opts.targetHeight} m.`);
  else if (sourceHeight >= 40) warnings.push(`Model height ${sourceHeight.toFixed(1)} units looks like centimeters; scaled to ${opts.targetHeight} m.`);
  else if (sourceHeight < 0.3) warnings.push(`Model height ${sourceHeight.toFixed(3)} units is tiny; scaled to ${opts.targetHeight} m.`);

  // ------------------------------------------------------------- corrected-space helpers
  const cpos = (o: Object3D): Vector3 => worldPos(o).applyQuaternion(correction).multiplyScalar(scale);
  const cquat = (o: Object3D): Quaternion => o.getWorldQuaternion(new Quaternion()).premultiply(correction);
  const rolePos: Partial<Record<HumanoidBone, Vector3>> = {};
  for (const role of HUMANOID_BONES) if (boneByRole[role]) rolePos[role] = cpos(boneByRole[role]!);

  // ------------------------------------------------------------- per-role analysis
  const analysis: Partial<Record<HumanoidBone, RigBoneAnalysis>> = {};
  const roleObj = new Map<Object3D, HumanoidBone>();
  for (const role of HUMANOID_BONES) if (boneByRole[role]) roleObj.set(boneByRole[role]!, role);

  const childTarget = (role: HumanoidBone, obj: Object3D, p: Vector3): { dir: Vector3; length: number } | null => {
    // 1. mapped humanoid child
    const prefs = DIR_CHILDREN[role] ?? (isFingerBone(role) ? [fingerChild(role)].filter((x): x is HumanoidBone => !!x) : []);
    if (role !== 'head') {
      for (const c of prefs) {
        const cp = rolePos[c];
        if (cp && cp.distanceTo(p) > 1e-6) return { dir: cp.clone().sub(p).normalize(), length: cp.distanceTo(p) };
      }
    }
    // 2. tail markers
    const tails = obj.children.filter((c) => isTailMarker(c.name));
    const mean = (list: Object3D[]) => {
      const m = new Vector3();
      let n = 0;
      for (const c of list) {
        const cp = cpos(c);
        if (cp.distanceTo(p) < 1e-6) continue;
        m.add(cp);
        n++;
      }
      return n ? m.multiplyScalar(1 / n) : null;
    };
    const t = mean(tails);
    if (t) return { dir: t.clone().sub(p).normalize(), length: t.distanceTo(p) };
    if (role === 'head') return null; // face/eye/jaw children point forward; the head is treated as upright.
    // 3. non-helper children (excluding other mapped roles that are not on this chain, e.g. legs under hips)
    const kids = obj.children.filter((c) => !isHelperBone(c.name) && !(roleObj.has(c) && boneSide(roleObj.get(c)!) !== boneSide(role) && role !== 'hips'));
    const usable = role === 'hips' ? kids.filter((c) => !roleObj.has(c) || !/Leg$/.test(roleObj.get(c)!)) : kids;
    const m = mean(usable.length ? usable : kids);
    if (m) return { dir: m.clone().sub(p).normalize(), length: m.distanceTo(p) };
    return null;
  };

  const fallback = (role: HumanoidBone, p: Vector3): { dir: Vector3; length: number } => {
    const side = boneSide(role);
    const est = (frac: number) => opts.targetHeight * frac;
    if (role === 'head') return { dir: new Vector3(0, 1, 0), length: Math.max(est(0.12), (rolePos.neck && p.distanceTo(rolePos.neck) * 1.5) || 0) };
    if (role === 'leftHand' || role === 'rightHand') {
      const la = analysis[`${side}LowerArm` as HumanoidBone];
      const dir = la ? new Vector3().fromArray(la.restDir) : canonicalDir(role);
      return { dir, length: la ? la.length * 0.45 : est(0.1) };
    }
    if (role === 'leftToes' || role === 'rightToes') return { dir: new Vector3(0, 0, 1), length: (analysis[`${side}Foot` as HumanoidBone]?.length ?? est(0.12)) * 0.35 };
    if (role === 'leftFoot' || role === 'rightFoot') return { dir: canonicalDir(role), length: est(0.12) };
    if (role === 'leftEye' || role === 'rightEye') return { dir: new Vector3(0, 0, 1), length: est(0.02) };
    if (role === 'jaw') return { dir: canonicalDir(role), length: est(0.05) };
    if (isFingerBone(role)) {
      const parent = HUMANOID_PARENT[role];
      const pa = parent ? analysis[parent] : undefined;
      if (pa && parent && !/Hand$/.test(parent)) return { dir: new Vector3().fromArray(pa.restDir), length: pa.length * 0.7 };
      const hand = analysis[`${side}Hand` as HumanoidBone];
      const dir = hand ? new Vector3().fromArray(hand.restDir) : canonicalDir(role);
      return { dir, length: (hand?.length ?? est(0.1)) * 0.35 };
    }
    // Torso links without a mapped child: up.
    if (['hips', 'spine', 'chest', 'upperChest', 'neck'].includes(role)) return { dir: new Vector3(0, 1, 0), length: est(0.1) };
    return { dir: canonicalDir(role), length: est(0.1) };
  };

  // Parent-first so fallbacks can reference parent analyses.
  const order: HumanoidBone[] = [];
  const visit = (b: HumanoidBone) => {
    if (order.includes(b)) return;
    const p = HUMANOID_PARENT[b];
    if (p) visit(p);
    order.push(b);
  };
  for (const b of HUMANOID_BONES) visit(b);

  const nonAnatomical: string[] = [];
  for (const role of order) {
    const obj = boneByRole[role];
    if (!obj) continue;
    const p = rolePos[role]!;
    const target = childTarget(role, obj, p) ?? fallback(role, p);
    const q = cquat(obj);
    const dir = target.dir.clone().normalize();
    const dev = canonicalDeviationDeg(role, dir);
    const anatomical = isAnatomical(role, dir);
    if (!anatomical) nonAnatomical.push(`${role} ('${obj.name}', ${dev.toFixed(0)}° off canonical, cone ${CANONICAL[role].coneDeg}°)`);
    analysis[role] = {
      name: obj.name,
      restDir: [dir.x, dir.y, dir.z],
      restQuat: [q.x, q.y, q.z, q.w],
      restPos: [p.x, p.y, p.z],
      length: target.length,
      canonicalDeviationDeg: dev,
      anatomical,
    };
  }
  if (nonAnatomical.length) warnings.push(`Non-anatomical bind pose, driven in relative mode: ${nonAnatomical.join('; ')}.`);

  // ------------------------------------------------------------- sanity checks
  {
    const l = rolePos.leftUpperArm ?? rolePos.leftUpperLeg;
    const r = rolePos.rightUpperArm ?? rolePos.rightUpperLeg;
    if (l && r && l.x < r.x) warnings.push('Left/right inversion: after root correction the mapped left bones are at -X (expected +X).');
    const hips = rolePos.hips;
    const head = rolePos.head;
    if (hips && head && head.y <= hips.y) warnings.push('The head is not above the hips after root correction.');
    if (hips) {
      const frac = hips.y / opts.targetHeight;
      if (frac < 0.35 || frac > 0.7) warnings.push(`Unusual proportions: hips at ${(frac * 100).toFixed(0)}% of the model height.`);
    }
    const armLen = (analysis.leftUpperArm?.length ?? 0) + (analysis.leftLowerArm?.length ?? 0);
    if (armLen > 0) {
      const frac = armLen / opts.targetHeight;
      if (frac < 0.18 || frac > 0.5) warnings.push(`Unusual proportions: arm length is ${(frac * 100).toFixed(0)}% of the height.`);
    }
    const legLen = (analysis.leftUpperLeg?.length ?? 0) + (analysis.leftLowerLeg?.length ?? 0);
    if (legLen > 0) {
      const frac = legLen / opts.targetHeight;
      if (frac < 0.2 || frac > 0.65) warnings.push(`Unusual proportions: leg length is ${(frac * 100).toFixed(0)}% of the height.`);
    }
  }

  return { analysis, rootCorrection, scale, sourceHeight, axes, warnings, boneByRole };
}

/**
 * Model height along `up` in source units: skinned mesh bounds in bind space,
 * else bind bounds recorded on `root.userData.bindBounds`, else the skeleton
 * extent.
 */
export function measureHeight(root: Object3D, up: Vector3, boneByRole: Partial<Record<HumanoidBone, Object3D>>): number {
  let min = Infinity;
  let max = -Infinity;
  const consider = (p: Vector3) => {
    const h = p.dot(up);
    if (h < min) min = h;
    if (h > max) max = h;
  };
  const box = new Box3();
  const corners = (b: Box3, xform: Matrix4 | null) => {
    for (let c = 0; c < 8; c++) {
      _v.set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z);
      if (xform) _v.applyMatrix4(xform);
      consider(_v);
    }
  };
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!m.isSkinnedMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    if (!m.geometry.boundingBox) return;
    box.copy(m.geometry.boundingBox);
    corners(box, m.bindMatrix);
  });
  if (Number.isFinite(min) && max - min > 0) return max - min;

  const ub = root.userData?.bindBounds as { min: Vec3Tuple; max: Vec3Tuple } | undefined;
  if (ub && ub.min && ub.max) {
    box.min.fromArray(ub.min);
    box.max.fromArray(ub.max);
    corners(box, null);
    if (Number.isFinite(min) && max - min > 0) return max - min;
  }

  min = Infinity;
  max = -Infinity;
  const objs = Object.values(boneByRole) as Object3D[];
  if (objs.length) {
    for (const o of objs) {
      consider(o.getWorldPosition(new Vector3()));
      for (const c of o.children) consider(c.getWorldPosition(new Vector3()));
    }
  } else {
    root.traverse((o) => consider(o.getWorldPosition(new Vector3())));
  }
  return Number.isFinite(min) ? max - min : 0;
}
