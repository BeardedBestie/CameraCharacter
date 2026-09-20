import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { parsePoseFrame } from '../../src/tracking/WebSocketSource';
import { parseMocapRecording } from '../../src/tracking/RecordingSource';
import { MEDIAPIPE_VERSION } from '../../src/tracking/mediapipeModels';
import { TRACKER_LIB, TRACKER_VERSION, buildMocapMeta, validatePoseFrame } from '../../src/tracking/protocol';
import { makeHand, makePoseFrame, makeRecording } from './fixtures';

describe('parsePoseFrame', () => {
  it('accepts a valid v2 frame and returns a fresh normalized copy', () => {
    const frame = makePoseFrame(12.5);
    const parsed = parsePoseFrame(JSON.stringify(frame));
    expect(parsed).not.toBeNull();
    expect(parsed!.v).toBe(2);
    expect(parsed!.t).toBe(12.5);
    expect(parsed!.src).toBe('test');
    expect(parsed!.size).toEqual([640, 480]);
    expect(parsed!.pose!.world).toHaveLength(33);
    expect(parsed!.pose!.image).toHaveLength(33);
    expect(parsed!.pose!.world[7]).toEqual(frame.pose!.world[7]);
    expect(parsed!.pose!.world[7]).not.toBe(frame.pose!.world[7]);
    expect('hands' in parsed!).toBe(false);
    expect('now' in parsed!).toBe(false);
  });

  it('accepts a null pose, hands and face', () => {
    const parsed = parsePoseFrame(JSON.stringify({ v: 2, t: 1, src: 'x', size: [1, 1], pose: null, hands: null, face: null }));
    expect(parsed).not.toBeNull();
    expect(parsed!.pose).toBeNull();
    expect(parsed!.hands).toBeNull();
    expect(parsed!.face).toBeNull();
  });

  it('keeps a finite `now` and drops a malformed one', () => {
    expect(parsePoseFrame(JSON.stringify({ ...makePoseFrame(1), now: 98765.4 }))!.now).toBe(98765.4);
    expect(parsePoseFrame(JSON.stringify({ ...makePoseFrame(1), now: 'x' }))!.now).toBeUndefined();
    expect(parsePoseFrame(JSON.stringify({ ...makePoseFrame(1), now: null }))!.now).toBeUndefined();
  });

  it('fills a default visibility for 3-component landmarks', () => {
    const frame = makePoseFrame(1);
    const raw = JSON.parse(JSON.stringify(frame));
    raw.pose.world = raw.pose.world.map((p: number[]) => p.slice(0, 3));
    const parsed = parsePoseFrame(JSON.stringify(raw));
    expect(parsed!.pose!.world[0][3]).toBe(1);
  });

  it('rejects wrong version, bad JSON, bad landmark counts and non-numeric values', () => {
    expect(parsePoseFrame('not json')).toBeNull();
    expect(parsePoseFrame('[]')).toBeNull();
    const frame = makePoseFrame(1);
    expect(parsePoseFrame(JSON.stringify({ ...frame, v: 1 }))).toBeNull();
    expect(parsePoseFrame(JSON.stringify({ ...frame, t: 'now' }))).toBeNull();
    const short = JSON.parse(JSON.stringify(frame));
    short.pose.world.pop();
    expect(parsePoseFrame(JSON.stringify(short))).toBeNull();
    const nan = JSON.parse(JSON.stringify(frame));
    nan.pose.image[3][1] = 'x';
    expect(parsePoseFrame(JSON.stringify(nan))).toBeNull();
    expect(parsePoseFrame(JSON.stringify({ ...frame, size: [640] }))).toBeNull();
  });

  it('validates hands (21 local + image points, optional handedness) and face (16-number matrix)', () => {
    const hand = makeHand(0, 'Right');
    const ok = parsePoseFrame(
      JSON.stringify({ ...makePoseFrame(1), hands: { left: hand, right: null }, face: { blendshapes: { jawOpen: 0.2 }, matrix: new Array(16).fill(0) } }),
    );
    expect(ok!.hands!.left!.score).toBe(0.9);
    expect(ok!.hands!.left!.local).toHaveLength(21);
    expect(ok!.hands!.left!.handedness).toBe('Right');
    expect(ok!.hands!.right).toBeNull();
    expect(ok!.face!.matrix).toHaveLength(16);
    expect(ok!.face!.blendshapes.jawOpen).toBe(0.2);

    // Handedness is optional and lenient; unknown labels are dropped.
    const noLabel = parsePoseFrame(JSON.stringify({ ...makePoseFrame(1), hands: { left: makeHand(0), right: null } }));
    expect(noLabel!.hands!.left!.handedness).toBeUndefined();
    const badLabel = parsePoseFrame(JSON.stringify({ ...makePoseFrame(1), hands: { left: { ...makeHand(0), handedness: 'Both' }, right: null } }));
    expect(badLabel!.hands!.left!.handedness).toBeUndefined();

    // Pre-2.1 frames named the array `world`; they still validate.
    const legacy = { local: undefined, world: hand.local, image: hand.image, score: 0.5 };
    const legacyParsed = parsePoseFrame(JSON.stringify({ ...makePoseFrame(1), hands: { left: legacy, right: null } }));
    expect(legacyParsed!.hands!.left!.local).toEqual(hand.local);

    const badHand = { ...hand, local: hand.local.slice(0, 20) };
    expect(parsePoseFrame(JSON.stringify({ ...makePoseFrame(1), hands: { left: badHand, right: null } }))).toBeNull();
    expect(parsePoseFrame(JSON.stringify({ ...makePoseFrame(1), face: { blendshapes: {}, matrix: [1, 2, 3] } }))).toBeNull();
    const noMatrix = parsePoseFrame(JSON.stringify({ ...makePoseFrame(1), face: { blendshapes: {} } }));
    expect(noMatrix!.face!.matrix).toBeNull();
  });

  it('validatePoseFrame clamps visibility into [0,1]', () => {
    const frame = makePoseFrame(1);
    frame.pose!.world[0][3] = 1.7;
    frame.pose!.world[1][3] = -0.2;
    const out = validatePoseFrame(JSON.parse(JSON.stringify(frame)));
    expect(out!.pose!.world[0][3]).toBe(1);
    expect(out!.pose!.world[1][3]).toBe(0);
  });
});

describe('parseMocapRecording', () => {
  it('accepts a valid recording and validates every frame', () => {
    const rec = parseMocapRecording(JSON.parse(JSON.stringify(makeRecording(5))));
    expect(rec.format).toBe('cameracharacter-mocap');
    expect(rec.version).toBe(2);
    expect(rec.frames).toHaveLength(5);
    expect(rec.meta.size).toEqual([640, 480]);
    expect(rec.meta.mirror).toBe(false);
    expect(rec.meta.tracker).toBeUndefined();
  });

  it('fills meta defaults from the frames', () => {
    const rec = parseMocapRecording({ format: 'cameracharacter-mocap', version: 2, frames: [makePoseFrame(0)] });
    expect(rec.meta.size).toEqual([640, 480]);
    expect(rec.meta.source).toBe('test');
  });

  it('parses the rich meta leniently (t0, camera, tracker, smoothing, calibration, referenceModel)', () => {
    const rec = parseMocapRecording({
      format: 'cameracharacter-mocap',
      version: 2,
      meta: {
        createdAt: '2026-09-19T10:00:00Z',
        source: 'mediapipe-web',
        size: [1280, 720],
        mirror: true,
        fovDeg: 45,
        t0: { wallclock: '2026-09-19T10:00:00Z', performanceNow: 12345.6 },
        camera: { deviceLabel: 'cam', facingMode: 'user', frameRate: 30, vfovDeg: 45, junk: 1 },
        tracker: { lib: '@mediapipe/tasks-vision', version: '1.0.1', poseModel: 'full', delegate: 'GPU', hands: false, face: 'no' },
        smoothing: { oneEuroBeta: 12, gateFeet: { on: 0.4 }, poseHoldMs: { arms: 100 }, bogus: 5 },
        calibration: null,
        referenceModel: { familyKey: 'fam', instanceKey: 'inst', displayName: 'Meshy' },
      },
      frames: [makePoseFrame(0)],
    });
    expect(rec.meta.t0).toEqual({ wallclock: '2026-09-19T10:00:00Z', performanceNow: 12345.6 });
    expect(rec.meta.camera).toEqual({ deviceLabel: 'cam', facingMode: 'user', frameRate: 30, vfovDeg: 45 });
    expect(rec.meta.tracker).toEqual({ lib: '@mediapipe/tasks-vision', version: '1.0.1', poseModel: 'full', delegate: 'GPU', hands: false });
    expect(rec.meta.smoothing!.oneEuroBeta).toBe(12);
    expect(rec.meta.smoothing!.gateFeet).toEqual({ on: 0.4, off: DEFAULT_SETTINGS.smoothing.gateFeet.off });
    expect(rec.meta.smoothing!.poseHoldMs).toEqual({ ...DEFAULT_SETTINGS.smoothing.poseHoldMs, arms: 100 });
    expect(rec.meta.smoothing!.oneEuroMinCutoff).toBe(DEFAULT_SETTINGS.smoothing.oneEuroMinCutoff);
    expect(rec.meta.calibration).toBeNull();
    expect(rec.meta.referenceModel).toEqual({ familyKey: 'fam', instanceKey: 'inst', displayName: 'Meshy' });

    // Malformed optional blocks are dropped, not fatal.
    const sloppy = parseMocapRecording({
      format: 'cameracharacter-mocap',
      version: 2,
      meta: { t0: { wallclock: 3 }, camera: 'x', tracker: null, smoothing: [], calibration: { version: 2 }, referenceModel: { familyKey: 1 } },
      frames: [],
    });
    expect(sloppy.meta.t0).toBeUndefined();
    expect(sloppy.meta.camera).toBeUndefined();
    expect(sloppy.meta.tracker).toBeUndefined();
    expect(sloppy.meta.smoothing).toBeUndefined();
    expect(sloppy.meta.calibration).toBeUndefined();
    expect(sloppy.meta.referenceModel).toBeUndefined();
    const cal = parseMocapRecording({
      format: 'cameracharacter-mocap',
      version: 2,
      meta: { calibration: { version: 3, createdAt: 'x', bases: {}, torsoBaseline: null, segmentLengths: {}, zRef: null, frames: 60 } },
      frames: [],
    });
    expect(cal.meta.calibration!.version).toBe(3);
  });

  it('rejects wrong format, version, missing frames and invalid frames', () => {
    expect(() => parseMocapRecording(null)).toThrow();
    expect(() => parseMocapRecording({ format: 'other', version: 2, frames: [] })).toThrow(/format/);
    expect(() => parseMocapRecording({ format: 'cameracharacter-mocap', version: 1, frames: [] })).toThrow(/version/);
    expect(() => parseMocapRecording({ format: 'cameracharacter-mocap', version: 2 })).toThrow(/frames/);
    expect(() => parseMocapRecording({ format: 'cameracharacter-mocap', version: 2, frames: [{ v: 1 }] })).toThrow(/frame 0/);
  });
});

describe('buildMocapMeta', () => {
  it('fills createdAt and the tracker identity, keeps the partial and round-trips through the parser', () => {
    const now = new Date('2026-09-19T12:00:00.000Z');
    const meta = buildMocapMeta({}, now);
    expect(meta.createdAt).toBe('2026-09-19T12:00:00.000Z');
    expect(meta.source).toBe('unknown');
    expect(meta.size).toEqual([0, 0]);
    expect(meta.mirror).toBe(false);
    expect(meta.tracker).toEqual({ lib: TRACKER_LIB, version: TRACKER_VERSION });
    expect(TRACKER_LIB).toBe('@mediapipe/tasks-vision');
    expect(TRACKER_VERSION).toBe(MEDIAPIPE_VERSION);
    expect('notes' in meta).toBe(false);

    const full = buildMocapMeta(
      {
        source: 'mediapipe-web',
        size: [1280, 720],
        mirror: true,
        fovDeg: 45,
        t0: { wallclock: now.toISOString(), performanceNow: 100 },
        camera: { deviceLabel: 'cam' },
        tracker: { lib: TRACKER_LIB, version: TRACKER_VERSION, poseModel: 'heavy', delegate: 'CPU' },
        smoothing: DEFAULT_SETTINGS.smoothing,
        calibration: null,
        referenceModel: { familyKey: 'f', displayName: 'd' },
        notes: 'n',
      },
      now,
    );
    expect(full.tracker!.poseModel).toBe('heavy');
    expect(full.tracker!.lib).toBe(TRACKER_LIB);
    const rec = parseMocapRecording({ format: 'cameracharacter-mocap', version: 2, meta: JSON.parse(JSON.stringify(full)), frames: [] });
    expect(rec.meta).toEqual(full);
  });
});
