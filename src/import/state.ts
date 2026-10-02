/**
 * Import page settings: URL options for automation and the small set of
 * import-specific options persisted next to the shared AppSettings.
 */
import type { AppSettings, HipsMode, PoseModelVariant } from '../core/types';
import type { DeepPartial } from '../app/state';
import { DEFAULT_SAMPLE_FPS } from './frameStepper';

export const IMPORT_SETTINGS_KEY = 'cameracharacter.import.settings.v1';
export const IMPORT_OPTIONS_KEY = 'cameracharacter.import.options.v1';

export type ImportCameraMode = 'orbit' | 'follow' | 'track';

/** Defaults that differ from the live app: actor mode, a free camera, no translation. */
export const IMPORT_SETTINGS_DEFAULTS: DeepPartial<AppSettings> = {
  stage: { mirror: false, cameraMode: 'orbit', hipsMode: 'locked', showLandmarkSkeleton: false },
  tracking: { poseModel: 'heavy', hands: false, face: false },
};

export interface ImportOptions {
  /** Samples per second of media time analysed per clip. */
  sampleFps: number;
  cameraMode: ImportCameraMode;
  /** Show the source video picture-in-picture. */
  pip: boolean;
  /** Play the clip's audio during playback. */
  audio: boolean;
  /** Include the clip's soundtrack when rendering a video. */
  renderAudio: boolean;
  /** Include the picture-in-picture when rendering a video. */
  renderPip: boolean;
  /** Clip sample rate for baked animation / GLB / BVH. */
  bakeFps: number;
  includeEnvironment: boolean;
  /** Vertical FOV of the free camera (orbit and keyframe modes), degrees. */
  fov: number;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  sampleFps: DEFAULT_SAMPLE_FPS,
  cameraMode: 'orbit',
  pip: true,
  audio: false,
  renderAudio: true,
  renderPip: false,
  bakeFps: 30,
  includeEnvironment: false,
  fov: 35,
};

export function loadImportOptions(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): ImportOptions {
  const out: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS };
  if (!storage) return out;
  try {
    const raw = storage.getItem(IMPORT_OPTIONS_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Partial<Record<keyof ImportOptions, unknown>>;
    for (const key of Object.keys(DEFAULT_IMPORT_OPTIONS) as (keyof ImportOptions)[]) {
      const v = parsed[key];
      if (v !== undefined && typeof v === typeof DEFAULT_IMPORT_OPTIONS[key]) (out as unknown as Record<string, unknown>)[key] = v;
    }
    if (!['orbit', 'follow', 'track'].includes(out.cameraMode)) out.cameraMode = 'orbit';
    if (!(out.sampleFps > 0)) out.sampleFps = DEFAULT_SAMPLE_FPS;
    if (!(out.bakeFps > 0)) out.bakeFps = 30;
    if (!(out.fov >= 5 && out.fov <= 150)) out.fov = 35;
  } catch {
    // corrupt storage: defaults
  }
  return out;
}

export function saveImportOptions(opts: ImportOptions, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage ?? null): void {
  if (!storage) return;
  try {
    storage.setItem(IMPORT_OPTIONS_KEY, JSON.stringify(opts));
  } catch {
    // quota / private mode
  }
}

export interface ImportUrlOptions {
  /** Model URL to load (default: the bundled sample). */
  model?: string;
  /** A `.mocap.json` take to load as a clip. */
  take?: string;
  /** A video URL to import on start. */
  video?: string;
  /** Sampling rate for the video import. */
  fps?: number;
  poseModel?: PoseModelVariant;
  delegate?: 'GPU' | 'CPU';
  hands?: boolean;
  face?: boolean;
  camera?: ImportCameraMode;
  hips?: HipsMode;
  mirror?: boolean;
  diagnostics?: boolean;
  autoplay: boolean;
  loop?: boolean;
  kiosk: boolean;
}

export function parseImportUrl(search: string = globalThis.location?.search ?? ''): ImportUrlOptions {
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
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    model: p.get('model') ?? undefined,
    take: p.get('take') ?? undefined,
    video: p.get('video') ?? undefined,
    fps: num('fps'),
    poseModel: oneOf('poseModel', ['lite', 'full', 'heavy'] as const),
    delegate: oneOf('delegate', ['GPU', 'CPU'] as const),
    hands: bool('hands'),
    face: bool('face'),
    camera: oneOf('camera', ['orbit', 'follow', 'track'] as const),
    hips: oneOf('hips', ['locked', 'horizontal', 'full'] as const),
    mirror: bool('mirror'),
    diagnostics: bool('diagnostics'),
    autoplay: bool('autoplay') ?? true,
    loop: bool('loop'),
    kiosk: bool('kiosk') ?? false,
  };
}

/** Settings patch from the URL (not persisted as user choices). */
export function importSettingsPatchFromUrl(url: ImportUrlOptions): DeepPartial<AppSettings> {
  const patch: DeepPartial<AppSettings> = {};
  const stage: DeepPartial<AppSettings['stage']> = {};
  if (url.hips) stage.hipsMode = url.hips;
  if (url.mirror !== undefined) stage.mirror = url.mirror;
  if (Object.keys(stage).length) patch.stage = stage;
  const tracking: DeepPartial<AppSettings['tracking']> = {};
  if (url.poseModel) tracking.poseModel = url.poseModel;
  if (url.delegate) tracking.delegate = url.delegate;
  if (url.hands !== undefined) tracking.hands = url.hands;
  if (url.face !== undefined) tracking.face = url.face;
  if (Object.keys(tracking).length) patch.tracking = tracking;
  if (url.diagnostics !== undefined) patch.diagnostics = url.diagnostics;
  return patch;
}
