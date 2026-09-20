import { describe, expect, it } from 'vitest';
import { Bone, Group, Object3D, PropertyBinding, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import type { HumanoidBone, Take, TakeSample } from '../../src/core/types';
import { ClipRecorder, assertTracksResolvable, takeToAnimationClip, trackNodeName } from '../../src/record/ClipRecorder';

interface TinyRig {
  root: Group;
  bones: Bone[];
  header: Omit<Take, 'samples' | 't0'>;
}

/** hips -> spine -> head, under an armature group. */
function tinyRig(): TinyRig {
  const root = new Group();
  root.name = 'wrapper';
  const armature = new Object3D();
  armature.name = 'Armature';
  root.add(armature);
  const hips = new Bone();
  hips.name = 'Hips';
  hips.position.set(0, 0.9, 0);
  const spine = new Bone();
  spine.name = 'Spine';
  spine.position.set(0, 0.2, 0);
  const head = new Bone();
  head.name = 'Head';
  head.position.set(0, 0.5, 0);
  armature.add(hips);
  hips.add(spine);
  spine.add(head);
  root.updateMatrixWorld(true);
  const bones = [hips, spine, head];
  const roles: HumanoidBone[] = ['hips', 'spine', 'head'];
  return {
    root,
    bones,
    header: {
      fps: 30,
      roles,
      boneNames: bones.map((b) => b.name),
      bindWorldQuat: bones.map((b) => b.getWorldQuaternion(new Quaternion()).toArray() as [number, number, number, number]),
      bindWorldPos: bones.map((b) => b.getWorldPosition(new Vector3()).toArray() as [number, number, number]),
      parentIndex: [-1, 0, 1],
      lengths: [0.2, 0.5, 0.15],
    },
  };
}

function sample(t: number, marker: number): TakeSample {
  const local = new Float32Array(12);
  const world = new Float32Array(12);
  for (let r = 0; r < 3; r++) {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), marker * 0.01 * (r + 1));
    local.set([q.x, q.y, q.z, q.w], r * 4);
    world.set([q.x, q.y, q.z, q.w], r * 4);
  }
  return { t, local, world, hipsLocal: [marker, 0.9, 0], hipsWorld: [marker, 0.9, 0] };
}

describe('ClipRecorder', () => {
  it('snaps samples to the fps grid, drops faster samples, keeps the nearest and holds across gaps', () => {
    const rig = tinyRig();
    const rec = new ClipRecorder(rig.header, 30);
    rec.push(sample(0, 99)); // ignored before start
    rec.start(5000);
    rec.push(sample(0, 1)); // slot 0
    rec.push(sample(0.01, 2)); // slot 0 again, farther from 0 -> dropped
    rec.push(sample(0.03, 3)); // slot 1 (1/30 = 0.0333)
    rec.push(sample(0.035, 4)); // slot 1, closer -> replaces
    rec.push(sample(0.1, 5)); // slot 3; slot 2 is filled by holding slot 1
    rec.push(sample(0.05, 6)); // late for slot 2 (already filled) -> dropped
    expect(rec.sampleCount).toBe(4);
    const take = rec.stop();
    expect(take.t0).toBe(5000);
    expect(take.fps).toBe(30);
    expect(take.roles).toEqual(['hips', 'spine', 'head']);
    expect(take.samples.map((s) => s.t)).toEqual([0, 1 / 30, 2 / 30, 3 / 30]);
    expect(take.samples.map((s) => s.hipsLocal[0])).toEqual([1, 4, 4, 5]);
    // Buffers are copied, not shared.
    const s = sample(0.2, 7);
    const rec2 = new ClipRecorder(rig.header, 30);
    rec2.start(0);
    rec2.push(s);
    s.local[0] = 123;
    expect(rec2.stop().samples[0].local[0]).not.toBe(123);
  });

  it('rejects a non-positive fps', () => {
    expect(() => new ClipRecorder(tinyRig().header, 0)).toThrow();
  });
});

describe('takeToAnimationClip', () => {
  it('names tracks by uuid and fills them from the samples', () => {
    const rig = tinyRig();
    const rec = new ClipRecorder(rig.header, 30);
    rec.start(0);
    for (let i = 0; i < 10; i++) rec.push(sample(i / 30, i));
    const take = rec.stop();
    const clip = takeToAnimationClip(take, rig.bones, rig.bones[0], 'test');
    expect(clip.name).toBe('test');
    expect(clip.tracks).toHaveLength(4);
    expect(clip.duration).toBeCloseTo(9 / 30, 5);
    for (let r = 0; r < 3; r++) {
      const track = clip.tracks[r];
      expect(track).toBeInstanceOf(QuaternionKeyframeTrack);
      expect(track.name).toBe(`${rig.bones[r].uuid}.quaternion`);
      expect(trackNodeName(track.name)).toBe(rig.bones[r].uuid);
      expect(track.times).toHaveLength(10);
      expect(track.values).toHaveLength(40);
      expect(Array.from(track.values.slice(4, 8))).toEqual(Array.from(take.samples[1].local.slice(r * 4, r * 4 + 4)));
      // The exporter resolves this name to the bone.
      expect(PropertyBinding.findNode(rig.root, trackNodeName(track.name))).toBe(rig.bones[r]);
    }
    const pos = clip.tracks[3];
    expect(pos).toBeInstanceOf(VectorKeyframeTrack);
    expect(pos.name).toBe(`${rig.bones[0].uuid}.position`);
    const first6 = Array.from(pos.values.slice(0, 6));
    [0, 0.9, 0, 1, 0.9, 0].forEach((v, i) => expect(first6[i]).toBeCloseTo(v, 6));
    expect(() => assertTracksResolvable(clip, rig.root)).not.toThrow();
    expect(() => assertTracksResolvable(clip, new Group())).toThrow(/do not resolve/);
  });

  it('rejects mismatched bone counts and empty takes', () => {
    const rig = tinyRig();
    const rec = new ClipRecorder(rig.header, 30);
    rec.start(0);
    const empty = rec.stop();
    expect(() => takeToAnimationClip(empty, rig.bones, rig.bones[0])).toThrow(/no samples/);
    rec.start(0);
    rec.push(sample(0, 1));
    const take = rec.stop();
    expect(() => takeToAnimationClip(take, rig.bones.slice(0, 2), rig.bones[0])).toThrow(/bones/);
  });
});
