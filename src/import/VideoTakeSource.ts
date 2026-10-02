/**
 * PoseSource that plays an extracted take in lock-step with its source video
 * (docs/DESIGN.md §17.3). The <video> element is the clock: every animation
 * frame the take frame matching `video.currentTime` is emitted (once), so the
 * character, the picture-in-picture and the landmark overlay always show the
 * same instant, scrubbing included. Play/pause/seek/loop/speed act on the
 * video element. Browser only; the frame lookup lives in TakeCursor (pure).
 */
import type { MocapRecording, PoseFrame } from '../core/types';
import { BaseSource } from '../tracking/PoseSource';
import { TakeCursor } from './TakeCursor';

export class VideoTakeSource extends BaseSource {
  readonly kind = 'recording' as const;
  readonly recording: MocapRecording;
  readonly video: HTMLVideoElement;
  private readonly cursor: TakeCursor;
  /** Media time (ms) of the first take frame. */
  private readonly baseMs: number;
  private rafHandle: number | null = null;
  private running = false;
  private readonly onEnded = (): void => {
    if (!this.video.loop) this.setStatus({ message: 'End of clip' });
  };

  constructor(recording: MocapRecording, video: HTMLVideoElement) {
    super();
    this.recording = recording;
    this.video = video;
    this.cursor = new TakeCursor(recording.frames);
    this.baseMs = recording.frames.length > 0 ? recording.frames[0].t : 0;
  }

  get frameCount(): number {
    return this.cursor.count;
  }

  /** Take duration in ms (last frame relative to the first). */
  get duration(): number {
    return this.cursor.duration;
  }

  /** Playback position within the take (ms). */
  get time(): number {
    return Math.max(0, this.video.currentTime * 1000 - this.baseMs);
  }

  get isPlaying(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  get isLooping(): boolean {
    return this.video.loop;
  }

  get playbackSpeed(): number {
    return this.video.playbackRate;
  }

  get frameIndex(): number {
    return this.cursor.lastEmitted;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cursor.reset();
    this.video.addEventListener('ended', this.onEnded);
    this.setStatus({ state: 'running', message: `${this.frameCount} frames, ${(this.duration / 1000).toFixed(1)} s` });
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    this.video.removeEventListener('ended', this.onEnded);
    try {
      this.video.pause();
    } catch {
      // ignore
    }
    this.setStatus({ state: 'stopped' });
  }

  play(): void {
    if (this.video.ended || this.time >= this.duration) this.seek(0);
    void this.video.play().catch((err: unknown) => {
      this.setStatus({ message: `Playback blocked: ${err instanceof Error ? err.message : String(err)}` });
    });
  }

  pause(): void {
    this.video.pause();
  }

  /** Jump to `ms` within the take; the matching frame is emitted on the next animation frame. */
  seek(ms: number): void {
    const target = Math.min(Math.max(Number.isFinite(ms) ? ms : 0, 0), this.duration);
    this.video.currentTime = (target + this.baseMs) / 1000;
    this.cursor.invalidate();
  }

  setLoop(loop: boolean): void {
    this.video.loop = loop;
  }

  setSpeed(x: number): void {
    this.video.playbackRate = Number.isFinite(x) && x > 0 ? x : 1;
  }

  /** Re-emit the frame at the current video time (after the pipeline was reset). */
  refresh(): void {
    this.cursor.invalidate();
    this.poll();
  }

  /** Emit the frame for the current video time now (tests, scrubbing without a running loop). */
  poll(now: number = performance.now()): PoseFrame | null {
    const frame = this.cursor.frameFor(this.time, now);
    if (frame) this.emitFrame(frame, now);
    return frame;
  }

  private schedule(): void {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame((now) => {
      this.rafHandle = null;
      if (!this.running) return;
      if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA) this.poll(now);
      this.schedule();
    });
  }
}
