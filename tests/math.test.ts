import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  HysteresisGate,
  OneEuroFilter,
  SpringScalar,
  angleBetween,
  expFactor,
  frameFromDirUp,
  limitTwist,
  quatAngle,
  quatFromDirUp,
  rotationBetweenBases,
  rotationBetweenDirections,
  swingTwist,
  fnv1a,
} from '../src/core/math';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

function col(m: Matrix4, i: number): Vector3 {
  const e = m.elements;
  return new Vector3(e[i * 4], e[i * 4 + 1], e[i * 4 + 2]);
}

describe('frameFromDirUp', () => {
  it('builds a right-handed orthonormal frame with column0 = d and column2 ⟂ d toward u', () => {
    const m = frameFromDirUp(new Vector3(2, 0, 0), new Vector3(0.3, 0, 1));
    const c0 = col(m, 0);
    const c1 = col(m, 1);
    const c2 = col(m, 2);
    expect(c0.distanceTo(X)).toBeLessThan(1e-9);
    expect(c2.distanceTo(Z)).toBeLessThan(1e-9);
    expect(c1.distanceTo(new Vector3().crossVectors(c2, c0))).toBeLessThan(1e-9);
    expect(new Vector3().crossVectors(c0, c1).distanceTo(c2)).toBeLessThan(1e-9);
    expect(Math.abs(m.determinant() - 1)).toBeLessThan(1e-9);
  });

  it('tolerates u parallel to d', () => {
    const m = frameFromDirUp(Y, Y.clone().multiplyScalar(3));
    expect(Math.abs(m.determinant() - 1)).toBeLessThan(1e-9);
    expect(col(m, 0).distanceTo(Y)).toBeLessThan(1e-9);
    expect(Math.abs(col(m, 2).dot(Y))).toBeLessThan(1e-9);
  });
});

describe('rotationBetweenBases', () => {
  it('maps the reference direction and up onto the measured ones', () => {
    const dRef = new Vector3(1, 0, 0);
    const uRef = new Vector3(0, 0, 1);
    const dMeas = new Vector3(0, 1, 0);
    const uMeas = new Vector3(-1, 0, 0);
    const q = rotationBetweenBases(dRef, uRef, dMeas, uMeas);
    expect(dRef.clone().applyQuaternion(q).distanceTo(dMeas)).toBeLessThan(1e-9);
    expect(uRef.clone().applyQuaternion(q).distanceTo(uMeas)).toBeLessThan(1e-9);
  });

  it('is identity for identical bases and handles arbitrary rotations', () => {
    const d = new Vector3(0.3, -0.9, 0.2).normalize();
    const u = new Vector3(0.1, 0.2, 1).normalize();
    expect(quatAngle(rotationBetweenBases(d, u, d, u), new Quaternion())).toBeLessThan(1e-9);
    const r = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1.234);
    const q = rotationBetweenBases(d, u, d.clone().applyQuaternion(r), u.clone().applyQuaternion(r));
    expect(quatAngle(q, r)).toBeLessThan(1e-9);
  });
});

describe('rotationBetweenDirections', () => {
  it('rotates from onto to', () => {
    const q = rotationBetweenDirections(X, Y);
    expect(X.clone().applyQuaternion(q).distanceTo(Y)).toBeLessThan(1e-9);
    expect(angleBetween(X, Y)).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('swingTwist', () => {
  it('recovers the twist angle about the axis and swing ∘ twist == q', () => {
    const axis = new Vector3(0, 1, 0);
    const twistIn = new Quaternion().setFromAxisAngle(axis, 0.7);
    const swingIn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    const q = swingIn.clone().multiply(twistIn);
    const swing = new Quaternion();
    const twist = new Quaternion();
    const angle = swingTwist(q, axis, swing, twist);
    expect(angle).toBeCloseTo(0.7, 6);
    expect(quatAngle(swing.clone().multiply(twist), q)).toBeLessThan(1e-9);
    expect(quatAngle(swing, swingIn)).toBeLessThan(1e-9);
    const moved = axis.clone().applyQuaternion(q);
    expect(axis.clone().applyQuaternion(swing).distanceTo(moved)).toBeLessThan(1e-9);
  });

  it('limitTwist keeps swing and scales twist', () => {
    const axis = new Vector3(1, 0, 0);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.5).multiply(
      new Quaternion().setFromAxisAngle(axis, 1.0),
    );
    const half = limitTwist(q, axis, 0.5);
    const swing = new Quaternion();
    const twist = new Quaternion();
    expect(swingTwist(half, axis, swing, twist)).toBeCloseTo(0.5, 6);
    const none = limitTwist(q, axis, 0);
    expect(Math.abs(swingTwist(none, axis, swing, twist))).toBeLessThan(1e-9);
    expect(axis.clone().applyQuaternion(none).distanceTo(axis.clone().applyQuaternion(q))).toBeLessThan(1e-9);
  });
});

describe('quatFromDirUp', () => {
  it('produces a quaternion whose +X maps to d', () => {
    const d = new Vector3(0, 0, -1);
    const q = quatFromDirUp(d, Y);
    expect(X.clone().applyQuaternion(q).distanceTo(d)).toBeLessThan(1e-9);
    expect(Z.clone().applyQuaternion(q).distanceTo(Y)).toBeLessThan(1e-9);
  });
});

describe('OneEuroFilter', () => {
  it('smooths noise while following a ramp', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.05, dCutoff: 1 });
    let t = 0;
    let out = 0;
    for (let i = 0; i < 300; i++) {
      t += 1 / 60;
      const truth = t * 0.5;
      const noisy = truth + (i % 2 === 0 ? 0.02 : -0.02);
      out = f.filter(noisy, t);
    }
    // A 1 Hz first-order low-pass lags a ramp of slope 0.5 by about 0.5/(2*pi) = 0.08.
    expect(Math.abs(out - t * 0.5)).toBeLessThan(0.12);
    // Noise of amplitude 0.02 alternating each frame must be strongly attenuated.
    const a = f.filter(t * 0.5 + 0.02, t + 1 / 60);
    const b = f.filter((t + 1 / 60) * 0.5 - 0.02, t + 2 / 60);
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });

  it('is stable when time does not advance', () => {
    const f = new OneEuroFilter();
    expect(f.filter(1, 0)).toBe(1);
    expect(Number.isFinite(f.filter(2, 0))).toBe(true);
  });
});

describe('SpringScalar', () => {
  it('converges to the target without overshoot', () => {
    const s = new SpringScalar(0, 2);
    let max = -Infinity;
    for (let i = 0; i < 240; i++) {
      s.update(1, 1 / 60);
      max = Math.max(max, s.value);
    }
    expect(Math.abs(s.value - 1)).toBeLessThan(1e-3);
    expect(max).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe('HysteresisGate', () => {
  it('opens above on-threshold, holds, then closes below off-threshold', () => {
    const g = new HysteresisGate(0.65, 0.45, 100);
    expect(g.update(0.5, 0)).toBe(false);
    expect(g.update(0.7, 10)).toBe(true);
    expect(g.update(0.3, 50)).toBe(true);
    expect(g.update(0.3, 200)).toBe(false);
    expect(g.update(0.5, 210)).toBe(false);
  });
});

describe('misc', () => {
  it('expFactor is in [0,1) and increases with dt', () => {
    expect(expFactor(10, 0)).toBe(0);
    expect(expFactor(10, 0.1)).toBeGreaterThan(expFactor(10, 0.01));
    expect(expFactor(10, 10)).toBeLessThanOrEqual(1);
  });
  it('fnv1a is deterministic', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).not.toBe(fnv1a('hellp'));
  });
});
