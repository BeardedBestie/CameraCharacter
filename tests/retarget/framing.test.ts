import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { FramingFit, FramingState } from '../../src/core/types';
import { FRAMING_BOUNDS, fitFraming, fitHeightLine } from '../../src/retarget/framing';
import {
  SYNTHETIC_PRESETS,
  type SyntheticCamera,
  computeLandmarkPositions,
  framePose,
  standingPose,
  toPoseFrame,
} from '../../src/testing/syntheticHuman';
import { filteredFromFrame } from './helpers';

const DT = 1 / 30;

function cameraAt(z: number, y = 1.45): SyntheticCamera {
  return { position: new Vector3(0, y, z), target: new Vector3(0, y, 0), vFovDeg: 60, aspect: 16 / 9 };
}

function run(frames: ReturnType<typeof framePose>[], dt = DT): { fits: FramingFit[]; states: FramingState[] } {
  let prev: FramingFit | null = null;
  const fits: FramingFit[] = [];
  for (const f of frames) {
    prev = fitFraming(filteredFromFrame(f), prev, dt);
    fits.push(prev);
  }
  return { fits, states: fits.map((f) => f.state) };
}

function dedupe(states: FramingState[]): FramingState[] {
  const out: FramingState[] = [];
  for (const s of states) if (out[out.length - 1] !== s) out.push(s);
  return out;
}

describe('framing fit', () => {
  it('full-body T-pose frame -> full with span >= 0.85', () => {
    const { fits } = run([framePose(standingPose({}))]);
    const fit = fits[0];
    expect(fit.valid).toBe(true);
    expect(fit.state).toBe('full');
    expect(fit.span).toBeGreaterThanOrEqual(0.85);
    expect(fit.visibleBottom).toBe(0);
    expect(fit.visibleTop).toBeCloseTo(FRAMING_BOUNDS.maxTop, 6);
    // Slope: image y decreases as the height increases.
    expect(fit.a).toBeLessThan(0);
  });

  it('the fitted line recovers the proportion heights of visible landmarks', () => {
    const fp = filteredFromFrame(framePose(standingPose({})));
    const line = fitHeightLine(fp)!;
    expect(line).not.toBeNull();
    // Shoulders should sit near 0.82H on the fitted line.
    const yShoulder = 0.5 * (fp.image[11].y + fp.image[12].y);
    const h = (yShoulder - line.b) / line.a;
    expect(Math.abs(h - 0.82)).toBeLessThan(0.03);
  });

  it('a camera framing the head and shoulders -> bust, tighter -> face', () => {
    const pts = computeLandmarkPositions(standingPose({}));
    const bust = run([toPoseFrame(pts, cameraAt(0.55), 0)]);
    expect(bust.fits[0].span).toBeGreaterThanOrEqual(FRAMING_BOUNDS.bust);
    expect(bust.fits[0].span).toBeLessThan(FRAMING_BOUNDS.waist);
    expect(bust.states[0]).toBe('bust');
    const face = run([toPoseFrame(pts, cameraAt(0.25), 0)]);
    expect(face.fits[0].span).toBeLessThan(FRAMING_BOUNDS.bust);
    expect(face.states[0]).toBe('face');
  });

  it('closeup preset is not full-body: the frame bottom cuts the body above the knees', () => {
    const preset = SYNTHETIC_PRESETS.closeup;
    const frames = [];
    for (let i = 0; i < 30; i++) {
      const t = i * DT;
      frames.push(toPoseFrame(computeLandmarkPositions(preset.poseAt(t)), preset.camera, t * 1000));
    }
    const { fits, states } = run(frames);
    const last = fits[fits.length - 1];
    expect(last.valid).toBe(true);
    expect(last.span).toBeLessThan(FRAMING_BOUNDS.full);
    expect(last.visibleBottom).toBeGreaterThan(0.4);
    expect(states.every((s) => s === 'waist' || s === 'bust')).toBe(true);
    expect(new Set(states).size).toBe(1);
  });

  it('approach: full -> waist -> bust with hysteresis and no flicker', () => {
    const preset = SYNTHETIC_PRESETS.approach;
    const frames = [];
    // The preset walks the subject to 1.0 m from the camera (waist framing); the camera then
    // continues to close in to 0.45 m so the bust boundary is crossed as well.
    const total = 12;
    for (let i = 0; i <= total * 30; i++) {
      const t = i * DT;
      const pose = preset.poseAt(Math.min(t, preset.durationSec));
      let cam = preset.camera;
      if (t > preset.durationSec) {
        const k = Math.min(1, (t - preset.durationSec) / 3);
        const dist = 1.0 + (0.45 - 1.0) * k;
        cam = { position: new Vector3(0, 1.2, 2.6 + dist), target: new Vector3(0, 1.2, 0), vFovDeg: 60, aspect: 16 / 9 };
      }
      frames.push(toPoseFrame(computeLandmarkPositions(pose), cam, t * 1000));
    }
    const { states, fits } = run(frames);
    expect(states[0]).toBe('full');
    expect(states[states.length - 1]).toBe('bust');
    expect(dedupe(states)).toEqual(['full', 'waist', 'bust']);
    // The span is continuous (no jumps > 0.1 between frames) even as knees leave the frame.
    for (let i = 1; i < fits.length; i++) expect(Math.abs(fits[i].span - fits[i - 1].span)).toBeLessThan(0.1);
    // Hysteresis: the first waist frame appears only after the span sat below 0.85 - 0.05 for 400 ms.
    const firstWaist = states.indexOf('waist');
    const dwellFrames = Math.round(FRAMING_BOUNDS.dwellSec / DT);
    for (let i = firstWaist - dwellFrames; i < firstWaist; i++) {
      expect(fits[i].span).toBeLessThan(FRAMING_BOUNDS.full - FRAMING_BOUNDS.hysteresis + 1e-9);
    }
  });

  it('a span hovering at a boundary does not flicker', () => {
    // Build fits by hand-crafted frames: alternate between just above and just below 0.85.
    const pts = computeLandmarkPositions(standingPose({}));
    // Distances that put the visible span slightly around the full boundary.
    const frames = [];
    for (let i = 0; i < 90; i++) {
      const z = i % 2 ? 2.35 : 2.2; // both sides of the boundary within the hysteresis band
      frames.push(toPoseFrame(pts, cameraAt(z, 1.0), i * DT * 1000));
    }
    const { states, fits } = run(frames);
    const spans = fits.map((f) => f.span);
    expect(Math.min(...spans)).toBeLessThan(FRAMING_BOUNDS.full);
    expect(Math.max(...spans)).toBeGreaterThan(FRAMING_BOUNDS.full - FRAMING_BOUNDS.hysteresis);
    expect(new Set(states).size).toBe(1);
  });

  it('pose lost keeps the state for 3 s, then none; a tracked face gives face', () => {
    const f = framePose(standingPose({}));
    let fit = fitFraming(filteredFromFrame(f), null, DT);
    expect(fit.state).toBe('full');
    fit = fitFraming(filteredFromFrame(f, { present: false, absentFor: 1 }), fit, DT);
    expect(fit.state).toBe('full');
    fit = fitFraming(filteredFromFrame(f, { present: false, absentFor: 3.5 }), fit, DT);
    expect(fit.state).toBe('none');
    fit = fitFraming(filteredFromFrame(f, { present: false, absentFor: 5, face: new Quaternion() }), fit, DT);
    expect(fit.state).toBe('face');
  });

  it('fewer than two height classes keeps the previous fit', () => {
    const f = framePose(standingPose({}));
    const first = fitFraming(filteredFromFrame(f), null, DT);
    const vis: Record<number, number> = {};
    for (let i = 0; i < 33; i++) if (i !== 11 && i !== 12) vis[i] = 0; // shoulders only
    const next = fitFraming(filteredFromFrame(f, { visibility: vis }), first, DT);
    expect(next.a).toBe(first.a);
    expect(next.b).toBe(first.b);
    expect(next.state).toBe('full');
  });
});
