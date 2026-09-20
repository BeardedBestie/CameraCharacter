/**
 * Rest analysis and global checks (docs/DESIGN.md §5.5, §5.6, §6.2 auto
 * references): per-role rest direction / up reference / quaternion / position
 * in the FINAL scene frame, bone lengths, plausibility, axes and root
 * correction, source height and scale, the monotonic height table, no-knee
 * flags, default per-bone modes and the family / instance keys. The output is
 * a complete {@link RigAnalysis}.
 *
 * Works on any three.js `Object3D` hierarchy in its bind pose (a `GLTFLoader`
 * scene in the browser, the Node GLB reader's tree in tests, a synthetic bone
 * rig) and needs no renderer.
 */
import { Box3, Matrix4, Mesh, Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three';
import type { BoneRefMode, BoneSettings, HeightTable, HumanoidBone, HumanoidMap, QuatTuple, RigAnalysis, RigAxes, RigBoneAnalysis, Vec3Tuple } from '../core/types';
import { HUMANOID_BONES, HUMANOID_PARENT, HUMANOID_SOLVE_ORDER, TORSO_BONES, boneSide, isFingerBone } from '../core/types';
import { DEG2RAD, angleBetween, dorsalNormal, flexionUp, kneecapUp, perpendicularComponent } from '../core/math';
import { CANONICAL, canonicalDeviationDeg, canonicalDir, isAnatomical } from '../retarget/canonical';
import { autoMapHumanoid, isAutoMapResult, mappedParentRole, remapAutoResult, type AutoMapOptions, type AutoMapResult } from './autoMap';
import type { FamilyHints } from './boneNames';
import { applyBindPose, buildRigGraph, defaultExclude, pathDown, subtreeLength, type SkeletonGraph } from './skeletonGraph';
import { rootCorrectionFromAxes } from './topology';

export interface AnalyzeRigOptions {
  /** Height the model will be scaled to (meters). */
  targetHeight: number;
  displayName?: string;
  /** Bind-pose graph of `root` (built with {@link buildRigGraph} when omitted). */
  graph?: SkeletonGraph;
  /** Skip putting the skeletons into their bind pose (the caller already did). */
  skipBindPose?: boolean;
  /** FBX unit scale factor when known (cm = 1); recorded only. */
  unitScaleFactor?: number;
  /** Auto-map options used when a plain map (or nothing) is given instead of an {@link AutoMapResult}. */
  hint?: HumanoidMap;
  vrm?: boolean;
  family?: FamilyHints;
  /** Subtrees to leave out (VRM normalized proxies by default). */
  exclude?: (obj: Object3D) => boolean;
}

/** Bend angle above which the bind elbow / knee defines the up reference (§6.2). */
export const BIND_BEND_MIN_DEG = 12;

/** Height-normalized body proportions used to interpolate missing height-table rows. */
const TABLE_FRACTIONS: Record<keyof HeightTable, number> = {
  floor: 0,
  ankles: 0.04,
  // knee := hips + 0.55·(ankle − hips) when the knee bone is unusable (§5.5)
  knees: 0.53 - 0.55 * (0.53 - 0.04),
  hips: 0.53,
  shoulders: 0.82,
  eyes: 0.94,
  headTop: 1,
};
const TABLE_ORDER: (keyof HeightTable)[] = ['floor', 'ankles', 'knees', 'hips', 'shoulders', 'eyes', 'headTop'];

/**
 * Monotonic height table (§5.5): `floor` and `headTop` must be given; the
 * other rows come from bones when they are in canonical order, otherwise they
 * are interpolated between their nearest valid neighbours with the standing
 * body proportions.
 */
export function computeHeightTable(input: { floor: number; headTop: number } & Partial<HeightTable>): HeightTable {
  const floor = Number.isFinite(input.floor) ? input.floor : 0;
  let headTop = Number.isFinite(input.headTop) ? input.headTop : floor + 1;
  if (headTop <= floor) headTop = floor + 1e-3;
  const values: Partial<Record<keyof HeightTable, number>> = { floor, headTop };
  // Bone rows: keep the heaviest strictly increasing subset inside (floor, headTop)
  // (hips and shoulders are the most reliable rows, a knee bone can sit anywhere).
  const weight: Record<keyof HeightTable, number> = { floor: 0, ankles: 2, knees: 1, hips: 3, shoulders: 3, eyes: 1, headTop: 0 };
  const cands = TABLE_ORDER.filter((k) => k !== 'floor' && k !== 'headTop').filter((k) => {
    const v = input[k];
    return v !== undefined && Number.isFinite(v) && v > floor && v < headTop;
  });
  let best: (keyof HeightTable)[] = [];
  let bestW = -1;
  for (let mask = 0; mask < 1 << cands.length; mask++) {
    const subset = cands.filter((_, i) => mask & (1 << i));
    let ok = true;
    let w = 0;
    for (let i = 0; i < subset.length; i++) {
      w += weight[subset[i]];
      if (i > 0 && !(input[subset[i]]! > input[subset[i - 1]]!)) ok = false;
    }
    if (ok && w > bestW) {
      bestW = w;
      best = subset;
    }
  }
  for (const k of best) values[k] = input[k]!;
  const valid = (k: keyof HeightTable): boolean => values[k] !== undefined;
  // Interpolate the rest between valid neighbours using the proportion fractions.
  for (let idx = 0; idx < TABLE_ORDER.length; idx++) {
    const k = TABLE_ORDER[idx];
    if (valid(k)) continue;
    let loK: keyof HeightTable = 'floor';
    let hiK: keyof HeightTable = 'headTop';
    for (let i = idx - 1; i >= 0; i--) if (valid(TABLE_ORDER[i])) { loK = TABLE_ORDER[i]; break; }
    for (let i = idx + 1; i < TABLE_ORDER.length; i++) if (valid(TABLE_ORDER[i])) { hiK = TABLE_ORDER[i]; break; }
    const t = (TABLE_FRACTIONS[k] - TABLE_FRACTIONS[loK]) / (TABLE_FRACTIONS[hiK] - TABLE_FRACTIONS[loK]);
    values[k] = values[loK]! + t * (values[hiK]! - values[loK]!);
  }
  // Enforce monotonicity against rounding.
  const out = values as HeightTable;
  for (let i = 1; i < TABLE_ORDER.length; i++) {
    const k = TABLE_ORDER[i];
    const prev = TABLE_ORDER[i - 1];
    if (out[k] < out[prev]) out[k] = out[prev];
  }
  return { floor: out.floor, ankles: out.ankles, knees: out.knees, hips: out.hips, shoulders: out.shoulders, eyes: out.eyes, headTop: out.headTop };
}

/** Objects by name; `Bone`s win over plain nodes when names repeat. */
export function indexObjectsByName(root: Object3D): Map<string, Object3D> {
  const byName = new Map<string, Object3D>();
  root.traverse((o) => {
    if (!o.name) return;
    const prev = byName.get(o.name);
    if (!prev || (!(prev as { isBone?: boolean }).isBone && (o as { isBone?: boolean }).isBone)) byName.set(o.name, o);
  });
  return byName;
}

export interface MeshExtents {
  /** Min / max along the up axis in loader-root space. */
  min: number;
  max: number;
  /** Number of meshes that contributed. */
  count: number;
}

/**
 * Mesh extents along `up` in loader-root space (§5.5): skinned meshes in bind
 * space (geometry bounds through the mesh's bind matrix), bind bounds recorded
 * by the Node reader (`root.userData.bindBounds`), and static meshes through
 * their node transforms only when the model has no skin at all (a posed mesh
 * node must never define a rigged model's height).
 */
export function measureMeshExtents(root: Object3D, up: Vector3, exclude: (obj: Object3D) => boolean = defaultExclude): MeshExtents {
  const rootInv = new Matrix4().copy(root.matrixWorld).invert();
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  const corner = new Vector3();
  const box = new Box3();
  const xform = new Matrix4();
  const addBox = (b: Box3, m: Matrix4 | null) => {
    for (let c = 0; c < 8; c++) {
      corner.set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z);
      if (m) corner.applyMatrix4(m);
      const h = corner.dot(up);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    count++;
  };
  const skinned: SkinnedMesh[] = [];
  const statics: Mesh[] = [];
  const visit = (o: Object3D) => {
    if (o !== root && exclude(o)) return;
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh) skinned.push(m);
    else if ((o as Mesh).isMesh) statics.push(o as Mesh);
    for (const c of o.children) visit(c);
  };
  visit(root);
  for (const m of skinned) {
    if (!m.geometry) continue;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    if (!m.geometry.boundingBox) continue;
    box.copy(m.geometry.boundingBox);
    // Bind space of the skin, expressed in loader-root space.
    xform.multiplyMatrices(rootInv, m.bindMatrix);
    addBox(box, xform);
  }
  if (count === 0) {
    const ub = root.userData?.bindBounds as { min: Vec3Tuple; max: Vec3Tuple } | undefined;
    if (ub && ub.min && ub.max) {
      box.min.fromArray(ub.min);
      box.max.fromArray(ub.max);
      addBox(box, null);
    }
  }
  if (count === 0) {
    for (const m of statics) {
      if (!m.geometry) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      if (!m.geometry.boundingBox) continue;
      box.copy(m.geometry.boundingBox);
      xform.multiplyMatrices(rootInv, m.matrixWorld);
      addBox(box, xform);
    }
  }
  return { min, max, count };
}

/** Preferred humanoid chain children for the rest direction of each role (§5.5). */
const DIR_CHILDREN: Partial<Record<HumanoidBone, HumanoidBone[]>> = {
  hips: ['spine', 'chest', 'upperChest', 'neck', 'head'],
  spine: ['chest', 'upperChest', 'neck', 'head'],
  chest: ['upperChest', 'neck', 'head'],
  upperChest: ['neck', 'head'],
  neck: ['head'],
  leftShoulder: ['leftUpperArm'],
  leftUpperArm: ['leftLowerArm'],
  leftLowerArm: ['leftHand'],
  rightShoulder: ['rightUpperArm'],
  rightUpperArm: ['rightLowerArm'],
  rightLowerArm: ['rightHand'],
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

const COLLINEAR_MAX_DEG = 45;

interface DirTarget {
  dir: Vector3;
  length: number;
  childRole: HumanoidBone | null;
}

/** Empty analysis for a model without a skeleton (static mesh). */
function unriggedAnalysis(root: Object3D, graph: SkeletonGraph, auto: AutoMapResult, opts: AnalyzeRigOptions, warnings: string[]): RigAnalysis {
  const up = new Vector3(0, 1, 0);
  const ext = measureMeshExtents(root, up, opts.exclude ?? defaultExclude);
  let sourceHeight = ext.count > 0 && ext.max - ext.min > 0 ? ext.max - ext.min : 0;
  if (!(sourceHeight > 0)) {
    warnings.push('Could not measure the model height; assuming 1 unit.');
    sourceHeight = 1;
  }
  const scale = opts.targetHeight / sourceHeight;
  const floor = ext.count > 0 ? ext.min * scale : 0;
  warnings.push('The model has no skeleton (static mesh); it can be shown as a prop but not driven.');
  return {
    familyKey: auto.familyKey,
    instanceKey: auto.instanceKey,
    displayName: opts.displayName ?? root.name ?? 'model',
    family: auto.family,
    map: {},
    confidence: {},
    warnings,
    axes: { up: [0, 1, 0], forward: [0, 0, 1], facingSource: 'assumed' },
    rootCorrection: [0, 0, 0, 1],
    scale,
    sourceHeight,
    unitScaleFactor: opts.unitScaleFactor,
    analysis: {},
    heightTable: computeHeightTable({ floor, headTop: floor + opts.targetHeight }),
    noKnee: { left: false, right: false },
    noElbow: { left: false, right: false },
    hasForearmTwist: { left: false, right: false },
    defaultBones: {},
    boneCount: 0,
    skinnedMeshCount: graph.skinnedMeshCount,
    unrigged: true,
  };
}

/**
 * Complete rig analysis (docs/DESIGN.md §5.5) of a loaded model in its bind
 * pose. `mapping` is the auto-map result, or a plain role -> bone name map
 * (the auto mapper then runs for axes / family / topology and the given roles
 * replace its map). Rest quaternions and positions are in the final scene
 * frame: `scale · rootCorrection · (loader-root space)`, i.e. what the wrapper
 * Group produces once its scale and correction are set.
 *
 * Never throws on an unrigged model: `unrigged = true` with an empty map.
 */
export function analyzeRig(root: Object3D, mapping: AutoMapResult | HumanoidMap | null | undefined, opts: AnalyzeRigOptions): RigAnalysis {
  const warnings: string[] = [];
  const exclude = opts.exclude ?? defaultExclude;
  if (!opts.skipBindPose) {
    const r = applyBindPose(root, { exclude });
    for (const w of r.warnings) warnings.push(w);
  }
  root.updateMatrixWorld(true);
  const graph = opts.graph ?? buildRigGraph(root, exclude);

  const autoOpts: AutoMapOptions = { hint: opts.hint, vrm: opts.vrm, family: opts.family };
  let auto: AutoMapResult;
  if (isAutoMapResult(mapping)) auto = mapping;
  else {
    auto = autoMapHumanoid(graph, autoOpts);
    if (mapping) auto = remapAutoResult(graph, auto, mapping);
  }
  for (const w of graph.warnings) if (!auto.warnings.includes(w)) warnings.push(w);
  for (const w of auto.warnings) warnings.push(w);

  if (auto.unrigged || Object.keys(auto.roleIndex).length === 0) {
    const a = unriggedAnalysis(root, graph, auto, opts, warnings);
    if (!auto.unrigged) {
      a.unrigged = false;
      a.boneCount = graph.nodes.filter((n) => n.isJoint).length || graph.nodes.length;
      a.warnings = warnings.filter((w) => !w.startsWith('The model has no skeleton'));
      a.warnings.push('No humanoid roles could be mapped; the rig cannot be driven.');
    }
    return a;
  }

  // ------------------------------------------------------------- axes and correction
  const axes: RigAxes = auto.axes;
  const upLoader = new Vector3().fromArray(axes.up).normalize();
  const correction = rootCorrectionFromAxes(axes, new Quaternion());
  const rootCorrection: QuatTuple = [correction.x, correction.y, correction.z, correction.w];

  // ------------------------------------------------------------- extents, height and scale (loader-root space)
  const rootInv = new Matrix4().copy(root.matrixWorld).invert();
  const nodePosLoader = (i: number): Vector3 => new Vector3().fromArray(graph.nodes[i].restPos).applyMatrix4(rootInv);
  const useJoints = graph.nodes.some((n) => n.isJoint);
  let skelMin = Infinity;
  let skelMax = -Infinity;
  for (const n of graph.nodes) {
    const jointLike = !useJoints || n.isJoint || (n.parent >= 0 && graph.nodes[n.parent].isJoint);
    if (!jointLike) continue;
    if (auto.topology.kinds[n.index] === 'passthrough' && useJoints && !n.isJoint) continue;
    const h = nodePosLoader(n.index).dot(upLoader);
    if (h < skelMin) skelMin = h;
    if (h > skelMax) skelMax = h;
  }
  const skelHeight = Number.isFinite(skelMin) ? skelMax - skelMin : 0;
  const mesh = measureMeshExtents(root, upLoader, exclude);
  const meshHeight = mesh.count > 0 ? mesh.max - mesh.min : 0;
  let sourceHeight = skelHeight;
  let useMesh = false;
  if (meshHeight > 0 && skelHeight > 0) {
    const ratio = meshHeight / skelHeight;
    if (ratio >= 0.7 && ratio <= 1.6) {
      sourceHeight = meshHeight;
      useMesh = true;
    } else warnings.push(`Skinned geometry height (${meshHeight.toFixed(3)}) disagrees with the skeleton bind extent (${skelHeight.toFixed(3)}); using the skeleton.`);
  } else if (meshHeight > 0) {
    sourceHeight = meshHeight;
    useMesh = true;
  }
  if (!(sourceHeight > 0)) {
    warnings.push('Could not measure the model height; assuming 1 unit.');
    sourceHeight = 1;
  }
  const scale = opts.targetHeight / sourceHeight;
  if (sourceHeight > 4 && sourceHeight < 40) warnings.push(`Unusual model height ${sourceHeight.toFixed(2)} units (decimeters?); scaled to ${opts.targetHeight} m.`);
  else if (sourceHeight >= 40) warnings.push(`Model height ${sourceHeight.toFixed(1)} units looks like centimeters; scaled to ${opts.targetHeight} m.`);
  else if (sourceHeight < 0.3) warnings.push(`Model height ${sourceHeight.toFixed(3)} units is tiny; scaled to ${opts.targetHeight} m.`);

  // ------------------------------------------------------------- final scene frame
  const rootQuatInv = new Quaternion().setFromRotationMatrix(rootInv);
  const toFinal = (p: Vector3): Vector3 => p.applyQuaternion(correction).multiplyScalar(scale);
  const finalPos = graph.nodes.map((n) => toFinal(nodePosLoader(n.index)));
  const finalQuat = (i: number): Quaternion => {
    const q = new Quaternion().fromArray(graph.nodes[i].restQuat);
    return q.premultiply(rootQuatInv).premultiply(correction);
  };
  const floorFinal = (useMesh ? mesh.min : skelMin) * scale;
  const topFinal = (useMesh ? mesh.max : skelMax) * scale;

  const roleIndex = auto.roleIndex;
  const roleIdx = (r: HumanoidBone): number | undefined => roleIndex[r];
  const P = (r: HumanoidBone): Vector3 | undefined => {
    const i = roleIdx(r);
    return i === undefined ? undefined : finalPos[i];
  };
  const isBelow = (i: number, ancestor: number): boolean => pathDown(graph, ancestor, i).length > 0;

  // ------------------------------------------------------------- per-role analysis
  const analysis: Partial<Record<HumanoidBone, RigBoneAnalysis>> = {};
  const kinds = auto.topology.kinds;
  const forward = new Vector3(0, 0, 1);
  const upFinal = new Vector3(0, 1, 0);

  const chainChild = (role: HumanoidBone, i: number): HumanoidBone | null => {
    const prefs = DIR_CHILDREN[role] ?? (isFingerBone(role) ? [fingerChild(role)].filter((x): x is HumanoidBone => !!x) : []);
    for (const c of prefs) {
      const ci = roleIdx(c);
      if (ci === undefined || ci === i) continue;
      if (!isBelow(ci, i)) continue;
      if (finalPos[ci].distanceTo(finalPos[i]) < 1e-6) continue;
      return c;
    }
    return null;
  };

  const target = (role: HumanoidBone, i: number): DirTarget => {
    const p = finalPos[i];
    const side = boneSide(role);
    // 1. Mapped child in the humanoid chain.
    if (role === 'leftHand' || role === 'rightHand') {
      const idx = roleIdx(`${side}IndexProximal` as HumanoidBone);
      const lit = roleIdx(`${side}LittleProximal` as HumanoidBone);
      if (idx !== undefined && lit !== undefined) {
        const mid = finalPos[idx].clone().add(finalPos[lit]).multiplyScalar(0.5);
        const len = mid.distanceTo(p);
        if (len > 1e-6) return { dir: mid.sub(p).normalize(), length: len, childRole: null };
      }
      for (const c of ['MiddleProximal', 'IndexProximal', 'RingProximal', 'LittleProximal'] as const) {
        const ci = roleIdx(`${side}${c}` as HumanoidBone);
        if (ci !== undefined && finalPos[ci].distanceTo(p) > 1e-6) return { dir: finalPos[ci].clone().sub(p).normalize(), length: finalPos[ci].distanceTo(p), childRole: `${side}${c}` as HumanoidBone };
      }
    } else {
      const c = chainChild(role, i);
      if (c) {
        const cp = finalPos[roleIdx(c)!];
        return { dir: cp.clone().sub(p).normalize(), length: cp.distanceTo(p), childRole: c };
      }
    }
    // 2. The single zero-weight tail marker child.
    const markers = graph.nodes[i].children.filter((c) => kinds[c] === 'marker' && finalPos[c].distanceTo(p) > 1e-6);
    if (markers.length === 1) {
      const mp = finalPos[markers[0]];
      return { dir: mp.clone().sub(p).normalize(), length: mp.distanceTo(p), childRole: null };
    }
    // 3. The child collinear with the parent link (never the mean of all children).
    const parentIdx = graph.nodes[i].parent;
    if (parentIdx >= 0 && role !== 'head') {
      const incoming = p.clone().sub(finalPos[parentIdx]);
      if (incoming.length() > 1e-6) {
        incoming.normalize();
        let best = -1;
        let bestDot = Math.cos(COLLINEAR_MAX_DEG * DEG2RAD);
        for (const c of graph.nodes[i].children) {
          if (kinds[c] === 'marker') continue;
          const d = finalPos[c].clone().sub(p);
          if (d.length() < 1e-6) continue;
          const dot = d.normalize().dot(incoming);
          if (dot > bestDot) {
            bestDot = dot;
            best = c;
          }
        }
        if (best >= 0) return { dir: finalPos[best].clone().sub(p).normalize(), length: finalPos[best].distanceTo(p), childRole: null };
      }
    }
    // 4. Role-specific estimates.
    const est = (frac: number) => opts.targetHeight * frac;
    if (role === 'head') {
      const above = topFinal - p.y;
      return { dir: upFinal.clone(), length: above > 0.02 * opts.targetHeight ? above : est(0.12), childRole: null };
    }
    if (role === 'leftHand' || role === 'rightHand') {
      const la = analysis[`${side}LowerArm` as HumanoidBone];
      return { dir: la ? new Vector3().fromArray(la.restDir) : canonicalDir(role), length: la ? la.length * 0.45 : est(0.1), childRole: null };
    }
    if (role === 'leftToes' || role === 'rightToes') return { dir: forward.clone(), length: (analysis[`${side}Foot` as HumanoidBone]?.length ?? est(0.12)) * 0.35, childRole: null };
    if (role === 'leftFoot' || role === 'rightFoot') return { dir: canonicalDir(role), length: est(0.12), childRole: null };
    if (role === 'leftEye' || role === 'rightEye') return { dir: forward.clone(), length: est(0.02), childRole: null };
    if (role === 'jaw') return { dir: canonicalDir(role), length: est(0.05), childRole: null };
    if (isFingerBone(role)) {
      const parent = HUMANOID_PARENT[role];
      const pa = parent ? analysis[parent] : undefined;
      if (pa && parent && !/Hand$/.test(parent)) return { dir: new Vector3().fromArray(pa.restDir), length: pa.length * 0.7, childRole: null };
      const hand = analysis[`${side}Hand` as HumanoidBone];
      return { dir: hand ? new Vector3().fromArray(hand.restDir) : canonicalDir(role), length: (hand?.length ?? est(0.1)) * 0.35, childRole: null };
    }
    if (TORSO_BONES.includes(role)) return { dir: upFinal.clone(), length: est(0.1), childRole: null };
    if (role === 'leftShoulder' || role === 'rightShoulder') return { dir: canonicalDir(role), length: est(0.08), childRole: null };
    return { dir: canonicalDir(role), length: est(0.1), childRole: null };
  };

  /** Rest tail point used by the up estimators when a chain child is missing. */
  const tailOf = (role: HumanoidBone): Vector3 | undefined => {
    const a = analysis[role];
    if (!a) return undefined;
    return new Vector3().fromArray(a.restPos).addScaledVector(new Vector3().fromArray(a.restDir), a.length);
  };

  /** Up reference with the §6.1 estimators on bind joint positions (§6.2 auto). */
  const restUp = (role: HumanoidBone): Vector3 | null => {
    const side = boneSide(role);
    switch (role) {
      case 'hips':
      case 'spine':
      case 'chest':
      case 'upperChest':
      case 'neck':
      case 'head':
      case 'leftShoulder':
      case 'rightShoulder':
        return forward.clone();
      case 'leftUpperArm':
      case 'rightUpperArm': {
        const sh = P(role);
        const el = P(`${side}LowerArm` as HumanoidBone);
        const wr = P(`${side}Hand` as HumanoidBone) ?? tailOf(`${side}LowerArm` as HumanoidBone);
        if (!sh || !el || !wr) return null;
        const d = el.clone().sub(sh);
        const c = wr.clone().sub(el);
        if (angleBetween(d, c) < BIND_BEND_MIN_DEG * DEG2RAD) return null;
        return flexionUp(d, c);
      }
      case 'leftLowerArm':
      case 'rightLowerArm':
      case 'leftHand':
      case 'rightHand': {
        const wrist = P(`${side}Hand` as HumanoidBone);
        const index = P(`${side}IndexProximal` as HumanoidBone);
        const pinky = P(`${side}LittleProximal` as HumanoidBone);
        if (!wrist || !index || !pinky) return null;
        return dorsalNormal(wrist, index, pinky, side === 'right' ? 'right' : 'left');
      }
      case 'leftUpperLeg':
      case 'rightUpperLeg': {
        const hip = P(role);
        const knee = P(`${side}LowerLeg` as HumanoidBone);
        const ankle = P(`${side}Foot` as HumanoidBone) ?? tailOf(`${side}LowerLeg` as HumanoidBone);
        if (!hip || !knee || !ankle) return null;
        const d = knee.clone().sub(hip);
        const c = ankle.clone().sub(knee);
        if (angleBetween(d, c) < BIND_BEND_MIN_DEG * DEG2RAD) return null;
        return kneecapUp(d, c);
      }
      case 'leftLowerLeg':
      case 'rightLowerLeg': {
        const knee = P(role);
        const ankle = P(`${side}Foot` as HumanoidBone);
        const toes = P(`${side}Toes` as HumanoidBone) ?? tailOf(`${side}Foot` as HumanoidBone);
        if (!knee || !ankle || !toes) return null;
        const shin = ankle.clone().sub(knee);
        if (shin.length() < 1e-6) return null;
        return perpendicularComponent(toes.clone().sub(ankle), shin.normalize());
      }
      case 'leftFoot':
      case 'rightFoot':
      case 'leftToes':
      case 'rightToes': {
        const knee = P(`${side}LowerLeg` as HumanoidBone);
        const ankle = P(`${side}Foot` as HumanoidBone);
        if (!knee || !ankle) return null;
        const a = analysis[role];
        if (!a) return null;
        const footDir = new Vector3().fromArray(a.restDir);
        return perpendicularComponent(knee.clone().sub(ankle), footDir);
      }
      default:
        return null;
    }
  };

  const nonAnatomical: string[] = [];
  for (const role of HUMANOID_SOLVE_ORDER) {
    const i = roleIdx(role);
    if (i === undefined) continue;
    const p = finalPos[i];
    const t = target(role, i);
    const q = finalQuat(i);
    const dir = t.dir.clone().normalize();
    const dev = canonicalDeviationDeg(role, dir);
    const anatomical = isAnatomical(role, dir);
    if (!anatomical) nonAnatomical.push(`${role} ('${graph.nodes[i].name}', ${dev.toFixed(0)}° off canonical, cone ${CANONICAL[role].coneDeg}°)`);
    const parentRole = mappedParentRole(role, roleIndex);
    const parentIdx = parentRole ? roleIdx(parentRole)! : -1;
    const intermediateCount = parentIdx >= 0 ? Math.max(0, pathDown(graph, parentIdx, i).length - 1) : 0;
    analysis[role] = {
      name: graph.nodes[i].name,
      restDir: [dir.x, dir.y, dir.z],
      restUp: null,
      restQuat: [q.x, q.y, q.z, q.w],
      restPos: [p.x, p.y, p.z],
      length: t.length,
      canonicalDeviationDeg: dev,
      anatomical,
      parentRole,
      childRole: t.childRole,
      intermediateCount,
    };
  }
  // Up references need the directions of neighbours, so a second pass.
  for (const role of HUMANOID_SOLVE_ORDER) {
    const a = analysis[role];
    if (!a) continue;
    const u = restUp(role);
    a.restUp = u ? [u.x, u.y, u.z] : null;
  }
  if (nonAnatomical.length) warnings.push(`Non-anatomical bind pose: ${nonAnatomical.join('; ')}.`);

  // ------------------------------------------------------------- global checks
  {
    const l = P('leftUpperArm') ?? P('leftUpperLeg');
    const r = P('rightUpperArm') ?? P('rightUpperLeg');
    if (l && r && l.x < r.x) warnings.push('Left/right inversion: after root correction the mapped left bones are at -X (expected +X).');
    const hips = P('hips');
    const head = P('head');
    if (hips && head && head.y <= hips.y) warnings.push('The head is not above the hips after root correction.');
    if (hips) {
      const frac = (hips.y - floorFinal) / opts.targetHeight;
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

  // ------------------------------------------------------------- height table (final frame)
  const mean = (a?: Vector3, b?: Vector3): number | undefined => {
    if (a && b) return 0.5 * (a.y + b.y);
    return (a ?? b)?.y;
  };
  const headPos = P('head');
  // Eyes: mapped eye bones, else ~half way from the head joint to the head top (capped so a hat
  // or hair above the skull does not lift them).
  const eyesY = mean(P('leftEye'), P('rightEye')) ?? (headPos ? headPos.y + Math.min(0.5 * Math.max(0, topFinal - headPos.y), 0.08 * opts.targetHeight) : undefined);
  const heightTable = computeHeightTable({
    floor: Math.min(floorFinal, P('leftFoot')?.y ?? Infinity, P('rightFoot')?.y ?? Infinity),
    headTop: topFinal,
    ankles: mean(P('leftFoot'), P('rightFoot')),
    knees: mean(P('leftLowerLeg'), P('rightLowerLeg')),
    hips: P('hips')?.y,
    shoulders: mean(P('leftUpperArm'), P('rightUpperArm')),
    eyes: eyesY,
  });

  // ------------------------------------------------------------- default modes
  const defaultBones: Partial<Record<HumanoidBone, BoneSettings>> = {};
  const heightLoader = auto.height > 0 ? auto.height : sourceHeight;
  const outOfConeAuto: string[] = [];
  for (const role of HUMANOID_BONES) {
    const a = analysis[role];
    const i = roleIdx(role);
    if (!a || i === undefined) continue;
    const side = boneSide(role);
    let mode: BoneRefMode;
    if (TORSO_BONES.includes(role)) mode = 'relative';
    else if ((role === 'leftUpperLeg' || role === 'rightUpperLeg') && auto.noKnee[side as 'left' | 'right']) mode = 'follow';
    else if ((role === 'leftUpperArm' || role === 'rightUpperArm') && auto.noElbow[side as 'left' | 'right']) mode = 'follow';
    else if (a.anatomical) mode = 'auto';
    else {
      const sub = subtreeLength(graph, i);
      const shortSubtree = sub < 0.12 * heightLoader;
      if (shortSubtree) mode = 'relative';
      else {
        mode = 'auto';
        outOfConeAuto.push(`${role} ('${a.name}')`);
      }
    }
    defaultBones[role] = { mode, rollOffsetDeg: 0 };
  }
  if (outOfConeAuto.length) warnings.push(`Out-of-cone bind pose driven in auto mode (check the result, switch to relative or calibrate): ${outOfConeAuto.join(', ')}.`);

  const boneCount = graph.nodes.filter((n) => n.isJoint).length || graph.nodes.length;
  return {
    familyKey: auto.familyKey,
    instanceKey: auto.instanceKey,
    displayName: opts.displayName ?? root.name ?? 'model',
    family: auto.family,
    map: { ...auto.map },
    confidence: { ...auto.confidence },
    warnings: [...new Set(warnings)],
    axes,
    rootCorrection,
    scale,
    sourceHeight,
    unitScaleFactor: opts.unitScaleFactor,
    analysis,
    heightTable,
    noKnee: { ...auto.noKnee },
    noElbow: { ...auto.noElbow },
    hasForearmTwist: { ...auto.hasForearmTwist },
    defaultBones,
    boneCount,
    skinnedMeshCount: graph.skinnedMeshCount,
    unrigged: false,
  };
}

export { rootCorrectionFromAxes };
