import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { LM } from '../../src/tracking/landmarks';
import { BodyModel, MIN_SEGMENT_SAMPLES, RunningMedian, twoBoneJoint, type BodyModelOptions } from '../../src/retarget/bodyModel';
import {
  DEFAULT_HUMAN,
  armDown,
  computeLandmarkPositions,
  elbowFlex,
  framePose,
  hipFlex,
  kneeFlex,
  standingPose,
} from '../../src/testing/syntheticHuman';
import { degrees, filteredFromFrame, SMOOTHING } from './helpers';
import { angleBetween } from '../../src/core/math';

const OPTS: BodyModelOptions = { framing: 'full', noKnee: { left: false, right: false }, noElbow: { left: false, right: false }, mirror: false };
const DT = 1 / 30;

function angleDeg(a: Vector3, b: Vector3): number {
  return degrees(angleBetween(a, b));
}

describe('BodyModel measured bases', () => {
  it('T-pose: arm directions along ±X with the forward fallback up, torso up/forward, dorsal normals up', () => {
    const model = new BodyModel(SMOOTHING);
    const r = model.update(filteredFromFrame(framePose(standingPose({}))), DT, OPTS);
    const b = r.bases;
    expect(angleDeg(b.leftUpperArm!.d, new Vector3(1, 0, 0))).toBeLessThan(0.5);
    expect(angleDeg(b.rightUpperArm!.d, new Vector3(-1, 0, 0))).toBeLessThan(0.5);
    expect(angleDeg(b.leftUpperArm!.u, new Vector3(0, 0, 1))).toBeLessThan(1);
    expect(b.leftUpperArm!.cU).toBe(0); // straight elbow: fallback only
    expect(b.leftUpperArm!.source).toBe('measured');
    expect(angleDeg(r.torso.hips.d, new Vector3(0, 1, 0))).toBeLessThan(0.5);
    expect(angleDeg(r.torso.hips.u, new Vector3(0, 0, 1))).toBeLessThan(0.5);
    expect(angleDeg(r.torso.shoulders.u, new Vector3(0, 0, 1))).toBeLessThan(0.5);
    expect(angleDeg(b.head!.d, new Vector3(0, 1, 0))).toBeLessThan(2);
    expect(angleDeg(b.head!.u, new Vector3(0, 0, 1))).toBeLessThan(2);
    expect(angleDeg(b.neck!.d, new Vector3(0, 1, 0))).toBeLessThan(2);
    // Palms down: the dorsal normal points up on both sides.
    expect(angleDeg(b.leftLowerArm!.u, new Vector3(0, 1, 0))).toBeLessThan(1);
    expect(angleDeg(b.rightLowerArm!.u, new Vector3(0, 1, 0))).toBeLessThan(1);
    expect(b.leftLowerArm!.cU).toBeGreaterThan(0.9);
    expect(angleDeg(b.leftHand!.u, new Vector3(0, 1, 0))).toBeLessThan(1);
    expect(angleDeg(b.rightHand!.d, new Vector3(-1, 0, 0))).toBeLessThan(3);
    // Legs straight down, kneecap fallback forward; foot ankle->toe forward-down; toes horizontal.
    expect(angleDeg(b.leftUpperLeg!.d, new Vector3(0, -1, 0))).toBeLessThan(0.5);
    expect(angleDeg(b.leftUpperLeg!.u, new Vector3(0, 0, 1))).toBeLessThan(1);
    expect(b.leftUpperLeg!.cU).toBe(0);
    expect(angleDeg(b.leftLowerLeg!.u, new Vector3(0, 0, 1))).toBeLessThan(1);
    expect(angleDeg(b.leftFoot!.d, new Vector3(0, -DEFAULT_HUMAN.ankleHeight, DEFAULT_HUMAN.footLength))).toBeLessThan(0.5);
    expect(angleDeg(b.leftFoot!.u, new Vector3(0, 1, 0))).toBeLessThan(25);
    expect(Math.abs(b.leftToes!.d.y)).toBeLessThan(1e-9);
    expect(r.hipsConfidence).toBeGreaterThan(0.9);
    expect(r.hipsLost).toBe(false);
    for (const role of ['leftUpperArm', 'leftLowerArm', 'leftHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'neck', 'head'] as const) {
      expect(b[role]!.c).toBeGreaterThan(0.9);
    }
  });

  it('a bent elbow yields the flexion direction with full up confidence; a bent knee the kneecap direction', () => {
    const model = new BodyModel(SMOOTHING);
    const pose = standingPose({ leftLowerArm: elbowFlex('left', 60), rightUpperLeg: hipFlex(20), rightLowerLeg: kneeFlex(60) });
    const r = model.update(filteredFromFrame(framePose(pose)), DT, OPTS);
    // Left forearm swings toward +Z: flexion direction +Z.
    expect(angleDeg(r.bases.leftUpperArm!.u, new Vector3(0, 0, 1))).toBeLessThan(1);
    expect(r.bases.leftUpperArm!.cU).toBeGreaterThan(0.9);
    expect(degrees(r.bendAngles.leftUpperArm!)).toBeCloseTo(60, 0);
    // Right knee bent: the heel swings backward so the kneecap points forward (+Z-ish, in the thigh plane).
    const u = r.bases.rightUpperLeg!.u;
    expect(u.z).toBeGreaterThan(0.8);
    expect(r.bases.rightUpperLeg!.cU).toBeGreaterThan(0.9);
    expect(degrees(r.bendAngles.rightUpperLeg!)).toBeCloseTo(60, 0);
  });

  it('holds a lost limb for poseHoldMs, then fades its confidence to zero', () => {
    const model = new BodyModel(SMOOTHING);
    const frame = framePose(standingPose({ leftLowerArm: elbowFlex('left', 40) }));
    model.update(filteredFromFrame(frame), DT, OPTS);
    const lost = { [LM.LEFT_WRIST]: 0, [LM.LEFT_INDEX]: 0, [LM.LEFT_PINKY]: 0, [LM.LEFT_THUMB]: 0 };
    const cs: number[] = [];
    const sources: string[] = [];
    let t = 0;
    for (let i = 0; i < 45; i++) {
      t += DT;
      const r = model.update(filteredFromFrame(frame, { visibility: lost, t }), DT, OPTS);
      cs.push(r.bases.leftLowerArm!.c);
      sources.push(r.bases.leftLowerArm!.source);
    }
    const holdFrames = Math.floor((SMOOTHING.poseHoldMs.arms / 1000) / DT);
    for (let i = 0; i < holdFrames - 1; i++) {
      expect(cs[i]).toBeGreaterThan(0.9);
      expect(sources[i]).toBe('hold');
    }
    expect(cs[cs.length - 1]).toBe(0);
    for (let i = 1; i < cs.length; i++) expect(cs[i]).toBeLessThanOrEqual(cs[i - 1] + 1e-9);
    // The upper arm still tracks (shoulder and elbow visible) but its up reference is unconfident.
    const r = model.update(filteredFromFrame(frame, { visibility: lost, t }), DT, OPTS);
    expect(r.bases.leftUpperArm!.c).toBeGreaterThan(0.9);
    expect(r.bases.leftUpperArm!.cU).toBe(0);
  });

  it('framing policies: waist relaxes legs, bust ignores hips, face keeps only head/neck', () => {
    const model = new BodyModel(SMOOTHING);
    const frame = framePose(standingPose({}));
    model.update(filteredFromFrame(frame), DT, OPTS);
    const waist = model.update(filteredFromFrame(frame), DT, { ...OPTS, framing: 'waist' });
    expect(waist.bases.leftUpperLeg!.c).toBe(0);
    expect(waist.bases.leftUpperArm!.c).toBeGreaterThan(0.9);
    expect(waist.hipsLost).toBe(false);
    const bust = model.update(filteredFromFrame(frame), DT, { ...OPTS, framing: 'bust' });
    expect(bust.hipsLost).toBe(true);
    expect(bust.hipsConfidence).toBe(0);
    expect(bust.torso.hips.source).toBe('hold');
    const face = model.update(filteredFromFrame(frame), DT, { ...OPTS, framing: 'face' });
    expect(face.bases.leftUpperArm!.c).toBe(0);
    expect(face.bases.head!.c).toBeGreaterThan(0.9);
    expect(face.torso.hips.source).toBe('hold');
    expect(face.torso.hips.c).toBeGreaterThan(0.9);
  });

  it('hips lost: the pelvis eases to the shoulder yaw over 2 s and legs relax', () => {
    const model = new BodyModel(SMOOTHING);
    const yawed = standingPose({}, { rootYaw: 0.4 });
    const frame = framePose(yawed);
    // Establish a measured pelvis, then lose the hips.
    model.update(filteredFromFrame(frame), DT, OPTS);
    const lost = { [LM.LEFT_HIP]: 0.2, [LM.RIGHT_HIP]: 0.2 };
    let r = model.update(filteredFromFrame(frame, { visibility: lost, t: DT }), DT, OPTS);
    expect(r.hipsLost).toBe(true);
    expect(r.torso.hips.source).toBe('hold');
    let t = DT;
    for (let i = 0; i < 90; i++) {
      t += DT;
      r = model.update(filteredFromFrame(frame, { visibility: lost, t }), DT, OPTS);
    }
    expect(r.torso.hips.source).toBe('fallback');
    expect(angleDeg(r.torso.hips.d, new Vector3(0, 1, 0))).toBeLessThan(0.5);
    // Shoulder-line forward for a yaw of 0.4 rad about Y.
    const fwd = new Vector3(Math.sin(0.4), 0, Math.cos(0.4));
    expect(angleDeg(r.torso.hips.u, fwd)).toBeLessThan(1);
    expect(r.bases.leftUpperLeg!.c).toBe(0);
  });
});

describe('two-bone fallback', () => {
  it('twoBoneJoint places the joint on the solution circle', () => {
    const S = new Vector3(0, 0, 0);
    const W = new Vector3(0.4, 0, 0);
    const out = new Vector3();
    expect(twoBoneJoint(S, W, 0.28, 0.26, new Vector3(0, 0, -1), out)).toBe(true);
    expect(out.distanceTo(S)).toBeCloseTo(0.28, 6);
    expect(out.distanceTo(W)).toBeCloseTo(0.26, 6);
    expect(out.z).toBeLessThan(0);
    expect(twoBoneJoint(S, W, 0.28, 0.26, new Vector3(1, 0, 0), out)).toBe(false);
  });

  it('running median tracks the middle of a window', () => {
    const m = new RunningMedian(5);
    for (const v of [5, 1, 4, 2, 3]) m.push(v);
    expect(m.value()).toBe(3);
    m.push(100);
    m.push(100);
    expect(m.value()).toBe(4);
  });

  it('a lost elbow is reconstructed within 3 cm after 60 warm-up frames', () => {
    const model = new BodyModel(SMOOTHING);
    const pose = standingPose({ leftUpperArm: armDown('left', 75), leftLowerArm: elbowFlex('left', 55) });
    const pts = computeLandmarkPositions(pose);
    const hipMid = pts[LM.LEFT_HIP].clone().add(pts[LM.RIGHT_HIP]).multiplyScalar(0.5);
    const trueElbow = pts[LM.LEFT_ELBOW].clone().sub(hipMid);
    const frame = framePose(pose);
    let t = 0;
    for (let i = 0; i < MIN_SEGMENT_SAMPLES; i++) {
      model.update(filteredFromFrame(frame, { t }), DT, OPTS);
      t += DT;
    }
    const r0 = model.update(filteredFromFrame(frame, { t }), DT, OPTS);
    expect(r0.segmentLengths.upperArm).toBeCloseTo(DEFAULT_HUMAN.upperArm, 3);
    expect(r0.segmentLengths.lowerArm).toBeCloseTo(DEFAULT_HUMAN.foreArm, 3);
    // Now lose the elbow. The reconstructed joint must stay near the truth while the normal decays.
    for (let i = 0; i < 10; i++) {
      t += DT;
      const r = model.update(filteredFromFrame(frame, { t, visibility: { [LM.LEFT_ELBOW]: 0 } }), DT, OPTS);
      expect(r.bases.leftUpperArm!.source).toBe('twoBone');
      expect(r.bases.leftUpperArm!.c).toBeGreaterThan(0.9);
      expect(r.joints[LM.LEFT_ELBOW].distanceTo(trueElbow)).toBeLessThan(0.03);
      expect(angleDeg(r.bases.leftUpperArm!.d, trueElbow.clone().sub(pts[LM.LEFT_SHOULDER].clone().sub(hipMid)))).toBeLessThan(5);
    }
  });

  it('without enough samples the limb holds instead of solving', () => {
    const model = new BodyModel(SMOOTHING);
    const pose = standingPose({ leftUpperArm: armDown('left', 75), leftLowerArm: elbowFlex('left', 55) });
    const frame = framePose(pose);
    model.update(filteredFromFrame(frame), DT, OPTS);
    const r = model.update(filteredFromFrame(frame, { t: DT, visibility: { [LM.LEFT_ELBOW]: 0 } }), DT, OPTS);
    expect(r.bases.leftUpperArm!.source).toBe('hold');
  });
});
