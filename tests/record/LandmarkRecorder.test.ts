import { describe, expect, it } from 'vitest';
import type { MocapRecording, PoseFrame } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { LandmarkRecorder, serializeRecording } from '../../src/record/LandmarkRecorder';
import { framePose, standingPose } from '../../src/testing/syntheticHuman';

function isIsoDate(s: string): boolean {
  return !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s);
}

/** Local shape validation of a recording (the protocol module is owned by another agent). */
function validateRecording(rec: MocapRecording): void {
  expect(rec.format).toBe('cameracharacter-mocap');
  expect(rec.version).toBe(2);
  expect(isIsoDate(rec.meta.createdAt)).toBe(true);
  expect(typeof rec.meta.source).toBe('string');
  expect(rec.meta.size).toHaveLength(2);
  expect(typeof rec.meta.mirror).toBe('boolean');
  expect(Array.isArray(rec.frames)).toBe(true);
  for (const f of rec.frames) {
    expect(f.v).toBe(2);
    expect(typeof f.t).toBe('number');
    expect(typeof f.src).toBe('string');
    expect(f.size).toHaveLength(2);
    if (f.pose) {
      expect(f.pose.world).toHaveLength(33);
      expect(f.pose.image).toHaveLength(33);
      for (const lm of f.pose.world) expect(lm).toHaveLength(4);
    }
  }
}

describe('LandmarkRecorder', () => {
  it('builds a valid recording with filled meta and raw frames', () => {
    const rec = new LandmarkRecorder();
    expect(rec.isRecording).toBe(false);
    rec.push(framePose(standingPose({}), 0)); // ignored before start
    rec.start({ mirror: true, tracker: { lib: '@mediapipe/tasks-vision', version: '1.0.1' }, smoothing: DEFAULT_SETTINGS.smoothing }, 1234.5);
    expect(rec.isRecording).toBe(true);
    const frames: PoseFrame[] = [];
    for (let i = 0; i < 5; i++) {
      const f = framePose(standingPose({}), 1000 + i * 33.3);
      frames.push(f);
      rec.push(f);
    }
    expect(rec.frameCount).toBe(5);
    expect(rec.durationMs).toBeCloseTo(4 * 33.3, 6);
    const out = rec.stop();
    expect(rec.isRecording).toBe(false);
    validateRecording(out);
    expect(out.frames).toHaveLength(5);
    // Raw: the very same frame objects, untouched.
    for (let i = 0; i < 5; i++) {
      expect(out.frames[i]).toBe(frames[i]);
      expect(out.frames[i].pose?.world[0]).toEqual(framePose(standingPose({}), 1000 + i * 33.3).pose?.world[0]);
    }
    expect(out.meta.mirror).toBe(true);
    expect(out.meta.source).toBe('synthetic'); // from the first frame
    expect(out.meta.size).toEqual([1280, 720]); // from the first frame
    expect(out.meta.t0?.performanceNow).toBe(1234.5);
    expect(isIsoDate(out.meta.t0?.wallclock ?? '')).toBe(true);
    expect(out.meta.tracker?.version).toBe('1.0.1');
    expect(out.meta.smoothing?.oneEuroBeta).toBe(DEFAULT_SETTINGS.smoothing.oneEuroBeta);
    expect(out.meta.calibration).toBeUndefined();
    // The recorder is reset after stop.
    expect(rec.frameCount).toBe(0);
    expect(rec.durationMs).toBe(0);
  });

  it('keeps explicitly given source, size, calibration and reference model', () => {
    const rec = new LandmarkRecorder();
    rec.start(
      {
        source: 'mediapipe-web',
        size: [640, 480],
        calibration: null,
        referenceModel: { familyKey: 'fam', displayName: 'Sample' },
        camera: { vfovDeg: 50 },
        fovDeg: 50,
        notes: 'hello',
      },
      0,
    );
    rec.push(framePose(standingPose({}), 0));
    const out = rec.stop();
    validateRecording(out);
    expect(out.meta.source).toBe('mediapipe-web');
    expect(out.meta.size).toEqual([640, 480]);
    expect(out.meta.calibration).toBeNull();
    expect(out.meta.referenceModel?.displayName).toBe('Sample');
    expect(out.meta.camera?.vfovDeg).toBe(50);
    expect(out.meta.fovDeg).toBe(50);
    expect(out.meta.notes).toBe('hello');
  });

  it('throws when stopped without start and returns an empty recording for an empty take', () => {
    const rec = new LandmarkRecorder();
    expect(() => rec.stop()).toThrow();
    rec.start({ source: 'x', size: [1, 1] }, 0);
    const out = rec.stop();
    validateRecording(out);
    expect(out.frames).toHaveLength(0);
  });
});

describe('serializeRecording', () => {
  it('produces compact JSON with numbers rounded to 5 decimals', () => {
    const f = framePose(standingPose({}), 1000.123456789);
    if (!f.pose) throw new Error('pose expected');
    f.pose.world[0] = [0.1234567, -0.9999996, 1e-7, 0.5];
    f.pose.image[1] = [Number.NaN, 0.5, 0.5, 1];
    const rec: MocapRecording = {
      format: 'cameracharacter-mocap',
      version: 2,
      meta: { createdAt: '2026-09-19T00:00:00.000Z', source: 'synthetic', size: [1280, 720], mirror: false, t0: { wallclock: '2026-09-19T00:00:00.000Z', performanceNow: 12.3456789 } },
      frames: [f],
    };
    const text = serializeRecording(rec);
    expect(text).not.toContain('\n');
    expect(text).not.toContain(': ');
    const parsed = JSON.parse(text) as MocapRecording;
    validateRecording(parsed);
    expect(parsed.version).toBe(2);
    expect(parsed.frames[0].t).toBe(1000.12346);
    expect(parsed.frames[0].pose?.world[0]).toEqual([0.12346, -1, 0, 0.5]);
    expect(parsed.frames[0].pose?.image[1][0]).toBeNull();
    expect(parsed.meta.t0?.performanceNow).toBe(12.34568);
    expect(parsed.meta.size).toEqual([1280, 720]);
  });
});
