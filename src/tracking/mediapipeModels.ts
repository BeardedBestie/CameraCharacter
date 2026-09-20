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
  /** Diagnostic lines (which location answered, with what). */
  log?: (message: string) => void;
}

function defaultFetch(): FetchLike {
  if (typeof fetch !== 'function') throw new Error('fetch is not available in this environment');
  return (input, init) => fetch(input, init);
}

/** Smallest plausible bundle: the lite pose model is 5.5 MB, a dev server's HTML fallback page a few KB. */
const MIN_TASK_BYTES = 256 * 1024;
/** How far into the body the zip signature may sit (the published files carry a two-byte prefix). */
const ZIP_SIGNATURE_WINDOW = 16;

/**
 * True when a response plausibly holds a `.task` bundle. Dev servers answer
 * unknown paths with the SPA's index.html (status 200), so that page must be
 * refused. A `.task` file is a zip archive, but Google's published bundles
 * start with two NUL bytes before the "PK\x03\x04" signature, so the signature
 * is searched within the first bytes rather than required at offset 0. Any
 * other large non-HTML body is accepted as well, so a future container format
 * does not make the loader refuse a genuine download again.
 */
export function looksLikeTaskBundle(contentType: string | null, bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (contentType && /text\/html/i.test(contentType)) return false;
  const last = Math.min(bytes.length - 4, ZIP_SIGNATURE_WINDOW);
  for (let i = 0; i <= last; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) return true;
  }
  let j = 0;
  while (j < bytes.length && (bytes[j] === 0x20 || bytes[j] === 0x09 || bytes[j] === 0x0a || bytes[j] === 0x0d)) j++;
  if (bytes[j] === 0x3c /* '<' */) return false;
  return bytes.length >= MIN_TASK_BYTES;
}

/**
 * The first bytes of a body for diagnostics: the text itself when it is
 * printable (an HTML block page, a JSON error), otherwise hex.
 */
export function previewBytes(bytes: Uint8Array, chars = 80): string {
  const head = bytes.subarray(0, chars);
  const printable = head.length > 0 && head.every((b) => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b < 0x7f));
  if (printable) return JSON.stringify(new TextDecoder().decode(head).replace(/\s+/g, ' ').trim());
  return Array.from(bytes.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** "HTTP 200, text/html, 1532 bytes, starts with ..." for error messages and logs. */
export function describeBody(res: Pick<Response, 'status' | 'headers'>, bytes: Uint8Array): string {
  const type = res.headers.get('content-type') ?? 'no content-type';
  return `HTTP ${res.status}, ${type}, ${bytes.length} bytes, starts with ${previewBytes(bytes)}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchBytes(fetchImpl: FetchLike, url: string): Promise<{ bytes: Uint8Array | null; reason: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { cache: 'default' });
  } catch (err) {
    return { bytes: null, reason: `network error: ${errorText(err)}` };
  }
  if (!res.ok) return { bytes: null, reason: `HTTP ${res.status}` };
  const buf = new Uint8Array(await res.arrayBuffer());
  if (looksLikeTaskBundle(res.headers.get('content-type'), buf)) return { bytes: buf, reason: '' };
  return { bytes: null, reason: `not a task bundle (${describeBody(res, buf)})` };
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
  const say = options.log ?? (() => {});
  const tag = `model ${asset.basename}`;

  options.onProgress?.('local', name);
  const localUrl = localModelUrl(name);
  const local = await fetchBytes(fetchImpl, localUrl);
  if (local.bytes) {
    say(`${tag}: self-hosted copy at ${localUrl} (${local.bytes.length} bytes)`);
    return local.bytes;
  }
  say(`${tag}: no self-hosted copy at ${localUrl} (${local.reason})`);

  const cache = useCache ? await openCache() : null;
  if (cache) {
    options.onProgress?.('cache', name);
    try {
      const hit = await cache.match(asset.url);
      if (hit && hit.ok) {
        const buf = new Uint8Array(await hit.arrayBuffer());
        if (looksLikeTaskBundle(hit.headers.get('content-type'), buf)) {
          say(`${tag}: served from the browser cache (${buf.length} bytes)`);
          return buf;
        }
        say(`${tag}: cached entry unusable, re-downloading`);
      }
    } catch {
      // A broken cache entry is not fatal; fall through to the network.
    }
  }

  options.onProgress?.('remote', name);
  say(`${tag}: downloading ${asset.url}`);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(asset.url);
  } catch (err) {
    throw new Error(`Failed to download ${asset.basename} from ${asset.url}: ${errorText(err)}`);
  }
  if (!res.ok) throw new Error(`Failed to download ${asset.basename}: HTTP ${res.status} from ${asset.url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!looksLikeTaskBundle(res.headers.get('content-type'), bytes)) {
    throw new Error(
      `Downloaded ${asset.basename} from ${asset.url} is not a MediaPipe task bundle (${describeBody(res, bytes)}). ` +
        'Something between this browser and Google\'s storage answered instead of the file (proxy, content filter, captive portal); ' +
        'see README "Troubleshooting a start-up problem" for self-hosting the models.',
    );
  }
  say(`${tag}: downloaded ${bytes.length} bytes in ${Date.now() - started} ms`);
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
export async function resolveWasmBasePath(fetchImpl: FetchLike = defaultFetch(), log?: (message: string) => void): Promise<string> {
  const probe = `${LOCAL_WASM_PATH}/${WASM_PROBE_FILE}`;
  const ok = (res: Response) => {
    if (!res.ok) return false;
    const ct = res.headers.get('content-type');
    return !(ct && /text\/html/i.test(ct));
  };
  let reason = '';
  try {
    const head = await fetchImpl(probe, { method: 'HEAD' });
    if (ok(head)) {
      log?.(`MediaPipe WASM runtime: local copy at ${LOCAL_WASM_PATH}`);
      return LOCAL_WASM_PATH;
    }
    if (head.status === 405 || head.status === 501) {
      const get = await fetchImpl(probe, { method: 'GET' });
      if (ok(get)) {
        log?.(`MediaPipe WASM runtime: local copy at ${LOCAL_WASM_PATH}`);
        return LOCAL_WASM_PATH;
      }
      reason = `HTTP ${get.status} ${get.headers.get('content-type') ?? ''}`.trim();
    } else {
      reason = `HTTP ${head.status} ${head.headers.get('content-type') ?? ''}`.trim();
    }
  } catch (err) {
    reason = errorText(err);
  }
  log?.(`MediaPipe WASM runtime: no local copy at ${probe} (${reason}); using the CDN ${CDN_WASM_PATH}`);
  return CDN_WASM_PATH;
}
