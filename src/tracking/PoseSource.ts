/**
 * PoseSource contract shared by every tracking provider (MediaPipe in the
 * browser, a WebSocket provider, recorded takes, the synthetic human) plus a
 * small base class that handles listener bookkeeping, status and fps
 * measurement. Pure: no DOM.
 */
import type { PoseFrame } from '../core/types';

export type SourceKind = 'mediapipe' | 'websocket' | 'recording' | 'synthetic';

export type SourceState = 'idle' | 'starting' | 'running' | 'error' | 'stopped';

export interface SourceStatus {
  state: SourceState;
  /** Human readable detail (error text, loading step, reconnect countdown…). */
  message?: string;
  /** Measured frames per second delivered to listeners. */
  fps?: number;
  /** Smoothed inference time in ms (MediaPipe only), published at the same cadence as fps. */
  inferenceMs?: number;
}

export interface PoseSource {
  readonly kind: SourceKind;
  start(): Promise<void>;
  stop(): void;
  /** Subscribe to frames; returns an unsubscribe function. */
  onFrame(cb: (frame: PoseFrame) => void): () => void;
  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatus(cb: (s: SourceStatus) => void): () => void;
  readonly status: SourceStatus;
}

export type FrameListener = (frame: PoseFrame) => void;
export type StatusListener = (s: SourceStatus) => void;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Exponentially weighted frames-per-second estimator. Feed it the wall time of
 * every emitted frame; `value` is 0 until two frames have been seen.
 */
export class FpsMeter {
  private last = NaN;
  private interval = NaN;
  constructor(private readonly smoothing = 0.1) {}

  tick(tMs: number = nowMs()): number {
    if (!Number.isNaN(this.last)) {
      const dt = Math.max(tMs - this.last, 1e-3);
      this.interval = Number.isNaN(this.interval) ? dt : this.interval + (dt - this.interval) * this.smoothing;
    }
    this.last = tMs;
    return this.value;
  }

  get value(): number {
    return Number.isNaN(this.interval) ? 0 : 1000 / this.interval;
  }

  reset(): void {
    this.last = NaN;
    this.interval = NaN;
  }
}

/**
 * Listener bookkeeping, status broadcasting and fps measurement shared by the
 * concrete sources. Subclasses call `emitFrame` and `setStatus`.
 */
export abstract class BaseSource implements PoseSource {
  abstract readonly kind: SourceKind;

  private frameListeners = new Set<FrameListener>();
  private statusListeners = new Set<StatusListener>();
  private _status: SourceStatus = { state: 'idle' };
  private readonly fpsMeter = new FpsMeter();
  private lastFpsPublish = -Infinity;
  /** Smoothed inference time, merged into the throttled fps publish when set. */
  private inferenceMsSmoothed = NaN;

  /** How often (ms) the fps figure is pushed into the status while running. */
  protected fpsPublishIntervalMs = 500;

  abstract start(): Promise<void>;
  abstract stop(): void;

  get status(): SourceStatus {
    return this._status;
  }

  onFrame(cb: FrameListener): () => void {
    this.frameListeners.add(cb);
    return () => {
      this.frameListeners.delete(cb);
    };
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /** Number of frame listeners (useful for skipping work when nobody listens). */
  protected get frameListenerCount(): number {
    return this.frameListeners.size;
  }

  /** Current fps estimate. */
  get fps(): number {
    return this.fpsMeter.value;
  }

  /** Deliver a frame to listeners and update the fps estimate. */
  protected emitFrame(frame: PoseFrame, wallMs: number = nowMs()): void {
    const fps = this.fpsMeter.tick(wallMs);
    for (const cb of this.frameListeners) {
      try {
        cb(frame);
      } catch (err) {
        // A misbehaving listener must not break the capture loop.
        console.error('PoseSource frame listener threw', err);
      }
    }
    if (this._status.state === 'running' && wallMs - this.lastFpsPublish >= this.fpsPublishIntervalMs) {
      this.lastFpsPublish = wallMs;
      const patch: Partial<SourceStatus> = { fps: Math.round(fps * 10) / 10 };
      if (!Number.isNaN(this.inferenceMsSmoothed)) patch.inferenceMs = Math.round(this.inferenceMsSmoothed * 10) / 10;
      this.setStatus(patch);
    }
  }

  /**
   * Record one inference duration (ms). The value is low-passed and published
   * together with the fps figure at the throttled cadence, never per frame.
   */
  protected reportInferenceMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.inferenceMsSmoothed = Number.isNaN(this.inferenceMsSmoothed) ? ms : this.inferenceMsSmoothed + (ms - this.inferenceMsSmoothed) * 0.2;
  }

  /**
   * Merge `patch` into the status and notify listeners. Changing the state
   * clears fps/inferenceMs unless the patch provides them.
   */
  protected setStatus(patch: Partial<SourceStatus>): void {
    const prev = this._status;
    const next: SourceStatus = { ...prev, ...patch };
    if (patch.state !== undefined && patch.state !== prev.state) {
      if (patch.fps === undefined) delete next.fps;
      if (patch.inferenceMs === undefined) delete next.inferenceMs;
      if (patch.message === undefined) delete next.message;
      if (patch.state !== 'running') {
        this.fpsMeter.reset();
        this.inferenceMsSmoothed = NaN;
      }
      this.lastFpsPublish = -Infinity;
    }
    this._status = next;
    for (const cb of this.statusListeners) {
      try {
        cb(next);
      } catch (err) {
        console.error('PoseSource status listener threw', err);
      }
    }
  }

  /** Drop all listeners (call from stop() when the source is disposed for good). */
  protected clearListeners(): void {
    this.frameListeners.clear();
    this.statusListeners.clear();
  }
}
