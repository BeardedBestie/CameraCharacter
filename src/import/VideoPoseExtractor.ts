/**
 * Offline pose extraction from a video clip (docs/DESIGN.md §17.2). Browser
 * only. The clip is decoded by the browser's own media stack: a detached
 * <video> element is stepped frame by frame with accurate seeks (every
 * `seeked` event presents the exact frame for that media time) and each
 * frame is run through the MediaPipe landmarkers in VIDEO mode. The result is
 * an ordinary `.mocap.json` recording whose frame times are media times, so it
 * plays in the live app's recording source and re-targets onto any model.
 *
 * Processing is deterministic and independent of the clip's frame rate or
 * the machine's speed: the sampling plan (frameStepper.ts) decides which
 * media times are analysed.
 */
import type { FaceLandmarkerResult, HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type { FaceFrame, HandFrame, MocapRecording, PoseFrame, PoseModelVariant, VideoMeta } from '../core/types';
import { MEDIAPIPE_VERSION } from '../tracking/mediapipeModels';
import { assignHandSides, blendshapesToRecord, landmarksToTuples, makeHandFrame, matrixToArray, pointsToTuples, type DetectedHandLike } from '../tracking/convert';
import { createLandmarkers, type Delegate } from './landmarkers';
import { MonotonicTimestamps, estimateRemainingMs, planSamples, sampleTime, type SamplePlan } from './frameStepper';

export const VIDEO_IMPORT_SRC = 'video-import';

/** Accepted container extensions (the browser decides what it can actually decode). */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'ogg', 'avi', 'mpg', 'mpeg', '3gp'];

export function isVideoFile(file: { name: string; type?: string }): boolean {
  if (file.type && file.type.startsWith('video/')) return true;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return VIDEO_EXTENSIONS.includes(ext);
}

export interface LoadedVideo {
  video: HTMLVideoElement;
  /** Object URL to revoke when the clip is discarded (null for remote URLs). */
  objectUrl: string | null;
  durationMs: number;
  width: number;
  height: number;
}

export interface ExtractOptions {
  source: Blob | string;
  fileName?: string;
  /** Already loaded element for `source` (skips loading). */
  loaded?: LoadedVideo;
  /** Samples per second of media time (default 30). */
  fps?: number;
  startSec?: number;
  endSec?: number;
  poseModel?: PoseModelVariant;
  delegate?: Delegate;
  hands?: boolean;
  face?: boolean;
  onProgress?: (p: ExtractProgress) => void;
  signal?: AbortSignal;
}

export type ExtractPhase = 'loading' | 'models' | 'frames' | 'done';

export interface ExtractProgress {
  phase: ExtractPhase;
  message: string;
  /** Frames analysed so far / planned. */
  frame: number;
  total: number;
  /** Media time of the last analysed frame (ms) and the clip duration (ms). */
  mediaTimeMs: number;
  durationMs: number;
  /** Frames with a detected subject so far. */
  detected: number;
  etaMs: number | null;
  elapsedMs: number;
}

export interface ExtractResult {
  recording: MocapRecording;
  loaded: LoadedVideo;
  plan: SamplePlan;
  detectedFrames: number;
  elapsedMs: number;
  delegate: Delegate;
  disabled: { hands?: string; face?: string };
}

function abortError(message = 'Import cancelled'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function once<K extends keyof HTMLMediaElementEventMap>(video: HTMLVideoElement, type: K, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener(type, onEvent);
      video.removeEventListener('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const onEvent = () => finish();
    const onError = () => finish(new Error(`${what}: ${mediaErrorText(video)}`));
    const timer = setTimeout(() => finish(new Error(`${what} timed out`)), timeoutMs);
    video.addEventListener(type, onEvent);
    video.addEventListener('error', onError);
  });
}

const CODEC_HINT = 'this browser cannot decode the clip (HEVC/H.265 from phones and some codecs are not supported everywhere); re-export it as H.264 MP4 or VP9 WebM, e.g. ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p out.mp4';

function mediaErrorText(video: HTMLVideoElement): string {
  const e = video.error;
  if (!e) return 'unknown media error';
  const names: Record<number, string> = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format not supported' };
  const detail = e.message ? ` (${e.message})` : '';
  const hint = e.code === 3 || e.code === 4 ? `; ${CODEC_HINT}` : '';
  return `${names[e.code] ?? `media error ${e.code}`}${detail}${hint}`;
}

/**
 * Loads a clip into a detached, muted video element and resolves once its
 * metadata (duration, size) and first frame are available. Streams recorded
 * by MediaRecorder report an infinite duration; the usual seek-to-the-end
 * trick makes the browser compute it.
 */
export async function loadVideoElement(source: Blob | string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LoadedVideo> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  if (typeof source === 'string') video.crossOrigin = 'anonymous';
  const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
  const fail = (err: Error): never => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    video.removeAttribute('src');
    video.load();
    throw err;
  };
  try {
    const ready = once(video, 'loadedmetadata', timeoutMs, 'Loading video metadata');
    video.src = objectUrl ?? (source as string);
    video.load();
    await ready;
    if (opts.signal?.aborted) return fail(abortError());
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      // MediaRecorder output without a Duration element: force the browser to find the end.
      const fixed = once(video, 'durationchange', timeoutMs, 'Measuring video duration');
      video.currentTime = 1e9;
      await fixed.catch(() => undefined);
      await new Promise<void>((resolve) => {
        if (Number.isFinite(video.duration)) resolve();
        else {
          const t = setTimeout(resolve, 2000);
          video.addEventListener(
            'durationchange',
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        }
      });
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0) return fail(new Error('The video has no readable duration'));
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      // Some containers only report the size once a frame is decoded.
      await seekTo(video, 0, timeoutMs).catch(() => undefined);
    }
    if (video.videoWidth === 0 || video.videoHeight === 0) return fail(new Error('The file has no video track the browser can decode'));
    await seekTo(video, 0, timeoutMs);
    return { video, objectUrl, durationMs: video.duration * 1000, width: video.videoWidth, height: video.videoHeight };
  } catch (err) {
    return fail(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Accurate seek: resolves when the frame at `sec` has been presented. */
export function seekTo(video: HTMLVideoElement, sec: number, timeoutMs = 10_000): Promise<void> {
  const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
  const target = Math.max(0, Math.min(sec, duration));
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime === target && !video.seeking) return Promise.resolve();
  const seeked = once(video, 'seeked', timeoutMs, `Seek to ${target.toFixed(3)} s`);
  video.currentTime = target;
  return seeked;
}

/** Releases a loaded video (object URL, decoder). */
export function disposeVideo(loaded: LoadedVideo): void {
  try {
    loaded.video.pause();
  } catch {
    // ignore
  }
  loaded.video.removeAttribute('src');
  loaded.video.load();
  if (loaded.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
}

/** JPEG data URL of the current frame scaled to `maxWidth`; null when the canvas is tainted or empty. */
export function captureThumbnail(video: HTMLVideoElement, maxWidth = 240, quality = 0.7): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!(w > 0 && h > 0) || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const scale = Math.min(1, maxWidth / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
}

function convertHands(res: HandLandmarkerResult, poseImage: ReturnType<typeof landmarksToTuples> | null): PoseFrame['hands'] {
  const detected: DetectedHandLike[] = [];
  const n = Math.min(res.landmarks.length, res.worldLandmarks.length);
  for (let i = 0; i < n; i++) {
    const cat = res.handedness[i]?.[0];
    detected.push({ image: pointsToTuples(res.landmarks[i]), handedness: cat?.categoryName ?? 'Left', score: cat?.score ?? 1 });
  }
  if (detected.length === 0) return { left: null, right: null };
  const sides = assignHandSides(detected, poseImage);
  const build = (idx: number | null): HandFrame | null =>
    idx === null ? null : makeHandFrame(res.worldLandmarks[idx], res.landmarks[idx], detected[idx].score, detected[idx].handedness);
  return { left: build(sides.left), right: build(sides.right) };
}

function convertFace(res: FaceLandmarkerResult): FaceFrame | null {
  if (res.faceLandmarks.length === 0) return null;
  return { blendshapes: blendshapesToRecord(res.faceBlendshapes[0]?.categories), matrix: matrixToArray(res.facialTransformationMatrixes[0]) };
}

/**
 * Runs the whole extraction. Rejects with an `AbortError` when `signal`
 * fires; the video element is left loaded (the caller reuses it for playback)
 * unless loading itself failed.
 */
export async function extractPoseFromVideo(opts: ExtractOptions): Promise<ExtractResult> {
  const started = performance.now();
  const fileName = opts.fileName ?? (typeof opts.source === 'string' ? opts.source.split('/').pop() || 'video' : (opts.source as File).name ?? 'video');
  const report = (p: Omit<ExtractProgress, 'elapsedMs' | 'etaMs'> & { etaMs?: number | null }) =>
    opts.onProgress?.({ ...p, etaMs: p.etaMs ?? null, elapsedMs: performance.now() - started });
  const checkAbort = () => {
    if (opts.signal?.aborted) throw abortError();
  };

  report({ phase: 'loading', message: 'Loading video', frame: 0, total: 0, mediaTimeMs: 0, durationMs: 0, detected: 0 });
  const loaded = opts.loaded ?? (await loadVideoElement(opts.source, { signal: opts.signal }));
  checkAbort();
  const { video } = loaded;
  const plan = planSamples(loaded.durationMs / 1000, opts.fps, { startSec: opts.startSec, endSec: opts.endSec });
  if (plan.count === 0) throw new Error('The clip is empty');

  report({ phase: 'models', message: 'Loading pose model', frame: 0, total: plan.count, mediaTimeMs: 0, durationMs: loaded.durationMs, detected: 0 });
  const set = await createLandmarkers({
    poseModel: opts.poseModel ?? 'full',
    delegate: opts.delegate ?? 'GPU',
    hands: opts.hands ?? false,
    face: opts.face ?? false,
    onStatus: (message) => report({ phase: 'models', message, frame: 0, total: plan.count, mediaTimeMs: 0, durationMs: loaded.durationMs, detected: 0 }),
  });

  const frames: PoseFrame[] = [];
  const stamps = new MonotonicTimestamps();
  let detected = 0;
  let lastHands: PoseFrame['hands'] = null;
  let lastFace: FaceFrame | null = null;
  const size: [number, number] = [loaded.width, loaded.height];
  try {
    checkAbort();
    for (let k = 0; k < plan.count; k++) {
      checkAbort();
      const tSec = sampleTime(plan, k);
      await seekTo(video, tSec);
      checkAbort();
      const ts = stamps.next(tSec * 1000);
      const result = set.pose.detectForVideo(video, ts);
      const poseLandmarks = result.landmarks.length > 0 ? result.landmarks[0] : null;
      const poseWorld = result.worldLandmarks.length > 0 ? result.worldLandmarks[0] : null;
      const image = poseLandmarks ? landmarksToTuples(poseLandmarks) : null;
      const frame: PoseFrame = {
        v: 2,
        t: tSec * 1000,
        src: VIDEO_IMPORT_SRC,
        size,
        pose: poseLandmarks && poseWorld && image ? { world: landmarksToTuples(poseWorld), image } : null,
      };
      if (set.hand) {
        lastHands = convertHands(set.hand.detectForVideo(video, ts), image);
        frame.hands = lastHands;
      }
      if (set.face) {
        lastFace = convertFace(set.face.detectForVideo(video, ts));
        frame.face = lastFace;
      }
      if (frame.pose) detected++;
      frames.push(frame);
      const elapsed = performance.now() - started;
      report({
        phase: 'frames',
        message: `Analysing frame ${k + 1} of ${plan.count}`,
        frame: k + 1,
        total: plan.count,
        mediaTimeMs: tSec * 1000,
        durationMs: loaded.durationMs,
        detected,
        etaMs: estimateRemainingMs(k + 1, plan.count, elapsed),
      });
    }
  } finally {
    set.close();
  }

  const videoMeta: VideoMeta = {
    fileName,
    durationMs: loaded.durationMs,
    sampleFps: plan.fps,
    width: loaded.width,
    height: loaded.height,
    detectedFrames: detected,
  };
  if (typeof opts.source !== 'string') videoMeta.sizeBytes = opts.source.size;
  const recording: MocapRecording = {
    format: 'cameracharacter-mocap',
    version: 2,
    meta: {
      createdAt: new Date().toISOString(),
      source: VIDEO_IMPORT_SRC,
      size,
      mirror: false,
      camera: { frameRate: plan.fps },
      tracker: {
        lib: '@mediapipe/tasks-vision',
        version: MEDIAPIPE_VERSION,
        poseModel: opts.poseModel ?? 'full',
        delegate: set.delegate,
        hands: !!set.hand,
        face: !!set.face,
      },
      notes: `Extracted from ${fileName} at ${plan.fps} samples/s`,
      video: videoMeta,
    },
    frames,
  };
  const elapsedMs = performance.now() - started;
  report({ phase: 'done', message: `Done: ${detected} of ${plan.count} frames with a subject`, frame: plan.count, total: plan.count, mediaTimeMs: loaded.durationMs, durationMs: loaded.durationMs, detected, etaMs: 0 });
  await seekTo(video, plan.startSec).catch(() => undefined);
  return { recording, loaded, plan, detectedFrames: detected, elapsedMs, delegate: set.delegate, disabled: set.disabled };
}
