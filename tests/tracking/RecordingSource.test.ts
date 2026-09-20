import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoseFrame } from '../../src/core/types';
import { RecordingSource } from '../../src/tracking/RecordingSource';
import { makeRecording } from './fixtures';

function collect(src: RecordingSource): PoseFrame[] {
  const out: PoseFrame[] = [];
  src.onFrame((f) => out.push(f));
  return out;
}

describe('RecordingSource.step', () => {
  it('emits frames deterministically in order with monotonic rewritten timestamps and src "recording"', () => {
    const src = RecordingSource.fromRecording(makeRecording(4, 40));
    const frames = collect(src);
    src.setLoop(false);
    expect(src.frameCount).toBe(4);
    expect(src.duration).toBe(120);
    expect(src.nominalGapMs).toBe(40);
    expect(src.frameIndex).toBe(-1);
    expect(src.step()).toBe(true);
    expect(src.step()).toBe(true);
    expect(src.step()).toBe(true);
    expect(src.step()).toBe(true);
    expect(src.step()).toBe(false);
    expect(frames).toHaveLength(4);
    expect(frames.map((f) => f.t)).toEqual([0, 40, 80, 120]);
    expect(frames.every((f) => f.src === 'recording')).toBe(true);
    expect(frames.every((f) => typeof f.now === 'number' && Number.isFinite(f.now))).toBe(true);
    expect(frames[2].pose!.world[5]).toEqual(src.recording.frames[2].pose!.world[5]);
    expect(src.frameIndex).toBe(3);
    expect(src.time).toBe(120);
    expect(src.isPlaying).toBe(false);
  });

  it('two sources with the same recording produce identical streams (apart from the wall clock)', () => {
    const a = RecordingSource.fromRecording(makeRecording(6));
    const b = RecordingSource.fromRecording(makeRecording(6));
    const fa = collect(a);
    const fb = collect(b);
    for (let i = 0; i < 6; i++) {
      a.step();
      b.step();
    }
    const strip = (fs: PoseFrame[]) => JSON.stringify(fs.map(({ now: _now, ...rest }) => rest));
    expect(strip(fa)).toBe(strip(fb));
  });

  it('loops back to the first frame with timestamps continuing forward', () => {
    const src = RecordingSource.fromRecording(makeRecording(3, 10));
    const frames = collect(src);
    src.setLoop(true);
    for (let i = 0; i < 7; i++) expect(src.step()).toBe(true);
    expect(frames).toHaveLength(7);
    const ts = frames.map((f) => f.t);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    expect(ts).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(src.frameIndex).toBe(0);
    expect(frames[3].pose!.image[0]).toEqual(src.recording.frames[0].pose!.image[0]);
  });

  it('seek positions the cursor at the first frame at or after the time and keeps timestamps monotonic', () => {
    const src = RecordingSource.fromRecording(makeRecording(10, 100));
    const frames = collect(src);
    src.setLoop(false);
    src.step();
    src.step();
    src.step();
    src.seek(450);
    expect(src.time).toBe(450);
    expect(src.nextFrameIndex).toBe(5);
    expect(src.step()).toBe(true);
    expect(src.frameIndex).toBe(5);
    expect(frames[3].t).toBe(300);
    src.seek(0);
    expect(src.step()).toBe(true);
    expect(src.frameIndex).toBe(0);
    expect(frames[4].t).toBeGreaterThan(frames[3].t);
    src.seek(99999);
    expect(src.time).toBe(900);
    expect(src.nextFrameIndex).toBe(9);
    expect(src.step()).toBe(true);
    expect(src.step()).toBe(false);
  });

  it('handles empty recordings and out-of-order timestamps', () => {
    const empty = RecordingSource.fromRecording(makeRecording(0));
    expect(empty.duration).toBe(0);
    expect(empty.step()).toBe(false);

    const rec = makeRecording(3, 10);
    rec.frames[1].t = rec.frames[0].t - 50;
    const src = RecordingSource.fromRecording(rec);
    const frames = collect(src);
    src.step();
    src.step();
    src.step();
    expect(frames.map((f) => f.t)).toEqual([0, 0, 20]);
  });

  it('start() sets running status and stop() stops playback', async () => {
    const src = RecordingSource.fromRecording(makeRecording(3));
    const states: string[] = [];
    src.onStatus((s) => states.push(s.state));
    await src.start();
    expect(src.isPlaying).toBe(true);
    expect(src.status.state).toBe('running');
    src.stop();
    expect(src.isPlaying).toBe(false);
    expect(src.status.state).toBe('stopped');
    expect(states).toEqual(['running', 'stopped']);
  });

  it('setSpeed accepts positive numbers only', () => {
    const src = RecordingSource.fromRecording(makeRecording(3));
    src.setSpeed(2);
    expect(src.playbackSpeed).toBe(2);
    src.setSpeed(-1);
    expect(src.playbackSpeed).toBe(1);
  });

  it('fromText parses JSON and rejects invalid text', () => {
    const src = RecordingSource.fromText(JSON.stringify(makeRecording(2)));
    expect(src.frameCount).toBe(2);
    expect(() => RecordingSource.fromText('{')).toThrow(/JSON/);
  });
});

describe('RecordingSource timer playback', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('play() emits frames at the recorded times and honors the recorded spacing', () => {
    const src = RecordingSource.fromRecording(makeRecording(5, 100));
    const frames = collect(src);
    src.setLoop(false);
    src.play();
    expect(src.isPlaying).toBe(true);
    vi.advanceTimersByTime(0);
    expect(frames.map((f) => f.t)).toEqual([0]);
    vi.advanceTimersByTime(99);
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(frames.map((f) => f.t)).toEqual([0, 100]);
    vi.advanceTimersByTime(300);
    expect(frames.map((f) => f.t)).toEqual([0, 100, 200, 300, 400]);
    expect(src.time).toBeCloseTo(400, 6);
    // The last frame keeps one nominal gap, then playback stops without looping.
    expect(src.isPlaying).toBe(true);
    vi.advanceTimersByTime(100);
    expect(src.isPlaying).toBe(false);
    expect(src.status.message).toBe('End of recording');
    expect(frames).toHaveLength(5);
    // Nothing more is scheduled.
    vi.advanceTimersByTime(5000);
    expect(frames).toHaveLength(5);
  });

  it('loops with monotonic timestamps and the nominal gap across the wrap', () => {
    const src = RecordingSource.fromRecording(makeRecording(3, 50));
    const frames = collect(src);
    src.setLoop(true);
    src.play();
    vi.advanceTimersByTime(400);
    // Frames at 0, 50, 100, then a 50 ms gap, then 150, 200, 250, gap, 300, 350, 400.
    expect(frames.map((f) => f.t)).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 400]);
    expect(src.isPlaying).toBe(true);
    for (let i = 1; i < frames.length; i++) expect(frames[i].t).toBeGreaterThan(frames[i - 1].t);
    expect(frames[3].pose!.world[4]).toEqual(src.recording.frames[0].pose!.world[4]);
  });

  it('setSpeed(2) plays twice as fast without changing the emitted timestamps', () => {
    const src = RecordingSource.fromRecording(makeRecording(5, 100));
    const frames = collect(src);
    src.setLoop(false);
    src.setSpeed(2);
    src.play();
    vi.advanceTimersByTime(200);
    expect(frames.map((f) => f.t)).toEqual([0, 100, 200, 300, 400]);
    // Changing speed mid-play re-anchors the clock (no jump).
    const slow = RecordingSource.fromRecording(makeRecording(5, 100));
    const sf = collect(slow);
    slow.setLoop(false);
    slow.play();
    vi.advanceTimersByTime(150);
    expect(sf.map((f) => f.t)).toEqual([0, 100]);
    slow.setSpeed(0.5);
    expect(slow.time).toBeCloseTo(150, 6);
    vi.advanceTimersByTime(99);
    expect(sf).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sf.map((f) => f.t)).toEqual([0, 100, 200]);
  });

  it('pause() freezes the position and play() resumes from it', () => {
    const src = RecordingSource.fromRecording(makeRecording(6, 100));
    const frames = collect(src);
    src.setLoop(false);
    src.play();
    vi.advanceTimersByTime(250);
    expect(frames.map((f) => f.t)).toEqual([0, 100, 200]);
    src.pause();
    expect(src.isPlaying).toBe(false);
    expect(src.time).toBeCloseTo(250, 6);
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(3);
    src.play();
    vi.advanceTimersByTime(49);
    expect(frames).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(frames.map((f) => f.t)).toEqual([0, 100, 200, 300]);
    src.stop();
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(4);
  });

});

describe('RecordingSource drift correction', () => {
  let wall = 0;
  beforeEach(() => {
    wall = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('catches up by skipping when the timer stalls', () => {
    const src = RecordingSource.fromRecording(makeRecording(30, 33));
    const frames = collect(src);
    src.setLoop(false);
    src.play();
    vi.advanceTimersByTime(0);
    expect(frames).toHaveLength(1);
    // The wall clock jumps 500 ms (tab throttled) before the pending tick runs.
    wall += 500;
    vi.advanceTimersByTime(33);
    // Instead of bursting 15 frames, only the last due frame is emitted.
    expect(frames).toHaveLength(2);
    expect(src.frameIndex).toBe(15);
    expect(frames[1].t).toBe(15 * 33);
    src.stop();
  });
});
