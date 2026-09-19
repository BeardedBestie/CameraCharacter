/**
 * Pure skeleton data model used by the rig analysis.
 *
 * A {@link SkeletonGraph} is a flat, index-addressed snapshot of a bone
 * hierarchy with world-space rest (bind pose) transforms. It carries no
 * three.js objects, so the mapper and the topology analysis can run in Node
 * and be unit-tested against synthetic rigs.
 *
 * Only the three.js *math* classes and the `Object3D` type are used here;
 * nothing touches the DOM.
 */
import { Bone, Matrix4, Object3D, Quaternion, SkinnedMesh, Skeleton, Vector3 } from 'three';
import type { QuatTuple, Vec3Tuple } from '../core/types';
import { fnv1a } from '../core/math';

export interface SkeletonNode {
  /** Index in {@link SkeletonGraph.nodes}. Parents always precede children. */
  index: number;
  name: string;
  /** Parent index, or -1 for a root. */
  parent: number;
  children: number[];
  /** World position in the bind pose. */
  restPos: Vec3Tuple;
  /** World quaternion in the bind pose. */
  restQuat: QuatTuple;
}

export interface SkeletonGraph {
  nodes: SkeletonNode[];
  /** Indices of nodes without a parent in the graph. */
  roots: number[];
  /**
   * Estimated meters per model unit from the skeleton's extent (1 for a
   * meter-scale rig, 0.01 for a centimeter rig, 0.0254 for inches...).
   * Undefined when the extent is degenerate.
   */
  unitHint?: number;
}

export interface BuildGraphOptions {
  /**
   * Include named non-bone nodes even when the hierarchy contains `Bone`
   * objects. When the model has no bones at all, every named node is included
   * regardless of this flag.
   */
  includeNonBones?: boolean;
}

const _pos = new Vector3();
const _quat = new Quaternion();
const _mat = new Matrix4();
const _parentInv = new Matrix4();

/**
 * Puts every skeleton under `root` into its bind pose and refreshes world
 * matrices, so that a graph built afterwards reflects the pose the skin
 * weights were painted for (see docs/DESIGN.md §5.3).
 *
 * This deliberately does not call `Skeleton.pose()`: that helper copies the
 * bind world matrix into the *local* matrix of every bone whose parent is not
 * a `Bone`, which is wrong whenever the top bone hangs under a transformed
 * node (the Meshy sample's `BaseArmature` carries a +90° X rotation, so the
 * skeleton would end up rotated twice). Here the bind world matrix
 * `inverse(boneInverse)` is converted to a local matrix against the parent's
 * actual world matrix instead. Each skeleton is processed once; a bone shared
 * by several skinned meshes keeps the first bind transform seen.
 */
export function applyBindPose(root: Object3D): void {
  root.updateMatrixWorld(true);
  const targets = new Map<Object3D, Matrix4>();
  const seen = new Set<Skeleton>();
  root.traverse((obj) => {
    const mesh = obj as SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const skeleton = mesh.skeleton;
    if (seen.has(skeleton)) return;
    seen.add(skeleton);
    for (let i = 0; i < skeleton.bones.length; i++) {
      const bone = skeleton.bones[i];
      const inv = skeleton.boneInverses[i];
      if (!bone || !inv || targets.has(bone)) continue;
      const world = new Matrix4().copy(inv).invert();
      if (!isFinite(world.elements[0])) continue;
      targets.set(bone, world);
    }
  });
  if (targets.size === 0) return;

  // Parent-first ordering so a parent's world matrix is settled before its children.
  const ordered: Object3D[] = [];
  root.traverse((obj) => {
    if (targets.has(obj)) ordered.push(obj);
  });
  for (const bone of ordered) {
    const world = targets.get(bone)!;
    const parent = bone.parent;
    if (parent) {
      const parentWorld = targets.get(parent) ?? parent.matrixWorld;
      _parentInv.copy(parentWorld).invert();
      _mat.multiplyMatrices(_parentInv, world);
    } else {
      _mat.copy(world);
    }
    _mat.decompose(bone.position, bone.quaternion, bone.scale);
    bone.updateMatrix();
  }
  root.updateMatrixWorld(true);
}

/**
 * Collects the bone hierarchy under `root` into a {@link SkeletonGraph}.
 * World transforms are read with `getWorldPosition` / `getWorldQuaternion`
 * after `root.updateMatrixWorld(true)`, so call {@link applyBindPose} first
 * when the rest pose should be the bind pose.
 */
export function buildGraphFromObject3D(root: Object3D, opts: BuildGraphOptions = {}): SkeletonGraph {
  root.updateMatrixWorld(true);
  let hasBones = false;
  root.traverse((obj) => {
    if ((obj as Bone).isBone) hasBones = true;
  });
  const includeAll = !hasBones || !!opts.includeNonBones;

  const indexOf = new Map<Object3D, number>();
  const objects: Object3D[] = [];
  root.traverse((obj) => {
    const isBone = !!(obj as Bone).isBone;
    if (!isBone && !(includeAll && obj.name && !(obj as SkinnedMesh).isMesh)) return;
    if (!isBone && obj === root && !opts.includeNonBones) return;
    indexOf.set(obj, objects.length);
    objects.push(obj);
  });

  const nodes: SkeletonNode[] = objects.map((obj, index) => {
    obj.getWorldPosition(_pos);
    obj.getWorldQuaternion(_quat);
    let p: Object3D | null = obj.parent;
    let parent = -1;
    while (p) {
      const pi = indexOf.get(p);
      if (pi !== undefined) {
        parent = pi;
        break;
      }
      p = p.parent;
    }
    return {
      index,
      name: obj.name,
      parent,
      children: [],
      restPos: [_pos.x, _pos.y, _pos.z],
      restQuat: [_quat.x, _quat.y, _quat.z, _quat.w],
    };
  });
  return finalizeGraph(nodes);
}

/** Fills children/roots and the unit hint for a node list whose `parent` fields are set. */
export function finalizeGraph(nodes: SkeletonNode[]): SkeletonGraph {
  const roots: number[] = [];
  for (const n of nodes) n.children = [];
  for (const n of nodes) {
    if (n.parent >= 0 && n.parent < nodes.length) nodes[n.parent].children.push(n.index);
    else roots.push(n.index);
  }
  const graph: SkeletonGraph = { nodes, roots };
  const extent = graphExtent(graph);
  if (extent > 0) graph.unitHint = unitHintFromExtent(extent);
  return graph;
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

/** Guesses meters-per-unit from a humanoid extent (height-ish) in model units. */
export function unitHintFromExtent(extent: number): number {
  if (!(extent > 0)) return 1;
  if (extent >= 0.4 && extent <= 4) return 1;
  if (extent > 4 && extent < 40) return 0.1;
  if (extent >= 40 && extent <= 400) return 0.01;
  if (extent > 400) return 0.001;
  return 1;
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

export function findNodeByName(graph: SkeletonGraph, name: string): SkeletonNode | undefined {
  return graph.nodes.find((n) => n.name === name);
}

/**
 * Stable hash of the bone hierarchy: FNV-1a over the sorted `child<parent`
 * name pairs. Independent of node order, positions and units, so a re-export
 * of the same rig yields the same profile key.
 */
export function fingerprintGraph(graph: SkeletonGraph): string {
  const pairs = graph.nodes.map((n) => `${n.name}<${n.parent >= 0 ? graph.nodes[n.parent].name : ''}`);
  pairs.sort();
  return fnv1a(pairs.join('\n'));
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
