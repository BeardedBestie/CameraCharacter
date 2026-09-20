/**
 * Hand-built solver results and rig analyses for the diagnostics tests (three
 * math objects only; no solver run needed).
 */
import { Quaternion, Vector3 } from 'three';
import type { FilteredPose } from '../../src/core/pose';
import type { BoneRefMode, HumanoidBone, RigAnalysis } from '../../src/core/types';
import { HUMANOID_SOLVE_ORDER } from '../../src/core/types';
import { DEG2RAD } from '../../src/core/math';
import type { SolveResult, SolveRoleResult } from '../../src/retarget/solver';
import { POSE_LANDMARK_COUNT } from '../../src/tracking/landmarks';
import { framePose, standingPose } from '../../src/testing/syntheticHuman';
import { filteredFromFrame } from '../retarget/helpers';

export interface RoleSpec {
  errorDeg?: number | null;
  confidence?: number;
  cU?: number;
  mode?: BoneRefMode;
  source?: string;
}

/** A role result whose solved direction is `errorDeg` away from the measured direction (+Y). */
export function makeRole(spec: RoleSpec = {}): SolveRoleResult {
  const errorDeg = spec.errorDeg === undefined ? 0 : spec.errorDeg;
  const measuredDir = errorDeg === null ? null : new Vector3(0, 1, 0);
  const solvedDir = errorDeg === null ? null : new Vector3(Math.sin(errorDeg * DEG2RAD), Math.cos(errorDeg * DEG2RAD), 0);
  return {
    worldQuat: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (errorDeg ?? 0) * DEG2RAD),
    localQuat: new Quaternion(),
    measuredDir,
    solvedDir,
    errorDeg,
    confidence: spec.confidence ?? 0.9,
    cU: spec.cU ?? 0.8,
    mode: spec.mode ?? 'auto',
    source: spec.source ?? 'measured',
  };
}

export function makeSolve(roles: Partial<Record<HumanoidBone, RoleSpec>>, overrides: Partial<SolveResult> = {}): SolveResult {
  const perRole: Partial<Record<HumanoidBone, SolveRoleResult>> = {};
  const order = HUMANOID_SOLVE_ORDER.filter((r) => roles[r] !== undefined);
  for (const r of order) perRole[r] = makeRole(roles[r]);
  return {
    roles: order,
    perRole,
    chainErrorDeg: { leftArm: 1.5, rightArm: null, leftLeg: 0.4, rightLeg: 7.2 },
    hipsWorldPos: new Vector3(0.05, 0.95, -0.02),
    depthZ: 2.4,
    framing: 'full',
    ...overrides,
  };
}

/** A minimal RigAnalysis with a map for the given roles. */
export function makeAnalysis(roles: readonly HumanoidBone[]): RigAnalysis {
  const map: Partial<Record<HumanoidBone, string>> = {};
  const analysis: RigAnalysis['analysis'] = {};
  const defaultBones: RigAnalysis['defaultBones'] = {};
  for (const r of roles) {
    map[r] = `mixamorig:${r}`;
    analysis[r] = {
      name: map[r]!,
      restDir: r.endsWith('Leg') ? [0, -1, 0] : r.startsWith('left') ? [1, 0, 0] : r.startsWith('right') ? [-1, 0, 0] : [0, 1, 0],
      restUp: [0, 0, 1],
      restQuat: [0, 0, 0, 1],
      restPos: [0, 1, 0],
      length: 0.3,
      canonicalDeviationDeg: 0,
      anatomical: true,
      parentRole: null,
      childRole: null,
      intermediateCount: 0,
    };
    defaultBones[r] = { mode: /^(hips|spine|chest|upperChest|neck|head)$/.test(r) ? 'relative' : 'auto', rollOffsetDeg: 0 };
  }
  return {
    familyKey: 'fam',
    instanceKey: 'fam-inst',
    displayName: 'Test rig',
    family: 'mixamo',
    map,
    confidence: Object.fromEntries(roles.map((r) => [r, 0.95])),
    warnings: ['facing assumed'],
    axes: { up: [0, 1, 0], forward: [0, 0, 1], facingSource: 'assumed' },
    rootCorrection: [0, 0, 0, 1],
    scale: 1,
    sourceHeight: 1.7,
    analysis,
    heightTable: { floor: 0, ankles: 0.08, knees: 0.48, hips: 0.95, shoulders: 1.42, eyes: 1.62, headTop: 1.72 },
    noKnee: { left: false, right: false },
    noElbow: { left: false, right: false },
    hasForearmTwist: { left: false, right: false },
    defaultBones,
    boneCount: roles.length,
    skinnedMeshCount: 1,
    unrigged: false,
  };
}

/** A standing synthetic subject as a FilteredPose (all landmarks gated). */
export function standingFiltered(mirror = false): FilteredPose {
  const pose = filteredFromFrame(framePose(standingPose({}), 0), { mirror });
  if (pose.world.length !== POSE_LANDMARK_COUNT) throw new Error('unexpected landmark count');
  return pose;
}
