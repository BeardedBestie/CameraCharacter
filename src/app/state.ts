/**
 * Application settings store: AppSettings with change notifications, local
 * persistence, and URL parameter overrides for automation and demos.
 */
import { DEFAULT_SETTINGS, type AppSettings, type CameraMode, type HipsMode, type PoseModelVariant } from '../core/types';

const STORAGE_KEY = 'cameracharacter.settings.v2';

type Listener = (settings: AppSettings) => void;

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(cur, v);
    } else if (v !== undefined && (cur === undefined || typeof cur === typeof v)) {
      out[k] = v;
    }
  }
  return out as T;
}

export class SettingsStore {
  private settings: AppSettings;
  private listeners = new Set<Listener>();

  constructor(initial?: Partial<AppSettings>) {
    this.settings = deepMerge(structuredClone(DEFAULT_SETTINGS), initial ?? {});
  }

  static load(): SettingsStore {
    let stored: unknown = null;
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    return new SettingsStore(stored as Partial<AppSettings>);
  }

  get(): AppSettings {
    return this.settings;
  }

  /** Deep-merge a patch and notify listeners. */
  update(patch: DeepPartial<AppSettings>): void {
    this.settings = deepMerge(this.settings, patch);
    this.persist();
    for (const l of this.listeners) l(this.settings);
  }

  reset(): void {
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.persist();
    for (const l of this.listeners) l(this.settings);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // storage unavailable (private mode, quota): settings stay in memory
    }
  }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type SourceKind = 'camera' | 'recording' | 'synthetic' | 'websocket';

export interface UrlOptions {
  source?: SourceKind;
  /** Recording URL (source=recording). */
  file?: string;
  /** Synthetic preset name (source=synthetic). */
  preset?: string;
  /** WebSocket URL (source=websocket). */
  ws?: string;
  /** Model URL to load. */
  model?: string;
  autoplay: boolean;
  diagnostics?: boolean;
  camera?: CameraMode;
  hips?: HipsMode;
  mirror?: boolean;
  poseModel?: PoseModelVariant;
  /** Hide the panel on start (kiosk/installation mode). */
  kiosk: boolean;
  /** Playback speed for recordings. */
  speed?: number;
  loop?: boolean;
}

export function parseUrlOptions(search: string = globalThis.location?.search ?? ''): UrlOptions {
  const p = new URLSearchParams(search);
  const bool = (k: string): boolean | undefined => {
    if (!p.has(k)) return undefined;
    const v = p.get(k)!.toLowerCase();
    return v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on';
  };
  const oneOf = <T extends string>(k: string, values: readonly T[]): T | undefined => {
    const v = p.get(k) as T | null;
    return v && values.includes(v) ? v : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = p.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    source: oneOf('source', ['camera', 'recording', 'synthetic', 'websocket'] as const),
    file: p.get('file') ?? undefined,
    preset: p.get('preset') ?? undefined,
    ws: p.get('ws') ?? undefined,
    model: p.get('model') ?? undefined,
    autoplay: bool('autoplay') ?? false,
    diagnostics: bool('diagnostics'),
    camera: oneOf('camera', ['mirror', 'follow', 'orbit'] as const),
    hips: oneOf('hips', ['locked', 'horizontal', 'full'] as const),
    mirror: bool('mirror'),
    poseModel: oneOf('poseModel', ['lite', 'full', 'heavy'] as const),
    kiosk: bool('kiosk') ?? false,
    speed: num('speed'),
    loop: bool('loop'),
  };
}

/** Applies URL overrides to the settings store (without persisting them as user choices). */
export function settingsPatchFromUrl(url: UrlOptions): DeepPartial<AppSettings> {
  const patch: DeepPartial<AppSettings> = {};
  if (url.diagnostics !== undefined) patch.diagnostics = url.diagnostics;
  const stage: DeepPartial<AppSettings['stage']> = {};
  if (url.camera) stage.cameraMode = url.camera;
  if (url.hips) stage.hipsMode = url.hips;
  if (url.mirror !== undefined) stage.mirror = url.mirror;
  if (Object.keys(stage).length) patch.stage = stage;
  if (url.poseModel) patch.tracking = { poseModel: url.poseModel };
  return patch;
}

/** Bundled sample models (served from the repository's models/ folder via Vite public copy or the dev server). */
export interface SampleModel {
  id: string;
  label: string;
  url: string;
  family: string;
}

export const SAMPLE_MODELS: SampleModel[] = [
  { id: 'sample-meshy', label: 'Meshy sample (bundled)', url: '/models/sample-meshy.glb', family: 'meshy' },
  { id: 'clerk', label: 'Clerk (sample pack)', url: '/models/characters/clerk.glb', family: 'game-parts' },
  { id: 'npc_office', label: 'Office NPC (sample pack)', url: '/models/characters/npc_office.glb', family: 'game-parts' },
  { id: 'npc_punk', label: 'Punk NPC (sample pack)', url: '/models/characters/npc_punk.glb', family: 'game-parts' },
  { id: 'ninja_parts', label: 'Ninja (sample pack)', url: '/models/characters/ninja_parts.glb', family: 'game-parts' },
  { id: 'zombie_new', label: 'Zombie (sample pack)', url: '/models/characters/zombie_new.glb', family: 'game-parts' },
  { id: 'skeleton', label: 'Skeleton (sample pack, scrambled names)', url: '/models/characters/skeleton.glb', family: 'game-parts' },
  { id: 'orc_parts', label: 'Orc (sample pack)', url: '/models/characters/orc_parts.glb', family: 'game-parts' },
];
