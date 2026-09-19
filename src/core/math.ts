/**
 * Pure math helpers used by the retargeting solver, filters and camera.
 * Only three.js math classes are used, so everything here runs in Node.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
const EPS = 1e-8;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, EPS), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent blend factor for an exponential approach at `rate` (1/s). */
export function expFactor(rate: number, dt: number): number {
  if (rate <= 0 || dt <= 0) return 0;
  return 1 - Math.exp(-rate * dt);
}

/** Angle in radians between two vectors (0..π). Zero vectors yield 0. */
export function angleBetween(a: Vector3, b: Vector3): number {
  const d = a.length() * b.length();
  if (d < EPS) return 0;
  return Math.acos(clamp(a.dot(b) / d, -1, 1));
}

/** Angle in radians between two unit quaternions (shortest arc). */
export function quatAngle(a: Quaternion, b: Quaternion): number {
  const dot = clamp(Math.abs(a.dot(b)), 0, 1);
  return 2 * Math.acos(dot);
}

/**
 * Component of `v` perpendicular to unit `axis`, normalized. Returns null when
 * `v` is (anti)parallel to the axis.
 */
export function perpendicularComponent(v: Vector3, axis: Vector3, out = new Vector3()): Vector3 | null {
  out.copy(v).addScaledVector(axis, -v.dot(axis));
  const len = out.length();
  if (len < 1e-5) return null;
  return out.multiplyScalar(1 / len);
}

/** Any unit vector perpendicular to `d` (deterministic). */
export function anyPerpendicular(d: Vector3, out = new Vector3()): Vector3 {
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  if (ax <= ay && ax <= az) out.set(1, 0, 0);
  else if (ay <= az) out.set(0, 1, 0);
  else out.set(0, 0, 1);
  return perpendicularComponent(out.clone(), d, out) ?? out.set(0, 1, 0);
}

/**
 * Builds a right-handed orthonormal frame from a direction `d` and an up reference `u`.
 * Column 0 = d (normalized), column 2 = component of u perpendicular to d (normalized),
 * column 1 = column2 × column0, so that col0 × col1 = col2.
 * If `u` is parallel to `d`, a deterministic perpendicular is used.
 */
export function frameFromDirUp(d: Vector3, u: Vector3, out = new Matrix4()): Matrix4 {
  const x = _fx.copy(d);
  const lx = x.length();
  if (lx < EPS) x.set(0, 1, 0);
  else x.multiplyScalar(1 / lx);
  let z = perpendicularComponent(u, x, _fz);
  if (!z) z = anyPerpendicular(x, _fz);
  const y = _fy.crossVectors(z, x).normalize();
  return out.makeBasis(x, y, z);
}
const _fx = new Vector3();
const _fy = new Vector3();
const _fz = new Vector3();

/** Quaternion form of {@link frameFromDirUp}. */
export function quatFromDirUp(d: Vector3, u: Vector3, out = new Quaternion()): Quaternion {
  return out.setFromRotationMatrix(frameFromDirUp(d, u, _fm));
}
const _fm = new Matrix4();

/**
 * Rotation R (as a quaternion) such that R · F_ref = F_meas, where both frames are
 * built with {@link frameFromDirUp}. Equivalent to q_meas · q_refᵀ.
 */
export function rotationBetweenBases(
  dRef: Vector3,
  uRef: Vector3,
  dMeas: Vector3,
  uMeas: Vector3,
  out = new Quaternion(),
): Quaternion {
  quatFromDirUp(dRef, uRef, _qa);
  quatFromDirUp(dMeas, uMeas, _qb);
  return out.copy(_qb).multiply(_qa.invert());
}
const _qa = new Quaternion();
const _qb = new Quaternion();

/** Shortest-arc rotation taking unit `from` to unit `to`. */
export function rotationBetweenDirections(from: Vector3, to: Vector3, out = new Quaternion()): Quaternion {
  _ra.copy(from).normalize();
  _rb.copy(to).normalize();
  return out.setFromUnitVectors(_ra, _rb);
}
const _ra = new Vector3();
const _rb = new Vector3();

/**
 * Swing/twist decomposition of `q` about unit `axis`: q = swing · twist, where
 * `twist` is a rotation about `axis` and `swing` moves `axis` onto q·axis.
 * Returns the twist angle in radians (signed about `axis`).
 */
export function swingTwist(
  q: Quaternion,
  axis: Vector3,
  outSwing: Quaternion,
  outTwist: Quaternion,
): number {
  const proj = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  outTwist.set(axis.x * proj, axis.y * proj, axis.z * proj, q.w);
  const len = outTwist.length();
  if (len < EPS) {
    outTwist.identity();
  } else {
    outTwist.normalize();
  }
  if (outTwist.w < 0) outTwist.set(-outTwist.x, -outTwist.y, -outTwist.z, -outTwist.w);
  outSwing.copy(q).multiply(_st.copy(outTwist).invert());
  const angle = 2 * Math.atan2(outTwist.x * axis.x + outTwist.y * axis.y + outTwist.z * axis.z, outTwist.w);
  return angle;
}
const _st = new Quaternion();

/**
 * Removes twist about `axis` from rotation `q`, scaling the twist angle by `keep` (0..1).
 * keep=1 returns q unchanged; keep=0 returns the pure swing.
 */
export function limitTwist(q: Quaternion, axis: Vector3, keep: number, out = new Quaternion()): Quaternion {
  const angle = swingTwist(q, axis, _lsw, _ltw);
  const scaled = angle * clamp(keep, 0, 1);
  _ltw.setFromAxisAngle(axis, scaled);
  return out.copy(_lsw).multiply(_ltw);
}
const _lsw = new Quaternion();
const _ltw = new Quaternion();

/** Positive-hemisphere slerp toward `target` by factor `t`, in place. */
export function slerpShortest(q: Quaternion, target: Quaternion, t: number): Quaternion {
  if (q.dot(target) < 0) {
    _neg.set(-target.x, -target.y, -target.z, -target.w);
    return q.slerp(_neg, t);
  }
  return q.slerp(target, t);
}
const _neg = new Quaternion();

// ---------------------------------------------------------------------------
// One Euro filter (Casiez et al. 2012)
// ---------------------------------------------------------------------------

export class LowPass {
  private y = 0;
  private initialized = false;
  filter(x: number, alpha: number): number {
    if (!this.initialized) {
      this.y = x;
      this.initialized = true;
      return x;
    }
    this.y = alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number {
    return this.y;
  }
  reset(): void {
    this.initialized = false;
  }
  hasValue(): boolean {
    return this.initialized;
  }
}

export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private lastTime = NaN;
  constructor(public params: OneEuroParams = { minCutoff: 1.0, beta: 0.02, dCutoff: 1.0 }) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * Math.max(cutoff, 1e-6));
    return 1 / (1 + tau / Math.max(dt, 1e-6));
  }

  /** `t` in seconds. */
  filter(value: number, t: number): number {
    if (Number.isNaN(this.lastTime) || t <= this.lastTime) {
      this.lastTime = t;
      this.dx.filter(0, 1);
      return this.x.filter(value, 1);
    }
    const dt = t - this.lastTime;
    this.lastTime = t;
    const prev = this.x.last();
    const dxRaw = (value - prev) / dt;
    const edx = this.dx.filter(dxRaw, OneEuroFilter.alpha(this.params.dCutoff, dt));
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(edx);
    return this.x.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastTime = NaN;
  }
}

/** One Euro filter for an N-dimensional vector stored as a flat array. */
export class OneEuroVector {
  private filters: OneEuroFilter[];
  constructor(dims: number, public params: OneEuroParams) {
    this.filters = Array.from({ length: dims }, () => new OneEuroFilter(params));
  }
  setParams(params: OneEuroParams): void {
    this.params = params;
    for (const f of this.filters) f.params = params;
  }
  filter(values: ArrayLike<number>, t: number, out: number[] = []): number[] {
    for (let i = 0; i < this.filters.length; i++) out[i] = this.filters[i].filter(values[i], t);
    return out;
  }
  reset(): void {
    for (const f of this.filters) f.reset();
  }
}

// ---------------------------------------------------------------------------
// Critically damped spring (for camera and hips translation)
// ---------------------------------------------------------------------------

export class SpringScalar {
  value: number;
  velocity = 0;
  constructor(initial = 0, public frequency = 3) {
    this.value = initial;
  }
  /** Advance toward `target`. `frequency` in Hz-like units (omega = 2π f). */
  update(target: number, dt: number): number {
    if (dt <= 0) return this.value;
    const omega = 2 * Math.PI * this.frequency;
    // Semi-implicit critically damped spring, stable for large dt.
    const x = this.value - target;
    const temp = (this.velocity + omega * x) * dt;
    const exp = Math.exp(-omega * dt);
    this.value = target + (x + temp) * exp;
    this.velocity = (this.velocity - omega * temp) * exp;
    return this.value;
  }
  snap(v: number): void {
    this.value = v;
    this.velocity = 0;
  }
}

export class SpringVector3 {
  readonly value = new Vector3();
  private sx: SpringScalar;
  private sy: SpringScalar;
  private sz: SpringScalar;
  constructor(initial = new Vector3(), frequency = 3) {
    this.value.copy(initial);
    this.sx = new SpringScalar(initial.x, frequency);
    this.sy = new SpringScalar(initial.y, frequency);
    this.sz = new SpringScalar(initial.z, frequency);
  }
  set frequency(f: number) {
    this.sx.frequency = f;
    this.sy.frequency = f;
    this.sz.frequency = f;
  }
  get frequency(): number {
    return this.sx.frequency;
  }
  update(target: Vector3, dt: number): Vector3 {
    this.value.set(this.sx.update(target.x, dt), this.sy.update(target.y, dt), this.sz.update(target.z, dt));
    return this.value;
  }
  snap(v: Vector3): void {
    this.value.copy(v);
    this.sx.snap(v.x);
    this.sy.snap(v.y);
    this.sz.snap(v.z);
  }
}

// ---------------------------------------------------------------------------
// Hysteresis gate with hold time (for per-landmark / per-bone visibility)
// ---------------------------------------------------------------------------

export class HysteresisGate {
  private on = false;
  private lastOnTime = -Infinity;
  constructor(public onThreshold = 0.65, public offThreshold = 0.45, public holdMs = 250) {}
  /** Returns whether the gate is open for `value` at time `tMs`. */
  update(value: number, tMs: number): boolean {
    if (value >= this.onThreshold) {
      this.on = true;
      this.lastOnTime = tMs;
    } else if (value <= this.offThreshold) {
      if (this.on && tMs - this.lastOnTime > this.holdMs) this.on = false;
    } else if (this.on) {
      this.lastOnTime = tMs;
    }
    return this.on;
  }
  isOpen(): boolean {
    return this.on;
  }
  reset(): void {
    this.on = false;
    this.lastOnTime = -Infinity;
  }
}

/** Stable hash (FNV-1a, 32-bit) of a string, hex encoded. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
