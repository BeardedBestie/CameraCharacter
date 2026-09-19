import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = resolve(process.cwd(), 'e2e/screenshots');
mkdirSync(SHOTS, { recursive: true });

interface DebugState {
  ready: boolean;
  source: { kind: string; state: string; message?: string };
  model: { name: string | null; family: string | null; bones: number; warnings: string[]; unrigged: boolean } | null;
  framesProcessed: number;
  framesSolved: number;
  present: boolean;
  framing: string;
  maxBoneErrorDeg: number | null;
  meanBoneErrorDeg: number | null;
  flaggedBones: string[];
  cameraDistance: number | null;
  errors: string[];
}

async function debugState(page: Page): Promise<DebugState> {
  return page.evaluate(() => {
    const app = (window as unknown as { cameraCharacter?: { getDebugState(): DebugState } }).cameraCharacter;
    if (!app) throw new Error('app not mounted');
    return app.getDebugState();
  });
}

async function waitFor(page: Page, pred: (s: DebugState) => boolean, timeoutMs = 60_000): Promise<DebugState> {
  const start = Date.now();
  let last: DebugState | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await debugState(page);
      if (pred(last)) return last;
    } catch {
      // app still booting
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`timeout waiting for state; last = ${JSON.stringify(last)}`);
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

const MODEL = '/models/sample-meshy.glb';

test.describe('CameraCharacter (synthetic source)', () => {
  test('loads the sample model, drives it from the synthetic walk, low bone error', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    await page.goto(`/?source=synthetic&preset=walk&model=${MODEL}&autoplay=1&diagnostics=1&camera=mirror&kiosk=1`);
    const s = await waitFor(page, (st) => st.ready && !!st.model && st.framesSolved > 60);
    expect(s.model?.unrigged).toBe(false);
    expect(s.model?.bones).toBeGreaterThan(15);
    expect(s.present).toBe(true);
    expect(s.framing).toBe('full');
    expect(s.maxBoneErrorDeg).not.toBeNull();
    expect(s.meanBoneErrorDeg!).toBeLessThan(8);
    expect(s.errors).toEqual([]);
    await page.screenshot({ path: resolve(SHOTS, 'walk-mirror.png') });
    const benign = consoleErrors.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED|net::ERR/i.test(e));
    expect(benign).toEqual([]);
  });

  test('arm raise keeps the arm chain error low in orbit camera', async ({ page }) => {
    collectConsoleErrors(page);
    await page.goto(`/?source=synthetic&preset=arm-raise&model=${MODEL}&autoplay=1&diagnostics=1&camera=orbit&kiosk=1`);
    const s = await waitFor(page, (st) => st.ready && st.framesSolved > 90);
    expect(s.meanBoneErrorDeg!).toBeLessThan(8);
    await page.screenshot({ path: resolve(SHOTS, 'arm-raise-orbit.png') });
  });

  test('approach preset moves the framing state toward a close-up and zooms the mirror camera in', async ({ page }) => {
    collectConsoleErrors(page);
    await page.goto(`/?source=synthetic&preset=approach&model=${MODEL}&autoplay=1&camera=mirror&kiosk=1&loop=0`);
    const first = await waitFor(page, (st) => st.ready && st.framesSolved > 20);
    expect(first.framing).toBe('full');
    const far = first.cameraDistance;
    const later = await waitFor(page, (st) => st.framing === 'bust' || st.framing === 'waist', 40_000);
    expect(later.cameraDistance).not.toBeNull();
    expect(later.cameraDistance!).toBeLessThan(far ?? Infinity);
    await page.screenshot({ path: resolve(SHOTS, 'approach-closeup.png') });
  });

  test('sample pack character with scrambled names maps and animates', async ({ page }) => {
    collectConsoleErrors(page);
    await page.goto(`/?source=synthetic&preset=wave&model=/models/characters/skeleton.glb&autoplay=1&diagnostics=1&camera=follow&kiosk=1`);
    const s = await waitFor(page, (st) => st.ready && !!st.model && st.framesSolved > 60);
    expect(s.model?.unrigged).toBe(false);
    expect(s.meanBoneErrorDeg!).toBeLessThan(10);
    await page.screenshot({ path: resolve(SHOTS, 'skeleton-wave.png') });
  });

  test('unrigged model is reported and does not crash', async ({ page }) => {
    collectConsoleErrors(page);
    await page.goto(`/?source=synthetic&preset=tpose&model=/models/characters/zombie_red.glb&autoplay=1&kiosk=1`);
    const s = await waitFor(page, (st) => st.ready && !!st.model);
    expect(s.model?.unrigged).toBe(true);
    expect(s.errors).toEqual([]);
  });

  test('recording playback source works with a generated take', async ({ page }) => {
    collectConsoleErrors(page);
    await page.goto(`/?source=recording&file=/recordings/squat.mocap.json&model=${MODEL}&autoplay=1&diagnostics=1&loop=1&kiosk=1`);
    const s = await waitFor(page, (st) => st.ready && st.framesSolved > 60);
    expect(s.source.kind).toBe('recording');
    expect(s.meanBoneErrorDeg!).toBeLessThan(8);
    await page.screenshot({ path: resolve(SHOTS, 'squat-recording.png') });
  });
});
