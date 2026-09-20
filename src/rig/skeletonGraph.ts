/**
 * Bind pose and skeleton graph (docs/DESIGN.md §5.2, §5.3).
 *
 * `applyBindPose` puts every skeleton under a loader root into the pose its
 * inverse bind matrices describe, without `Skeleton.pose()`.
 * `buildGraphFromObject3D` snapshots the named hierarchy (bones, empties and
 * tail markers, never meshes) into a flat, index-addressed graph with world
 * rest transforms, skin joint flags and summed skin weights. The graph carries
 * no three.js objects, so the detectors run in Node.
 */
import { Bone, Camera, Light, Matrix4, Mesh, Object3D, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import type { QuatTuple, Vec3Tuple } from '../core/types';

export interface SkeletonNode {
  /** Index in {@link SkeletonGraph.nodes}. Parents always precede children. */
  index: number;
  name: string;
  /** Parent index, or -1 for a root. */
  parent: number;
  children: number[];
  /** World position in the bind pose (loader-root space). */
  restPos: Vec3Tuple;
  /** World quaternion in the bind pose. */
  restQuat: QuatTuple;
  /** True when the node is a skin joint of the primary skeleton group. */
  isJoint: boolean;
  /** Summed skin weight over every skinned mesh (0 for non-joints and unweighted joints). */
  weight: number;
}

export interface SkeletonGraph {
  nodes: SkeletonNode[];
  /** Indices of nodes without a parent in the graph. */
  roots: number[];
  /** True when at least one skinned mesh contributed weights (then weight 0 means "unweighted"). */
  hasSkinWeights: boolean;
  skinnedMeshCount: number;
  /** Notes produced while collecting (secondary skeletons, unnamed bones, ...). */
  warnings: string[];
}

export interface BuildGraphOptions {
  /** Skin joints of the primary skeleton group. When omitted, every `Bone` counts as a joint. */
  joints?: ReadonlySet<Object3D>;
  /** Summed skin weight per joint (see {@link computeSkinWeights}). */
  weights?: ReadonlyMap<Object3D, number>;
  /** Subtrees to leave out entirely (VRM normalized proxy bones, helpers). */
  exclude?: (obj: Object3D) => boolean;
  skinnedMeshCount?: number;
  warnings?: string[];
}

/** Default exclusion: VRM `normalizedHumanBonesRoot` proxies and anything flagged by the loader. */
export function defaultExclude(obj: Object3D): boolean {
  if (obj.userData && obj.userData.excludeFromRig === true) return true;
  return typeof obj.name === 'string' && obj.name.startsWith('Normalized_');
}

const _mat = new Matrix4();
const _inv = new Matrix4();

function maxAbsDiff(a: Matrix4, b: Matrix4): number {
  let m = 0;
  for (let i = 0; i < 16; i++) m = Math.max(m, Math.abs(a.elements[i] - b.elements[i]));
  return m;
}

/**
 * Every skeleton under `root` (each visited once) in the order the skinned
 * meshes are met.
 */
export function collectSkeletons(root: Object3D, exclude: (obj: Object3D) => boolean = defaultExclude): { skeleton: Skeleton; meshes: SkinnedMesh[] }[] {
  const out: { skeleton: Skeleton; meshes: SkinnedMesh[] }[] = [];
  const byskel = new Map<Skeleton, { skeleton: Skeleton; meshes: SkinnedMesh[] }>();
  const visit = (obj: Object3D): void => {
    if (exclude(obj)) return;
    const mesh = obj as SkinnedMesh;
    if (mesh.isSkinnedMesh && mesh.skeleton) {
      let entry = byskel.get(mesh.skeleton);
      if (!entry) {
        entry = { skeleton: mesh.skeleton, meshes: [] };
        byskel.set(mesh.skeleton, entry);
        out.push(entry);
      }
      entry.meshes.push(mesh);
    }
    for (const c of obj.children) visit(c);
  };
  visit(root);
  return out;
}

/**
 * Puts every skeleton under `root` into its bind pose (docs/DESIGN.md §5.3):
 *
 * 1. `G_i = inverse(boneInverses[i])` is joint i's bind world matrix in
 *    loader-root space (GLTFLoader binds with the identity matrix; FBXLoader's
 *    inverses come from the cluster TransformLink, and three's skinning is
 *    Σw·(boneWorld·boneInverse)·bindMatrix, so boneWorld = inverse(boneInverse)
 *    at bind time in both cases).
 * 2. The parent's bind world `P` is its own `G` when it is a joint, else the
 *    parent's actual world matrix from the file's node transforms (composed
 *    through any bind-posed joints above it).
 * 3. `bone.matrix = inverse(P)·G_i`, decomposed, parents first. Joints shared
 *    by several skins keep the first bind transform; disagreeing inverse bind
 *    matrices (> 1e-3) are reported.
 * 4. Non-joint ancestors keep their file transforms.
 *
 * `Skeleton.pose()` is deliberately not used: it copies the bind world matrix
 * into the local matrix of every bone whose parent is not a `Bone`, which
 * double-applies any transform on a non-bone ancestor (the sample rig's
 * `BaseArmature` carries a +90° X rotation).
 *
 * Call with the loader root at identity, before any normalization. Rigs without
 * skins keep their node transforms.
 */
export function applyBindPose(root: Object3D, opts: { exclude?: (obj: Object3D) => boolean } = {}): { warnings: string[]; jointCount: number } {
  const warnings: string[] = [];
  root.updateMatrixWorld(true);
  const targets = new Map<Object3D, Matrix4>();
  for (const { skeleton } of collectSkeletons(root, opts.exclude ?? defaultExclude)) {
    for (let i = 0; i < skeleton.bones.length; i++) {
      const bone = skeleton.bones[i];
      const inv = skeleton.boneInverses[i];
      if (!bone || !inv) continue;
      const world = new Matrix4().copy(inv).invert();
      if (!Number.isFinite(world.elements[0]) || !Number.isFinite(world.elements[15])) continue;
      const prev = targets.get(bone);
      if (prev) {
        const d = maxAbsDiff(prev, world);
        if (d > 1e-3) warnings.push(`Joint '${bone.name}' is shared by several skins whose inverse bind matrices disagree (max diff ${d.toExponential(1)}); keeping the first.`);
        continue;
      }
      targets.set(bone, world);
    }
  }
  if (targets.size === 0) return { warnings, jointCount: 0 };

  // Parent-first ordering so a parent's world matrix is settled before its children.
  const ordered: Object3D[] = [];
  root.traverse((obj) => {
    if (targets.has(obj)) ordered.push(obj);
  });

  // World matrix of any node given the joints already placed: joints use their
  // bind world, everything else composes its file transform on its parent.
  const worldCache = new Map<Object3D, Matrix4>();
  const worldOf = (obj: Object3D): Matrix4 => {
    const t = targets.get(obj);
    if (t) return t;
    const cached = worldCache.get(obj);
    if (cached) return cached;
    let m: Matrix4;
    if (obj === root || !obj.parent) m = obj.matrixWorld.clone();
    else m = new Matrix4().multiplyMatrices(worldOf(obj.parent), obj.matrix);
    worldCache.set(obj, m);
    return m;
  };

  for (const bone of ordered) {
    const world = targets.get(bone)!;
    const parent = bone.parent;
    if (parent) {
      _inv.copy(worldOf(parent)).invert();
      _mat.multiplyMatrices(_inv, world);
    } else {
      _mat.copy(world);
    }
    _mat.decompose(bone.position, bone.quaternion, bone.scale);
    bone.updateMatrix();
  }
  root.updateMatrixWorld(true);
  return { warnings, jointCount: targets.size };
}

/**
 * Sums the skin weight per joint over every skinned mesh under `root`
 * (each geometry/skeleton pair counted once). Joints of every skeleton are
 * present in the map (weight 0 when unweighted).
 */
export function computeSkinWeights(root: Object3D, exclude: (obj: Object3D) => boolean = defaultExclude): Map<Object3D, number> {
  const weights = new Map<Object3D, number>();
  const seen = new Set<string>();
  for (const { skeleton, meshes } of collectSkeletons(root, exclude)) {
    for (const bone of skeleton.bones) if (bone && !weights.has(bone)) weights.set(bone, 0);
    for (const mesh of meshes) {
      const geom = mesh.geometry;
      if (!geom) continue;
      const key = `${geom.uuid}|${skeleton.uuid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const idx = geom.getAttribute('skinIndex');
      const wgt = geom.getAttribute('skinWeight');
      if (!idx || !wgt) continue;
      const n = Math.min(idx.count, wgt.count);
      const items = Math.min(idx.itemSize, wgt.itemSize);
      for (let v = 0; v < n; v++) {
        for (let k = 0; k < items; k++) {
          const w = wgt.getComponent(v, k);
          if (!(w > 0)) continue;
          const bone = skeleton.bones[idx.getComponent(v, k)];
          if (!bone) continue;
          weights.set(bone, (weights.get(bone) ?? 0) + w);
        }
      }
    }
  }
  return weights;
}

export interface SkinGroup {
  /** Joints of every skin in the group (skins sharing at least one joint are merged). */
  joints: Set<Object3D>;
  /** Summed skin weight of the group. */
  weight: number;
  skinCount: number;
}

/**
 * Groups skins that share at least one joint and returns the groups sorted by
 * summed weight (largest first). The first group is the primary skeleton.
 */
export function groupSkins(skins: readonly { joints: readonly Object3D[] }[], weights: ReadonlyMap<Object3D, number>): SkinGroup[] {
  const parent = skins.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const owner = new Map<Object3D, number>();
  skins.forEach((skin, i) => {
    for (const j of skin.joints) {
      const o = owner.get(j);
      if (o === undefined) owner.set(j, i);
      else parent[find(i)] = find(o);
    }
  });
  const groups = new Map<number, SkinGroup>();
  skins.forEach((skin, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = { joints: new Set(), weight: 0, skinCount: 0 };
      groups.set(r, g);
    }
    g.skinCount++;
    for (const j of skin.joints) g.joints.add(j);
  });
  for (const g of groups.values()) for (const j of g.joints) g.weight += weights.get(j) ?? 0;
  return [...groups.values()].sort((a, b) => b.weight - a.weight || b.joints.size - a.joints.size);
}

/** Primary skeleton joints and warnings about secondary skeletons for a loaded object tree. */
export function selectPrimarySkeleton(root: Object3D, exclude: (obj: Object3D) => boolean = defaultExclude): { joints: Set<Object3D>; weights: Map<Object3D, number>; skinnedMeshCount: number; warnings: string[] } {
  const skeletons = collectSkeletons(root, exclude);
  const weights = computeSkinWeights(root, exclude);
  const groups = groupSkins(skeletons.map((s) => ({ joints: s.skeleton.bones })), weights);
  const warnings: string[] = [];
  const joints = groups.length ? groups[0].joints : new Set<Object3D>();
  for (let i = 1; i < groups.length; i++) {
    const g = groups[i];
    const sample = [...g.joints].slice(0, 3).map((j) => `'${j.name}'`).join(', ');
    warnings.push(`Secondary skeleton ignored (${g.joints.size} joints, ${g.skinCount} skin(s), weight ${g.weight.toFixed(1)}; e.g. ${sample}).`);
  }
  let skinnedMeshCount = 0;
  for (const s of skeletons) skinnedMeshCount += s.meshes.length;
  return { joints, weights, skinnedMeshCount, warnings };
}

const _pos = new Vector3();
const _quat = new Quaternion();

function isNonBoneLeafObject(obj: Object3D): boolean {
  return !!(obj as Mesh).isMesh || !!(obj as Light).isLight || !!(obj as Camera).isCamera;
}

/**
 * Collects every named descendant of `root` (bones, empties, tail markers;
 * never meshes, lights or cameras) into a {@link SkeletonGraph}. World
 * transforms are read after `root.updateMatrixWorld(true)`, so call
 * {@link applyBindPose} first when the rest pose should be the bind pose.
 * Unnamed bones receive a stable placeholder name (`Bone_<n>`) so they can be
 * addressed by the map.
 */
export function buildGraphFromObject3D(root: Object3D, opts: BuildGraphOptions = {}): SkeletonGraph {
  root.updateMatrixWorld(true);
  const exclude = opts.exclude ?? defaultExclude;
  const warnings = opts.warnings ? [...opts.warnings] : [];
  const weights = opts.weights;
  const joints = opts.joints;

  const indexOf = new Map<Object3D, number>();
  const objects: Object3D[] = [];
  let unnamed = 0;
  const visit = (obj: Object3D): void => {
    if (obj !== root) {
      if (exclude(obj)) return;
      if (!isNonBoneLeafObject(obj)) {
        if (!obj.name && (obj as Bone).isBone) obj.name = `Bone_${++unnamed}`;
        if (obj.name) {
          indexOf.set(obj, objects.length);
          objects.push(obj);
        }
      }
    }
    for (const c of obj.children) visit(c);
  };
  visit(root);
  if (unnamed > 0) warnings.push(`${unnamed} unnamed bone(s) were given placeholder names.`);

  const nodes: SkeletonNode[] = objects.map((obj, index) => {
    obj.getWorldPosition(_pos);
    obj.getWorldQuaternion(_quat);
    let p: Object3D | null = obj.parent;
    let parent = -1;
    while (p && p !== root) {
      const pi = indexOf.get(p);
      if (pi !== undefined) {
        parent = pi;
        break;
      }
      p = p.parent;
    }
    const isJoint = joints ? joints.has(obj) : !!(obj as Bone).isBone;
    const weight = weights ? (weights.get(obj) ?? 0) : isJoint ? 1 : 0;
    return {
      index,
      name: obj.name,
      parent,
      children: [],
      restPos: [_pos.x, _pos.y, _pos.z],
      restQuat: [_quat.x, _quat.y, _quat.z, _quat.w],
      isJoint,
      weight,
    };
  });
  const graph = finalizeGraph(nodes);
  graph.hasSkinWeights = !!weights && weights.size > 0;
  graph.skinnedMeshCount = opts.skinnedMeshCount ?? 0;
  graph.warnings = warnings;
  return graph;
}

/** Fills children/roots for a node list whose `parent` fields are set. */
export function finalizeGraph(nodes: SkeletonNode[]): SkeletonGraph {
  const roots: number[] = [];
  for (const n of nodes) n.children = [];
  for (const n of nodes) {
    if (n.parent >= 0 && n.parent < nodes.length && n.parent !== n.index) nodes[n.parent].children.push(n.index);
    else roots.push(n.index);
  }
  return { nodes, roots, hasSkinWeights: false, skinnedMeshCount: 0, warnings: [] };
}

/** Largest axis-aligned extent of the rest positions. */
export function graphExtent(graph: SkeletonGraph): number {
  if (graph.nodes.length === 0) return 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const n of graph.nodes) {
    for (let i = 0; i < 3; i++) {
      if (n.restPos[i] < min[i]) min[i] = n.restPos[i];
      if (n.restPos[i] > max[i]) max[i] = n.restPos[i];
    }
  }
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** True when `descendant` lies in the subtree of `ancestor` (not equal). */
export function isDescendant(graph: SkeletonGraph, descendant: number, ancestor: number): boolean {
  let p = graph.nodes[descendant]?.parent ?? -1;
  while (p >= 0) {
    if (p === ancestor) return true;
    p = graph.nodes[p].parent;
  }
  return false;
}

/** Indices of every node in the subtree of `index`, excluding the node itself. */
export function subtree(graph: SkeletonGraph, index: number): number[] {
  const out: number[] = [];
  const stack = [...graph.nodes[index].children];
  while (stack.length) {
    const i = stack.pop()!;
    out.push(i);
    for (const c of graph.nodes[i].children) stack.push(c);
  }
  return out;
}

/** Depth (number of links) of the longest path from `index` down to a leaf. */
export function subtreeDepth(graph: SkeletonGraph, index: number): number {
  let best = 0;
  for (const c of graph.nodes[index].children) best = Math.max(best, 1 + subtreeDepth(graph, c));
  return best;
}

/** Ancestors from the parent upward. */
export function ancestors(graph: SkeletonGraph, index: number): number[] {
  const out: number[] = [];
  let p = graph.nodes[index].parent;
  while (p >= 0) {
    out.push(p);
    p = graph.nodes[p].parent;
  }
  return out;
}

/** Lowest common ancestor of the given nodes (a node is its own ancestor), or -1. */
export function lca(graph: SkeletonGraph, indices: readonly number[]): number {
  if (indices.length === 0) return -1;
  let common: number[] | null = null;
  for (const i of indices) {
    const chain = [i, ...ancestors(graph, i)];
    if (!common) {
      common = chain;
      continue;
    }
    const set = new Set(chain);
    common = common.filter((c) => set.has(c));
    if (common.length === 0) return -1;
  }
  return common ? common[0] : -1;
}

/** Nodes strictly below `ancestor` down to and including `descendant`, top first. Empty when unrelated. */
export function pathDown(graph: SkeletonGraph, ancestor: number, descendant: number): number[] {
  const out: number[] = [];
  let cur = descendant;
  while (cur >= 0 && cur !== ancestor) {
    out.push(cur);
    cur = graph.nodes[cur].parent;
  }
  if (cur !== ancestor) return [];
  return out.reverse();
}

export function findNodeByName(graph: SkeletonGraph, name: string): SkeletonNode | undefined {
  return graph.nodes.find((n) => n.name === name);
}

/** Convenience: world position of a node as a Vector3. */
export function nodePos(graph: SkeletonGraph, index: number, out = new Vector3()): Vector3 {
  return out.fromArray(graph.nodes[index].restPos);
}

/** Length of the link from `index` to `child`. */
export function linkLength(graph: SkeletonGraph, index: number, child: number): number {
  const a = graph.nodes[index].restPos;
  const b = graph.nodes[child].restPos;
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** Sum of link lengths over the subtree of `index` (all descendants). */
export function subtreeLength(graph: SkeletonGraph, index: number): number {
  let total = 0;
  const stack = [index];
  while (stack.length) {
    const i = stack.pop()!;
    for (const c of graph.nodes[i].children) {
      total += linkLength(graph, i, c);
      stack.push(c);
    }
  }
  return total;
}

/** True when the graph has at least one skin joint. */
export function hasJoints(graph: SkeletonGraph): boolean {
  return graph.nodes.some((n) => n.isJoint);
}

/** Node index per name (first occurrence wins, matching the mapping rule for duplicates). */
export function nodeIndexByName(graph: SkeletonGraph): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of graph.nodes) if (!out.has(n.name)) out.set(n.name, n.index);
  return out;
}

/**
 * Builds the rig graph of a loaded object tree: primary skeleton selection
 * (docs/DESIGN.md §5.2), skin weights and the graph itself. When the tree has
 * no skinned mesh at all, every `Bone` counts as a joint (armature-only
 * exports, synthetic test rigs) and weights are unknown.
 *
 * Call after {@link applyBindPose} so the rest transforms are the bind pose.
 */
export function buildRigGraph(root: Object3D, exclude: (obj: Object3D) => boolean = defaultExclude): SkeletonGraph {
  const sel = selectPrimarySkeleton(root, exclude);
  if (sel.joints.size === 0) return buildGraphFromObject3D(root, { exclude, skinnedMeshCount: sel.skinnedMeshCount, warnings: sel.warnings });
  return buildGraphFromObject3D(root, { joints: sel.joints, weights: sel.weights, exclude, skinnedMeshCount: sel.skinnedMeshCount, warnings: sel.warnings });
}
