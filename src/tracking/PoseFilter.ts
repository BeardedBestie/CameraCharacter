/**
 * Converts raw PoseFrames (MediaPipe conventions) into filtered, three.js
 * space poses: coordinate conversion, mirror mode, One Euro smoothing per
 * landmark coordinate, visibility smoothing with hysteresis gating, and
 * consistent mirroring of hands and face. Pure (three.js math only).
 *
 * Time base: `PoseFrame.t` is milliseconds; the One Euro filters run in
 * seconds, the gates in milliseconds.
 */
import { Vector3 } from 'three';
import type { FaceFrame, HandFrame, LandmarkTuple, PointTuple, PoseFrame, SmoothingSettings } from '../core/types';
import { HysteresisGate, LowPass, OneEuroVector } from '../core/math';
import type { OneEuroParams } from '../core/math';
import { HAND_LANDMARK_COUNT, POSE_LANDMARK_COUNT, POSE_MIRROR_INDEX } from './landmarks';
import { mirrorFaceFrame } from './convert';

export interface FilteredPose {
  /** Frame time in seconds. */
  t: number;
  /** True when the frame carried a pose. */
  present: boolean;
  /** 33 world landmarks in three.js coords (meters, hip-centred): (x, -y, -z) of MediaPipe. */
  world: Vector3[];
  /** 33 image landmarks: x right (0..1), y down (0..1), z raw. */
  image: Vector3[];
  /** 33 smoothed visibilities, 0..1. */
  visibility: number[];
  /** 33 hysteresis-gated visibility flags. */
  visible: boolean[];
  mirror: boolean;
  size: [number, number];
  /** 21 world hand points per side in three.js coords (mirrored/swapped consistently), or null. */
  hands: { left: Vector3[] | null; right: Vector3[] | null };
  /** Face data (mirrored when in mirror mode), or null. */
  face: FaceFrame | null;
}

/** Subject absent for longer than this (ms) resets the filters. */
export const ABSENCE_RESET_MS = 1000;
/** Low-pass alpha for visibilities. */
export const VISIBILITY_ALPHA = 0.5;
const D_CUTOFF = 1.0;
const N = POSE_LANDMARK_COUNT;

/** MediaPipe → three.js: (x, y, z) → (x, -y, -z). */
export function worldToThree(p: readonly number[], out = new Vector3()): Vector3 {
  return out.set(p[0], -p[1], -p[2]);
}

function oneEuroParams(s: SmoothingSettings): OneEuroParams {
  return { minCutoff: s.oneEuroMinCutoff, beta: s.oneEuroBeta, dCutoff: D_CUTOFF };
}

export class PoseFilter {
  private settings: SmoothingSettings;
  private mirror: boolean;

  private readonly worldFilter: OneEuroVector;
  private readonly imageFilter: OneEuroVector;
  private readonly visLowPass: LowPass[] = [];
  private readonly gates: HysteresisGate[] = [];

  // Scratch buffers (flat, mirrored, converted) fed to the filters.
  private readonly worldRaw = new Float64Array(N * 3);
  private readonly imageRaw = new Float64Array(N * 3);
  private readonly visRaw = new Float64Array(N);
  private worldOut: number[] = new Array<number>(N * 3).fill(0);
  private imageOut: number[] = new Array<number>(N * 3).fill(0);

  // Last outputs, kept while the subject is absent.
  private readonly lastWorld: Vector3[] = [];
  private readonly lastImage: Vector3[] = [];
  private readonly lastVisibility: number[] = new Array<number>(N).fill(0);
  private readonly lastVisible: boolean[] = new Array<boolean>(N).fill(false);
  private lastSize: [number, number] = [0, 0];
  private lastPresentMs = NaN;
  private filtersLive = false;

  constructor(settings: SmoothingSettings, mirror: boolean) {
    this.settings = settings;
    this.mirror = mirror;
    const p = oneEuroParams(settings);
    this.worldFilter = new OneEuroVector(N * 3, p);
    this.imageFilter = new OneEuroVector(N * 3, { ...p });
    for (let i = 0; i < N; i++) {
      this.visLowPass.push(new LowPass());
      this.gates.push(new HysteresisGate(settings.visibilityOn, settings.visibilityOff, settings.holdMs));
      this.lastWorld.push(new Vector3());
      this.lastImage.push(new Vector3(0.5, 0.5, 0));
    }
  }

  get isMirrored(): boolean {
    return this.mirror;
  }

  getSettings(): SmoothingSettings {
    return this.settings;
  }

  setSettings(settings: SmoothingSettings): void {
    this.settings = settings;
    const p = oneEuroParams(settings);
    this.worldFilter.setParams(p);
    this.imageFilter.setParams({ ...p });
    for (const g of this.gates) {
      g.onThreshold = settings.visibilityOn;
      g.offThreshold = settings.visibilityOff;
      g.holdMs = settings.holdMs;
    }
  }

  /** Toggling mirror mode resets the smoothing filters (the data jumps). */
  setMirror(mirror: boolean): void {
    if (mirror === this.mirror) return;
    this.mirror = mirror;
    this.resetFilters();
  }

  /** Clear all filter state and last outputs. */
  reset(): void {
    this.resetFilters();
    for (let i = 0; i < N; i++) {
      this.lastWorld[i].set(0, 0, 0);
      this.lastImage[i].set(0.5, 0.5, 0);
      this.lastVisibility[i] = 0;
      this.lastVisible[i] = false;
      this.gates[i].reset();
    }
    this.lastPresentMs = NaN;
  }

  private resetFilters(): void {
    this.worldFilter.reset();
    this.imageFilter.reset();
    for (const lp of this.visLowPass) lp.reset();
    this.filtersLive = false;
  }

  process(frame: PoseFrame): FilteredPose {
    const tMs = frame.t;
    const tSec = tMs / 1000;
    const mirror = this.mirror;
    if (frame.size && frame.size[0] > 0 && frame.size[1] > 0) this.lastSize = [frame.size[0], frame.size[1]];

    const pose = frame.pose;
    let present = false;

    if (pose && pose.world.length === N && pose.image.length === N) {
      present = true;
      // Absent for too long: start the filters afresh so stale state does not lag the new pose.
      if (!Number.isNaN(this.lastPresentMs) && tMs - this.lastPresentMs > ABSENCE_RESET_MS) this.resetFilters();
      this.lastPresentMs = tMs;

      this.fillRaw(pose.world, pose.image, mirror);
      this.worldOut = this.worldFilter.filter(this.worldRaw, tSec, this.worldOut);
      this.imageOut = this.imageFilter.filter(this.imageRaw, tSec, this.imageOut);
      this.filtersLive = true;

      for (let i = 0; i < N; i++) {
        const w = this.lastWorld[i];
        w.set(this.worldOut[i * 3], this.worldOut[i * 3 + 1], this.worldOut[i * 3 + 2]);
        if (!Number.isFinite(w.x) || !Number.isFinite(w.y) || !Number.isFinite(w.z)) {
          w.set(this.worldRaw[i * 3], this.worldRaw[i * 3 + 1], this.worldRaw[i * 3 + 2]);
        }
        const im = this.lastImage[i];
        im.set(this.imageOut[i * 3], this.imageOut[i * 3 + 1], this.imageOut[i * 3 + 2]);
        if (!Number.isFinite(im.x) || !Number.isFinite(im.y) || !Number.isFinite(im.z)) {
          im.set(this.imageRaw[i * 3], this.imageRaw[i * 3 + 1], this.imageRaw[i * 3 + 2]);
        }
        const v = this.visLowPass[i].filter(this.visRaw[i], VISIBILITY_ALPHA);
        this.lastVisibility[i] = v;
        this.lastVisible[i] = this.gates[i].update(v, tMs);
      }
    } else {
      // No subject: visibilities decay, gates close after the hold time, positions hold.
      for (let i = 0; i < N; i++) {
        const v = this.filtersLive ? this.visLowPass[i].filter(0, VISIBILITY_ALPHA) : 0;
        this.lastVisibility[i] = v;
        this.lastVisible[i] = this.gates[i].update(0, tMs);
      }
      if (!Number.isNaN(this.lastPresentMs) && tMs - this.lastPresentMs > ABSENCE_RESET_MS && this.filtersLive) {
        this.resetFilters();
      }
    }

    return {
      t: tSec,
      present,
      world: this.lastWorld.map((v) => v.clone()),
      image: this.lastImage.map((v) => v.clone()),
      visibility: this.lastVisibility.slice(),
      visible: this.lastVisible.slice(),
      mirror,
      size: [this.lastSize[0], this.lastSize[1]],
      hands: this.convertHands(frame.hands, mirror),
      face: this.convertFace(frame.face, mirror),
    };
  }

  /** Convert + mirror the raw landmarks into the flat scratch buffers. */
  private fillRaw(world: LandmarkTuple[], image: LandmarkTuple[], mirror: boolean): void {
    for (let i = 0; i < N; i++) {
      const src = mirror ? POSE_MIRROR_INDEX[i] : i;
      const w = world[src];
      const im = image[src];
      const sx = mirror ? -1 : 1;
      this.worldRaw[i * 3] = sx * w[0];
      this.worldRaw[i * 3 + 1] = -w[1];
      this.worldRaw[i * 3 + 2] = -w[2];
      this.imageRaw[i * 3] = mirror ? 1 - im[0] : im[0];
      this.imageRaw[i * 3 + 1] = im[1];
      this.imageRaw[i * 3 + 2] = im[2];
      // Visibility: prefer the world landmark's value, fall back to the image one.
      const vw = w[3];
      const vi = im[3];
      const v = Number.isFinite(vw) ? vw : Number.isFinite(vi) ? vi : 0;
      this.visRaw[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  private convertHands(
    hands: PoseFrame['hands'],
    mirror: boolean,
  ): { left: Vector3[] | null; right: Vector3[] | null } {
    if (!hands) return { left: null, right: null };
    const conv = (h: HandFrame | null): Vector3[] | null => {
      if (!h || h.world.length !== HAND_LANDMARK_COUNT) return null;
      const sx = mirror ? -1 : 1;
      return h.world.map((p: PointTuple) => new Vector3(sx * p[0], -p[1], -p[2]));
    };
    // Mirror swaps the sides: the subject's left hand appears on the model's right.
    return mirror
      ? { left: conv(hands.right), right: conv(hands.left) }
      : { left: conv(hands.left), right: conv(hands.right) };
  }

  private convertFace(face: PoseFrame['face'], mirror: boolean): FaceFrame | null {
    if (!face) return null;
    if (!mirror) {
      return { blendshapes: { ...face.blendshapes }, matrix: face.matrix ? face.matrix.slice() : null };
    }
    return mirrorFaceFrame(face);
  }
}
