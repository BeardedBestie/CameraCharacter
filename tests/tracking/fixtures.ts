import type { LandmarkTuple, MocapRecording, PoseFrame, SmoothingSettings } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/types';

export const SMOOTHING: SmoothingSettings = { ...DEFAULT_SETTINGS.smoothing };

/** A deterministic 33-point pose: landmark i at world (0.01*i, 0.02*i, 0.03*i), image spread across [0,1]. */
export function makePoseFrame(t: number, overrides: Partial<PoseFrame> = {}, visibility = 1): PoseFrame {
  const world: LandmarkTuple[] = [];
  const image: LandmarkTuple[] = [];
  for (let i = 0; i < 33; i++) {
    world.push([0.01 * i, 0.02 * i, 0.03 * i, visibility]);
    image.push([0.1 + (i / 33) * 0.8, 0.2 + (i / 33) * 0.6, -0.01 * i, visibility]);
  }
  return { v: 2, t, src: 'test', size: [640, 480], pose: { world, image }, ...overrides };
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
