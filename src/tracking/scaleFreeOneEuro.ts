/**
 * Scale-free One Euro filter (docs/DESIGN.md §11): the classic Casiez et al.
 * filter with the speed term normalized by the subject's apparent size, so
 * `beta` has the same meaning whether the arrays are normalized image
 * coordinates of a distant subject or meters of a close one:
 *
 *   cutoff = minCutoff + beta · |dx/dt| / scale
 *
 * A step of one subject-size per second therefore adds `beta` Hz of cutoff.
 * The scale is passed per call because it is measured live (torso length EMA).
 * Pure; composes `LowPass` from core/math.
 */
import { LowPass } from '../core/math';
import type { OneEuroParams } from '../core/math';

const MIN_SCALE = 1e-4;

function alphaFor(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(cutoff, 1e-6));
  return 1 / (1 + tau / Math.max(dt, 1e-6));
}

export class ScaleFreeOneEuro {
  private readonly x = new LowPass();
  private readonly dx = new LowPass();
  private lastTime = NaN;

  constructor(public params: OneEuroParams) {}

  /**
   * Filter `value` sampled at time `t` (seconds). `scale` is the subject's
   * apparent size in the same units as `value`.
   */
  filter(value: number, t: number, scale: number): number {
    if (Number.isNaN(this.lastTime) || t <= this.lastTime) {
      this.lastTime = t;
      this.dx.filter(0, 1);
      return this.x.filter(value, 1);
    }
    const dt = t - this.lastTime;
    this.lastTime = t;
    const prev = this.x.last();
    const s = Number.isFinite(scale) && scale > MIN_SCALE ? scale : MIN_SCALE;
    const speed = (value - prev) / dt / s;
    const edx = this.dx.filter(speed, alphaFor(this.params.dCutoff, dt));
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(edx);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }

  /** Last filtered value (NaN before the first sample). */
  last(): number {
    return this.x.hasValue() ? this.x.last() : NaN;
  }

  hasValue(): boolean {
    return this.x.hasValue();
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastTime = NaN;
  }
}

/**
 * Scale-free One Euro filter for a 3-vector stored as three numbers, with an
 * optional separate parameter set for the third component (world z uses half
 * the minimum cutoff, §11).
 */
export class ScaleFreeOneEuro3 {
  private readonly fx: ScaleFreeOneEuro;
  private readonly fy: ScaleFreeOneEuro;
  private readonly fz: ScaleFreeOneEuro;

  constructor(params: OneEuroParams, zParams: OneEuroParams = params) {
    this.fx = new ScaleFreeOneEuro(params);
    this.fy = new ScaleFreeOneEuro(params);
    this.fz = new ScaleFreeOneEuro(zParams);
  }

  setParams(params: OneEuroParams, zParams: OneEuroParams = params): void {
    this.fx.params = params;
    this.fy.params = params;
    this.fz.params = zParams;
  }

  /** Filters (x, y, z) at `t` seconds and writes the result into `out` at `offset`. */
  filter(x: number, y: number, z: number, t: number, scale: number, out: number[], offset = 0): void {
    out[offset] = this.fx.filter(x, t, scale);
    out[offset + 1] = this.fy.filter(y, t, scale);
    out[offset + 2] = this.fz.filter(z, t, scale);
  }

  hasValue(): boolean {
    return this.fx.hasValue();
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}
