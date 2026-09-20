/**
 * Rig profiles (docs/DESIGN.md §5.6): persisted USER INTENT only (map
 * overrides, swapped sides, per-bone settings, sockets, calibration, display
 * name), applied as a diff over the runtime {@link RigAnalysis}. Scale, root
 * correction, confidences and warnings are never persisted.
 *
 * `ProfileStore` keys profiles by `instanceKey` and falls back to a profile of
 * the same `familyKey` (map overrides and bone settings only). It takes any
 * Web-Storage-like object (`getItem/setItem/removeItem`), `localStorage` when
 * usable, or an in-memory map, so it runs in Node.
 */
import type { BoneRefMode, BoneSettings, HumanoidBone, HumanoidMap, PoseCalibration, RigAnalysis, RigProfile, SocketOffset } from '../core/types';
import { HUMANOID_BONES, mirrorBone } from '../core/types';

export const PROFILE_VERSION = 3 as const;

/** A fresh profile for an analysis: no overrides, no settings, no calibration. */
export function createRigProfile(analysis: RigAnalysis): RigProfile {
  return {
    version: PROFILE_VERSION,
    familyKey: analysis.familyKey,
    instanceKey: analysis.instanceKey,
    displayName: analysis.displayName,
    updatedAt: new Date().toISOString(),
    mapOverrides: {},
    swapSides: false,
    bones: {},
    sockets: {},
    calibration: null,
  };
}

export interface AppliedProfile {
  map: HumanoidMap;
  boneSettings: Partial<Record<HumanoidBone, BoneSettings>>;
  warnings: string[];
}

/** Mirrors every left/right entry of a role-keyed record. */
function mirrorRecord<T>(rec: Partial<Record<HumanoidBone, T>>): Partial<Record<HumanoidBone, T>> {
  const out: Partial<Record<HumanoidBone, T>> = {};
  for (const role of HUMANOID_BONES) {
    const src = mirrorBone(role);
    if (rec[src] !== undefined) out[role] = rec[src];
  }
  return out;
}

/**
 * Applies a profile over the auto result: `swapSides` mirrors the left/right
 * roles of the map (and of the default bone settings, which follow their
 * bones), map overrides replace roles only where the named bone exists
 * (`boneNames`, when given; an empty override unmaps the role), and bone
 * settings are merged per role over `analysis.defaultBones`.
 */
export function applyProfile(analysis: RigAnalysis, profile: RigProfile | null | undefined, boneNames?: Iterable<string>): AppliedProfile {
  const warnings: string[] = [];
  let map: HumanoidMap = { ...analysis.map };
  let defaults: Partial<Record<HumanoidBone, BoneSettings>> = {};
  for (const [role, s] of Object.entries(analysis.defaultBones) as [HumanoidBone, BoneSettings][]) defaults[role] = { ...s };
  if (!profile) return { map, boneSettings: defaults, warnings };

  if (profile.swapSides) {
    map = mirrorRecord(map);
    defaults = mirrorRecord(defaults);
  }
  const existing = boneNames ? new Set(boneNames) : null;
  for (const [role, name] of Object.entries(profile.mapOverrides) as [HumanoidBone, string | undefined][]) {
    if (!HUMANOID_BONES.includes(role)) continue;
    if (name === undefined) continue;
    if (name === '') {
      delete map[role];
      continue;
    }
    if (existing && !existing.has(name)) {
      warnings.push(`Profile override ${role} -> '${name}' ignored: the bone does not exist in this model.`);
      continue;
    }
    // A bone holds one role: release it from any other role first.
    for (const other of HUMANOID_BONES) if (other !== role && map[other] === name) delete map[other];
    map[role] = name;
  }
  const boneSettings: Partial<Record<HumanoidBone, BoneSettings>> = {};
  for (const role of HUMANOID_BONES) {
    if (!map[role]) continue;
    const base = defaults[role] ?? { mode: 'auto', rollOffsetDeg: 0 };
    const user = profile.bones[role];
    boneSettings[role] = user ? { ...base, ...user } : { ...base };
  }
  return { map, boneSettings, warnings };
}

// ---------------------------------------------------------------------------
// Validation / JSON
// ---------------------------------------------------------------------------

const MODES = new Set<BoneRefMode>(['auto', 'relative', 'calibrated', 'follow', 'off']);
const ROLES = new Set<string>(HUMANOID_BONES);

function isNumArray(v: unknown, n: number): v is number[] {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validateCalibration(c: unknown, errors: string[]): void {
  if (!isRecord(c)) {
    errors.push('calibration must be an object or null');
    return;
  }
  if (c.version !== 3) errors.push(`calibration version ${String(c.version)} is not supported (expected 3)`);
  if (typeof c.createdAt !== 'string') errors.push('calibration.createdAt must be a string');
  if (!isRecord(c.bases)) errors.push('calibration.bases must be an object');
  else {
    for (const [role, b] of Object.entries(c.bases)) {
      if (!ROLES.has(role)) errors.push(`calibration.bases: unknown role '${role}'`);
      else if (!isRecord(b) || !isNumArray(b.d, 3) || !isNumArray(b.u, 3)) errors.push(`calibration.bases.${role} is malformed`);
    }
  }
  if (c.torsoBaseline !== null && c.torsoBaseline !== undefined) {
    const t = c.torsoBaseline;
    if (!isRecord(t) || !isNumArray(t.d, 3) || !isNumArray(t.u, 3)) errors.push('calibration.torsoBaseline is malformed');
  }
  if (!isRecord(c.segmentLengths)) errors.push('calibration.segmentLengths must be an object');
  if (c.zRef !== null && typeof c.zRef !== 'number') errors.push('calibration.zRef must be a number or null');
  if (typeof c.frames !== 'number') errors.push('calibration.frames must be a number');
}

/** Returns a list of problems; empty when `value` is a valid v3 RigProfile. */
export function validateProfile(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['profile must be an object'];
  const p = value;
  if (p.version !== PROFILE_VERSION) errors.push(`unsupported profile version ${String(p.version)} (expected ${PROFILE_VERSION})`);
  if (typeof p.familyKey !== 'string' || !p.familyKey) errors.push('familyKey must be a non-empty string');
  if (typeof p.instanceKey !== 'string' || !p.instanceKey) errors.push('instanceKey must be a non-empty string');
  if (typeof p.displayName !== 'string') errors.push('displayName must be a string');
  if (typeof p.updatedAt !== 'string') errors.push('updatedAt must be a string');
  if (!isRecord(p.mapOverrides)) errors.push('mapOverrides must be an object');
  else {
    for (const [role, name] of Object.entries(p.mapOverrides)) {
      if (!ROLES.has(role)) errors.push(`mapOverrides: unknown role '${role}'`);
      else if (typeof name !== 'string') errors.push(`mapOverrides: bone name for '${role}' must be a string`);
    }
  }
  if (typeof p.swapSides !== 'boolean') errors.push('swapSides must be a boolean');
  if (!isRecord(p.bones)) errors.push('bones must be an object');
  else {
    for (const [role, s] of Object.entries(p.bones)) {
      if (!ROLES.has(role)) {
        errors.push(`bones: unknown role '${role}'`);
        continue;
      }
      if (!isRecord(s) || typeof s.mode !== 'string' || !MODES.has(s.mode as BoneRefMode) || typeof s.rollOffsetDeg !== 'number' || !Number.isFinite(s.rollOffsetDeg)) errors.push(`bones.${role} is malformed`);
      else if (s.smoothing !== undefined && (typeof s.smoothing !== 'number' || !Number.isFinite(s.smoothing))) errors.push(`bones.${role}.smoothing must be a number`);
    }
  }
  if (!isRecord(p.sockets)) errors.push('sockets must be an object');
  else {
    for (const [name, s] of Object.entries(p.sockets)) {
      if (!isRecord(s) || !isNumArray(s.position, 3) || !isNumArray(s.rotation, 4) || typeof s.scale !== 'number' || !(s.scale > 0)) errors.push(`sockets.${name} is malformed`);
    }
  }
  if (p.calibration !== null && p.calibration !== undefined) validateCalibration(p.calibration, errors);
  return errors;
}

export function isRigProfile(value: unknown): value is RigProfile {
  return validateProfile(value).length === 0;
}

/** Normalizes a validated profile object (fills optional fields). */
function normalizeProfile(p: RigProfile): RigProfile {
  const bones: Partial<Record<HumanoidBone, BoneSettings>> = {};
  for (const [role, s] of Object.entries(p.bones) as [HumanoidBone, BoneSettings][]) {
    bones[role] = s.smoothing !== undefined ? { mode: s.mode, rollOffsetDeg: s.rollOffsetDeg, smoothing: s.smoothing } : { mode: s.mode, rollOffsetDeg: s.rollOffsetDeg };
  }
  const sockets: Record<string, SocketOffset> = {};
  for (const [name, s] of Object.entries(p.sockets)) sockets[name] = { position: [...s.position] as SocketOffset['position'], rotation: [...s.rotation] as SocketOffset['rotation'], scale: s.scale };
  return {
    version: PROFILE_VERSION,
    familyKey: p.familyKey,
    instanceKey: p.instanceKey,
    displayName: p.displayName,
    updatedAt: p.updatedAt,
    mapOverrides: { ...p.mapOverrides },
    swapSides: p.swapSides,
    bones,
    sockets,
    calibration: (p.calibration ?? null) as PoseCalibration | null,
  };
}

export function exportProfileJson(profile: RigProfile): string {
  const errors = validateProfile(profile);
  if (errors.length) throw new Error(`Refusing to export an invalid profile: ${errors.join('; ')}`);
  return JSON.stringify({ format: 'cameracharacter-rig-profile', ...normalizeProfile(profile) }, null, 2);
}

/** Parses and validates a profile; throws with a readable message on failure. */
export function importProfileJson(text: string): RigProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Profile JSON could not be parsed: ${(e as Error).message}`);
  }
  if (isRecord(parsed) && 'format' in parsed) {
    if (parsed.format !== 'cameracharacter-rig-profile') throw new Error(`Not a rig profile (format '${String(parsed.format)}').`);
    const { format: _format, ...rest } = parsed;
    parsed = rest;
  }
  const errors = validateProfile(parsed);
  if (errors.length) throw new Error(`Invalid rig profile: ${errors.join('; ')}`);
  return normalizeProfile(parsed as RigProfile);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** The subset of the Web Storage API the store needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage (Node, private browsing). */
export class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

/** `localStorage` when it exists and is writable, else null. */
export function localStorageAdapter(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!ls || typeof ls.getItem !== 'function') return null;
    const probe = '__cameracharacter_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

export class ProfileStore {
  private storage: StorageLike;
  private readonly prefix: string;
  constructor(storage?: StorageLike | null, prefix = 'cameracharacter.profile.') {
    this.storage = storage ?? localStorageAdapter() ?? new MemoryStorage();
    this.prefix = prefix;
  }

  private key(instanceKey: string): string {
    return this.prefix + instanceKey;
  }
  private get indexKey(): string {
    return this.prefix + '__index__';
  }
  private readIndex(): string[] {
    try {
      const raw = this.storage.getItem(this.indexKey);
      if (!raw) return [];
      const arr = JSON.parse(raw) as unknown;
      return Array.isArray(arr) ? arr.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }
  private writeIndex(keys: string[]): void {
    this.storage.setItem(this.indexKey, JSON.stringify(keys));
  }
  private read(instanceKey: string): RigProfile | null {
    try {
      const raw = this.storage.getItem(this.key(instanceKey));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return isRigProfile(parsed) ? normalizeProfile(parsed) : null;
    } catch {
      return null;
    }
  }

  /**
   * The profile stored for `instanceKey`, else a family-level fallback: the
   * most recently saved profile of the same `familyKey`, reduced to its map
   * overrides, swapped sides and bone settings (calibration and sockets are
   * instance-specific).
   */
  load(instanceKey: string, familyKey: string): RigProfile | null {
    const exact = this.read(instanceKey);
    if (exact) return exact;
    const family = this.list().find((p) => p.familyKey === familyKey);
    if (!family) return null;
    return {
      version: PROFILE_VERSION,
      familyKey,
      instanceKey,
      displayName: '',
      updatedAt: family.updatedAt,
      mapOverrides: { ...family.mapOverrides },
      swapSides: family.swapSides,
      bones: { ...family.bones },
      sockets: {},
      calibration: null,
    };
  }

  save(profile: RigProfile): void {
    const errors = validateProfile(profile);
    if (errors.length) throw new Error(`Refusing to save an invalid profile: ${errors.join('; ')}`);
    const rec = normalizeProfile(profile);
    this.storage.setItem(this.key(rec.instanceKey), JSON.stringify(rec));
    const idx = this.readIndex();
    if (!idx.includes(rec.instanceKey)) this.writeIndex([...idx, rec.instanceKey]);
  }

  remove(instanceKey: string): void {
    this.storage.removeItem(this.key(instanceKey));
    this.writeIndex(this.readIndex().filter((k) => k !== instanceKey));
  }

  /** Every stored profile, most recently updated first. */
  list(): RigProfile[] {
    const out: RigProfile[] = [];
    for (const k of this.readIndex()) {
      const p = this.read(k);
      if (p) out.push(p);
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return out;
  }

  clear(): void {
    for (const k of this.readIndex()) this.storage.removeItem(this.key(k));
    this.storage.removeItem(this.indexKey);
  }
}
