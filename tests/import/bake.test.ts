import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { HumanoidBone } from '../../src/core/types';
import { angleBetween } from '../../src/core/math';
import { bakeRecording, bakeRecordingAsync, createBaker } from '../../src/import/bake';
import { StandingBaseline } from '../../src/retarget/calibration';
import { PoseFilter } from '../../src/tracking/PoseFilter';
import { SYNTHETIC_PRESETS, computeLandmarkPositions, generateRecording } from '../../src/testing/syntheticHuman';
import { SMOOTHING, buildRig, degrees, groundTruthDirections, makePipeline } from '../retarget/helpers';

const LIMBS: readonly HumanoidBone[] = ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm', 'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];

function pipelineFor(rigPose: 'tpose' | 'apose') {
  const rig = buildRig({ pose: rigPose, axis: 'y', shoulders: true });
  const pipe = makePipeline(rig, { hipsMode: 'locked', depthTranslation: false });
  return {
    rig,
    bake: {
      filter: new PoseFilter(SMOOTHING, false),
      bodyModel: pipe.model,
      baseline: new StandingBaseline(SMOOTHING),
      retargeter: pipe.retargeter,
      noKnee: rig.analysis.noKnee,
      noElbow: rig.analysis.noElbow,
      mirror: false,
    },
  };
}

/** World direction of a role in a take sample: the solved world delta applied to the bind direction. */
function sampleDirection(take: { roles: HumanoidBone[]; bindWorldQuat: number[][] }, world: Float32Array, restDir: Vector3, role: HumanoidBone): Vector3 {
  const i = take.roles.indexOf(role);
  const q = new Quaternion().fromArray(world, 4 * i);
  const bind = new Quaternion().fromArray(take.bindWorldQuat[i]);
  return restDir.clone().applyQuaternion(q.multiply(bind.invert()));
}

describe('bakeRecording', () => {
  it('samples the whole take onto the clip grid with finite values', () => {
    const { bake } = pipelineFor('apose');
    const rec = generateRecording('arm-raise', { fps: 30, durationSec: 2 });
    const take = bakeRecording(rec, bake, { fps: 30 });
    expect(take.fps).toBe(30);
    expect(take.samples.length).toBe(60);
    expect(take.samples[0].t).toBe(0);
    expect(take.samples[59].t).toBeCloseTo(59 / 30, 6);
    for (const s of take.samples) {
      for (const v of s.local) expect(Number.isFinite(v)).toBe(true);
      for (const v of s.world) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('reproduces a static pose: baked limb directions match the synthetic human within 4°', () => {
    const { rig, bake } = pipelineFor('tpose');
    const rec = generateRecording('apose', { fps: 30, durationSec: 2 });
    const take = bakeRecording(rec, bake, { fps: 30, preRollSec: 1 });
    const pose = SYNTHETIC_PRESETS.apose.poseAt(0);
    const P = computeLandmarkPositions(pose);
    const truth = groundTruthDirections(P);
    const last = take.samples[take.samples.length - 1];
    for (const role of LIMBS) {
      const rest = new Vector3().fromArray(rig.analysis.analysis[role]!.restDir);
      const dir = sampleDirection(take, last.world, rest, role);
      expect(degrees(angleBetween(dir, truth[role]!)), role).toBeLessThan(4);
    }
    // The first sample is already converged thanks to the pre-roll.
    const first = take.samples[0];
    const rest = new Vector3().fromArray(rig.analysis.analysis.leftUpperArm!.restDir);
    expect(degrees(angleBetween(sampleDirection(take, first.world, rest, 'leftUpperArm'), truth.leftUpperArm!))).toBeLessThan(4);
  });

  it('steps incrementally, reports progress and resets the pipeline when finished', () => {
    const { bake } = pipelineFor('apose');
    const rec = generateRecording('tpose', { fps: 10, durationSec: 1 });
    const seen: number[] = [];
    const baker = createBaker(rec, bake, { fps: 10, preRollSec: 0.5, onProgress: (d) => seen.push(d) });
    expect(baker.total).toBe(10 + 5);
    let steps = 0;
    while (baker.step()) steps++;
    expect(steps).toBe(baker.total - 1);
    expect(seen[seen.length - 1]).toBe(baker.total);
    const take = baker.finish();
    expect(take.samples.length).toBe(10);
    expect(baker.finished).toBe(true);
    expect(baker.step()).toBe(false);
  });

  it('bakes asynchronously and honours cancellation', async () => {
    const { bake } = pipelineFor('apose');
    const rec = generateRecording('walk', { fps: 30, durationSec: 1 });
    const take = await bakeRecordingAsync(rec, bake, { fps: 30, yieldEvery: 7 });
    expect(take.samples.length).toBe(30);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(bakeRecordingAsync(rec, bake, { fps: 30, yieldEvery: 1, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects empty recordings and bad rates', () => {
    const { bake } = pipelineFor('apose');
    const rec = generateRecording('tpose', { fps: 10, durationSec: 1 });
    expect(() => bakeRecording({ ...rec, frames: [] }, bake, { fps: 30 })).toThrow(/no frames/);
    expect(() => bakeRecording(rec, bake, { fps: 0 })).toThrow(/fps/);
  });
});
