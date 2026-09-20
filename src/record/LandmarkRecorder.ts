/**
 * LandmarkRecorder: records the raw PoseFrame v2 stream into a
 * `.mocap.json` recording (docs/DESIGN.md §9, §10).
 *
 * Frames are stored exactly as received: un-mirrored and unfiltered. Mirror
 * and smoothing are replay-time steps (RecordingSource + PoseFilter). Pure:
 * no DOM, no three.js.
 */
import type { MocapMeta, MocapRecording, PoseFrame } from '../core/types';

export class LandmarkRecorder {
  private frames: PoseFrame[] = [];
  private meta: MocapMeta | null = null;
  private recording = false;

  /**
   * Starts a new take. `t0` is `performance.now()` at start and is shared with
   * the clip and video recorders so the three can be aligned afterwards.
   * Any previous, un-stopped take is discarded.
   */
  start(meta: Partial<MocapMeta>, t0: number): void {
    const now = new Date();
    const filled: MocapMeta = {
      createdAt: meta.createdAt ?? now.toISOString(),
      source: meta.source ?? '',
      size: meta.size ? [meta.size[0], meta.size[1]] : [0, 0],
      mirror: meta.mirror ?? false,
      t0: meta.t0 ?? { wallclock: now.toISOString(), performanceNow: t0 },
    };
    if (meta.fovDeg !== undefined) filled.fovDeg = meta.fovDeg;
    if (meta.camera) filled.camera = { ...meta.camera };
    if (meta.tracker) filled.tracker = { ...meta.tracker };
    if (meta.smoothing) filled.smoothing = { ...meta.smoothing };
    if (meta.calibration !== undefined) filled.calibration = meta.calibration;
    if (meta.referenceModel !== undefined) filled.referenceModel = meta.referenceModel;
    if (meta.notes !== undefined) filled.notes = meta.notes;
    this.meta = filled;
    this.frames = [];
    this.recording = true;
  }

  /** Appends a raw frame. Ignored when not recording. The frame object is kept by reference. */
  push(frame: PoseFrame): void {
    if (!this.recording) return;
    this.frames.push(frame);
  }

  /**
   * Stops and returns the recording. Source and size that were not given to
   * `start` are taken from the first frame.
   */
  stop(): MocapRecording {
    if (!this.meta) throw new Error('LandmarkRecorder.stop: start() was not called');
    this.recording = false;
    const meta = this.meta;
    const first = this.frames[0];
    if (first) {
      if (!meta.source) meta.source = first.src;
      if (meta.size[0] === 0 && meta.size[1] === 0) meta.size = [first.size[0], first.size[1]];
    }
    const rec: MocapRecording = { format: 'cameracharacter-mocap', version: 2, meta, frames: this.frames };
    this.meta = null;
    this.frames = [];
    return rec;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Media-time span of the frames recorded so far (last.t − first.t), in ms. */
  get durationMs(): number {
    const n = this.frames.length;
    if (n < 2) return 0;
    return this.frames[n - 1].t - this.frames[0].t;
  }

  get isRecording(): boolean {
    return this.recording;
  }
}

const ROUND = 1e5;

/** Rounds a number to 5 decimals; non-finite values become null (JSON has no NaN). */
function roundNumber(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * ROUND) / ROUND;
}

/** Compact JSON with every number rounded to 5 decimals. */
export function serializeRecording(rec: MocapRecording): string {
  return JSON.stringify(rec, (_key, value: unknown) => (typeof value === 'number' ? roundNumber(value) : value));
}
