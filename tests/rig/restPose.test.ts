/**
 * Bind pose (docs/DESIGN.md §5.3), rest analysis and the height table (§5.5).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bone, BufferGeometry, Matrix4, Object3D, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { DEG2RAD } from '../../src/core/math';
import { applyBindPose, buildRigGraph, selectPrimarySkeleton } from '../../src/rig/skeletonGraph';
import { readGlbSkeleton } from '../../src/rig/glbSkeleton';
import { analyzeRig, computeHeightTable } from '../../src/rig/restPose';
import { analyzeModel } from '../../src/rig/analyzeModel';
import { MIXAMO_PREFIXED, buildFixtureObject, mixamoFixture } from '../fixtures/rigNames';

const SAMPLE = resolve(__dirname, '../../public/models/sample-meshy.glb');

/** Rebuilds three.js skins (SkinnedMesh + Skeleton with the file's IBMs) on the reader's tree. */
function attachSkins(glb: ReturnType<typeof readGlbSkeleton>): SkinnedMesh[] {
  const meshes: SkinnedMesh[] = [];
  for (const skin of glb.skins) {
    const mesh = new SkinnedMesh(new BufferGeometry());
    mesh.name = 'skin';
    glb.root.add(mesh);
    mesh.bind(new Skeleton(skin.joints as Bone[], skin.inverseBindMatrices.map((m) => m.clone())), new Matrix4());
    meshes.push(mesh);
  }
  glb.root.updateMatrixWorld(true);
  return meshes;
}

describe('applyBindPose on sample-meshy.glb', () => {
  it('puts every joint at inverse(IBM) after the joints were disturbed (BaseArmature has a +90° X rotation)', () => {
    const glb = readGlbSkeleton(readFileSync(SAMPLE));
    const meshes = attachSkins(glb);
    const skeleton = meshes[0].skeleton;
    // Disturb every joint.
    for (const b of skeleton.bones) {
      b.position.x += 0.1;
      b.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5));
    }
    glb.root.updateMatrixWorld(true);
    const r = applyBindPose(glb.root);
    expect(r.jointCount).toBe(24);
    expect(r.warnings).toEqual([]);
    const m = new Matrix4();
    for (let i = 0; i < skeleton.bones.length; i++) {
      m.copy(skeleton.boneInverses[i]).invert();
      const w = skeleton.bones[i].matrixWorld;
      for (let k = 0; k < 16; k++) expect(w.elements[k]).toBeCloseTo(m.elements[k], 5);
    }
    const hips = glb.root.getObjectByName('Hips')!;
    expect(hips.getWorldPosition(new Vector3()).y).toBeCloseTo(0.57, 2);
    // The non-bone ancestor keeps its file transform (not double-applied).
    const armature = glb.root.getObjectByName('BaseArmature')!;
    expect(armature.quaternion.x).toBeCloseTo(0.7071, 3);
  });

  it('selects the skinned joints and their weights', () => {
    const glb = readGlbSkeleton(readFileSync(SAMPLE));
    attachSkins(glb);
    const sel = selectPrimarySkeleton(glb.root);
    expect(sel.joints.size).toBe(24);
    expect(sel.skinnedMeshCount).toBe(1);
    const graph = buildRigGraph(glb.root);
    expect(graph.nodes.filter((n) => n.isJoint).length).toBe(24);
  });

  it('is a no-op on a rig without skins (node transforms are the rest pose)', () => {
    const { root, nodes } = buildFixtureObject(MIXAMO_PREFIXED.bones);
    const before = nodes.get('mixamorig:LeftHand')!.getWorldPosition(new Vector3());
    const r = applyBindPose(root);
    expect(r.jointCount).toBe(0);
    expect(nodes.get('mixamorig:LeftHand')!.getWorldPosition(new Vector3())).toEqual(before);
  });
});

describe('computeHeightTable', () => {
  it('keeps bone rows in canonical order and interpolates the rest', () => {
    const t = computeHeightTable({ floor: 0, headTop: 1.7, ankles: 0.08, knees: 0.48, hips: 0.95, shoulders: 1.42 });
    expect(t).toEqual({ floor: 0, ankles: 0.08, knees: 0.48, hips: 0.95, shoulders: 1.42, eyes: expect.any(Number), headTop: 1.7 });
    expect(t.eyes).toBeGreaterThan(1.42);
    expect(t.eyes).toBeLessThan(1.7);
  });

  it('drops a knee that sits above the hips and interpolates hips + 0.55·(ankle − hips)', () => {
    const t = computeHeightTable({ floor: 0, headTop: 1.7, ankles: 0.1, knees: 1.1, hips: 0.9, shoulders: 1.4, eyes: 1.6 });
    expect(t.knees).toBeCloseTo(0.9 + 0.55 * (0.1 - 0.9), 9);
    expect(t.hips).toBe(0.9);
  });

  it('is monotonic for arbitrary junk input', () => {
    const t = computeHeightTable({ floor: 0.2, headTop: 0.1, ankles: 5, knees: -1, hips: NaN, shoulders: 0.15, eyes: 0.16 });
    const keys = ['floor', 'ankles', 'knees', 'hips', 'shoulders', 'eyes', 'headTop'] as const;
    for (let i = 1; i < keys.length; i++) expect(t[keys[i]]).toBeGreaterThanOrEqual(t[keys[i - 1]]);
    for (const k of keys) expect(Number.isFinite(t[k])).toBe(true);
  });
});

describe('analyzeRig on synthetic trees', () => {
  it('T-pose Mixamo tree: anatomical limbs in auto mode, torso relative, forward up references', () => {
    const { root } = buildFixtureObject(MIXAMO_PREFIXED.bones);
    const a = analyzeRig(root, null, { targetHeight: 1.72 });
    expect(a.unrigged).toBe(false);
    expect(a.map.leftHand).toBe('mixamorig:LeftHand');
    // Skeleton bind extent: toe tails at 0.02 up to the HeadTop_End marker at 1.72.
    expect(a.sourceHeight).toBeCloseTo(1.7, 6);
    expect(a.scale).toBeCloseTo(1.72 / 1.7, 6);
    expect(a.defaultBones.hips!.mode).toBe('relative');
    expect(a.defaultBones.head!.mode).toBe('relative');
    expect(a.defaultBones.leftUpperArm!.mode).toBe('auto');
    expect(a.defaultBones.leftIndexProximal!.mode).toBe('auto');
    expect(a.analysis.leftUpperArm!.restDir[0]).toBeCloseTo(1, 5);
    expect(a.analysis.leftUpperArm!.restUp).toBeNull(); // straight elbow: no flexion direction
    expect(a.analysis.leftLowerArm!.restUp).not.toBeNull(); // fingers define the dorsal normal
    expect(a.analysis.leftLowerArm!.restUp![1]).toBeCloseTo(1, 3); // palms down in a T-pose
    expect(a.analysis.rightLowerArm!.restUp![1]).toBeCloseTo(1, 3);
    expect(a.analysis.leftUpperLeg!.restUp).toBeNull(); // straight knee
    expect(a.analysis.leftLowerLeg!.restUp![2]).toBeCloseTo(1, 3); // foot forward
    expect(a.analysis.leftFoot!.restUp![1]).toBeGreaterThan(0.5); // ankle->knee is up
    expect(a.analysis.leftFoot!.childRole).toBe('leftToes');
    expect(a.analysis.leftToes!.childRole).toBeNull();
    expect(a.analysis.leftToes!.restDir[2]).toBeCloseTo(1, 5); // toward the Toe_End marker
    expect(a.analysis.head!.restDir[1]).toBeCloseTo(1, 5); // toward HeadTop_End
    expect(a.analysis.head!.length).toBeCloseTo(0.17 * a.scale, 5);
    expect(a.analysis.leftHand!.restDir[0]).toBeGreaterThan(0.98); // toward mid(index, little)
    expect(a.analysis.leftShoulder!.parentRole).toBe('upperChest');
    expect(a.analysis.leftUpperArm!.intermediateCount).toBe(0);
    expect(a.heightTable.headTop).toBeCloseTo(1.72 * a.scale, 6);
    expect(a.heightTable.knees).toBeCloseTo(0.48 * a.scale, 6);
    expect(a.heightTable.eyes).toBeGreaterThan(1.55);
    expect(a.boneCount).toBe(65);
  });

  it('bent elbows and knees define the up references with the body-model estimators', () => {
    const fx = mixamoFixture('bent', { prefix: '', fingers: false, ends: true });
    for (const b of fx.bones) {
      // Elbows bend forward (wrist moves +Z), knees bend backward (ankle moves -Z).
      if (b.name === 'LeftHand') b.at = [0.62, 1.42, 0.2];
      if (b.name === 'RightHand') b.at = [-0.62, 1.42, 0.2];
      if (b.name === 'LeftFoot') b.at = [0.1, 0.12, -0.2];
      if (b.name === 'RightFoot') b.at = [-0.1, 0.12, -0.2];
    }
    const { root } = buildFixtureObject(fx.bones);
    const a = analyzeRig(root, null, { targetHeight: 1.72 });
    const ua = a.analysis.leftUpperArm!;
    expect(ua.restUp![2]).toBeCloseTo(1, 3); // flexion toward +Z
    const ul = a.analysis.leftUpperLeg!;
    expect(ul.restUp![2]).toBeCloseTo(1, 3); // kneecap = minus the backward flexion
    expect(ul.anatomical).toBe(true);
    expect(a.noKnee).toEqual({ left: false, right: false });
  });

  it('counts unmapped intermediates between mapped roles', () => {
    const fx = mixamoFixture('inter', { prefix: '', fingers: false, ends: true });
    fx.bones.push({ name: 'LeftArmTwist', parent: 'LeftArm', at: 'leftUpperArm>leftLowerArm@0.5' });
    for (const b of fx.bones) if (b.name === 'LeftForeArm') b.parent = 'LeftArmTwist';
    const { root } = buildFixtureObject(fx.bones);
    const a = analyzeRig(root, null, { targetHeight: 1.72 });
    expect(a.map.leftLowerArm).toBe('LeftForeArm');
    expect(a.analysis.leftLowerArm!.intermediateCount).toBe(1);
    expect(a.analysis.leftLowerArm!.parentRole).toBe('leftUpperArm');
    expect(Object.values(a.map)).not.toContain('LeftArmTwist');
  });

  it('accepts an explicit map and honours it', () => {
    const { root } = buildFixtureObject(MIXAMO_PREFIXED.bones);
    const auto = analyzeRig(root, null, { targetHeight: 1.7 });
    const map = { ...auto.map, head: 'mixamorig:Neck' };
    delete (map as Record<string, string>).neck;
    const a = analyzeRig(root, map, { targetHeight: 1.7 });
    expect(a.map.head).toBe('mixamorig:Neck');
    expect(a.map.neck).toBeUndefined();
    expect(a.analysis.head!.name).toBe('mixamorig:Neck');
    expect(a.analysis.head!.parentRole).toBe('upperChest');
    expect(a.confidence.head).toBe(1);
  });

  it('never throws on a static mesh tree', () => {
    const root = new Object3D();
    const empty = new Object3D();
    empty.name = 'mesh_node';
    root.add(empty);
    const a = analyzeRig(root, null, { targetHeight: 1.7 });
    expect(a.unrigged).toBe(true);
    expect(a.map).toEqual({});
    expect(a.rootCorrection).toEqual([0, 0, 0, 1]);
    expect(Number.isFinite(a.scale)).toBe(true);
  });

  it('analyzeModel: the wrapper carries the root correction of a -Z-facing rig and rest quats are in the wrapper frame', () => {
    const fx = mixamoFixture('facing -Z', { prefix: '', fingers: true, ends: true });
    const { root, nodes } = buildFixtureObject(fx.bones, { transform: (v) => new Vector3(-v.x, v.y, -v.z) });
    const model = analyzeModel({ root, name: 'fixture', format: 'glb', skinnedMeshes: [], animations: [] }, { targetHeight: 1.72 });
    const q = new Quaternion().fromArray(model.analysis.rootCorrection);
    expect(Math.abs(q.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 180 * DEG2RAD)))).toBeLessThan(1e-4);
    const hand = nodes.get('LeftHand')!;
    const wp = hand.getWorldPosition(new Vector3());
    const wq = hand.getWorldQuaternion(new Quaternion());
    const rec = model.analysis.analysis.leftHand!;
    expect(wp.x).toBeCloseTo(rec.restPos[0], 6);
    expect(wp.x).toBeGreaterThan(0);
    expect(Math.abs(wq.dot(new Quaternion().fromArray(rec.restQuat)))).toBeCloseTo(1, 6);
  });
});
