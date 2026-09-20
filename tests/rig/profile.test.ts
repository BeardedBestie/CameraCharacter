import { describe, expect, it } from 'vitest';
import type { RigAnalysis, RigProfile } from '../../src/core/types';
import { MemoryStorage, ProfileStore, applyProfile, createRigProfile, exportProfileJson, importProfileJson, validateProfile } from '../../src/rig/profile';
import { analyzeRig } from '../../src/rig/restPose';
import { MIXAMO_PREFIXED, buildFixtureObject } from '../fixtures/rigNames';

function analysis(): RigAnalysis {
  const { root } = buildFixtureObject(MIXAMO_PREFIXED.bones);
  return analyzeRig(root, null, { targetHeight: 1.7, displayName: 'Mixamo fixture' });
}

describe('createRigProfile / applyProfile', () => {
  it('creates an empty v3 profile carrying the keys and display name', () => {
    const a = analysis();
    const p = createRigProfile(a);
    expect(p.version).toBe(3);
    expect(p.familyKey).toBe(a.familyKey);
    expect(p.instanceKey).toBe(a.instanceKey);
    expect(p.displayName).toBe('Mixamo fixture');
    expect(p.mapOverrides).toEqual({});
    expect(p.bones).toEqual({});
    expect(p.swapSides).toBe(false);
    expect(p.calibration).toBeNull();
    expect(validateProfile(p)).toEqual([]);
  });

  it('applies map overrides only where the bone exists, and merges bone settings over the defaults', () => {
    const a = analysis();
    const p = createRigProfile(a);
    p.mapOverrides = { head: 'mixamorig:Neck', leftEye: 'nope', neck: '' };
    p.bones = { leftUpperArm: { mode: 'calibrated', rollOffsetDeg: 15 }, hips: { mode: 'relative', rollOffsetDeg: 0, smoothing: 0.5 } };
    const names = [...MIXAMO_PREFIXED.bones.map((b) => b.name)];
    const r = applyProfile(a, p, names);
    expect(r.map.head).toBe('mixamorig:Neck');
    expect(r.map.neck).toBeUndefined();
    expect(r.map.leftEye).toBeUndefined();
    expect(r.warnings.some((w) => /nope/.test(w))).toBe(true);
    expect(r.boneSettings.leftUpperArm).toEqual({ mode: 'calibrated', rollOffsetDeg: 15 });
    expect(r.boneSettings.hips).toEqual({ mode: 'relative', rollOffsetDeg: 0, smoothing: 0.5 });
    expect(r.boneSettings.leftLowerArm).toEqual(a.defaultBones.leftLowerArm);
    // The analysis itself is untouched.
    expect(a.map.head).toBe('mixamorig:Head');
    expect(a.map.neck).toBe('mixamorig:Neck');
  });

  it('without a bone list, overrides are applied as given', () => {
    const a = analysis();
    const p = createRigProfile(a);
    p.mapOverrides = { head: 'whatever' };
    expect(applyProfile(a, p).map.head).toBe('whatever');
    expect(applyProfile(a, null).map).toEqual(a.map);
  });

  it('swapSides mirrors the left/right roles (and their default settings)', () => {
    const a = analysis();
    a.defaultBones.leftUpperLeg = { mode: 'follow', rollOffsetDeg: 0 };
    const p = createRigProfile(a);
    p.swapSides = true;
    const r = applyProfile(a, p);
    expect(r.map.leftUpperArm).toBe('mixamorig:RightArm');
    expect(r.map.rightUpperArm).toBe('mixamorig:LeftArm');
    expect(r.map.leftIndexDistal).toBe('mixamorig:RightHandIndex3');
    expect(r.map.hips).toBe('mixamorig:Hips');
    expect(r.boneSettings.rightUpperLeg!.mode).toBe('follow');
    expect(r.boneSettings.leftUpperLeg!.mode).toBe('auto');
  });
});

describe('JSON export / import', () => {
  it('round-trips and validates', () => {
    const p = createRigProfile(analysis());
    p.bones = { head: { mode: 'off', rollOffsetDeg: -5 } };
    p.sockets = { rightHand: { position: [0.1, 0, 0], rotation: [0, 0, 0, 1], scale: 1 } };
    const json = exportProfileJson(p);
    expect(JSON.parse(json).format).toBe('cameracharacter-rig-profile');
    const back = importProfileJson(json);
    expect(back).toEqual(p);
    // Bare profile objects (no format field) also import.
    expect(importProfileJson(JSON.stringify(p))).toEqual(p);
  });

  it('rejects invalid input with a readable message', () => {
    expect(() => importProfileJson('not json')).toThrow(/parsed/);
    expect(() => importProfileJson('{"format":"other"}')).toThrow(/Not a rig profile/);
    expect(() => importProfileJson(JSON.stringify({ version: 2, fingerprint: 'x' }))).toThrow(/version/);
    const p = createRigProfile(analysis());
    (p.bones as Record<string, unknown>).head = { mode: 'weird', rollOffsetDeg: 0 };
    expect(validateProfile(p).some((e) => /bones\.head/.test(e))).toBe(true);
    (p.mapOverrides as Record<string, unknown>).notARole = 'x';
    expect(validateProfile(p).some((e) => /unknown role/.test(e))).toBe(true);
    expect(() => exportProfileJson(p)).toThrow(/invalid/);
  });
});

describe('ProfileStore', () => {
  function profile(instanceKey: string, familyKey: string, updatedAt: string): RigProfile {
    return {
      version: 3,
      familyKey,
      instanceKey,
      displayName: instanceKey,
      updatedAt,
      mapOverrides: { head: `${instanceKey}-head` },
      swapSides: false,
      bones: { hips: { mode: 'off', rollOffsetDeg: 1 } },
      sockets: { leftHand: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 } },
      calibration: { version: 3, createdAt: updatedAt, bases: {}, torsoBaseline: null, segmentLengths: {}, zRef: null, frames: 60 },
    };
  }

  it('saves, lists (newest first), loads and removes profiles in an in-memory Storage', () => {
    const storage = new MemoryStorage();
    const store = new ProfileStore(storage);
    store.save(profile('fam1-a', 'fam1', '2026-01-01T00:00:00Z'));
    store.save(profile('fam1-b', 'fam1', '2026-02-01T00:00:00Z'));
    store.save(profile('fam2-c', 'fam2', '2026-03-01T00:00:00Z'));
    expect(store.list().map((p) => p.instanceKey)).toEqual(['fam2-c', 'fam1-b', 'fam1-a']);
    expect(store.load('fam1-a', 'fam1')!.displayName).toBe('fam1-a');
    expect(store.load('fam1-a', 'fam1')!.calibration!.frames).toBe(60);
    store.remove('fam1-a');
    expect(store.list().length).toBe(2);
    // The store only needs getItem/setItem/removeItem.
    expect(storage.length).toBe(3); // two profiles + index
    // Re-saving updates in place.
    store.save(profile('fam1-b', 'fam1', '2026-04-01T00:00:00Z'));
    expect(store.list().length).toBe(2);
    expect(store.list()[0].instanceKey).toBe('fam1-b');
  });

  it('falls back to a family-level profile carrying map overrides and bone settings only', () => {
    const store = new ProfileStore(new MemoryStorage());
    store.save(profile('fam1-a', 'fam1', '2026-01-01T00:00:00Z'));
    const p = store.load('fam1-new', 'fam1')!;
    expect(p.instanceKey).toBe('fam1-new');
    expect(p.familyKey).toBe('fam1');
    expect(p.mapOverrides).toEqual({ head: 'fam1-a-head' });
    expect(p.bones).toEqual({ hips: { mode: 'off', rollOffsetDeg: 1 } });
    expect(p.sockets).toEqual({});
    expect(p.calibration).toBeNull();
    expect(store.load('other', 'fam9')).toBeNull();
  });

  it('ignores corrupt entries and refuses invalid profiles', () => {
    const storage = new MemoryStorage();
    const store = new ProfileStore(storage);
    store.save(profile('k1', 'f', '2026-01-01T00:00:00Z'));
    storage.setItem('cameracharacter.profile.k1', '{broken');
    expect(store.load('k1', 'f')).toBeNull();
    expect(store.list()).toEqual([]);
    expect(() => store.save({ ...profile('k2', 'f', 'x'), version: 2 } as unknown as RigProfile)).toThrow(/invalid/);
    // The store survives a storage that throws (private mode).
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => undefined, removeItem: () => undefined };
    expect(new ProfileStore(throwing).list()).toEqual([]);
  });

  it('a store without an explicit storage falls back to memory in Node', () => {
    const store = new ProfileStore();
    store.save(profile('k', 'f', '2026-01-01T00:00:00Z'));
    expect(store.load('k', 'f')).not.toBeNull();
    store.clear();
    expect(store.list()).toEqual([]);
  });
});
