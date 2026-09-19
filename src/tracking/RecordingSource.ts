/**
 * PoseSource that replays a `.mocap.json` landmark take. Timer-driven playback
 * honors the recorded timestamps with drift correction; `step()` advances one
 * frame deterministically without timers (tests, end-to-end runs, scrubbing).
 *
 * Emitted timestamps are rewritten so they are monotonic in playback time and
 * expressed in recording-time milliseconds (independent of playback speed):
 * looping and seeking add an offset so the stream never goes backwards. `now`
 * is stamped at emission (performance.now()) so clip/video recorders align
 * with the replay, not with the original capture.
 * Only `fromFile` / `fromUrl` need a browser; everything else runs in Node.
 */
import type { MocapRecording, PoseFrame } from '../core/types';
import { BaseSource } from './PoseSource';
import { parseMocapRecording } from './protocol';

export { parseMocapRecording } from './protocol';

export const RECORDING_SRC = 'recording';
/** Frames dropped per tick before catching up by skipping (drift correction). */
const MAX_FRAMES_PER_TICK = 3;
/** Fallback inter-frame gap (ms) for single-frame recordings. */
const DEFAULT_GAP_MS = 1000 / 30;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class RecordingSource extends BaseSource {
  readonly kind = 'recording' as const;

  readonly recording: MocapRecording;
  /** Frame times relative to the first frame (ms), non-decreasing. */
  private readonly rel: number[];
  /** Typical inter-frame gap in ms (median), used for loop/seek continuity. */
  readonly nominalGapMs: number;

  private cursor = 0;
  private lastEmitted = -1;
  private position = 0;
  private playing = false;
  private loop = true;
  private speed = 1;
  private started = false;

  /** Offset added to rel[] to keep emitted timestamps monotonic. */
  private tOffset = 0;
  private lastTOut = NaN;

  private wallStart = 0;
  private timeAtStart = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(recording: MocapRecording) {
    super();
    this.recording = recording;
    const frames = recording.frames;
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

  static fromRecording(rec: MocapRecording): RecordingSource {
    return new RecordingSource(parseMocapRecording(rec));
  }

  static fromJson(json: unknown): RecordingSource {
    return new RecordingSource(parseMocapRecording(json));
  }

  static async fromFile(file: File): Promise<RecordingSource> {
    const text = await file.text();
    return RecordingSource.fromText(text);
  }

  static async fromUrl(url: string): Promise<RecordingSource> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load recording ${url}: HTTP ${res.status}`);
    return RecordingSource.fromText(await res.text());
  }

  static fromText(text: string): RecordingSource {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`Recording is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return RecordingSource.fromJson(json);
  }

  // ---- state -------------------------------------------------------------

  get frameCount(): number {
    return this.recording.frames.length;
  }

  /** Duration in ms (time of the last frame relative to the first). */
  get duration(): number {
    return this.rel.length > 0 ? this.rel[this.rel.length - 1] : 0;
  }

  /** Current playback position in ms within the recording. */
  get time(): number {
    if (this.playing) return this.clockTime();
    return this.position;
  }

  /** Index of the most recently emitted frame, -1 when none. */
  get frameIndex(): number {
    return this.lastEmitted;
  }

  /** Index of the frame the next step() will emit (== frameCount at the end without loop). */
  get nextFrameIndex(): number {
    return this.cursor;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isLooping(): boolean {
    return this.loop;
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  // ---- PoseSource ----------------------------------------------------------

  async start(): Promise<void> {
    this.started = true;
    this.setStatus({ state: 'running', message: `${this.frameCount} frames, ${(this.duration / 1000).toFixed(1)} s` });
    this.play();
  }

  stop(): void {
    this.pause();
    this.started = false;
    this.setStatus({ state: 'stopped' });
  }

  // ---- controls ------------------------------------------------------------

  play(): void {
    if (this.frameCount === 0) return;
    if (this.cursor >= this.frameCount) {
      // At the end: restart from the beginning.
      this.seek(0);
    }
    if (this.playing) return;
    this.playing = true;
    this.wallStart = nowMs();
    this.timeAtStart = this.position;
    if (!this.started) {
      this.started = true;
      this.setStatus({ state: 'running' });
    }
    this.scheduleTick(0);
  }

  pause(): void {
    if (this.playing) this.position = this.clockTime();
    this.playing = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Jump to `ms` (clamped to [0, duration]); the next frame emitted is the first at or after `ms`. */
  seek(ms: number): void {
    const target = Math.min(Math.max(Number.isFinite(ms) ? ms : 0, 0), this.duration);
    this.position = target;
    this.cursor = this.lowerBound(target);
    if (!Number.isNaN(this.lastTOut) && this.cursor < this.frameCount) {
      this.tOffset = this.lastTOut + this.nominalGapMs - this.rel[this.cursor];
    }
    if (this.playing) {
      this.wallStart = nowMs();
      this.timeAtStart = target;
      this.scheduleTick(0);
    }
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  setSpeed(x: number): void {
    const speed = Number.isFinite(x) && x > 0 ? x : 1;
    if (this.playing) {
      this.timeAtStart = this.clockTime();
      this.wallStart = nowMs();
    }
    this.speed = speed;
    if (this.playing) this.scheduleTick(0);
  }

  /**
   * Emit the next frame synchronously. Returns false when there is nothing to
   * emit (empty recording, or the end was reached and looping is off; playback
   * then pauses). With looping on, the end wraps to the first frame.
   */
  step(): boolean {
    if (this.frameCount === 0) return false;
    if (this.cursor >= this.frameCount) {
      if (!this.loop) {
        this.playing = false;
        return false;
      }
      this.wrap();
    }
    this.emitAt(this.cursor);
    return true;
  }

  // ---- internals -----------------------------------------------------------

  private wrap(): void {
    if (!Number.isNaN(this.lastTOut)) this.tOffset = this.lastTOut + this.nominalGapMs - this.rel[0];
    this.cursor = 0;
    this.position = 0;
    if (this.playing) {
      this.wallStart = nowMs();
      this.timeAtStart = 0;
    }
  }

  private emitAt(index: number): void {
    const src = this.recording.frames[index];
    const t = this.rel[index] + this.tOffset;
    const frame: PoseFrame = { ...src, t, now: nowMs(), src: RECORDING_SRC };
    this.lastTOut = t;
    this.lastEmitted = index;
    this.position = this.rel[index];
    this.cursor = index + 1;
    this.emitFrame(frame);
  }

  /** Playback position derived from the wall clock while playing. */
  private clockTime(): number {
    const t = this.timeAtStart + (nowMs() - this.wallStart) * this.speed;
    return Math.min(Math.max(t, 0), this.duration);
  }

  /** First index whose relative time is >= ms. */
  private lowerBound(ms: number): number {
    let lo = 0;
    let hi = this.rel.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rel[mid] < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private scheduleTick(delayMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, Math.max(0, delayMs));
  }

  private tick(): void {
    if (!this.playing) return;
    const target = this.timeAtStart + (nowMs() - this.wallStart) * this.speed;

    // Frames whose time has come.
    let due = 0;
    while (this.cursor + due < this.frameCount && this.rel[this.cursor + due] <= target) due++;

    if (due > MAX_FRAMES_PER_TICK) {
      // Fell behind (tab throttled, slow consumer): skip ahead to the last due frame.
      this.cursor += due - 1;
      due = 1;
    }
    for (let i = 0; i < due && this.playing; i++) this.emitAt(this.cursor);
    if (!this.playing) return;

    if (this.cursor >= this.frameCount) {
      // End reached: past the last frame's time (plus one nominal gap so the
      // last frame gets its full display time).
      const endTime = this.duration + this.nominalGapMs;
      if (target < endTime) {
        this.scheduleTick((endTime - target) / this.speed);
        return;
      }
      if (this.loop) {
        this.wrap();
        this.scheduleTick(0);
      } else {
        this.position = this.duration;
        this.playing = false;
        this.setStatus({ message: 'End of recording' });
      }
      return;
    }
    const wait = (this.rel[this.cursor] - target) / this.speed;
    this.scheduleTick(Math.min(Math.max(wait, 0), 50));
  }
}
