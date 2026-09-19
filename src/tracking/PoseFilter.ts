/**
 * Converts raw PoseFrames (MediaPipe conventions) into `FilteredPose`
 * (src/core/pose.ts): mirror mode, coordinate conversion, per-landmark
 * visibility EMA with an in-frame test, hysteresis gates with dwell/release
 * timing, scale-free One Euro smoothing that is frozen while a landmark's gate
 * is closed, soft confidences with a re-acquisition ramp, and consistent
 * conversion of hands and face (docs/DESIGN.md §3, §6.1, §11).
 *
 * Pure (three.js math only). Time base: `PoseFrame.t` is milliseconds; the
 * One Euro filters run in seconds, the gates in milliseconds.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { HandFrame, LandmarkTuple, PoseFrame, SmoothingSettings } from '../core/types';
import type { OneEuroParams } from '../core/math';
import { clamp, smoothstep } from '../core/math';
import type { FacePose, FilteredPose, HandPose } from '../core/pose';
import { HAND_LANDMARK_COUNT, LM, POSE_LANDMARK_COUNT } from './landmarks';
import { mirrorPoseFrame } from './convert';
import { ScaleFreeOneEuro3 } from './scaleFreeOneEuro';

export type { FilteredPose } from '../core/pose';

const N = POSE_LANDMARK_COUNT;

/** Visibility EMA time constant (ms). */
export const VISIBILITY_TAU_MS = 120;
/** Margin outside [0, 1] within which a normalized landmark still counts as in frame. */
export const IN_FRAME_MARGIN = 0.03;
/** Fallback subject sizes for the scale-free filters when the torso has not been measured. */
export const IMAGE_SCALE_FALLBACK = 0.25;
export const WORLD_SCALE_FALLBACK = 0.5;
/** Time constant (ms) of the subject-size EMAs. */
const SCALE_TAU_MS = 1000;
const MIN_IMAGE_SCALE = 0.02;
const MIN_WORLD_SCALE = 0.05;

/**
 * Basis change from MediaPipe's face camera space into our converted world
 * frame. MediaPipe's facial transformation matrix is expressed with x right,
 * y up and z toward the viewer, which coincides with the three.js frame we
 * convert the pose into, so the change is the identity. TO BE VERIFIED LIVE
 * against a webcam session (nod = pitch about +X, shake = yaw about +Y).
 */
export const FACE_BASIS_CHANGE: Quaternion = new Quaternion();

/** MediaPipe → three.js: (x, y, z) → (x, -y, -z). */
export function worldToThree(p: readonly number[], out = new Vector3()): Vector3 {
  return out.set(p[0], -p[1], -p[2]);
}

type Group = 'body' | 'feet' | 'face';

/** Landmark groups for the gate thresholds: face 0–10, feet/heels/toes 27–32, body otherwise. */
export function landmarkGroup(index: number): Group {
  if (index <= LM.MOUTH_RIGHT) return 'face';
  if (index >= LM.LEFT_ANKLE) return 'feet';
  return 'body';
}

const _m = new Matrix4();
const _rot = new Matrix4();
const _basisInv = new Quaternion();

/**
 * Head rotation from a 4x4 column-major facial transformation matrix
 * (already mirrored when applicable). Scale is removed before extraction. The
 * result is conjugated by {@link FACE_BASIS_CHANGE}. Null when the matrix is
 * absent, malformed or degenerate.
 */
export function faceRotationFromMatrix(matrix: readonly number[] | null | undefined, out = new Quaternion()): Quaternion | null {
  if (!matrix || matrix.length !== 16) return null;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(matrix[i])) return null;
  _m.fromArray(matrix);
  // Reject degenerate or reflecting upper-left 3x3 blocks before the scale is normalized away.
  const e = _m.elements;
  const det3 =
    e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
  if (!(det3 > 1e-9)) return null;
  _rot.extractRotation(_m);
  if (!(Math.abs(_rot.determinant() - 1) < 1e-3)) return null;
  out.setFromRotationMatrix(_rot);
  _basisInv.copy(FACE_BASIS_CHANGE).invert();
  out.premultiply(FACE_BASIS_CHANGE).multiply(_basisInv);
  return out.normalize();
}

/** Per-landmark gate with dwell (open) and release (close) timing. */
class LandmarkGate {
  open = false;
  private aboveSince = NaN;
  private belowSince = NaN;
  private outSince = NaN;

  update(inFrame: boolean, ema: number, on: number, off: number, tMs: number, dwellMs: number, releaseMs: number, outMs: number): boolean {
    const qualifies = inFrame && ema >= on;
    if (qualifies) {
      if (Number.isNaN(this.aboveSince)) this.aboveSince = tMs;
    } else {
      this.aboveSince = NaN;
    }
    if (!inFrame) {
      if (Number.isNaN(this.outSince)) this.outSince = tMs;
    } else {
      this.outSince = NaN;
    }
    if (ema <= off) {
      if (Number.isNaN(this.belowSince)) this.belowSince = tMs;
    } else {
      this.belowSince = NaN;
    }
    if (!this.open) {
      if (qualifies && tMs - this.aboveSince >= dwellMs) this.open = true;
    } else if (
      (!Number.isNaN(this.outSince) && tMs - this.outSince >= outMs) ||
      (!Number.isNaN(this.belowSince) && tMs - this.belowSince >= releaseMs)
    ) {
      this.open = false;
    }
    return this.open;
  }

  reset(): void {
    this.open = false;
    this.aboveSince = NaN;
    this.belowSince = NaN;
    this.outSince = NaN;
  }
}

function emaAlpha(dtMs: number, tauMs: number): number {
  if (!(dtMs > 0)) return 1;
  if (!(tauMs > 0)) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
}

function paramsFor(s: SmoothingSettings): { xy: OneEuroParams; worldZ: OneEuroParams } {
  const xy: OneEuroParams = { minCutoff: s.oneEuroMinCutoff, beta: s.oneEuroBeta, dCutoff: s.oneEuroDCutoff };
  const worldZ: OneEuroParams = { ...xy, minCutoff: s.oneEuroMinCutoff * 0.5 };
  return { xy, worldZ };
}

export class PoseFilter {
  private settings: SmoothingSettings;
  private mirror: boolean;

  private readonly worldFilters: ScaleFreeOneEuro3[] = [];
  private readonly imageFilters: ScaleFreeOneEuro3[] = [];
  private readonly gates: LandmarkGate[] = [];

  // Raw (converted + mirrored) values of the current frame.
  private readonly worldRaw = new Float64Array(N * 3);
  private readonly imageRaw = new Float64Array(N * 3);
  private readonly visRaw = new Float64Array(N);

  // Outputs (held while gates are closed or the subject is absent).
  private readonly worldOut: number[] = new Array<number>(N * 3).fill(0);
  private readonly imageOut: number[] = new Array<number>(N * 3).fill(0);
  private readonly ema: number[] = new Array<number>(N).fill(0);
  private readonly emaInit: boolean[] = new Array<boolean>(N).fill(false);
  private readonly inFrame: boolean[] = new Array<boolean>(N).fill(false);
  private readonly gated: boolean[] = new Array<boolean>(N).fill(false);
  private readonly confidence: number[] = new Array<number>(N).fill(0);
  private readonly hasOutput: boolean[] = new Array<boolean>(N).fill(false);

  private lastSize: [number, number] = [0, 0];
  private lastTMs = NaN;
  private firstTMs = NaN;
  private lastPresentMs = NaN;
  private reacquiredAtMs = NaN;
  private wasPresent = false;

  private imageScale = NaN;
  private worldScale = NaN;

  constructor(settings: SmoothingSettings, mirror: boolean) {
    this.settings = settings;
    this.mirror = mirror;
    const p = paramsFor(settings);
    for (let i = 0; i < N; i++) {
      this.worldFilters.push(new ScaleFreeOneEuro3(p.xy, p.worldZ));
      this.imageFilters.push(new ScaleFreeOneEuro3(p.xy));
      this.gates.push(new LandmarkGate());
      this.imageOut[i * 3] = 0.5;
      this.imageOut[i * 3 + 1] = 0.5;
    }
  }

  get isMirrored(): boolean {
    return this.mirror;
  }

  getSettings(): SmoothingSettings {
    return this.settings;
  }

  /** New smoothing/gate parameters take effect on the next frame; filter state is kept. */
  setSettings(settings: SmoothingSettings): void {
    this.settings = settings;
    const p = paramsFor(settings);
    for (let i = 0; i < N; i++) {
      this.worldFilters[i].setParams(p.xy, p.worldZ);
      this.imageFilters[i].setParams(p.xy);
    }
  }

  /** Toggling mirror mode resets the filters (the data jumps sides). */
  setMirror(mirror: boolean): void {
    if (mirror === this.mirror) return;
    this.mirror = mirror;
    this.resetFilters();
  }

  /** Clear every filter, gate and held output. */
  reset(): void {
    this.resetFilters();
    for (let i = 0; i < N; i++) {
      this.gates[i].reset();
      this.ema[i] = 0;
      this.emaInit[i] = false;
      this.inFrame[i] = false;
      this.gated[i] = false;
      this.confidence[i] = 0;
      this.hasOutput[i] = false;
      this.worldOut[i * 3] = this.worldOut[i * 3 + 1] = this.worldOut[i * 3 + 2] = 0;
      this.imageOut[i * 3] = this.imageOut[i * 3 + 1] = 0.5;
      this.imageOut[i * 3 + 2] = 0;
    }
    this.lastTMs = NaN;
    this.firstTMs = NaN;
    this.lastPresentMs = NaN;
    this.reacquiredAtMs = NaN;
    this.wasPresent = false;
    this.imageScale = NaN;
    this.worldScale = NaN;
  }

  private resetFilters(): void {
    for (let i = 0; i < N; i++) {
      this.worldFilters[i].reset();
      this.imageFilters[i].reset();
    }
  }

  process(frame: PoseFrame): FilteredPose {
    const s = this.settings;
    const mirror = this.mirror;
    const raw = mirror ? mirrorPoseFrame(frame) : frame;
    const tMs = raw.t;
    const tSec = tMs / 1000;
    if (Number.isNaN(this.firstTMs)) this.firstTMs = tMs;
    const dtMs = Number.isNaN(this.lastTMs) ? 0 : Math.max(tMs - this.lastTMs, 0);
    this.lastTMs = tMs;
    if (raw.size && raw.size[0] > 0 && raw.size[1] > 0) this.lastSize = [raw.size[0], raw.size[1]];

    const pose = raw.pose;
    const present = !!pose && pose.world.length === N && pose.image.length === N;
    const visAlpha = emaAlpha(dtMs, VISIBILITY_TAU_MS);

    if (present && pose) {
      // Re-acquisition: the pose returns after an absence long enough that the gates would have released.
      const absentMs = Number.isNaN(this.lastPresentMs) ? Infinity : tMs - this.lastPresentMs;
      if (!this.wasPresent && (Number.isNaN(this.reacquiredAtMs) || absentMs >= s.outOfFrameReleaseMs)) {
        this.reacquiredAtMs = tMs;
      }
      this.lastPresentMs = tMs;
      this.fillRaw(pose.world, pose.image);
      this.updateScales(dtMs);

      for (let i = 0; i < N; i++) {
        const thr = this.thresholds(i);
        const v = this.visRaw[i];
        this.ema[i] = this.emaInit[i] ? this.ema[i] + (v - this.ema[i]) * visAlpha : v;
        this.emaInit[i] = true;
        const ix = this.imageRaw[i * 3];
        const iy = this.imageRaw[i * 3 + 1];
        const inFrame =
          ix >= -IN_FRAME_MARGIN && ix <= 1 + IN_FRAME_MARGIN && iy >= -IN_FRAME_MARGIN && iy <= 1 + IN_FRAME_MARGIN;
        this.inFrame[i] = inFrame;
        const wasOpen = this.gates[i].open;
        const open = this.gates[i].update(
          inFrame,
          this.ema[i],
          thr.on,
          thr.off,
          tMs,
          s.gateDwellMs,
          s.gateReleaseMs,
          s.outOfFrameReleaseMs,
        );
        this.gated[i] = open;

        if (open) {
          if (!wasOpen) {
            // Reopened: start afresh from the true position.
            this.worldFilters[i].reset();
            this.imageFilters[i].reset();
          }
          this.worldFilters[i].filter(
            this.worldRaw[i * 3],
            this.worldRaw[i * 3 + 1],
            this.worldRaw[i * 3 + 2],
            tSec,
            this.worldScaleValue(),
            this.worldOut,
            i * 3,
          );
          this.imageFilters[i].filter(
            this.imageRaw[i * 3],
            this.imageRaw[i * 3 + 1],
            this.imageRaw[i * 3 + 2],
            tSec,
            this.imageScaleValue(),
            this.imageOut,
            i * 3,
          );
          this.hasOutput[i] = true;
        } else if (!this.hasOutput[i]) {
          // Never gated yet: pass the raw position through so the arrays are meaningful.
          this.worldOut[i * 3] = this.worldRaw[i * 3];
          this.worldOut[i * 3 + 1] = this.worldRaw[i * 3 + 1];
          this.worldOut[i * 3 + 2] = this.worldRaw[i * 3 + 2];
          this.imageOut[i * 3] = this.imageRaw[i * 3];
          this.imageOut[i * 3 + 1] = this.imageRaw[i * 3 + 1];
          this.imageOut[i * 3 + 2] = this.imageRaw[i * 3 + 2];
        }
        // else: gate closed after having been open → frozen (hold the last filtered value).
        this.sanitize(i);
      }
    } else {
      // No subject: visibilities decay toward zero, everything counts as out of frame,
      // gates release on their timers, positions hold.
      for (let i = 0; i < N; i++) {
        const thr = this.thresholds(i);
        if (this.emaInit[i]) this.ema[i] = this.ema[i] * (1 - visAlpha);
        this.inFrame[i] = false;
        this.gated[i] = this.gates[i].update(false, this.ema[i], thr.on, thr.off, tMs, s.gateDwellMs, s.gateReleaseMs, s.outOfFrameReleaseMs);
      }
    }
    this.wasPresent = present;

    const ramp = this.rampValue(tMs, present);
    for (let i = 0; i < N; i++) {
      if (!this.gated[i]) {
        this.confidence[i] = 0;
        continue;
      }
      const thr = this.thresholds(i);
      const x = (this.ema[i] - thr.off) / Math.max(thr.on - thr.off, 1e-6);
      this.confidence[i] = smoothstep(0, 1, x) * ramp;
    }

    const absentFor = present
      ? 0
      : Number.isNaN(this.lastPresentMs)
        ? Math.max(tMs - this.firstTMs, 0) / 1000
        : Math.max(tMs - this.lastPresentMs, 0) / 1000;

    return {
      t: tSec,
      now: typeof raw.now === 'number' && Number.isFinite(raw.now) ? raw.now : NaN,
      present,
      absentFor,
      reacquireRamp: ramp,
      size: [this.lastSize[0], this.lastSize[1]],
      mirror,
      world: this.toVectors(this.worldOut),
      image: this.toVectors(this.imageOut),
      visibility: this.ema.slice(),
      inFrame: this.inFrame.slice(),
      gated: this.gated.slice(),
      confidence: this.confidence.slice(),
      hands: this.convertHands(raw.hands),
      face: this.convertFace(raw.face),
    };
  }

  // ---- internals -------------------------------------------------------------

  private thresholds(i: number): { on: number; off: number } {
    const g = landmarkGroup(i);
    const s = this.settings;
    return g === 'face' ? s.gateFace : g === 'feet' ? s.gateFeet : s.gateBody;
  }

  private rampValue(tMs: number, present: boolean): number {
    if (!present || Number.isNaN(this.reacquiredAtMs)) return 0;
    const ms = this.settings.reacquireRampMs;
    if (!(ms > 0)) return 1;
    return clamp((tMs - this.reacquiredAtMs) / ms, 0, 1);
  }

  private imageScaleValue(): number {
    return Number.isNaN(this.imageScale) ? IMAGE_SCALE_FALLBACK : this.imageScale;
  }

  private worldScaleValue(): number {
    return Number.isNaN(this.worldScale) ? WORLD_SCALE_FALLBACK : this.worldScale;
  }

  /** Subject size EMAs from the raw torso (mid-shoulder → mid-hip), only when the torso is confidently seen. */
  private updateScales(dtMs: number): void {
    const on = this.settings.gateBody.on;
    const ids = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP];
    for (const i of ids) if (this.visRaw[i] < on) return;
    const mid = (arr: Float64Array, a: number, b: number, k: number) => 0.5 * (arr[a * 3 + k] + arr[b * 3 + k]);
    const imgLen = Math.hypot(
      mid(this.imageRaw, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, 0) - mid(this.imageRaw, LM.LEFT_HIP, LM.RIGHT_HIP, 0),
      mid(this.imageRaw, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, 1) - mid(this.imageRaw, LM.LEFT_HIP, LM.RIGHT_HIP, 1),
    );
    const worldLen = Math.hypot(
      mid(this.worldRaw, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, 0) - mid(this.worldRaw, LM.LEFT_HIP, LM.RIGHT_HIP, 0),
      mid(this.worldRaw, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, 1) - mid(this.worldRaw, LM.LEFT_HIP, LM.RIGHT_HIP, 1),
      mid(this.worldRaw, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, 2) - mid(this.worldRaw, LM.LEFT_HIP, LM.RIGHT_HIP, 2),
    );
    const a = emaAlpha(dtMs, SCALE_TAU_MS);
    if (Number.isFinite(imgLen) && imgLen >= MIN_IMAGE_SCALE) {
      this.imageScale = Number.isNaN(this.imageScale) ? imgLen : this.imageScale + (imgLen - this.imageScale) * a;
    }
    if (Number.isFinite(worldLen) && worldLen >= MIN_WORLD_SCALE) {
      this.worldScale = Number.isNaN(this.worldScale) ? worldLen : this.worldScale + (worldLen - this.worldScale) * a;
    }
  }

  /** Convert the (already mirrored) raw landmarks into the flat scratch buffers. */
  private fillRaw(world: readonly LandmarkTuple[], image: readonly LandmarkTuple[]): void {
    for (let i = 0; i < N; i++) {
      const w = world[i];
      const im = image[i];
      this.worldRaw[i * 3] = w[0];
      this.worldRaw[i * 3 + 1] = -w[1];
      this.worldRaw[i * 3 + 2] = -w[2];
      this.imageRaw[i * 3] = im[0];
      this.imageRaw[i * 3 + 1] = im[1];
      this.imageRaw[i * 3 + 2] = im[2];
      // Visibility: the larger of the finite world/image values (either array may carry it).
      const vw = w[3];
      const vi = im[3];
      let v = -1;
      if (Number.isFinite(vw)) v = vw;
      if (Number.isFinite(vi) && vi > v) v = vi;
      if (v < 0) v = 0;
      this.visRaw[i] = v > 1 ? 1 : v;
    }
  }

  /** Guard against a NaN/Infinity leaking out of a filter (falls back to the raw value). */
  private sanitize(i: number): void {
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(this.worldOut[i * 3 + k])) this.worldOut[i * 3 + k] = this.worldRaw[i * 3 + k];
      if (!Number.isFinite(this.imageOut[i * 3 + k])) this.imageOut[i * 3 + k] = this.imageRaw[i * 3 + k];
    }
  }

  private toVectors(flat: readonly number[]): Vector3[] {
    const out: Vector3[] = new Array<Vector3>(N);
    for (let i = 0; i < N; i++) out[i] = new Vector3(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]);
    return out;
  }

  private convertHands(hands: PoseFrame['hands']): { left: HandPose | null; right: HandPose | null } {
    if (!hands) return { left: null, right: null };
    const conv = (h: HandFrame | null): HandPose | null => {
      if (!h || h.local.length !== HAND_LANDMARK_COUNT || h.image.length !== HAND_LANDMARK_COUNT) return null;
      return {
        local: h.local.map((p) => new Vector3(p[0], -p[1], -p[2])),
        image: h.image.map((p) => new Vector3(p[0], p[1], p[2])),
        score: h.score,
      };
    };
    return { left: conv(hands.left), right: conv(hands.right) };
  }

  private convertFace(face: PoseFrame['face']): FacePose | null {
    if (!face) return null;
    return {
      blendshapes: { ...face.blendshapes },
      rotation: faceRotationFromMatrix(face.matrix),
    };
  }
}
