/**
 * Contract between the control panels (pure UI) and the App (orchestration).
 * Panels call actions and receive view models; they never touch the pipeline.
 */
import type { BoneRefMode, CameraMode, FramingState, HumanoidBone } from '../core/types';

export type SourceKind = 'camera' | 'recording' | 'synthetic' | 'websocket';

export interface SourceStatusVM {
  state: 'idle' | 'starting' | 'running' | 'error' | 'stopped';
  message?: string;
  fps?: number;
  inferenceMs?: number;
}

export interface PlaybackVM {
  playing: boolean;
  timeMs: number;
  durationMs: number;
  speed: number;
  loop: boolean;
}

export interface SourceVM {
  kind: SourceKind;
  status: SourceStatusVM;
  cameras: { deviceId: string; label: string }[];
  cameraId: string | null;
  presets: string[];
  preset: string;
  wsUrl: string;
  recordingName: string | null;
  playback: PlaybackVM | null;
  delegate: 'GPU' | 'CPU' | null;
}

export interface MappingRow {
  role: HumanoidBone;
  bone: string | null;
  confidence: number;
  mode: BoneRefMode;
  rollOffsetDeg: number;
  anatomical: boolean | null;
  errorDeg: number | null;
  overridden: boolean;
}

export interface ModelVM {
  name: string | null;
  loading: boolean;
  progress: number | null;
  family: string | null;
  familyKey: string | null;
  warnings: string[];
  rows: MappingRow[];
  boneNames: string[];
  unrigged: boolean;
  sourceHeight: number | null;
  scale: number | null;
  environmentName: string | null;
}

export interface CalibrationVM {
  hasCalibration: boolean;
  calibratedAt: string | null;
  baselineReady: boolean;
  capturing: boolean;
  countdown: number | null;
  snapshotBusy: boolean;
}

export interface RecorderVM {
  active: boolean;
  frames: number;
  seconds: number;
}

export interface RecordingVM {
  take: RecorderVM;
  clip: RecorderVM;
  video: RecorderVM & { mime: string | null };
  hasTake: boolean;
  hasClip: boolean;
  fps: number;
  includeEnvironment: boolean;
  pip: boolean;
  microphone: boolean;
}

export interface StatusVM {
  present: boolean;
  framing: FramingState;
  renderFps: number;
  inferenceFps: number;
  inferenceMs: number;
  parts: { name: string; confidence: number }[];
  errors: { role: HumanoidBone; errorDeg: number | null; flagged: boolean }[];
  chainErrors: { name: string; errorDeg: number | null }[];
  depthZ: number | null;
  hands: { left: boolean; right: boolean };
  face: boolean;
}

export interface AppActions {
  setSource(kind: SourceKind): Promise<void>;
  selectCamera(deviceId: string): Promise<void>;
  refreshCameras(): Promise<void>;
  setSyntheticPreset(name: string): Promise<void>;
  setWebSocketUrl(url: string): Promise<void>;
  loadRecordingFile(file: File): Promise<void>;
  loadRecordingUrl(url: string): Promise<void>;
  playback: {
    play(): void;
    pause(): void;
    seek(ms: number): void;
    setSpeed(x: number): void;
    setLoop(v: boolean): void;
  };
  loadModelFile(file: File): Promise<void>;
  loadModelUrl(url: string, label?: string): Promise<void>;
  setMappingOverride(role: HumanoidBone, boneName: string | null): void;
  swapSides(): void;
  resetMapping(): void;
  setBoneMode(role: HumanoidBone, mode: BoneRefMode): void;
  setBoneRoll(role: HumanoidBone, deg: number): void;
  resetBoneSettings(): void;
  exportProfile(): void;
  importProfile(file: File): Promise<void>;
  loadEnvironmentFile(file: File): Promise<void>;
  clearEnvironment(): void;
  startPoseCalibration(): Promise<void>;
  clearPoseCalibration(): void;
  resetBaseline(): void;
  takeSnapshot(): Promise<void>;
  toggleRecording(kind: 'take' | 'clip' | 'video'): Promise<void>;
  setRecordingOption(key: 'fps' | 'includeEnvironment' | 'pip' | 'microphone', value: number | boolean): void;
  exportTake(): void;
  exportClipGlb(): Promise<void>;
  exportBvh(): void;
  resetSettings(): void;
  togglePanel(): void;
}

export interface Panel<VM> {
  root: HTMLElement;
  update(vm: VM): void;
}

/** Snapshot of the app state exposed on window.cameraCharacter.getDebugState() for tests and consoles. */
export interface AppDebugState {
  ready: boolean;
  source: { kind: SourceKind; state: string; message?: string };
  model: { name: string | null; family: string | null; bones: number; warnings: string[]; unrigged: boolean } | null;
  framesProcessed: number;
  framesSolved: number;
  present: boolean;
  framing: FramingState;
  /** Max per-bone error (degrees) over the last solved frame, among confident bones. */
  maxBoneErrorDeg: number | null;
  meanBoneErrorDeg: number | null;
  flaggedBones: HumanoidBone[];
  cameraDistance: number | null;
  cameraMode: CameraMode | null;
  errors: string[];
}
