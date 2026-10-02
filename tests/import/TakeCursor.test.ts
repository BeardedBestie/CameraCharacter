import { describe, expect, it } from 'vitest';
import { TakeCursor, VIDEO_TAKE_SRC } from '../../src/import/TakeCursor';
import { makePoseFrame } from '../tracking/fixtures';

function frames(count: number, gapMs = 40, t0 = 1000) {
  return Array.from({ length: count }, (_, i) => makePoseFrame(t0 + i * gapMs));
}

describe('TakeCursor', () => {
  it('finds the last frame at or before a media time', () => {
    const c = new TakeCursor(frames(5));
    expect(c.count).toBe(5);
    expect(c.duration).toBe(160);
    expect(c.nominalGapMs).toBe(40);
    expect(c.indexAt(-10)).toBe(0);
    expect(c.indexAt(0)).toBe(0);
    expect(c.indexAt(39)).toBe(0);
    expect(c.indexAt(40)).toBe(1);
    expect(c.indexAt(159)).toBe(3);
    expect(c.indexAt(10_000)).toBe(4);
    expect(new TakeCursor([]).indexAt(0)).toBe(-1);
  });

  it('emits a frame once per index and re-stamps time and source', () => {
    const c = new TakeCursor(frames(4));
    const a = c.frameFor(0, 123);
    expect(a).not.toBeNull();
    expect(a!.t).toBe(0);
    expect(a!.now).toBe(123);
    expect(a!.src).toBe(VIDEO_TAKE_SRC);
    expect(c.frameFor(20, 124)).toBeNull(); // same frame still current
    const b = c.frameFor(45, 125);
    expect(b!.t).toBe(40);
    expect(c.lastEmitted).toBe(1);
  });

  it('keeps emitted timestamps monotonic across a backward seek and a loop', () => {
    const c = new TakeCursor(frames(4));
    c.frameFor(0, 0);
    c.frameFor(80, 1);
    const back = c.frameFor(0, 2); // seek to the start
    expect(back!.t).toBe(120); // 80 + one nominal gap
    const next = c.frameFor(40, 3);
    expect(next!.t).toBe(160);
    c.frameFor(120, 4);
    const wrapped = c.frameFor(0, 5);
    expect(wrapped!.t).toBeGreaterThan(160);
  });

  it('invalidate() re-emits the current frame, reset() restarts the clock', () => {
    const c = new TakeCursor(frames(3));
    c.frameFor(40, 0);
    expect(c.frameFor(40, 1)).toBeNull();
    c.invalidate();
    const again = c.frameFor(40, 2);
    expect(again).not.toBeNull();
    expect(again!.t).toBe(80); // repeat of the same index advances the clock by one gap
    c.reset();
    expect(c.frameFor(0, 3)!.t).toBe(0);
  });

  it('tolerates non-monotonic recorded times by clamping', () => {
    const f = frames(3);
    f[1] = makePoseFrame(900); // earlier than frame 0
    const c = new TakeCursor(f);
    expect(c.rel).toEqual([0, 0, 80]);
    expect(c.indexAt(0)).toBe(1);
  });
});
