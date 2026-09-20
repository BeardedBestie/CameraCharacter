import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoseFrame } from '../../src/core/types';
import { SYNTHETIC_SRC, SyntheticSource } from '../../src/tracking/SyntheticSource';
import { generateRecording } from '../../src/testing/syntheticHuman';

function collect(src: SyntheticSource): PoseFrame[] {
  const out: PoseFrame[] = [];
  src.onFrame((f) => out.push(f));
  return out;
}

const strip = (fs: PoseFrame[]) => JSON.stringify(fs.map(({ now: _now, ...rest }) => rest));

describe('SyntheticSource.step', () => {
  it('is deterministic: two sources produce identical frames, t = k · 1000/fps, src "synthetic"', () => {
    const a = new SyntheticSource({ preset: 'walk', fps: 30 });
    const b = new SyntheticSource({ preset: 'walk', fps: 30 });
    const fa = collect(a);
    const fb = collect(b);
    for (let i = 0; i < 10; i++) {
      expect(a.step()).toBe(true);
      expect(b.step()).toBe(true);
    }
    expect(strip(fa)).toBe(strip(fb));
    expect(fa.map((f) => f.t)).toEqual(Array.from({ length: 10 }, (_, k) => (k * 1000) / 30));
    expect(fa.every((f) => f.src === SYNTHETIC_SRC && f.v === 2)).toBe(true);
    expect(fa.every((f) => Number.isFinite(f.now))).toBe(true);
    expect(fa[0].size).toEqual([1280, 720]);
    expect(fa[3].pose!.world).toHaveLength(33);
    expect(a.frameIndex).toBe(9);
    expect(a.nextFrameIndex).toBe(10);
    // Same landmarks as the offline generator at the same times.
    const rec = generateRecording('walk', { fps: 30 });
    expect(fa[5].pose!.world[15]).toEqual(rec.frames[5].pose!.world[15]);
    expect(fa[5].pose!.image[27]).toEqual(rec.frames[5].pose!.image[27]);
  });

  it('loops with monotonic t (preset time wraps) and stops at the end when loop is off', () => {
    const src = new SyntheticSource({ preset: 'tpose', fps: 10 });
    expect(src.framesPerLoop).toBe(40);
    const frames = collect(src);
    for (let i = 0; i < 45; i++) expect(src.step()).toBe(true);
    expect(frames[44].t).toBe(4400);
    expect(frames[41].pose!.world[0]).toEqual(frames[1].pose!.world[0]);

    const once = new SyntheticSource({ preset: 'tpose', fps: 10, loop: false });
    const f2 = collect(once);
    for (let i = 0; i < 40; i++) expect(once.step()).toBe(true);
    expect(once.step()).toBe(false);
    expect(f2).toHaveLength(40);
    expect(once.isPlaying).toBe(false);
  });

  it('rejects unknown presets and defaults the frame rate', () => {
    expect(() => new SyntheticSource({ preset: 'nope' })).toThrow(/Unknown synthetic preset/);
    expect(new SyntheticSource({ preset: 'wave' }).frameRate).toBe(30);
    expect(new SyntheticSource({ preset: 'wave', fps: -5 }).frameRate).toBe(30);
    expect(new SyntheticSource({ preset: 'closeup', size: [640, 360] }).frameAt(0).size).toEqual([640, 360]);
  });
});

describe('SyntheticSource real-time playback', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() paces frames at the configured rate, pause() and stop() halt it', async () => {
    const src = new SyntheticSource({ preset: 'squat', fps: 20 });
    const frames = collect(src);
    const states: string[] = [];
    src.onStatus((s) => states.push(s.state));
    await src.start();
    expect(src.isPlaying).toBe(true);
    expect(src.status.state).toBe('running');
    vi.advanceTimersByTime(0);
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    // 50 ms per frame: 21 frames in [0, 1000] ms (timer rounding may shift one boundary).
    expect(frames.length).toBeGreaterThanOrEqual(20);
    expect(frames.length).toBeLessThanOrEqual(21);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].t - frames[i - 1].t).toBeCloseTo(50, 9);
      expect(frames[i].now!).toBeGreaterThan(frames[i - 1].now!);
    }
    src.pause();
    const n = frames.length;
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(n);
    src.play();
    vi.advanceTimersByTime(500);
    expect(frames.length).toBeGreaterThan(n + 8);
    src.stop();
    expect(src.status.state).toBe('stopped');
    const m = frames.length;
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(m);
    const transitions = states.filter((st, i) => i === 0 || states[i - 1] !== st);
    expect(transitions).toEqual(['running', 'stopped']);
  });

});

describe('SyntheticSource drift correction', () => {
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

  it('skips ahead instead of bursting when the timer stalls, and pauses at the end without loop', () => {
    const src = new SyntheticSource({ preset: 'tpose', fps: 10, loop: false });
    const frames = collect(src);
    src.play();
    vi.advanceTimersByTime(0);
    expect(frames).toHaveLength(1);
    expect(frames[0].now).toBe(0);
    // The wall clock jumps 2 s before the pending tick runs: 20 frames became due, only the last three are emitted.
    wall += 2000;
    vi.advanceTimersByTime(100);
    expect(frames).toHaveLength(4);
    expect(frames.map((f) => f.t)).toEqual([0, 1800, 1900, 2000]);
    expect(src.frameIndex).toBe(20);
    // Then it runs to the end of the 4 s preset and pauses.
    for (let i = 0; i < 40; i++) {
      wall += 100;
      vi.advanceTimersByTime(100);
    }
    expect(src.isPlaying).toBe(false);
    expect(src.frameIndex).toBe(39);
    expect(src.status.message).toBe('End of preset');
    const n = frames.length;
    wall += 1000;
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(n);
  });
});
