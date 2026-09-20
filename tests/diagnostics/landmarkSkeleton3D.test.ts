import { describe, expect, it } from 'vitest';
import { type BufferAttribute, Color, Matrix4, Vector3 } from 'three';
import { LandmarkSkeleton3D, containRect, overlayFlipsX } from '../../src/diagnostics';
import { LM, POSE_CONNECTIONS, POSE_LANDMARK_COUNT } from '../../src/tracking/landmarks';
import { standingFiltered } from './fixtures';

describe('LandmarkSkeleton3D', () => {
  it('builds in Node and hides itself without a pose', () => {
    const sk = new LandmarkSkeleton3D();
    expect(sk.object.children).toHaveLength(2);
    expect(sk.joints.count).toBe(POSE_LANDMARK_COUNT);
    expect(sk.joints.instanceColor).not.toBeNull();
    expect(sk.lines.geometry.getAttribute('position').count).toBe(POSE_CONNECTIONS.length * 2);
    expect(sk.object.visible).toBe(false); // no pose yet
    sk.visible = true;
    expect(sk.object.visible).toBe(false);
    sk.update(null, new Vector3());
    expect(sk.object.visible).toBe(false);
    sk.dispose();
  });

  it('writes instance matrices, line positions and confidence colors from a pose', () => {
    const sk = new LandmarkSkeleton3D({ scale: 2, jointRadius: 0.01 });
    const pose = standingFiltered(false);
    pose.confidence[LM.LEFT_WRIST] = 0.1; // low confidence -> red
    pose.gated[LM.RIGHT_ANKLE] = false; // ungated -> smaller marker
    const hips = new Vector3(0.3, 1.0, -0.5);
    sk.update(pose, hips);
    expect(sk.object.visible).toBe(true);
    // needsUpdate is a write-only setter in three; it bumps `version`.
    expect(sk.joints.instanceMatrix.version).toBeGreaterThan(0);
    expect(sk.joints.instanceColor!.version).toBeGreaterThan(0);

    const m = new Matrix4();
    const p = new Vector3();
    sk.joints.getMatrixAt(LM.NOSE, m);
    p.setFromMatrixPosition(m);
    const w = pose.world[LM.NOSE];
    expect(p.x).toBeCloseTo(hips.x + w.x * 2, 6);
    expect(p.y).toBeCloseTo(hips.y + w.y * 2, 6);
    expect(p.z).toBeCloseTo(hips.z + w.z * 2, 6);
    expect(m.elements[0]).toBeCloseTo(0.02, 6); // radius * scale
    sk.joints.getMatrixAt(LM.RIGHT_ANKLE, m);
    expect(m.elements[0]).toBeCloseTo(0.02 * 0.45, 6); // ungated marker shrinks

    const c = new Color();
    sk.joints.getColorAt(LM.LEFT_WRIST, c);
    expect(c.r).toBeGreaterThan(0.9);
    expect(c.g).toBeLessThan(0.4);
    sk.joints.getColorAt(LM.NOSE, c);
    expect(c.g).toBeGreaterThan(0.8);
    expect(c.r).toBeLessThan(0.3);

    const pos = sk.lines.geometry.getAttribute('position') as BufferAttribute;
    const col = sk.lines.geometry.getAttribute('color') as BufferAttribute;
    expect(pos.version).toBeGreaterThan(0);
    expect(col.version).toBeGreaterThan(0);
    const k = POSE_CONNECTIONS.findIndex(([a, b]) => a === LM.LEFT_SHOULDER && b === LM.LEFT_ELBOW);
    expect(k).toBeGreaterThanOrEqual(0);
    const a = pose.world[LM.LEFT_SHOULDER];
    expect(pos.getX(k * 2)).toBeCloseTo(hips.x + a.x * 2, 6);
    expect(pos.getY(k * 2)).toBeCloseTo(hips.y + a.y * 2, 6);
    // Segment color = min confidence of its endpoints (elbow->wrist takes the wrist's low confidence).
    const kw = POSE_CONNECTIONS.findIndex(([x, y]) => x === LM.LEFT_ELBOW && y === LM.LEFT_WRIST);
    expect(col.getX(kw * 2)).toBeGreaterThan(0.9);
    expect(col.getY(kw * 2)).toBeLessThan(0.4);
    for (let i = 0; i < pos.count * 3; i++) expect(Number.isFinite((pos.array as Float32Array)[i])).toBe(true);

    // Non-finite landmark: the joint collapses and the segment draws nothing, without throwing.
    pose.world[LM.LEFT_HEEL].set(NaN, 0, 0);
    expect(() => sk.update(pose, hips)).not.toThrow();
    sk.joints.getMatrixAt(LM.LEFT_HEEL, m);
    expect(m.elements[0]).toBe(0);
    for (let i = 0; i < pos.count * 3; i++) expect(Number.isFinite((pos.array as Float32Array)[i])).toBe(true);

    // An absent pose hides the skeleton; the visible flag is remembered.
    sk.update({ ...pose, present: false }, hips);
    expect(sk.object.visible).toBe(false);
    expect(sk.visible).toBe(true);
    sk.visible = false;
    sk.update(pose, hips);
    expect(sk.object.visible).toBe(false);
    sk.dispose();
  });
});

describe('overlay geometry helpers', () => {
  it('computes object-fit: contain letterboxing', () => {
    const wide = containRect(1000, 500, 16, 9);
    expect(wide.x).toBeCloseTo((1000 - 500 * (16 / 9)) / 2, 9);
    expect(wide.y).toBe(0);
    expect(wide.width).toBeCloseTo(500 * (16 / 9), 9);
    expect(wide.height).toBe(500);
    expect(containRect(400, 400, 16, 9)).toEqual({ x: 0, y: (400 - 225) / 2, width: 400, height: 225 });
    expect(containRect(400, 300, 0, 0)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(containRect(0, 0, 16, 9)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('flips x only when exactly one of preview/pose is mirrored', () => {
    expect(overlayFlipsX(true, true)).toBe(false);
    expect(overlayFlipsX(false, false)).toBe(false);
    expect(overlayFlipsX(true, false)).toBe(true);
    expect(overlayFlipsX(false, true)).toBe(true);
  });
});
