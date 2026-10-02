/**
 * Import page orchestration (docs/DESIGN.md §17): video clips → offline pose
 * extraction → takes stored in the browser → the same filter / body model /
 * retargeter pipeline as the live app, played in lock-step with the source
 * video, with a free camera, camera keyframes, baking and exports.
 */
import { Vector3 } from 'three';
import packageJson from '../../package.json';
import type { ModelVM, Panel, StatusVM } from '../app/actions';
import { installDropZone, installShortcuts } from '../app/layout';
import { ModelSession } from '../app/ModelSession';
import { createModelPanel } from '../app/panels/ModelPanel';
import { createSmoothingPanel } from '../app/panels/SmoothingPanel';
import { createStatusPanel } from '../app/panels/StatusPanel';
import { PART_GROUPS } from '../app/partGroups';
import { SAMPLE_MODELS, SettingsStore } from '../app/state';
import { Toasts } from '../app/ui';
import type { FilteredPose } from '../core/pose';
import type { AppSettings, BoneRefMode, FramingFit, HumanoidBone, MocapRecording, PoseFrame, Take } from '../core/types';
import { ErrorStats, LandmarkSkeleton3D, Overlay2D, summarize, type BoneErrorSummary } from '../diagnostics';
import {
  VideoRecorder,
  downloadArrayBuffer,
  downloadBlob,
  downloadText,
  exportGlbWithTake,
  serializeRecording,
  takeToAnimationClip,
  takeToBvh,
  timestampedFilename,
} from '../record';
import { BodyModel, type BodyModelResult } from '../retarget/bodyModel';
import { StandingBaseline } from '../retarget/calibration';
import { fitFraming } from '../retarget/framing';
import type { SolveResult } from '../retarget/solver';
import { ProfileStore } from '../rig';
import { Stage, loadEnvironment } from '../stage';
import { PoseFilter } from '../tracking/PoseFilter';
import type { SourceStatus } from '../tracking/PoseSource';
import { RecordingSource } from '../tracking/RecordingSource';
import { parseMocapRecording } from '../tracking/protocol';
import type { CameraVM, ClipsVM, ExportOptionKey, ExportVM, ImportActions, ImportDebugState, ProcessingVM } from './actions';
import { bakeRecordingAsync } from './bake';
import { CAMERA_TRACK_FORMAT, CameraTrack, type CameraEase, type CameraPose } from './CameraTrack';
import { shotFor, type ShotName } from './cameraShots';
import { newClipId, openClipStore, statsOf, type ClipStats, type ClipStore, type ClipSummary, type StoredClip } from './clipStore';
import { buildImportLayout, renderMarkers, type ImportLayout } from './layout';
import { createCameraPanel } from './panels/CameraPanel';
import { createClipsPanel } from './panels/ClipsPanel';
import { createExportPanel } from './panels/ExportPanel';
import { createImportStagePanel } from './panels/ImportStagePanel';
import {
  IMPORT_SETTINGS_DEFAULTS,
  IMPORT_SETTINGS_KEY,
  importSettingsPatchFromUrl,
  loadImportOptions,
  parseImportUrl,
  saveImportOptions,
  type ImportCameraMode,
  type ImportOptions,
  type ImportUrlOptions,
} from './state';
import { transportFor, type Transport } from './transport';
import { captureThumbnail, disposeVideo, extractPoseFromVideo, isVideoFile, loadVideoElement, seekTo, type LoadedVideo } from './VideoPoseExtractor';
import { VideoTakeSource } from './VideoTakeSource';
import '../app/styles.css';
import './styles.css';

const PANEL_REFRESH_MS = 100;
/** Settle time before a video render starts, so the first frames are not the bind pose easing in. */
const RENDER_SETTLE_MS = 700;

interface ClipEntry {
  id: string;
  name: string;
  createdAt: string;
  recording: MocapRecording;
  stats: ClipStats;
  thumbnail?: string;
  video: LoadedVideo | null;
  videoBlob: Blob | null;
  videoType?: string;
  track: CameraTrack;
}

interface QueuedImport {
  source: Blob | string;
  name: string;
}

interface RenderJob {
  recorder: VideoRecorder;
  startedAt: number;
  restoreLoop: boolean;
  stopping: boolean;
}

function sanitize(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'clip';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export class ImportApp implements ImportActions {
  readonly store: SettingsStore;
  readonly url: ImportUrlOptions;
  options: ImportOptions;
  private layout!: ImportLayout;
  private toasts!: Toasts;
  private stage: Stage | null = null;
  private clipStore: ClipStore | null = null;

  private readonly filter: PoseFilter;
  private readonly bodyModel: BodyModel;
  private readonly baseline: StandingBaseline;
  private readonly profileStore = new ProfileStore(typeof localStorage !== 'undefined' ? localStorage : null);
  private model: ModelSession | null = null;
  private modelLoading: { name: string; progress: number | null } | null = null;
  private environment: { name: string; root: import('three').Object3D } | null = null;

  /** Library summaries (from the store) and fully loaded clips. */
  private summaries = new Map<string, ClipSummary>();
  private entries = new Map<string, ClipEntry>();
  private active: ClipEntry | null = null;
  private source: VideoTakeSource | RecordingSource | null = null;
  private transport: Transport | null = null;
  private unsubscribe: (() => void)[] = [];
  private lastSourceStatus: SourceStatus = { state: 'idle' };
  private activation = 0;

  private queue: QueuedImport[] = [];
  private processing: ProcessingVM | null = null;
  private abort: AbortController | null = null;

  private latestFrame: PoseFrame | null = null;
  private frameDirty = false;
  private pose: FilteredPose | null = null;
  private body: BodyModelResult | null = null;
  private framing: FramingFit | null = null;
  private solve: SolveResult | null = null;
  private summary: BoneErrorSummary | null = null;
  private errorStats = new ErrorStats(60);
  private framesProcessed = 0;
  private framesSolved = 0;
  private lastLoopTime = 0;
  private renderFps = 0;
  private rafHandle = 0;
  private lastPanelRefresh = 0;
  private errors: string[] = [];
  private scrubbing = false;

  private overlay: Overlay2D | null = null;
  private skeleton3D: LandmarkSkeleton3D | null = null;

  /** Camera track of the active clip (an empty track when none). */
  private track = new CameraTrack();
  private readonly cameraPose: CameraPose = { position: new Vector3(), target: new Vector3(), fov: 35 };
  private markersDirty = true;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private baking: { done: number; total: number } | null = null;
  private bakeAbort: AbortController | null = null;
  private lastTake: Take | null = null;
  private lastTakeKey = '';
  private renderJob: RenderJob | null = null;

  private panels!: {
    clips: ReturnType<typeof createClipsPanel>;
    model: Panel<ModelVM>;
    camera: Panel<CameraVM>;
    stage: ReturnType<typeof createImportStagePanel>;
    export: Panel<ExportVM>;
    status: Panel<StatusVM>;
    smoothing: ReturnType<typeof createSmoothingPanel>;
  };

  constructor(private readonly root: HTMLElement) {
    this.store = SettingsStore.load(IMPORT_SETTINGS_KEY, IMPORT_SETTINGS_DEFAULTS);
    this.url = parseImportUrl();
    this.store.update(importSettingsPatchFromUrl(this.url));
    this.options = loadImportOptions();
    if (this.url.camera) this.options.cameraMode = this.url.camera;
    if (this.url.fps) this.options.sampleFps = this.url.fps;
    const s = this.store.get();
    this.filter = new PoseFilter(s.smoothing, s.stage.mirror);
    this.bodyModel = new BodyModel(s.smoothing);
    this.baseline = new StandingBaseline(s.smoothing);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.layout = buildImportLayout(
      this.root,
      { version: packageJson.version },
      {
        onPlayToggle: () => this.transport?.toggle(),
        onScrubStart: () => (this.scrubbing = true),
        onScrubEnd: () => (this.scrubbing = false),
        onScrub: (f) => this.transport?.seek(f * (this.transport?.durationMs ?? 0)),
        onLoop: (v) => this.transport?.setLoop(v),
        onSpeed: (x) => this.transport?.setSpeed(x),
        onPrevKey: () => this.jumpToNeighbourKey(-1),
        onNextKey: () => this.jumpToNeighbourKey(1),
        onAddKey: () => this.addCameraKey(),
        onStep: (frames) => this.stepFrames(frames),
      },
    );
    this.toasts = new Toasts(this.root);
    const settings = this.store.get();

    try {
      this.stage = new Stage(this.layout.viewport, { ...settings.stage, cameraMode: 'orbit' });
    } catch (err) {
      this.fail(`WebGL is not available: ${(err as Error).message}`);
      return;
    }
    this.stage.camera.fov = this.options.fov;
    this.stage.camera.updateProjectionMatrix();
    this.stage.onBeforeRender = () => this.applyTrackCamera();
    this.skeleton3D = new LandmarkSkeleton3D();
    this.skeleton3D.visible = settings.stage.showLandmarkSkeleton;
    this.stage.scene.add(this.skeleton3D.object);
    this.overlay = new Overlay2D(this.layout.overlay);
    this.layout.setPipVisible(this.options.pip);

    this.buildPanels();
    installDropZone(this.root, this.layout.dropOverlay, (files) => void this.importFiles(files));
    installShortcuts({
      Tab: () => this.togglePanel(),
      ' ': () => this.transport?.toggle(),
      k: () => this.addCameraKey(),
      '[': () => this.jumpToNeighbourKey(-1),
      ']': () => this.jumpToNeighbourKey(1),
      ArrowLeft: () => this.stepFrames(-1),
      ArrowRight: () => this.stepFrames(1),
      Home: () => this.transport?.seek(0),
      End: () => this.transport?.seek(this.transport.durationMs),
      c: () => {
        const order: ImportCameraMode[] = ['orbit', 'follow', 'track'];
        this.setCameraMode(order[(order.indexOf(this.options.cameraMode) + 1) % order.length]);
      },
      m: () => this.store.update({ stage: { mirror: !this.store.get().stage.mirror } }),
      d: () => this.store.update({ diagnostics: !this.store.get().diagnostics }),
      b: () => void this.bake(),
    });
    this.store.subscribe((s) => this.applySettings(s));
    this.applyCameraMode();
    if (this.url.kiosk) this.layout.setPanelCollapsed(true);

    this.lastLoopTime = performance.now();
    this.rafHandle = requestAnimationFrame((t) => this.loop(t));

    const modelUrl = this.url.model ?? SAMPLE_MODELS[0].url;
    void this.loadModelUrl(modelUrl, this.url.model ? undefined : SAMPLE_MODELS[0].label);

    try {
      this.clipStore = await openClipStore();
      for (const summary of await this.clipStore.list()) this.summaries.set(summary.id, summary);
    } catch (err) {
      this.reportError(`Clip library unavailable: ${(err as Error).message ?? err}`);
    }

    if (this.url.take) await this.loadTakeUrl(this.url.take);
    else if (this.url.video) await this.importVideoUrl(this.url.video);
    else if (this.summaries.size) {
      const latest = Array.from(this.summaries.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      await this.selectClip(latest.id);
    }
  }

  private buildPanels(): void {
    this.panels = {
      clips: createClipsPanel(this.store, this),
      model: createModelPanel(this.store, this),
      camera: createCameraPanel(this),
      export: createExportPanel(this),
      stage: createImportStagePanel(this.store, this, { pip: this.options.pip, audio: this.options.audio }),
      status: createStatusPanel(this.store),
      smoothing: createSmoothingPanel(this.store, this),
    };
    this.layout.panelBody.append(
      this.panels.clips.root,
      this.panels.model.root,
      this.panels.camera.root,
      this.panels.export.root,
      this.panels.stage.root,
      this.panels.status.root,
      this.panels.smoothing.root,
    );
  }

  private applySettings(s: AppSettings): void {
    this.filter.setSettings(s.smoothing);
    this.filter.setMirror(s.stage.mirror);
    this.bodyModel.setSettings(s.smoothing);
    this.baseline.setSettings(s.smoothing);
    const video = this.active?.video?.video ?? null;
    if (video) video.classList.toggle('mirrored', s.stage.mirror);
    this.stage?.applySettings({ ...s.stage, cameraMode: this.options.cameraMode === 'follow' ? 'follow' : 'orbit' });
    this.applyCameraMode();
    if (this.skeleton3D) this.skeleton3D.visible = s.stage.showLandmarkSkeleton;
    this.model?.updateOptions({
      smoothing: s.smoothing,
      hipsMode: s.stage.hipsMode,
      cameraVfovDeg: s.tracking.cameraVfovDeg,
      depthTranslation: true,
    });
    if (this.model && Math.abs(this.model.analysis.scale * this.model.analysis.sourceHeight - s.stage.targetHeight) > 1e-3) {
      this.model.wrapper.scale.setScalar(s.stage.targetHeight / this.model.analysis.sourceHeight);
    }
  }

  private saveOptions(): void {
    saveImportOptions(this.options);
  }

  // ---------------------------------------------------------------------------
  // Per-frame pipeline
  // ---------------------------------------------------------------------------

  private onFrame(frame: PoseFrame): void {
    this.latestFrame = frame;
    this.frameDirty = true;
    this.framesProcessed++;
  }

  private loop(now: number): void {
    this.rafHandle = requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastLoopTime) / 1000));
    this.lastLoopTime = now;
    this.renderFps = this.renderFps * 0.9 + (1 / dt) * 0.1;
    const settings = this.store.get();

    try {
      if (!this.baking) {
        if (this.frameDirty && this.latestFrame) {
          this.frameDirty = false;
          this.pose = this.filter.process(this.latestFrame);
          this.framing = fitFraming(this.pose, this.framing, dt);
          const analysis = this.model?.analysis;
          this.body = this.bodyModel.update(this.pose, dt, {
            framing: this.framing.state,
            noKnee: analysis?.noKnee ?? { left: false, right: false },
            noElbow: analysis?.noElbow ?? { left: false, right: false },
            mirror: settings.stage.mirror,
          });
          this.baseline.update(this.body, this.pose, this.framing.state, dt, this.solve?.depthZ ?? null);
          if (this.baseline.isReady && this.model?.retargeter) this.model.retargeter.setTorsoBaseline(this.baseline.torsoBaseline);
          this.overlay?.draw({
            pose: this.pose,
            fit: this.framing,
            videoWidth: this.latestFrame.size[0],
            videoHeight: this.latestFrame.size[1],
            previewMirrored: settings.stage.mirror,
            showFit: settings.diagnostics,
          });
        }
        const retargeter = this.model?.retargeter ?? null;
        if (retargeter && this.pose && this.body && this.framing) {
          this.solve = retargeter.solve(this.body, this.pose, dt, this.framing);
          this.framesSolved++;
          if (settings.diagnostics) {
            this.summary = summarize(this.solve, this.model!.analysis);
            this.errorStats.push(this.summary);
          }
        }
      }

      if (this.stage) {
        const hipsWorld = this.solve?.hipsWorldPos ?? this.stage.modelOrigin;
        if (this.options.cameraMode === 'follow' && this.model && this.pose) {
          this.stage.setCameraInput({
            fit: this.framing,
            table: this.model.analysis.heightTable,
            hipsWorld,
            lateralOffset: hipsWorld.x - this.stage.modelOrigin.x,
            present: this.pose.present,
            absentFor: this.pose.absentFor,
            origin: this.stage.modelOrigin,
          });
        } else {
          this.stage.setCameraInput(null);
        }
        this.skeleton3D?.update(settings.stage.showLandmarkSkeleton ? this.pose : null, hipsWorld);
        this.stage.render(dt);
        this.renderJob?.recorder.drawFrame();
        this.checkRenderEnd();
      }
    } catch (err) {
      this.reportError(`Frame error: ${(err as Error).message ?? err}`);
      console.error(err);
    }

    if (now - this.lastPanelRefresh > PANEL_REFRESH_MS) {
      this.lastPanelRefresh = now;
      this.refreshPanels();
    }
  }

  /** Keyframe camera: evaluated at the playhead every frame when the mode is `track`. */
  private applyTrackCamera(): void {
    if (!this.stage || this.options.cameraMode !== 'track' || this.track.isEmpty) return;
    const t = this.transport ? this.transport.timeMs / 1000 : 0;
    const pose = this.track.evaluate(t, this.cameraPose);
    if (!pose) return;
    const cam = this.stage.camera;
    cam.position.copy(pose.position);
    cam.up.set(0, 1, 0);
    cam.lookAt(pose.target);
    if (Math.abs(cam.fov - pose.fov) > 1e-3) {
      cam.fov = pose.fov;
      cam.updateProjectionMatrix();
    }
  }

  private refreshPanels(): void {
    const s = this.store.get();
    this.panels.clips.update(this.clipsVM());
    this.panels.model.update(
      this.model
        ? this.model.viewModel(s.diagnostics ? this.solve : null, this.environment?.name ?? null, false)
        : {
            name: this.modelLoading?.name ?? null,
            loading: !!this.modelLoading,
            progress: this.modelLoading?.progress ?? null,
            family: null,
            familyKey: null,
            warnings: [],
            rows: [],
            boneNames: [],
            unrigged: false,
            sourceHeight: null,
            scale: null,
            environmentName: this.environment?.name ?? null,
          },
    );
    this.panels.camera.update(this.cameraVM());
    this.panels.export.update(this.exportVM());
    this.panels.stage.update({ pip: this.options.pip, audio: this.options.audio });
    this.panels.status.update(this.statusVM());
    this.refreshTransport();

    const c = this.layout.chips;
    const p = this.processing;
    c.clip.set(
      p ? `importing ${p.name}${p.total ? ` ${Math.round((100 * p.frame) / p.total)}%` : ''}` : this.active ? this.active.name : 'no clip',
      p ? 'warn' : this.active ? 'good' : 'off',
    );
    c.subject.set(this.pose?.present ? 'subject tracked' : 'no subject', this.pose?.present ? 'good' : 'off');
    c.model.set(
      this.model ? `${this.model.name}${this.model.unrigged ? ' (no rig)' : ''}` : this.modelLoading ? `loading ${this.modelLoading.name}` : 'no model',
      this.model && !this.model.unrigged ? 'good' : 'warn',
    );
    const mode = this.options.cameraMode;
    c.camera.set(`camera: ${mode === 'track' ? `keyframes (${this.track.length})` : mode}`, mode === 'track' && this.track.isEmpty ? 'warn' : 'off');
    c.fps.set(`${this.renderFps.toFixed(0)} fps`, 'off');
  }

  private refreshTransport(): void {
    const tb = this.layout.transport;
    const t = this.transport;
    tb.playBtn.textContent = t?.playing ? '❚❚' : '▶';
    tb.playBtn.disabled = !t;
    tb.stepBackBtn.disabled = !t;
    tb.stepFwdBtn.disabled = !t;
    tb.scrub.disabled = !t;
    tb.addKeyBtn.disabled = !this.stage;
    tb.prevKeyBtn.disabled = this.track.isEmpty;
    tb.nextKeyBtn.disabled = this.track.isEmpty;
    tb.clipLabel.textContent = this.active ? this.active.name : 'No clip';
    if (t) {
      const dur = t.durationMs;
      if (!this.scrubbing && dur > 0) tb.scrub.value = String(Math.round((t.timeMs / dur) * 1000));
      tb.timeLabel.textContent = `${fmtTime(t.timeMs)} / ${fmtTime(dur)}`;
      tb.loopToggle.set(t.loop);
      tb.speedSelect.set(String(t.speed));
    } else {
      tb.timeLabel.textContent = '0:00.0 / 0:00.0';
    }
    if (this.markersDirty) {
      this.markersDirty = false;
      const dur = (t?.durationMs ?? 0) / 1000;
      const fractions = this.track.keys.map((k) => (dur > 0 ? k.t / dur : 0));
      renderMarkers(tb.markers, fractions, -1, (i) => this.jumpToCameraKey(i));
    }
  }

  private clipsVM(): ClipsVM {
    const clips = Array.from(this.summaries.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((s) => {
        const e = this.entries.get(s.id);
        return {
          id: s.id,
          name: e?.name ?? s.name,
          durationMs: s.stats.durationMs,
          frames: s.stats.frames,
          detectedFrames: s.stats.detectedFrames,
          sampleFps: s.stats.sampleFps,
          width: s.stats.width,
          height: s.stats.height,
          thumbnail: e?.thumbnail ?? s.thumbnail,
          hasVideo: e ? !!e.video : s.hasVideo,
          active: this.active?.id === s.id,
        };
      });
    return {
      clips,
      processing: this.processing ? { ...this.processing, queued: this.queue.length } : null,
      sampleFps: this.options.sampleFps,
      storeKind: this.clipStore?.kind ?? 'none',
    };
  }

  private cameraVM(): CameraVM {
    const t = this.transport ? this.transport.timeMs / 1000 : 0;
    const nearest = this.track.nearest(t, 0.25);
    return {
      mode: this.options.cameraMode,
      fov: this.options.fov,
      keys: this.track.keys.map((k, i) => ({ t: k.t, ease: k.ease, active: i === nearest })),
      timeSec: t,
      durationSec: (this.transport?.durationMs ?? 0) / 1000,
      hasModel: !!this.model,
    };
  }

  private exportVM(): ExportVM {
    return {
      hasClip: !!this.active,
      hasModel: !!this.model?.retargeter,
      hasVideo: !!this.active?.video,
      hasEnvironment: !!this.environment,
      baking: this.baking,
      hasTake: !!this.lastTake,
      takeStale: !!this.lastTake && this.lastTakeKey !== this.takeKey(),
      rendering: this.renderJob ? { seconds: (performance.now() - this.renderJob.startedAt) / 1000 } : null,
      bakeFps: this.options.bakeFps,
      includeEnvironment: this.options.includeEnvironment,
      renderAudio: this.options.renderAudio,
      renderPip: this.options.renderPip,
    };
  }

  private statusVM(): StatusVM {
    const pose = this.pose;
    const parts = PART_GROUPS.map((g) => ({ name: g.name, confidence: pose ? Math.min(...g.indices.map((i) => pose.confidence[i] ?? 0)) : 0 }));
    const st = this.lastSourceStatus;
    return {
      present: !!pose?.present,
      framing: this.framing?.state ?? 'none',
      renderFps: this.renderFps,
      inferenceFps: st.fps ?? 0,
      inferenceMs: 0,
      parts,
      errors: this.summary ? this.summary.perBone.map((b) => ({ role: b.role, errorDeg: b.errorDeg, flagged: b.flagged })) : [],
      chainErrors: this.summary ? this.summary.chains.map((c) => ({ name: c.name, errorDeg: c.errorDeg })) : [],
      depthZ: this.solve?.depthZ ?? null,
      hands: { left: !!pose?.hands.left, right: !!pose?.hands.right },
      face: !!pose?.face,
    };
  }

  // ---------------------------------------------------------------------------
  // Clips: import, select, delete
  // ---------------------------------------------------------------------------

  async importFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const lower = file.name.toLowerCase();
      if (isVideoFile(file)) {
        this.queue.push({ source: file, name: file.name });
      } else if (/\.(glb|gltf|fbx|vrm)$/.test(lower)) {
        if (this.model && !this.model.unrigged && this.environment === null && lower.includes('env')) await this.loadEnvironmentFile(file);
        else await this.loadModelFile(file);
      } else if (lower.endsWith('.json')) {
        const text = await file.text();
        if (text.includes('cameracharacter-mocap')) await this.addTakeClip(text, file.name);
        else if (text.includes(CAMERA_TRACK_FORMAT)) await this.importCameraTrackFile(file);
        else if (text.includes('"mapOverrides"')) await this.importProfile(file);
        else this.toasts.show(`${file.name} is not a take, a camera track or a profile.`, 'warn');
      } else {
        this.toasts.show(`Unsupported file: ${file.name}`, 'warn');
      }
    }
    void this.drainQueue();
  }

  async importVideoUrl(url: string, name?: string): Promise<void> {
    this.queue.push({ source: url, name: name ?? (url.split('/').pop() || url) });
    await this.drainQueue();
  }

  private draining: Promise<void> | null = null;

  private drainQueue(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        await this.runImport(job);
      }
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async runImport(job: QueuedImport): Promise<void> {
    const s = this.store.get();
    this.abort = new AbortController();
    this.processing = { name: job.name, phase: 'loading', message: 'Loading video', frame: 0, total: 0, detected: 0, etaMs: null, queued: this.queue.length };
    let loaded: LoadedVideo | null = null;
    try {
      // URLs are fetched into a Blob first so the clip persists with its video like a dropped file.
      let source: Blob | string = job.source;
      if (typeof source === 'string') {
        try {
          const res = await fetch(source, { signal: this.abort.signal });
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          source = await res.blob();
        } catch (err) {
          if (isAbort(err)) throw err;
          console.warn(`Could not fetch ${source} as a file (${(err as Error).message ?? err}); streaming it instead`);
        }
      }
      const result = await extractPoseFromVideo({
        source,
        fileName: job.name,
        fps: this.options.sampleFps,
        poseModel: s.tracking.poseModel,
        delegate: s.tracking.delegate,
        hands: s.tracking.hands,
        face: s.tracking.face,
        signal: this.abort.signal,
        onProgress: (p) => {
          this.processing = { name: job.name, phase: p.phase, message: p.message, frame: p.frame, total: p.total, detected: p.detected, etaMs: p.etaMs, queued: this.queue.length };
        },
      });
      loaded = result.loaded;
      const { recording } = result;
      let thumbnail: string | undefined;
      try {
        await seekTo(loaded.video, Math.min(1, loaded.durationMs / 1000 / 5));
        thumbnail = captureThumbnail(loaded.video) ?? undefined;
        await seekTo(loaded.video, 0);
      } catch {
        thumbnail = undefined;
      }
      const entry: ClipEntry = {
        id: newClipId(),
        name: job.name,
        createdAt: new Date().toISOString(),
        recording,
        stats: statsOf(recording),
        thumbnail,
        video: loaded,
        videoBlob: typeof source === 'string' ? null : source,
        videoType: typeof source === 'string' ? undefined : source.type || undefined,
        track: new CameraTrack(),
      };
      this.registerEntry(entry);
      await this.persistEntry(entry);
      const pct = recording.frames.length ? Math.round((100 * result.detectedFrames) / recording.frames.length) : 0;
      const notes = [`${result.detectedFrames}/${recording.frames.length} frames tracked (${pct}%)`, `${(result.elapsedMs / 1000).toFixed(1)} s on ${result.delegate}`];
      if (result.disabled.hands) notes.push(`hands off: ${result.disabled.hands}`);
      if (result.disabled.face) notes.push(`face off: ${result.disabled.face}`);
      this.toasts.show(`${job.name}: ${notes.join(' · ')}`, pct < 50 ? 'warn' : 'info', 7000);
      await this.activate(entry);
    } catch (err) {
      if (loaded) disposeVideo(loaded);
      if (isAbort(err)) this.toasts.show(`Import of ${job.name} cancelled.`, 'warn');
      else this.reportError(`Could not import ${job.name}: ${(err as Error).message ?? err}`);
    } finally {
      this.processing = null;
      this.abort = null;
    }
  }

  cancelImport(): void {
    this.abort?.abort();
    this.queue = [];
  }

  setSampleFps(fps: number): void {
    if (fps > 0) this.options.sampleFps = fps;
    this.saveOptions();
  }

  /** A `.mocap.json` take becomes a clip without video. */
  private async addTakeClip(text: string, name: string): Promise<void> {
    try {
      const recording = parseMocapRecording(JSON.parse(text));
      const entry: ClipEntry = {
        id: newClipId(),
        name,
        createdAt: new Date().toISOString(),
        recording,
        stats: statsOf(recording),
        video: null,
        videoBlob: null,
        track: new CameraTrack(),
      };
      this.registerEntry(entry);
      await this.persistEntry(entry);
      await this.activate(entry);
      this.toasts.show(`Loaded take ${name} (${recording.frames.length} frames).`);
    } catch (err) {
      this.reportError(`Could not load take ${name}: ${(err as Error).message ?? err}`);
    }
  }

  async loadTakeUrl(url: string): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await this.addTakeClip(await res.text(), url.split('/').pop() ?? url);
    } catch (err) {
      this.reportError(`Could not load take ${url}: ${(err as Error).message ?? err}`);
    }
  }

  private registerEntry(entry: ClipEntry): void {
    this.entries.set(entry.id, entry);
    this.summaries.set(entry.id, {
      id: entry.id,
      name: entry.name,
      createdAt: entry.createdAt,
      stats: entry.stats,
      thumbnail: entry.thumbnail,
      hasVideo: !!entry.video,
      videoBytes: entry.videoBlob?.size ?? 0,
    });
  }

  private async persistEntry(entry: ClipEntry): Promise<void> {
    if (!this.clipStore) return;
    const stored: StoredClip = {
      id: entry.id,
      name: entry.name,
      createdAt: entry.createdAt,
      recording: entry.recording,
      stats: entry.stats,
      cameraTrack: entry.track.toJSON(),
    };
    if (entry.thumbnail) stored.thumbnail = entry.thumbnail;
    if (entry.videoBlob) {
      stored.video = entry.videoBlob;
      stored.videoType = entry.videoType;
    }
    try {
      await this.clipStore.put(stored);
    } catch (err) {
      this.toasts.show(`Clip kept for this session only (storage failed: ${(err as Error).message ?? err}).`, 'warn', 6000);
    }
  }

  async selectClip(id: string): Promise<void> {
    let entry = this.entries.get(id) ?? null;
    if (!entry) {
      if (!this.clipStore) return;
      let stored: StoredClip | null = null;
      try {
        stored = await this.clipStore.get(id);
      } catch (err) {
        this.reportError(`Could not read the clip: ${(err as Error).message ?? err}`);
        return;
      }
      if (!stored) {
        this.summaries.delete(id);
        return;
      }
      let video: LoadedVideo | null = null;
      if (stored.video) {
        try {
          video = await loadVideoElement(stored.video);
        } catch (err) {
          this.toasts.show(`Stored video could not be decoded (${(err as Error).message ?? err}); playing the landmarks only.`, 'warn', 6000);
        }
      }
      let track = new CameraTrack();
      if (stored.cameraTrack) {
        try {
          track = CameraTrack.fromJSON(stored.cameraTrack);
        } catch {
          track = new CameraTrack();
        }
      }
      entry = {
        id: stored.id,
        name: stored.name,
        createdAt: stored.createdAt,
        recording: stored.recording,
        stats: stored.stats,
        thumbnail: stored.thumbnail,
        video,
        videoBlob: stored.video ?? null,
        videoType: stored.videoType,
        track,
      };
      this.entries.set(id, entry);
    }
    await this.activate(entry);
  }

  async deleteClip(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (this.active?.id === id) this.deactivate();
    if (entry?.video) disposeVideo(entry.video);
    this.entries.delete(id);
    this.summaries.delete(id);
    try {
      await this.clipStore?.delete(id);
    } catch (err) {
      this.reportError(`Could not delete the clip: ${(err as Error).message ?? err}`);
    }
  }

  async renameClip(id: string, name: string): Promise<void> {
    const entry = this.entries.get(id);
    const summary = this.summaries.get(id);
    if (entry) entry.name = name;
    if (summary) summary.name = name;
    try {
      await this.clipStore?.patch(id, { name });
    } catch {
      // keep the in-memory rename
    }
  }

  /** Makes a clip the one that plays: builds its source, mounts its video, loads its camera track. */
  private async activate(entry: ClipEntry): Promise<void> {
    const gen = ++this.activation;
    this.deactivate();
    const source = entry.video ? new VideoTakeSource(entry.recording, entry.video.video) : RecordingSource.fromRecording(entry.recording);
    this.unsubscribe.push(source.onFrame((f) => this.onFrame(f)));
    this.unsubscribe.push(
      source.onStatus((st) => {
        this.lastSourceStatus = st;
      }),
    );
    this.active = entry;
    this.source = source;
    this.transport = transportFor(source);
    this.track = entry.track;
    this.markersDirty = true;
    this.resetTracking();
    if (entry.video) {
      entry.video.video.muted = !this.options.audio;
      this.layout.mountVideo(entry.video.video, this.store.get().stage.mirror);
      this.layout.pipLabel.textContent = entry.name;
    } else {
      this.layout.mountVideo(null, false);
      this.layout.pipLabel.textContent = `${entry.name} (landmarks only)`;
    }
    try {
      await source.start();
    } catch (err) {
      if (gen !== this.activation) return;
      this.reportError(`Clip failed to start: ${(err as Error).message ?? err}`);
      return;
    }
    if (gen !== this.activation) return;
    source.setLoop(this.url.loop ?? true);
    source.setSpeed(1);
    if (this.url.autoplay) source.play();
    else {
      source.pause();
      this.transport.emitCurrent();
    }
    this.lastSourceStatus = source.status;
    this.applyCameraMode();
  }

  private deactivate(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    if (this.source) {
      try {
        this.source.stop();
      } catch (err) {
        console.warn('source stop failed', err);
      }
    }
    this.source = null;
    this.transport = null;
    this.active = null;
    this.track = new CameraTrack();
    this.markersDirty = true;
    this.layout.mountVideo(null, false);
    this.layout.pipLabel.textContent = 'source video';
    this.lastSourceStatus = { state: 'idle' };
    this.resetTracking();
  }

  private resetTracking(): void {
    this.filter.reset();
    this.bodyModel.reset();
    this.baseline.reset();
    this.framing = null;
    this.pose = null;
    this.body = null;
    this.solve = null;
    this.summary = null;
    this.latestFrame = null;
    this.frameDirty = false;
    this.errorStats.reset();
    this.model?.retargeter?.reset();
  }

  private stepFrames(frames: number): void {
    const t = this.transport;
    if (!t) return;
    t.pause();
    t.seek(Math.min(Math.max(t.timeMs + frames * t.frameMs, 0), t.durationMs));
  }

  setPipVisible(v: boolean): void {
    this.options.pip = v;
    this.layout.setPipVisible(v);
    this.saveOptions();
  }

  setAudio(v: boolean): void {
    this.options.audio = v;
    const video = this.active?.video?.video;
    if (video) video.muted = !v;
    this.saveOptions();
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  setCameraMode(mode: ImportCameraMode): void {
    const prev = this.options.cameraMode;
    this.options.cameraMode = mode;
    if (prev === 'track' && mode === 'orbit' && this.stage && !this.track.isEmpty) {
      // Keep orbiting around what the keyframe camera was looking at.
      this.stage.controls.target.copy(this.cameraPose.target);
    }
    this.applyCameraMode();
    this.saveOptions();
    if (mode === 'track' && this.track.isEmpty) this.toasts.show('No camera keyframes yet: add keys (K) and the camera will follow them.', 'warn');
  }

  private applyCameraMode(): void {
    const stage = this.stage;
    if (!stage) return;
    const mode = this.options.cameraMode;
    const stageMode = mode === 'follow' ? 'follow' : 'orbit';
    if (stage.cameraMode !== stageMode) stage.setCameraMode(stageMode);
    const trackActive = mode === 'track' && !this.track.isEmpty;
    stage.controls.enabled = mode === 'orbit' || (mode === 'track' && !trackActive);
    if (mode !== 'follow' && !trackActive && Math.abs(stage.camera.fov - this.options.fov) > 1e-3) {
      stage.camera.fov = this.options.fov;
      stage.camera.updateProjectionMatrix();
    }
  }

  setFov(deg: number): void {
    this.options.fov = Math.min(150, Math.max(5, deg));
    if (this.stage && this.options.cameraMode !== 'follow') {
      this.stage.camera.fov = this.options.fov;
      this.stage.camera.updateProjectionMatrix();
    }
    this.saveOptions();
  }

  applyShot(name: ShotName): void {
    if (!this.stage || !this.model) return;
    if (this.options.cameraMode !== 'orbit') {
      this.options.cameraMode = 'orbit';
      this.saveOptions();
      this.applyCameraMode();
    }
    const shot = shotFor(name, this.model.analysis.heightTable, { fov: this.options.fov, origin: this.stage.modelOrigin });
    const cam = this.stage.camera;
    cam.position.copy(shot.position);
    cam.fov = shot.fov;
    cam.updateProjectionMatrix();
    this.stage.controls.target.copy(shot.target);
    cam.lookAt(shot.target);
    this.stage.controls.update();
  }

  /** Current camera as a pose (position, look target, fov). */
  private currentCameraPose(): CameraPose {
    const stage = this.stage!;
    const trackActive = this.options.cameraMode === 'track' && !this.track.isEmpty;
    const target = trackActive ? this.cameraPose.target.clone() : stage.controls.target.clone();
    return { position: stage.camera.position.clone(), target, fov: stage.camera.fov };
  }

  addCameraKey(): void {
    if (!this.stage) return;
    const t = this.transport ? this.transport.timeMs / 1000 : 0;
    const pose = this.currentCameraPose();
    const index = this.track.add({ t, position: pose.position, target: pose.target, fov: pose.fov });
    this.markersDirty = true;
    this.schedulePersistTrack();
    this.toasts.show(`Camera key ${index + 1} at ${t.toFixed(2)} s${this.options.cameraMode === 'track' ? '' : ' (switch the camera mode to Keyframes to play it)'}.`, 'info', 2500);
    this.applyCameraMode();
  }

  removeCameraKey(index: number): void {
    if (this.track.remove(index)) {
      this.markersDirty = true;
      this.schedulePersistTrack();
      this.applyCameraMode();
    }
  }

  jumpToCameraKey(index: number): void {
    const key = this.track.keys[index];
    if (!key) return;
    this.transport?.pause();
    this.transport?.seek(key.t * 1000);
    if (this.options.cameraMode === 'orbit' && this.stage) {
      // Show the stored camera so it can be adjusted and re-saved.
      const cam = this.stage.camera;
      cam.position.set(key.position[0], key.position[1], key.position[2]);
      this.stage.controls.target.set(key.target[0], key.target[1], key.target[2]);
      cam.fov = key.fov;
      cam.updateProjectionMatrix();
      this.stage.controls.update();
    }
  }

  private jumpToNeighbourKey(direction: 1 | -1): void {
    const t = this.transport ? this.transport.timeMs / 1000 : 0;
    const next = direction > 0 ? this.track.nextKeyTime(t + 0.05) : this.track.prevKeyTime(t - 0.05);
    if (next === null) return;
    const index = this.track.nearest(next, 1e-6);
    if (index >= 0) this.jumpToCameraKey(index);
  }

  setCameraKeyEase(index: number, ease: CameraEase): void {
    this.track.setEase(index, ease);
    this.schedulePersistTrack();
  }

  clearCameraKeys(): void {
    this.track.clear();
    this.markersDirty = true;
    this.schedulePersistTrack();
    this.applyCameraMode();
  }

  addOrbitShot(opts: { turns: number }): void {
    if (!this.stage || !this.model) return;
    const front = shotFor('front', this.model.analysis.heightTable, { fov: this.options.fov, origin: this.stage.modelOrigin });
    const origin = this.stage.modelOrigin;
    const radius = Math.hypot(front.position.x - origin.x, front.position.z - origin.z);
    const duration = Math.max(1, (this.transport?.durationMs ?? 6000) / 1000);
    const track = CameraTrack.orbit({
      center: origin,
      radius,
      height: front.position.y - origin.y,
      lookAtHeight: front.target.y,
      durationSec: duration,
      turns: opts.turns,
      fov: this.options.fov,
    });
    this.track.clear();
    for (const k of track.keys) this.track.add(k);
    this.options.cameraMode = 'track';
    this.saveOptions();
    this.markersDirty = true;
    this.schedulePersistTrack();
    this.applyCameraMode();
    this.toasts.show(`Orbit shot: ${this.track.length} keys over ${duration.toFixed(1)} s.`);
  }

  exportCameraTrack(): void {
    downloadText(JSON.stringify(this.track.toJSON(), null, 2), `${sanitize(this.active?.name ?? 'camera')}-camera.json`, 'application/json');
  }

  async importCameraTrackFile(file: File): Promise<void> {
    try {
      const track = CameraTrack.fromJSON(JSON.parse(await file.text()));
      this.track.clear();
      for (const k of track.keys) this.track.add(k);
      this.markersDirty = true;
      this.schedulePersistTrack();
      this.applyCameraMode();
      this.toasts.show(`Camera track imported (${track.length} keys).`);
    } catch (err) {
      this.reportError(`Camera track import failed: ${(err as Error).message ?? err}`);
    }
  }

  private schedulePersistTrack(): void {
    const entry = this.active;
    if (!entry || !this.clipStore) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.clipStore?.patch(entry.id, { cameraTrack: entry.track.toJSON() }).catch(() => undefined);
    }, 400);
  }

  // ---------------------------------------------------------------------------
  // Model (same behaviour as the live app)
  // ---------------------------------------------------------------------------

  async loadModelFile(file: File): Promise<void> {
    await this.loadModelSource(file, file.name);
  }

  async loadModelUrl(url: string, label?: string): Promise<void> {
    await this.loadModelSource(url, label ?? url.split('/').pop() ?? url);
  }

  private async loadModelSource(source: File | string, name: string): Promise<void> {
    if (!this.stage) return;
    this.modelLoading = { name, progress: null };
    const s = this.store.get();
    try {
      const session = await ModelSession.load(source, {
        targetHeight: s.stage.targetHeight,
        smoothing: s.smoothing,
        hipsMode: s.stage.hipsMode,
        cameraVfovDeg: s.tracking.cameraVfovDeg,
        depthTranslation: true,
        profileStore: this.profileStore,
        renderer: this.stage.renderer,
        displayName: name,
        onProgress: (p) => {
          if (this.modelLoading) this.modelLoading.progress = p;
        },
      });
      if (this.model) {
        this.stage.setModel(null);
        this.model.dispose();
      }
      this.model = session;
      this.stage.setModel(session.wrapper);
      session.wrapper.updateMatrixWorld(true);
      this.solve = null;
      this.summary = null;
      this.errorStats.reset();
      if (!this.track.isEmpty || this.options.cameraMode !== 'orbit') this.applyCameraMode();
      else this.applyShot('front');
      if (session.unrigged) this.toasts.show(`${name} has no skeleton; showing it as a static model.`, 'warn', 6000);
      else if (session.warnings.length) this.toasts.show(`${name}: ${session.warnings.length} mapping note(s), see the Model panel.`, 'warn', 5000);
      else this.toasts.show(`${name} ready (${Object.keys(session.map).length} bones mapped).`);
    } catch (err) {
      this.reportError(`Could not load model ${name}: ${(err as Error).message ?? err}`);
      console.error(err);
    } finally {
      this.modelLoading = null;
    }
  }

  setMappingOverride(role: HumanoidBone, boneName: string | null): void {
    this.model?.setMappingOverride(role, boneName);
  }

  swapSides(): void {
    this.model?.swapSides();
  }

  resetMapping(): void {
    this.model?.resetMapping();
  }

  setBoneMode(role: HumanoidBone, mode: BoneRefMode): void {
    this.model?.setBoneMode(role, mode);
  }

  setBoneRoll(role: HumanoidBone, deg: number): void {
    this.model?.setBoneRoll(role, deg);
  }

  resetBoneSettings(): void {
    this.model?.resetBoneSettings();
  }

  exportProfile(): void {
    if (!this.model) return;
    downloadText(this.model.exportProfileJson(), `${sanitize(this.model.name)}-profile.json`, 'application/json');
  }

  async importProfile(file: File): Promise<void> {
    if (!this.model) return;
    try {
      this.model.importProfile(await file.text());
      this.toasts.show('Profile imported.');
    } catch (err) {
      this.reportError(`Profile import failed: ${(err as Error).message ?? err}`);
    }
  }

  async loadEnvironmentFile(file: File): Promise<void> {
    if (!this.stage) return;
    try {
      const env = await loadEnvironment(file, { renderer: this.stage.renderer });
      this.clearEnvironment();
      this.environment = { name: env.name, root: env.root };
      this.stage.setEnvironment(env.root, env.spawn);
      this.toasts.show(`Environment ${env.name} loaded.`);
    } catch (err) {
      this.reportError(`Could not load environment: ${(err as Error).message ?? err}`);
    }
  }

  clearEnvironment(): void {
    if (!this.environment || !this.stage) return;
    this.stage.setEnvironment(null);
    this.environment = null;
  }

  // ---------------------------------------------------------------------------
  // Export: bake, GLB, BVH, take, video
  // ---------------------------------------------------------------------------

  private takeKey(): string {
    return `${this.active?.id ?? ''}:${this.model?.name ?? ''}:${this.model?.analysis.instanceKey ?? ''}:${this.options.bakeFps}:${this.store.get().stage.mirror ? 'm' : 'a'}:${this.store.get().stage.hipsMode}`;
  }

  async bake(): Promise<void> {
    const entry = this.active;
    const retargeter = this.model?.retargeter;
    if (!entry || !retargeter || !this.model) {
      this.toasts.show('Load a clip and a rigged model first.', 'warn');
      return;
    }
    if (this.baking || this.renderJob) return;
    const transport = this.transport;
    const wasPlaying = !!transport?.playing;
    transport?.pause();
    this.bakeAbort = new AbortController();
    this.baking = { done: 0, total: 0 };
    const key = this.takeKey();
    try {
      const take = await bakeRecordingAsync(
        entry.recording,
        {
          filter: this.filter,
          bodyModel: this.bodyModel,
          baseline: this.baseline,
          retargeter,
          noKnee: this.model.analysis.noKnee,
          noElbow: this.model.analysis.noElbow,
          mirror: this.store.get().stage.mirror,
        },
        {
          fps: this.options.bakeFps,
          yieldEvery: 20,
          signal: this.bakeAbort.signal,
          onProgress: (done, total) => {
            this.baking = { done, total };
          },
        },
      );
      this.lastTake = take;
      this.lastTakeKey = key;
      this.toasts.show(`Baked ${take.samples.length} samples at ${take.fps} fps.`);
    } catch (err) {
      if (!isAbort(err)) this.reportError(`Baking failed: ${(err as Error).message ?? err}`);
    } finally {
      this.baking = null;
      this.bakeAbort = null;
      this.resetTracking();
      if (transport && transport === this.transport) {
        if (wasPlaying) transport.play();
        else transport.emitCurrent();
      }
    }
  }

  private async ensureTake(): Promise<Take | null> {
    if (!this.lastTake || this.lastTakeKey !== this.takeKey()) await this.bake();
    return this.lastTake && this.lastTakeKey === this.takeKey() ? this.lastTake : null;
  }

  async exportGlb(): Promise<void> {
    const take = await this.ensureTake();
    if (!take || !this.model || !this.stage) return;
    try {
      const bones = take.roles.map((role) => this.model!.bones[role]).filter((b): b is import('three').Object3D => !!b);
      if (bones.length !== take.roles.length) throw new Error('The mapping changed since the take was baked; bake again.');
      const hips = this.model.bones.hips;
      if (!hips) throw new Error('No hips bone mapped.');
      const clip = takeToAnimationClip(take, bones, hips, sanitize(this.active?.name ?? 'take'));
      const buffer = await exportGlbWithTake({
        wrapper: this.model.wrapper,
        applyBindPose: () => this.model!.applyBindPose(),
        clip,
        environment: this.options.includeEnvironment ? this.environment?.root ?? null : null,
        renderer: this.stage.renderer,
      });
      downloadArrayBuffer(buffer, timestampedFilename(`${sanitize(this.model.name)}-${sanitize(this.active?.name ?? 'clip')}`, 'glb'), 'model/gltf-binary');
      this.toasts.show('GLB exported with the baked animation.');
    } catch (err) {
      this.reportError(`GLB export failed: ${(err as Error).message ?? err}`);
    }
  }

  async exportBvh(): Promise<void> {
    const take = await this.ensureTake();
    if (!take) return;
    try {
      downloadText(takeToBvh(take), timestampedFilename(sanitize(this.active?.name ?? 'take'), 'bvh'), 'text/plain');
    } catch (err) {
      this.reportError(`BVH export failed: ${(err as Error).message ?? err}`);
    }
  }

  exportTake(): void {
    if (!this.active) return;
    downloadText(serializeRecording(this.active.recording), `${sanitize(this.active.name)}.mocap.json`, 'application/json');
  }

  setExportOption(key: ExportOptionKey, value: number | boolean): void {
    if (key === 'bakeFps') this.options.bakeFps = Number(value) > 0 ? Number(value) : 30;
    else this.options[key] = Boolean(value);
    this.saveOptions();
  }

  async renderVideo(): Promise<void> {
    const entry = this.active;
    const t = this.transport;
    if (!entry || !t || !this.stage || this.renderJob || this.baking) return;
    const s = this.store.get();
    t.pause();
    const restoreLoop = t.loop;
    t.setLoop(false);
    t.seek(0);
    this.resetTracking();
    const video = entry.video?.video ?? null;
    let audioTracks: MediaStreamTrack[] | undefined;
    if (this.options.renderAudio && video) {
      try {
        const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
        if (capture) audioTracks = capture.call(video).getAudioTracks();
      } catch {
        audioTracks = undefined;
      }
    }
    const recorder = new VideoRecorder({
      source: this.stage.domElement,
      fps: 30,
      pip: this.options.renderPip && video ? { video, mirror: s.stage.mirror, rect: { x: 0.02, y: 0.7, w: 0.25, h: 0.28 } } : null,
      audioTracks,
      onWarning: (m) => this.toasts.show(m, 'warn', 5000),
    });
    try {
      await sleep(RENDER_SETTLE_MS);
      const { t0 } = await recorder.start();
      this.renderJob = { recorder, startedAt: t0, restoreLoop, stopping: false };
      t.play();
    } catch (err) {
      t.setLoop(restoreLoop);
      this.reportError(`Video recording could not start: ${(err as Error).message ?? err}`);
    }
  }

  private checkRenderEnd(): void {
    const job = this.renderJob;
    const t = this.transport;
    if (!job || job.stopping || !t) return;
    if (!t.playing && t.timeMs >= t.durationMs - t.frameMs * 1.5) void this.finishRender();
  }

  async cancelRender(): Promise<void> {
    await this.finishRender();
  }

  private async finishRender(): Promise<void> {
    const job = this.renderJob;
    if (!job || job.stopping) return;
    job.stopping = true;
    this.transport?.pause();
    try {
      const { blob, extension, durationMs } = await job.recorder.stop();
      downloadBlob(blob, timestampedFilename(`${sanitize(this.active?.name ?? 'clip')}-render`, extension));
      this.toasts.show(`Video saved (${(durationMs / 1000).toFixed(1)} s).`);
    } catch (err) {
      this.reportError(`Video recording failed: ${(err as Error).message ?? err}`);
    } finally {
      this.renderJob = null;
      this.transport?.setLoop(job.restoreLoop);
    }
  }

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------

  resetSettings(): void {
    this.store.reset();
    this.store.update(importSettingsPatchFromUrl(this.url));
    this.toasts.show('Settings reset to defaults.');
  }

  togglePanel(): void {
    this.layout.setPanelCollapsed(!this.layout.isPanelCollapsed());
  }

  /** Stops the loop, the active clip and the renderer (tests, hot reload). */
  stop(): void {
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.cancelImport();
    this.bakeAbort?.abort();
    this.deactivate();
    for (const e of this.entries.values()) if (e.video) disposeVideo(e.video);
    this.entries.clear();
    if (this.renderJob) void this.renderJob.recorder.stop().catch(() => undefined);
    this.renderJob = null;
    this.stage?.dispose();
    this.stage = null;
  }

  private reportError(message: string): void {
    this.errors.push(message);
    if (this.errors.length > 50) this.errors.shift();
    this.toasts?.show(message, 'bad', 7000);
    console.error(message);
  }

  private fail(message: string): void {
    this.reportError(message);
    const el = document.createElement('div');
    el.className = 'toast bad';
    el.style.position = 'absolute';
    el.style.inset = '40% 20%';
    el.textContent = message;
    this.root.appendChild(el);
  }

  getDebugState(): ImportDebugState {
    const m = this.model;
    const summary = this.solve && m ? summarize(this.solve, m.analysis) : null;
    const t = this.transport;
    const cam = this.stage?.camera.position;
    return {
      ready: !!this.stage && !this.modelLoading,
      storeKind: this.clipStore?.kind ?? 'none',
      clips: Array.from(this.summaries.values()).map((s) => ({ id: s.id, name: s.name, frames: s.stats.frames, detectedFrames: s.stats.detectedFrames, hasVideo: s.hasVideo })),
      activeClip: this.active?.name ?? null,
      processing: this.processing ? { name: this.processing.name, phase: this.processing.phase, frame: this.processing.frame, total: this.processing.total, detected: this.processing.detected } : null,
      playback: t ? { playing: t.playing, timeMs: t.timeMs, durationMs: t.durationMs, loop: t.loop } : null,
      model: m ? { name: m.name, family: m.analysis.family, bones: Object.keys(m.map).length, warnings: m.warnings, unrigged: m.unrigged } : null,
      framesProcessed: this.framesProcessed,
      framesSolved: this.framesSolved,
      present: !!this.pose?.present,
      framing: this.framing?.state ?? 'none',
      maxBoneErrorDeg: summary?.maxErrorDeg ?? null,
      meanBoneErrorDeg: summary?.meanErrorDeg ?? null,
      cameraMode: this.options.cameraMode,
      cameraKeys: this.track.length,
      cameraPosition: cam ? [cam.x, cam.y, cam.z] : [0, 0, 0],
      baking: !!this.baking,
      hasTake: !!this.lastTake,
      rendering: !!this.renderJob,
      errors: [...this.errors],
    };
  }

  get settings(): AppSettings {
    return this.store.get();
  }
}

function fmtTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
