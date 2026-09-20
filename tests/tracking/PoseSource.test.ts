import { describe, expect, it } from 'vitest';
import type { PoseFrame } from '../../src/core/types';
import { BaseSource, FpsMeter } from '../../src/tracking/PoseSource';
import type { SourceStatus } from '../../src/tracking/PoseSource';
import { isDeviceUnavailableError } from '../../src/tracking/camera';
import { makePoseFrame } from './fixtures';

/** Concrete source exposing the protected hooks for the test. */
class ProbeSource extends BaseSource {
  readonly kind = 'recording' as const;
  async start(): Promise<void> {
    this.setStatus({ state: 'running' });
  }
  stop(): void {
    this.setStatus({ state: 'stopped' });
  }
  push(frame: PoseFrame, wallMs: number, inferenceMs?: number): void {
    if (inferenceMs !== undefined) this.reportInferenceMs(inferenceMs);
    this.emitFrame(frame, wallMs);
  }
}

describe('BaseSource status metrics', () => {
  it('publishes fps and inferenceMs together at the throttled cadence, never per frame', async () => {
    const src = new ProbeSource();
    const statuses: SourceStatus[] = [];
    src.onStatus((s) => statuses.push(s));
    await src.start();
    const publishesBefore = statuses.length;
    // 30 frames over one second with a varying inference time.
    for (let k = 0; k < 30; k++) src.push(makePoseFrame(k * 33), 1000 + k * 33, 5 + (k % 3));
    const published = statuses.slice(publishesBefore);
    // 500 ms cadence → at most 3 publishes for ~1 s of frames, each carrying both metrics.
    expect(published.length).toBeGreaterThanOrEqual(1);
    expect(published.length).toBeLessThanOrEqual(3);
    for (const s of published) {
      expect(s.state).toBe('running');
      expect(s.inferenceMs).toBeGreaterThan(4);
      expect(s.inferenceMs).toBeLessThan(8);
    }
    // The very first publish happens on the first frame (one sample → fps 0); later ones carry the rate.
    for (const s of published.slice(1)) {
      expect(s.fps).toBeGreaterThan(25);
      expect(s.fps).toBeLessThan(35);
    }
    expect(src.status.inferenceMs).toBeDefined();
    // Leaving the running state clears the metrics.
    src.stop();
    expect(src.status.inferenceMs).toBeUndefined();
    expect(src.status.fps).toBeUndefined();
  });

  it('FpsMeter converges to the frame rate and resets', () => {
    const m = new FpsMeter(0.5);
    expect(m.value).toBe(0);
    for (let k = 0; k < 50; k++) m.tick(k * 20);
    expect(m.value).toBeCloseTo(50, 3);
    m.reset();
    expect(m.value).toBe(0);
  });

  it('a throwing frame listener does not stop delivery to the others', async () => {
    const src = new ProbeSource();
    const seen: number[] = [];
    src.onFrame(() => {
      throw new Error('boom');
    });
    src.onFrame((f) => seen.push(f.t));
    const errSpy = console.error;
    console.error = () => {};
    try {
      src.push(makePoseFrame(1), 1);
      src.push(makePoseFrame(2), 2);
    } finally {
      console.error = errSpy;
    }
    expect(seen).toEqual([1, 2]);
  });
});

describe('camera retry policy', () => {
  it('retries only for device-level getUserMedia errors', () => {
    const err = (name: string) => Object.assign(new Error(name), { name });
    expect(isDeviceUnavailableError(err('OverconstrainedError'))).toBe(true);
    expect(isDeviceUnavailableError(err('NotFoundError'))).toBe(true);
    expect(isDeviceUnavailableError(err('NotReadableError'))).toBe(true);
    expect(isDeviceUnavailableError(err('NotAllowedError'))).toBe(false);
    expect(isDeviceUnavailableError(err('SecurityError'))).toBe(false);
    expect(isDeviceUnavailableError(err('TypeError'))).toBe(false);
    expect(isDeviceUnavailableError(null)).toBe(false);
    expect(isDeviceUnavailableError('NotFoundError')).toBe(false);
  });
});
