/**
 * Rig profiles (docs/DESIGN.md §5.5): assembling a `RigProfile` from the
 * analysis results, persisting profiles keyed by skeleton fingerprint, and
 * JSON import/export with validation.
 *
 * Pure except for the optional `localStorage` backing, which is feature
 * detected so the store also works in Node (in-memory fallback).
 */
import type { BoneSettings, HumanoidBone, HumanoidMap, RigProfile } from '../core/types';
import { HUMANOID_BONES } from '../core/types';
import type { AutoMapResult } from './autoMap';
import type { RigAnalysisResult } from './restPose';
import { fingerprintGraph, type SkeletonGraph } from './skeletonGraph';

export const PROFILE_VERSION = 2 as const;

/** Default per-bone settings: `auto` for anatomical bind poses, `relative` otherwise. */
export function defaultBoneSettings(analysis: RigAnalysisResult['analysis'], map: HumanoidMap): Partial<Record<HumanoidBone, BoneSettings>> {
  const out: Partial<Record<HumanoidBone, BoneSettings>> = {};
  for (const role of HUMANOID_BONES) {
    if (!map[role]) continue;
    const a = analysis[role];
    out[role] = { mode: a && !a.anatomical ? 'relative' : 'auto', rollOffsetDeg: 0 };
  }
  return out;
}

export function createRigProfile(
  displayName: string,
  graph: SkeletonGraph,
  autoMap: Pick<AutoMapResult, 'map' | 'confidence' | 'warnings' | 'family'>,
  analysis: Pick<RigAnalysisResult, 'analysis' | 'rootCorrection' | 'scale' | 'sourceHeight' | 'warnings'>,
): RigProfile {
  const warnings = [...new Set([...autoMap.warnings, ...analysis.warnings])];
  return {
    version: PROFILE_VERSION,
    fingerprint: fingerprintGraph(graph),
    displayName,
    family: autoMap.family,
    map: { ...autoMap.map },
    confidence: { ...autoMap.confidence },
    warnings,
    rootCorrection: [...analysis.rootCorrection] as RigProfile['rootCorrection'],
    scale: analysis.scale,
    sourceHeight: analysis.sourceHeight,
    analysis: { ...analysis.analysis },
    bones: defaultBoneSettings(analysis.analysis, autoMap.map),
    calibration: null,
  };
}

// ---------------------------------------------------------------------------
// Validation / JSON
// ---------------------------------------------------------------------------

const FAMILIES = new Set(['mixamo', 'meshy', 'vrm', 'rigify', 'ue', 'cc', 'daz', 'blender', 'unknown']);
const MODES = new Set(['auto', 'relative', 'calibrated', 'off']);
const ROLES = new Set<string>(HUMANOID_BONES);

function isNumArray(v: unknown, n: number): v is number[] {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** Returns a list of problems; empty when `value` is a valid RigProfile. */
export function validateProfile(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') return ['profile must be an object'];
  const p = value as Record<string, unknown>;
  if (p.version !== PROFILE_VERSION) errors.push(`unsupported profile version ${String(p.version)} (expected ${PROFILE_VERSION})`);
  if (typeof p.fingerprint !== 'string' || !p.fingerprint) errors.push('fingerprint must be a non-empty string');
  if (typeof p.displayName !== 'string') errors.push('displayName must be a string');
  if (typeof p.family !== 'string' || !FAMILIES.has(p.family)) errors.push('family is not a known rig family');
  if (!p.map || typeof p.map !== 'object') errors.push('map must be an object');
  else {
    for (const [role, name] of Object.entries(p.map as Record<string, unknown>)) {
      if (!ROLES.has(role)) errors.push(`map: unknown role '${role}'`);
      else if (typeof name !== 'string' || !name) errors.push(`map: bone name for '${role}' must be a non-empty string`);
    }
  }
  if (p.confidence !== undefined && (!p.confidence || typeof p.confidence !== 'object')) errors.push('confidence must be an object');
  if (!Array.isArray(p.warnings) || !p.warnings.every((w) => typeof w === 'string')) errors.push('warnings must be a string array');
  if (!isNumArray(p.rootCorrection, 4)) errors.push('rootCorrection must be a quaternion [x,y,z,w]');
  if (typeof p.scale !== 'number' || !(p.scale > 0)) errors.push('scale must be a positive number');
  if (typeof p.sourceHeight !== 'number' || !(p.sourceHeight > 0)) errors.push('sourceHeight must be a positive number');
  if (!p.analysis || typeof p.analysis !== 'object') errors.push('analysis must be an object');
  else {
    for (const [role, a] of Object.entries(p.analysis as Record<string, unknown>)) {
      if (!ROLES.has(role)) {
        errors.push(`analysis: unknown role '${role}'`);
        continue;
      }
      const b = a as Record<string, unknown>;
      if (!b || typeof b !== 'object') errors.push(`analysis.${role} must be an object`);
      else if (!isNumArray(b.restDir, 3) || !isNumArray(b.restQuat, 4) || !isNumArray(b.restPos, 3) || typeof b.length !== 'number' || typeof b.anatomical !== 'boolean')
        errors.push(`analysis.${role} is malformed`);
    }
  }
  if (!p.bones || typeof p.bones !== 'object') errors.push('bones must be an object');
  else {
    for (const [role, s] of Object.entries(p.bones as Record<string, unknown>)) {
      if (!ROLES.has(role)) {
        errors.push(`bones: unknown role '${role}'`);
        continue;
      }
      const b = s as Record<string, unknown>;
      if (!b || typeof b !== 'object' || typeof b.mode !== 'string' || !MODES.has(b.mode) || typeof b.rollOffsetDeg !== 'number') errors.push(`bones.${role} is malformed`);
    }
  }
  if (p.calibration !== undefined && p.calibration !== null) {
    const c = p.calibration as Record<string, unknown>;
    if (!c || typeof c !== 'object' || c.version !== 2 || !c.bases || typeof c.bases !== 'object') errors.push('calibration is malformed');
  }
  return errors;
}

export function isRigProfile(value: unknown): value is RigProfile {
  return validateProfile(value).length === 0;
}

export function exportProfileJson(profile: RigProfile): string {
  return JSON.stringify(profile, null, 2);
}

/** Parses and validates a profile; throws with a readable message on failure. */
export function importProfileJson(json: string): RigProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Profile JSON could not be parsed: ${(e as Error).message}`);
  }
  const errors = validateProfile(parsed);
  if (errors.length) throw new Error(`Invalid rig profile: ${errors.join('; ')}`);
  const p = parsed as RigProfile;
  return { ...p, confidence: p.confidence ?? {}, calibration: p.calibration ?? null };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

/** In-memory storage used when `localStorage` is unavailable (Node, private mode). */
export class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** Wraps the Web Storage API when it is usable in this environment. */
export function localStorageAdapter(): KeyValueStorage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls || typeof ls.getItem !== 'function') return null;
    const probe = '__cameracharacter_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      getItem: (k) => ls.getItem(k),
      setItem: (k, v) => ls.setItem(k, v),
      removeItem: (k) => ls.removeItem(k),
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      },
    };
  } catch {
    return null;
  }
}

export interface ProfileSummary {
  fingerprint: string;
  displayName: string;
  family: RigProfile['family'];
  savedAt: string;
}

interface StoredRecord {
  savedAt: string;
  profile: RigProfile;
}

export class ProfileStore {
  private storage: KeyValueStorage;
  constructor(storage?: KeyValueStorage | null, private prefix = 'cameracharacter.profile.') {
    this.storage = storage ?? localStorageAdapter() ?? new MemoryStorage();
  }
  private key(fingerprint: string): string {
    return this.prefix + fingerprint;
  }
  load(fingerprint: string): RigProfile | null {
    const raw = this.storage.getItem(this.key(fingerprint));
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw) as StoredRecord;
      return isRigProfile(rec.profile) ? rec.profile : null;
    } catch {
      return null;
    }
  }
  save(profile: RigProfile): void {
    const errors = validateProfile(profile);
    if (errors.length) throw new Error(`Refusing to save an invalid profile: ${errors.join('; ')}`);
    const rec: StoredRecord = { savedAt: new Date().toISOString(), profile };
    this.storage.setItem(this.key(profile.fingerprint), JSON.stringify(rec));
  }
  list(): ProfileSummary[] {
    const out: ProfileSummary[] = [];
    for (const k of this.storage.keys()) {
      if (!k.startsWith(this.prefix)) continue;
      const raw = this.storage.getItem(k);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as StoredRecord;
        if (!isRigProfile(rec.profile)) continue;
        out.push({ fingerprint: rec.profile.fingerprint, displayName: rec.profile.displayName, family: rec.profile.family, savedAt: rec.savedAt });
      } catch {
        // skip corrupt entries
      }
    }
    out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
    return out;
  }
  remove(fingerprint: string): void {
    this.storage.removeItem(this.key(fingerprint));
  }
  clear(): void {
    for (const k of this.storage.keys()) if (k.startsWith(this.prefix)) this.storage.removeItem(k);
  }
}
