/**
 * Real bundled models through the Node GLB skeleton reader (docs/DESIGN.md §13):
 * the Meshy sample and every file in models/characters.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { REQUIRED_BONES, type HumanoidBone } from '../../src/core/types';
import { autoMapHumanoid } from '../../src/rig/autoMap';
import { readGlbSkeleton } from '../../src/rig/glbSkeleton';
import { analyzeRig } from '../../src/rig/restPose';
import { analyzeModel } from '../../src/rig/analyzeModel';

const ROOT = resolve(__dirname, '../..');
const SAMPLE = resolve(ROOT, 'public/models/sample-meshy.glb');
const CHARACTERS = resolve(ROOT, 'models/characters');
const files = readdirSync(CHARACTERS).filter((f) => f.endsWith('.glb')).sort();
const UNRIGGED = ['zombie_demon.glb', 'zombie_purple.glb', 'zombie_red.glb', 'zombie_toxic.glb'];
const RIGGED = files.filter((f) => !UNRIGGED.includes(f));

function load(path: string) {
  const glb = readGlbSkeleton(readFileSync(path));
  const auto = autoMapHumanoid(glb.graph, { family: { generator: glb.generator, meshNames: glb.meshNames } });
  const analysis = analyzeRig(glb.root, auto, { targetHeight: 1.7, graph: glb.graph, skipBindPose: true, displayName: path.split('/').pop() });
  return { glb, auto, analysis };
}

describe('sample-meshy.glb', () => {
  const { glb, auto, analysis } = load(SAMPLE);

  it('maps the numbered Meshy spine and the limbs', () => {
    expect(auto.map.hips).toBe('Hips');
    expect(auto.map.spine).toBe('Spine02');
    expect(auto.map.chest).toBe('Spine01');
    expect(auto.map.upperChest).toBe('Spine');
    expect(auto.map.neck).toBe('neck');
    expect(auto.map.head).toBe('Head');
    expect(auto.map.leftShoulder).toBe('LeftShoulder');
    expect(auto.map.leftUpperArm).toBe('LeftArm');
    expect(auto.map.leftLowerArm).toBe('LeftForeArm');
    expect(auto.map.leftHand).toBe('LeftHand');
    expect(auto.map.rightHand).toBe('RightHand');
    expect(auto.map.leftUpperLeg).toBe('LeftUpLeg');
    expect(auto.map.leftLowerLeg).toBe('LeftLeg');
    expect(auto.map.leftFoot).toBe('LeftFoot');
    expect(auto.map.leftToes).toBe('LeftToeBase');
    expect(auto.map.rightToes).toBe('RightToeBase');
    expect(Object.values(auto.map)).not.toContain('headfront');
    expect(Object.values(auto.map)).not.toContain('head_end');
    expect(auto.family).toBe('meshy');
  });

  it('faces +Z with the left side at +X', () => {
    expect(auto.axes.up).toEqual([0, 1, 0]);
    expect(auto.axes.forward[2]).toBeCloseTo(1, 5);
    expect(auto.left[0]).toBeCloseTo(1, 5);
    expect(auto.axes.facingSource).toBe('names');
    expect(analysis.rootCorrection[3]).toBeCloseTo(1, 5);
  });

  it('flags the stub thighs: no knee on both sides, upper legs non-anatomical, follow mode', () => {
    expect(auto.noKnee).toEqual({ left: true, right: true });
    expect(auto.noElbow).toEqual({ left: false, right: false });
    expect(analysis.analysis.leftUpperLeg!.anatomical).toBe(false);
    expect(analysis.analysis.rightUpperLeg!.anatomical).toBe(false);
    expect(analysis.defaultBones.leftUpperLeg!.mode).toBe('follow');
    expect(analysis.defaultBones.rightUpperLeg!.mode).toBe('follow');
    expect(analysis.defaultBones.leftLowerLeg!.mode).toBe('auto');
    expect(analysis.defaultBones.spine!.mode).toBe('relative');
    expect(analysis.defaultBones.leftUpperArm!.mode).toBe('auto');
    expect(analysis.warnings.some((w) => /no knee joint on the left leg/.test(w))).toBe(true);
  });

  it('measures the source height from bind extents cross-checked with the skinned geometry', () => {
    expect(analysis.sourceHeight).toBeGreaterThan(1.8);
    expect(analysis.sourceHeight).toBeLessThan(2.3);
    expect(analysis.scale).toBeCloseTo(1.7 / analysis.sourceHeight, 6);
    // Hips in loader space before scaling (bind pose from the inverse bind matrices).
    const hips = glb.graph.nodes.find((n) => n.name === 'Hips')!;
    expect(hips.restPos[1]).toBeCloseTo(0.57, 2);
    // ... and in the final frame after scaling.
    expect(analysis.analysis.hips!.restPos[1]).toBeCloseTo(0.57 * analysis.scale, 3);
  });

  it('rest directions: head toward its single tail marker, not the mean with headfront', () => {
    const head = analysis.analysis.head!;
    const d = new Vector3().fromArray(head.restDir);
    // head_end sits almost straight above the head; headfront would tilt it forward.
    expect(d.y).toBeGreaterThan(0.99);
    expect(head.childRole).toBeNull();
    expect(head.parentRole).toBe('neck');
    expect(analysis.analysis.neck!.childRole).toBe('head');
    expect(analysis.analysis.hips!.childRole).toBe('spine');
    // The hand continues the lower arm.
    const la = new Vector3().fromArray(analysis.analysis.leftLowerArm!.restDir);
    const hand = new Vector3().fromArray(analysis.analysis.leftHand!.restDir);
    expect(hand.dot(la)).toBeGreaterThan(0.999);
  });

  it('estimates bind up references with the body-model estimators (flexed elbows)', () => {
    const ua = analysis.analysis.leftUpperArm!;
    expect(ua.restUp).not.toBeNull();
    const up = new Vector3().fromArray(ua.restUp!);
    const d = new Vector3().fromArray(ua.restDir);
    expect(Math.abs(up.dot(d))).toBeLessThan(1e-4);
    expect(up.length()).toBeCloseTo(1, 5);
    // Torso up references are the model forward.
    expect(analysis.analysis.spine!.restUp).toEqual([0, 0, 1]);
    // No fingers: the lower arm / hand dorsal normal is undefined.
    expect(analysis.analysis.leftLowerArm!.restUp).toBeNull();
  });

  it('produces a monotonic height table with the knee interpolated (knee bone above the hips)', () => {
    const t = analysis.heightTable;
    expect(t.floor).toBeLessThanOrEqual(t.ankles);
    expect(t.ankles).toBeLessThan(t.knees);
    expect(t.knees).toBeLessThan(t.hips);
    expect(t.hips).toBeLessThan(t.shoulders);
    expect(t.shoulders).toBeLessThan(t.eyes);
    expect(t.eyes).toBeLessThan(t.headTop);
    expect(t.headTop).toBeCloseTo(1.7, 2);
    expect(t.knees).toBeCloseTo(t.hips + 0.55 * (t.ankles - t.hips), 6);
  });

  it('is complete: keys, counts, confidences', () => {
    expect(analysis.familyKey).toMatch(/^[0-9a-f]{8}$/);
    expect(analysis.instanceKey.startsWith(analysis.familyKey + '-')).toBe(true);
    expect(analysis.boneCount).toBe(24);
    expect(analysis.skinnedMeshCount).toBe(1);
    expect(analysis.unrigged).toBe(false);
    expect(analysis.displayName).toBe('sample-meshy.glb');
    for (const r of REQUIRED_BONES) expect(analysis.confidence[r]).toBeGreaterThanOrEqual(0.7);
    for (const r of REQUIRED_BONES) expect(analysis.analysis[r]).toBeDefined();
  });

  it('analyzeModel wraps the root, keeps the loader root unscaled and matches analyzeRig', () => {
    const fresh = readGlbSkeleton(readFileSync(SAMPLE));
    const model = analyzeModel({ root: fresh.root, name: 'sample-meshy.glb', format: 'glb', skinnedMeshes: [], animations: [] }, { targetHeight: 1.7 });
    expect(model.wrapper.children).toContain(fresh.root);
    expect(model.wrapper.scale.x).toBeCloseTo(analysis.scale, 6);
    expect(fresh.root.scale.x).toBe(1);
    expect(model.analysis.map).toEqual(analysis.map);
    expect(model.analysis.sourceHeight).toBeCloseTo(analysis.sourceHeight, 6);
    // Rest positions equal the wrapper-frame world positions of the bones.
    const hips = model.bonesByName.get('Hips')!;
    const wp = hips.getWorldPosition(new Vector3());
    expect(wp.y).toBeCloseTo(model.analysis.analysis.hips!.restPos[1], 6);
    const bones = model.bonesForMap(model.analysis.map);
    expect(bones.leftHand!.name).toBe('LeftHand');
    // applyBindPose restores a disturbed joint.
    hips.rotation.x = 1;
    model.applyBindPose();
    expect(hips.getWorldPosition(new Vector3()).y).toBeCloseTo(wp.y, 6);
  });
});

describe('models/characters/*.glb', () => {
  const results = new Map<string, ReturnType<typeof load>>();
  for (const f of files) results.set(f, load(resolve(CHARACTERS, f)));

  for (const f of RIGGED) {
    it(`${f}: maps every required role with correct sides`, () => {
      const { auto, analysis } = results.get(f)!;
      expect(auto.unrigged).toBe(false);
      for (const r of REQUIRED_BONES) expect(auto.map[r], `${f}: ${r}`).toBeDefined();
      expect(auto.map.leftUpperArm).toBe('LeftArm');
      expect(auto.map.rightUpperArm).toBe('RightArm');
      expect(auto.map.leftUpperLeg).toBe('LeftUpLeg');
      expect(auto.map.rightUpperLeg).toBe('RightUpLeg');
      expect(auto.map.leftFoot).toBe('LeftFoot');
      expect(auto.map.rightFoot).toBe('RightFoot');
      expect(auto.map.head).toBe('Head');
      expect(auto.axes.facingSource).toBe('names');
      // After root correction, left bones sit at +X and the head is above the hips.
      expect(analysis.analysis.leftUpperArm!.restPos[0]).toBeGreaterThan(analysis.analysis.rightUpperArm!.restPos[0]);
      expect(analysis.analysis.head!.restPos[1]).toBeGreaterThan(analysis.analysis.hips!.restPos[1]);
      expect(analysis.warnings.some((w) => /inversion/.test(w))).toBe(false);
      expect(analysis.heightTable.headTop).toBeCloseTo(1.7, 1);
      expect(analysis.heightTable.floor).toBeLessThan(analysis.heightTable.ankles);
      expect(analysis.heightTable.hips).toBeGreaterThan(0.5);
      expect(analysis.heightTable.hips).toBeLessThan(1.2);
    });
  }

  for (const f of UNRIGGED) {
    it(`${f}: unrigged static mesh returns unrigged=true with an empty map and does not throw`, () => {
      const { auto, analysis } = results.get(f)!;
      expect(auto.unrigged).toBe(true);
      expect(analysis.unrigged).toBe(true);
      expect(analysis.map).toEqual({});
      expect(analysis.boneCount).toBe(0);
      expect(analysis.scale).toBeGreaterThan(0);
      expect(Number.isFinite(analysis.scale)).toBe(true);
      expect(analysis.warnings.some((w) => /no skeleton/i.test(w))).toBe(true);
    });
  }

  it('skeleton.glb: the scrambled chain maps by chain order', () => {
    const { auto } = results.get('skeleton.glb')!;
    expect(auto.map.hips).toBe('Hips');
    expect(auto.map.spine).toBe('neck');
    expect(auto.map.chest).toBe('Spine02');
    expect(auto.map.upperChest).toBe('Spine');
    expect(auto.map.neck).toBe('Spine1');
    expect(auto.map.head).toBe('Head');
  });

  it('game-parts files: the bind pose (not the posed node transforms) drives the analysis', () => {
    // clerk.glb: the node-transform pose differs from the bind pose (rotated leg joints);
    // the bind pose has the thigh pointing down, which is what the analysis must see.
    const { glb, analysis } = results.get('clerk.glb')!;
    const ul = analysis.analysis.leftUpperLeg!;
    expect(ul.anatomical).toBe(true);
    expect(ul.restDir[1]).toBeLessThan(-0.8);
    // Bind hips are at ~0.8 m in loader space (the inverse bind matrices are in scene units).
    const hips = glb.graph.nodes.find((n) => n.name === 'Hips')!;
    expect(hips.restPos[1]).toBeGreaterThan(0.7);
    expect(hips.restPos[1]).toBeLessThan(1.1);
    // The Armature node carries a 0.01 scale and the bone-local translations are in centimeters;
    // the inverse bind matrices already include that scale, so the joints' world transforms are
    // the bind pose in meters while their local transforms stay in the armature's units.
    const armature = glb.root.getObjectByName('Armature')!;
    expect(armature.scale.x).toBeCloseTo(0.01, 6);
    const hipsObj = glb.root.getObjectByName('Hips')!;
    expect(hipsObj.position.y).toBeGreaterThan(70);
    expect(hipsObj.position.y).toBeLessThan(110);
    expect(hipsObj.getWorldPosition(new Vector3()).y).toBeCloseTo(hips.restPos[1], 6);
  });

  it('the 0.01 root scale files normalize to the target height (source height in bind-space meters)', () => {
    for (const f of RIGGED) {
      const { analysis } = results.get(f)!;
      expect(analysis.sourceHeight, f).toBeGreaterThan(1.4);
      expect(analysis.sourceHeight, f).toBeLessThan(2.0);
      expect(analysis.scale, f).toBeGreaterThan(0.85);
      expect(analysis.scale, f).toBeLessThan(1.25);
    }
  });

  it('zombie.glb: a -Z-up bind pose is detected and corrected', () => {
    const { auto, analysis } = results.get('zombie.glb')!;
    expect(auto.axes.up[2]).toBeCloseTo(-1, 5);
    expect(analysis.analysis.head!.restPos[1]).toBeGreaterThan(analysis.analysis.hips!.restPos[1]);
    expect(analysis.analysis.hips!.restDir[1]).toBeGreaterThan(0.9);
    expect(analysis.analysis.leftUpperArm!.restPos[0]).toBeGreaterThan(0);
  });

  it('familyKey is identical across the 23 game-parts files and instanceKeys differ where bind directions differ', () => {
    const parts = RIGGED.filter((f) => f !== 'skeleton.glb');
    expect(parts.length).toBe(23);
    const keys = new Set(parts.map((f) => results.get(f)!.auto.familyKey));
    expect(keys.size).toBe(1);
    expect(results.get('skeleton.glb')!.auto.familyKey).not.toBe([...keys][0]);
    const instances = new Set(parts.map((f) => results.get(f)!.auto.instanceKey));
    // Identical exports share an instance key (zombie_new / zombie_parts / zombie_parts_lite);
    // characters with different proportions do not.
    expect(results.get('zombie_new.glb')!.auto.instanceKey).toBe(results.get('zombie_parts.glb')!.auto.instanceKey);
    expect(instances.size).toBeGreaterThan(10);
    for (const f of parts) expect(results.get(f)!.auto.instanceKey.startsWith(results.get(f)!.auto.familyKey + '-')).toBe(true);
  });

  it('every mapped role of every rigged file has a finite analysis record', () => {
    for (const f of RIGGED) {
      const { analysis } = results.get(f)!;
      for (const [role, a] of Object.entries(analysis.analysis) as [HumanoidBone, NonNullable<typeof analysis.analysis.hips>][]) {
        expect(a.name, `${f} ${role}`).toBe(analysis.map[role]);
        for (const v of [...a.restDir, ...a.restPos, ...a.restQuat, a.length, a.canonicalDeviationDeg]) expect(Number.isFinite(v), `${f} ${role}`).toBe(true);
        expect(Math.hypot(...a.restDir), `${f} ${role}`).toBeCloseTo(1, 5);
        if (a.restUp) expect(Math.hypot(...a.restUp), `${f} ${role}`).toBeCloseTo(1, 4);
        expect(a.length).toBeGreaterThan(0);
        expect(analysis.defaultBones[role]).toBeDefined();
      }
    }
  });
});
