/**
 * Known-good humanoid maps for well-known rig families. Used by the auto
 * mapper as a tie-breaker/validation when the detected family matches: a
 * preset entry overrides the detected role only when that bone name exists in
 * the graph.
 */
import type { HumanoidBone, HumanoidMap, RigProfile } from '../core/types';

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

function withPrefix(base: Record<string, string>, prefix: string): HumanoidMap {
  const out: HumanoidMap = {};
  for (const [role, name] of Object.entries(base)) out[role as HumanoidBone] = prefix + name;
  return out;
}

/** Mixamo skeleton with the `mixamorig:` namespace (FBX/GLB from mixamo.com). */
export const MIXAMO_PRESET: HumanoidMap = withPrefix(MIXAMO_BASE, 'mixamorig:');
/** Mixamo naming without the namespace (Ready Player Me, many Blender re-exports). */
export const MIXAMO_UNPREFIXED_PRESET: HumanoidMap = withPrefix(MIXAMO_BASE, '');

/** Meshy.ai auto-rig export (spine numbered from the hips upward: Spine02 -> Spine01 -> Spine). */
export const MESHY_PRESET: HumanoidMap = {
  hips: 'Hips',
  spine: 'Spine02',
  chest: 'Spine01',
  upperChest: 'Spine',
  neck: 'neck',
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
};

export interface PresetMatch {
  family: RigProfile['family'];
  name: string;
  map: HumanoidMap;
}

/**
 * Returns the preset that fits a rig family and its bone names, or null.
 * The Mixamo preset adapts to any `mixamorig<N>:` namespace variant.
 */
export function presetFor(family: RigProfile['family'], names: readonly string[]): PresetMatch | null {
  const set = new Set(names);
  if (family === 'mixamo') {
    const prefixed = names.find((n) => /^mixamorig\d*:/i.test(n));
    if (prefixed) {
      const prefix = /^mixamorig\d*:/i.exec(prefixed)![0];
      return { family, name: `mixamo (${prefix})`, map: withPrefix(MIXAMO_BASE, prefix) };
    }
    if (set.has('Hips') && set.has('LeftArm')) return { family, name: 'mixamo (unprefixed)', map: MIXAMO_UNPREFIXED_PRESET };
    return null;
  }
  if (family === 'meshy') {
    if (set.has('Spine02') && set.has('Hips')) return { family, name: 'meshy', map: MESHY_PRESET };
    return null;
  }
  return null;
}

export const PRESETS: Readonly<Record<string, HumanoidMap>> = {
  mixamo: MIXAMO_PRESET,
  'mixamo-unprefixed': MIXAMO_UNPREFIXED_PRESET,
  meshy: MESHY_PRESET,
};
