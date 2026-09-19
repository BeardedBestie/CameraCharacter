import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { LM } from '../../src/tracking/landmarks';
import {
  DEFAULT_CAMERA,
  DEFAULT_HUMAN,
  SYNTHETIC_PRESETS,
  armDown,
  computeLandmarkPositions,
  elbowFlex,
  framePose,
  generateRecording,
  hipFlex,
  kneeFlex,
  standingPose,
} from '../../src/testing/syntheticHuman';

describe('synthetic human FK', () => {
  it('T-pose has the left side at +X, arms horizontal, feet on the floor', () => {
    const p = computeLandmarkPositions(standingPose({}));
    expect(p[LM.LEFT_SHOULDER].x).toBeGreaterThan(0);
    expect(p[LM.RIGHT_SHOULDER].x).toBeLessThan(0);
    expect(p[LM.LEFT_HIP].x).toBeGreaterThan(p[LM.RIGHT_HIP].x);
    expect(Math.abs(p[LM.LEFT_WRIST].y - p[LM.LEFT_SHOULDER].y)).toBeLessThan(1e-9);
    expect(p[LM.LEFT_WRIST].x).toBeCloseTo(DEFAULT_HUMAN.shoulderHalfWidth + DEFAULT_HUMAN.upperArm + DEFAULT_HUMAN.foreArm, 9);
    expect(Math.abs(p[LM.LEFT_HEEL].y)).toBeLessThan(1e-9);
    expect(p[LM.LEFT_FOOT_INDEX].z).toBeGreaterThan(p[LM.LEFT_HEEL].z);
    expect(p[LM.NOSE].z).toBeGreaterThan(p[LM.LEFT_EAR].z);
    expect(p[LM.NOSE].y).toBeGreaterThan(p[LM.LEFT_SHOULDER].y);
  });

  it('arm helpers move limbs in the documented directions', () => {
    const down = computeLandmarkPositions(standingPose({ leftUpperArm: armDown('left', 90), rightUpperArm: armDown('right', 90) }));
    expect(down[LM.LEFT_WRIST].y).toBeLessThan(down[LM.LEFT_SHOULDER].y - 0.5);
    expect(down[LM.RIGHT_WRIST].y).toBeLessThan(down[LM.RIGHT_SHOULDER].y - 0.5);
    const bent = computeLandmarkPositions(standingPose({ leftLowerArm: elbowFlex('left', 90), rightLowerArm: elbowFlex('right', 90) }));
    expect(bent[LM.LEFT_WRIST].z).toBeGreaterThan(bent[LM.LEFT_ELBOW].z + 0.2);
    expect(bent[LM.RIGHT_WRIST].z).toBeGreaterThan(bent[LM.RIGHT_ELBOW].z + 0.2);
  });

  it('leg helpers flex hips forward and knees backward', () => {
    const p = computeLandmarkPositions(standingPose({ leftUpperLeg: hipFlex(60), rightLowerLeg: kneeFlex(60) }));
    expect(p[LM.LEFT_KNEE].z).toBeGreaterThan(p[LM.LEFT_HIP].z + 0.3);
    expect(p[LM.RIGHT_ANKLE].z).toBeLessThan(p[LM.RIGHT_KNEE].z - 0.3);
  });
});

describe('projection to MediaPipe conventions', () => {
  it('world landmarks are hip-centered with y down and z toward camera negative', () => {
    const f = framePose(standingPose({}));
    expect(f.pose).not.toBeNull();
    const w = f.pose!.world;
    const hip = w[LM.LEFT_HIP];
    const rhip = w[LM.RIGHT_HIP];
    expect(Math.abs(hip[0] + rhip[0])).toBeLessThan(1e-6);
    expect(Math.abs(hip[1])).toBeLessThan(1e-6);
    // Left side at +x (image right), head above hips means negative y.
    expect(hip[0]).toBeGreaterThan(0);
    expect(w[LM.NOSE][1]).toBeLessThan(-0.5);
    // Nose is closer to the camera than the ears => smaller (more negative) z.
    expect(w[LM.NOSE][2]).toBeLessThan(w[LM.LEFT_EAR][2]);
  });

  it('image landmarks lie inside the frame for a full-body view and the subject left appears on image right', () => {
    const f = framePose(standingPose({}));
    const img = f.pose!.image;
    for (const [u, v, , vis] of img) {
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
      expect(vis).toBeGreaterThan(0.9);
    }
    expect(img[LM.LEFT_SHOULDER][0]).toBeGreaterThan(img[LM.RIGHT_SHOULDER][0]);
    expect(img[LM.NOSE][1]).toBeLessThan(img[LM.LEFT_HIP][1]);
  });

  it('close-up camera drops visibility of out-of-frame legs', () => {
    const preset = SYNTHETIC_PRESETS.closeup;
    const pose = preset.poseAt(0);
    const f = framePose(pose, 0, preset.camera);
    const img = f.pose!.image;
    expect(img[LM.LEFT_ANKLE][3]).toBeLessThan(0.3);
    expect(img[LM.NOSE][3]).toBeGreaterThan(0.9);
  });

  it('image z is negative for points closer to the camera than the hips', () => {
    const f = framePose(standingPose({ leftLowerArm: elbowFlex('left', 90) }), 0, DEFAULT_CAMERA);
    expect(f.pose!.image[LM.LEFT_WRIST][2]).toBeLessThan(0);
  });
});

describe('generateRecording', () => {
  it('produces a valid v2 recording for every preset', () => {
    for (const name of Object.keys(SYNTHETIC_PRESETS)) {
      const rec = generateRecording(name, { fps: 10, durationSec: 1 });
      expect(rec.format).toBe('cameracharacter-mocap');
      expect(rec.frames.length).toBe(10);
      for (const fr of rec.frames) {
        expect(fr.v).toBe(2);
        expect(fr.pose?.world.length).toBe(33);
        expect(fr.pose?.image.length).toBe(33);
        for (const l of fr.pose!.world) for (const x of l) expect(Number.isFinite(x)).toBe(true);
      }
      const ts = rec.frames.map((f) => f.t);
      for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    }
  });

  it('approach preset ends with legs out of frame', () => {
    const rec = generateRecording('approach', { fps: 5 });
    const last = rec.frames[rec.frames.length - 1].pose!.image;
    expect(last[LM.LEFT_ANKLE][3]).toBeLessThan(0.5);
    expect(last[LM.NOSE][3]).toBeGreaterThan(0.9);
    const first = rec.frames[0].pose!.image;
    expect(first[LM.LEFT_ANKLE][3]).toBeGreaterThan(0.9);
  });

  it('occluded-arm preset lowers left wrist visibility mid-take', () => {
    const rec = generateRecording('occluded-arm', { fps: 10 });
    const mid = rec.frames[Math.floor(rec.frames.length / 2)].pose!.world;
    expect(mid[LM.LEFT_WRIST][3]).toBeLessThan(0.2);
    expect(mid[LM.RIGHT_WRIST][3]).toBeGreaterThan(0.9);
  });

  it('T-pose world landmark distances match the human dimensions', () => {
    const rec = generateRecording('tpose', { fps: 1, durationSec: 1 });
    const w = rec.frames[0].pose!.world;
    const v = (i: number) => new Vector3(w[i][0], w[i][1], w[i][2]);
    expect(v(LM.LEFT_SHOULDER).distanceTo(v(LM.LEFT_ELBOW))).toBeCloseTo(DEFAULT_HUMAN.upperArm, 4);
    expect(v(LM.LEFT_HIP).distanceTo(v(LM.LEFT_KNEE))).toBeCloseTo(DEFAULT_HUMAN.thigh, 4);
  });
});
