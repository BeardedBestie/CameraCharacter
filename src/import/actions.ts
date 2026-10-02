/**
 * Contract between the import page's panels (pure UI) and ImportApp
 * (orchestration), mirroring src/app/actions.ts for the live app.
 */
import type { ModelActions, SettingsActions } from '../app/actions';
import type { FramingState } from '../core/types';
import type { CameraEase } from './CameraTrack';
import type { ShotName } from './cameraShots';
import type { ImportCameraMode } from './state';
import type { ExtractPhase } from './VideoPoseExtractor';

export interface ClipVM {
  id: string;
  name: string;
  durationMs: number;
  frames: number;
  detectedFrames: number;
  sampleFps: number;
  width: number;
  height: number;
  thumbnail?: string;
  hasVideo: boolean;
  active: boolean;
}

export interface ProcessingVM {
  name: string;
  phase: ExtractPhase;
  message: string;
  frame: number;
  total: number;
  detected: number;
  etaMs: number | null;
  /** Clips still waiting behind this one. */
  queued: number;
}

export interface ClipsVM {
  clips: ClipVM[];
  processing: ProcessingVM | null;
  sampleFps: number;
  storeKind: 'indexeddb' | 'memory' | 'none';
}

export interface ClipActions {
  importFiles(files: File[]): Promise<void>;
  importVideoUrl(url: string, name?: string): Promise<void>;
  selectClip(id: string): Promise<void>;
  deleteClip(id: string): Promise<void>;
  renameClip(id: string, name: string): Promise<void>;
  cancelImport(): void;
  setSampleFps(fps: number): void;
}

export interface CameraKeyVM {
  t: number;
  ease: CameraEase;
  /** The key nearest to the playhead. */
  active: boolean;
}

export interface CameraVM {
  mode: ImportCameraMode;
  fov: number;
  keys: CameraKeyVM[];
  timeSec: number;
  durationSec: number;
  hasModel: boolean;
}

export interface CameraActions {
  setCameraMode(mode: ImportCameraMode): void;
  setFov(deg: number): void;
  applyShot(name: ShotName): void;
  addCameraKey(): void;
  removeCameraKey(index: number): void;
  jumpToCameraKey(index: number): void;
  setCameraKeyEase(index: number, ease: CameraEase): void;
  clearCameraKeys(): void;
  addOrbitShot(opts: { turns: number }): void;
  exportCameraTrack(): void;
  importCameraTrackFile(file: File): Promise<void>;
}

export interface ExportVM {
  hasClip: boolean;
  hasModel: boolean;
  hasVideo: boolean;
  hasEnvironment: boolean;
  baking: { done: number; total: number } | null;
  hasTake: boolean;
  takeStale: boolean;
  rendering: { seconds: number } | null;
  bakeFps: number;
  includeEnvironment: boolean;
  renderAudio: boolean;
  renderPip: boolean;
}

export type ExportOptionKey = 'bakeFps' | 'includeEnvironment' | 'renderAudio' | 'renderPip';

export interface ExportActions {
  bake(): Promise<void>;
  exportGlb(): Promise<void>;
  exportBvh(): Promise<void>;
  exportTake(): void;
  renderVideo(): Promise<void>;
  cancelRender(): Promise<void>;
  setExportOption(key: ExportOptionKey, value: number | boolean): void;
}

export interface ImportActions extends ClipActions, CameraActions, ExportActions, ModelActions, SettingsActions {
  setPipVisible(v: boolean): void;
  setAudio(v: boolean): void;
}

/** Snapshot exposed on window.cameraCharacterImport.getDebugState() for tests and consoles. */
export interface ImportDebugState {
  ready: boolean;
  storeKind: 'indexeddb' | 'memory' | 'none';
  clips: { id: string; name: string; frames: number; detectedFrames: number; hasVideo: boolean }[];
  activeClip: string | null;
  processing: { name: string; phase: ExtractPhase; frame: number; total: number; detected: number } | null;
  playback: { playing: boolean; timeMs: number; durationMs: number; loop: boolean } | null;
  model: { name: string | null; family: string | null; bones: number; warnings: string[]; unrigged: boolean } | null;
  framesProcessed: number;
  framesSolved: number;
  present: boolean;
  framing: FramingState;
  maxBoneErrorDeg: number | null;
  meanBoneErrorDeg: number | null;
  cameraMode: ImportCameraMode;
  cameraKeys: number;
  cameraPosition: [number, number, number];
  baking: boolean;
  hasTake: boolean;
  rendering: boolean;
  errors: string[];
}
