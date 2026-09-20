/**
 * Application orchestration: sources → filter → body model → framing → solver →
 * stage, plus panels, recorders, calibration and diagnostics.
 */
import { Vector3 } from 'three';
import packageJson from '../../package.json';
import { BUILD_INFO, log } from '../core/log';
import { type FilteredPose } from '../core/pose';
import { type AppSettings, type FramingFit, type HumanoidBone, type MocapRecording, type PoseFrame, type Take, DEFAULT_SETTINGS } from '../core/types';
import { ErrorStats, LandmarkSkeleton3D, Overlay2D, buildDiagnosticsJson, captureSnapshot, summarize, type BoneErrorSummary } from '../diagnostics';
import {
  ClipRecorder,
  LandmarkRecorder,
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
import { PoseCalibrationCapture, StandingBaseline } from '../retarget/calibration';
import { fitFraming } from '../retarget/framing';
import type { SolveResult } from '../retarget/solver';
import { ProfileStore } from '../rig';
import { Stage, loadEnvironment } from '../stage';
import { LM } from '../tracking/landmarks';
import { MEDIAPIPE_VERSION } from '../tracking/mediapipeModels';
import { PoseFilter } from '../tracking/PoseFilter';
import type { SourceStatus } from '../tracking/PoseSource';
import { parseMocapRecording } from '../tracking/protocol';
import type { AppActions, AppDebugState, CalibrationVM, RecordingVM, SourceKind, StatusVM } from './actions';
import { buildLayout, installDropZone, installShortcuts, type Layout } from './layout';
import { ModelSession } from './ModelSession';
import { createCalibrationPanel } from './panels/CalibrationPanel';
import { createModelPanel } from './panels/ModelPanel';
import { createRecordingPanel } from './panels/RecordingPanel';
import { createSmoothingPanel } from './panels/SmoothingPanel';
import { createSourcePanel } from './panels/SourcePanel';
import { createStagePanel } from './panels/StagePanel';
import { createStatusPanel } from './panels/StatusPanel';
import { SourceManager } from './SourceManager';
import { SAMPLE_MODELS, SettingsStore, parseUrlOptions, settingsPatchFromUrl, type UrlOptions } from './state';
import { Toasts } from './ui';
import './styles.css';

const PART_GROUPS: { name: string; indices: number[] }[] = [
  { name: 'head', indices: [LM.NOSE, LM.LEFT_EAR, LM.RIGHT_EAR] },
  { name: 'torso', indices: [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP] },
  { name: 'L arm', indices: [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST] },
  { name: 'R arm', indices: [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST] },
  { name: 'L hand', indices: [LM.LEFT_WRIST, LM.LEFT_INDEX, LM.LEFT_PINKY] },
  { name: 'R hand', indices: [LM.RIGHT_WRIST, LM.RIGHT_INDEX, LM.RIGHT_PINKY] },
  { name: 'L leg', indices: [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE] },
  { name: 'R leg', indices: [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE] },
  { name: 'feet', indices: [LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX, LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX] },
];

const PANEL_REFRESH_MS = 100;

interface RecordingOptions {
  fps: number;
  includeEnvironment: boolean;
  pip: boolean;
  microphone: boolean;
}

export class App implements AppActions {
  readonly store: SettingsStore;
  readonly url: UrlOptions;
  private layout!: Layout;
  private toasts!: Toasts;
  private stage: Stage | null = null;
  private sources!: SourceManager;
  private filter: PoseFilter;
  private bodyModel: BodyModel;
  private baseline: StandingBaseline;
  private calibration = new PoseCalibrationCapture();
  private profileStore = new ProfileStore(typeof localStorage !== 'undefined' ? localStorage : null);
  private model: ModelSession | null = null;
  private modelLoading: { name: string; progress: number | null } | null = null;
  private environment: { name: string; root: import('three').Object3D } | null = null;

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
  private solvingPaused = false;
  private calibrationCountdown: number | null = null;
  private snapshotBusy = false;
  private errors: string[] = [];
  private rafHandle = 0;
  private lastPanelRefresh = 0;
  /** The automatic camera mode to return to after the free (orbit) camera. */
  private lastAutoCameraMode: 'mirror' | 'follow' = 'mirror';
  private lastSourceStatus: SourceStatus = { state: 'idle' };

  private overlay: Overlay2D | null = null;
  private skeleton3D: LandmarkSkeleton3D | null = null;

  private takeRecorder = new LandmarkRecorder();
  private clipRecorder: ClipRecorder | null = null;
  private clipT0 = 0;
  private videoRecorder: VideoRecorder | null = null;
  private videoT0 = 0;
  private videoMime: string | null = null;
  private lastTake: MocapRecording | null = null;
  private lastClip: Take | null = null;
  private recordingOptions: RecordingOptions = { fps: 30, includeEnvironment: false, pip: false, microphone: false };

  private panels!: {
    source: ReturnType<typeof createSourcePanel>;
    model: ReturnType<typeof createModelPanel>;
    calibration: ReturnType<typeof createCalibrationPanel>;
    stage: ReturnType<typeof createStagePanel>;
    smoothing: ReturnType<typeof createSmoothingPanel>;
    recording: ReturnType<typeof createRecordingPanel>;
    status: ReturnType<typeof createStatusPanel>;
  };

  constructor(private readonly root: HTMLElement) {
    this.store = SettingsStore.load();
    this.url = parseUrlOptions();
    this.store.update(settingsPatchFromUrl(this.url));
    const s = this.store.get();
    this.filter = new PoseFilter(s.smoothing, s.stage.mirror);
    this.bodyModel = new BodyModel(s.smoothing);
    this.baseline = new StandingBaseline(s.smoothing);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    log.info(`CameraCharacter v${packageJson.version} · commit ${BUILD_INFO.commit} (${BUILD_INFO.branch}) · built ${BUILD_INFO.builtAt}`);
    log.info(`page ${location.href} · ${navigator.userAgent}`);
    this.layout = buildLayout(this.root, { version: packageJson.version });
    this.toasts = new Toasts(this.root);
    const settings = this.store.get();
    log.info(
      `settings: source ${this.url.source ?? 'camera'} · pose ${settings.tracking.poseModel} on ${settings.tracking.delegate}` +
        ` · hands ${settings.tracking.hands ? 'on' : 'off'} · face ${settings.tracking.face ? 'on' : 'off'}` +
        ` · camera ${settings.stage.cameraMode} · mirror ${settings.stage.mirror ? 'on' : 'off'} · diagnostics ${settings.diagnostics ? 'on' : 'off'}`,
      { url: this.url, settings },
    );

    try {
      this.stage = new Stage(this.layout.viewport, settings.stage);
    } catch (err) {
      this.fail(`WebGL is not available: ${(err as Error).message}`);
      return;
    }
    log.info(`stage: ${this.stage.describeGl()}`);
    // Mouse/touch on the viewport switches to the free camera (the stage already did); double-click or the pill returns.
    this.stage.onCameraTakeover = () => {
      if (this.store.get().stage.cameraMode !== 'orbit') this.store.update({ stage: { cameraMode: 'orbit' } });
    };
    this.stage.onResetView = () => this.store.update({ stage: { cameraMode: this.lastAutoCameraMode } });
    this.layout.cameraHint.addEventListener('click', () => this.store.update({ stage: { cameraMode: this.lastAutoCameraMode } }));
    this.skeleton3D = new LandmarkSkeleton3D();
    this.skeleton3D.visible = settings.stage.showLandmarkSkeleton;
    this.stage.scene.add(this.skeleton3D.object);
    this.overlay = new Overlay2D(this.layout.overlay);
    this.layout.setPipMirrored(settings.stage.mirror);

    this.sources = new SourceManager({
      getTracking: () => this.store.get().tracking,
      onFrame: (f) => this.onFrame(f),
      onStatus: (st) => {
        this.lastSourceStatus = st;
        if (st.state === 'error' && st.message) this.toasts.show(st.message, 'bad', 6000);
      },
      onVideo: (video) => this.mountVideo(video),
      onError: (m) => this.reportError(m),
    });
    this.sources.autoplay = this.url.autoplay || this.url.source !== 'recording';
    if (this.url.loop !== undefined) this.sources.loop = this.url.loop;
    if (this.url.speed) this.sources.speed = this.url.speed;
    if (this.url.preset) this.sources.preset = this.url.preset;
    if (this.url.ws) this.sources.wsUrl = this.url.ws;

    this.buildPanels();
    installDropZone(this.root, this.layout.dropOverlay, (files) => void this.handleDroppedFiles(files));
    installShortcuts({
      Tab: () => this.togglePanel(),
      ' ': () => this.sources.togglePlay(),
      r: () => void this.toggleRecording('take'),
      a: () => void this.toggleRecording('clip'),
      v: () => void this.toggleRecording('video'),
      m: () => this.store.update({ stage: { mirror: !this.store.get().stage.mirror } }),
      c: () => {
        const order = ['mirror', 'follow', 'orbit'] as const;
        const cur = this.store.get().stage.cameraMode;
        this.store.update({ stage: { cameraMode: order[(order.indexOf(cur) + 1) % order.length] } });
      },
      d: () => this.store.update({ diagnostics: !this.store.get().diagnostics }),
      s: () => void this.takeSnapshot(),
      k: () => this.store.update({ diagnostics: !this.store.get().diagnostics }),
    });
    this.store.subscribe((s) => this.applySettings(s));
    if (this.url.kiosk) this.layout.setPanelCollapsed(true);

    this.lastLoopTime = performance.now();
    this.rafHandle = requestAnimationFrame((t) => this.loop(t));

    const modelUrl = this.url.model ?? SAMPLE_MODELS[0].url;
    void this.loadModelUrl(modelUrl, this.url.model ? undefined : SAMPLE_MODELS[0].label);

    if (this.url.source === 'recording' && this.url.file) {
      await this.loadRecordingUrl(this.url.file);
    } else {
      await this.sources.setSource(this.url.source ?? 'camera');
    }
  }

  private buildPanels(): void {
    this.panels = {
      source: createSourcePanel(this.store, this),
      model: createModelPanel(this.store, this),
      calibration: createCalibrationPanel(this.store, this),
      stage: createStagePanel(this.store, this),
      smoothing: createSmoothingPanel(this.store, this),
      recording: createRecordingPanel(this.store, this),
      status: createStatusPanel(this.store, this),
    };
    this.layout.panelBody.append(
      this.panels.source.root,
      this.panels.model.root,
      this.panels.calibration.root,
      this.panels.stage.root,
      this.panels.recording.root,
      this.panels.status.root,
      this.panels.smoothing.root,
    );
  }

  private applySettings(s: AppSettings): void {
    this.filter.setSettings(s.smoothing);
    this.filter.setMirror(s.stage.mirror);
    this.bodyModel.setSettings(s.smoothing);
    this.baseline.setSettings(s.smoothing);
    this.layout.setPipMirrored(s.stage.mirror);
    this.stage?.applySettings(s.stage);
    if (s.stage.cameraMode !== 'orbit') this.lastAutoCameraMode = s.stage.cameraMode;
    this.layout.setCameraHint(
      s.stage.cameraMode === 'orbit' ? `Free camera · drag to rotate, wheel to zoom, right-drag to pan · click here or double-click the view for the ${this.lastAutoCameraMode} camera` : null,
    );
    if (this.skeleton3D) this.skeleton3D.visible = s.stage.showLandmarkSkeleton;
    this.model?.updateOptions({
      smoothing: s.smoothing,
      hipsMode: s.stage.hipsMode,
      cameraVfovDeg: s.tracking.cameraVfovDeg,
      depthTranslation: s.stage.cameraMode !== 'mirror',
    });
    if (this.model && Math.abs(this.model.analysis.scale * this.model.analysis.sourceHeight - s.stage.targetHeight) > 1e-3) {
      this.model.wrapper.scale.setScalar(s.stage.targetHeight / this.model.analysis.sourceHeight);
    }
    void this.sources.applyTrackingSettings(s.tracking);
  }

  private mountVideo(video: HTMLVideoElement | null): void {
    const pip = this.layout.pip;
    const current = pip.querySelector('video');
    if (video) {
      if (current !== video) {
        current?.remove();
        video.classList.add('pip-video');
        video.classList.toggle('mirrored', this.store.get().stage.mirror);
        pip.insertBefore(video, this.layout.overlay);
      }
      this.layout.video = video;
      this.layout.pipLabel.textContent = 'webcam';
    } else {
      if (current && current !== this.layout.video) current.remove();
      this.layout.video.style.display = 'none';
      this.layout.pipLabel.textContent = this.sources?.kind === 'camera' ? 'webcam' : `${this.sources?.kind ?? 'source'} (landmarks)`;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame pipeline
  // ---------------------------------------------------------------------------

  private onFrame(frame: PoseFrame): void {
    this.latestFrame = frame;
    this.frameDirty = true;
    this.framesProcessed++;
    if (this.framesProcessed === 1) log.info(`first pose frame from ${frame.src} · ${frame.size[0]}×${frame.size[1]} · subject ${frame.pose ? 'detected' : 'not detected'}`);
    if (this.takeRecorder.isRecording) this.takeRecorder.push(frame);
  }

  private loop(now: number): void {
    this.rafHandle = requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastLoopTime) / 1000));
    this.lastLoopTime = now;
    this.renderFps = this.renderFps * 0.9 + (1 / dt) * 0.1;
    const settings = this.store.get();

    try {
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
        if (this.calibration.isRunning) {
          const result = this.calibration.update(this.body, this.solve?.depthZ ?? null);
          if (result) this.finishCalibration(result);
        }
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
      if (retargeter && this.pose && this.body && this.framing && !this.solvingPaused) {
        this.solve = retargeter.solve(this.body, this.pose, dt, this.framing);
        this.framesSolved++;
        if (settings.diagnostics || this.snapshotBusy) {
          this.summary = summarize(this.solve, this.model!.analysis);
          this.errorStats.push(this.summary);
        }
        if (this.clipRecorder?.isRecording) this.clipRecorder.push(retargeter.sampleTake((now - this.clipT0) / 1000));
      }

      if (this.stage) {
        const hipsWorld = this.solve?.hipsWorldPos ?? this.stage.modelOrigin;
        if (this.model && this.pose) {
          this.stage.setCameraInput({
            fit: this.framing,
            table: this.model.analysis.heightTable,
            hipsWorld,
            lateralOffset: hipsWorld.x - this.stage.modelOrigin.x,
            present: this.pose.present,
            absentFor: this.pose.absentFor,
            origin: this.stage.modelOrigin,
          });
        }
        this.skeleton3D?.update(settings.stage.showLandmarkSkeleton ? this.pose : null, hipsWorld);
        this.stage.render(dt);
        this.videoRecorder?.drawFrame();
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

  private refreshPanels(): void {
    const s = this.store.get();
    this.panels.source.update(this.sources.viewModel());
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
    this.panels.calibration.update(this.calibrationVM());
    this.panels.recording.update(this.recordingVM());
    this.panels.status.update(this.statusVM());

    const st = this.lastSourceStatus;
    const c = this.layout.chips;
    c.source.set(`${this.sources.kind}: ${st.state}${st.fps ? ` ${st.fps.toFixed(0)} fps` : ''}`, st.state === 'running' ? 'good' : st.state === 'error' ? 'bad' : 'warn');
    c.subject.set(this.pose?.present ? 'subject tracked' : 'no subject', this.pose?.present ? 'good' : 'off');
    c.model.set(this.model ? `${this.model.name}${this.model.unrigged ? ' (no rig)' : ''}` : this.modelLoading ? `loading ${this.modelLoading.name}` : 'no model', this.model && !this.model.unrigged ? 'good' : 'warn');
    c.framing.set(`framing: ${this.framing?.state ?? 'none'}`, 'off');
    c.fps.set(`${this.renderFps.toFixed(0)} fps`, 'off');
  }

  private calibrationVM(): CalibrationVM {
    return {
      hasCalibration: !!this.model?.profile.calibration,
      calibratedAt: this.model?.profile.calibration?.createdAt ?? null,
      baselineReady: this.baseline.isReady,
      capturing: this.calibration.isRunning || this.calibrationCountdown !== null,
      countdown: this.calibrationCountdown,
      snapshotBusy: this.snapshotBusy,
    };
  }

  private recordingVM(): RecordingVM {
    const now = performance.now();
    return {
      take: { active: this.takeRecorder.isRecording, frames: this.takeRecorder.frameCount, seconds: this.takeRecorder.durationMs / 1000 },
      clip: {
        active: !!this.clipRecorder?.isRecording,
        frames: this.clipRecorder?.sampleCount ?? 0,
        seconds: this.clipRecorder?.isRecording ? (now - this.clipT0) / 1000 : 0,
      },
      video: { active: !!this.videoRecorder?.isRecording, frames: 0, seconds: this.videoRecorder?.isRecording ? (now - this.videoT0) / 1000 : 0, mime: this.videoMime },
      hasTake: !!this.lastTake,
      hasClip: !!this.lastClip,
      fps: this.recordingOptions.fps,
      includeEnvironment: this.recordingOptions.includeEnvironment,
      pip: this.recordingOptions.pip,
      microphone: this.recordingOptions.microphone,
    };
  }

  private statusVM(): StatusVM {
    const pose = this.pose;
    const parts = PART_GROUPS.map((g) => ({
      name: g.name,
      confidence: pose ? Math.min(...g.indices.map((i) => pose.confidence[i] ?? 0)) : 0,
    }));
    const st = this.lastSourceStatus;
    return {
      present: !!pose?.present,
      framing: this.framing?.state ?? 'none',
      renderFps: this.renderFps,
      inferenceFps: st.fps ?? 0,
      inferenceMs: st.inferenceMs ?? 0,
      parts,
      errors: this.summary ? this.summary.perBone.map((b) => ({ role: b.role, errorDeg: b.errorDeg, flagged: b.flagged })) : [],
      chainErrors: this.summary ? this.summary.chains.map((c) => ({ name: c.name, errorDeg: c.errorDeg })) : [],
      depthZ: this.solve?.depthZ ?? null,
      hands: { left: !!pose?.hands.left, right: !!pose?.hands.right },
      face: !!pose?.face,
    };
  }

  // ---------------------------------------------------------------------------
  // Actions: sources
  // ---------------------------------------------------------------------------

  async setSource(kind: SourceKind): Promise<void> {
    this.resetTracking();
    await this.sources.setSource(kind);
  }

  async selectCamera(deviceId: string): Promise<void> {
    await this.sources.selectCamera(deviceId);
  }

  async refreshCameras(): Promise<void> {
    await this.sources.refreshCameras();
  }

  async setSyntheticPreset(name: string): Promise<void> {
    this.resetTracking();
    await this.sources.setSyntheticPreset(name);
  }

  async setWebSocketUrl(url: string): Promise<void> {
    await this.sources.setWebSocketUrl(url);
  }

  async loadRecordingFile(file: File): Promise<void> {
    try {
      const rec = parseMocapRecording(JSON.parse(await file.text()));
      this.resetTracking();
      await this.sources.loadRecording(rec, file.name);
      this.toasts.show(`Loaded take ${file.name} (${rec.frames.length} frames)`);
    } catch (err) {
      this.reportError(`Could not load take: ${(err as Error).message ?? err}`);
    }
  }

  async loadRecordingUrl(url: string): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const rec = parseMocapRecording(await res.json());
      this.resetTracking();
      await this.sources.loadRecording(rec, url.split('/').pop() ?? url);
    } catch (err) {
      this.reportError(`Could not load take ${url}: ${(err as Error).message ?? err}`);
    }
  }

  playback = {
    play: () => this.sources.play(),
    pause: () => this.sources.pause(),
    seek: (ms: number) => this.sources.seek(ms),
    setSpeed: (x: number) => this.sources.setSpeed(x),
    setLoop: (v: boolean) => this.sources.setLoop(v),
  };

  private resetTracking(): void {
    this.filter.reset();
    this.bodyModel.reset();
    this.baseline.reset();
    this.framing = null;
    this.pose = null;
    this.body = null;
    this.solve = null;
    this.summary = null;
    this.errorStats.reset();
    this.model?.retargeter?.reset();
  }

  // ---------------------------------------------------------------------------
  // Actions: model
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
    log.info(`model: loading "${name}"${typeof source === 'string' ? ` from ${source}` : ` (${Math.round(source.size / 1024)} KB file)`}`);
    const s = this.store.get();
    try {
      const session = await ModelSession.load(source, {
        targetHeight: s.stage.targetHeight,
        smoothing: s.smoothing,
        hipsMode: s.stage.hipsMode,
        cameraVfovDeg: s.tracking.cameraVfovDeg,
        depthTranslation: s.stage.cameraMode !== 'mirror',
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
      log.info(
        `model: "${name}" ready · family ${session.analysis.family} · ${Object.keys(session.map).length} bones mapped` +
          `${session.unrigged ? ' · no skeleton' : ''}${session.warnings.length ? ` · ${session.warnings.length} note(s)` : ''}`,
        session.warnings,
      );
      this.stage.setModel(session.wrapper);
      session.wrapper.updateMatrixWorld(true);
      this.solve = null;
      this.summary = null;
      this.errorStats.reset();
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

  setBoneMode(role: HumanoidBone, mode: import('../core/types').BoneRefMode): void {
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
  // Actions: calibration and diagnostics
  // ---------------------------------------------------------------------------

  async startPoseCalibration(): Promise<void> {
    if (!this.model?.retargeter || this.calibration.isRunning) return;
    this.solvingPaused = true;
    this.model.applyBindPose();
    for (let n = 3; n > 0; n--) {
      this.calibrationCountdown = n;
      this.layout.showCountdown(n, 'Match the character’s pose like a mirror and hold still');
      await sleep(1000);
    }
    this.calibrationCountdown = null;
    this.layout.showCountdown(null, 'Hold…');
    this.calibration.start(60);
    const started = performance.now();
    while (this.calibration.isRunning && performance.now() - started < 8000) await sleep(50);
    if (this.calibration.isRunning) {
      this.calibration.cancel();
      this.toasts.show('Calibration cancelled: not enough tracked frames. Stand in full view and try again.', 'warn', 6000);
      this.layout.hideCountdown();
      this.solvingPaused = false;
    }
  }

  private finishCalibration(result: import('../core/types').PoseCalibration): void {
    this.layout.hideCountdown();
    this.solvingPaused = false;
    this.model?.setCalibration(result);
    this.toasts.show('Pose calibration stored for this character.');
  }

  clearPoseCalibration(): void {
    this.model?.setCalibration(null);
    this.toasts.show('Pose calibration cleared.');
  }

  resetBaseline(): void {
    this.baseline.reset();
    this.toasts.show('Standing baseline will be re-captured from the next seconds of full-body tracking.');
  }

  async takeSnapshot(): Promise<void> {
    if (!this.stage || this.snapshotBusy) return;
    this.snapshotBusy = true;
    try {
      const s = this.store.get();
      const summary = this.solve && this.model ? summarize(this.solve, this.model.analysis) : null;
      const json = buildDiagnosticsJson({
        analysis: this.model?.analysis ?? null,
        profile: this.model?.profile ?? null,
        pose: this.pose,
        body: this.body,
        solve: this.solve,
        framing: this.framing,
        settings: s,
        mirror: s.stage.mirror,
        sourceKind: this.sources.kind,
        extra: { sourceStatus: this.lastSourceStatus, framesProcessed: this.framesProcessed, framesSolved: this.framesSolved, errors: this.errors, mediapipe: MEDIAPIPE_VERSION },
      });
      const video = this.sources.mediaPipe?.video ?? null;
      const { png, bundleName } = await captureSnapshot({
        renderer: this.stage.renderer,
        scene: this.stage.scene,
        camera: this.stage.camera,
        video,
        overlay: this.overlay,
        previewMirrored: s.stage.mirror,
        summary,
        json,
      });
      downloadBlob(png, `${bundleName}.png`);
      downloadText(json, `${bundleName}.json`, 'application/json');
      this.toasts.show('Snapshot saved (PNG + JSON).');
    } catch (err) {
      this.reportError(`Snapshot failed: ${(err as Error).message ?? err}`);
    } finally {
      this.snapshotBusy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions: recording
  // ---------------------------------------------------------------------------

  async toggleRecording(kind: 'take' | 'clip' | 'video'): Promise<void> {
    const s = this.store.get();
    if (kind === 'take') {
      if (this.takeRecorder.isRecording) {
        this.lastTake = this.takeRecorder.stop();
        this.toasts.show(`Take recorded: ${this.lastTake.frames.length} frames. Use "Save take" to download.`);
      } else {
        this.takeRecorder.start(
          {
            source: this.sources.kind,
            mirror: s.stage.mirror,
            fovDeg: s.tracking.cameraVfovDeg,
            camera: { vfovDeg: s.tracking.cameraVfovDeg, deviceLabel: this.sources.cameras.find((c) => c.deviceId === this.sources.cameraId)?.label },
            tracker: this.sources.kind === 'camera' ? { lib: '@mediapipe/tasks-vision', version: MEDIAPIPE_VERSION, poseModel: s.tracking.poseModel, delegate: this.sources.delegate ?? s.tracking.delegate, hands: s.tracking.hands, face: s.tracking.face } : undefined,
            smoothing: s.smoothing,
            calibration: this.model?.profile.calibration ?? null,
            referenceModel: this.model ? { familyKey: this.model.analysis.familyKey, instanceKey: this.model.analysis.instanceKey, displayName: this.model.name } : null,
          },
          performance.now(),
        );
      }
      return;
    }
    if (kind === 'clip') {
      if (this.clipRecorder?.isRecording) {
        this.lastClip = this.clipRecorder.stop();
        this.clipRecorder = null;
        this.toasts.show(`Animation recorded: ${this.lastClip.samples.length} samples at ${this.lastClip.fps} fps.`);
      } else {
        const r = this.model?.retargeter;
        if (!r) {
          this.toasts.show('Load a rigged model first.', 'warn');
          return;
        }
        this.clipRecorder = new ClipRecorder(r.takeHeader(this.recordingOptions.fps), this.recordingOptions.fps);
        this.clipT0 = performance.now();
        this.clipRecorder.start(this.clipT0);
      }
      return;
    }
    if (this.videoRecorder?.isRecording) {
      try {
        const { blob, extension, durationMs } = await this.videoRecorder.stop();
        downloadBlob(blob, timestampedFilename('cameracharacter', extension));
        this.toasts.show(`Video saved (${(durationMs / 1000).toFixed(1)} s).`);
      } catch (err) {
        this.reportError(`Video recording failed: ${(err as Error).message ?? err}`);
      }
      this.videoRecorder = null;
      this.videoMime = null;
    } else if (this.stage) {
      const video = this.sources.mediaPipe?.video ?? null;
      this.videoRecorder = new VideoRecorder({
        source: this.stage.domElement,
        fps: this.recordingOptions.fps,
        pip: this.recordingOptions.pip && video ? { video, mirror: s.stage.mirror, rect: { x: 0.02, y: 0.7, w: 0.25, h: 0.28 } } : null,
        audio: this.recordingOptions.microphone,
        onWarning: (m) => this.toasts.show(m, 'warn', 5000),
      });
      try {
        const { t0, mimeType } = await this.videoRecorder.start();
        this.videoT0 = t0;
        this.videoMime = mimeType;
      } catch (err) {
        this.reportError(`Video recording could not start: ${(err as Error).message ?? err}`);
        this.videoRecorder = null;
      }
    }
  }

  setRecordingOption(key: 'fps' | 'includeEnvironment' | 'pip' | 'microphone', value: number | boolean): void {
    if (key === 'fps') this.recordingOptions.fps = Number(value) === 60 ? 60 : 30;
    else this.recordingOptions[key] = Boolean(value);
  }

  exportTake(): void {
    if (!this.lastTake) return;
    downloadText(serializeRecording(this.lastTake), timestampedFilename('take', 'mocap.json'), 'application/json');
  }

  async exportClipGlb(): Promise<void> {
    if (!this.lastClip || !this.model || !this.stage) return;
    try {
      const take = this.lastClip;
      const bones = take.roles.map((role) => this.model!.bones[role]).filter((b): b is import('three').Object3D => !!b);
      if (bones.length !== take.roles.length) throw new Error('The mapping changed since the take was recorded; record again.');
      const hips = this.model.bones.hips;
      if (!hips) throw new Error('No hips bone mapped.');
      const clip = takeToAnimationClip(take, bones, hips, 'take');
      const buffer = await exportGlbWithTake({
        wrapper: this.model.wrapper,
        applyBindPose: () => this.model!.applyBindPose(),
        clip,
        environment: this.recordingOptions.includeEnvironment ? this.environment?.root ?? null : null,
        renderer: this.stage.renderer,
      });
      downloadArrayBuffer(buffer, timestampedFilename(sanitize(this.model.name), 'glb'), 'model/gltf-binary');
      this.toasts.show('GLB exported with the recorded animation.');
    } catch (err) {
      this.reportError(`GLB export failed: ${(err as Error).message ?? err}`);
    }
  }

  exportBvh(): void {
    if (!this.lastClip) return;
    try {
      downloadText(takeToBvh(this.lastClip), timestampedFilename('take', 'bvh'), 'text/plain');
    } catch (err) {
      this.reportError(`BVH export failed: ${(err as Error).message ?? err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Misc actions
  // ---------------------------------------------------------------------------

  resetSettings(): void {
    this.store.reset();
    this.store.update(settingsPatchFromUrl(this.url));
    this.toasts.show('Settings reset to defaults.');
  }

  togglePanel(): void {
    this.layout.setPanelCollapsed(!this.layout.isPanelCollapsed());
  }

  /** Stops the render loop and every source, recorder and renderer (used by tests and hot reload). */
  stop(): void {
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.sources?.stop();
    if (this.takeRecorder.isRecording) this.lastTake = this.takeRecorder.stop();
    if (this.clipRecorder?.isRecording) this.lastClip = this.clipRecorder.stop();
    this.clipRecorder = null;
    if (this.videoRecorder?.isRecording) void this.videoRecorder.stop().catch(() => undefined);
    this.videoRecorder = null;
    this.stage?.dispose();
    this.stage = null;
  }

  private async handleDroppedFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const lower = file.name.toLowerCase();
      if (/\.(glb|gltf|fbx|vrm)$/.test(lower)) {
        if (this.model && !this.model.unrigged && this.environment === null && lower.includes('env')) await this.loadEnvironmentFile(file);
        else await this.loadModelFile(file);
      } else if (lower.endsWith('.json')) {
        const text = await file.text();
        if (text.includes('cameracharacter-mocap')) {
          await this.loadRecordingFile(file);
        } else if (text.includes('"mapOverrides"')) {
          await this.importProfile(file);
        } else {
          this.toasts.show(`${file.name} is not a take or a profile.`, 'warn');
        }
      } else {
        this.toasts.show(`Unsupported file: ${file.name}`, 'warn');
      }
    }
  }

  private reportError(message: string): void {
    this.errors.push(message);
    if (this.errors.length > 50) this.errors.shift();
    this.toasts?.show(message, 'bad', 7000);
    log.error(message);
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

  // ---------------------------------------------------------------------------
  // Debug state for tests and consoles
  // ---------------------------------------------------------------------------

  getDebugState(): AppDebugState {
    const m = this.model;
    const summary = this.solve && m ? summarize(this.solve, m.analysis) : null;
    return {
      ready: !!this.stage && !this.modelLoading,
      source: { kind: this.sources?.kind ?? 'camera', state: this.lastSourceStatus.state, message: this.lastSourceStatus.message },
      model: m ? { name: m.name, family: m.analysis.family, bones: Object.keys(m.map).length, warnings: m.warnings, unrigged: m.unrigged } : null,
      framesProcessed: this.framesProcessed,
      framesSolved: this.framesSolved,
      present: !!this.pose?.present,
      framing: this.framing?.state ?? 'none',
      maxBoneErrorDeg: summary?.maxErrorDeg ?? null,
      meanBoneErrorDeg: summary?.meanErrorDeg ?? null,
      flaggedBones: summary ? summary.perBone.filter((b) => b.flagged).map((b) => b.role) : [],
      cameraDistance: this.stage ? this.stage.camera.position.distanceTo(new Vector3(0, this.stage.camera.position.y, 0)) : null,
      cameraMode: this.stage?.cameraMode ?? null,
      errors: [...this.errors],
    };
  }

  get settings(): AppSettings {
    return this.store.get();
  }

  static readonly defaults = DEFAULT_SETTINGS;
}

function sanitize(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'model';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
