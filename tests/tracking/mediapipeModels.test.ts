import { describe, expect, it } from 'vitest';
import {
  CDN_WASM_PATH,
  LOCAL_WASM_PATH,
  MODEL_ASSETS,
  loadModelAsset,
  localModelUrl,
  looksLikeTaskBundle,
  poseModelAsset,
  resolveWasmBasePath,
  type FetchLike,
} from '../../src/tracking/mediapipeModels';

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
/** The first bytes of Google's published pose_landmarker_full.task: two NUL bytes, then the zip signature. */
const PUBLISHED = new Uint8Array([0x00, 0x00, 0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0xa7, 0x05, 0x9c, 0x56]);
const HTML = new TextEncoder().encode('<!doctype html><html></html>');

function response(body: Uint8Array | null, init: { status?: number; type?: string } = {}): Response {
  const headers = new Headers();
  if (init.type) headers.set('content-type', init.type);
  return new Response(body ? body.slice().buffer : null, { status: init.status ?? 200, headers });
}

describe('model asset table', () => {
  it('maps variants to the documented URLs', () => {
    expect(poseModelAsset('lite')).toBe('pose_lite');
    expect(poseModelAsset('full')).toBe('pose_full');
    expect(poseModelAsset('heavy')).toBe('pose_heavy');
    expect(MODEL_ASSETS.pose_full.url).toBe(
      'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    );
    expect(MODEL_ASSETS.hand.url).toBe(
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    );
    expect(MODEL_ASSETS.face.url).toBe(
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    );
    expect(localModelUrl('hand')).toBe('/models/mediapipe/hand_landmarker.task');
  });

  it('looksLikeTaskBundle rejects HTML fallbacks', () => {
    expect(looksLikeTaskBundle('application/octet-stream', ZIP)).toBe(true);
    expect(looksLikeTaskBundle(null, ZIP)).toBe(true);
    expect(looksLikeTaskBundle('text/html', ZIP)).toBe(false);
    expect(looksLikeTaskBundle(null, HTML)).toBe(false);
    expect(looksLikeTaskBundle(null, new TextEncoder().encode('\n  <!doctype html>'))).toBe(false);
    expect(looksLikeTaskBundle(null, new Uint8Array([1]))).toBe(false);
  });

  it('looksLikeTaskBundle accepts the published bundles (zip signature after a two-byte prefix)', () => {
    expect(looksLikeTaskBundle('application/octet-stream', PUBLISHED)).toBe(true);
    expect(looksLikeTaskBundle(null, PUBLISHED)).toBe(true);
  });

  it('looksLikeTaskBundle accepts a large non-HTML body and refuses a small unknown one', () => {
    const big = new Uint8Array(300 * 1024).fill(0x11);
    expect(looksLikeTaskBundle('application/octet-stream', big)).toBe(true);
    expect(looksLikeTaskBundle(null, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
  });
});

describe('loadModelAsset', () => {
  it('prefers the self-hosted copy', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return response(ZIP, { type: 'application/octet-stream' });
    };
    const bytes = await loadModelAsset('hand', { fetch: fetchImpl, useCache: false });
    expect(Array.from(bytes)).toEqual(Array.from(ZIP));
    expect(calls).toEqual(['/models/mediapipe/hand_landmarker.task']);
  });

  it('falls back to the remote URL when the local copy is an HTML fallback page', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.startsWith('/models/')) return response(HTML, { type: 'text/html' });
      return response(ZIP, { type: 'application/octet-stream' });
    };
    const bytes = await loadModelAsset('pose_lite', { fetch: fetchImpl, useCache: false });
    expect(bytes[0]).toBe(0x50);
    expect(calls).toEqual(['/models/mediapipe/pose_landmarker_lite.task', MODEL_ASSETS.pose_lite.url]);
  });

  it('accepts the bytes Google actually serves', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.startsWith('/models/')) return response(HTML, { type: 'text/html' });
      return response(PUBLISHED, { type: 'application/octet-stream' });
    };
    const bytes = await loadModelAsset('pose_full', { fetch: fetchImpl, useCache: false });
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 0x50, 0x4b]);
  });

  it('throws when nothing is reachable', async () => {
    const fetchImpl: FetchLike = async () => response(null, { status: 404 });
    await expect(loadModelAsset('face', { fetch: fetchImpl, useCache: false })).rejects.toThrow(/HTTP 404/);
    const failing: FetchLike = async () => {
      throw new Error('offline');
    };
    await expect(loadModelAsset('face', { fetch: failing, useCache: false })).rejects.toThrow(/offline/);
  });
});

describe('resolveWasmBasePath', () => {
  it('uses the local path when the probe succeeds and the CDN otherwise', async () => {
    const local: FetchLike = async (_url, init) => {
      expect(init?.method).toBe('HEAD');
      return response(null, { status: 200, type: 'text/javascript' });
    };
    expect(await resolveWasmBasePath(local)).toBe(LOCAL_WASM_PATH);
    const missing: FetchLike = async () => response(null, { status: 404 });
    expect(await resolveWasmBasePath(missing)).toBe(CDN_WASM_PATH);
    const html: FetchLike = async () => response(null, { status: 200, type: 'text/html' });
    expect(await resolveWasmBasePath(html)).toBe(CDN_WASM_PATH);
    const throwing: FetchLike = async () => {
      throw new Error('network');
    };
    expect(await resolveWasmBasePath(throwing)).toBe(CDN_WASM_PATH);
  });

  it('retries with GET when HEAD is not allowed', async () => {
    const methods: string[] = [];
    const f: FetchLike = async (_url, init) => {
      methods.push(String(init?.method));
      if (init?.method === 'HEAD') return response(null, { status: 405 });
      return response(null, { status: 200, type: 'text/javascript' });
    };
    expect(await resolveWasmBasePath(f)).toBe(LOCAL_WASM_PATH);
    expect(methods).toEqual(['HEAD', 'GET']);
  });
});
