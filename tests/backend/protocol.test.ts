/**
 * Cross-language contract: frames produced by backend/stream_pose.py must pass
 * the browser's PoseFrame v2 validator (src/tracking/protocol.ts). The Python
 * encoder is exercised directly through python3 when it is available; the
 * checked-in example frame is validated unconditionally.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POSE_LANDMARK_COUNT } from '../../src/tracking/landmarks';
import { parsePoseFrameText, validatePoseFrame } from '../../src/tracking/protocol';

const ROOT = resolve(__dirname, '../..');
const BACKEND = resolve(ROOT, 'backend');

function runPython(script: string): string | null {
  const result = spawnSync('python3', ['-c', script], { cwd: BACKEND, encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/** Encode a frame with the Python encoder using duck-typed landmark objects (no mediapipe import). */
const ENCODE_SCRIPT = `
import json, sys
from types import SimpleNamespace as NS
import stream_pose as sp
image = [NS(x=0.5 + i * 0.001, y=0.25 + i * 0.01, z=-0.1 * (i % 3), visibility=1.0 - i / 64, presence=0.9) for i in range(33)]
world = [NS(x=(i - 16) * 0.02, y=-0.6 + i * 0.03, z=1e-7 * i, visibility=1.5 if i == 0 else -0.2 if i == 1 else 0.8, presence=0.9) for i in range(33)]
result = NS(pose_landmarks=[image], pose_world_landmarks=[world], segmentation_masks=None)
print(sp.frame_to_json(sp.encode_frame(1234.567891, (1280, 720), result)))
print(sp.frame_to_json(sp.encode_frame(1235, (1280, 720), None)))
print(sp.frame_to_json(sp.encode_frame(1236, (1280, 720), NS(pose_landmarks=[], pose_world_landmarks=[], segmentation_masks=None))))
# Production path: integer timestamp_ms plus the provider's performance counter, and a
# landmark whose coordinate is not finite (must come out invisible, never NaN in the JSON).
world[3] = NS(x=float("nan"), y=0.0, z=0.0, visibility=0.9, presence=0.9)
image[4] = NS(x=0.1, y=float("inf"), z=0.0, visibility=0.9, presence=0.9)
print(sp.frame_to_json(sp.encode_frame(4242, (640, 480), result, now_ms=98765.4321987)))
`;

const pythonAvailable = runPython('import stream_pose') !== null;

describe('backend/example_frame.json', () => {
  it('is a valid PoseFrame v2 for the browser parser', () => {
    const text = readFileSync(resolve(BACKEND, 'example_frame.json'), 'utf8');
    const frame = parsePoseFrameText(text);
    expect(frame).not.toBeNull();
    expect(frame!.v).toBe(2);
    expect(frame!.src).toBe('python-opencv');
    expect(frame!.size).toEqual([1280, 720]);
    expect(frame!.pose?.world).toHaveLength(POSE_LANDMARK_COUNT);
    expect(frame!.pose?.image).toHaveLength(POSE_LANDMARK_COUNT);
    expect(frame!.hands).toBeUndefined();
    expect(frame!.face).toBeUndefined();
  });
});

describe.skipIf(!pythonAvailable)('backend/stream_pose.py encoder', () => {
  const lines = (runPython(ENCODE_SCRIPT) ?? '').trim().split('\n');

  it('produces four messages', () => {
    expect(lines).toHaveLength(4);
  });

  it('encodes a detected pose that the browser accepts', () => {
    const frame = parsePoseFrameText(lines[0]!);
    expect(frame).not.toBeNull();
    expect(frame!.src).toBe('python-opencv');
    expect(frame!.size).toEqual([1280, 720]);
    expect(frame!.t).toBe(1234.56789);
    expect(frame!.pose).not.toBeNull();
    expect(frame!.pose!.world).toHaveLength(POSE_LANDMARK_COUNT);
    expect(frame!.pose!.image).toHaveLength(POSE_LANDMARK_COUNT);
    expect(frame!.pose!.image[0]).toEqual([0.5, 0.25, 0, 1]);
    // Visibility is clamped to [0, 1] on the Python side already.
    const raw = JSON.parse(lines[0]!) as { pose: { world: number[][] } };
    expect(raw.pose.world[0]![3]).toBe(1);
    expect(raw.pose.world[1]![3]).toBe(0);
    // Floats carry at most 5 decimals and never NaN/Infinity.
    expect(lines[0]).not.toMatch(/NaN|Infinity/);
    for (const m of lines[0]!.matchAll(/-?\d+\.(\d+)/g)) expect(m[1]!.length).toBeLessThanOrEqual(5);
    expect(lines[0]!.length).toBeLessThan(4000);
  });

  it('encodes "no subject" as pose null (both None and empty results)', () => {
    for (const line of [lines[1]!, lines[2]!]) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.pose).toBeNull();
      expect(parsed).not.toHaveProperty('hands');
      expect(parsed).not.toHaveProperty('face');
      const frame = validatePoseFrame(parsed);
      expect(frame).not.toBeNull();
      expect(frame!.pose).toBeNull();
    }
  });

  it('keeps an integer timestamp integral and passes the optional now field through', () => {
    const line = lines[3]!;
    // `t` is the int handed to detect_for_video; it must not become "4242.0" on the wire.
    expect(line).toMatch(/"t":4242,/);
    expect(line).toMatch(/"now":98765\.4322[,}]/);
    const frame = parsePoseFrameText(line);
    expect(frame).not.toBeNull();
    expect(frame!.t).toBe(4242);
    expect(frame!.now).toBe(98765.4322);
    expect(frame!.size).toEqual([640, 480]);
    // The other three messages carry no `now`, and the validator leaves it undefined.
    expect(parsePoseFrameText(lines[1]!)!.now).toBeUndefined();
    expect(lines[1]).not.toContain('"now"');
  });

  it('turns a landmark with a non-finite coordinate into an invisible point the browser accepts', () => {
    const line = lines[3]!;
    expect(line).not.toMatch(/NaN|Infinity/);
    const frame = parsePoseFrameText(line);
    expect(frame).not.toBeNull();
    expect(frame!.pose).not.toBeNull();
    expect(frame!.pose!.world[3]).toEqual([0, 0, 0, 0]);
    expect(frame!.pose!.image[4]).toEqual([0, 0, 0, 0]);
    // Neighbours are untouched.
    expect(frame!.pose!.world[2]![3]).toBeCloseTo(0.8, 5);
    expect(frame!.pose!.image[5]![0]).toBeCloseTo(0.505, 5);
  });
});
