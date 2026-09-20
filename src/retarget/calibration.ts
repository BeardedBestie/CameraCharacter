/**
 * Calibration (docs/DESIGN.md §6.2 and §7): the silent standing baseline,
 * the optional pose calibration capture, and the per-role reference basis
 * selection used by the solver. Pure three.js math.
 */
import { Quaternion, Vector3 } from 'three';
import type { FilteredPose } from '../core/pose';
import type {
  BoneRefMode,
  FramingState,
  HumanoidBone,
  PoseCalibration,
  RefBasisRecord,
  RigAnalysis,
  SegmentName,
  SmoothingSettings,
} from '../core/types';
import { HUMANOID_BONES } from '../core/types';
import { DEG2RAD, rotationBetweenDirections } from '../core/math';
import { CANONICAL } from './canonical';
import type { BodyModelResult, MeasuredBasis } from './bodyModel';
import { RunningMedian } from './bodyModel';

const SEGMENTS: readonly SegmentName[] = ['upperArm', 'lowerArm', 'upperLeg', 'lowerLeg', 'shoulderWidth', 'hipWidth', 'torso'];

/** Confidence a torso/leg basis needs for a frame to count as "confident full body". */
export const BASELINE_MIN_CONFIDENCE = 0.6;

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/** Component-wise median of unit vectors, re-normalized. */
function medianVector(xs: number[], ys: number[], zs: number[], fallback: Vector3): Vector3 {
  const v = new Vector3(median(xs), median(ys), median(zs));
  if (!Number.isFinite(v.x) || v.lengthSq() < 1e-8) return fallback.clone();
  return v.normalize();
}

/** Orthogonalizes u against d and returns a plain record. */
export function toBasisRecord(d: Vector3, u: Vector3): RefBasisRecord {
  const dn = d.clone().normalize();
  const un = u.clone().addScaledVector(dn, -u.dot(dn));
  if (un.lengthSq() < 1e-8) un.set(0, 0, 1).addScaledVector(dn, -dn.z);
  un.normalize();
  return { d: [dn.x, dn.y, dn.z], u: [un.x, un.y, un.z] };
}

/**
 * Standing baseline: the median torso basis and segment medians over the
 * first `standingBaselineSec` seconds of confident full-body tracking.
 */
export class StandingBaseline {
  private settings: SmoothingSettings;
  private accumulated = 0;
  private readonly dx: number[] = [];
  private readonly dy: number[] = [];
  private readonly dz: number[] = [];
  private readonly ux: number[] = [];
  private readonly uy: number[] = [];
  private readonly uz: number[] = [];
  private readonly zSamples: number[] = [];
  private ready = false;
  private baseline: RefBasisRecord | null = null;
  private segments: Partial<Record<SegmentName, number>> = {};
  private zRefValue: number | null = null;

  constructor(settings: SmoothingSettings) {
    this.settings = settings;
  }

  setSettings(settings: SmoothingSettings): void {
    this.settings = settings;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Median torso basis (d = up, u = forward) once ready, else null. */
  get torsoBaseline(): RefBasisRecord | null {
    return this.baseline;
  }

  get segmentLengths(): Partial<Record<SegmentName, number>> {
    return this.segments;
  }

  /** Median depth estimate while standing, when depth samples were supplied. */
  get zRef(): number | null {
    return this.zRefValue;
  }

  /** Seconds of confident full-body tracking accumulated so far. */
  get progress(): number {
    return Math.min(1, this.accumulated / Math.max(this.settings.standingBaselineSec, 1e-3));
  }

  /**
   * Feed one frame. `depthZ` is the solver's depth estimate for the frame
   * (optional). Frames that are not confident full-body frames are ignored.
   */
  update(result: BodyModelResult, pose: FilteredPose, framing: FramingState, dt: number, depthZ: number | null = null): void {
    if (this.ready) return;
    if (!pose.present || framing !== 'full' || result.hipsLost) return;
    const hips = result.torso.hips;
    const legs = ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'] as const;
    if (hips.c < BASELINE_MIN_CONFIDENCE || hips.source !== 'measured') return;
    for (const l of legs) {
      const b = result.bases[l];
      if (!b || b.c < BASELINE_MIN_CONFIDENCE) return;
    }
    this.dx.push(hips.d.x);
    this.dy.push(hips.d.y);
    this.dz.push(hips.d.z);
    this.ux.push(hips.u.x);
    this.uy.push(hips.u.y);
    this.uz.push(hips.u.z);
    if (depthZ !== null && Number.isFinite(depthZ)) this.zSamples.push(depthZ);
    this.accumulated += Math.max(dt, 0);
    if (this.accumulated >= this.settings.standingBaselineSec && this.dx.length >= 5) {
      const d = medianVector(this.dx, this.dy, this.dz, new Vector3(0, 1, 0));
      const u = medianVector(this.ux, this.uy, this.uz, new Vector3(0, 0, 1));
      this.baseline = toBasisRecord(d, u);
      this.segments = { ...result.segmentLengths };
      this.zRefValue = this.zSamples.length ? median(this.zSamples) : null;
      this.ready = true;
    }
  }

  reset(): void {
    this.accumulated = 0;
    for (const a of [this.dx, this.dy, this.dz, this.ux, this.uy, this.uz, this.zSamples]) a.length = 0;
    this.ready = false;
    this.baseline = null;
    this.segments = {};
    this.zRefValue = null;
  }
}

/**
 * Pose calibration capture (§7.3): the user matches the model's rest pose and
 * the measured bases are averaged over `durationFrames` frames.
 */
export class PoseCalibrationCapture {
  private running = false;
  private target = 60;
  private count = 0;
  private readonly sums = new Map<HumanoidBone, { d: Vector3; u: Vector3; n: number }>();
  private readonly torsoSum = { d: new Vector3(), u: new Vector3(), n: 0 };
  private readonly segmentMedians = new Map<SegmentName, RunningMedian>();
  private readonly zSamples: number[] = [];
  private lastSegments: Partial<Record<SegmentName, number>> = {};
  private result: PoseCalibration | null = null;

  start(durationFrames = 60): void {
    this.running = true;
    this.target = Math.max(1, Math.round(durationFrames));
    this.count = 0;
    this.sums.clear();
    this.torsoSum.d.set(0, 0, 0);
    this.torsoSum.u.set(0, 0, 0);
    this.torsoSum.n = 0;
    this.segmentMedians.clear();
    this.zSamples.length = 0;
    this.lastSegments = {};
    this.result = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isDone(): boolean {
    return this.result !== null;
  }

  /** 0..1 progress of the capture. */
  get progress(): number {
    return Math.min(1, this.count / this.target);
  }

  get frames(): number {
    return this.count;
  }

  /** Feed one frame while running. Returns the finished calibration on the frame that completes it. */
  update(result: BodyModelResult, depthZ: number | null = null): PoseCalibration | null {
    if (!this.running) return null;
    for (const role of HUMANOID_BONES) {
      const b = result.bases[role];
      if (!b || b.c <= 0 || b.source === 'hold') continue;
      let acc = this.sums.get(role);
      if (!acc) {
        acc = { d: new Vector3(), u: new Vector3(), n: 0 };
        this.sums.set(role, acc);
      }
      acc.d.addScaledVector(b.d, b.c);
      // Weight the up reference by its own confidence so fallbacks barely count.
      acc.u.addScaledVector(b.u, Math.max(b.cU, 0.05) * b.c);
      acc.n += b.c;
    }
    const hips = result.torso.hips;
    if (hips.c > 0 && hips.source === 'measured') {
      this.torsoSum.d.addScaledVector(hips.d, hips.c);
      this.torsoSum.u.addScaledVector(hips.u, hips.c);
      this.torsoSum.n += hips.c;
    }
    for (const s of SEGMENTS) {
      const v = result.segmentLengths[s];
      if (v !== undefined && Number.isFinite(v)) {
        let m = this.segmentMedians.get(s);
        if (!m) {
          m = new RunningMedian(this.target);
          this.segmentMedians.set(s, m);
        }
        m.push(v);
      }
    }
    this.lastSegments = { ...result.segmentLengths };
    if (depthZ !== null && Number.isFinite(depthZ)) this.zSamples.push(depthZ);
    this.count++;
    if (this.count >= this.target) {
      this.running = false;
      this.result = this.build();
      return this.result;
    }
    return null;
  }

  /** The finished calibration, or null while running / before start. */
  getResult(): PoseCalibration | null {
    return this.result;
  }

  cancel(): void {
    this.running = false;
  }

  private build(): PoseCalibration {
    const bases: Partial<Record<HumanoidBone, RefBasisRecord>> = {};
    for (const [role, acc] of this.sums) {
      if (acc.n <= 0 || acc.d.lengthSq() < 1e-8) continue;
      const d = acc.d.clone().normalize();
      const u = acc.u.lengthSq() > 1e-8 ? acc.u.clone().normalize() : new Vector3().fromArray(CANONICAL[role].up);
      bases[role] = toBasisRecord(d, u);
    }
    const torsoBaseline =
      this.torsoSum.n > 0 && this.torsoSum.d.lengthSq() > 1e-8
        ? toBasisRecord(this.torsoSum.d.clone().normalize(), this.torsoSum.u.clone().normalize())
        : null;
    const segmentLengths: Partial<Record<SegmentName, number>> = {};
    for (const s of SEGMENTS) {
      const m = this.segmentMedians.get(s);
      if (m && m.size > 0) segmentLengths[s] = m.value();
      else if (this.lastSegments[s] !== undefined) segmentLengths[s] = this.lastSegments[s];
    }
    return {
      version: 3,
      createdAt: new Date().toISOString(),
      bases,
      torsoBaseline,
      segmentLengths,
      zRef: this.zSamples.length ? median(this.zSamples) : null,
      frames: this.count,
    };
  }
}

/** Rotates `u` about unit `d` by `deg` degrees, in place. */
export function applyRollOffset(d: Vector3, u: Vector3, deg: number): Vector3 {
  if (!deg) return u;
  _rollQ.setFromAxisAngle(_rollAxis.copy(d).normalize(), deg * DEG2RAD);
  return u.applyQuaternion(_rollQ);
}
const _rollQ = new Quaternion();
const _rollAxis = new Vector3();

/**
 * Canonical up min-rotated onto `dir`: rotate the canonical (dir, up) pair by
 * the shortest rotation taking the canonical dir to `dir` and return the
 * rotated up (used when the rig's geometry does not define an up reference).
 */
export function canonicalUpMinRotated(role: HumanoidBone, dir: Vector3, out = new Vector3()): Vector3 {
  const c = CANONICAL[role];
  _cd.fromArray(c.dir);
  _cu.fromArray(c.up);
  _dn.copy(dir).normalize();
  if (_dn.lengthSq() < 1e-8) return out.copy(_cu);
  if (_cd.dot(_dn) < -0.999999) {
    // Antiparallel: any 180° rotation about an axis perpendicular to dir; prefer keeping up.
    return out.copy(_cu).addScaledVector(_dn, -_cu.dot(_dn)).normalize();
  }
  rotationBetweenDirections(_cd, _dn, _rotQ);
  out.copy(_cu).applyQuaternion(_rotQ);
  out.addScaledVector(_dn, -out.dot(_dn));
  if (out.lengthSq() < 1e-8) return out.copy(_cu);
  return out.normalize();
}
const _cd = new Vector3();
const _cu = new Vector3();
const _dn = new Vector3();
const _rotQ = new Quaternion();

/**
 * Reference basis for a role in a given mode (§6.2). Returns fresh vectors
 * (the solver caches them) or null for modes without a reference
 * (`follow`, `off`) or when the analysis lacks the role.
 */
export function referenceBasisFor(
  role: HumanoidBone,
  mode: BoneRefMode,
  analysis: RigAnalysis,
  calibration: PoseCalibration | null,
  rollOffsetDeg: number,
): { d: Vector3; u: Vector3 } | null {
  let d: Vector3 | null = null;
  let u: Vector3 | null = null;
  const auto = (): boolean => {
    const a = analysis.analysis[role];
    if (!a) return false;
    d = new Vector3().fromArray(a.restDir);
    if (d.lengthSq() < 1e-8) return false;
    d.normalize();
    if (a.restUp) {
      u = new Vector3().fromArray(a.restUp);
      u.addScaledVector(d, -u.dot(d));
      if (u.lengthSq() < 1e-8) u = canonicalUpMinRotated(role, d);
      else u.normalize();
    } else {
      u = canonicalUpMinRotated(role, d);
    }
    return true;
  };
  switch (mode) {
    case 'auto':
      if (!auto()) return null;
      break;
    case 'relative': {
      const c = CANONICAL[role];
      d = new Vector3().fromArray(c.restDir).normalize();
      u = new Vector3().fromArray(c.restUp);
      break;
    }
    case 'calibrated': {
      const rec = calibration?.bases[role];
      if (rec) {
        d = new Vector3().fromArray(rec.d).normalize();
        u = new Vector3().fromArray(rec.u);
      } else if (!auto()) return null;
      break;
    }
    case 'follow':
    case 'off':
    default:
      return null;
  }
  if (!d || !u) return null;
  const dd = d as Vector3;
  const uu = u as Vector3;
  uu.addScaledVector(dd, -uu.dot(dd));
  if (uu.lengthSq() < 1e-8) uu.copy(canonicalUpMinRotated(role, dd));
  uu.normalize();
  applyRollOffset(dd, uu, rollOffsetDeg);
  return { d: dd, u: uu };
}

/** Effective torso baseline for the solver: calibration first, then the standing baseline, else canonical. */
export function effectiveTorsoBaseline(calibration: PoseCalibration | null, standing: RefBasisRecord | null): RefBasisRecord {
  if (calibration?.torsoBaseline) return calibration.torsoBaseline;
  if (standing) return standing;
  const c = CANONICAL.hips;
  return { d: [c.restDir[0], c.restDir[1], c.restDir[2]], u: [c.restUp[0], c.restUp[1], c.restUp[2]] };
}

export type { MeasuredBasis };
