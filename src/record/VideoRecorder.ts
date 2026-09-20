/**
 * VideoRecorder: records the viewport (plus an optional webcam
 * picture-in-picture and microphone) with MediaRecorder (docs/DESIGN.md §9).
 * Browser only. Every rendered frame is composited into a fixed, even-sized
 * offscreen canvas whose captureStream is what gets encoded, so the encoder
 * never sees a resize. WebM output gets its EBML Duration patched on stop.
 */
import { patchWebmDuration } from './webmDuration';

export interface PipRect {
  /** Fractions of the output size. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VideoRecorderOptions {
  /** The WebGL canvas to record. */
  source: HTMLCanvasElement;
  /** Output size; defaults to the source size rounded down to even (1920×1080 when the source has no size). */
  width?: number;
  height?: number;
  /** Capture rate hint for captureStream (default 30). */
  fps?: number;
  /** Optional webcam picture-in-picture. `mirror` flips it horizontally like the preview. */
  pip?: { video: HTMLVideoElement; mirror: boolean; rect: PipRect } | null;
  /** Merge a microphone track (getUserMedia audio). Default false. */
  audio?: boolean;
  /** Encoder bitrate hint (default 8 Mbit/s). */
  videoBitsPerSecond?: number;
  /** Receives human-readable warnings (hidden tab, microphone denied, patch failure). */
  onWarning?: (message: string) => void;
}

/** Probe order from docs/DESIGN.md §9; the container decides the file extension. */
export const CODEC_PROBE_ORDER: readonly string[] = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export type VideoExtension = 'mp4' | 'webm';

export function extensionForMimeType(mimeType: string): VideoExtension {
  return /mp4/i.test(mimeType) ? 'mp4' : 'webm';
}

/** First supported MIME type of the probe order, or null when MediaRecorder is unavailable. */
export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of CODEC_PROBE_ORDER) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

/** Rounds a size down to even numbers (encoders reject odd dimensions). */
export function evenSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(2, Math.floor(width / 2) * 2);
  const h = Math.max(2, Math.floor(height / 2) * 2);
  return { width: w, height: h };
}

const HIDDEN_WARNING = 'Recording stalls while the tab is hidden: keep this tab visible until you stop recording.';

export class VideoRecorder {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly opts: VideoRecorderOptions;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private canvasStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private mimeType = '';
  private t0 = 0;
  private stopPromise: Promise<{ blob: Blob; extension: VideoExtension; durationMs: number }> | null = null;
  private readonly onVisibility = () => {
    if (typeof document !== 'undefined' && document.hidden && this.recorder) this.warn(HIDDEN_WARNING);
  };

  constructor(opts: VideoRecorderOptions) {
    this.opts = opts;
    const srcW = opts.width ?? opts.source.width;
    const srcH = opts.height ?? opts.source.height;
    const size = srcW > 0 && srcH > 0 ? evenSize(srcW, srcH) : { width: 1920, height: 1080 };
    this.width = size.width;
    this.height = size.height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('VideoRecorder: 2D canvas context unavailable');
    this.ctx = ctx;
  }

  get isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  /** Starts encoding. Returns `performance.now()` at start (shared with the other recorders) and the MIME type in use. */
  async start(): Promise<{ t0: number; mimeType: string }> {
    if (this.recorder) throw new Error('VideoRecorder: already recording');
    if (typeof MediaRecorder === 'undefined') throw new Error('VideoRecorder: MediaRecorder is not supported in this browser');
    const fps = this.opts.fps ?? 30;
    this.drawFrame();
    this.canvasStream = this.canvas.captureStream(fps);
    const tracks: MediaStreamTrack[] = [...this.canvasStream.getVideoTracks()];
    if (this.opts.audio) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        tracks.push(...this.micStream.getAudioTracks());
      } catch (err) {
        this.micStream = null;
        this.warn(`Microphone unavailable, recording without audio (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    const stream = new MediaStream(tracks);
    const mimeType = pickMimeType();
    const init: MediaRecorderOptions = { videoBitsPerSecond: this.opts.videoBitsPerSecond ?? 8_000_000 };
    if (mimeType) init.mimeType = mimeType;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, init);
    } catch (err) {
      this.releaseStreams();
      throw new Error(`VideoRecorder: MediaRecorder could not be created (${err instanceof Error ? err.message : String(err)})`);
    }
    this.mimeType = recorder.mimeType || mimeType || 'video/webm';
    this.chunks = [];
    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.recorder = recorder;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      if (document.hidden) this.warn(HIDDEN_WARNING);
    }
    recorder.start(1000);
    this.t0 = performance.now();
    return { t0: this.t0, mimeType: this.mimeType };
  }

  /**
   * Composites the source canvas and the PiP into the captured canvas. Call
   * once per rendered frame, right after `renderer.render()` in the same task
   * (WebGL canvases are read back synchronously; no preserveDrawingBuffer).
   */
  drawFrame(): void {
    const ctx = this.ctx;
    const { width: W, height: H } = this;
    const src = this.opts.source;
    if (src.width > 0 && src.height > 0) ctx.drawImage(src, 0, 0, W, H);
    else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    }
    const pip = this.opts.pip;
    if (!pip) return;
    const video = pip.video;
    if (video.readyState < 2 || video.videoWidth === 0) return;
    const x = pip.rect.x * W;
    const y = pip.rect.y * H;
    const w = pip.rect.w * W;
    const h = pip.rect.h * H;
    if (!(w > 0 && h > 0)) return;
    ctx.save();
    if (pip.mirror) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, w, h);
    } else {
      ctx.drawImage(video, x, y, w, h);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }

  /** Stops encoding and resolves with the file. WebM files get their Duration patched. */
  stop(): Promise<{ blob: Blob; extension: VideoExtension; durationMs: number }> {
    if (this.stopPromise) return this.stopPromise;
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error('VideoRecorder: not recording'));
    const mimeType = this.mimeType;
    const extension = extensionForMimeType(mimeType);
    this.stopPromise = new Promise<{ blob: Blob; extension: VideoExtension; durationMs: number }>((resolve, reject) => {
      const finish = async () => {
        const durationMs = performance.now() - this.t0;
        let blob = new Blob(this.chunks, { type: mimeType });
        if (extension === 'webm') {
          try {
            const patched = patchWebmDuration(await blob.arrayBuffer(), durationMs);
            blob = new Blob([patched], { type: mimeType });
          } catch (err) {
            this.warn(`Could not patch the WebM duration (${err instanceof Error ? err.message : String(err)}); the file may not seek.`);
          }
        }
        resolve({ blob, extension, durationMs });
      };
      recorder.onstop = () => {
        this.cleanup();
        finish().catch(reject);
      };
      recorder.onerror = (ev: Event) => {
        this.cleanup();
        const detail = (ev as { error?: unknown }).error;
        reject(detail instanceof Error ? detail : new Error('VideoRecorder: MediaRecorder error'));
      };
      if (recorder.state === 'inactive') {
        this.cleanup();
        finish().catch(reject);
      } else {
        recorder.stop();
      }
    });
    return this.stopPromise;
  }

  private cleanup(): void {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.releaseStreams();
    this.recorder = null;
  }

  private releaseStreams(): void {
    for (const s of [this.canvasStream, this.micStream]) {
      if (!s) continue;
      for (const t of s.getTracks()) t.stop();
    }
    this.canvasStream = null;
    this.micStream = null;
  }

  private warn(message: string): void {
    if (this.opts.onWarning) this.opts.onWarning(message);
    else console.warn(`VideoRecorder: ${message}`);
  }
}
