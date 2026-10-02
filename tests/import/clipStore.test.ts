import { describe, expect, it } from 'vitest';
import { generateRecording } from '../../src/testing/syntheticHuman';
import { MemoryClipStore, newClipId, statsOf, summarize, type StoredClip } from '../../src/import/clipStore';

function clip(id: string, name: string, createdAt: string): StoredClip {
  const recording = generateRecording('tpose', { fps: 10, durationSec: 1 });
  return { id, name, createdAt, recording, stats: statsOf(recording) };
}

describe('clipStore helpers', () => {
  it('builds sortable ids', () => {
    const a = newClipId(new Date(1_000_000), () => 0.5);
    const b = newClipId(new Date(2_000_000), () => 0.5);
    expect(a < b).toBe(true);
    expect(a).toMatch(/^[0-9a-z]+-[0-9a-z]{6}$/);
  });

  it('derives stats from the recording, preferring the video block', () => {
    const rec = generateRecording('walk', { fps: 30, durationSec: 2 });
    const s = statsOf(rec);
    expect(s.frames).toBe(60);
    expect(s.detectedFrames).toBe(60);
    expect(s.durationMs).toBeCloseTo((59 / 30) * 1000, 0);
    expect(s.sampleFps).toBeCloseTo(30, 0);
    expect(s.width).toBe(1280);
    rec.meta.video = { fileName: 'x.mp4', durationMs: 2000, sampleFps: 25, width: 640, height: 360, detectedFrames: 12 };
    const v = statsOf(rec);
    expect(v).toMatchObject({ durationMs: 2000, sampleFps: 25, width: 640, height: 360, detectedFrames: 12 });
  });

  it('summaries drop the heavy fields', () => {
    const c = clip('a', 'A', '2026-01-01T00:00:00Z');
    const s = summarize(c);
    expect(s).toEqual({ id: 'a', name: 'A', createdAt: '2026-01-01T00:00:00Z', stats: c.stats, hasVideo: false, videoBytes: 0 });
    expect('recording' in s).toBe(false);
  });
});

describe('MemoryClipStore', () => {
  it('stores, lists in creation order, patches and deletes', async () => {
    const store = new MemoryClipStore();
    await store.put(clip('b', 'B', '2026-01-02T00:00:00Z'));
    await store.put(clip('a', 'A', '2026-01-01T00:00:00Z'));
    const list = await store.list();
    expect(list.map((c) => c.id)).toEqual(['a', 'b']);
    await store.patch('a', { name: 'Renamed', cameraTrack: { format: 'cameracharacter-camera-track', version: 1, keys: [] } });
    const a = await store.get('a');
    expect(a?.name).toBe('Renamed');
    expect(a?.cameraTrack?.keys).toEqual([]);
    await store.patch('missing', { name: 'x' });
    expect(await store.get('missing')).toBeNull();
    await store.delete('a');
    expect((await store.list()).map((c) => c.id)).toEqual(['b']);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });
});
