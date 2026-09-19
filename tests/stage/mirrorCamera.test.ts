import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { FramingFit, FramingState, HeightTable } from '../../src/core/types';
import {
  DEFAULT_MAX_DISTANCE,
  DEFAULT_MIN_DISTANCE,
  FULL_BODY_TOP,
  MirrorCameraController,
  computeMirrorFraming,
  modelHeightAt,
  sanitizeHeightTable,
  type MirrorCameraInput,
  type OrbitLike,
} from '../../src/stage/MirrorCamera';

/** A 1.7 m model with plausible joint heights. */
const TABLE: HeightTable = { floor: 0, ankles: 0.07, knees: 0.48, hips: 0.9, shoulders: 1.4, eyes: 1.6, headTop: 1.7 };
const FOV = 35;

function fit(bottom: number, top: number, state: FramingState = 'full', valid = true): FramingFit {
  return { a: -1 / (top - bottom), b: top / (top - bottom), valid, visibleTop: top, visibleBottom: bottom, span: top - bottom, state };
}

const FULL = fit(0, FULL_BODY_TOP, 'full');
const BUST = fit(0.75, FULL_BODY_TOP, 'bust');

describe('computeMirrorFraming', () => {
  it('frames a full body at about 3.1 m with the target near the body midpoint', () => {
    const f = computeMirrorFraming(FULL, TABLE, { vfovDeg: FOV });
    expect(f.distance).toBeGreaterThanOrEqual(3.0);
    expect(f.distance).toBeLessThanOrEqual(3.3);
    expect(f.targetY).toBeGreaterThanOrEqual(0.85);
    expect(f.targetY).toBeLessThanOrEqual(0.9);
    expect(f.spanBottom).toBeCloseTo(0, 9);
    expect(f.spanTop).toBeCloseTo(1.7 + 0.05 * 1.7, 9);
  });

  it('frames a bust at under a metre with the target between the shoulders and the eyes', () => {
    const f = computeMirrorFraming(BUST, TABLE, { vfovDeg: FOV });
    expect(f.distance).toBeGreaterThanOrEqual(0.7);
    expect(f.distance).toBeLessThanOrEqual(1.0);
    expect(f.targetY).toBeGreaterThanOrEqual(TABLE.shoulders - 0.05);
    expect(f.targetY).toBeLessThanOrEqual(TABLE.eyes + 0.1);
    // 0.75 H lies between the hips (0.53 H) and the shoulders (0.82 H).
    expect(f.spanBottom).toBeGreaterThan(TABLE.hips);
    expect(f.spanBottom).toBeLessThan(TABLE.shoulders);
  });

  it('is monotonic: smaller spans give smaller distances', () => {
    const tops = [1.05, 0.95, 0.85, 0.7, 0.55, 0.4, 0.3];
    let prev = Infinity;
    for (const top of tops) {
      const d = computeMirrorFraming(fit(0.2, top), TABLE, { vfovDeg: FOV, minDistance: 0.05 }).distance;
      expect(d).toBeLessThan(prev);
      prev = d;
    }
  });

  it('matches the design formula distance = modelSpan * 1.08 / (2 tan(vfov/2))', () => {
    const f = computeMirrorFraming(fit(0.28, 0.82), TABLE, { vfovDeg: FOV });
    const span = TABLE.shoulders - TABLE.knees;
    const expected = (span * 1.08) / (2 * Math.tan((FOV / 2) * (Math.PI / 180)));
    expect(f.distance).toBeCloseTo(expected, 9);
    expect(f.targetY).toBeCloseTo((TABLE.shoulders + TABLE.knees) / 2, 9);
  });

  it('clamps the distance to [minDistance, maxDistance]', () => {
    const tiny = computeMirrorFraming(fit(0.9, 0.91), TABLE, { vfovDeg: FOV });
    expect(tiny.distance).toBe(DEFAULT_MIN_DISTANCE);
    const huge = computeMirrorFraming(fit(-2, 4), TABLE, { vfovDeg: FOV });
    expect(huge.distance).toBe(DEFAULT_MAX_DISTANCE);
    const custom = computeMirrorFraming(FULL, TABLE, { vfovDeg: FOV, minDistance: 4, maxDistance: 5 });
    expect(custom.distance).toBe(4);
    const narrow = computeMirrorFraming(FULL, TABLE, { vfovDeg: 5, maxDistance: 8 });
    expect(narrow.distance).toBe(8);
    const zero = computeMirrorFraming(fit(0.5, 0.5), TABLE, { vfovDeg: FOV });
    expect(Number.isFinite(zero.distance)).toBe(true);
    expect(zero.distance).toBe(DEFAULT_MIN_DISTANCE);
  });

  it('handles a sanitized table whose knee equals the hips', () => {
    const flat: HeightTable = { ...TABLE, knees: TABLE.hips };
    for (const h of [0.2, 0.28, 0.4, 0.53, 0.6]) {
      const y = modelHeightAt(h, sanitizeHeightTable(flat));
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(flat.ankles);
      expect(y).toBeLessThanOrEqual(flat.shoulders);
    }
    expect(modelHeightAt(0.4, sanitizeHeightTable(flat))).toBeCloseTo(TABLE.hips, 9);
    const f = computeMirrorFraming(fit(0.3, 0.5), flat, { vfovDeg: FOV });
    expect(f.spanTop - f.spanBottom).toBeCloseTo(0, 9);
    expect(f.distance).toBe(DEFAULT_MIN_DISTANCE);
    expect(f.targetY).toBeCloseTo(TABLE.hips, 9);
  });

  it('sanitizes a non-monotonic table (knee above the hips) instead of producing negative spans', () => {
    const bad: HeightTable = { ...TABLE, knees: 1.2 };
    const s = sanitizeHeightTable(bad);
    expect(s.knees).toBe(1.2);
    expect(s.hips).toBe(1.2);
    expect(s.shoulders).toBe(TABLE.shoulders);
    const f = computeMirrorFraming(fit(0.1, 0.9), bad, { vfovDeg: FOV });
    expect(f.spanTop).toBeGreaterThan(f.spanBottom);
    expect(Number.isFinite(f.distance)).toBe(true);
  });

  it('falls back to canonical proportions for a degenerate table', () => {
    const s = sanitizeHeightTable({ floor: 0, ankles: 0, knees: 0, hips: 0, shoulders: 0, eyes: 0, headTop: 0 });
    expect(s.headTop).toBeCloseTo(1.7, 9);
    expect(s.hips).toBeCloseTo(0.53 * 1.7, 9);
  });

  it('interpolates piecewise-linearly between the knots and extrapolates outside [0, 1]', () => {
    expect(modelHeightAt(0, TABLE)).toBeCloseTo(TABLE.floor, 9);
    expect(modelHeightAt(0.04, TABLE)).toBeCloseTo(TABLE.ankles, 9);
    expect(modelHeightAt(0.53, TABLE)).toBeCloseTo(TABLE.hips, 9);
    expect(modelHeightAt(0.94, TABLE)).toBeCloseTo(TABLE.eyes, 9);
    expect(modelHeightAt(1, TABLE)).toBeCloseTo(TABLE.headTop, 9);
    expect(modelHeightAt((0.53 + 0.82) / 2, TABLE)).toBeCloseTo((TABLE.hips + TABLE.shoulders) / 2, 9);
    expect(modelHeightAt(1.05, TABLE)).toBeCloseTo(TABLE.headTop + 0.05 * 1.7, 9);
    expect(modelHeightAt(-0.1, TABLE)).toBeCloseTo(-0.17, 9);
  });
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const DT = 1 / 60;

class FakeControls implements OrbitLike {
  enabled = false;
  target = new Vector3();
  updates = 0;
  update(): boolean {
    this.updates++;
    return true;
  }
}

function makeInput(f: FramingFit | null, overrides: Partial<MirrorCameraInput> = {}): MirrorCameraInput {
  return {
    fit: f,
    table: TABLE,
    hipsWorld: new Vector3(0, TABLE.hips, 0),
    lateralOffset: 0,
    present: f !== null,
    absentFor: 0,
    ...overrides,
  };
}

function makeController(controls?: OrbitLike) {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  const ctl = new MirrorCameraController(camera, { controls: controls ?? null, mode: 'mirror' });
  return { camera, ctl };
}

function run(ctl: MirrorCameraController, input: MirrorCameraInput, seconds: number, onStep?: (d: number, t: number) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    ctl.update(DT, input);
    onStep?.(ctl.distance, (i + 1) * DT);
  }
}

function lookDir(camera: PerspectiveCamera): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
}

describe('MirrorCameraController', () => {
  it('snaps to the framing on the first update and converges to a new span without overshoot', () => {
    const { ctl, camera } = makeController();
    const full = computeMirrorFraming(FULL, TABLE, { vfovDeg: FOV });
    const bust = computeMirrorFraming(BUST, TABLE, { vfovDeg: FOV });
    ctl.update(DT, makeInput(FULL));
    expect(ctl.distance).toBeCloseTo(full.distance, 9);
    expect(ctl.targetY).toBeCloseTo(full.targetY, 9);
    expect(camera.position.z).toBeCloseTo(full.distance, 9);

    let prev = ctl.distance;
    let minD = Infinity;
    run(ctl, makeInput(BUST), 4, (d) => {
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
      minD = Math.min(minD, d);
    });
    expect(ctl.distance).toBeCloseTo(bust.distance, 2);
    expect(minD).toBeGreaterThanOrEqual(bust.distance - 1e-6);
    expect(ctl.targetY).toBeCloseTo(bust.targetY, 2);
  });

  it('ignores ±2 % span jitter through the dead-band and reacts to a real change', () => {
    const { ctl } = makeController();
    ctl.update(DT, makeInput(FULL));
    const d0 = ctl.distance;
    const y0 = ctl.targetY;
    for (let i = 0; i < 240; i++) {
      const jitter = (i % 2 === 0 ? 1 : -1) * 0.02 * FULL_BODY_TOP;
      ctl.update(DT, makeInput(fit(0, FULL_BODY_TOP + jitter)));
    }
    expect(ctl.distance).toBeCloseTo(d0, 12);
    expect(ctl.targetY).toBeCloseTo(y0, 12);
    expect(ctl.committedSpan).toEqual({ bottom: 0, top: FULL_BODY_TOP });

    run(ctl, makeInput(fit(0, FULL_BODY_TOP * 0.9)), 2);
    expect(ctl.distance).toBeLessThan(d0 * 0.95);
  });

  it('caps the distance change at 1.5 m/s', () => {
    const { ctl } = makeController();
    ctl.update(DT, makeInput(BUST));
    const start = ctl.distance;
    let maxRate = 0;
    let prev = start;
    run(ctl, makeInput(FULL), 0.5, (d) => {
      maxRate = Math.max(maxRate, Math.abs(d - prev) / DT);
      prev = d;
    });
    expect(maxRate).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(ctl.distance - start).toBeLessThanOrEqual(0.75 + 1e-9);
    // It is actually moving at the limit, not just slowly.
    expect(ctl.distance - start).toBeGreaterThan(0.6);
    run(ctl, makeInput(FULL), 4);
    expect(ctl.distance).toBeCloseTo(computeMirrorFraming(FULL, TABLE, { vfovDeg: FOV }).distance, 2);
  });

  it('holds the framing for 3 s of absence, then eases back to full body', () => {
    const { ctl } = makeController();
    ctl.update(DT, makeInput(BUST));
    const bust = ctl.distance;
    const full = computeMirrorFraming(FULL, TABLE, { vfovDeg: FOV }).distance;

    let absent = 0;
    const absentStep = () => {
      absent += DT;
      ctl.update(DT, makeInput(null, { present: false, absentFor: absent }));
    };
    while (absent < 2.9) absentStep();
    expect(ctl.distance).toBeCloseTo(bust, 9);

    // A pose returning within the timeout keeps the framing.
    ctl.update(DT, makeInput(BUST));
    expect(ctl.distance).toBeCloseTo(bust, 9);

    absent = 0;
    while (absent < 3.5) absentStep();
    expect(ctl.distance).toBeGreaterThan(bust);
    expect(ctl.distance).toBeLessThan(full);
    while (absent < 8) absentStep();
    expect(ctl.distance).toBeCloseTo(full, 2);
  });

  it('never tilts in mirror mode and keeps the camera at the target height', () => {
    const { ctl, camera } = makeController();
    for (const f of [FULL, BUST, fit(0.3, 0.9, 'waist')]) {
      run(ctl, makeInput(f, { lateralOffset: 0.3 }), 1);
      const dir = lookDir(camera);
      expect(Math.abs(dir.y)).toBeLessThan(1e-9);
      expect(dir.z).toBeLessThan(0);
      expect(camera.position.y).toBeCloseTo(ctl.targetY, 9);
    }
  });

  it('follows the lateral offset with the camera x and pans with the hips in follow mode', () => {
    const { ctl, camera } = makeController();
    run(ctl, makeInput(FULL, { lateralOffset: 0 }), 0.5);
    run(ctl, makeInput(FULL, { lateralOffset: 0.4 }), 4);
    expect(camera.position.x).toBeCloseTo(0.4, 2);

    ctl.setMode('follow');
    const hips = new Vector3(1.2, TABLE.hips, -0.6);
    run(ctl, makeInput(BUST, { hipsWorld: hips, lateralOffset: 0 }), 5);
    expect(camera.position.x).toBeCloseTo(hips.x, 2);
    expect(camera.position.z - hips.z).toBeCloseTo(computeMirrorFraming(FULL, TABLE, { vfovDeg: FOV }).distance, 2);
  });

  it('sets the mirror FOV, restores it in orbit mode and hands control to the orbit controls', () => {
    const controls = new FakeControls();
    const { ctl, camera } = makeController(controls);
    expect(camera.fov).toBe(35);
    expect(controls.enabled).toBe(false);
    ctl.update(DT, makeInput(FULL));

    ctl.setMode('orbit');
    expect(camera.fov).toBe(60);
    expect(controls.enabled).toBe(true);
    expect(controls.target.y).toBeCloseTo(ctl.targetY, 9);
    const before = camera.position.clone();
    ctl.update(DT, makeInput(BUST));
    expect(controls.updates).toBe(1);
    expect(camera.position.equals(before)).toBe(true);

    ctl.setMode('mirror');
    expect(camera.fov).toBe(35);
    expect(controls.enabled).toBe(false);

    ctl.setOptions({ vfovDeg: 40 });
    expect(camera.fov).toBe(40);
    ctl.setMode('orbit');
    expect(camera.fov).toBe(60);
  });

  it('places the camera relative to the model origin', () => {
    const { ctl, camera } = makeController();
    const origin = new Vector3(2, 0.5, -3);
    ctl.update(DT, makeInput(FULL, { origin, lateralOffset: 0.1 }));
    const full = computeMirrorFraming(FULL, TABLE, { vfovDeg: FOV });
    expect(camera.position.x).toBeCloseTo(2.1, 9);
    expect(camera.position.y).toBeCloseTo(0.5 + full.targetY, 9);
    expect(camera.position.z).toBeCloseTo(-3 + full.distance, 9);
  });
});
