/**
 * Environment loading (docs/DESIGN.md §8): a GLB/glTF scene the character
 * stands in. Browser only (GLTFLoader with DRACO, KTX2 and Meshopt decoders,
 * object URLs for File inputs).
 */
import { Object3D, Vector3, type WebGLRenderer } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { enableShadows, findSpawn } from './placement';

export const ENV_DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
export const ENV_KTX2_TRANSCODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/basis/';

export interface LoadedEnvironment {
  root: Object3D;
  /** World position of the 'spawn' empty, or null when the scene has none. */
  spawn: Vector3 | null;
  /** Source name (file name or URL) for display. */
  name: string;
  /** Animations found in the file (not played by the stage; available to the app). */
  animations: GLTF['animations'];
}

export interface LoadEnvironmentOptions {
  /** Lets the KTX2 loader pick a GPU-compatible transcode target. */
  renderer?: WebGLRenderer;
  onProgress?: (fraction: number) => void;
  /** Cast/receive shadows on every mesh (default true). */
  shadows?: boolean;
}

let draco: DRACOLoader | null = null;
let ktx2: KTX2Loader | null = null;

function getDraco(): DRACOLoader {
  if (!draco) draco = new DRACOLoader().setDecoderPath(ENV_DRACO_DECODER_PATH);
  return draco;
}

function getKtx2(renderer?: WebGLRenderer): KTX2Loader {
  if (!ktx2) ktx2 = new KTX2Loader().setTranscoderPath(ENV_KTX2_TRANSCODER_PATH);
  if (renderer) ktx2.detectSupport(renderer);
  return ktx2;
}

/** A GLTFLoader with DRACO, KTX2 and Meshopt support. */
export function createEnvironmentLoader(renderer?: WebGLRenderer): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(getDraco());
  loader.setKTX2Loader(getKtx2(renderer));
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** Releases the shared decoder workers (call when the app shuts down). */
export function disposeEnvironmentLoaders(): void {
  draco?.dispose();
  draco = null;
  ktx2?.dispose();
  ktx2 = null;
}

function isFile(source: string | File): source is File {
  return typeof File !== 'undefined' && source instanceof File;
}

/**
 * Loads a `.glb`/`.gltf` environment from a URL or a File. Meshes get shadows,
 * the spawn marker (an object named 'spawn', case-insensitive) is hidden and
 * its world position returned.
 */
export async function loadEnvironment(source: string | File, opts: LoadEnvironmentOptions = {}): Promise<LoadedEnvironment> {
  const loader = createEnvironmentLoader(opts.renderer);
  const name = isFile(source) ? source.name : source;
  const url = isFile(source) ? URL.createObjectURL(source) : source;
  const onProgress = opts.onProgress
    ? (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0) opts.onProgress!(Math.min(1, e.loaded / e.total));
      }
    : undefined;
  let gltf: GLTF;
  try {
    gltf = await loader.loadAsync(url, onProgress);
  } finally {
    if (isFile(source)) URL.revokeObjectURL(url);
  }
  const root = gltf.scene;
  root.name = root.name || name;
  if (opts.shadows !== false) enableShadows(root);
  const spawn = findSpawn(root);
  root.traverse((node) => {
    if (node.name.trim().toLowerCase() === 'spawn') node.visible = false;
  });
  return { root, spawn, name, animations: gltf.animations };
}
