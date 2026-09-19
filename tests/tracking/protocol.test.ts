import { describe, expect, it } from 'vitest';
import { parsePoseFrame } from '../../src/tracking/WebSocketSource';
import { parseMocapRecording } from '../../src/tracking/RecordingSource';
import { validatePoseFrame } from '../../src/tracking/protocol';
import { makePoseFrame, makeRecording } from './fixtures';

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
  });

  it('accepts a null pose, hands and face', () => {
    const parsed = parsePoseFrame(JSON.stringify({ v: 2, t: 1, src: 'x', size: [1, 1], pose: null, hands: null, face: null }));
    expect(parsed).not.toBeNull();
    expect(parsed!.pose).toBeNull();
    expect(parsed!.hands).toBeNull();
    expect(parsed!.face).toBeNull();
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

  it('validates hands (21 points) and face (16-number matrix)', () => {
    const hand = {
      world: Array.from({ length: 21 }, () => [0, 0, 0]),
      image: Array.from({ length: 21 }, () => [0.5, 0.5, 0]),
      score: 0.7,
    };
    const ok = parsePoseFrame(
      JSON.stringify({ ...makePoseFrame(1), hands: { left: hand, right: null }, face: { blendshapes: { jawOpen: 0.2 }, matrix: new Array(16).fill(0) } }),
    );
    expect(ok!.hands!.left!.score).toBe(0.7);
    expect(ok!.hands!.right).toBeNull();
    expect(ok!.face!.matrix).toHaveLength(16);
    expect(ok!.face!.blendshapes.jawOpen).toBe(0.2);

    const badHand = { ...hand, world: hand.world.slice(0, 20) };
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
  });

  it('fills meta defaults from the frames', () => {
    const rec = parseMocapRecording({ format: 'cameracharacter-mocap', version: 2, frames: [makePoseFrame(0)] });
    expect(rec.meta.size).toEqual([640, 480]);
    expect(rec.meta.source).toBe('test');
  });

  it('rejects wrong format, version, missing frames and invalid frames', () => {
    expect(() => parseMocapRecording(null)).toThrow();
    expect(() => parseMocapRecording({ format: 'other', version: 2, frames: [] })).toThrow(/format/);
    expect(() => parseMocapRecording({ format: 'cameracharacter-mocap', version: 1, frames: [] })).toThrow(/version/);
    expect(() => parseMocapRecording({ format: 'cameracharacter-mocap', version: 2 })).toThrow(/frames/);
    expect(() => parseMocapRecording({ format: 'cameracharacter-mocap', version: 2, frames: [{ v: 1 }] })).toThrow(/frame 0/);
  });
});
