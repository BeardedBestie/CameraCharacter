/**
 * Browser-only model loading (docs/DESIGN.md §5.1): GLB/glTF (DRACO, KTX2,
 * Meshopt), FBX and VRM. Not imported by the pure analysis modules, so the
 * rest of `src/rig` stays testable in Node.
 */
import { AnimationClip, Object3D, SkinnedMesh, WebGLRenderer } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { HumanoidBone, HumanoidMap } from '../core/types';
import { HUMANOID_BONES } from '../core/types';

export type ModelFormat = 'glb' | 'gltf' | 'fbx' | 'vrm';

export interface LoadedModel {
  root: Object3D;
  format: ModelFormat;
  skinnedMeshes: SkinnedMesh[];
  animations: AnimationClip[];
  /** The three-vrm `VRM` instance for .vrm files. */
  vrm?: VRM;
  /** Role -> bone name taken from the VRM humanoid definition. */
  humanoidHint?: HumanoidMap;
  /** File or URL name the model was loaded from. */
  sourceName: string;
}

export interface LoadModelOptions {
  /** Needed for KTX2 texture support detection; optional. */
  renderer?: WebGLRenderer;
  /** Override the format detection (by extension). */
  format?: ModelFormat;
  /** Merge VRM skeletons into one (`VRMUtils.combineSkeletons`), default true. */
  combineVrmSkeletons?: boolean;
  onProgress?: (fraction: number) => void;
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
  if (opts.vrm) loader.register((parser) => new VRMLoaderPlugin(parser));
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

/** Role -> raw bone node name from a VRM humanoid (VRM bone names equal ours). */
export function humanoidHintFromVrm(vrm: VRM): HumanoidMap {
  const map: HumanoidMap = {};
  for (const role of HUMANOID_BONES) {
    const node = vrm.humanoid.getRawBoneNode(role as HumanoidBone);
    if (node && node.name) map[role] = node.name;
  }
  return map;
}

function progressHandler(opts: LoadModelOptions): ((e: ProgressEvent) => void) | undefined {
  if (!opts.onProgress) return undefined;
  return (e) => {
    if (e.lengthComputable && e.total > 0) opts.onProgress!(Math.min(1, e.loaded / e.total));
  };
}

async function loadGltf(url: string, format: 'glb' | 'gltf' | 'vrm', sourceName: string, opts: LoadModelOptions): Promise<LoadedModel> {
  const loader = createGltfLoader({ renderer: opts.renderer, vrm: format === 'vrm' });
  const gltf: GLTF = await loader.loadAsync(url, progressHandler(opts));
  const root = gltf.scene;
  const vrm = (gltf.userData as { vrm?: VRM }).vrm;
  if (format === 'vrm' && vrm) {
    if (vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
    if (opts.combineVrmSkeletons !== false) VRMUtils.combineSkeletons(root);
    root.updateMatrixWorld(true);
    return {
      root,
      format,
      skinnedMeshes: collectSkinnedMeshes(root),
      animations: gltf.animations,
      vrm,
      humanoidHint: humanoidHintFromVrm(vrm),
      sourceName,
    };
  }
  root.updateMatrixWorld(true);
  return { root, format: format === 'vrm' ? 'glb' : format, skinnedMeshes: collectSkinnedMeshes(root), animations: gltf.animations, sourceName };
}

async function loadFbx(url: string, sourceName: string, opts: LoadModelOptions): Promise<LoadedModel> {
  const loader = new FBXLoader();
  const group = await loader.loadAsync(url, progressHandler(opts));
  group.updateMatrixWorld(true);
  return { root: group, format: 'fbx', skinnedMeshes: collectSkinnedMeshes(group), animations: group.animations ?? [], sourceName };
}

/** Loads a model from a URL. The format is taken from the extension unless overridden. */
export async function loadModelFromUrl(url: string, opts: LoadModelOptions = {}): Promise<LoadedModel> {
  const format = opts.format ?? detectFormat(url);
  if (!format) throw new Error(`Unsupported model format: ${url}`);
  const sourceName = url.split(/[?#]/)[0].split('/').pop() || url;
  if (format === 'fbx') return loadFbx(url, sourceName, opts);
  return loadGltf(url, format, sourceName, opts);
}

/** Loads a model from a `File` (drag & drop / file picker). Object URLs are revoked afterwards. */
export async function loadModelFromFile(file: File, opts: LoadModelOptions = {}): Promise<LoadedModel> {
  const format = opts.format ?? detectFormat(file.name);
  if (!format) throw new Error(`Unsupported model format: ${file.name}`);
  if (format === 'gltf') throw new Error('Drop a self-contained .glb; a .gltf with external buffers/textures cannot be loaded from a single file.');
  const url = URL.createObjectURL(file);
  try {
    const model = await loadModelFromUrl(url, { ...opts, format });
    return { ...model, sourceName: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Releases the shared decoder workers (call on app shutdown). */
export function disposeLoaders(): void {
  dracoLoader?.dispose();
  dracoLoader = null;
  ktx2Loader?.dispose();
  ktx2Loader = null;
}
