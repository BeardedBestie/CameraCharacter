/**
 * Minimal, Node-safe GLB reader that reconstructs a rig's node hierarchy and
 * bind pose without WebGL, images or materials. Used by the unit tests on
 * `public/models/sample-meshy.glb` and usable anywhere a skeleton-only view of
 * a GLB is enough (e.g. profile precomputation in a script).
 *
 * Bind pose: for every skin joint the world matrix is `inverse(IBM)`. Per the
 * glTF specification the skinned mesh node's own transform is ignored for
 * skinning (vertices live in the skin's bind space, which is scene space), so
 * the inverse bind matrices directly give scene-space joint transforms; this
 * matches three.js' GLTFLoader, which binds skinned meshes with an identity
 * bind matrix.
 */
import { Bone, Box3, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { Vec3Tuple } from '../core/types';
import { buildGraphFromObject3D, type SkeletonGraph } from './skeletonGraph';

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
interface GltfJson {
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
  /** Bind-pose mesh extent along +Y (glTF's up axis), when any mesh has bounds. */
  meshHeight?: number;
  /** Bind-pose axis-aligned bounds of all meshes in scene space. */
  meshBounds?: { min: Vec3Tuple; max: Vec3Tuple };
  /** The parsed glTF JSON (for callers that need extras/asset info). */
  json: unknown;
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

function readFloatAccessor(json: GltfJson, bin: Uint8Array | null, index: number): Float32Array {
  const acc = json.accessors?.[index];
  if (!acc) throw new Error(`Accessor ${index} missing.`);
  if (acc.componentType !== 5126) throw new Error(`Accessor ${index} is not float32.`);
  const n = TYPE_SIZE[acc.type];
  const out = new Float32Array(acc.count * n);
  if (acc.bufferView === undefined || !bin) return out; // all zeros per spec when no bufferView
  const bv = json.bufferViews?.[acc.bufferView];
  if (!bv) throw new Error(`BufferView ${acc.bufferView} missing.`);
  if (bv.buffer !== 0) throw new Error('Only the embedded GLB buffer is supported.');
  const elemBytes = n * COMPONENT_SIZE[acc.componentType];
  const stride = bv.byteStride ?? elemBytes;
  const base = bin.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(bin.buffer, 0, bin.buffer.byteLength);
  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride;
    for (let k = 0; k < n; k++) out[i * n + k] = dv.getFloat32(at + k * 4, true);
  }
  return out;
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
 * returns the reconstructed `Object3D` tree, the {@link SkeletonGraph} and the
 * bind-pose mesh bounds.
 */
export function readGlbSkeleton(bytes: ArrayBuffer | Uint8Array): GlbSkeletonResult {
  const { json, bin } = parseGlbChunks(bytes);
  const nodes = json.nodes ?? [];
  const joints = new Set<number>();
  for (const skin of json.skins ?? []) for (const j of skin.joints) joints.add(j);

  const objects: Object3D[] = nodes.map((n, i) => {
    const obj = joints.has(i) ? new Bone() : new Object3D();
    obj.name = n.name ?? (joints.has(i) ? `joint_${i}` : `node_${i}`);
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

  // Original world matrices (for non-skinned mesh bounds).
  const originalWorld = objects.map((o) => o.matrixWorld.clone());

  // Bind pose from inverse bind matrices.
  const targets = new Map<Object3D, Matrix4>();
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices === undefined) {
      // No IBMs: identity, i.e. the node transforms are the bind pose already.
      continue;
    }
    const ibm = readFloatAccessor(json, bin, skin.inverseBindMatrices);
    skin.joints.forEach((j, k) => {
      const obj = objects[j];
      if (!obj || targets.has(obj)) return;
      const world = new Matrix4().fromArray(ibm, k * 16).invert();
      if (!Number.isFinite(world.elements[0])) return;
      targets.set(obj, world);
    });
  }
  if (targets.size > 0) {
    const ordered: Object3D[] = [];
    root.traverse((o) => {
      if (targets.has(o)) ordered.push(o);
    });
    const local = new Matrix4();
    const parentInv = new Matrix4();
    for (const obj of ordered) {
      const world = targets.get(obj)!;
      const parent = obj.parent;
      if (parent) {
        parentInv.copy(targets.get(parent) ?? parent.matrixWorld).invert();
        local.multiplyMatrices(parentInv, world);
      } else local.copy(world);
      local.decompose(obj.position, obj.quaternion, obj.scale);
      obj.updateMatrix();
    }
    root.updateMatrixWorld(true);
  }

  // Mesh bounds in bind space.
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
        if (acc.componentType !== 5126) continue;
        const data = readFloatAccessor(json, bin, pi);
        min = [Infinity, Infinity, Infinity];
        max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < data.length; v += 3) {
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

  const result: GlbSkeletonResult = { root, graph: buildGraphFromObject3D(root), json };
  if (any) {
    result.meshBounds = { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
    result.meshHeight = box.max.y - box.min.y;
    root.userData.bindBounds = result.meshBounds;
  }
  return result;
}
