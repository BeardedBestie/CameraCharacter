import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { HumanoidBone } from '../../src/core/types';
import { BODY_BONES, HUMANOID_BONES, REQUIRED_BONES, isFingerBone } from '../../src/core/types';
import { autoMapHumanoid, remapAutoResult } from '../../src/rig/autoMap';
import { analyzeTopology } from '../../src/rig/topology';
import { analyzeRig } from '../../src/rig/restPose';
import {
  BLENDER_METARIG,
  CC4,
  FACING_NEG_Z,
  GENESIS8,
  MESHY,
  MIXAMO_FBX,
  MIXAMO_PREFIXED,
  NAMELESS,
  NAME_FIXTURES,
  READY_PLAYER_ME,
  RIGIFY_DEF,
  RIGIFY_FULL,
  SMPL,
  UE5_MANNEQUIN,
  VROID,
  Z_UP,
  buildFixtureGraph,
  buildFixtureObject,
  mixamoFixture,
  type RigFixture,
} from '../fixtures/rigNames';

function expectMapMatches(fixture: RigFixture, map: Record<string, string | undefined>, roles: readonly HumanoidBone[] = HUMANOID_BONES): void {
  const problems: string[] = [];
  for (const role of roles) {
    const want = fixture.expect[role];
    const got = map[role];
    if (want !== got) problems.push(`${role}: expected ${want ?? '(unmapped)'}, got ${got ?? '(unmapped)'}`);
  }
  expect(problems, `${fixture.name}\n${problems.join('\n')}`).toEqual([]);
}

function expectHelpersUnmapped(fixture: RigFixture, map: Record<string, string | undefined>): void {
  const mapped = new Set(Object.values(map));
  const leaked = fixture.helpers.filter((h) => mapped.has(h));
  expect(leaked, `${fixture.name}: helper bones mapped: ${leaked.join(', ')}`).toEqual([]);
}

describe('autoMapHumanoid on name/hierarchy fixtures', () => {
  for (const fixture of NAME_FIXTURES) {
    it(`maps ${fixture.name}`, () => {
      const graph = buildFixtureGraph(fixture.bones);
      const res = autoMapHumanoid(graph);
      expectMapMatches(fixture, res.map);
      expectHelpersUnmapped(fixture, res.map);
      expect(res.axes.up).toEqual([0, 1, 0]);
      expect(res.axes.forward[2]).toBeCloseTo(1, 5);
      expect(res.left[0]).toBeCloseTo(1, 5);
      expect(res.unrigged).toBe(false);
      for (const r of REQUIRED_BONES) expect(res.map[r], `${fixture.name}: ${r}`).toBeDefined();
      expect(res.noKnee).toEqual({ left: false, right: false });
      expect(res.noElbow).toEqual({ left: false, right: false });
    });
  }

  it('reports high confidence when names agree with the chain and topology-only confidence for nameless rigs', () => {
    const named = autoMapHumanoid(buildFixtureGraph(MIXAMO_PREFIXED.bones));
    for (const r of BODY_BONES) if (named.map[r]) expect(named.confidence[r]).toBeCloseTo(0.95, 5);
    const nameless = autoMapHumanoid(buildFixtureGraph(NAMELESS.bones));
    for (const r of BODY_BONES) if (nameless.map[r]) expect(nameless.confidence[r]).toBeCloseTo(0.7, 5);
    // Unsided names: the toes decide the facing; without toes it is assumed (+Z) with a warning.
    expect(nameless.axes.facingSource).toBe('toes');
    const noToes = NAMELESS.bones.filter((b) => !['Bone.013', 'Bone.014', 'Bone.022', 'Bone.023'].includes(b.name));
    const assumed = autoMapHumanoid(buildFixtureGraph(noToes));
    expect(assumed.axes.facingSource).toBe('assumed');
    expect(assumed.warnings.some((w) => /facing assumed/i.test(w))).toBe(true);
    expect(assumed.map.leftUpperArm).toBe(NAMELESS.expect.leftUpperArm);
    expect(assumed.map.leftFoot).toBe(NAMELESS.expect.leftFoot);
    expect(named.axes.facingSource).toBe('names');
  });

  it('detects the rig family from names', () => {
    const fam = (f: RigFixture) => autoMapHumanoid(buildFixtureGraph(f.bones)).family;
    expect(fam(MIXAMO_PREFIXED)).toBe('mixamo');
    expect(fam(MIXAMO_FBX)).toBe('mixamo');
    expect(fam(READY_PLAYER_ME)).toBe('mixamo');
    expect(fam(MESHY)).toBe('meshy');
    expect(fam(UE5_MANNEQUIN)).toBe('ue');
    expect(fam(RIGIFY_DEF)).toBe('rigify');
    expect(fam(RIGIFY_FULL)).toBe('rigify');
    expect(fam(BLENDER_METARIG)).toBe('blender');
    expect(fam(VROID)).toBe('vrm');
    expect(fam(CC4)).toBe('cc');
    expect(fam(GENESIS8)).toBe('daz');
    expect(fam(SMPL)).toBe('smpl');
    expect(fam(NAMELESS)).toBe('unknown');
  });

  it('keeps the twist/segment helpers as unmapped intermediates but counts forearm twists', () => {
    const ue = autoMapHumanoid(buildFixtureGraph(UE5_MANNEQUIN.bones));
    expect(ue.hasForearmTwist).toEqual({ left: true, right: true });
    const cc = autoMapHumanoid(buildFixtureGraph(CC4.bones));
    expect(cc.hasForearmTwist).toEqual({ left: true, right: true });
    const rig = autoMapHumanoid(buildFixtureGraph(RIGIFY_DEF.bones));
    expect(rig.hasForearmTwist).toEqual({ left: false, right: false });
    const mx = autoMapHumanoid(buildFixtureGraph(MIXAMO_PREFIXED.bones));
    expect(mx.hasForearmTwist).toEqual({ left: false, right: false });
  });

  it('shares the familyKey across characters of a family and separates instances by bind signature', () => {
    const a = autoMapHumanoid(buildFixtureGraph(MIXAMO_PREFIXED.bones));
    const b = autoMapHumanoid(buildFixtureGraph(mixamoFixture('mixamo 2', { prefix: 'mixamorig:', ends: true, fingers: true }).bones));
    expect(a.familyKey).toBe(b.familyKey);
    expect(a.instanceKey).toBe(b.instanceKey);
    // A longer arm changes the quantized bind signature but not the family.
    const longArm = mixamoFixture('mixamo long arm', { prefix: 'mixamorig:', ends: true, fingers: true });
    for (const bone of longArm.bones) if (bone.name === 'mixamorig:LeftForeArm') bone.at = [0.56, 1.42, 0];
    const c = autoMapHumanoid(buildFixtureGraph(longArm.bones));
    expect(c.familyKey).toBe(a.familyKey);
    expect(c.instanceKey).not.toBe(a.instanceKey);
    // Different naming (and hence subgraph) = different family key.
    const d = autoMapHumanoid(buildFixtureGraph(VROID.bones));
    expect(d.familyKey).not.toBe(a.familyKey);
  });

  it('the Meshy sample names map the numbered spine from the hips upward', () => {
    const res = autoMapHumanoid(buildFixtureGraph(MESHY.bones));
    expect(res.map.spine).toBe('Spine02');
    expect(res.map.chest).toBe('Spine01');
    expect(res.map.upperChest).toBe('Spine');
    expect(res.map.neck).toBe('neck');
    expect(res.map.head).toBe('Head');
    expect(Object.values(res.map)).not.toContain('headfront');
    expect(Object.values(res.map)).not.toContain('head_end');
  });

  it('SMPL joint names: joints named after the joint they start at', () => {
    const res = autoMapHumanoid(buildFixtureGraph(SMPL.bones));
    expect(res.map.leftUpperLeg).toBe('left_hip');
    expect(res.map.leftShoulder).toBe('left_collar');
    expect(res.map.leftUpperArm).toBe('left_shoulder');
    expect(res.map.leftToes).toBe('left_foot');
  });

  it('a scrambled chain maps by chain order, not by name (neck below the arm branch, Spine1 above)', () => {
    // skeleton.glb layout: Hips -> neck -> Spine02 -> Spine -> {arms, Spine1 -> Head}
    const bones = MESHY.bones.filter((b) => !['head_end', 'headfront', 'Spine01', 'BaseArmature'].includes(b.name)).map((b) => ({ ...b }));
    for (const b of bones) {
      if (b.name === 'Hips') b.parent = null;
      if (b.name === 'neck') { b.parent = 'Hips'; b.at = 'spine'; }
      if (b.name === 'Spine02') { b.parent = 'neck'; b.at = 'chest'; }
      if (b.name === 'Spine') { b.parent = 'Spine02'; b.at = 'upperChest'; }
      if (b.name === 'Head') { b.parent = 'Spine1'; b.at = 'head'; }
    }
    bones.push({ name: 'Spine1', parent: 'Spine', at: 'neck', weight: 0 });
    const res = autoMapHumanoid(buildFixtureGraph(bones));
    expect(res.map.hips).toBe('Hips');
    expect(res.map.spine).toBe('neck');
    expect(res.map.chest).toBe('Spine02');
    expect(res.map.upperChest).toBe('Spine');
    expect(res.map.neck).toBe('Spine1');
    expect(res.map.head).toBe('Head');
    expect(res.map.leftUpperArm).toBe('LeftArm');
  });
});

describe('sides and facing', () => {
  it('sided names decide the sides and the facing for a -Z-facing rig', () => {
    const fixture = mixamoFixture('mixamo facing -Z', { prefix: '', fingers: true, ends: true });
    const graph = buildFixtureGraph(fixture.bones, { transform: FACING_NEG_Z });
    const res = autoMapHumanoid(graph);
    expectMapMatches(fixture, res.map);
    expect(res.axes.facingSource).toBe('names');
    expect(res.axes.up).toEqual([0, 1, 0]);
    expect(res.axes.forward[2]).toBeCloseTo(-1, 5);
    expect(res.left[0]).toBeCloseTo(-1, 5);
    // The rest analysis corrects the root so the left bones end at +X and the toes point +Z.
    const { root } = buildFixtureObject(fixture.bones, { transform: FACING_NEG_Z });
    const a = analyzeRig(root, res, { targetHeight: 1.7, graph, skipBindPose: true });
    expect(a.analysis.leftUpperArm!.restPos[0]).toBeGreaterThan(0);
    expect(a.analysis.rightUpperArm!.restPos[0]).toBeLessThan(0);
    expect(a.analysis.leftFoot!.restDir[2]).toBeGreaterThan(0.5);
    const q = a.rootCorrection;
    // 180° about Y.
    expect(Math.abs(q[1])).toBeCloseTo(1, 4);
    expect(a.warnings.some((w) => /inversion/i.test(w))).toBe(false);
  });

  it('a Z-up rig is detected and corrected to Y-up / +Z', () => {
    const fixture = mixamoFixture('mixamo Z-up', { prefix: '', fingers: true, ends: true });
    const graph = buildFixtureGraph(fixture.bones, { transform: Z_UP });
    const res = autoMapHumanoid(graph);
    expectMapMatches(fixture, res.map);
    expect(res.axes.up[2]).toBeCloseTo(1, 5);
    expect(res.axes.forward[1]).toBeCloseTo(-1, 5);
    const { root } = buildFixtureObject(fixture.bones, { transform: Z_UP });
    const a = analyzeRig(root, res, { targetHeight: 1.72, graph, skipBindPose: true });
    expect(a.analysis.head!.restPos[1]).toBeGreaterThan(a.analysis.hips!.restPos[1]);
    expect(a.analysis.leftUpperArm!.restPos[0]).toBeGreaterThan(0);
    expect(a.analysis.leftToes!.restDir[2]).toBeGreaterThan(0.9);
    expect(a.analysis.hips!.restDir[1]).toBeGreaterThan(0.99);
  });

  it('unsided names take the facing from the toes and the sides from x', () => {
    const fixture = NAMELESS;
    const graph = buildFixtureGraph(fixture.bones, { transform: FACING_NEG_Z });
    const res = autoMapHumanoid(graph);
    expect(res.axes.facingSource).toBe('toes');
    expect(res.axes.forward[2]).toBeCloseTo(-1, 5);
    expectMapMatches(fixture, res.map, BODY_BONES);
  });

  it('sided names win over the toe direction, with a warning (no flip)', () => {
    // Names say left at +X (canonical) but the toes point backward.
    const fixture = mixamoFixture('mixamo toes backward', { prefix: '', fingers: false, ends: true });
    for (const b of fixture.bones) {
      if (b.name === 'LeftToeBase') b.at = [0.1, 0.02, -0.12];
      if (b.name === 'RightToeBase') b.at = [-0.1, 0.02, -0.12];
      if (b.name === 'LeftToe_End') b.at = [0.1, 0.02, -0.2];
      if (b.name === 'RightToe_End') b.at = [-0.1, 0.02, -0.2];
    }
    const res = autoMapHumanoid(buildFixtureGraph(fixture.bones));
    expect(res.axes.facingSource).toBe('names');
    expect(res.axes.forward[2]).toBeCloseTo(1, 5);
    expect(res.warnings.some((w) => /feet point the opposite way/i.test(w))).toBe(true);
  });
});

describe('topology detector', () => {
  it('finds hips, spine branch, chains and roles on the UE5 mannequin', () => {
    const graph = buildFixtureGraph(UE5_MANNEQUIN.bones);
    const t = analyzeTopology(graph);
    const name = (i: number) => graph.nodes[i].name;
    expect(name(t.hips)).toBe('pelvis');
    expect(name(t.spineBranch)).toBe('spine_05');
    expect(t.torso.map(name)).toEqual(['spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05']);
    expect(t.headChain.map(name)).toEqual(['neck_01', 'neck_02', 'head']);
    expect(t.arms.left!.links.map(name)).toEqual(['clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l']);
    expect(t.legs.right!.links.map(name)).toEqual(['thigh_r', 'calf_r', 'foot_r', 'ball_r']);
    expect(t.arms.left!.fingers.map((f) => f.digit)).toEqual(['Thumb', 'Index', 'Middle', 'Ring', 'Little']);
    expect(t.sideSource).toBe('names');
  });

  it('orders unnamed finger chains by rest position (thumb forward, then across the hand)', () => {
    const fixture = mixamoFixture('mixamo anonymous fingers', { prefix: '', fingers: true, ends: false });
    let k = 0;
    const rename = new Map<string, string>();
    for (const b of fixture.bones) {
      if (/Hand(Thumb|Index|Middle|Ring|Pinky)\d/.test(b.name)) {
        const n = `Bone.${String(++k).padStart(3, '0')}`;
        rename.set(b.name, n);
      }
    }
    for (const b of fixture.bones) {
      if (rename.has(b.name)) b.name = rename.get(b.name)!;
      if (b.parent && rename.has(b.parent)) b.parent = rename.get(b.parent)!;
    }
    const graph = buildFixtureGraph(fixture.bones);
    const res = autoMapHumanoid(graph);
    for (const role of HUMANOID_BONES) {
      if (!isFingerBone(role)) continue;
      const original = fixture.expect[role]!;
      expect(res.map[role], role).toBe(rename.get(original) ?? original);
    }
  });

  it('remapAutoResult applies an explicit map and recomputes the keys', () => {
    const graph = buildFixtureGraph(MIXAMO_PREFIXED.bones);
    const auto = autoMapHumanoid(graph);
    const map = { ...auto.map, leftEye: 'does-not-exist', head: 'mixamorig:Neck', neck: undefined };
    const re = remapAutoResult(graph, auto, map);
    expect(re.map.head).toBe('mixamorig:Neck');
    expect(re.map.neck).toBeUndefined();
    expect(re.map.leftEye).toBeUndefined();
    expect(re.warnings.some((w) => /does-not-exist/.test(w))).toBe(true);
    expect(re.familyKey).not.toBe(auto.familyKey);
    expect(re.confidence.head).toBe(1);
    expect(re.confidence.hips).toBe(auto.confidence.hips);
  });

  it('reports an unrigged graph (no joints, no skins) without throwing', () => {
    const graph = buildFixtureGraph([{ name: 'mesh_node', parent: null, at: 'root', joint: false, weight: 0 }], { weights: false });
    graph.skinnedMeshCount = 0;
    graph.hasSkinWeights = false;
    const res = autoMapHumanoid(graph);
    expect(res.unrigged).toBe(true);
    expect(res.map).toEqual({});
  });

  it('does not map a leaf pair that is too short to be a leg (skirt) as feet', () => {
    const fixture = VROID;
    const graph = buildFixtureGraph(fixture.bones);
    const t = analyzeTopology(graph);
    const name = (i: number) => graph.nodes[i].name;
    expect(name(t.legs.left!.end)).toBe('J_Bip_L_ToeBase');
    expect(name(t.legs.right!.end)).toBe('J_Bip_R_ToeBase');
    expect(new Vector3().fromArray(t.axes.forward).z).toBeCloseTo(1, 5);
  });
});
