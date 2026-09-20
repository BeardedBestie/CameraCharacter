/**
 * Browser-only model loading (docs/DESIGN.md §5.1): GLB/glTF (DRACO, KTX2,
 * Meshopt), FBX (Phong/Lambert -> MeshStandardMaterial, sRGB maps, unit scale
 * factor recorded) and VRM (three-vrm with `autoUpdateHumanBones: false`,
 * `rotateVRM0`, `combineSkeletons`, raw humanoid bone map, normalized proxy
 * root excluded from bone collection). Object URLs are revoked. Unrigged
 * models load like any other (no skin, no hint).
 *
 * The analysis lives in `analyzeModel.ts` / `restPose.ts`, which are Node-safe.
 */
import { Material, Mesh, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial, Object3D, SRGBColorSpace, SkinnedMesh, Texture, WebGLRenderer } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { HumanoidBone, HumanoidMap } from '../core/types';
import { HUMANOID_BONES } from '../core/types';
import type { LoadedModel, ModelFormat } from './analyzeModel';

export type { LoadedModel, ModelFormat } from './analyzeModel';

export interface LoadModelOptions {
  onProgress?: (fraction: number) => void;
  /** Needed for KTX2 transcoder support detection; optional. */
  renderer?: WebGLRenderer;
  /** Override the format detection (by extension). */
  format?: ModelFormat;
}

export const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
export const KTX2_TRANSCODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/basis/';

let dracoLoader: DRACOLoader | null = null;
let ktx2Loader: KTX2Loader | null = null;

function getDraco(): DRACOLoader {
  if (!dracoLoader) dracoLoader = new DRACOLoader().setDecoderPath(DRACO_DECODER_PATH);
  return dracoLoader;
}

function getKtx2(renderer?: WebGLRenderer): KTX2Loader {
  if (!ktx2Loader) ktx2Loader = new KTX2Loader().setTranscoderPath(KTX2_TRANSCODER_PATH);
  if (renderer) ktx2Loader.detectSupport(renderer);
  return ktx2Loader;
}

/** Format from a file name / URL extension. */
export function detectFormat(name: string): ModelFormat | null {
  const clean = name.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith('.glb')) return 'glb';
  if (clean.endsWith('.gltf')) return 'gltf';
  if (clean.endsWith('.fbx')) return 'fbx';
  if (clean.endsWith('.vrm')) return 'vrm';
  return null;
}

/** Builds a GLTFLoader with DRACO, KTX2 and Meshopt support (and the VRM plugin when asked). */
export function createGltfLoader(opts: { renderer?: WebGLRenderer; vrm?: boolean } = {}): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(getDraco());
  loader.setKTX2Loader(getKtx2(opts.renderer));
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (opts.vrm) loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: false }));
  return loader;
}

function collectSkinnedMeshes(root: Object3D): SkinnedMesh[] {
  const out: SkinnedMesh[] = [];
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh) {
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = false;
      out.push(m);
    }
  });
  return out;
}

function recordMeshNames(root: Object3D): void {
  const names: string[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh && o.name) names.push(o.name);
  });
  root.userData.meshNames = names;
}

/** Role -> raw bone node name from a VRM humanoid (VRM bone names equal ours). */
export function humanoidHintFromVrm(vrm: VRM): HumanoidMap {
  const map: HumanoidMap = {};
  for (const role of HUMANOID_BONES) {
    const node = vrm.humanoid.getRawBoneNode(role as HumanoidBone);
    if (node && node.name) map[role] = node.name;
  }
  return map;
}

/**
 * Converts FBX Phong/Lambert materials to `MeshStandardMaterial` (color, map,
 * normalMap, emissive, alphaMap, opacity, transparent, side; roughness 0.75,
 * metalness 0; color maps tagged sRGB) so FBX models light like glTF models
 * and export as PBR.
 */
export function convertFbxMaterials(root: Object3D): number {
  let converted = 0;
  const cache = new Map<Material, MeshStandardMaterial>();
  const convert = (m: Material): Material => {
    const src = m as MeshPhongMaterial | MeshLambertMaterial;
    if (!(src as MeshPhongMaterial).isMeshPhongMaterial && !(src as MeshLambertMaterial).isMeshLambertMaterial) return m;
    const hit = cache.get(m);
    if (hit) return hit;
    const out = new MeshStandardMaterial({
      color: src.color.clone(),
      map: src.map ?? null,
      normalMap: src.normalMap ?? null,
      emissive: src.emissive ? src.emissive.clone() : undefined,
      emissiveMap: src.emissiveMap ?? null,
      alphaMap: src.alphaMap ?? null,
      opacity: src.opacity,
      transparent: src.transparent,
      side: src.side,
      roughness: 0.75,
      metalness: 0,
    });
    out.name = src.name;
    if (src.normalScale) out.normalScale.copy(src.normalScale);
    out.alphaTest = src.alphaTest;
    out.depthWrite = src.depthWrite;
    out.vertexColors = src.vertexColors;
    for (const tex of [out.map, out.emissiveMap] as (Texture | null)[]) if (tex) tex.colorSpace = SRGBColorSpace;
    cache.set(m, out);
    converted++;
    return out;
  };
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(convert);
    else if (mesh.material) mesh.material = convert(mesh.material);
  });
  return converted;
}

function progressHandler(opts: LoadModelOptions): ((e: ProgressEvent) => void) | undefined {
  if (!opts.onProgress) return undefined;
  return (e) => {
    if (e.lengthComputable && e.total > 0) opts.onProgress!(Math.min(1, e.loaded / e.total));
  };
}

async function loadGltf(url: string, format: 'glb' | 'gltf' | 'vrm', name: string, opts: LoadModelOptions): Promise<LoadedModel> {
  const loader = createGltfLoader({ renderer: opts.renderer, vrm: format === 'vrm' });
  const gltf: GLTF = await loader.loadAsync(url, progressHandler(opts));
  const root = gltf.scene;
  root.userData.generator = gltf.asset?.generator;
  const vrm = (gltf.userData as { vrm?: VRM }).vrm;
  if (format === 'vrm' && vrm) {
    if (vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
    VRMUtils.combineSkeletons(root);
    // The normalized proxy skeleton is not part of the rig.
    const proxy = vrm.humanoid.normalizedHumanBonesRoot;
    proxy.userData.excludeFromRig = true;
    root.updateMatrixWorld(true);
    recordMeshNames(root);
    opts.onProgress?.(1);
    return { root, name, format, skinnedMeshes: collectSkinnedMeshes(root), animations: gltf.animations, humanoidHint: humanoidHintFromVrm(vrm), vrm };
  }
  root.updateMatrixWorld(true);
  recordMeshNames(root);
  opts.onProgress?.(1);
  return { root, name, format: format === 'vrm' ? 'glb' : format, skinnedMeshes: collectSkinnedMeshes(root), animations: gltf.animations };
}

async function loadFbx(url: string, name: string, opts: LoadModelOptions): Promise<LoadedModel> {
  const loader = new FBXLoader();
  const group = await loader.loadAsync(url, progressHandler(opts));
  convertFbxMaterials(group);
  group.updateMatrixWorld(true);
  recordMeshNames(group);
  const usf = (group.userData as { unitScaleFactor?: number }).unitScaleFactor;
  opts.onProgress?.(1);
  return {
    root: group,
    name,
    format: 'fbx',
    skinnedMeshes: collectSkinnedMeshes(group),
    animations: group.animations ?? [],
    unitScaleFactor: typeof usf === 'number' && Number.isFinite(usf) ? usf : undefined,
  };
}

/** Loads a model from a URL. The format is taken from the extension unless overridden. */
export async function loadModelFromUrl(url: string, opts: LoadModelOptions = {}): Promise<LoadedModel> {
  const format = opts.format ?? detectFormat(url);
  if (!format) throw new Error(`Unsupported model format: ${url}`);
  const name = url.split(/[?#]/)[0].split('/').pop() || url;
  if (format === 'fbx') return loadFbx(url, name, opts);
  return loadGltf(url, format, name, opts);
}

/** Loads a model from a `File` (drag & drop / file picker). The object URL is revoked afterwards. */
export async function loadModelFromFile(file: File, opts: LoadModelOptions = {}): Promise<LoadedModel> {
  const format = opts.format ?? detectFormat(file.name);
  if (!format) throw new Error(`Unsupported model format: ${file.name}`);
  if (format === 'gltf') throw new Error('Drop a self-contained .glb; a .gltf with external buffers/textures cannot be loaded from a single file.');
  const url = URL.createObjectURL(file);
  try {
    const model = await loadModelFromUrl(url, { ...opts, format });
    return { ...model, name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Loads a model from a `File` or a URL string. */
export function loadModel(source: File | string, opts: LoadModelOptions = {}): Promise<LoadedModel> {
  if (typeof source === 'string') return loadModelFromUrl(source, opts);
  return loadModelFromFile(source, opts);
}

/** Releases the shared decoder workers (call on app shutdown). */
export function disposeLoaders(): void {
  dracoLoader?.dispose();
  dracoLoader = null;
  ktx2Loader?.dispose();
  ktx2Loader = null;
}
