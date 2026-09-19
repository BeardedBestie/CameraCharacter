import type { HandFrame, LandmarkTuple, MocapRecording, PointTuple, PoseFrame, SmoothingSettings } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/types';

export const SMOOTHING: SmoothingSettings = { ...DEFAULT_SETTINGS.smoothing };

/** A deterministic 33-point pose: landmark i at world (0.01*i, 0.02*i, 0.03*i), image spread across [0.1, 0.9]×[0.2, 0.8]. */
export function makePoseFrame(t: number, overrides: Partial<PoseFrame> = {}, visibility = 1): PoseFrame {
  const world: LandmarkTuple[] = [];
  const image: LandmarkTuple[] = [];
  for (let i = 0; i < 33; i++) {
    world.push([0.01 * i, 0.02 * i, 0.03 * i, visibility]);
    image.push([0.1 + (i / 33) * 0.8, 0.2 + (i / 33) * 0.6, -0.01 * i, visibility]);
  }
  return { v: 2, t, src: 'test', size: [640, 480], pose: { world, image }, ...overrides };
}

/** A 21-point hand with local x = k + i/1000 and constant image position. */
export function makeHand(k: number, handedness?: 'Left' | 'Right'): HandFrame {
  const local: PointTuple[] = Array.from({ length: 21 }, (_, i) => [k + i * 0.001, 0.2, 0.3]);
  const image: PointTuple[] = Array.from({ length: 21 }, (_, i) => [0.3 + k * 0.1, 0.5 + i * 0.001, -0.01]);
  const hand: HandFrame = { local, image, score: 0.9 };
  if (handedness) hand.handedness = handedness;
  return hand;
}

export function makeRecording(n: number, gapMs = 33): MocapRecording {
  const frames: PoseFrame[] = [];
  for (let i = 0; i < n; i++) frames.push(makePoseFrame(1000 + i * gapMs));
  return {
    format: 'cameracharacter-mocap',
    version: 2,
    meta: { createdAt: '2026-09-19T00:00:00Z', source: 'test', size: [640, 480], mirror: false },
    frames,
  };
}

/** Column-major 4x4 rotation about +Y by `rad` with translation (tx, ty, tz). */
export function yawMatrix(rad: number, tx = 0, ty = 0, tz = 0): number[] {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1];
}
