/**
 * PoseSource that generates PoseFrames from the parametric synthetic human
 * (src/testing/syntheticHuman.ts) in real time: webcam-free demos, end-to-end
 * tests and deterministic unit tests via `step()`.
 *
 * Pacing: setTimeout with drift correction against performance.now(); frame k
 * carries `t = k · 1000 / fps` (elapsed media time in ms, monotonic across
 * loops and pauses) and `now = performance.now()` at emission. Pure: no DOM.
 */
import type { PoseFrame } from '../core/types';
import {
  DEFAULT_HUMAN,
  SYNTHETIC_PRESETS,
  computeLandmarkPositions,
  toPoseFrame,
  type HumanDimensions,
  type SyntheticPreset,
} from '../testing/syntheticHuman';
import { BaseSource } from './PoseSource';

export const SYNTHETIC_SRC = 'synthetic';
/** Frames caught up in one tick before skipping ahead (drift correction). */
const MAX_FRAMES_PER_TICK = 3;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface SyntheticSourceOptions {
  /** Preset name from `SYNTHETIC_PRESETS`. */
  preset: string;
  /** Frames per second (default 30). */
  fps?: number;
  /** Wrap around at the preset's duration (default true); otherwise pause at the end. */
  loop?: boolean;
  /** Capture size reported in the frames (default 1280×720). */
  size?: [number, number];
  dims?: HumanDimensions;
}

export class SyntheticSource extends BaseSource {
  readonly kind = 'synthetic' as const;

  readonly preset: SyntheticPreset;
  /** Generated frames per second. */
  readonly frameRate: number;
  private readonly size: [number, number];
  private readonly dims: HumanDimensions;
  private loop: boolean;

  /** Index of the next frame to emit. */
  private cursor = 0;
  private lastEmitted = -1;
  private playing = false;
  private started = false;
  private wallStart = 0;
  private cursorAtStart = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SyntheticSourceOptions) {
    super();
    const preset = SYNTHETIC_PRESETS[options.preset];
    if (!preset) throw new Error(`Unknown synthetic preset "${options.preset}"`);
    this.preset = preset;
    this.frameRate = Number.isFinite(options.fps) && (options.fps as number) > 0 ? (options.fps as number) : 30;
    this.loop = options.loop ?? true;
    this.size = options.size ? [options.size[0], options.size[1]] : [1280, 720];
    this.dims = options.dims ?? DEFAULT_HUMAN;
  }

  // ---- state -------------------------------------------------------------

  get frameMs(): number {
    return 1000 / this.frameRate;
  }

  /** Frames per loop of the preset. */
  get framesPerLoop(): number {
    return Math.max(1, Math.round(this.preset.durationSec * this.frameRate));
  }

  /** Index of the most recently emitted frame, -1 when none. */
  get frameIndex(): number {
    return this.lastEmitted;
  }

  get nextFrameIndex(): number {
    return this.cursor;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isLooping(): boolean {
    return this.loop;
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  // ---- PoseSource ----------------------------------------------------------

  async start(): Promise<void> {
    this.started = true;
    this.setStatus({ state: 'running', message: `Synthetic ${this.preset.name} at ${this.frameRate} fps` });
    this.play();
  }

  stop(): void {
    this.pause();
    this.started = false;
    this.setStatus({ state: 'stopped' });
  }

  // ---- controls ------------------------------------------------------------

  play(): void {
    if (this.playing) return;
    if (!this.loop && this.cursor >= this.framesPerLoop) this.cursor = 0;
    this.playing = true;
    this.wallStart = nowMs();
    this.cursorAtStart = this.cursor;
    if (!this.started) {
      this.started = true;
      this.setStatus({ state: 'running', message: `Synthetic ${this.preset.name} at ${this.frameRate} fps` });
    }
    this.scheduleTick(0);
  }

  pause(): void {
    this.playing = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Emit the next frame synchronously (no timers). Returns false when looping
   * is off and the preset's end was reached; playback then pauses.
   */
  step(): boolean {
    if (!this.loop && this.cursor >= this.framesPerLoop) {
      this.playing = false;
      return false;
    }
    this.emitAt(this.cursor);
    return true;
  }

  /** Pure frame generation for index `k` (used by step() and the timer loop). */
  frameAt(k: number): PoseFrame {
    const presetT = ((k % this.framesPerLoop) + this.framesPerLoop) % this.framesPerLoop / this.frameRate;
    const pose = this.preset.poseAt(presetT);
    const cam = this.preset.cameraAt ? this.preset.cameraAt(presetT) : this.preset.camera;
    const points = computeLandmarkPositions(pose, this.dims);
    const frame = toPoseFrame(points, cam, k * this.frameMs, {
      size: this.size,
      src: SYNTHETIC_SRC,
      visibilityOverride: pose.visibilityOverride,
    });
    return frame;
  }

  // ---- internals -----------------------------------------------------------

  private emitAt(k: number): void {
    const frame = this.frameAt(k);
    const wall = nowMs();
    frame.now = wall;
    this.lastEmitted = k;
    this.cursor = k + 1;
    this.emitFrame(frame, wall);
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
    const elapsed = nowMs() - this.wallStart;
    // Frames whose scheduled time (relative to the play start) has come.
    const dueUntil = this.cursorAtStart + Math.floor(elapsed / this.frameMs);
    let due = dueUntil - this.cursor + 1;
    if (due > MAX_FRAMES_PER_TICK) {
      // Fell behind (tab throttled): skip ahead rather than bursting frames.
      this.cursor = dueUntil - MAX_FRAMES_PER_TICK + 1;
      due = MAX_FRAMES_PER_TICK;
    }
    for (let i = 0; i < due && this.playing; i++) {
      if (!this.loop && this.cursor >= this.framesPerLoop) {
        this.playing = false;
        this.setStatus({ message: 'End of preset' });
        return;
      }
      this.emitAt(this.cursor);
    }
    if (!this.playing) return;
    const nextAt = (this.cursor - this.cursorAtStart) * this.frameMs;
    this.scheduleTick(nextAt - (nowMs() - this.wallStart));
  }
}
