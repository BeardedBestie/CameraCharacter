/**
 * Minimal, Node-safe GLB reader that reconstructs a rig's node hierarchy,
 * bind pose, skin weights and bind-space mesh extents without WebGL, images or
 * materials. Used by the unit tests on the bundled models and usable anywhere
 * a skeleton-only view of a GLB is enough (profile precomputation scripts).
 *
 * Bind pose: exactly {@link applyBindPose}: for every skin joint the bind
 * world matrix is `inverse(IBM)` composed against the parent's bind world (a
 * joint) or the parent's file transform (a non-joint), parents first. Per the
 * glTF specification a skinned mesh node's own transform is ignored for
 * skinning (three's GLTFLoader binds with the identity matrix), so the inverse
 * bind matrices directly give scene-space joint transforms and skinned
 * geometry bounds are already in bind space.
 */
import { Bone, Box3, BufferGeometry, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import type { Vec3Tuple } from '../core/types';
import { buildGraphFromObject3D, groupSkins, type SkeletonGraph } from './skeletonGraph';

interface GltfNode {
  name?: string;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  mesh?: number;
  skin?: number;
}
interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  normalized?: boolean;
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
export interface GltfJson {
  scene?: number;
  scenes?: { name?: string; nodes?: number[] }[];
  nodes?: GltfNode[];
  skins?: { name?: string; joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number> }[] }[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  asset?: { version?: string; generator?: string };
}

export interface GlbSkeletonResult {
  /** Container holding the scene's root nodes; joints are `Bone`s, other nodes plain `Object3D`s. */
  root: Object3D;
  graph: SkeletonGraph;
  /** Summed skin weight per joint object. */
  weights: Map<Object3D, number>;
  /** Alias of {@link weights}. */
  skinWeights: Map<Object3D, number>;
  /** Joints of the primary skeleton group. */
  joints: Set<Object3D>;
  /** Every skin of the file: joint objects and their inverse bind matrices (identity when the file has none). */
  skins: { joints: Object3D[]; inverseBindMatrices: Matrix4[] }[];
  /** Bind-pose mesh extent along +Y, when any mesh has bounds. */
  meshHeight?: number;
  /** Bind-space axis-aligned bounds of all meshes (skinned: bind space; static: node transforms). */
  meshBounds?: { min: Vec3Tuple; max: Vec3Tuple };
  /** Names of mesh nodes (family hints). */
  meshNames: string[];
  skinnedMeshCount: number;
  generator?: string;
  json: GltfJson;
  warnings: string[];
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function toUint8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Splits a GLB into its JSON and BIN chunks. */
export function parseGlbChunks(bytes: ArrayBuffer | Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
  const u8 = toUint8(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < 20 || dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB file (bad magic).');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`Unsupported GLB version ${version}.`);
  const total = Math.min(dv.getUint32(8, true), u8.byteLength);
  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= total) {
    const len = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + len > u8.byteLength) throw new Error('Truncated GLB chunk.');
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder('utf-8').decode(u8.subarray(start, start + len))) as GltfJson;
    } else if (type === CHUNK_BIN && !bin) {
      bin = u8.subarray(start, start + len);
    }
    offset = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('GLB has no JSON chunk.');
  return { json, bin };
}

/** Reads any numeric accessor as plain numbers (normalized integers are denormalized). */
function readAccessor(json: GltfJson, bin: Uint8Array | null, index: number): { data: Float64Array; n: number; count: number } {
  const acc = json.accessors?.[index];
  if (!acc) throw new Error(`Accessor ${index} missing.`);
  const n = TYPE_SIZE[acc.type];
  const compSize = COMPONENT_SIZE[acc.componentType];
  if (!n || !compSize) throw new Error(`Accessor ${index} has an unsupported type.`);
  const data = new Float64Array(acc.count * n);
  if (acc.bufferView === undefined || !bin) return { data, n, count: acc.count }; // all zeros per spec
  const bv = json.bufferViews?.[acc.bufferView];
  if (!bv) throw new Error(`BufferView ${acc.bufferView} missing.`);
  if (bv.buffer !== 0) throw new Error('Only the embedded GLB buffer is supported.');
  const elemBytes = n * compSize;
  const stride = bv.byteStride ?? elemBytes;
  const base = bin.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(bin.buffer, 0, bin.buffer.byteLength);
  const read = (at: number): number => {
    switch (acc.componentType) {
      case 5120:
        return acc.normalized ? Math.max(dv.getInt8(at) / 127, -1) : dv.getInt8(at);
      case 5121:
        return acc.normalized ? dv.getUint8(at) / 255 : dv.getUint8(at);
      case 5122:
        return acc.normalized ? Math.max(dv.getInt16(at, true) / 32767, -1) : dv.getInt16(at, true);
      case 5123:
        return acc.normalized ? dv.getUint16(at, true) / 65535 : dv.getUint16(at, true);
      case 5125:
        return dv.getUint32(at, true);
      default:
        return dv.getFloat32(at, true);
    }
  };
  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride;
    for (let k = 0; k < n; k++) data[i * n + k] = read(at + k * compSize);
  }
  return { data, n, count: acc.count };
}

function nodeLocalMatrix(node: GltfNode, out = new Matrix4()): Matrix4 {
  if (node.matrix && node.matrix.length === 16) return out.fromArray(node.matrix);
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return out.compose(new Vector3(t[0], t[1], t[2]), new Quaternion(r[0], r[1], r[2], r[3]), new Vector3(s[0], s[1], s[2]));
}

/**
 * Reads a GLB's node hierarchy, puts skinned joints into their bind pose and
 * returns the reconstructed `Object3D` tree, the {@link SkeletonGraph} with
 * skin weights, and the bind-pose mesh bounds.
 */
export function readGlbSkeleton(bytes: ArrayBuffer | Uint8Array): GlbSkeletonResult {
  const { json, bin } = parseGlbChunks(bytes);
  const warnings: string[] = [];
  const nodes = json.nodes ?? [];
  const skins = json.skins ?? [];
  const jointSet = new Set<number>();
  for (const skin of skins) for (const j of skin.joints) jointSet.add(j);

  const objects: Object3D[] = nodes.map((n, i) => {
    // Mesh nodes become (empty) meshes so they leave the skeleton graph exactly as in the browser.
    const obj = jointSet.has(i) ? new Bone() : n.mesh !== undefined ? new Mesh(new BufferGeometry()) : new Object3D();
    obj.name = n.name ?? (jointSet.has(i) ? `joint_${i}` : `node_${i}`);
    nodeLocalMatrix(n).decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrix();
    return obj;
  });
  const hasParent = new Set<number>();
  nodes.forEach((n, i) => {
    for (const c of n.children ?? []) {
      objects[i].add(objects[c]);
      hasParent.add(c);
    }
  });
  const root = new Object3D();
  const sceneIndex = json.scene ?? 0;
  const scene = json.scenes?.[sceneIndex];
  root.name = scene?.name ?? 'Scene';
  const sceneRoots = scene?.nodes ?? nodes.map((_, i) => i).filter((i) => !hasParent.has(i));
  for (const i of sceneRoots) if (!hasParent.has(i)) root.add(objects[i]);
  root.updateMatrixWorld(true);

  // Original world matrices (for static mesh bounds).
  const originalWorld = objects.map((o) => o.matrixWorld.clone());

  // Bind pose from inverse bind matrices (same procedure as applyBindPose).
  const targets = new Map<Object3D, Matrix4>();
  const skinRecords: GlbSkeletonResult['skins'] = [];
  for (const skin of skins) {
    const jointObjs = skin.joints.map((j) => objects[j]).filter((o): o is Object3D => !!o);
    if (skin.inverseBindMatrices === undefined) {
      // Identity IBMs: the node transforms are the bind pose.
      skinRecords.push({ joints: jointObjs, inverseBindMatrices: jointObjs.map(() => new Matrix4()) });
      continue;
    }
    const { data } = readAccessor(json, bin, skin.inverseBindMatrices);
    const ibms: Matrix4[] = [];
    skin.joints.forEach((j, k) => {
      const obj = objects[j];
      if (!obj) return;
      const ibm = new Matrix4().fromArray(Array.from(data.subarray(k * 16, k * 16 + 16)));
      ibms.push(ibm);
      const world = ibm.clone().invert();
      if (!Number.isFinite(world.elements[0])) return;
      const prev = targets.get(obj);
      if (prev) {
        let d = 0;
        for (let e = 0; e < 16; e++) d = Math.max(d, Math.abs(prev.elements[e] - world.elements[e]));
        if (d > 1e-3) warnings.push(`Joint '${obj.name}' is shared by several skins whose inverse bind matrices disagree (max diff ${d.toExponential(1)}); keeping the first.`);
        return;
      }
      targets.set(obj, world);
    });
    skinRecords.push({ joints: jointObjs, inverseBindMatrices: ibms });
  }
  if (targets.size > 0) {
    const ordered: Object3D[] = [];
    root.traverse((o) => {
      if (targets.has(o)) ordered.push(o);
    });
    const worldCache = new Map<Object3D, Matrix4>();
    const worldOf = (obj: Object3D): Matrix4 => {
      const t = targets.get(obj);
      if (t) return t;
      const c = worldCache.get(obj);
      if (c) return c;
      const m = obj === root || !obj.parent ? obj.matrixWorld.clone() : new Matrix4().multiplyMatrices(worldOf(obj.parent), obj.matrix);
      worldCache.set(obj, m);
      return m;
    };
    const local = new Matrix4();
    const parentInv = new Matrix4();
    for (const obj of ordered) {
      const world = targets.get(obj)!;
      if (obj.parent) {
        parentInv.copy(worldOf(obj.parent)).invert();
        local.multiplyMatrices(parentInv, world);
      } else local.copy(world);
      local.decompose(obj.position, obj.quaternion, obj.scale);
      obj.updateMatrix();
    }
    root.updateMatrixWorld(true);
  }

  // Skin weights per joint (JOINTS_n / WEIGHTS_n over every skinned mesh node).
  const weights = new Map<Object3D, number>();
  for (const skin of skins) for (const j of skin.joints) if (objects[j]) weights.set(objects[j], weights.get(objects[j]) ?? 0);
  const meshNames: string[] = [];
  let skinnedMeshCount = 0;
  const seenMeshSkin = new Set<string>();
  nodes.forEach((n) => {
    if (n.mesh === undefined) return;
    const mesh = json.meshes?.[n.mesh];
    if (!mesh) return;
    if (n.name) meshNames.push(n.name);
    if (n.skin === undefined) return;
    skinnedMeshCount++;
    const key = `${n.mesh}|${n.skin}`;
    if (seenMeshSkin.has(key)) return;
    seenMeshSkin.add(key);
    const skin = skins[n.skin];
    if (!skin) return;
    for (const prim of mesh.primitives) {
      for (let set = 0; ; set++) {
        const ji = prim.attributes?.[`JOINTS_${set}`];
        const wi = prim.attributes?.[`WEIGHTS_${set}`];
        if (ji === undefined || wi === undefined) break;
        const J = readAccessor(json, bin, ji);
        const W = readAccessor(json, bin, wi);
        const count = Math.min(J.count, W.count);
        const comps = Math.min(J.n, W.n);
        for (let v = 0; v < count; v++) {
          for (let k = 0; k < comps; k++) {
            const w = W.data[v * W.n + k];
            if (!(w > 0)) continue;
            const jointNode = skin.joints[J.data[v * J.n + k]];
            const obj = jointNode !== undefined ? objects[jointNode] : undefined;
            if (!obj) continue;
            weights.set(obj, (weights.get(obj) ?? 0) + w);
          }
        }
      }
    }
  });
  const groups = groupSkins(
    skins.map((s) => ({ joints: s.joints.map((j) => objects[j]).filter((o): o is Object3D => !!o) })),
    weights,
  );
  const joints = groups.length ? groups[0].joints : new Set<Object3D>();
  for (let g = 1; g < groups.length; g++) {
    const sample = [...groups[g].joints].slice(0, 3).map((j) => `'${j.name}'`).join(', ');
    warnings.push(`Secondary skeleton ignored (${groups[g].joints.size} joints, weight ${groups[g].weight.toFixed(1)}; e.g. ${sample}).`);
  }

  // Mesh bounds: bind space for skinned meshes (identity), node transforms for static meshes.
  const box = new Box3();
  let any = false;
  const corner = new Vector3();
  nodes.forEach((n, i) => {
    if (n.mesh === undefined) return;
    const mesh = json.meshes?.[n.mesh];
    if (!mesh) return;
    const xform = n.skin !== undefined ? new Matrix4() : originalWorld[i];
    for (const prim of mesh.primitives) {
      const pi = prim.attributes?.POSITION;
      if (pi === undefined) continue;
      const acc = json.accessors?.[pi];
      if (!acc) continue;
      let min = acc.min;
      let max = acc.max;
      if (!min || !max || min.length < 3 || max.length < 3) {
        const { data, n: comps } = readAccessor(json, bin, pi);
        min = [Infinity, Infinity, Infinity];
        max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < data.length; v += comps) {
          for (let k = 0; k < 3; k++) {
            if (data[v + k] < min[k]) min[k] = data[v + k];
            if (data[v + k] > max[k]) max[k] = data[v + k];
          }
        }
        if (!Number.isFinite(min[0])) continue;
      }
      for (let c = 0; c < 8; c++) {
        corner.set(c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]);
        corner.applyMatrix4(xform);
        box.expandByPoint(corner);
        any = true;
      }
    }
  });

  const graph = buildGraphFromObject3D(root, { joints, weights, skinnedMeshCount, warnings });
  const result: GlbSkeletonResult = { root, graph, weights, skinWeights: weights, joints, skins: skinRecords, meshNames, skinnedMeshCount, generator: json.asset?.generator, json, warnings: graph.warnings };
  if (any) {
    result.meshBounds = { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
    result.meshHeight = box.max.y - box.min.y;
    root.userData.bindBounds = result.meshBounds;
  }
  root.userData.generator = json.asset?.generator;
  root.userData.meshNames = meshNames;
  return result;
}
