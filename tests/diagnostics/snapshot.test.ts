import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { HumanoidBone, RigProfile } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { BodyModel } from '../../src/retarget/bodyModel';
import { emptyFramingFit } from '../../src/retarget/framing';
import { SMOOTHING, buildRig, makePipeline } from '../retarget/helpers';
import {
  APP_VERSION,
  DIAGNOSTICS_FORMAT,
  DIAGNOSTICS_VERSION,
  MEDIAPIPE_VERSION,
  THREE_REVISION,
  buildDiagnosticsJson,
  libraryVersions,
  snapshotBundleName,
  summarize,
  toJsonValue,
} from '../../src/diagnostics';
import { makeAnalysis, makeSolve, standingFiltered } from './fixtures';

const ROLES: HumanoidBone[] = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm', 'leftUpperLeg', 'leftLowerLeg'];

function walk(value: unknown, visit: (v: unknown, path: string) => void, path = '$'): void {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, visit, `${path}.${k}`);
}

describe('toJsonValue', () => {
  it('serializes three.js math objects as arrays and non-finite numbers as null', () => {
    const out = toJsonValue({
      v: new Vector3(1, NaN, 3),
      q: new Quaternion(0, 0, 0, 1),
      n: Infinity,
      m: -Infinity,
      f: () => 1,
      u: undefined,
      t: new Float32Array([1, 2]),
      nested: [new Vector3(0, 1, 0)],
    });
    expect(out).toEqual({ v: [1, null, 3], q: [0, 0, 0, 1], n: null, m: null, u: null, t: [1, 2], nested: [[0, 1, 0]] });
  });

  it('sorts keys when asked', () => {
    expect(Object.keys(toJsonValue({ b: 1, a: { d: 1, c: 2 } }, true) as object)).toEqual(['a', 'b']);
    expect(Object.keys((toJsonValue({ b: 1, a: { d: 1, c: 2 } }, true) as { a: object }).a)).toEqual(['c', 'd']);
  });
});

describe('buildDiagnosticsJson', () => {
  const now = new Date('2026-09-20T12:34:56Z');

  function build(overrides: Partial<Parameters<typeof buildDiagnosticsJson>[0]> = {}): string {
    const solve = makeSolve({
      hips: { errorDeg: 1, mode: 'relative' },
      spine: { errorDeg: 2, mode: 'relative' },
      head: { errorDeg: 3, mode: 'relative' },
      leftUpperArm: { errorDeg: 8, confidence: 0.9 },
      leftLowerArm: { errorDeg: NaN, confidence: 0.9 },
      rightUpperArm: { errorDeg: 2, mode: 'calibrated' },
      rightLowerArm: { errorDeg: null, source: 'hold', confidence: 0 },
      leftUpperLeg: { errorDeg: 1, mode: 'follow' },
      leftLowerLeg: { errorDeg: 0.5, source: 'chord' },
    });
    solve.perRole.leftUpperArm!.solvedDir!.x = Infinity;
    const pose = standingFiltered(true);
    const body = new BodyModel(SMOOTHING).update(pose, 1 / 30, { framing: 'full', noKnee: { left: false, right: false }, noElbow: { left: false, right: false }, mirror: true });
    const analysis = makeAnalysis(ROLES);
    const profile: RigProfile = {
      version: 3,
      familyKey: analysis.familyKey,
      instanceKey: analysis.instanceKey,
      displayName: 'Test rig',
      updatedAt: now.toISOString(),
      mapOverrides: { head: 'HeadOverride' },
      swapSides: false,
      bones: { leftUpperArm: { mode: 'auto', rollOffsetDeg: 15 } },
      sockets: {},
      calibration: null,
    };
    const fit = { ...emptyFramingFit('full'), a: -0.9, b: 0.98, valid: true, visibleTop: 1.05, visibleBottom: 0, span: 1.05 };
    return buildDiagnosticsJson({
      analysis,
      profile,
      pose,
      body,
      solve,
      framing: fit,
      settings: DEFAULT_SETTINGS,
      mirror: true,
      sourceKind: 'synthetic',
      extra: { framesProcessed: 12, note: 'unit test', bad: NaN },
      now,
      ...overrides,
    });
  }

  it('has a stable shape with no NaN/Infinity and vectors as arrays', () => {
    const json = build();
    expect(json).not.toMatch(/NaN|Infinity/);
    const doc = JSON.parse(json);
    expect(Object.keys(doc)).toEqual(['format', 'version', 'createdAt', 'versions', 'source', 'settings', 'analysis', 'profile', 'pose', 'body', 'solve', 'framing', 'extra']);
    expect(doc.format).toBe(DIAGNOSTICS_FORMAT);
    expect(doc.version).toBe(DIAGNOSTICS_VERSION);
    expect(doc.createdAt).toBe('2026-09-20T12:34:56.000Z');
    expect(doc.versions).toEqual({ app: APP_VERSION, mediapipe: '1.0.1', three: THREE_REVISION });
    expect(MEDIAPIPE_VERSION).toBe('1.0.1');
    expect(libraryVersions().three).toBe('186');
    expect(doc.source).toEqual({ kind: 'synthetic', mirror: true, videoSize: [1280, 720] });

    // Every number in the document is finite.
    walk(doc, (v, path) => {
      if (typeof v === 'number') expect(Number.isFinite(v), path).toBe(true);
    });

    // Solve section.
    // Roles in solve order; the per-role map in canonical HUMANOID_BONES order (same here).
    expect(doc.solve.roles).toEqual(ROLES);
    expect(Object.keys(doc.solve.perRole)).toEqual(ROLES);
    const lua = doc.solve.perRole.leftUpperArm;
    expect(lua.bone).toBe('mixamorig:leftUpperArm');
    expect(lua.mode).toBe('auto');
    expect(lua.measuredDir).toEqual([0, 1, 0]);
    expect(lua.solvedDir[0]).toBeNull(); // Infinity -> null
    expect(lua.errorDeg).toBe(8);
    expect(lua.worldQuat).toHaveLength(4);
    expect(lua.reference.d).toEqual([1, 0, 0]);
    // 15° roll trim from the profile rotates u_ref about d_ref.
    expect(lua.reference.u[0]).toBeCloseTo(0, 6);
    expect(Math.abs(lua.reference.u[1])).toBeCloseTo(Math.sin((15 * Math.PI) / 180), 6);
    expect(doc.solve.perRole.leftLowerArm.errorDeg).toBeNull(); // NaN -> null
    expect(doc.solve.perRole.rightLowerArm.measuredDir).toBeNull();
    expect(doc.solve.perRole.leftUpperLeg.reference).toBeNull(); // follow mode has no reference
    expect(doc.solve.perRole.rightUpperArm.reference).not.toBeNull(); // calibrated without calibration falls back to auto
    expect(doc.solve.chainErrorDeg).toEqual({ leftArm: 1.5, rightArm: null, leftLeg: 0.4, rightLeg: 7.2 });
    expect(doc.solve.hipsWorldPos).toEqual([0.05, 0.95, -0.02]);
    expect(doc.solve.summary.flagged).toEqual(['leftUpperArm']);
    expect(doc.solve.summary.worst).toBe('leftUpperArm');
    expect(doc.solve.summary.ok).toBe(false);

    // Measured bases carry d, u, c, cU and source for every role the body model produced.
    const baseRoles = Object.keys(doc.body.bases);
    expect(baseRoles.length).toBeGreaterThan(8);
    for (const r of baseRoles) {
      const b = doc.body.bases[r];
      expect(Object.keys(b)).toEqual(['d', 'u', 'c', 'cU', 'source']);
      expect(b.d).toHaveLength(3);
      expect(b.u).toHaveLength(3);
    }
    expect(doc.body.torso.hips.d).toHaveLength(3);

    // Pose: 33 landmarks with gating flags, hand presence, mirror flag.
    expect(doc.pose.present).toBe(true);
    expect(doc.pose.mirror).toBe(true);
    expect(doc.pose.landmarks).toHaveLength(33);
    expect(doc.pose.landmarks[0].name).toBe('nose');
    expect(doc.pose.landmarks[0].world).toHaveLength(3);
    expect(typeof doc.pose.landmarks[0].gated).toBe('boolean');
    expect(doc.pose.hands).toEqual({ left: null, right: null });
    expect(doc.pose.face).toBeNull();

    // Foreign objects are emitted with sorted keys; the profile is the user diff as stored.
    expect(Object.keys(doc.analysis)).toEqual([...Object.keys(doc.analysis)].sort());
    expect(Object.keys(doc.settings)).toEqual(['diagnostics', 'smoothing', 'stage', 'tracking']);
    expect(doc.profile.mapOverrides).toEqual({ head: 'HeadOverride' });
    expect(doc.analysis.heightTable.headTop).toBe(1.72);
    expect(doc.framing.state).toBe('full');
    expect(doc.extra).toEqual({ bad: null, framesProcessed: 12, note: 'unit test' });
  });

  it('is deterministic for the same input and tolerates missing sections', () => {
    expect(build()).toBe(build());
    const json = buildDiagnosticsJson({
      analysis: null,
      profile: null,
      pose: null,
      body: null,
      solve: null,
      framing: null,
      settings: DEFAULT_SETTINGS,
      mirror: false,
      sourceKind: 'camera',
      now,
    });
    const doc = JSON.parse(json);
    expect(doc.analysis).toBeNull();
    expect(doc.pose).toBeNull();
    expect(doc.body).toBeNull();
    expect(doc.solve).toBeNull();
    expect(doc.framing).toBeNull();
    expect(doc.extra).toBeNull();
    expect(doc.source.videoSize).toBeNull();
  });

  it('serializes a real solver frame on a synthetic rig', () => {
    const rig = buildRig({ pose: 'tpose', axis: 'y' });
    const pipe = makePipeline(rig);
    const pose = standingFiltered(false);
    const out = pipe.converge(pose, 20, 1 / 30);
    const summary = summarize(out.solve, rig.analysis);
    expect(summary.perBone.length).toBeGreaterThan(10);
    const json = buildDiagnosticsJson({
      analysis: rig.analysis,
      profile: null,
      pose,
      body: out.result,
      solve: out.solve,
      framing: out.fit,
      settings: DEFAULT_SETTINGS,
      mirror: false,
      sourceKind: 'synthetic',
      now,
    });
    expect(json).not.toMatch(/NaN|Infinity/);
    const doc = JSON.parse(json);
    expect(doc.solve.roles.length).toBe(out.solve.roles.length);
    for (const role of out.solve.roles) {
      const r = doc.solve.perRole[role];
      expect(r, role).toBeDefined();
      expect(r.bone).toBe(rig.analysis.map[role]);
      if (r.mode === 'auto' || r.mode === 'relative') expect(r.reference, role).not.toBeNull();
    }
    expect(doc.solve.summary.maxErrorDeg).not.toBeNull();
  });
});

describe('snapshotBundleName', () => {
  it('formats the local timestamp', () => {
    const d = new Date(2026, 8, 20, 7, 5, 9); // local time
    expect(snapshotBundleName(d)).toBe('cameracharacter-snapshot-20260920-070509');
    expect(snapshotBundleName()).toMatch(/^cameracharacter-snapshot-\d{8}-\d{6}$/);
  });
});
