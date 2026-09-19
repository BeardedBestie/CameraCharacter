/**
 * MediaPipe Tasks model assets and WASM runtime location.
 *
 * `.task` bundles are fetched from a self-hosted copy under
 * `public/models/mediapipe/` when present, otherwise from Google's storage,
 * and cached with the Cache API so the app works offline after the first run.
 * The WASM runtime is served from `public/mediapipe/wasm` (copied from
 * node_modules by vite.config.ts) with a CDN fallback.
 *
 * Uses only `fetch` and (optionally) `caches`, so it loads in Node for tests;
 * a custom `fetch` can be injected.
 */
import type { PoseModelVariant } from '../core/types';

export type ModelAssetName = 'pose_lite' | 'pose_full' | 'pose_heavy' | 'hand' | 'face';

export interface ModelAsset {
  /** File name of the .task bundle (used for the self-hosted path). */
  basename: string;
  /** Canonical remote URL. */
  url: string;
}

const POSE_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';

export const MODEL_ASSETS: Readonly<Record<ModelAssetName, ModelAsset>> = {
  pose_lite: {
    basename: 'pose_landmarker_lite.task',
    url: `${POSE_BASE}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  },
  pose_full: {
    basename: 'pose_landmarker_full.task',
    url: `${POSE_BASE}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  },
  pose_heavy: {
    basename: 'pose_landmarker_heavy.task',
    url: `${POSE_BASE}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
  },
  hand: {
    basename: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
  face: {
    basename: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
};

/** Directory (URL path) of the self-hosted model copies. */
export const LOCAL_MODEL_DIR = '/models/mediapipe';
/** Cache API bucket name for downloaded model bytes. */
export const MODEL_CACHE_NAME = 'cameracharacter-models';

export const MEDIAPIPE_VERSION = '1.0.1';
export const LOCAL_WASM_PATH = '/mediapipe/wasm';
export const CDN_WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
/** The file the FilesetResolver loads first; used to probe the local copy. */
export const WASM_PROBE_FILE = 'vision_wasm_internal.js';

export function poseModelAsset(variant: PoseModelVariant): ModelAssetName {
  switch (variant) {
    case 'lite':
      return 'pose_lite';
    case 'heavy':
      return 'pose_heavy';
    case 'full':
    default:
      return 'pose_full';
  }
}

export function localModelUrl(name: ModelAssetName): string {
  return `${LOCAL_MODEL_DIR}/${MODEL_ASSETS[name].basename}`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LoadModelOptions {
  /** Injected fetch (tests, Node). Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Use the Cache API when available (default true). */
  useCache?: boolean;
  /** Progress callback with the step being attempted. */
  onProgress?: (step: 'local' | 'cache' | 'remote', name: ModelAssetName) => void;
}

function defaultFetch(): FetchLike {
  if (typeof fetch !== 'function') throw new Error('fetch is not available in this environment');
  return (input, init) => fetch(input, init);
}

/**
 * True when a response plausibly holds a `.task` bundle. Dev servers answer
 * unknown paths with the SPA's index.html (status 200), so the content type
 * and the first bytes are checked: a `.task` file is a zip archive ("PK").
 */
export function looksLikeTaskBundle(contentType: string | null, bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (contentType && /text\/html/i.test(contentType)) return false;
  if (bytes[0] === 0x3c /* '<' */) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4b; // 'P' 'K'
}

async function fetchBytes(fetchImpl: FetchLike, url: string): Promise<Uint8Array | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, { cache: 'default' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return looksLikeTaskBundle(res.headers.get('content-type'), buf) ? buf : null;
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined' || !caches || typeof caches.open !== 'function') return null;
  try {
    return await caches.open(MODEL_CACHE_NAME);
  } catch {
    return null;
  }
}

/**
 * Load a model bundle: self-hosted copy → Cache API → remote URL (stored in
 * the cache on success). Throws when every location fails.
 */
export async function loadModelAsset(name: ModelAssetName, options: LoadModelOptions = {}): Promise<Uint8Array> {
  const asset = MODEL_ASSETS[name];
  if (!asset) throw new Error(`Unknown model asset "${String(name)}"`);
  const fetchImpl = options.fetch ?? defaultFetch();
  const useCache = options.useCache ?? true;

  options.onProgress?.('local', name);
  const local = await fetchBytes(fetchImpl, localModelUrl(name));
  if (local) return local;

  const cache = useCache ? await openCache() : null;
  if (cache) {
    options.onProgress?.('cache', name);
    try {
      const hit = await cache.match(asset.url);
      if (hit && hit.ok) {
        const buf = new Uint8Array(await hit.arrayBuffer());
        if (looksLikeTaskBundle(hit.headers.get('content-type'), buf)) return buf;
      }
    } catch {
      // A broken cache entry is not fatal; fall through to the network.
    }
  }

  options.onProgress?.('remote', name);
  let res: Response;
  try {
    res = await fetchImpl(asset.url);
  } catch (err) {
    throw new Error(`Failed to download ${asset.basename}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`Failed to download ${asset.basename}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!looksLikeTaskBundle(res.headers.get('content-type'), bytes)) {
    throw new Error(`Downloaded ${asset.basename} is not a MediaPipe task bundle`);
  }
  if (cache) {
    try {
      const headers = new Headers({ 'content-type': 'application/octet-stream' });
      await cache.put(asset.url, new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, headers }));
    } catch {
      // Quota or private-mode failures are ignored; the bytes are still usable.
    }
  }
  return bytes;
}

/**
 * Resolve the base path for `FilesetResolver.forVisionTasks`: the local copy
 * when `/mediapipe/wasm/vision_wasm_internal.js` is reachable, else the CDN.
 */
export async function resolveWasmBasePath(fetchImpl: FetchLike = defaultFetch()): Promise<string> {
  const probe = `${LOCAL_WASM_PATH}/${WASM_PROBE_FILE}`;
  const ok = (res: Response) => {
    if (!res.ok) return false;
    const ct = res.headers.get('content-type');
    return !(ct && /text\/html/i.test(ct));
  };
  try {
    const head = await fetchImpl(probe, { method: 'HEAD' });
    if (ok(head)) return LOCAL_WASM_PATH;
    if (head.status === 405 || head.status === 501) {
      const get = await fetchImpl(probe, { method: 'GET' });
      if (ok(get)) return LOCAL_WASM_PATH;
    }
  } catch {
    // fall through to the CDN
  }
  return CDN_WASM_PATH;
}
