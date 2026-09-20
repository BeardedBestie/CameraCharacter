/**
 * A loaded, analyzed model with its profile (user intent) and retargeter.
 */
import type { Group, Object3D, WebGLRenderer } from 'three';
import {
  BODY_BONES,
  type BoneRefMode,
  type BoneSettings,
  type HipsMode,
  type HumanoidBone,
  type HumanoidMap,
  type PoseCalibration,
  type RigAnalysis,
  type RigProfile,
  type SmoothingSettings,
  mirrorBone,
} from '../core/types';
import { Retargeter, type SolveResult } from '../retarget/solver';
import {
  ProfileStore,
  analyzeModel,
  applyProfile,
  createRigProfile,
  exportProfileJson,
  importProfileJson,
  loadModel,
  type AnalyzedModel,
  type LoadedModel,
} from '../rig';
import type { MappingRow, ModelVM } from './actions';

export interface ModelSessionOptions {
  targetHeight: number;
  smoothing: SmoothingSettings;
  hipsMode: HipsMode;
  cameraVfovDeg: number;
  depthTranslation: boolean;
  profileStore: ProfileStore;
  renderer?: WebGLRenderer;
  displayName?: string;
  onProgress?: (fraction: number) => void;
}

export class ModelSession {
  readonly name: string;
  readonly loaded: LoadedModel;
  readonly analyzed: AnalyzedModel;
  readonly analysis: RigAnalysis;
  profile: RigProfile;
  map: HumanoidMap = {};
  boneSettings: Partial<Record<HumanoidBone, BoneSettings>> = {};
  bones: Partial<Record<HumanoidBone, Object3D>> = {};
  warnings: string[] = [];
  retargeter: Retargeter | null = null;
  private opts: ModelSessionOptions;

  private constructor(loaded: LoadedModel, analyzed: AnalyzedModel, opts: ModelSessionOptions) {
    this.loaded = loaded;
    this.analyzed = analyzed;
    this.analysis = analyzed.analysis;
    this.name = opts.displayName ?? loaded.name;
    this.opts = opts;
    this.profile = opts.profileStore.load(this.analysis.instanceKey, this.analysis.familyKey) ?? createRigProfile(this.analysis);
    this.profile.displayName = this.name;
    this.applyProfile();
  }

  static async load(source: File | string, opts: ModelSessionOptions): Promise<ModelSession> {
    const loaded = await loadModel(source, { onProgress: opts.onProgress, renderer: opts.renderer });
    const analyzed = analyzeModel(loaded, { targetHeight: opts.targetHeight, displayName: opts.displayName ?? loaded.name });
    return new ModelSession(loaded, analyzed, opts);
  }

  get wrapper(): Group {
    return this.analyzed.wrapper;
  }

  get unrigged(): boolean {
    return this.analysis.unrigged;
  }

  /** Recomputes the effective map/bone settings from the analysis plus the profile and rebuilds the retargeter. */
  applyProfile(): void {
    const eff = applyProfile(this.analysis, this.profile);
    this.map = eff.map;
    this.boneSettings = eff.boneSettings;
    this.warnings = [...this.analysis.warnings, ...eff.warnings];
    this.bones = this.unrigged ? {} : this.analyzed.bonesForMap(this.map);
    this.rebuildRetargeter();
  }

  rebuildRetargeter(): void {
    if (this.unrigged || !this.bones.hips) {
      this.retargeter = null;
      return;
    }
    const prevBaseline = this.retargeter ? null : undefined;
    this.retargeter = new Retargeter({
      bones: this.bones,
      analysis: { ...this.analysis, map: this.map },
      settings: this.opts.smoothing,
      boneSettings: this.boneSettings,
      calibration: this.profile.calibration,
      hipsMode: this.opts.hipsMode,
      cameraVfovDeg: this.opts.cameraVfovDeg,
      depthTranslation: this.opts.depthTranslation,
      torsoBaseline: prevBaseline,
    });
  }

  updateOptions(patch: Partial<Pick<ModelSessionOptions, 'smoothing' | 'hipsMode' | 'cameraVfovDeg' | 'depthTranslation'>>): void {
    Object.assign(this.opts, patch);
    const r = this.retargeter;
    if (!r) return;
    if (patch.smoothing) r.setSettings(patch.smoothing);
    if (patch.hipsMode) r.setHipsMode(patch.hipsMode);
    if (patch.cameraVfovDeg !== undefined) r.setCameraVfovDeg(patch.cameraVfovDeg);
    if (patch.depthTranslation !== undefined) r.setDepthTranslation(patch.depthTranslation);
  }

  setMappingOverride(role: HumanoidBone, boneName: string | null): void {
    if (boneName === null || boneName === this.analysis.map[role]) delete this.profile.mapOverrides[role];
    else this.profile.mapOverrides[role] = boneName;
    this.save();
    this.applyProfile();
  }

  swapSides(): void {
    this.profile.swapSides = !this.profile.swapSides;
    this.save();
    this.applyProfile();
  }

  resetMapping(): void {
    this.profile.mapOverrides = {};
    this.profile.swapSides = false;
    this.save();
    this.applyProfile();
  }

  setBoneMode(role: HumanoidBone, mode: BoneRefMode): void {
    const cur = this.boneSettings[role] ?? this.analysis.defaultBones[role] ?? { mode: 'auto', rollOffsetDeg: 0 };
    this.profile.bones[role] = { ...cur, mode };
    this.save();
    this.applyProfile();
  }

  setBoneRoll(role: HumanoidBone, deg: number): void {
    const cur = this.boneSettings[role] ?? this.analysis.defaultBones[role] ?? { mode: 'auto', rollOffsetDeg: 0 };
    this.profile.bones[role] = { ...cur, rollOffsetDeg: deg };
    this.save();
    this.applyProfile();
  }

  resetBoneSettings(): void {
    this.profile.bones = {};
    this.save();
    this.applyProfile();
  }

  setCalibration(calibration: PoseCalibration | null): void {
    this.profile.calibration = calibration;
    this.save();
    this.retargeter?.setCalibration(calibration);
  }

  save(): void {
    this.profile.updatedAt = new Date().toISOString();
    this.opts.profileStore.save(this.profile);
  }

  exportProfileJson(): string {
    return exportProfileJson(this.profile);
  }

  importProfile(text: string): void {
    const imported = importProfileJson(text);
    this.profile = { ...imported, familyKey: this.analysis.familyKey, instanceKey: this.analysis.instanceKey, displayName: this.name };
    this.save();
    this.applyProfile();
  }

  /** Bone names available for mapping overrides. */
  boneNames(): string[] {
    return Array.from(this.analyzed.bonesByName.keys()).sort();
  }

  mappingRows(solve: SolveResult | null): MappingRow[] {
    const rows: MappingRow[] = [];
    for (const role of BODY_BONES) {
      const bone = this.map[role] ?? null;
      const settings = this.boneSettings[role] ?? this.analysis.defaultBones[role];
      const analysisRole = this.profile.swapSides ? mirrorBone(role) : role;
      const per = solve?.perRole[role];
      rows.push({
        role,
        bone,
        confidence: this.analysis.confidence[analysisRole] ?? (bone ? 0.5 : 0),
        mode: settings?.mode ?? 'auto',
        rollOffsetDeg: settings?.rollOffsetDeg ?? 0,
        anatomical: this.analysis.analysis[analysisRole]?.anatomical ?? null,
        errorDeg: per && per.confidence > 0.5 ? per.errorDeg : null,
        overridden: this.profile.mapOverrides[role] !== undefined,
      });
    }
    return rows;
  }

  viewModel(solve: SolveResult | null, environmentName: string | null, loading = false, progress: number | null = null): ModelVM {
    return {
      name: this.name,
      loading,
      progress,
      family: this.analysis.family,
      familyKey: this.analysis.familyKey,
      warnings: this.warnings,
      rows: this.unrigged ? [] : this.mappingRows(solve),
      boneNames: this.boneNames(),
      unrigged: this.unrigged,
      sourceHeight: this.analysis.sourceHeight,
      scale: this.analysis.scale,
      environmentName,
    };
  }

  applyBindPose(): void {
    this.analyzed.applyBindPose();
    this.wrapper.updateMatrixWorld(true);
  }

  dispose(): void {
    this.wrapper.traverse((node) => {
      const mesh = node as { geometry?: { dispose(): void }; material?: unknown };
      mesh.geometry?.dispose?.();
      const mat = mesh.material as { dispose?: () => void } | { dispose?: () => void }[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    });
  }
}
