/**
 * Playback transport shared by the import page's UI, keyboard shortcuts and
 * render job: one interface over the video-slaved source (clip with video)
 * and the plain RecordingSource (take without video).
 */
import { RecordingSource } from '../tracking/RecordingSource';
import type { VideoTakeSource } from './VideoTakeSource';

export interface Transport {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(ms: number): void;
  setLoop(v: boolean): void;
  setSpeed(x: number): void;
  readonly playing: boolean;
  readonly timeMs: number;
  readonly durationMs: number;
  readonly loop: boolean;
  readonly speed: number;
  /** Typical gap between take frames (ms) for frame stepping. */
  readonly frameMs: number;
  /** Emit the frame at the playhead again (after the pipeline was reset, or when paused). */
  emitCurrent(): void;
}

export function transportFor(source: VideoTakeSource | RecordingSource): Transport {
  const frameMs = source instanceof RecordingSource ? source.nominalGapMs : Math.max(1, source.duration / Math.max(1, source.frameCount - 1));
  const emitCurrent = (): void => {
    if (source instanceof RecordingSource) {
      // RecordingSource only emits on its timer: re-seek to the playhead and step one frame.
      source.seek(source.time);
      source.step();
    } else {
      source.refresh();
    }
  };
  return {
    play: () => source.play(),
    pause: () => source.pause(),
    toggle: () => (source.isPlaying ? source.pause() : source.play()),
    seek: (ms) => {
      source.seek(ms);
      // A paused RecordingSource would otherwise show nothing until play.
      if (source instanceof RecordingSource && !source.isPlaying) source.step();
    },
    emitCurrent,
    setLoop: (v) => source.setLoop(v),
    setSpeed: (x) => source.setSpeed(x),
    get playing() {
      return source.isPlaying;
    },
    get timeMs() {
      return source.time;
    },
    get durationMs() {
      return source.duration;
    },
    get loop() {
      return source.isLooping;
    },
    get speed() {
      return source.playbackSpeed;
    },
    frameMs,
  };
}
