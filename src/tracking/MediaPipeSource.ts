/**
 * Browser PoseSource built on @mediapipe/tasks-vision: PoseLandmarker in VIDEO
 * mode (GPU with CPU fallback), optional HandLandmarker / FaceLandmarker at a
 * reduced cadence, driven by requestVideoFrameCallback (rAF fallback).
 * Emits PoseFrame v2 in raw MediaPipe conventions; see docs/DESIGN.md §11.
 *
 * Browser only. The pure conversion helpers live in ./convert.ts.
 */
import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { FaceFrame, HandFrame, PoseFrame, TrackingSettings } from '../core/types';
import { BaseSource } from './PoseSource';
import { closeCamera, openCamera } from './camera';
import {
  assignHandSides,
  blendshapesToRecord,
  landmarksToTuples,
  makeHandFrame,
  matrixToArray,
  pointsToTuples,
  type DetectedHandLike,
} from './convert';
import { loadModelAsset, poseModelAsset, resolveWasmBasePath, type ModelAssetName } from './mediapipeModels';

export const MEDIAPIPE_SRC = 'mediapipe-web';

/** `WasmFileset` is not exported by the package typings; derive it. */
type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

export interface MediaPipeSourceOptions {
  /** An already playing video element (camera or file). When omitted the source opens a camera. */
  video?: HTMLVideoElement | undefined;
  deviceId?: string;
  width?: number;
  height?: number;
  settings: TrackingSettings;
}

/** Raw MediaPipe results of the most recent inference, for overlays. */
export interface MediaPipeLastResult {
  pose: PoseLandmarkerResult | null;
  hands: HandLandmarkerResult | null;
  face: FaceLandmarkerResult | null;
  /** Timestamp (ms) passed to detectForVideo for the pose result. */
  t: number;
}

const CONFIDENCE = 0.5;

export class MediaPipeSource extends BaseSource {
  readonly kind = 'mediapipe' as const;

  private settings: TrackingSettings;
  private readonly options: MediaPipeSourceOptions;

  private videoEl: HTMLVideoElement | null = null;
  private ownsCamera = false;

  private fileset: WasmFileset | null = null;
  private pose: PoseLandmarker | null = null;
  private hand: HandLandmarker | null = null;
  private face: FaceLandmarker | null = null;
  /** Variant and requested/actual delegate the current pose landmarker was built with. */
  private poseBuilt: { model: ModelAssetName; requested: 'GPU' | 'CPU'; actual: 'GPU' | 'CPU' } | null = null;
  private delegateInUse: 'GPU' | 'CPU' = 'GPU';

  private running = false;
  private generation = 0;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private lastMediaTime = -1;
  private lastTimestamp = -1;
  private frameCounter = 0;

  private lastHands: PoseFrame['hands'] = null;
  private lastFace: FaceFrame | null = null;
  private _lastResult: MediaPipeLastResult = { pose: null, hands: null, face: null, t: 0 };

  private applyingSettings: Promise<void> = Promise.resolve();

  constructor(options: MediaPipeSourceOptions) {
    super();
    this.options = options;
    this.settings = { ...options.settings };
    this.videoEl = options.video ?? null;
  }

  /** The video element being analysed (for the preview overlay). */
  get video(): HTMLVideoElement | null {
    return this.videoEl;
  }

  /** Most recent raw landmarker results (normalized landmarks for drawing). */
  get lastResult(): MediaPipeLastResult {
    return this._lastResult;
  }

  /** Delegate actually in use after fallback. */
  get delegate(): 'GPU' | 'CPU' {
    return this.delegateInUse;
  }

  getSettings(): TrackingSettings {
    return this.settings;
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    const gen = ++this.generation;
    this.setStatus({ state: 'starting', message: 'Opening camera' });
    try {
      if (!this.videoEl) {
        const cam = await openCamera({
          deviceId: this.options.deviceId,
          width: this.options.width,
          height: this.options.height,
        });
        if (gen !== this.generation) {
          closeCamera(cam.video);
          return;
        }
        this.videoEl = cam.video;
        this.ownsCamera = true;
      } else if (this.videoEl.paused) {
        await this.videoEl.play();
      }

      this.setStatus({ state: 'starting', message: 'Loading MediaPipe runtime' });
      if (!this.fileset) {
        const wasmPath = await resolveWasmBasePath();
        this.fileset = await FilesetResolver.forVisionTasks(wasmPath);
      }
      if (gen !== this.generation) return;

      await this.createPoseLandmarker(this.settings);
      if (gen !== this.generation) return;
      await this.syncAuxLandmarkers(this.settings);
      if (gen !== this.generation) return;

      this.running = true;
      this.lastMediaTime = -1;
      this.frameCounter = 0;
      this.setStatus({
        state: 'running',
        message: `Pose ${this.settings.poseModel} on ${this.delegateInUse}`,
      });
      this.scheduleNext();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: 'error', message });
      this.releaseVideo();
      throw err;
    }
  }

  stop(): void {
    this.generation++;
    this.running = false;
    this.cancelLoop();
    this.closeLandmarker('pose');
    this.closeLandmarker('hand');
    this.closeLandmarker('face');
    this.releaseVideo();
    this.lastHands = null;
    this.lastFace = null;
    this._lastResult = { pose: null, hands: null, face: null, t: 0 };
    this.setStatus({ state: 'stopped' });
  }

  /**
   * Apply new tracking settings at runtime; landmarkers are recreated only
   * when their configuration changed. Safe to call while running.
   */
  setSettings(settings: TrackingSettings): Promise<void> {
    const next = { ...settings };
    this.settings = next;
    if (!this.running && !this.pose) return Promise.resolve();
    this.applyingSettings = this.applyingSettings
      .then(async () => {
        if (this.settings !== next) return; // superseded
        const gen = this.generation;
        const wantModel = poseModelAsset(next.poseModel);
        const poseChanged =
          !this.poseBuilt || this.poseBuilt.model !== wantModel || this.poseBuilt.requested !== next.delegate;
        if (poseChanged) {
          this.setStatus({ message: `Switching to pose ${next.poseModel}` });
          await this.createPoseLandmarker(next);
          if (gen !== this.generation) return;
          if (this.running) this.setStatus({ state: 'running', message: `Pose ${next.poseModel} on ${this.delegateInUse}` });
        }
        await this.syncAuxLandmarkers(next);
      })
      .catch((err: unknown) => {
        this.setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return this.applyingSettings;
  }

  // ---- landmarker management -------------------------------------------------

  private async createPoseLandmarker(settings: TrackingSettings): Promise<void> {
    if (!this.fileset) throw new Error('MediaPipe runtime not loaded');
    const model = poseModelAsset(settings.poseModel);
    this.setStatus({ message: `Loading pose model (${settings.poseModel})` });
    const bytes = await loadModelAsset(model);
    const create = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(this.fileset as WasmFileset, {
        baseOptions: { modelAssetBuffer: bytes, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: CONFIDENCE,
        minPosePresenceConfidence: CONFIDENCE,
        minTrackingConfidence: CONFIDENCE,
      });
    let landmarker: PoseLandmarker;
    let delegate = settings.delegate;
    try {
      landmarker = await create(delegate);
    } catch (err) {
      if (delegate !== 'GPU') throw err;
      const reason = err instanceof Error ? err.message : String(err);
      this.setStatus({ message: `GPU delegate unavailable (${reason}); using CPU` });
      delegate = 'CPU';
      landmarker = await create('CPU');
    }
    const old = this.pose;
    this.pose = landmarker;
    this.poseBuilt = { model, requested: settings.delegate, actual: delegate };
    this.delegateInUse = delegate;
    // A fresh graph needs strictly increasing timestamps from its own start; ours are global and increasing.
    if (old) old.close();
  }

  private async syncAuxLandmarkers(settings: TrackingSettings): Promise<void> {
    if (!this.fileset) return;
    if (settings.hands && !this.hand) {
      this.setStatus({ message: 'Loading hand model' });
      const bytes = await loadModelAsset('hand');
      const create = (delegate: 'GPU' | 'CPU') =>
        HandLandmarker.createFromOptions(this.fileset as WasmFileset, {
          baseOptions: { modelAssetBuffer: bytes, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: CONFIDENCE,
          minHandPresenceConfidence: CONFIDENCE,
          minTrackingConfidence: CONFIDENCE,
        });
      const hand = await this.createWithFallback(create);
      if (this.settings.hands) this.hand = hand;
      else hand.close();
    } else if (!settings.hands && this.hand) {
      this.closeLandmarker('hand');
      this.lastHands = null;
      this._lastResult = { ...this._lastResult, hands: null };
    }

    if (settings.face && !this.face) {
      this.setStatus({ message: 'Loading face model' });
      const bytes = await loadModelAsset('face');
      const create = (delegate: 'GPU' | 'CPU') =>
        FaceLandmarker.createFromOptions(this.fileset as WasmFileset, {
          baseOptions: { modelAssetBuffer: bytes, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          minFaceDetectionConfidence: CONFIDENCE,
          minFacePresenceConfidence: CONFIDENCE,
          minTrackingConfidence: CONFIDENCE,
        });
      const face = await this.createWithFallback(create);
      if (this.settings.face) this.face = face;
      else face.close();
    } else if (!settings.face && this.face) {
      this.closeLandmarker('face');
      this.lastFace = null;
      this._lastResult = { ...this._lastResult, face: null };
    }
    if (this.running) this.setStatus({ state: 'running', message: `Pose ${this.settings.poseModel} on ${this.delegateInUse}` });
  }

  private async createWithFallback<T>(create: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
    const preferred = this.delegateInUse;
    try {
      return await create(preferred);
    } catch (err) {
      if (preferred === 'CPU') throw err;
      return await create('CPU');
    }
  }

  private closeLandmarker(which: 'pose' | 'hand' | 'face'): void {
    const lm = this[which];
    if (!lm) return;
    this[which] = null;
    if (which === 'pose') this.poseBuilt = null;
    try {
      lm.close();
    } catch {
      // ignore
    }
  }

  private releaseVideo(): void {
    if (this.ownsCamera && this.videoEl) {
      closeCamera(this.videoEl);
      this.videoEl = null;
    }
    this.ownsCamera = false;
  }

  // ---- inference loop ---------------------------------------------------------

  private scheduleNext(): void {
    if (!this.running || !this.videoEl) return;
    const v = this.videoEl;
    if (typeof v.requestVideoFrameCallback === 'function') {
      this.rvfcHandle = v.requestVideoFrameCallback((_now, meta) => {
        this.rvfcHandle = null;
        this.onVideoFrame(meta.mediaTime);
      });
    } else {
      this.rafHandle = requestAnimationFrame(() => {
        this.rafHandle = null;
        this.onVideoFrame(v.currentTime);
      });
    }
  }

  private cancelLoop(): void {
    const v = this.videoEl;
    if (this.rvfcHandle !== null && v && typeof v.cancelVideoFrameCallback === 'function') {
      v.cancelVideoFrameCallback(this.rvfcHandle);
    }
    this.rvfcHandle = null;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  /** Strictly increasing integer millisecond timestamp derived from performance.now(). */
  private nextTimestamp(): number {
    let ts = Math.floor(performance.now());
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1;
    this.lastTimestamp = ts;
    return ts;
  }

  private onVideoFrame(mediaTime: number): void {
    if (!this.running || !this.videoEl || !this.pose) return;
    const v = this.videoEl;
    const advanced = mediaTime !== this.lastMediaTime;
    const ready = v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && v.videoWidth > 0 && v.videoHeight > 0;
    if (advanced && ready) {
      this.lastMediaTime = mediaTime;
      try {
        this.infer(v);
      } catch (err) {
        this.setStatus({ state: 'error', message: `Inference failed: ${err instanceof Error ? err.message : String(err)}` });
        this.running = false;
        return;
      }
    }
    this.scheduleNext();
  }

  private infer(v: HTMLVideoElement): void {
    const pose = this.pose as PoseLandmarker;
    const ts = this.nextTimestamp();
    const t0 = performance.now();
    const result = pose.detectForVideo(v, ts);
    const poseLandmarks = result.landmarks.length > 0 ? result.landmarks[0] : null;
    const poseWorld = result.worldLandmarks.length > 0 ? result.worldLandmarks[0] : null;

    const counter = this.frameCounter++;
    const cadence = Math.max(1, Math.floor(this.settings.auxCadence) || 1);
    let handsResult: HandLandmarkerResult | null = this._lastResult.hands;
    let faceResult: FaceLandmarkerResult | null = this._lastResult.face;

    const poseImageTuples = poseLandmarks ? landmarksToTuples(poseLandmarks) : null;

    if (this.hand && counter % cadence === 0) {
      handsResult = this.hand.detectForVideo(v, ts);
      this.lastHands = this.convertHands(handsResult, poseImageTuples);
    }
    // Stagger the face onto a different frame than the hands when the cadence allows.
    const faceSlot = cadence > 1 ? Math.floor(cadence / 2) : 0;
    if (this.face && counter % cadence === faceSlot) {
      faceResult = this.face.detectForVideo(v, ts);
      this.lastFace = this.convertFace(faceResult);
    }

    const inferenceMs = performance.now() - t0;
    this._lastResult = { pose: result, hands: handsResult, face: faceResult, t: ts };

    const frame: PoseFrame = {
      v: 2,
      t: ts,
      src: MEDIAPIPE_SRC,
      size: [v.videoWidth, v.videoHeight],
      pose: poseLandmarks && poseWorld && poseImageTuples
        ? { world: landmarksToTuples(poseWorld), image: poseImageTuples }
        : null,
    };
    if (this.hand) frame.hands = this.lastHands;
    if (this.face) frame.face = this.lastFace;

    this.emitFrame(frame);
    if (this.status.state === 'running') {
      const prev = this.status.inferenceMs ?? inferenceMs;
      const smoothed = prev + (inferenceMs - prev) * 0.2;
      if (Math.abs(smoothed - prev) > 0.5 || this.status.inferenceMs === undefined) {
        this.setStatus({ inferenceMs: Math.round(smoothed * 10) / 10 });
      }
    }
  }

  private convertHands(
    res: HandLandmarkerResult,
    poseImage: ReturnType<typeof landmarksToTuples> | null,
  ): PoseFrame['hands'] {
    const detected: DetectedHandLike[] = [];
    const n = Math.min(res.landmarks.length, res.worldLandmarks.length);
    for (let i = 0; i < n; i++) {
      const cat = res.handedness[i]?.[0];
      detected.push({
        image: pointsToTuples(res.landmarks[i]),
        handedness: cat?.categoryName ?? 'Left',
        score: cat?.score ?? 1,
      });
    }
    if (detected.length === 0) return { left: null, right: null };
    const sides = assignHandSides(detected, poseImage);
    const build = (idx: number | null): HandFrame | null =>
      idx === null ? null : makeHandFrame(res.worldLandmarks[idx], res.landmarks[idx], detected[idx].score);
    return { left: build(sides.left), right: build(sides.right) };
  }

  private convertFace(res: FaceLandmarkerResult): FaceFrame | null {
    if (res.faceLandmarks.length === 0) return null;
    return {
      blendshapes: blendshapesToRecord(res.faceBlendshapes[0]?.categories),
      matrix: matrixToArray(res.facialTransformationMatrixes[0]),
    };
  }
}
