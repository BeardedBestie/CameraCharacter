/**
 * Sampling plan for offline video analysis (docs/DESIGN.md §17). Pure.
 *
 * A clip of `durationSec` is sampled at `fps` frames per second of media time
 * between optional in/out points. Sample k sits at `start + k / fps`; the last
 * sample stays at least half a frame before the out point so a seek never
 * lands past the final decoded frame (browsers may present black there).
 */

export interface SamplePlan {
  fps: number;
  startSec: number;
  endSec: number;
  /** Number of samples (≥ 1 for any positive duration). */
  count: number;
}

export interface PlanOptions {
  startSec?: number;
  endSec?: number;
  /** Cap on the number of samples; the plan lowers its fps to stay under it. */
  maxFrames?: number;
}

export const DEFAULT_SAMPLE_FPS = 30;
export const SAMPLE_FPS_CHOICES: readonly number[] = [10, 15, 24, 25, 30, 50, 60];
export const DEFAULT_MAX_FRAMES = 20_000;

export function planSamples(durationSec: number, fps: number = DEFAULT_SAMPLE_FPS, opts: PlanOptions = {}): SamplePlan {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const start = Math.min(Math.max(opts.startSec ?? 0, 0), duration);
  const end = Math.min(Math.max(opts.endSec ?? duration, start), duration);
  let rate = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_SAMPLE_FPS;
  const span = end - start;
  const maxFrames = Math.max(1, Math.floor(opts.maxFrames ?? DEFAULT_MAX_FRAMES));
  if (duration <= 0) return { fps: rate, startSec: 0, endSec: 0, count: 0 };
  if (span <= 0) return { fps: rate, startSec: start, endSec: end, count: 1 };
  let count = Math.max(1, Math.floor(span * rate - 0.5) + 1);
  if (count > maxFrames) {
    count = maxFrames;
    rate = count > 1 ? (count - 1) / span : rate;
  }
  return { fps: rate, startSec: start, endSec: end, count };
}

/** Media time (seconds) of sample `k`, never past the last safely decodable frame. */
export function sampleTime(plan: SamplePlan, k: number): number {
  const t = plan.startSec + k / plan.fps;
  const last = Math.max(plan.startSec, plan.endSec - 0.5 / plan.fps);
  return Math.min(t, last);
}

/**
 * MediaPipe VIDEO mode requires strictly increasing integer millisecond
 * timestamps per landmarker instance. Feed media times in; get safe stamps out.
 */
export class MonotonicTimestamps {
  private last = -Infinity;

  next(ms: number): number {
    let ts = Math.round(Number.isFinite(ms) ? ms : this.last + 1);
    if (!(ts > this.last)) ts = Number.isFinite(this.last) ? this.last + 1 : 0;
    this.last = ts;
    return ts;
  }

  reset(): void {
    this.last = -Infinity;
  }
}

/** Remaining time estimate from the frames done so far (ms), or null before any progress. */
export function estimateRemainingMs(done: number, total: number, elapsedMs: number): number | null {
  if (!(done > 0) || !(total > done) || !(elapsedMs >= 0)) return null;
  return (elapsedMs / done) * (total - done);
}

/** `m:ss` for a duration in milliseconds (used by the clip list and progress text). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
