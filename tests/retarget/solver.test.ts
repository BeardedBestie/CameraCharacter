import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { HumanoidBone, Take } from '../../src/core/types';
import { DEG2RAD, angleBetween, flexionUp, quatAngle, swingTwist } from '../../src/core/math';
import { LM } from '../../src/tracking/landmarks';
import { MIN_SEGMENT_SAMPLES } from '../../src/retarget/bodyModel';
import { StandingBaseline } from '../../src/retarget/calibration';
import { FRAMING_BOUNDS, fitFraming } from '../../src/retarget/framing';
import { makeTakeHeader } from '../../src/retarget/solver';
import { evaluateBvhFrame, parseBvh, takeToBvh } from '../../src/record/exportBvh';
import {
  DEFAULT_CAMERA,
  SYNTHETIC_PRESETS,
  armDown,
  armForward,
  computeLandmarkPositions,
  elbowFlex,
  framePose,
  headNod,
  hipFlex,
  kneeFlex,
  rotX,
  rotZ,
  standingPose,
  toPoseFrame,
} from '../../src/testing/syntheticHuman';
import {
  type BuiltRig,
  SMOOTHING,
  assertFinite,
  buildRig,
  degrees,
  filteredFromFrame,
  forwardYawDeg,
  groundTruthDirections,
  makePipeline,
  mulberry32,
  presetFrames,
  tailNode,
  worldDelta,
  worldDirection,
} from './helpers';

const DT = 1 / 30;
const LIMB_ROLES: readonly HumanoidBone[] = [
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
];
const TORSO_ROLES: readonly HumanoidBone[] = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
const PRESETS = ['tpose', 'apose', 'arm-raise', 'squat', 'walk', 'wave'] as const;

function angleDeg(a: Vector3, b: Vector3): number {
  return degrees(angleBetween(a, b));
}

/** The five rigs of DESIGN §13: T-pose, A-pose, arms-down with bent elbows, rotated+scaled armature, no-knee. */
function rigs(): BuiltRig[] {
  return [
    buildRig({ pose: 'tpose', axis: 'y', shoulders: true }),
    buildRig({ pose: 'apose', axis: 'x' }),
    buildRig({ pose: 'armsDown', axis: 'identity', shoulders: true, upperChest: true }),
    buildRig({
      pose: 'tpose',
      axis: 'y',
      armature: { quaternion: rotX(90), scale: 0.01 },
      intermediates: true,
      shoulders: true,
      upperChest: true,
    }),
    buildRig({ pose: 'noKnee', axis: 'y' }),
  ];
}

function armatureRig(): BuiltRig {
  return buildRig({
    pose: 'tpose',
    axis: 'y',
    armature: { quaternion: rotX(90), scale: 0.01 },
    intermediates: true,
    shoulders: true,
    upperChest: true,
  });
}

/** World direction of a role from three.js matrices; the chord for chord-driven (no-knee) shins. */
function rigDirection(rig: BuiltRig, role: HumanoidBone, source: string): Vector3 | null {
  rig.root.updateMatrixWorld(true);
  const bone = rig.bones[role]!;
  const tail = tailNode(rig, role);
  if (!tail) return null;
  if (source === 'chord') {
    const parentRole = rig.analysis.analysis[role]!.parentRole;
    if (parentRole && rig.bones[parentRole]) return worldDirection(rig.bones[parentRole]!, tail);
  }
  return worldDirection(bone, tail);
}

describe('Retargeter property tests (DESIGN §6.2/§6.3)', () => {
  for (const rig of rigs()) {
    it(`${rig.name}: driven bones match the measured directions within 2° (solver chain and three.js)`, () => {
      for (const preset of PRESETS) {
        // A Retargeter reads bind locals from the nodes, so the rig must be back in its bind pose.
        const pipe = makePipeline(rig);
        for (const frame of presetFrames(preset)) {
          const pose = filteredFromFrame(frame);
          const { result, solve } = pipe.converge(pose);
          assertFinite(rig);
          expect(solve.framing).toBe('full');
          let checked = 0;
          for (const role of [...LIMB_ROLES, ...TORSO_ROLES]) {
            const out = solve.perRole[role];
            const basis = role === 'hips' ? result.torso.hips : result.bases[role];
            if (!out || !basis) continue;
            if (out.mode === 'follow' || out.mode === 'off') continue;
            if (!(basis.c > 0.5)) continue;
            const label = `${rig.name} ${preset} t=${frame.t} ${role}`;
            // Solver's own world chain.
            expect(out.errorDeg, label).not.toBeNull();
            expect(out.errorDeg!, label).toBeLessThan(2);
            // three.js matrices after updateMatrixWorld (proves the world->local conversion).
            const dir = rigDirection(rig, role, out.source);
            if (dir && TORSO_ROLES.indexOf(role) < 0) expect(angleDeg(dir, basis.d), label).toBeLessThan(2);
            // The solver's world quaternion equals three.js' world quaternion.
            const q = rig.bones[role]!.getWorldQuaternion(new Quaternion());
            expect(degrees(quatAngle(q, out.worldQuat)), label).toBeLessThan(0.05);
            checked++;
          }
          expect(checked).toBeGreaterThanOrEqual(12);
          // Chains: the rig's upper->end chord equals the chord built from the rig's own segment lengths
          // along the measured directions (the rig's thigh/shin ratio differs from the user's, so the raw
          // chain error is only exact for chord-driven limbs).
          for (const [upper, lower, end, chordKey] of [
            ['leftUpperArm', 'leftLowerArm', 'leftHand', 'leftArm'],
            ['rightUpperArm', 'rightLowerArm', 'rightHand', 'rightArm'],
            ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftLeg'],
            ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightLeg'],
          ] as const) {
            const bu = result.bases[upper]!;
            const bl = result.bases[lower]!;
            if (!(bu.c > 0.5) || !(bl.c > 0.5)) continue;
            const label = `${rig.name} ${preset} t=${frame.t} ${chordKey}`;
            if (bu.source === 'chord') {
              expect(solve.chainErrorDeg[chordKey], label).not.toBeNull();
              expect(solve.chainErrorDeg[chordKey]!, label).toBeLessThan(2);
              continue;
            }
            const au = rig.analysis.analysis[upper]!;
            const al = rig.analysis.analysis[lower]!;
            const expected = bu.d.clone().multiplyScalar(au.length).addScaledVector(bl.d, al.length);
            rig.root.updateMatrixWorld(true);
            const actual = rig.bones[end]!.getWorldPosition(new Vector3()).sub(rig.bones[upper]!.getWorldPosition(new Vector3()));
            expect(angleDeg(actual, expected), label).toBeLessThan(2);
            expect(Math.abs(actual.length() - expected.length()), label).toBeLessThan(0.01);
          }
        }
        pipe.retargeter.reset();
      }
    });
  }

  it('shoulders take 30 % of the arm swing and match the clavicle direction when the arms are level', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y', shoulders: true });
    const pipe = makePipeline(rig);
    const { solve } = pipe.converge(filteredFromFrame(framePose(standingPose({}))));
    expect(solve.perRole.leftShoulder!.errorDeg!).toBeLessThan(2);
    expect(solve.perRole.rightShoulder!.errorDeg!).toBeLessThan(2);
    // Arm raised overhead: the clavicle rises by about 30 % of the swing.
    const raised = pipe.converge(filteredFromFrame(framePose(standingPose({ leftUpperArm: armDown('left', -80) }))));
    const swing = degrees(quatAngle(raised.solve.perRole.leftUpperArm!.worldQuat, new Quaternion().fromArray(rig.analysis.analysis.leftUpperArm!.restQuat)));
    const clav = degrees(quatAngle(raised.solve.perRole.leftShoulder!.worldQuat, new Quaternion().fromArray(rig.analysis.analysis.leftShoulder!.restQuat)));
    expect(swing).toBeGreaterThan(70);
    expect(clav).toBeGreaterThan(0.25 * swing - 2);
    expect(clav).toBeLessThan(0.35 * swing + 2);
  });
});

describe('twist handling', () => {
  it('bent-elbow rig with a straight-armed user keeps its bind twist (cU low)', () => {
    const rig = buildRig({ pose: 'armsDown', axis: 'identity' });
    const pipe = makePipeline(rig);
    const { result, solve } = pipe.converge(filteredFromFrame(framePose(standingPose({}))));
    expect(result.bases.leftUpperArm!.cU).toBe(0);
    expect(solve.perRole.leftUpperArm!.cU).toBe(0);
    for (const role of ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'] as const) {
      const ref = pipe.retargeter.referenceOf(role)!;
      const delta = worldDelta(rig, role);
      const swing = new Quaternion();
      const twist = new Quaternion();
      const angle = swingTwist(delta, ref.d, swing, twist);
      expect(Math.abs(degrees(angle)), role).toBeLessThan(1);
      expect(solve.perRole[role]!.errorDeg!).toBeLessThan(2);
    }
  });

  it('bent-elbow user maps flexion onto the rig hinge (forearm flexion direction within 5°)', () => {
    const rig = buildRig({ pose: 'armsDown', axis: 'identity' });
    const pipe = makePipeline(rig);
    const pose = standingPose({
      leftUpperArm: armDown('left', 75),
      leftLowerArm: elbowFlex('left', 60),
      rightUpperArm: armDown('right', 40),
      rightLowerArm: elbowFlex('right', 90),
    });
    const { result } = pipe.converge(filteredFromFrame(framePose(pose)));
    rig.root.updateMatrixWorld(true);
    for (const side of ['left', 'right'] as const) {
      const upper = worldDirection(rig.bones[`${side}UpperArm`]!, rig.bones[`${side}LowerArm`]!);
      const lower = worldDirection(rig.bones[`${side}LowerArm`]!, rig.bones[`${side}Hand`]!);
      const P = result.joints;
      const L = side === 'left';
      const uUser = P[L ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW].clone().sub(P[L ? LM.LEFT_SHOULDER : LM.RIGHT_SHOULDER]);
      const lUser = P[L ? LM.LEFT_WRIST : LM.RIGHT_WRIST].clone().sub(P[L ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW]);
      const fRig = flexionUp(upper, lower)!;
      const fUser = flexionUp(uUser, lUser)!;
      expect(fRig).not.toBeNull();
      expect(angleDeg(fRig, fUser), side).toBeLessThan(5);
      expect(Math.abs(degrees(angleBetween(upper, lower)) - degrees(angleBetween(uUser, lUser))), side).toBeLessThan(3);
      expect(result.bases[`${side}UpperArm`]!.cU).toBeGreaterThan(0.9);
    }
  });

  it('T-pose rig with the arm crossed in front (d = -d_ref) is finite with a swing axis near ±Y', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y' });
    const pipe = makePipeline(rig);
    // 180° yaw of the left arm through the front, elbow bent so the flexion direction is -Z.
    const pose = standingPose({ leftUpperArm: armForward('left', 180), leftLowerArm: elbowFlex('left', 60) });
    const { result, solve } = pipe.converge(filteredFromFrame(framePose(pose)));
    assertFinite(rig);
    const ref = pipe.retargeter.referenceOf('leftUpperArm')!;
    expect(angleDeg(result.bases.leftUpperArm!.d, ref.d.clone().negate())).toBeLessThan(1);
    const delta = worldDelta(rig, 'leftUpperArm');
    const swing = new Quaternion();
    const twist = new Quaternion();
    swingTwist(delta, ref.d, swing, twist);
    const axis = new Vector3(swing.x, swing.y, swing.z).normalize();
    expect(Math.abs(axis.y)).toBeGreaterThan(0.95);
    expect(degrees(2 * Math.acos(Math.min(1, Math.abs(swing.w))))).toBeGreaterThan(178);
    expect(solve.perRole.leftUpperArm!.errorDeg!).toBeLessThan(2);
    expect(solve.perRole.leftLowerArm!.errorDeg!).toBeLessThan(2);
  });

  it('180° cases (arm straight back, leg straight up, body upside down) produce no NaN', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y', shoulders: true });
    const cases = [
      standingPose({ leftUpperArm: armForward('left', 180), rightUpperArm: armForward('right', 180) }),
      standingPose({ leftUpperLeg: hipFlex(180), rightUpperLeg: hipFlex(-180) }),
      standingPose({ hips: rotZ(180) }, { rootPosition: new Vector3(0, 1.0, 0) }),
      standingPose({ leftUpperArm: armDown('left', 180), rightUpperArm: armDown('right', -180), head: rotX(180) }),
    ];
    for (const pose of cases) {
      const pipe = makePipeline(rig);
      const fp = filteredFromFrame(framePose(pose));
      for (let i = 0; i < 10; i++) {
        const { solve } = pipe.step(fp, DT);
        assertFinite(rig);
        for (const role of solve.roles) {
          const o = solve.perRole[role]!;
          expect(Number.isFinite(o.worldQuat.x + o.worldQuat.y + o.worldQuat.z + o.worldQuat.w)).toBe(true);
          expect(Number.isFinite(o.localQuat.x + o.localQuat.y + o.localQuat.z + o.localQuat.w)).toBe(true);
          if (o.errorDeg !== null) expect(Number.isFinite(o.errorDeg)).toBe(true);
        }
        expect(Number.isFinite(solve.hipsWorldPos.x + solve.hipsWorldPos.y + solve.hipsWorldPos.z)).toBe(true);
      }
    }
  });
});

describe('hips translation through a rotated, scaled armature', () => {
  it('placeHips: a +0.1 m world lift moves hips.matrixWorld by +0.1 in Y', () => {
    const rig = armatureRig();
    const pipe = makePipeline(rig, { hipsMode: 'full' });
    const hips = rig.bones.hips!;
    rig.root.updateMatrixWorld(true);
    const before = hips.getWorldPosition(new Vector3());
    const rest = new Vector3().fromArray(rig.analysis.analysis.hips!.restPos);
    expect(before.distanceTo(rest)).toBeLessThan(1e-6);
    pipe.retargeter.placeHips(rest.clone().add(new Vector3(0, 0.1, 0)));
    rig.root.updateMatrixWorld(true);
    const after = hips.getWorldPosition(new Vector3());
    expect(after.y - before.y).toBeCloseTo(0.1, 6);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
    expect(Math.abs(after.z - before.z)).toBeLessThan(1e-6);
    // The local position went through the armature (rotated 90° about X, scaled 0.01), not a plain Y offset.
    expect(Math.abs(hips.position.y)).toBeLessThan(1e-6);
    expect(Math.abs(hips.position.z) * 0.01).toBeCloseTo(after.y, 6);
  });

  it('full mode: a squat lowers the hips by the scaled ankle-relative drop, feet stay on the floor, orientation matches', () => {
    const rig = armatureRig();
    const pipe = makePipeline(rig, { hipsMode: 'full' });
    const hips = rig.bones.hips!;
    const standing = filteredFromFrame(framePose(standingPose({})));
    let t = 0;
    for (let i = 0; i < 45; i++) {
      pipe.step(filteredFromFrame(framePose(standingPose({}), t), { t }), DT);
      t += DT;
    }
    rig.root.updateMatrixWorld(true);
    const restY = hips.getWorldPosition(new Vector3()).y;
    const ht = rig.analysis.heightTable;
    const userStanding = -Math.min(standing.world[LM.LEFT_ANKLE].y, standing.world[LM.RIGHT_ANKLE].y);
    // Squat: hips 70° flexed, knees 140°, the ankles stay put (see the squat preset).
    const theta = 70;
    const squat = standingPose(
      {
        leftUpperLeg: hipFlex(theta),
        rightUpperLeg: hipFlex(theta),
        leftLowerLeg: kneeFlex(2 * theta),
        rightLowerLeg: kneeFlex(2 * theta),
        leftFoot: kneeFlex(-theta),
        rightFoot: kneeFlex(-theta),
      },
      { rootPosition: new Vector3(0, 0.08 + 0.84 * Math.cos(theta * DEG2RAD), 0) },
    );
    let out = pipe.last!;
    for (let i = 0; i < 60; i++) {
      out = pipe.step(filteredFromFrame(framePose(squat, t), { t }), DT);
      t += DT;
    }
    rig.root.updateMatrixWorld(true);
    const p = hips.getWorldPosition(new Vector3());
    const userSquat = -Math.min(out.result.joints[LM.LEFT_ANKLE].y, out.result.joints[LM.RIGHT_ANKLE].y);
    // The user's leg extension maps onto the rig's thigh-head-to-ankle length (0.82 m here; the hips bone sits 5 cm higher).
    const modelLeg = rig.analysis.analysis.leftUpperLeg!.restPos[1] - rig.analysis.analysis.leftFoot!.restPos[1];
    const s = modelLeg / userStanding;
    const expectedDrop = (userStanding - userSquat) * s;
    expect(expectedDrop).toBeGreaterThan(0.3);
    expect(restY - p.y).toBeCloseTo(expectedDrop, 2);
    expect(Math.abs(p.x)).toBeLessThan(0.01);
    expect(Math.abs(p.z)).toBeLessThan(0.02);
    // The reported world position is the actual one.
    expect(p.distanceTo(out.solve.hipsWorldPos)).toBeLessThan(1e-6);
    // Ankles stay at their rest height above the floor (within the thigh/shin ratio difference).
    for (const role of ['leftFoot', 'rightFoot'] as const) {
      expect(Math.abs(rig.bones[role]!.getWorldPosition(new Vector3()).y - ht.ankles)).toBeLessThan(0.015);
    }
    // Hips orientation matches the measured pelvis basis.
    expect(out.solve.perRole.hips!.errorDeg!).toBeLessThan(2);
  });
});

describe('degradation', () => {
  it('a lost wrist holds, then relaxes with no discontinuity > 10°/frame at 30 fps', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y', shoulders: true });
    const pipe = makePipeline(rig);
    const pose = standingPose({ rightUpperArm: armDown('right', -30), rightLowerArm: elbowFlex('right', 80), rightHand: rotZ(20) });
    const frame = framePose(pose);
    let t = 0;
    for (let i = 0; i < 60; i++) {
      pipe.step(filteredFromFrame(frame, { t }), DT);
      t += DT;
    }
    const lost = { [LM.RIGHT_WRIST]: 0, [LM.RIGHT_INDEX]: 0, [LM.RIGHT_PINKY]: 0, [LM.RIGHT_THUMB]: 0 };
    const roles = ['rightUpperArm', 'rightLowerArm', 'rightHand'] as const;
    const prev = new Map<HumanoidBone, Quaternion>();
    for (const r of roles) prev.set(r, pipe.last!.solve.perRole[r]!.worldQuat.clone());
    const localAtStart = rig.bones.rightLowerArm!.quaternion.clone();
    let maxStep = 0;
    const sources: string[] = [];
    for (let i = 0; i < 90; i++) {
      t += DT;
      const { solve, result } = pipe.step(filteredFromFrame(frame, { t, visibility: lost }), DT);
      sources.push(result.bases.rightLowerArm!.source);
      for (const r of roles) {
        const q = solve.perRole[r]!.worldQuat;
        const step = degrees(quatAngle(q, prev.get(r)!));
        expect(step, `${r} frame ${i}`).toBeLessThan(10);
        maxStep = Math.max(maxStep, step);
        prev.get(r)!.copy(q);
      }
      assertFinite(rig);
    }
    // Held for poseHoldMs (700 ms = 21 frames) before fading.
    expect(sources.slice(0, 20).every((s) => s === 'hold')).toBe(true);
    expect(maxStep).toBeGreaterThan(0.01);
    // After 3 s the lower arm has moved well away from its driven pose toward bind.
    const moved = degrees(quatAngle(rig.bones.rightLowerArm!.quaternion, localAtStart));
    expect(moved).toBeGreaterThan(20);
    expect(pipe.last!.solve.perRole.rightLowerArm!.confidence).toBe(0);
  });

  it('seated jitter: hips jittered ±3 cm with low hip confidence move the head yaw < 2°', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y', shoulders: true, upperChest: true });
    const seated = standingPose(
      { leftUpperLeg: hipFlex(90), rightUpperLeg: hipFlex(90), leftLowerLeg: kneeFlex(90), rightLowerLeg: kneeFlex(90), leftUpperArm: armDown('left', 70), rightUpperArm: armDown('right', 70) },
      { rootPosition: new Vector3(0, 0.5, 0) },
    );
    const base = computeLandmarkPositions(seated);
    for (const hipVis of [0.3, 0.55]) {
      const pipe = makePipeline(rig);
      const rnd = mulberry32(7);
      let t = 0;
      // Settle first without jitter.
      for (let i = 0; i < 30; i++) {
        pipe.step(filteredFromFrame(toPoseFrame(base, DEFAULT_CAMERA, t * 1000), { t, visibility: { [LM.LEFT_HIP]: hipVis, [LM.RIGHT_HIP]: hipVis } }), DT);
        t += DT;
      }
      let maxYaw = 0;
      for (let i = 0; i < 90; i++) {
        t += DT;
        const pts = base.map((p) => p.clone());
        for (const idx of [LM.LEFT_HIP, LM.RIGHT_HIP]) {
          pts[idx].x += (rnd() * 2 - 1) * 0.03;
          pts[idx].z += (rnd() * 2 - 1) * 0.03;
        }
        const fp = filteredFromFrame(toPoseFrame(pts, DEFAULT_CAMERA, t * 1000), { t, visibility: { [LM.LEFT_HIP]: hipVis, [LM.RIGHT_HIP]: hipVis } });
        pipe.step(fp, DT);
        rig.root.updateMatrixWorld(true);
        maxYaw = Math.max(maxYaw, Math.abs(forwardYawDeg(rig, 'head')));
      }
      expect(maxYaw, `hip visibility ${hipVis}`).toBeLessThan(2);
    }
  });

  it('two-bone fallback: the elbow lands within 3 cm of the truth after 60 warm-up frames', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y' });
    const pipe = makePipeline(rig);
    const pose = standingPose({ leftUpperArm: armDown('left', 75), leftLowerArm: elbowFlex('left', 55) });
    const pts = computeLandmarkPositions(pose);
    const hipMid = pts[LM.LEFT_HIP].clone().add(pts[LM.RIGHT_HIP]).multiplyScalar(0.5);
    const trueElbow = pts[LM.LEFT_ELBOW].clone().sub(hipMid);
    const trueUpper = pts[LM.LEFT_ELBOW].clone().sub(pts[LM.LEFT_SHOULDER]).normalize();
    const frame = framePose(pose);
    let t = 0;
    for (let i = 0; i <= MIN_SEGMENT_SAMPLES; i++) {
      pipe.step(filteredFromFrame(frame, { t }), DT);
      t += DT;
    }
    for (let i = 0; i < 30; i++) {
      t += DT;
      const { result, solve } = pipe.step(filteredFromFrame(frame, { t, visibility: { [LM.LEFT_ELBOW]: 0 } }), DT);
      expect(result.bases.leftUpperArm!.source).toBe('twoBone');
      expect(result.joints[LM.LEFT_ELBOW].distanceTo(trueElbow)).toBeLessThan(0.03);
      expect(solve.perRole.leftUpperArm!.errorDeg!).toBeLessThan(2);
      expect(solve.perRole.leftUpperArm!.confidence).toBeGreaterThan(0.9);
    }
    rig.root.updateMatrixWorld(true);
    expect(angleDeg(worldDirection(rig.bones.leftUpperArm!, rig.bones.leftLowerArm!), trueUpper)).toBeLessThan(8);
  });
});

describe('standing baseline for neck and head', () => {
  it('a level head lands at bind after the baseline; a 20° nod pitches the head by 20°', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y', shoulders: true });
    const pipe = makePipeline(rig);
    const sb = new StandingBaseline(SMOOTHING);
    const frame = framePose(standingPose({}));
    // Without a baseline the raw head basis is pitched back (synthetic eyes sit 3 cm above the ears).
    const raw = pipe.converge(filteredFromFrame(frame));
    const rawDelta = worldDelta(rig, 'head');
    expect(degrees(2 * Math.acos(Math.min(1, Math.abs(rawDelta.w))))).toBeGreaterThan(15);
    expect(raw.solve.perRole.head!.errorDeg!).toBeLessThan(1);
    // Feed 2 s of confident full-body tracking.
    let t = 0;
    for (let i = 0; i < 70 && !sb.isReady; i++) {
      const fp = filteredFromFrame(frame, { t });
      const out = pipe.step(fp, DT);
      sb.update(out.result, fp, out.fit.state, DT, out.solve.depthZ);
      t += DT;
    }
    expect(sb.isReady).toBe(true);
    expect(sb.standingBases.head).toBeDefined();
    expect(sb.standingBases.neck).toBeDefined();
    pipe.retargeter.setTorsoBaseline(sb.torsoBaseline);
    pipe.retargeter.setStandingBases(sb.standingBases);
    pipe.converge(filteredFromFrame(frame));
    for (const role of ['head', 'neck', 'hips', 'spine', 'chest'] as const) {
      const d = worldDelta(rig, role);
      expect(degrees(2 * Math.acos(Math.min(1, Math.abs(d.w)))), role).toBeLessThan(1);
    }
    // Nod 20° down: the head world delta is a 20° pitch about the lateral axis.
    pipe.converge(filteredFromFrame(framePose(standingPose({ head: headNod(20) }))));
    const nod = worldDelta(rig, 'head');
    const angle = degrees(2 * Math.acos(Math.min(1, Math.abs(nod.w))));
    expect(Math.abs(angle - 20)).toBeLessThan(2);
    const axis = new Vector3(nod.x, nod.y, nod.z).normalize().multiplyScalar(Math.sign(nod.w) || 1);
    expect(axis.x).toBeGreaterThan(0.95);
    // Turn the head 30°: yaw follows, the pitch correction does not bake in yaw.
    pipe.converge(filteredFromFrame(framePose(standingPose({ head: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 30 * DEG2RAD) }))));
    rig.root.updateMatrixWorld(true);
    expect(Math.abs(forwardYawDeg(rig, 'head') - 30)).toBeLessThan(2);
  });
});

describe('takes and BVH round trip', () => {
  it('sampleTake/makeTakeHeader produce a Take whose BVH export reproduces every joint direction within 1°', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y', shoulders: true, upperChest: true });
    const pipe = makePipeline(rig);
    const header = makeTakeHeader(pipe.retargeter, 30);
    expect(header.roles.length).toBe(22);
    expect(header.parentIndex.filter((p) => p < 0).length).toBe(1);
    const samples = [];
    const dirsPerSample: Map<HumanoidBone, { dir: Vector3; tail: Vector3; pos: Vector3 }>[] = [];
    const frames = [framePose(SYNTHETIC_PRESETS.wave.poseAt(0.2)), framePose(SYNTHETIC_PRESETS.squat.poseAt(1.5)), framePose(SYNTHETIC_PRESETS.walk.poseAt(0.3))];
    for (let k = 0; k < frames.length; k++) {
      pipe.converge(filteredFromFrame(frames[k]));
      samples.push(pipe.retargeter.sampleTake(k / 30));
      rig.root.updateMatrixWorld(true);
      const m = new Map<HumanoidBone, { dir: Vector3; tail: Vector3; pos: Vector3 }>();
      for (const role of header.roles) {
        const tail = tailNode(rig, role)!;
        const pos = rig.bones[role]!.getWorldPosition(new Vector3());
        m.set(role, { dir: worldDirection(rig.bones[role]!, tail), tail: tail.getWorldPosition(new Vector3()), pos });
      }
      dirsPerSample.push(m);
    }
    const take: Take = { ...header, samples, t0: 0 };
    const bvh = takeToBvh(take);
    const parsed = parseBvh(bvh);
    expect(parsed.frames.length).toBe(3);
    expect(parsed.joints.length).toBe(22);
    for (let k = 0; k < samples.length; k++) {
      const states = evaluateBvhFrame(parsed, k);
      const expected = dirsPerSample[k];
      const hips = states.get('hips')!;
      expect(hips.pos.distanceTo(expected.get('hips')!.pos)).toBeLessThan(1e-3);
      for (let j = 0; j < header.roles.length; j++) {
        const role = header.roles[j];
        const st = states.get(role)!;
        const childIdx = header.parentIndex.indexOf(j);
        let dir: Vector3;
        if (childIdx >= 0) dir = states.get(header.roles[childIdx])!.pos.clone().sub(st.pos);
        else dir = st.end!.clone().sub(st.pos);
        expect(angleDeg(dir, expected.get(role)!.dir), `${role} frame ${k}`).toBeLessThan(1);
        expect(st.pos.distanceTo(expected.get(role)!.pos), `${role} frame ${k}`).toBeLessThan(2e-3);
      }
    }
  });
});

describe('framing on presets', () => {
  it('tpose is full (span >= 0.85); closeup is a waist framing; approach goes full -> waist -> bust without flicker', () => {
    const states: string[] = [];
    let prev = null;
    for (const f of presetFrames('tpose', [0, 0.5])) {
      prev = fitFraming(filteredFromFrame(f), prev, DT);
      expect(prev.state).toBe('full');
      expect(prev.span).toBeGreaterThanOrEqual(FRAMING_BOUNDS.full);
    }
    prev = null;
    const closeup = SYNTHETIC_PRESETS.closeup;
    for (let i = 0; i < 60; i++) {
      const t = i * DT;
      prev = fitFraming(filteredFromFrame(toPoseFrame(computeLandmarkPositions(closeup.poseAt(t)), closeup.camera, t * 1000)), prev, DT);
      states.push(prev.state);
    }
    // The closeup camera (1.45 m high, 1.1 m away, 60° FOV) cuts the body at about 0.48 H: a waist framing by §6.4.
    expect(new Set(states).size).toBe(1);
    expect(states[0]).toBe('waist');
    expect(prev!.visibleBottom).toBeGreaterThan(FRAMING_BOUNDS.waist);
    expect(prev!.span).toBeLessThan(FRAMING_BOUNDS.full);
    prev = null;
    const approach = SYNTHETIC_PRESETS.approach;
    const seq: string[] = [];
    for (let i = 0; i <= 12 * 30; i++) {
      const t = i * DT;
      const pose = approach.poseAt(Math.min(t, approach.durationSec));
      let cam = approach.camera;
      if (t > approach.durationSec) {
        const k = Math.min(1, (t - approach.durationSec) / 3);
        cam = { position: new Vector3(0, 1.2, 2.6 + 1.0 + (0.45 - 1.0) * k), target: new Vector3(0, 1.2, 0), vFovDeg: 60, aspect: 16 / 9 };
      }
      prev = fitFraming(filteredFromFrame(toPoseFrame(computeLandmarkPositions(pose), cam, t * 1000)), prev, DT);
      if (seq[seq.length - 1] !== prev.state) seq.push(prev.state);
    }
    expect(seq).toEqual(['full', 'waist', 'bust']);
  });
});

describe('BodyModel against the synthetic presets', () => {
  it('every measured role direction is within 1° of the ground truth from the same landmarks', () => {
    for (const preset of [...PRESETS, 'turn']) {
      for (const frame of presetFrames(preset)) {
        const pipe = makePipeline(buildRig({ pose: 'tpose', axis: 'y' }));
        const fp = filteredFromFrame(frame);
        const { result } = pipe.step(fp, DT);
        const truth = groundTruthDirections(fp.world);
        let n = 0;
        for (const [roleStr, d] of Object.entries(truth)) {
          const role = roleStr as HumanoidBone;
          const basis = role === 'hips' ? result.torso.hips : result.bases[role]!;
          if (!(basis.c > 0.5)) continue;
          expect(basis.source, `${preset} ${role}`).toBe('measured');
          expect(angleDeg(basis.d, d!), `${preset} t=${frame.t} ${role}`).toBeLessThan(1);
          n++;
        }
        expect(n).toBeGreaterThanOrEqual(17);
      }
    }
  });
});

describe('performance', () => {
  it('1000 frames (body model + framing + solve) of a 22-role rig run under 400 ms', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y', shoulders: true, upperChest: true });
    const pipe = makePipeline(rig, { hipsMode: 'full' });
    expect(pipe.retargeter.roles.length).toBe(22);
    const frames = presetFrames('walk', [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]).map((f) => filteredFromFrame(f));
    // Warm up (JIT) outside the timed window.
    for (let i = 0; i < 200; i++) pipe.step(frames[i % frames.length], DT);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) pipe.step(frames[i % frames.length], DT);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(400);
  });
});
