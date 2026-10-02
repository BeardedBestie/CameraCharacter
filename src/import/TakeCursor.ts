/**
 * Frame lookup for a take that is played against an external clock (the
 * source video's `currentTime`). Pure, no DOM.
 *
 * `frameFor(ms)` returns the frame whose media time is the last one at or
 * before `ms` (relative to the first frame), or null when that frame was
 * already emitted. Emitted timestamps are rewritten to stay monotonic across
 * backward seeks and loops, the way RecordingSource does, so the downstream
 * filters never see time run backwards.
 */
import type { PoseFrame } from '../core/types';

export const VIDEO_TAKE_SRC = 'video-take';
const DEFAULT_GAP_MS = 1000 / 30;

export class TakeCursor {
  readonly frames: readonly PoseFrame[];
  /** Frame times relative to the first frame (ms), non-decreasing. */
  readonly rel: readonly number[];
  readonly nominalGapMs: number;
  private lastIndex = -1;
  private tOffset = 0;
  private lastTOut = NaN;

  constructor(frames: readonly PoseFrame[]) {
    this.frames = frames;
    const rel: number[] = new Array<number>(frames.length);
    const t0 = frames.length > 0 ? frames[0].t : 0;
    let prev = 0;
    for (let i = 0; i < frames.length; i++) {
      const r = Math.max(frames[i].t - t0, prev);
      rel[i] = r;
      prev = r;
    }
    this.rel = rel;
    const gaps: number[] = [];
    for (let i = 1; i < rel.length; i++) {
      const g = rel[i] - rel[i - 1];
      if (g > 0) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    this.nominalGapMs = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : DEFAULT_GAP_MS;
  }

  get count(): number {
    return this.frames.length;
  }

  /** Time of the last frame relative to the first (ms). */
  get duration(): number {
    return this.rel.length > 0 ? this.rel[this.rel.length - 1] : 0;
  }

  /** Index of the most recently emitted frame, -1 when none. */
  get lastEmitted(): number {
    return this.lastIndex;
  }

  /** Index of the last frame at or before `ms`; 0 before the first frame; -1 for an empty take. */
  indexAt(ms: number): number {
    const n = this.rel.length;
    if (n === 0) return -1;
    const target = Number.isFinite(ms) ? ms : 0;
    let lo = 0;
    let hi = n; // first index with rel > target
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rel[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  /**
   * The frame to emit for media time `ms`, stamped with a monotonic `t`, the
   * given `now` and the video-take source id; null when nothing new is due.
   */
  frameFor(ms: number, now: number): PoseFrame | null {
    const idx = this.indexAt(ms);
    if (idx < 0 || idx === this.lastIndex) return null;
    return this.emit(idx, now);
  }

  /** Emit a specific frame index (scrubbing, tests). */
  emit(index: number, now: number): PoseFrame {
    const i = Math.min(Math.max(index, 0), this.frames.length - 1);
    let t = this.rel[i] + this.tOffset;
    if (!Number.isNaN(this.lastTOut) && t <= this.lastTOut) {
      // Backward jump or repeat: keep the emitted clock running forward.
      this.tOffset = this.lastTOut + this.nominalGapMs - this.rel[i];
      t = this.rel[i] + this.tOffset;
    }
    this.lastTOut = t;
    this.lastIndex = i;
    const src = this.frames[i];
    return { ...src, t, now, src: VIDEO_TAKE_SRC };
  }

  /** Forget the last emitted index so the next `frameFor` emits again (after a seek). */
  invalidate(): void {
    this.lastIndex = -1;
  }

  reset(): void {
    this.lastIndex = -1;
    this.tOffset = 0;
    this.lastTOut = NaN;
  }
}
