/**
 * Bundled family-level map overrides (docs/DESIGN.md §5.6). A preset entry is
 * applied by the auto mapper only when the named bone exists in the graph, the
 * role is still unmapped and the entry is hierarchy-consistent with the chain
 * result; the chain decides otherwise (the scrambled `skeleton.glb` keeps its
 * chain roles even though its names match the Meshy preset).
 */
import type { HumanoidBone, HumanoidMap, RigFamily } from '../core/types';

const MIXAMO_BASE: Record<string, string> = {
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Spine1',
  upperChest: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  leftShoulder: 'LeftShoulder',
  leftUpperArm: 'LeftArm',
  leftLowerArm: 'LeftForeArm',
  leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder',
  rightUpperArm: 'RightArm',
  rightLowerArm: 'RightForeArm',
  rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg',
  leftLowerLeg: 'LeftLeg',
  leftFoot: 'LeftFoot',
  leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg',
  rightLowerLeg: 'RightLeg',
  rightFoot: 'RightFoot',
  rightToes: 'RightToeBase',
  leftThumbMetacarpal: 'LeftHandThumb1',
  leftThumbProximal: 'LeftHandThumb2',
  leftThumbDistal: 'LeftHandThumb3',
  leftIndexProximal: 'LeftHandIndex1',
  leftIndexIntermediate: 'LeftHandIndex2',
  leftIndexDistal: 'LeftHandIndex3',
  leftMiddleProximal: 'LeftHandMiddle1',
  leftMiddleIntermediate: 'LeftHandMiddle2',
  leftMiddleDistal: 'LeftHandMiddle3',
  leftRingProximal: 'LeftHandRing1',
  leftRingIntermediate: 'LeftHandRing2',
  leftRingDistal: 'LeftHandRing3',
  leftLittleProximal: 'LeftHandPinky1',
  leftLittleIntermediate: 'LeftHandPinky2',
  leftLittleDistal: 'LeftHandPinky3',
  rightThumbMetacarpal: 'RightHandThumb1',
  rightThumbProximal: 'RightHandThumb2',
  rightThumbDistal: 'RightHandThumb3',
  rightIndexProximal: 'RightHandIndex1',
  rightIndexIntermediate: 'RightHandIndex2',
  rightIndexDistal: 'RightHandIndex3',
  rightMiddleProximal: 'RightHandMiddle1',
  rightMiddleIntermediate: 'RightHandMiddle2',
  rightMiddleDistal: 'RightHandMiddle3',
  rightRingProximal: 'RightHandRing1',
  rightRingIntermediate: 'RightHandRing2',
  rightRingDistal: 'RightHandRing3',
  rightLittleProximal: 'RightHandPinky1',
  rightLittleIntermediate: 'RightHandPinky2',
  rightLittleDistal: 'RightHandPinky3',
};

/** Meshy / bundled game-parts export: spine numbered from the hips upward (Spine02 -> Spine01 -> Spine). */
const MESHY_BASE: Record<string, string> = {
  ...MIXAMO_BASE,
  spine: 'Spine02',
  chest: 'Spine01',
  upperChest: 'Spine',
  neck: 'neck',
};
delete (MESHY_BASE as Record<string, string | undefined>).leftThumbMetacarpal;

function withPrefix(base: Record<string, string>, prefix: string): HumanoidMap {
  const out: HumanoidMap = {};
  for (const [role, name] of Object.entries(base)) out[role as HumanoidBone] = prefix + name;
  return out;
}

/** Mixamo skeleton with the `mixamorig:` namespace (GLB/FBX from mixamo.com). */
export const MIXAMO_PRESET: HumanoidMap = withPrefix(MIXAMO_BASE, 'mixamorig:');
/** Mixamo naming without the namespace (Ready Player Me, many Blender re-exports). */
export const MIXAMO_UNPREFIXED_PRESET: HumanoidMap = withPrefix(MIXAMO_BASE, '');
/** Mixamo names as FBXLoader delivers them (the colon is dropped). */
export const MIXAMO_FBX_PRESET: HumanoidMap = withPrefix(MIXAMO_BASE, 'mixamorig');
/** Meshy.ai auto-rig and the bundled game-parts pack. */
export const MESHY_PRESET: HumanoidMap = withPrefix(MESHY_BASE, '');

export interface PresetMatch {
  family: RigFamily;
  name: string;
  map: HumanoidMap;
}

const MIXAMO_PREFIX = /^(mixamorig\d*:?)(Hips|Spine|Head|LeftArm|RightArm|LeftUpLeg|RightUpLeg)$/i;

/**
 * Returns the preset that fits a rig family and its bone names, or null.
 * The Mixamo preset adapts to any `mixamorig<N>:` namespace variant and to the
 * colon-less FBX form (`mixamorigHips`).
 */
export function presetFor(family: RigFamily, names: readonly string[]): PresetMatch | null {
  const set = new Set(names);
  if (family === 'mixamo') {
    for (const n of names) {
      const m = MIXAMO_PREFIX.exec(n);
      if (m) return { family, name: `mixamo (${m[1]})`, map: withPrefix(MIXAMO_BASE, m[1]) };
    }
    if (set.has('Hips') && set.has('LeftArm')) return { family, name: 'mixamo (unprefixed)', map: MIXAMO_UNPREFIXED_PRESET };
    return null;
  }
  if (family === 'meshy' || family === 'game-parts') {
    if (set.has('Spine02') && set.has('Hips')) return { family, name: family, map: MESHY_PRESET };
    return null;
  }
  return null;
}

export const PRESETS: Readonly<Record<string, HumanoidMap>> = {
  mixamo: MIXAMO_PRESET,
  'mixamo-fbx': MIXAMO_FBX_PRESET,
  'mixamo-unprefixed': MIXAMO_UNPREFIXED_PRESET,
  meshy: MESHY_PRESET,
};
