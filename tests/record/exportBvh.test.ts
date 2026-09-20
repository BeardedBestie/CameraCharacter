import { describe, expect, it } from 'vitest';
import { Bone, Object3D, Quaternion, Vector3 } from 'three';
import { HUMANOID_PARENT, type HumanoidBone, type QuatTuple, type Take, type TakeSample, type Vec3Tuple } from '../../src/core/types';
import { bvhJointOrder, evaluateBvhFrame, parseBvh, restDirection, takeToBvh } from '../../src/record/exportBvh';

const D2R = Math.PI / 180;
const rotX = (deg: number) => new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), deg * D2R);
const rotY = (deg: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), deg * D2R);
const rotZ = (deg: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), deg * D2R);

interface Rig {
  root: Object3D;
  roles: HumanoidBone[];
  bones: Bone[];
  header: Omit<Take, 'samples' | 't0'>;
}

/**
 * Small synthetic humanoid: hips -> spine -> head, arms and legs, with known
 * bind world positions. Arm and hand bones carry non-identity bind rotations
 * (local +Y along the bone) so the bind quaternions matter.
 */
function buildRig(): Rig {
  const root = new Object3D();
  const roles: HumanoidBone[] = [
    'hips', 'spine', 'head',
    'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  ];
  const worldPos: Record<string, Vector3> = {
    hips: new Vector3(0, 0.9, 0),
    spine: new Vector3(0, 1.0, 0),
    head: new Vector3(0, 1.5, 0),
    leftUpperArm: new Vector3(0.2, 1.4, 0),
    leftLowerArm: new Vector3(0.5, 1.4, 0),
    leftHand: new Vector3(0.75, 1.4, 0),
    rightUpperArm: new Vector3(-0.2, 1.4, 0),
    rightLowerArm: new Vector3(-0.5, 1.4, 0),
    rightHand: new Vector3(-0.75, 1.4, 0),
    leftUpperLeg: new Vector3(0.1, 0.9, 0),
    leftLowerLeg: new Vector3(0.1, 0.45, 0),
    leftFoot: new Vector3(0.1, 0.05, 0),
    rightUpperLeg: new Vector3(-0.1, 0.9, 0),
    rightLowerLeg: new Vector3(-0.1, 0.45, 0),
    rightFoot: new Vector3(-0.1, 0.05, 0),
  };
  // World bind rotations: local +Y along the bone for arms/hands, +Y up elsewhere, feet +Y forward.
  const worldQuat: Record<string, Quaternion> = {};
  for (const r of roles) worldQuat[r] = new Quaternion();
  for (const r of ['leftUpperArm', 'leftLowerArm', 'leftHand']) worldQuat[r] = rotZ(-90); // +Y -> +X
  for (const r of ['rightUpperArm', 'rightLowerArm', 'rightHand']) worldQuat[r] = rotZ(90); // +Y -> -X
  for (const r of ['leftFoot', 'rightFoot']) worldQuat[r] = rotX(90); // +Y -> +Z

  // Mapped parent = canonical parent skipping unmapped roles.
  const parentRole = (r: HumanoidBone): HumanoidBone | null => {
    let p = HUMANOID_PARENT[r];
    while (p && !roles.includes(p)) p = HUMANOID_PARENT[p];
    return p;
  };
  const bones: Bone[] = [];
  const byRole = new Map<HumanoidBone, Bone>();
  for (const r of roles) {
    const b = new Bone();
    b.name = r;
    byRole.set(r, b);
    bones.push(b);
  }
  for (const r of roles) {
    const b = byRole.get(r)!;
    const p = parentRole(r);
    const parent = p ? byRole.get(p)! : root;
    parent.add(b);
    const pq = p ? worldQuat[p] : new Quaternion();
    const pp = p ? worldPos[p] : new Vector3();
    b.quaternion.copy(pq.clone().invert().multiply(worldQuat[r]));
    b.position.copy(worldPos[r].clone().sub(pp).applyQuaternion(pq.clone().invert()));
  }
  root.updateMatrixWorld(true);
  const parentIndex = roles.map((r) => {
    const p = parentRole(r);
    return p ? roles.indexOf(p) : -1;
  });
  const lengths = roles.map((r, i) => {
    const child = roles.find((_, j) => parentIndex[j] === i);
    if (child) return worldPos[child].clone().sub(worldPos[r]).length();
    return r.endsWith('Hand') ? 0.15 : r.endsWith('Foot') ? 0.2 : 0.25;
  });
  return {
    root,
    roles,
    bones,
    header: {
      fps: 30,
      roles,
      boneNames: roles.map((r) => r),
      bindWorldQuat: bones.map((b) => b.getWorldQuaternion(new Quaternion()).toArray() as QuatTuple),
      bindWorldPos: bones.map((b) => b.getWorldPosition(new Vector3()).toArray() as Vec3Tuple),
      parentIndex,
      lengths,
    },
  };
}

interface DrivenPose {
  sample: TakeSample;
  /** Expected world positions per role after applying the world deltas. */
  pos: Vector3[];
  delta: Quaternion[];
}

/** Applies per-role world deltas (relative to bind) with parent-first propagation. */
function drive(rig: Rig, t: number, localDeltas: Partial<Record<HumanoidBone, Quaternion>>, hipsWorld: Vector3): DrivenPose {
  const { roles, header } = rig;
  const n = roles.length;
  const delta: Quaternion[] = [];
  const pos: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const p = header.parentIndex[i];
    const own = localDeltas[roles[i]] ?? new Quaternion();
    // world delta = parent's world delta composed with this bone's own change
    const d = p < 0 ? own.clone() : delta[p].clone().multiply(own);
    delta.push(d);
    if (p < 0) pos.push(hipsWorld.clone());
    else {
      const bindOff = new Vector3().fromArray(header.bindWorldPos[i]).sub(new Vector3().fromArray(header.bindWorldPos[p]));
      pos.push(bindOff.applyQuaternion(delta[p]).add(pos[p]));
    }
  }
  const world = new Float32Array(n * 4);
  const local = new Float32Array(n * 4);
  const wq: Quaternion[] = [];
  for (let i = 0; i < n; i++) {
    const bind = new Quaternion().fromArray(header.bindWorldQuat[i]);
    const q = delta[i].clone().multiply(bind);
    wq.push(q);
    world.set([q.x, q.y, q.z, q.w], i * 4);
    const p = header.parentIndex[i];
    const lq = p < 0 ? q.clone() : wq[p].clone().invert().multiply(q);
    local.set([lq.x, lq.y, lq.z, lq.w], i * 4);
  }
  return {
    sample: { t, local, world, hipsLocal: hipsWorld.toArray() as Vec3Tuple, hipsWorld: hipsWorld.toArray() as Vec3Tuple },
    pos,
    delta,
  };
}

function angleDeg(a: Vector3, b: Vector3): number {
  return Math.acos(Math.min(1, Math.max(-1, a.clone().normalize().dot(b.clone().normalize())))) / D2R;
}

describe('takeToBvh structure', () => {
  it('writes HIERARCHY / ROOT / OFFSET / CHANNELS / End Site / MOTION / Frames / Frame Time', () => {
    const rig = buildRig();
    const rest = drive(rig, 0, {}, new Vector3(0, 0.9, 0));
    const take: Take = { ...rig.header, samples: [rest.sample, { ...rest.sample, t: 1 / 30 }], t0: 0 };
    const text = takeToBvh(take);
    const lines = text.split('\n');
    expect(lines[0]).toBe('HIERARCHY');
    expect(lines[1]).toBe('ROOT hips');
    expect(lines[2]).toBe('{');
    expect(lines[3]).toBe('\tOFFSET 0 0.9 0');
    expect(lines[4]).toBe('\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation');
    expect(text).toContain('\tJOINT spine\n\t{\n\t\tOFFSET 0 0.1 0\n\t\tCHANNELS 3 Zrotation Xrotation Yrotation');
    expect(text).toContain('JOINT leftUpperArm');
    expect(text).toContain('JOINT leftUpperLeg');
    // Leaves get an End Site: head has no child -> its bind +Y (0.25 long); hand's bind +Y is +X (0.15).
    expect(text).toContain('JOINT head\n\t\t{\n\t\t\tOFFSET 0 0.5 0\n\t\t\tCHANNELS 3 Zrotation Xrotation Yrotation\n\t\t\tEnd Site\n\t\t\t{\n\t\t\t\tOFFSET 0 0.25 0\n\t\t\t}');
    expect(text).toMatch(/JOINT leftHand[\s\S]*?End Site\n\t*\{\n\t*OFFSET 0\.15 0 0\n/);
    expect((text.match(/End Site/g) ?? []).length).toBe(5); // head, 2 hands, 2 feet
    expect((text.match(/CHANNELS /g) ?? []).length).toBe(rig.roles.length);
    const motion = lines.indexOf('MOTION');
    expect(motion).toBeGreaterThan(0);
    expect(lines[motion + 1]).toBe('Frames: 2');
    expect(lines[motion + 2]).toBe('Frame Time: 0.033333');
    const frame0 = lines[motion + 3].split(' ');
    expect(frame0).toHaveLength(6 + 3 * (rig.roles.length - 1));
    // Rest pose: zero rotations, absolute root position.
    expect(frame0.slice(0, 3)).toEqual(['0', '0.9', '0']);
    expect(frame0.slice(3).every((v) => v === '0')).toBe(true);
    expect(lines[motion + 5]).toBe('');
    expect(lines).toHaveLength(motion + 6);
    // Custom frame time and cm scale.
    const cm = takeToBvh(take, { unitScale: 100, frameTime: 1 / 60 });
    expect(cm).toContain('\tOFFSET 0 90 0');
    expect(cm).toContain('Frame Time: 0.016667');
  });

  it('orders joints depth first and derives rest directions', () => {
    const rig = buildRig();
    const take: Take = { ...rig.header, samples: [], t0: 0 };
    const order = bvhJointOrder(take);
    expect(order[0]).toBe(rig.roles.indexOf('hips'));
    expect(order).toHaveLength(rig.roles.length);
    expect(new Set(order).size).toBe(rig.roles.length);
    // Children always come after their parent.
    for (let k = 1; k < order.length; k++) {
      expect(order.indexOf(take.parentIndex[order[k]])).toBeLessThan(k);
    }
    const spine = rig.roles.indexOf('spine');
    expect(restDirection(take, spine).toArray().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 0]);
    const rightHand = rig.roles.indexOf('rightHand');
    expect(restDirection(take, rightHand).toArray().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-1, 0, 0]);
  });

  it('rejects takes with several roots', () => {
    const rig = buildRig();
    const bad: Take = { ...rig.header, parentIndex: rig.header.parentIndex.map((p, i) => (rig.roles[i] === 'spine' ? -1 : p)), samples: [], t0: 0 };
    expect(() => takeToBvh(bad)).toThrow(/spine/);
  });
});

describe('BVH round trip', () => {
  it('re-evaluated joint directions match the driven pose within 1° and the root is absolute', () => {
    const rig = buildRig();
    const hipsWorld = new Vector3(0.12, 0.95, -0.3);
    const poses = [
      drive(rig, 0, {}, new Vector3(0, 0.9, 0)),
      drive(
        rig,
        1 / 30,
        {
          hips: rotY(30),
          spine: rotX(20),
          leftUpperArm: rotY(-60), // arm forward (+X toward +Z)
          leftLowerArm: rotZ(30),
          rightUpperArm: rotZ(45).multiply(rotX(-20)),
          leftUpperLeg: rotX(-40),
          leftLowerLeg: rotX(50),
          rightUpperLeg: rotZ(-15),
          head: rotY(25).multiply(rotZ(10)),
        },
        hipsWorld,
      ),
    ];
    const take: Take = { ...rig.header, samples: poses.map((p) => p.sample), t0: 0 };
    for (const unitScale of [1, 100]) {
      const text = takeToBvh(take, { unitScale });
      const parsed = parseBvh(text);
      expect(parsed.joints).toHaveLength(rig.roles.length);
      expect(parsed.frames).toHaveLength(2);
      expect(parsed.frameTime).toBeCloseTo(1 / 30, 6);
      for (let f = 0; f < poses.length; f++) {
        const evaluated = evaluateBvhFrame(parsed, f);
        const expected = poses[f];
        const root = evaluated.get('hips')!;
        const hw = expected.sample.hipsWorld;
        expect(root.pos.x).toBeCloseTo(hw[0] * unitScale, 3);
        expect(root.pos.y).toBeCloseTo(hw[1] * unitScale, 3);
        expect(root.pos.z).toBeCloseTo(hw[2] * unitScale, 3);
        for (let i = 0; i < rig.roles.length; i++) {
          const role = rig.roles[i];
          const st = evaluated.get(role)!;
          expect(st).toBeDefined();
          // Absolute positions (scaled).
          expect(st.pos.distanceTo(expected.pos[i].clone().multiplyScalar(unitScale))).toBeLessThan(1e-3 * unitScale);
          // Direction toward each mapped child.
          for (let c = 0; c < rig.roles.length; c++) {
            if (take.parentIndex[c] !== i) continue;
            const dirBvh = evaluated.get(rig.roles[c])!.pos.clone().sub(st.pos);
            const dirDriven = expected.pos[c].clone().sub(expected.pos[i]);
            expect(angleDeg(dirBvh, dirDriven)).toBeLessThan(1);
          }
          // Leaves: the End Site follows the bone's driven rest direction.
          if (st.end) {
            const bindDir = restDirection(take, i);
            const drivenDir = bindDir.applyQuaternion(expected.delta[i]);
            expect(angleDeg(st.end.clone().sub(st.pos), drivenDir)).toBeLessThan(1);
          }
          // World rotation of every joint equals the driven world delta.
          expect(Math.abs(st.quat.dot(expected.delta[i]))).toBeGreaterThan(Math.cos(0.5 * D2R));
        }
      }
    }
  });
});

const BLENDER_SAMPLE = `HIERARCHY
ROOT Hips
{
	OFFSET 0.000000 1.000000 0.000000
	CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
	JOINT Spine
	{
		OFFSET 0.000000 0.500000 0.000000
		CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
		JOINT Head
		{
			OFFSET 0.000000 0.300000 0.000000
			CHANNELS 3 Xrotation Yrotation Zrotation
			End Site
			{
				OFFSET 0.000000 0.200000 0.000000
			}
		}
	}
	JOINT LeftLeg
	{
		OFFSET 0.100000 0.000000 0.000000
		CHANNELS 3 Zrotation Xrotation Yrotation
		End Site
		{
			OFFSET 0.000000 -0.900000 0.000000
		}
	}
}
MOTION
Frames:	2
Frame Time:	0.041667
0.000000 1.000000 0.000000 0.000000 0.000000 0.000000 0.000000 0.500000 0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 0.000000
1.000000 2.000000 3.000000 90.000000 0.000000 0.000000 0.000000 0.500000 0.000000 0.000000 90.000000 0.000000 0.000000 0.000000 -90.000000 0.000000 0.000000 0.000000
`;

describe('parseBvh / evaluateBvhFrame on a Blender-style file', () => {
  it('parses tabs, per-joint position channels and mixed channel orders', () => {
    const parsed = parseBvh(BLENDER_SAMPLE);
    expect(parsed.joints.map((j) => j.name)).toEqual(['Hips', 'Spine', 'Head', 'LeftLeg']);
    expect(parsed.joints.map((j) => j.parent)).toEqual([-1, 0, 1, 0]);
    expect(parsed.joints[2].channels).toEqual(['Xrotation', 'Yrotation', 'Zrotation']);
    expect(parsed.joints[2].endSite).toEqual([0, 0.2, 0]);
    expect(parsed.joints[3].offset).toEqual([0.1, 0, 0]);
    expect(parsed.frameTime).toBeCloseTo(0.041667, 6);
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.channelCount).toBe(18);

    const f0 = evaluateBvhFrame(parsed, 0);
    expect(f0.get('Hips')!.pos.toArray()).toEqual([0, 1, 0]);
    expect(f0.get('Spine')!.pos.toArray()).toEqual([0, 1.5, 0]);
    expect(f0.get('Head')!.pos.toArray()).toEqual([0, 1.8, 0]);
    expect(f0.get('Head')!.end!.toArray()).toEqual([0, 2, 0]);
    expect(f0.get('LeftLeg')!.pos.toArray()).toEqual([0.1, 1, 0]);

    // Frame 1: root at (1,2,3) rotated 90° about Z: +Y children go to -X; the
    // spine's position channel (0,0.5,0) is rotated by the root; the spine
    // rotates 90° about X on top (its +Y -> +Z), the head undoes the root's Z.
    const f1 = evaluateBvhFrame(parsed, 1);
    const near = (v: Vector3, x: number, y: number, z: number) => {
      expect(v.x).toBeCloseTo(x, 6);
      expect(v.y).toBeCloseTo(y, 6);
      expect(v.z).toBeCloseTo(z, 6);
    };
    near(f1.get('Hips')!.pos, 1, 2, 3);
    near(f1.get('Spine')!.pos, 0.5, 2, 3);
    near(f1.get('Head')!.pos, 0.5, 2, 3.3);
    // Head: Rz(90)·Rx(90)·Rz(-90) applied to the end site (0, 0.2, 0).
    const q = rotZ(90).multiply(rotX(90)).multiply(rotZ(-90));
    const e = new Vector3(0, 0.2, 0).applyQuaternion(q).add(f1.get('Head')!.pos);
    near(f1.get('Head')!.end!, e.x, e.y, e.z);
    near(f1.get('LeftLeg')!.pos, 1, 2.1, 3);
    near(f1.get('LeftLeg')!.end!, 1.9, 2.1, 3);
  });

  it('reports malformed input', () => {
    expect(() => parseBvh('HIERARCHY\nMOTION\n')).toThrow();
    expect(() => parseBvh('HIERARCHY\nROOT a\n{\nOFFSET 0 0 0\nCHANNELS 1 Wrotation\n}\nMOTION\nFrames: 0\nFrame Time: 0.1\n')).toThrow(/channel/);
  });
});
