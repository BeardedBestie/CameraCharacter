import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_OPTIONS, importSettingsPatchFromUrl, loadImportOptions, parseImportUrl, saveImportOptions } from '../../src/import/state';

class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

describe('import page state', () => {
  it('parses URL options with validation', () => {
    const u = parseImportUrl('?model=/m.glb&take=/t.json&video=/v.mp4&fps=24&poseModel=lite&delegate=CPU&hands=1&camera=track&hips=full&mirror=0&kiosk&autoplay=0&loop=1');
    expect(u).toMatchObject({ model: '/m.glb', take: '/t.json', video: '/v.mp4', fps: 24, poseModel: 'lite', delegate: 'CPU', hands: true, camera: 'track', hips: 'full', mirror: false, kiosk: true, autoplay: false, loop: true });
    const bad = parseImportUrl('?fps=-3&poseModel=giant&camera=mirror');
    expect(bad.fps).toBeUndefined();
    expect(bad.poseModel).toBeUndefined();
    expect(bad.camera).toBeUndefined();
    expect(bad.autoplay).toBe(true);
    const patch = importSettingsPatchFromUrl(u);
    expect(patch).toEqual({ stage: { hipsMode: 'full', mirror: false }, tracking: { poseModel: 'lite', delegate: 'CPU', hands: true } });
    expect(importSettingsPatchFromUrl(parseImportUrl(''))).toEqual({});
  });

  it('persists import options and ignores malformed values', () => {
    const storage = new FakeStorage();
    expect(loadImportOptions(storage)).toEqual(DEFAULT_IMPORT_OPTIONS);
    saveImportOptions({ ...DEFAULT_IMPORT_OPTIONS, sampleFps: 15, cameraMode: 'track', pip: false }, storage);
    const back = loadImportOptions(storage);
    expect(back.sampleFps).toBe(15);
    expect(back.cameraMode).toBe('track');
    expect(back.pip).toBe(false);
    storage.setItem('cameracharacter.import.options.v1', JSON.stringify({ sampleFps: 'fast', cameraMode: 'mirror', bakeFps: -1 }));
    const fixed = loadImportOptions(storage);
    expect(fixed.sampleFps).toBe(DEFAULT_IMPORT_OPTIONS.sampleFps);
    expect(fixed.cameraMode).toBe('orbit');
    expect(fixed.bakeFps).toBe(30);
    storage.setItem('cameracharacter.import.options.v1', '{not json');
    expect(loadImportOptions(storage)).toEqual(DEFAULT_IMPORT_OPTIONS);
    expect(loadImportOptions(null)).toEqual(DEFAULT_IMPORT_OPTIONS);
  });
});
