/**
 * Camera keyframe track for imported clips (docs/DESIGN.md §17.4). Pure
 * three.js math, no DOM.
 *
 * A track is a time-sorted list of keyframes (camera position, look-at target,
 * vertical FOV). Between keyframes the position and target follow a
 * Catmull-Rom spline through the neighbouring keys (linear for two keys) with
 * a per-segment time easing: `smooth` (ease in/out), `linear`, or `cut` (hold
 * the previous key until the next one). Before the first and after the last
 * key the camera holds. Serializes to JSON for the clip store and for export.
 */
import { Vector3 } from 'three';
import { clamp, lerp, smoothstep } from '../core/math';
import type { Vec3Tuple } from '../core/types';

export type CameraEase = 'smooth' | 'linear' | 'cut';

export interface CameraKeyframe {
  /** Seconds since the start of the clip. */
  t: number;
  position: Vec3Tuple;
  target: Vec3Tuple;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Easing of the segment that starts at this key. */
  ease: CameraEase;
}

export interface CameraPose {
  position: Vector3;
  target: Vector3;
  fov: number;
}

export interface CameraTrackJson {
  format: 'cameracharacter-camera-track';
  version: 1;
  keys: CameraKeyframe[];
}

export const CAMERA_TRACK_FORMAT = 'cameracharacter-camera-track';
/** Keys closer than this (seconds) replace each other. */
export const KEY_MERGE_TOLERANCE_SEC = 0.02;
const EASES: readonly CameraEase[] = ['smooth', 'linear', 'cut'];

function tuple(v: Vector3 | Vec3Tuple): Vec3Tuple {
  return v instanceof Vector3 ? [v.x, v.y, v.z] : [v[0], v[1], v[2]];
}

function isTuple(v: unknown): v is Vec3Tuple {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Uniform Catmull-Rom for one component. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/** The key mirrored through `about`: 2·about − key (position and target). */
function reflect(about: CameraKeyframe, key: CameraKeyframe): Pick<CameraKeyframe, 'position' | 'target'> {
  return {
    position: [2 * about.position[0] - key.position[0], 2 * about.position[1] - key.position[1], 2 * about.position[2] - key.position[2]],
    target: [2 * about.target[0] - key.target[0], 2 * about.target[1] - key.target[1], 2 * about.target[2] - key.target[2]],
  };
}

function splineVec(p0: Vec3Tuple, p1: Vec3Tuple, p2: Vec3Tuple, p3: Vec3Tuple, u: number, out: Vector3): Vector3 {
  return out.set(catmullRom(p0[0], p1[0], p2[0], p3[0], u), catmullRom(p0[1], p1[1], p2[1], p3[1], u), catmullRom(p0[2], p1[2], p2[2], p3[2], u));
}

export class CameraTrack {
  private keysList: CameraKeyframe[] = [];

  constructor(keys: readonly CameraKeyframe[] = []) {
    for (const k of keys) this.add(k);
  }

  get keys(): readonly CameraKeyframe[] {
    return this.keysList;
  }

  get length(): number {
    return this.keysList.length;
  }

  get isEmpty(): boolean {
    return this.keysList.length === 0;
  }

  /** Duration covered by the keys (seconds), 0 for fewer than two keys. */
  get span(): number {
    const n = this.keysList.length;
    return n >= 2 ? this.keysList[n - 1].t - this.keysList[0].t : 0;
  }

  /**
   * Insert a key (copying its arrays), replacing a key within
   * {@link KEY_MERGE_TOLERANCE_SEC}. Returns the index of the stored key.
   */
  add(key: { t: number; position: Vector3 | Vec3Tuple; target: Vector3 | Vec3Tuple; fov: number; ease?: CameraEase }): number {
    const t = Number.isFinite(key.t) ? Math.max(0, key.t) : 0;
    const stored: CameraKeyframe = {
      t,
      position: tuple(key.position),
      target: tuple(key.target),
      fov: clamp(Number.isFinite(key.fov) ? key.fov : 35, 5, 150),
      ease: key.ease ?? 'smooth',
    };
    const existing = this.nearest(t, KEY_MERGE_TOLERANCE_SEC);
    if (existing >= 0) {
      this.keysList[existing] = { ...stored, t: this.keysList[existing].t };
      return existing;
    }
    let i = 0;
    while (i < this.keysList.length && this.keysList[i].t <= t) i++;
    this.keysList.splice(i, 0, stored);
    return i;
  }

  remove(index: number): boolean {
    if (index < 0 || index >= this.keysList.length) return false;
    this.keysList.splice(index, 1);
    return true;
  }

  /** Remove the key within `tol` seconds of `t`, if any. */
  removeAt(t: number, tol = KEY_MERGE_TOLERANCE_SEC): boolean {
    return this.remove(this.nearest(t, tol));
  }

  clear(): void {
    this.keysList = [];
  }

  setEase(index: number, ease: CameraEase): void {
    const k = this.keysList[index];
    if (k) k.ease = ease;
  }

  /** Move a key to a new time, keeping the list sorted. Returns the new index. */
  moveKey(index: number, t: number): number {
    const k = this.keysList[index];
    if (!k) return -1;
    this.keysList.splice(index, 1);
    return this.add({ ...k, t });
  }

  /** Index of the key nearest to `t`, or -1 when none lies within `tol` (Infinity = any). */
  nearest(t: number, tol = Infinity): number {
    let best = -1;
    let bestD = tol;
    for (let i = 0; i < this.keysList.length; i++) {
      const d = Math.abs(this.keysList[i].t - t);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Time of the next key strictly after `t`, or null. */
  nextKeyTime(t: number): number | null {
    for (const k of this.keysList) if (k.t > t + 1e-6) return k.t;
    return null;
  }

  /** Time of the previous key strictly before `t`, or null. */
  prevKeyTime(t: number): number | null {
    for (let i = this.keysList.length - 1; i >= 0; i--) if (this.keysList[i].t < t - 1e-6) return this.keysList[i].t;
    return null;
  }

  /** Camera pose at time `t` written into `out`; null when the track is empty. */
  evaluate(t: number, out: CameraPose): CameraPose | null {
    const keys = this.keysList;
    const n = keys.length;
    if (n === 0) return null;
    if (n === 1 || t <= keys[0].t) return this.copyKey(keys[0], out);
    if (t >= keys[n - 1].t) return this.copyKey(keys[n - 1], out);
    let i = 0;
    while (i + 1 < n && keys[i + 1].t <= t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    if (a.ease === 'cut') return this.copyKey(a, out);
    const span = b.t - a.t;
    let u = span > 0 ? (t - a.t) / span : 1;
    if (a.ease === 'smooth') u = smoothstep(0, 1, u);
    // Neighbours for the spline; a missing neighbour is reflected through the
    // end key, which makes two keys exactly linear and keeps the speed uniform
    // on the first and last segments.
    const p0 = i > 0 ? keys[i - 1] : reflect(a, b);
    const p3 = i + 2 < n ? keys[i + 2] : reflect(b, a);
    splineVec(p0.position, a.position, b.position, p3.position, u, out.position);
    splineVec(p0.target, a.target, b.target, p3.target, u, out.target);
    out.fov = lerp(a.fov, b.fov, u);
    return out;
  }

  private copyKey(k: CameraKeyframe, out: CameraPose): CameraPose {
    out.position.set(k.position[0], k.position[1], k.position[2]);
    out.target.set(k.target[0], k.target[1], k.target[2]);
    out.fov = k.fov;
    return out;
  }

  /** Shift every key by `dt` seconds (clamped at 0). */
  shift(dt: number): void {
    const keys = this.keysList.map((k) => ({ ...k, t: Math.max(0, k.t + dt) }));
    this.keysList = [];
    for (const k of keys) this.add(k);
  }

  toJSON(): CameraTrackJson {
    return {
      format: CAMERA_TRACK_FORMAT,
      version: 1,
      keys: this.keysList.map((k) => ({ t: k.t, position: [...k.position], target: [...k.target], fov: k.fov, ease: k.ease })),
    };
  }

  /** Parse a serialized track; malformed keys are skipped, a wrong format throws. */
  static fromJSON(json: unknown): CameraTrack {
    if (typeof json !== 'object' || json === null) throw new Error('Camera track must be a JSON object');
    const o = json as Record<string, unknown>;
    if (o.format !== CAMERA_TRACK_FORMAT) throw new Error(`Unsupported camera track format "${String(o.format)}"`);
    if (o.version !== 1) throw new Error(`Unsupported camera track version ${String(o.version)}`);
    if (!Array.isArray(o.keys)) throw new Error('Camera track is missing "keys"');
    const track = new CameraTrack();
    for (const raw of o.keys) {
      if (typeof raw !== 'object' || raw === null) continue;
      const k = raw as Record<string, unknown>;
      if (typeof k.t !== 'number' || !Number.isFinite(k.t) || !isTuple(k.position) || !isTuple(k.target)) continue;
      const fov = typeof k.fov === 'number' && Number.isFinite(k.fov) ? k.fov : 35;
      const ease = EASES.includes(k.ease as CameraEase) ? (k.ease as CameraEase) : 'smooth';
      track.add({ t: k.t, position: k.position, target: k.target, fov, ease });
    }
    return track;
  }

  /**
   * Generates an orbit shot: `count` keys evenly spaced over `durationSec`,
   * circling `center` at `radius` and `height`, `turns` revolutions starting at
   * `startDeg` (0° = in front of the character, +Z). Keys use linear easing so
   * the orbit speed is constant.
   */
  static orbit(opts: {
    center: Vector3 | Vec3Tuple;
    radius: number;
    height: number;
    durationSec: number;
    turns?: number;
    startDeg?: number;
    count?: number;
    fov?: number;
    startSec?: number;
    lookAtHeight?: number;
  }): CameraTrack {
    const c = tuple(opts.center);
    const turns = opts.turns ?? 1;
    const count = Math.max(2, Math.floor(opts.count ?? Math.max(8, Math.round(12 * Math.abs(turns)))));
    const start = opts.startSec ?? 0;
    const duration = Math.max(0.1, opts.durationSec);
    const fov = opts.fov ?? 35;
    const lookY = opts.lookAtHeight ?? c[1];
    const track = new CameraTrack();
    for (let i = 0; i < count; i++) {
      const f = i / (count - 1);
      const ang = ((opts.startDeg ?? 0) + 360 * turns * f) * (Math.PI / 180);
      track.add({
        t: start + duration * f,
        position: [c[0] + Math.sin(ang) * opts.radius, c[1] + opts.height, c[2] + Math.cos(ang) * opts.radius],
        target: [c[0], lookY, c[2]],
        fov,
        ease: 'linear',
      });
    }
    return track;
  }
}
