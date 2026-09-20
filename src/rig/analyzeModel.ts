/**
 * `analyzeModel`: the one call the App makes after loading (docs/DESIGN.md
 * §5.1–§5.6). Bind pose, primary skeleton + skin weights, graph, auto-map,
 * rest analysis, and the wrapper Group that carries the height scale and the
 * root correction. The loaded root itself is never rescaled.
 *
 * Node-safe: it only needs an `Object3D` tree, so tests can feed it the GLB
 * reader's output or a synthetic rig.
 */
import { AnimationClip, Group, Object3D, SkinnedMesh } from 'three';
import type { HumanoidBone, HumanoidMap, RigAnalysis } from '../core/types';
import { HUMANOID_BONES } from '../core/types';
import { autoMapHumanoid } from './autoMap';
import { indexObjectsByName, analyzeRig } from './restPose';
import { applyBindPose, buildRigGraph, defaultExclude, type SkeletonGraph } from './skeletonGraph';

export type ModelFormat = 'glb' | 'gltf' | 'fbx' | 'vrm';

export interface LoadedModel {
  root: Object3D;
  /** File or URL name the model was loaded from. */
  name: string;
  format: ModelFormat;
  skinnedMeshes: SkinnedMesh[];
  animations: AnimationClip[];
  /** Role -> bone name known from the file format (VRM humanoid). */
  humanoidHint?: HumanoidMap;
  /** FBX unit scale factor (cm = 1) when known. */
  unitScaleFactor?: number;
  /** The three-vrm `VRM` instance for .vrm files (typed loosely to keep this module free of the VRM dependency). */
  vrm?: unknown;
}

export interface AnalyzeModelOptions {
  targetHeight: number;
  displayName?: string;
}

export interface AnalyzedModel {
  analysis: RigAnalysis;
  /** Contains `loaded.root`; carries the scale and the root correction. */
  wrapper: Group;
  graph: SkeletonGraph;
  bonesByName: Map<string, Object3D>;
  /** Re-applies the bind pose to every joint (GLB export, calibration UI). */
  applyBindPose(): void;
  /** Bone objects for a (possibly overridden) humanoid map; missing names are skipped. */
  bonesForMap(map: HumanoidMap): Partial<Record<HumanoidBone, Object3D>>;
}

/** Family hints recorded by the loader on `root.userData` (generator, mesh names). */
function familyHints(loaded: LoadedModel): { generator?: string; meshNames?: string[]; vrm?: boolean } {
  const ud = loaded.root.userData ?? {};
  const meshNames: string[] = Array.isArray(ud.meshNames) ? (ud.meshNames as string[]) : [];
  if (meshNames.length === 0) loaded.root.traverse((o) => {
    if ((o as SkinnedMesh).isMesh && o.name) meshNames.push(o.name);
  });
  const generator = typeof ud.generator === 'string' ? (ud.generator as string) : undefined;
  return { generator, meshNames, vrm: loaded.format === 'vrm' };
}

export function analyzeModel(loaded: LoadedModel, opts: AnalyzeModelOptions): AnalyzedModel {
  const root = loaded.root;
  const exclude = defaultExclude;
  // Analysis runs with the loader root at identity (§5.3).
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);

  const bind = applyBindPose(root, { exclude });
  const graph = buildRigGraph(root, exclude);
  for (const w of bind.warnings) if (!graph.warnings.includes(w)) graph.warnings.push(w);

  const auto = autoMapHumanoid(graph, {
    hint: loaded.humanoidHint,
    vrm: loaded.format === 'vrm',
    family: familyHints(loaded),
  });
  const analysis = analyzeRig(root, auto, {
    targetHeight: opts.targetHeight,
    displayName: opts.displayName ?? loaded.name,
    graph,
    skipBindPose: true,
    unitScaleFactor: loaded.unitScaleFactor,
    exclude,
  });

  const wrapper = new Group();
  wrapper.name = 'ModelWrapper';
  wrapper.add(root);
  wrapper.quaternion.fromArray(analysis.rootCorrection);
  wrapper.scale.setScalar(analysis.scale);
  wrapper.updateMatrixWorld(true);

  const bonesByName = indexObjectsByName(root);
  const bonesForMap = (map: HumanoidMap): Partial<Record<HumanoidBone, Object3D>> => {
    const out: Partial<Record<HumanoidBone, Object3D>> = {};
    for (const role of HUMANOID_BONES) {
      const name = map[role];
      if (!name) continue;
      const obj = bonesByName.get(name);
      if (obj) out[role] = obj;
    }
    return out;
  };

  return {
    analysis,
    wrapper,
    graph,
    bonesByName,
    applyBindPose: () => {
      applyBindPose(root, { exclude });
      wrapper.updateMatrixWorld(true);
    },
    bonesForMap,
  };
}
