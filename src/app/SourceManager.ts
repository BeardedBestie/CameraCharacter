/**
 * Owns the active PoseSource (webcam, synthetic, recording, WebSocket): creation,
 * start/stop, camera selection, playback controls, and the webcam preview element.
 */
import { log } from '../core/log';
import type { MocapRecording, PoseFrame, TrackingSettings } from '../core/types';
import { listSyntheticPresets } from '../testing/syntheticHuman';
import { listCameras } from '../tracking/camera';
import { MediaPipeSource } from '../tracking/MediaPipeSource';
import type { PoseSource, SourceStatus } from '../tracking/PoseSource';
import { RecordingSource } from '../tracking/RecordingSource';
import { SyntheticSource } from '../tracking/SyntheticSource';
import { WebSocketSource } from '../tracking/WebSocketSource';
import type { PlaybackVM, SourceKind, SourceVM } from './actions';

export interface SourceManagerOptions {
  getTracking: () => TrackingSettings;
  onFrame: (frame: PoseFrame) => void;
  onStatus: (status: SourceStatus) => void;
  /** Called when the webcam preview element changes (null when the source has no video). */
  onVideo: (video: HTMLVideoElement | null) => void;
  onError: (message: string) => void;
}

export class SourceManager {
  kind: SourceKind = 'camera';
  source: PoseSource | null = null;
  cameras: MediaDeviceInfo[] = [];
  cameraId: string | null = null;
  preset = 'walk';
  wsUrl = 'ws://localhost:8765';
  recording: MocapRecording | null = null;
  recordingName: string | null = null;
  loop = true;
  speed = 1;
  autoplay = true;
  private unsubscribe: (() => void)[] = [];
  private generation = 0;
  private lastStatus: SourceStatus = { state: 'idle' };
  private mountedVideo: HTMLVideoElement | null = null;
  private lastLogged: { state: string; message: string | undefined } | null = null;

  constructor(private readonly opts: SourceManagerOptions) {}

  get status(): SourceStatus {
    return this.source?.status ?? this.lastStatus;
  }

  get presets(): string[] {
    return listSyntheticPresets();
  }

  get delegate(): 'GPU' | 'CPU' | null {
    return this.source instanceof MediaPipeSource ? this.source.delegate : null;
  }

  get mediaPipe(): MediaPipeSource | null {
    return this.source instanceof MediaPipeSource ? this.source : null;
  }

  get playback(): PlaybackVM | null {
    const s = this.source;
    if (s instanceof RecordingSource) {
      return { playing: s.isPlaying, timeMs: s.time, durationMs: s.duration, speed: s.playbackSpeed, loop: s.isLooping };
    }
    if (s instanceof SyntheticSource) {
      const frameMs = s.frameMs;
      return {
        playing: s.isPlaying,
        timeMs: (s.frameIndex % Math.max(1, s.framesPerLoop)) * frameMs,
        durationMs: s.framesPerLoop * frameMs,
        speed: 1,
        loop: s.isLooping,
      };
    }
    return null;
  }

  viewModel(): SourceVM {
    return {
      kind: this.kind,
      status: this.status,
      cameras: this.cameras.map((c) => ({ deviceId: c.deviceId, label: c.label })),
      cameraId: this.cameraId,
      presets: this.presets,
      preset: this.preset,
      wsUrl: this.wsUrl,
      recordingName: this.recordingName,
      playback: this.playback,
      delegate: this.delegate,
    };
  }

  async refreshCameras(): Promise<void> {
    try {
      this.cameras = await listCameras();
    } catch (err) {
      this.opts.onError(`Camera list unavailable: ${(err as Error).message ?? err}`);
    }
  }

  async setSource(kind: SourceKind): Promise<void> {
    this.kind = kind;
    await this.restart();
  }

  async selectCamera(deviceId: string): Promise<void> {
    this.cameraId = deviceId || null;
    if (this.kind === 'camera') await this.restart();
  }

  async setSyntheticPreset(name: string): Promise<void> {
    this.preset = name;
    if (this.kind === 'synthetic') await this.restart();
  }

  async setWebSocketUrl(url: string): Promise<void> {
    this.wsUrl = url;
    if (this.kind === 'websocket') await this.restart();
  }

  async loadRecording(recording: MocapRecording, name: string): Promise<void> {
    this.recording = recording;
    this.recordingName = name;
    this.kind = 'recording';
    await this.restart();
  }

  async applyTrackingSettings(settings: TrackingSettings): Promise<void> {
    const mp = this.mediaPipe;
    if (mp) {
      try {
        await mp.setSettings(settings);
      } catch (err) {
        this.opts.onError(`Tracking settings failed: ${(err as Error).message ?? err}`);
      }
    }
  }

  play(): void {
    const s = this.source;
    if (s instanceof RecordingSource || s instanceof SyntheticSource) s.play();
  }

  pause(): void {
    const s = this.source;
    if (s instanceof RecordingSource || s instanceof SyntheticSource) s.pause();
  }

  togglePlay(): void {
    const s = this.source;
    if (s instanceof RecordingSource || s instanceof SyntheticSource) {
      if (s.isPlaying) s.pause();
      else s.play();
    }
  }

  seek(ms: number): void {
    const s = this.source;
    if (s instanceof RecordingSource) s.seek(ms);
  }

  setSpeed(x: number): void {
    this.speed = x;
    const s = this.source;
    if (s instanceof RecordingSource) s.setSpeed(x);
  }

  setLoop(v: boolean): void {
    this.loop = v;
    const s = this.source;
    if (s instanceof RecordingSource || s instanceof SyntheticSource) s.setLoop(v);
  }

  stop(): void {
    this.generation++;
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    if (this.source) {
      try {
        this.source.stop();
      } catch (err) {
        log.warn('source stop failed', err);
      }
      this.lastStatus = { state: 'stopped' };
    }
    this.source = null;
    this.mountedVideo = null;
    this.opts.onVideo(null);
  }

  /** Mounts the webcam element as soon as the source has one (before the model loads), unmounts when it is gone. */
  private syncVideo(source: PoseSource): void {
    const video = source instanceof MediaPipeSource ? source.video : null;
    if (video === this.mountedVideo) return;
    this.mountedVideo = video;
    this.opts.onVideo(video);
  }

  /** One console line per status transition (state or message change); fps-only updates stay quiet. */
  private logStatus(s: SourceStatus): void {
    if (this.lastLogged && this.lastLogged.state === s.state && this.lastLogged.message === s.message) return;
    this.lastLogged = { state: s.state, message: s.message };
    const line = `source ${this.kind}: ${s.state}${s.message ? ` · ${s.message}` : ''}`;
    if (s.state === 'error') log.warn(line);
    else log.info(line);
  }

  private async restart(): Promise<void> {
    this.stop();
    const gen = ++this.generation;
    let source: PoseSource;
    try {
      source = this.create();
    } catch (err) {
      this.opts.onError((err as Error).message ?? String(err));
      return;
    }
    log.info(`source ${this.kind}: starting${this.kind === 'camera' ? ` (camera ${this.cameraId ?? 'default'})` : ''}`);
    this.source = source;
    this.unsubscribe.push(source.onFrame((f) => this.opts.onFrame(f)));
    this.unsubscribe.push(
      source.onStatus((s) => {
        this.lastStatus = s;
        this.logStatus(s);
        this.syncVideo(source);
        this.opts.onStatus(s);
      }),
    );
    try {
      await source.start();
    } catch (err) {
      if (gen !== this.generation) return;
      this.syncVideo(source);
      this.opts.onError(`Source failed to start: ${(err as Error).message ?? err}`);
      return;
    }
    if (gen !== this.generation) return;
    this.syncVideo(source);
    if (source instanceof MediaPipeSource && !this.cameras.length) void this.refreshCameras();
    if (source instanceof RecordingSource || source instanceof SyntheticSource) {
      source.setLoop(this.loop);
      if (source instanceof RecordingSource) source.setSpeed(this.speed);
      if (this.autoplay) source.play();
    }
    this.opts.onStatus(source.status);
  }

  private create(): PoseSource {
    switch (this.kind) {
      case 'camera':
        return new MediaPipeSource({ deviceId: this.cameraId ?? undefined, settings: this.opts.getTracking() });
      case 'synthetic':
        return new SyntheticSource({ preset: this.preset, fps: 30, loop: this.loop });
      case 'recording':
        if (!this.recording) throw new Error('No take loaded. Drop a .mocap.json file first.');
        return RecordingSource.fromRecording(this.recording);
      case 'websocket':
        return new WebSocketSource(this.wsUrl);
    }
  }
}
