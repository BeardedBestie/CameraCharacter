/**
 * Browser PoseSource built on @mediapipe/tasks-vision: PoseLandmarker in VIDEO
 * mode (GPU with CPU fallback), optional HandLandmarker / FaceLandmarker at a
 * reduced cadence, driven by requestVideoFrameCallback (rAF fallback).
 * Emits PoseFrame v2 in raw MediaPipe conventions; see docs/DESIGN.md §11.
 *
 * Lifecycle rules:
 * - every async creation carries the generation it was started in; a
 *   landmarker that finishes after `stop()` (or a later `start()`) moved the
 *   generation is closed immediately instead of being adopted;
 * - hand/face model failures never abort the source: the feature is disabled
 *   and reported in the status message;
 * - an inference-time failure on the GPU delegate rebuilds every landmarker on
 *   the CPU once; any further failure tears the source down (camera released)
 *   before the error is reported.
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
import { log } from '../core/log';
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
type Delegate = 'GPU' | 'CPU';

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

/** Why an optional feature is currently off although the settings ask for it. */
export interface AuxFeatureState {
  hands?: string;
  face?: string;
}

const CONFIDENCE = 0.5;

class StaleGenerationError extends Error {
  constructor() {
    super('MediaPipe source was stopped or restarted while loading');
    this.name = 'StaleGenerationError';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  private poseBuilt: { model: ModelAssetName; requested: Delegate; actual: Delegate } | null = null;
  private delegateInUse: Delegate = 'GPU';
  /** Set after an inference-time GPU failure forced the CPU; cleared by start(). */
  private cpuForced = false;
  private auxDisabled: AuxFeatureState = {};

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
  get delegate(): Delegate {
    return this.delegateInUse;
  }

  /** Optional features that were disabled after a load failure, with the reason. */
  get disabledFeatures(): AuxFeatureState {
    return { ...this.auxDisabled };
  }

  getSettings(): TrackingSettings {
    return this.settings;
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    const gen = ++this.generation;
    this.cpuForced = false;
    this.auxDisabled = {};
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
        const track = cam.stream.getVideoTracks()[0];
        const ts = track?.getSettings?.() ?? {};
        log.info(
          `camera opened: "${track?.label || 'unnamed device'}" ${cam.video.videoWidth}×${cam.video.videoHeight}` +
            `${ts.frameRate ? ` @ ${Math.round(ts.frameRate)} fps` : ''} (${this.options.deviceId ? `device ${this.options.deviceId}` : 'default device'})`,
        );
      } else if (this.videoEl.paused) {
        await this.videoEl.play();
        if (gen !== this.generation) return;
      }

      this.setStatus({ state: 'starting', message: 'Loading MediaPipe runtime' });
      if (!this.fileset) {
        const t = performance.now();
        const wasmPath = await resolveWasmBasePath(undefined, (m) => log.info(m));
        const fileset = await FilesetResolver.forVisionTasks(wasmPath);
        if (gen !== this.generation) return;
        this.fileset = fileset;
        log.info(`MediaPipe runtime loaded from ${wasmPath} in ${Math.round(performance.now() - t)} ms`);
      }
      if (gen !== this.generation) return;

      await this.createPoseLandmarker(this.settings, this.settings.delegate, gen);
      await this.syncAuxLandmarkers(this.settings, gen);
      if (gen !== this.generation) return;

      this.running = true;
      this.lastMediaTime = -1;
      this.frameCounter = 0;
      this.setStatus({ state: 'running', message: this.runningMessage() });
      this.scheduleNext();
    } catch (err) {
      if (err instanceof StaleGenerationError || gen !== this.generation) return;
      log.error(`source start failed: ${errorText(err)}`, err);
      // The camera (if it opened) stays open so the preview keeps showing the
      // feed next to the error: "camera works, model failed" is diagnosable at
      // a glance. stop() releases it before any restart.
      this.setStatus({ state: 'error', message: errorText(err) });
      throw err;
    }
  }

  stop(): void {
    this.generation++;
    this.teardown();
    this.setStatus({ state: 'stopped' });
  }

  /** Release everything the source holds (landmarkers, loop, camera). */
  private teardown(): void {
    this.running = false;
    this.cancelLoop();
    this.closeLandmarker('pose');
    this.closeLandmarker('hand');
    this.closeLandmarker('face');
    this.releaseVideo();
    this.lastHands = null;
    this.lastFace = null;
    this._lastResult = { pose: null, hands: null, face: null, t: 0 };
  }

  /**
   * Apply new tracking settings at runtime; landmarkers are recreated only
   * when their configuration changed. Safe to call while running.
   */
  setSettings(settings: TrackingSettings): Promise<void> {
    const next = { ...settings };
    this.settings = next;
    if (next.hands) delete this.auxDisabled.hands;
    if (next.face) delete this.auxDisabled.face;
    if (!this.running && !this.pose) return Promise.resolve();
    this.applyingSettings = this.applyingSettings
      .then(async () => {
        if (this.settings !== next) return; // superseded
        const gen = this.generation;
        const wantModel = poseModelAsset(next.poseModel);
        const wantDelegate: Delegate = this.cpuForced ? 'CPU' : next.delegate;
        const poseChanged =
          !this.poseBuilt || this.poseBuilt.model !== wantModel || this.poseBuilt.requested !== wantDelegate;
        if (poseChanged) {
          this.setStatus({ message: `Switching to pose ${next.poseModel}` });
          await this.createPoseLandmarker(next, wantDelegate, gen);
          if (this.running) this.setStatus({ state: 'running', message: this.runningMessage() });
        }
        await this.syncAuxLandmarkers(next, gen);
        if (this.running && gen === this.generation) this.setStatus({ state: 'running', message: this.runningMessage() });
      })
      .catch((err: unknown) => {
        if (err instanceof StaleGenerationError) return;
        this.setStatus({ state: 'error', message: errorText(err) });
      });
    return this.applyingSettings;
  }

  private runningMessage(): string {
    const parts = [`Pose ${this.settings.poseModel} on ${this.delegateInUse}`];
    if (this.auxDisabled.hands) parts.push(`hands off (${this.auxDisabled.hands})`);
    if (this.auxDisabled.face) parts.push(`face off (${this.auxDisabled.face})`);
    return parts.join('; ');
  }

  // ---- landmarker management -------------------------------------------------

  /** Throws when `gen` is no longer the current generation. */
  private assertGen(gen: number): void {
    if (gen !== this.generation) throw new StaleGenerationError();
  }

  /**
   * Await a landmarker creation on behalf of generation `gen`; if the
   * generation moved meanwhile the result is closed and a stale error thrown.
   */
  private async adopt<T extends { close(): void }>(creation: Promise<T>, gen: number): Promise<T> {
    const lm = await creation;
    if (gen !== this.generation) {
      try {
        lm.close();
      } catch {
        // ignore
      }
      throw new StaleGenerationError();
    }
    return lm;
  }

  private async createPoseLandmarker(settings: TrackingSettings, requested: Delegate, gen: number): Promise<void> {
    if (!this.fileset) throw new Error('MediaPipe runtime not loaded');
    const fileset = this.fileset;
    const model = poseModelAsset(settings.poseModel);
    this.setStatus({ message: `Loading pose model (${settings.poseModel})` });
    const bytes = await loadModelAsset(model, { log: (m) => log.info(m) });
    this.assertGen(gen);
    const t = performance.now();
    const create = (delegate: Delegate) =>
      this.adopt(
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: bytes, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: CONFIDENCE,
          minPosePresenceConfidence: CONFIDENCE,
          minTrackingConfidence: CONFIDENCE,
        }),
        gen,
      );
    let landmarker: PoseLandmarker;
    let delegate = requested;
    try {
      landmarker = await create(delegate);
    } catch (err) {
      if (err instanceof StaleGenerationError || delegate !== 'GPU') throw err;
      log.warn(`GPU delegate unavailable (${errorText(err)}); using CPU`);
      this.setStatus({ message: `GPU delegate unavailable (${errorText(err)}); using CPU` });
      delegate = 'CPU';
      landmarker = await create('CPU');
    }
    log.info(`pose landmarker ready: ${settings.poseModel} on ${delegate} (${Math.round(performance.now() - t)} ms)`);
    const old = this.pose;
    this.pose = landmarker;
    this.poseBuilt = { model, requested, actual: delegate };
    this.delegateInUse = delegate;
    // A fresh graph needs strictly increasing timestamps from its own start; ours are global and increasing.
    if (old) old.close();
  }

  private async syncAuxLandmarkers(settings: TrackingSettings, gen: number): Promise<void> {
    if (!this.fileset) return;
    const fileset = this.fileset;
    this.assertGen(gen);

    if (settings.hands && !this.hand && !this.auxDisabled.hands) {
      this.setStatus({ message: 'Loading hand model' });
      try {
        const bytes = await loadModelAsset('hand');
        this.assertGen(gen);
        const hand = await this.createWithFallback(
          (delegate) =>
            this.adopt(
              HandLandmarker.createFromOptions(fileset, {
                baseOptions: { modelAssetBuffer: bytes, delegate },
                runningMode: 'VIDEO',
                numHands: 2,
                minHandDetectionConfidence: CONFIDENCE,
                minHandPresenceConfidence: CONFIDENCE,
                minTrackingConfidence: CONFIDENCE,
              }),
              gen,
            ),
        );
        if (this.settings.hands) this.hand = hand;
        else hand.close();
      } catch (err) {
        if (err instanceof StaleGenerationError) throw err;
        this.auxDisabled.hands = errorText(err);
        this.setStatus({ message: `Hand tracking unavailable: ${this.auxDisabled.hands}` });
      }
    } else if (!settings.hands && this.hand) {
      this.closeLandmarker('hand');
      this.lastHands = null;
      this._lastResult = { ...this._lastResult, hands: null };
    }

    this.assertGen(gen);
    if (settings.face && !this.face && !this.auxDisabled.face) {
      this.setStatus({ message: 'Loading face model' });
      try {
        const bytes = await loadModelAsset('face');
        this.assertGen(gen);
        const face = await this.createWithFallback(
          (delegate) =>
            this.adopt(
              FaceLandmarker.createFromOptions(fileset, {
                baseOptions: { modelAssetBuffer: bytes, delegate },
                runningMode: 'VIDEO',
                numFaces: 1,
                outputFaceBlendshapes: true,
                outputFacialTransformationMatrixes: true,
                minFaceDetectionConfidence: CONFIDENCE,
                minFacePresenceConfidence: CONFIDENCE,
                minTrackingConfidence: CONFIDENCE,
              }),
              gen,
            ),
        );
        if (this.settings.face) this.face = face;
        else face.close();
      } catch (err) {
        if (err instanceof StaleGenerationError) throw err;
        this.auxDisabled.face = errorText(err);
        this.setStatus({ message: `Face tracking unavailable: ${this.auxDisabled.face}` });
      }
    } else if (!settings.face && this.face) {
      this.closeLandmarker('face');
      this.lastFace = null;
      this._lastResult = { ...this._lastResult, face: null };
    }
  }

  private async createWithFallback<T>(create: (delegate: Delegate) => Promise<T>): Promise<T> {
    const preferred = this.delegateInUse;
    try {
      return await create(preferred);
    } catch (err) {
      if (err instanceof StaleGenerationError || preferred === 'CPU') throw err;
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
        void this.recoverFromInferenceError(err);
        return;
      }
    }
    this.scheduleNext();
  }

  /**
   * Inference threw. On the GPU delegate rebuild every landmarker on the CPU
   * once and resume; otherwise (or if the rebuild fails) tear the source down
   * so the camera is released, then report the error.
   */
  private async recoverFromInferenceError(err: unknown): Promise<void> {
    const gen = this.generation;
    const reason = errorText(err);
    if (this.delegateInUse === 'GPU' && !this.cpuForced) {
      this.cpuForced = true;
      this.cancelLoop();
      this.setStatus({ state: 'starting', message: `GPU inference failed (${reason}); rebuilding on CPU` });
      try {
        this.closeLandmarker('hand');
        this.closeLandmarker('face');
        this.lastHands = null;
        this.lastFace = null;
        this._lastResult = { pose: null, hands: null, face: null, t: 0 };
        await this.createPoseLandmarker(this.settings, 'CPU', gen);
        await this.syncAuxLandmarkers(this.settings, gen);
        if (gen !== this.generation) return;
        this.lastMediaTime = -1;
        this.setStatus({ state: 'running', message: this.runningMessage() });
        this.scheduleNext();
        return;
      } catch (rebuildErr) {
        if (rebuildErr instanceof StaleGenerationError || gen !== this.generation) return;
        this.teardown();
        this.setStatus({ state: 'error', message: `Inference failed on GPU (${reason}) and CPU (${errorText(rebuildErr)})` });
        return;
      }
    }
    this.teardown();
    this.setStatus({ state: 'error', message: `Inference failed: ${reason}` });
  }

  private infer(v: HTMLVideoElement): void {
    const pose = this.pose as PoseLandmarker;
    const ts = this.nextTimestamp();
    const captured = performance.now();
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

    this.reportInferenceMs(performance.now() - captured);
    this._lastResult = { pose: result, hands: handsResult, face: faceResult, t: ts };

    const frame: PoseFrame = {
      v: 2,
      t: ts,
      now: captured,
      src: MEDIAPIPE_SRC,
      size: [v.videoWidth, v.videoHeight],
      pose: poseLandmarks && poseWorld && poseImageTuples
        ? { world: landmarksToTuples(poseWorld), image: poseImageTuples }
        : null,
    };
    if (this.hand) frame.hands = this.lastHands;
    if (this.face) frame.face = this.lastFace;

    this.emitFrame(frame, captured);
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
      idx === null
        ? null
        : makeHandFrame(res.worldLandmarks[idx], res.landmarks[idx], detected[idx].score, detected[idx].handedness);
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
