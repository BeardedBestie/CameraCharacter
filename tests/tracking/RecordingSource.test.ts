import { describe, expect, it } from 'vitest';
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
    expect(frames[2].pose!.world[5]).toEqual(src.recording.frames[2].pose!.world[5]);
    expect(src.frameIndex).toBe(3);
    expect(src.time).toBe(120);
    expect(src.isPlaying).toBe(false);
  });

  it('two sources with the same recording produce identical streams', () => {
    const a = RecordingSource.fromRecording(makeRecording(6));
    const b = RecordingSource.fromRecording(makeRecording(6));
    const fa = collect(a);
    const fb = collect(b);
    for (let i = 0; i < 6; i++) {
      a.step();
      b.step();
    }
    expect(JSON.stringify(fa)).toBe(JSON.stringify(fb));
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
    expect(src.frameIndex).toBe(0); // 7th emission is frame index 0 again
    expect(frames[3].pose!.image[0]).toEqual(src.recording.frames[0].pose!.image[0]);
  });

  it('seek positions the cursor at the first frame at or after the time and keeps timestamps monotonic', () => {
    const src = RecordingSource.fromRecording(makeRecording(10, 100));
    const frames = collect(src);
    src.setLoop(false);
    src.step();
    src.step();
    src.step(); // frames 0,1,2 emitted; last t = 200
    src.seek(450);
    expect(src.time).toBe(450);
    expect(src.nextFrameIndex).toBe(5);
    expect(src.step()).toBe(true);
    expect(src.frameIndex).toBe(5);
    expect(frames[3].t).toBe(300); // continues one nominal gap after the last emitted t
    src.seek(0); // backwards
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
    rec.frames[1].t = rec.frames[0].t - 50; // goes backwards
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
