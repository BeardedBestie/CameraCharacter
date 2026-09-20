import { describe, expect, it } from 'vitest';
import { classifyBone, detectFamily, isSegmentOf, normalizedName, parseBoneName, stripPrefix, tokenize } from '../../src/rig/boneNames';

const leaf0 = { isLeaf: true, weight: 0, hasWeights: true };
const weighted = { isLeaf: false, weight: 3, hasWeights: true };

describe('prefix stripping and tokenization', () => {
  it('strips true namespace prefixes only', () => {
    expect(stripPrefix('mixamorig:Hips').stripped).toBe('Hips');
    expect(stripPrefix('mixamorigHips').stripped).toBe('Hips');
    expect(stripPrefix('mixamorig1:LeftArm').stripped).toBe('LeftArm');
    expect(stripPrefix('DEF-upper_arm.L').stripped).toBe('upper_arm.L');
    expect(stripPrefix('ORG-spine').stripped).toBe('spine');
    expect(stripPrefix('MCH-thigh_ik.L').stripped).toBe('thigh_ik.L');
    expect(stripPrefix('CC_Base_L_Upperarm').stripped).toBe('L_Upperarm');
    expect(stripPrefix('Character1_LeftHand').stripped).toBe('LeftHand');
    expect(stripPrefix('Genesis8Female_lShldrBend').stripped).toBe('lShldrBend');
    expect(stripPrefix('Bip001 L Thigh').stripped).toBe('L Thigh');
    expect(stripPrefix('b_LeftHand').stripped).toBe('LeftHand');
    expect(stripPrefix('bone_head').stripped).toBe('head');
    expect(stripPrefix('Armature|Hips').stripped).toBe('Armature|Hips');
    expect(stripPrefix('Armature_Hips').stripped).toBe('Armature_Hips');
    expect(stripPrefix('root|Hips').stripped).toBe('root|Hips');
  });

  it('J_Bip_ keeps the C_/L_/R_ token as the side', () => {
    expect(stripPrefix('J_Bip_L_UpperArm')).toEqual({ stripped: 'UpperArm', side: 'left' });
    expect(stripPrefix('J_Bip_R_Foot')).toEqual({ stripped: 'Foot', side: 'right' });
    expect(stripPrefix('J_Bip_C_Spine')).toEqual({ stripped: 'Spine', side: 'center' });
  });

  it('detects sides in every convention', () => {
    expect(tokenize('LeftUpLeg').side).toBe('left');
    expect(tokenize('upperarm_l').side).toBe('left');
    expect(tokenize('thigh_r').side).toBe('right');
    expect(tokenize('upper_arm.L').side).toBe('left');
    expect(tokenize('L_Thigh').side).toBe('left');
    expect(tokenize('lShldrBend').side).toBe('left');
    expect(tokenize('rForearmTwist').side).toBe('right');
    expect(tokenize('left_hip').side).toBe('left');
    expect(tokenize('Spine').side).toBeNull();
    expect(tokenize('leftfoot').side).toBe('left');
  });

  it('merges lexicon phrases longest first and splits digits', () => {
    expect(tokenize('LeftForeArm').tokens).toEqual(['forearm']);
    expect(tokenize('LeftUpLeg').tokens).toEqual(['upleg']);
    expect(tokenize('LeftToeBase').tokens).toEqual(['toebase']);
    expect(tokenize('HeadTop_End').tokens).toEqual(['headtop', 'end']);
    expect(tokenize('UpperChest').tokens).toEqual(['upperchest']);
    expect(tokenize('Spine2').tokens).toEqual(['spine', '2']);
    expect(tokenize('LeftHandIndex3').tokens).toEqual(['hand', 'index', '3']);
    expect(tokenize('center_of_mass').tokens).toEqual(['centerofmass']);
    expect(tokenize('calf_kneeBack_l').tokens).toEqual(['calf', 'kneeback']);
  });
});

describe('classification', () => {
  it('classes and keywords', () => {
    expect(parseBoneName('mixamorig:Hips').class).toBe('torso');
    expect(parseBoneName('mixamorig:LeftForeArm').class).toBe('armL');
    expect(parseBoneName('RightUpLeg').class).toBe('legR');
    expect(parseBoneName('upperarm_l').class).toBe('armL');
    expect(parseBoneName('calf_r').class).toBe('legR');
    expect(parseBoneName('pelvis').class).toBe('torso');
    expect(parseBoneName('left_hip').class).toBe('legL');
    expect(parseBoneName('DEF-pelvis.L').class).toBe('unknown');
    expect(parseBoneName('neck_01').class).toBe('torso');
    expect(parseBoneName('CC_Base_NeckTwist01').class).toBe('torso');
    expect(parseBoneName('abdomenLower').class).toBe('torso');
    expect(parseBoneName('lCollar').class).toBe('armL');
    expect(parseBoneName('Bone.001').class).toBe('unknown');
    expect(parseBoneName('LeftEye').class).toBe('face');
    expect(parseBoneName('CC_Base_JawRoot').class).toBe('face');
  });

  it('fingers: digit token pre-empts hand, segment from words or 1..4 ordinals', () => {
    const t1 = parseBoneName('LeftHandThumb1');
    expect(t1.class).toBe('finger');
    expect(t1.finger).toEqual({ digit: 'Thumb', segment: 'Metacarpal', ordinal: 1 });
    expect(parseBoneName('LeftHandIndex2').finger).toEqual({ digit: 'Index', segment: 'Intermediate', ordinal: 2 });
    expect(parseBoneName('index_metacarpal_l').finger).toEqual({ digit: 'Index', segment: 'Metacarpal', ordinal: null });
    expect(parseBoneName('pinky_03_r').finger).toEqual({ digit: 'Little', segment: 'Distal', ordinal: 3 });
    expect(parseBoneName('CC_Base_L_Mid1').finger?.digit).toBe('Middle');
    expect(parseBoneName('DEF-f_ring.02.L').finger).toEqual({ digit: 'Ring', segment: 'Intermediate', ordinal: 2 });
    // "middle" without a hand cue is not a finger (e.g. a middle spine bone).
    expect(parseBoneName('MiddleSpine').class).toBe('torso');
    expect(parseBoneName('lSmallToe2').class).toBe('legL');
  });

  it('helper classification on whole tokens with skin weights', () => {
    expect(classifyBone('HeadTop_End', leaf0).class).toBe('marker');
    expect(classifyBone('LeftToe_End', leaf0).class).toBe('marker');
    expect(classifyBone('LeftHandThumb4', leaf0).class).toBe('marker');
    expect(classifyBone('LeftHandThumb4', { isLeaf: true, weight: 2, hasWeights: true }).class).toBe('finger');
    // A weighted "end" bone is a real link.
    expect(classifyBone('Tail_End', { isLeaf: false, weight: 5, hasWeights: true }).class).not.toBe('marker');
    // bend is never a marker token.
    expect(classifyBone('lShldrBend', weighted).class).toBe('armL');
    expect(classifyBone('lShldrBend', weighted).stem).toBe('shldr');
    // Ignore class wins over any lexicon match.
    for (const n of ['ik_foot_l', 'hand_ik.L', 'MCH-thigh_ik.L', 'thigh_fk.L', 'tweak_spine', 'ctrl_arm', 'arm_ctl', 'pole_target', 'weapon_r', 'foot_socket', 'center_of_mass', 'interaction', 'heel.02.L', 'ankle_bck_l', 'J_Sec_Hair1_01', 'J_Adj_L_FaceEye', 'DEF-breast.L', 'J_Sec_L_Bust1', 'skirt_front', 'tail_01', 'wing_l', 'eyelid_L', 'spine_04_latissimus_l', 'clavicle_scap_l', 'wrist_inner_l', 'calf_kneeBack_l', 'lPectoral']) {
      expect(classifyBone(n, weighted).class, n).toBe('ignore');
    }
  });

  it('segment/twist merge rule: same stem and side as the parent', () => {
    const p = (n: string) => parseBoneName(n);
    expect(isSegmentOf(p('lShldrTwist'), p('lShldrBend'))).toBe(true);
    expect(isSegmentOf(p('DEF-upper_arm.L.001'), p('DEF-upper_arm.L'))).toBe(true);
    expect(isSegmentOf(p('upperarm_twist_01_l'), p('upperarm_l'))).toBe(true);
    expect(isSegmentOf(p('CC_Base_L_ForearmTwist01'), p('CC_Base_L_Forearm'))).toBe(true);
    expect(isSegmentOf(p('lForearmBend'), p('lShldrTwist'))).toBe(false);
    expect(isSegmentOf(p('CC_Base_NeckTwist02'), p('CC_Base_NeckTwist01'))).toBe(false); // unsided torso chain
    expect(isSegmentOf(p('CC_Base_NeckTwist01'), p('CC_Base_Spine02'))).toBe(false);
    expect(isSegmentOf(p('DEF-spine.001'), p('DEF-spine'))).toBe(false);
    expect(isSegmentOf(p('DEF-forearm.L'), p('DEF-upper_arm.L.001'))).toBe(false);
  });

  it('normalized names and family detection', () => {
    expect(normalizedName('mixamorig:LeftForeArm')).toBe('leftforearm');
    expect(normalizedName('DEF-upper_arm.L')).toBe('upperarml');
    expect(detectFamily(['mixamorig:Hips', 'mixamorig:LeftArm'])).toBe('mixamo');
    expect(detectFamily(['mixamorigHips', 'mixamorigLeftArm'])).toBe('mixamo');
    expect(detectFamily(['Hips', 'Spine02', 'Spine'], { generator: 'compress_glb.py (Game-Parts-Work)' })).toBe('game-parts');
    expect(detectFamily(['Hips', 'Spine02', 'Spine'], { meshNames: ['part_torso'] })).toBe('game-parts');
    expect(detectFamily(['Hips', 'Spine02', 'Spine'], { generator: 'Khronos glTF Blender I/O' })).toBe('meshy');
    expect(detectFamily(['J_Bip_C_Hips'])).toBe('vrm');
    expect(detectFamily(['Hips'], { vrm: true })).toBe('vrm');
  });
});
