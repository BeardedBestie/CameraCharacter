import { describe, expect, it } from 'vitest';
import type { HumanoidBone } from '../../src/core/types';
import { ErrorStats, FLAG_CONFIDENCE, FLAG_ERROR_DEG, flaggedRoles, summarize } from '../../src/diagnostics';
import { makeAnalysis, makeSolve } from './fixtures';

const ROLES: HumanoidBone[] = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg'];

describe('summarize', () => {
  it('flags only confident auto/calibrated bones above the threshold', () => {
    const solve = makeSolve({
      hips: { errorDeg: 12, mode: 'relative' }, // relative: never flagged
      spine: { errorDeg: 9, mode: 'relative' },
      head: { errorDeg: 2, mode: 'relative' },
      leftUpperArm: { errorDeg: 8.5, confidence: 0.9 }, // auto, confident, > 5 -> flagged
      leftLowerArm: { errorDeg: 8.5, confidence: 0.3 }, // not confident
      rightUpperArm: { errorDeg: 6, mode: 'calibrated', confidence: 0.7 }, // calibrated -> flagged
      rightLowerArm: { errorDeg: 4.9 }, // under threshold
      leftUpperLeg: { errorDeg: 30, mode: 'follow' }, // follow: never flagged
      rightUpperLeg: { errorDeg: null, source: 'hold' }, // nothing measured
    });
    const analysis = makeAnalysis(ROLES);
    const s = summarize(solve, analysis);

    expect(s.perBone.map((b) => b.role)).toEqual(solve.roles);
    expect(flaggedRoles(s)).toEqual(['leftUpperArm', 'rightUpperArm']);
    expect(s.ok).toBe(false);
    const byRole = Object.fromEntries(s.perBone.map((b) => [b.role, b]));
    expect(byRole.leftUpperArm.bone).toBe('mixamorig:leftUpperArm');
    expect(byRole.leftUpperArm.mode).toBe('auto');
    expect(byRole.leftUpperArm.source).toBe('measured');
    expect(byRole.rightUpperLeg.errorDeg).toBeNull();
    expect(byRole.rightUpperLeg.flagged).toBe(false);
    expect(byRole.leftLowerArm.flagged).toBe(false);
    expect(byRole.hips.flagged).toBe(false);
    expect(byRole.leftUpperLeg.flagged).toBe(false);
  });

  it('reports worst, max and the mean over confident bones only', () => {
    const solve = makeSolve({
      hips: { errorDeg: 1, mode: 'relative', confidence: 0.9 },
      leftUpperArm: { errorDeg: 3, confidence: 0.9 },
      rightUpperArm: { errorDeg: 5, confidence: 0.9 },
      leftLowerArm: { errorDeg: 40, confidence: 0.2 }, // not confident: excluded from mean/max
      rightLowerArm: { errorDeg: null },
    });
    const s = summarize(solve, null);
    expect(s.worst).toBe('rightUpperArm');
    expect(s.maxErrorDeg).toBe(5);
    expect(s.meanErrorDeg).toBeCloseTo((1 + 3 + 5) / 3, 10);
    expect(s.ok).toBe(true);
    // No analysis: bone names unknown.
    expect(s.perBone.every((b) => b.bone === null)).toBe(true);
  });

  it('exposes the four chain errors and handles an empty solve', () => {
    const solve = makeSolve({ hips: { errorDeg: 0, mode: 'relative' } });
    const s = summarize(solve, null);
    expect(s.chains).toEqual([
      { name: 'leftArm', errorDeg: 1.5 },
      { name: 'rightArm', errorDeg: null },
      { name: 'leftLeg', errorDeg: 0.4 },
      { name: 'rightLeg', errorDeg: 7.2 },
    ]);
    const empty = summarize(makeSolve({}, { chainErrorDeg: { leftArm: null, rightArm: null, leftLeg: null, rightLeg: null } }), null);
    expect(empty.perBone).toEqual([]);
    expect(empty.worst).toBeNull();
    expect(empty.maxErrorDeg).toBeNull();
    expect(empty.meanErrorDeg).toBeNull();
    expect(empty.ok).toBe(true);
  });

  it('treats non-finite errors as unmeasured and honors custom thresholds', () => {
    const solve = makeSolve({ leftUpperArm: { errorDeg: 3, confidence: 0.9 }, rightUpperArm: { errorDeg: 7, confidence: 0.6 } });
    solve.perRole.leftUpperArm!.errorDeg = NaN;
    const s = summarize(solve, null, { errorDeg: 6, confidence: 0.55 });
    expect(s.perBone[0].errorDeg).toBeNull();
    expect(flaggedRoles(s)).toEqual(['rightUpperArm']);
    // Defaults are the documented constants.
    expect(FLAG_ERROR_DEG).toBe(5);
    expect(FLAG_CONFIDENCE).toBe(0.5);
  });
});

describe('ErrorStats', () => {
  it('keeps a rolling window per role', () => {
    const stats = new ErrorStats(4);
    for (let i = 1; i <= 6; i++) stats.push(summarize(makeSolve({ leftUpperArm: { errorDeg: i }, rightUpperArm: { errorDeg: null } }), null));
    // Window holds the last four samples: 3, 4, 5, 6.
    expect(stats.get('leftUpperArm')).toEqual({ mean: 4.5, max: 6, n: 4 });
    // Frames without a measurement do not count.
    expect(stats.get('rightUpperArm')).toBeNull();
    expect(stats.get('head')).toBeNull();
    expect(stats.roles()).toEqual(['leftUpperArm']);
  });

  it('fills the window before wrapping and resets', () => {
    const stats = new ErrorStats(60);
    expect(stats.windowFrames).toBe(60);
    stats.push(summarize(makeSolve({ hips: { errorDeg: 2, mode: 'relative' } }), null));
    stats.push(summarize(makeSolve({ hips: { errorDeg: 4, mode: 'relative' } }), null));
    expect(stats.get('hips')).toEqual({ mean: 3, max: 4, n: 2 });
    stats.reset();
    expect(stats.get('hips')).toBeNull();
    expect(() => new ErrorStats(0)).toThrow();
  });
});
