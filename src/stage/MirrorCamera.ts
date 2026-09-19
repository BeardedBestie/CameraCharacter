/**
 * Mirror camera (docs/DESIGN.md §8). Pure three.js math, no DOM: the framing
 * function and the controller both run in Node so they can be unit-tested.
 *
 * `computeMirrorFraming` maps the visible body span measured on the user (in
 * units of the user's height, docs/DESIGN.md §6.4) onto the model through the
 * rig's height table and returns the camera distance and height that frame
 * exactly that part of the model with a small margin.
 *
 * `MirrorCameraController` drives a PerspectiveCamera in one of three modes:
 *   mirror – frames the visible span like a mirror would (horizontal look,
 *            never tilts), springs + dead-band + rate limit against pumping;
 *   follow – full-body framing that pans with the hips;
 *   orbit  – hands the camera to OrbitControls.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { DEG2RAD, SpringScalar, clamp, lerp, smoothstep } from '../core/math';
import type { CameraMode, FramingFit, HeightTable } from '../core/types';
import { USER_PROPORTIONS } from '../core/types';

// ---------------------------------------------------------------------------
// Framing (pure)
// ---------------------------------------------------------------------------

export interface MirrorFramingOptions {
  /** Vertical field of view of the camera in degrees. */
  vfovDeg: number;
  /** Multiplier on the model span (1.08 = 4 % headroom on each side). */
  margin?: number;
  /** Distance clamps in meters. */
  minDistance?: number;
  maxDistance?: number;
}

export interface MirrorFraming {
  /** Camera distance from the model's vertical axis, meters (clamped). */
  distance: number;
  /** Camera height = look-at height, meters (midpoint of the visible model span). */
  targetY: number;
  /** Visible model span in meters (model space, same frame as the height table). */
  spanBottom: number;
  spanTop: number;
}

export const DEFAULT_MARGIN = 1.08;
export const DEFAULT_MIN_DISTANCE = 0.6;
export const DEFAULT_MAX_DISTANCE = 6;
export const DEFAULT_MIRROR_FOV_DEG = 35;
/** The frame's top edge maps to at most 1.05 H (docs/DESIGN.md §6.4). */
export const FULL_BODY_TOP = 1.05;
export const FULL_BODY_BOTTOM = 0;
/** Fallback model height when a height table is degenerate. */
const FALLBACK_HEIGHT = 1.7;
/** Smallest model span that is framed (avoids a zero-height frustum). */
const MIN_SPAN = 0.05;

/** Height-table knots in user-height units, floor to head top (strictly increasing). */
const KNOT_H: readonly number[] = [
  0,
  USER_PROPORTIONS.ankles,
  USER_PROPORTIONS.knees,
  USER_PROPORTIONS.hips,
  USER_PROPORTIONS.shoulders,
  USER_PROPORTIONS.eyes,
  1,
];

const TABLE_KEYS: readonly (keyof HeightTable)[] = ['floor', 'ankles', 'knees', 'hips', 'shoulders', 'eyes', 'headTop'];

/**
 * Returns a monotonic (non-decreasing) copy of a height table. Non-finite or
 * out-of-order entries are clamped to their lower neighbour; a table without
 * a usable height falls back to canonical proportions of {@link FALLBACK_HEIGHT}.
 */
export function sanitizeHeightTable(table: HeightTable): HeightTable {
  const floor = Number.isFinite(table.floor) ? table.floor : 0;
  const rawTop = Number.isFinite(table.headTop) ? table.headTop : floor;
  if (rawTop - floor < 1e-3) {
    const h = FALLBACK_HEIGHT;
    return {
      floor,
      ankles: floor + KNOT_H[1] * h,
      knees: floor + KNOT_H[2] * h,
      hips: floor + KNOT_H[3] * h,
      shoulders: floor + KNOT_H[4] * h,
      eyes: floor + KNOT_H[5] * h,
      headTop: floor + h,
    };
  }
  const out: HeightTable = { ...table, floor };
  let prev = floor;
  for (let i = 1; i < TABLE_KEYS.length; i++) {
    const key = TABLE_KEYS[i];
    const v = table[key];
    const clamped = Number.isFinite(v) ? Math.max(v, prev) : prev;
    out[key] = Math.min(clamped, rawTop);
    prev = out[key];
  }
  out.headTop = rawTop;
  return out;
}

/**
 * Model height (meters, model frame) at a user-proportion height `h` (0 =
 * floor, 1 = head top), piecewise-linear between the table's knots and
 * extrapolated linearly with the model's total height outside [0, 1].
 * The table must already be sanitized (monotonic).
 */
export function modelHeightAt(h: number, table: HeightTable): number {
  const modelHeight = table.headTop - table.floor;
  if (h <= 0) return table.floor + h * modelHeight;
  if (h >= 1) return table.headTop + (h - 1) * modelHeight;
  for (let i = 1; i < KNOT_H.length; i++) {
    const h1 = KNOT_H[i];
    if (h <= h1) {
      const h0 = KNOT_H[i - 1];
      const y0 = table[TABLE_KEYS[i - 1]];
      const y1 = table[TABLE_KEYS[i]];
      // KNOT_H is strictly increasing, so the division is always safe even
      // when y0 === y1 (a knee sanitized onto the hips).
      return lerp(y0, y1, (h - h0) / (h1 - h0));
    }
  }
  return table.headTop;
}

/** Distance at which a vertical span of `spanMeters` fills the frame with `margin`. */
export function distanceForSpan(spanMeters: number, vfovDeg: number, margin = DEFAULT_MARGIN): number {
  const halfTan = Math.tan(clamp(vfovDeg, 1, 179) * 0.5 * DEG2RAD);
  return (Math.max(spanMeters, MIN_SPAN) * margin) / (2 * halfTan);
}

/**
 * Camera distance and height framing the user's visible span on the model
 * (docs/DESIGN.md §8). Only `visibleBottom`/`visibleTop` of the fit are used,
 * so a plain `{ visibleBottom, visibleTop }` object works as well.
 */
export function computeMirrorFraming(
  fit: Pick<FramingFit, 'visibleBottom' | 'visibleTop'>,
  table: HeightTable,
  opts: MirrorFramingOptions,
): MirrorFraming {
  const t = sanitizeHeightTable(table);
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const minD = opts.minDistance ?? DEFAULT_MIN_DISTANCE;
  const maxD = Math.max(opts.maxDistance ?? DEFAULT_MAX_DISTANCE, minD);
  const lo = Math.min(fit.visibleBottom, fit.visibleTop);
  const hi = Math.max(fit.visibleBottom, fit.visibleTop);
  const spanBottom = modelHeightAt(Number.isFinite(lo) ? lo : FULL_BODY_BOTTOM, t);
  const spanTop = modelHeightAt(Number.isFinite(hi) ? hi : FULL_BODY_TOP, t);
  const distance = clamp(distanceForSpan(spanTop - spanBottom, opts.vfovDeg, margin), minD, maxD);
  return { distance, targetY: 0.5 * (spanBottom + spanTop), spanBottom, spanTop };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** The subset of OrbitControls the controller touches (duck-typed so tests can pass a fake). */
export interface OrbitLike {
  enabled: boolean;
  target?: Vector3;
  update?(deltaTime?: number): unknown;
}

export interface MirrorCameraOptions {
  /** Mirror/follow vertical FOV in degrees (default 35). */
  vfovDeg?: number;
  margin?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Spring frequencies in Hz (critically damped). */
  distanceHz?: number;
  targetHz?: number;
  /** Camera x/z follow the model laterally with a slower spring. */
  lateralHz?: number;
  /** Relative dead-band on the visible span (0.04 = 4 %). */
  spanDeadband?: number;
  /** Maximum distance change in m/s. */
  distanceRateLimit?: number;
  /** After this many seconds without a subject the framing returns to full body... */
  absentTimeoutSec?: number;
  /** ...easing over this many seconds. */
  absentEaseSec?: number;
  /** Full-body span in user-height units. */
  fullBodyTop?: number;
  fullBodyBottom?: number;
  /** OrbitControls (or a stand-in) enabled only in orbit mode. */
  controls?: OrbitLike | null;
  /** Initial mode (default mirror). */
  mode?: CameraMode;
}

export interface MirrorCameraInput {
  /** Latest framing fit, or null when no subject is tracked. */
  fit: FramingFit | null;
  /** The rig's height table (model frame, meters; relative to `origin`). */
  table: HeightTable;
  /** World position of the model's hips (follow mode pans with it). */
  hipsWorld: Vector3;
  /** The user's metric lateral offset in meters, already mirrored (mirror mode). */
  lateralOffset: number;
  present: boolean;
  /** Seconds since the subject was last present (0 while present). */
  absentFor: number;
  /** Where the model stands (spawn point); default origin. */
  origin?: Vector3;
}

interface Span {
  bottom: number;
  top: number;
}

const ZERO = new Vector3();

export class MirrorCameraController {
  readonly camera: PerspectiveCamera;
  private opts: Required<Omit<MirrorCameraOptions, 'controls' | 'mode'>>;
  private controls: OrbitLike | null;
  private modeValue: CameraMode = 'orbit';
  private savedFov: number;
  private fovOverridden = false;

  private readonly distanceSpring = new SpringScalar(3, 1.5);
  private readonly targetSpring = new SpringScalar(0.9, 2.5);
  private readonly xSpring = new SpringScalar(0, 1);
  private readonly zSpring = new SpringScalar(0, 1);
  private initialized = false;

  /** Span committed through the dead-band (user-height units). */
  private committed: Span | null = null;
  /** Span shown when the subject was last present; start of the absent ease. */
  private presentSpan: Span | null = null;
  /** Progress of the ease toward full body while absent, 0..1. */
  private absentBlend = 0;

  private readonly lookTarget = new Vector3();
  private readonly tmp = new Vector3();

  constructor(camera: PerspectiveCamera, opts: MirrorCameraOptions = {}) {
    this.camera = camera;
    this.savedFov = camera.fov;
    this.controls = opts.controls ?? null;
    this.opts = {
      vfovDeg: opts.vfovDeg ?? DEFAULT_MIRROR_FOV_DEG,
      margin: opts.margin ?? DEFAULT_MARGIN,
      minDistance: opts.minDistance ?? DEFAULT_MIN_DISTANCE,
      maxDistance: opts.maxDistance ?? DEFAULT_MAX_DISTANCE,
      distanceHz: opts.distanceHz ?? 1.5,
      targetHz: opts.targetHz ?? 2.5,
      lateralHz: opts.lateralHz ?? 1.0,
      spanDeadband: opts.spanDeadband ?? 0.04,
      distanceRateLimit: opts.distanceRateLimit ?? 1.5,
      absentTimeoutSec: opts.absentTimeoutSec ?? 3,
      absentEaseSec: opts.absentEaseSec ?? 2,
      fullBodyTop: opts.fullBodyTop ?? FULL_BODY_TOP,
      fullBodyBottom: opts.fullBodyBottom ?? FULL_BODY_BOTTOM,
    };
    this.applyFrequencies();
    this.setMode(opts.mode ?? 'mirror');
  }

  get mode(): CameraMode {
    return this.modeValue;
  }

  /** Current (sprung) camera distance from the model axis. */
  get distance(): number {
    return this.distanceSpring.value;
  }

  /** Current (sprung) look-at height. */
  get targetY(): number {
    return this.targetSpring.value;
  }

  /** The span (user-height units) currently committed through the dead-band, or null before the first update. */
  get committedSpan(): Readonly<Span> | null {
    return this.committed;
  }

  get options(): Readonly<Required<Omit<MirrorCameraOptions, 'controls' | 'mode'>>> {
    return this.opts;
  }

  setOptions(patch: Partial<Omit<MirrorCameraOptions, 'controls' | 'mode'>>): void {
    Object.assign(this.opts, patch);
    this.applyFrequencies();
    if (patch.vfovDeg !== undefined && this.fovOverridden) {
      this.camera.fov = this.opts.vfovDeg;
      this.camera.updateProjectionMatrix();
    }
  }

  setControls(controls: OrbitLike | null): void {
    this.controls = controls;
    if (controls) controls.enabled = this.modeValue === 'orbit';
  }

  private applyFrequencies(): void {
    this.distanceSpring.frequency = this.opts.distanceHz;
    this.targetSpring.frequency = this.opts.targetHz;
    this.xSpring.frequency = this.opts.lateralHz;
    this.zSpring.frequency = this.opts.lateralHz;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.modeValue) return;
    const framing = mode === 'mirror' || mode === 'follow';
    if (framing && !this.fovOverridden) {
      this.savedFov = this.camera.fov;
      this.camera.fov = this.opts.vfovDeg;
      this.camera.updateProjectionMatrix();
      this.fovOverridden = true;
    } else if (!framing && this.fovOverridden) {
      this.camera.fov = this.savedFov;
      this.camera.updateProjectionMatrix();
      this.fovOverridden = false;
    }
    if (this.controls) {
      this.controls.enabled = mode === 'orbit';
      if (mode === 'orbit' && this.controls.target && this.initialized) {
        this.controls.target.copy(this.lookTarget);
      }
    }
    this.modeValue = mode;
  }

  /** Forget the sprung state; the next update snaps the camera to its goal (e.g. after a model load). */
  reset(): void {
    this.initialized = false;
    this.committed = null;
    this.presentSpan = null;
    this.absentBlend = 0;
  }

  /** Advance the camera by `dt` seconds. In orbit mode only the controls are updated. */
  update(dt: number, input: MirrorCameraInput): void {
    if (this.modeValue === 'orbit') {
      this.controls?.update?.(dt);
      return;
    }
    const o = this.opts;
    const origin = input.origin ?? ZERO;
    const goal = this.goalSpan(input, dt);
    const framing = computeMirrorFraming(
      { visibleBottom: goal.bottom, visibleTop: goal.top },
      input.table,
      { vfovDeg: this.camera.fov, margin: o.margin, minDistance: o.minDistance, maxDistance: o.maxDistance },
    );
    const targetY = origin.y + framing.targetY;
    let targetX: number;
    let targetZ: number;
    if (this.modeValue === 'follow') {
      targetX = input.hipsWorld.x;
      targetZ = input.hipsWorld.z;
    } else {
      targetX = origin.x + input.lateralOffset;
      targetZ = origin.z;
    }

    if (!this.initialized) {
      this.distanceSpring.snap(framing.distance);
      this.targetSpring.snap(targetY);
      this.xSpring.snap(targetX);
      this.zSpring.snap(targetZ);
      this.initialized = true;
    } else if (dt > 0) {
      const prev = this.distanceSpring.value;
      this.distanceSpring.update(framing.distance, dt);
      const maxStep = o.distanceRateLimit * dt;
      const step = this.distanceSpring.value - prev;
      if (Math.abs(step) > maxStep) {
        const s = Math.sign(step);
        this.distanceSpring.value = prev + s * maxStep;
        this.distanceSpring.velocity = s * o.distanceRateLimit;
      }
      this.targetSpring.update(targetY, dt);
      this.xSpring.update(targetX, dt);
      this.zSpring.update(targetZ, dt);
    }

    const x = this.xSpring.value;
    const y = this.targetSpring.value;
    const z = this.zSpring.value;
    this.lookTarget.set(x, y, z);
    this.camera.position.set(x, y, z + this.distanceSpring.value);
    // Horizontal look direction: a mirror never tilts.
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.tmp.set(x, y, z - 1));
  }

  /** Visible span to frame (user-height units) after dead-band and absence handling. */
  private goalSpan(input: MirrorCameraInput, dt: number): Span {
    const o = this.opts;
    const full: Span = { bottom: o.fullBodyBottom, top: o.fullBodyTop };
    if (this.modeValue === 'follow') {
      this.committed = full;
      return full;
    }
    const fit = input.fit;
    const tracked = input.present && fit !== null && fit.valid && fit.state !== 'none';
    if (tracked) {
      this.absentBlend = 0;
      this.presentSpan = null;
      const candidate: Span = {
        bottom: Math.min(fit.visibleBottom, fit.visibleTop),
        top: Math.max(fit.visibleBottom, fit.visibleTop),
      };
      if (this.committed === null || this.exceedsDeadband(candidate, this.committed)) {
        this.committed = candidate;
      }
      return this.committed;
    }
    // Absent (or an unusable fit): hold the last framing for the timeout, then ease to full body.
    if (this.committed === null) {
      this.committed = full;
      return full;
    }
    const absentFor = input.present ? 0 : input.absentFor;
    if (absentFor <= o.absentTimeoutSec) return this.committed;
    if (this.presentSpan === null) this.presentSpan = { ...this.committed };
    this.absentBlend = clamp(this.absentBlend + (o.absentEaseSec > 0 ? dt / o.absentEaseSec : 1), 0, 1);
    const k = smoothstep(0, 1, this.absentBlend);
    this.committed = {
      bottom: lerp(this.presentSpan.bottom, full.bottom, k),
      top: lerp(this.presentSpan.top, full.top, k),
    };
    return this.committed;
  }

  private exceedsDeadband(candidate: Span, committed: Span): boolean {
    const span = Math.max(committed.top - committed.bottom, 1e-3);
    const tol = this.opts.spanDeadband * span;
    const dSpan = Math.abs(candidate.top - candidate.bottom - span);
    const dMid = Math.abs(0.5 * (candidate.top + candidate.bottom) - 0.5 * (committed.top + committed.bottom));
    return dSpan > tol || dMid > tol;
  }
}
