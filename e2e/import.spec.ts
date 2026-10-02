import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = resolve(process.cwd(), 'e2e/screenshots');
mkdirSync(SHOTS, { recursive: true });

interface ImportDebugState {
  ready: boolean;
  storeKind: string;
  clips: { id: string; name: string; frames: number; detectedFrames: number; hasVideo: boolean }[];
  activeClip: string | null;
  processing: { name: string; phase: string; frame: number; total: number; detected: number } | null;
  playback: { playing: boolean; timeMs: number; durationMs: number; loop: boolean } | null;
  model: { name: string | null; family: string | null; bones: number; warnings: string[]; unrigged: boolean } | null;
  framesProcessed: number;
  framesSolved: number;
  present: boolean;
  framing: string;
  maxBoneErrorDeg: number | null;
  meanBoneErrorDeg: number | null;
  cameraMode: string;
  cameraKeys: number;
  cameraPosition: [number, number, number];
  baking: boolean;
  hasTake: boolean;
  rendering: boolean;
  errors: string[];
}

type ImportWindow = Window & {
  cameraCharacterImport?: {
    getDebugState(): ImportDebugState;
    addCameraKey(): void;
    setCameraMode(mode: 'orbit' | 'follow' | 'track'): void;
    addOrbitShot(opts: { turns: number }): void;
    bake(): Promise<void>;
    importVideoUrl(url: string): Promise<void>;
    selectClip(id: string): Promise<void>;
  };
};

async function state(page: Page): Promise<ImportDebugState> {
  return page.evaluate(() => {
    const app = (window as unknown as ImportWindow).cameraCharacterImport;
    if (!app) throw new Error('import app not mounted');
    return app.getDebugState();
  });
}

async function waitFor(page: Page, pred: (s: ImportDebugState) => boolean, timeoutMs = 60_000, failOnError = true): Promise<ImportDebugState> {
  const start = Date.now();
  let last: ImportDebugState | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await state(page);
      if (pred(last)) return last;
      if (failOnError && last.errors.length) throw new Error(`app reported errors: ${last.errors.join(' | ')}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('app reported errors')) throw err;
      // booting
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`timeout waiting for import state; last = ${JSON.stringify(last)}`);
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
const TEST_VIDEO = resolve(process.cwd(), 'public/recordings/walk.webm');
const LOCAL_POSE_MODEL = resolve(process.cwd(), 'public/models/mediapipe/pose_landmarker_lite.task');

test.describe('Import page (/import/)', () => {
  test('loads a take as a clip, drives the model and plays in sync', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    await page.goto(`/import/?take=/recordings/walk.mocap.json&model=${MODEL}&kiosk=1&diagnostics=1`);
    const s = await waitFor(page, (st) => st.ready && !!st.model && st.clips.length === 1 && st.framesSolved > 60);
    expect(s.activeClip).toBe('walk.mocap.json');
    expect(s.clips[0].frames).toBeGreaterThan(100);
    expect(s.clips[0].hasVideo).toBe(false);
    expect(s.playback?.playing).toBe(true);
    expect(s.playback?.durationMs).toBeGreaterThan(1000);
    expect(s.present).toBe(true);
    expect(s.cameraMode).toBe('orbit');
    expect(s.meanBoneErrorDeg).not.toBeNull();
    expect(s.meanBoneErrorDeg!).toBeLessThan(10);
    expect(s.errors).toEqual([]);
    await page.screenshot({ path: resolve(SHOTS, 'import-take-orbit.png') });
    const benign = consoleErrors.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED|net::ERR/i.test(e));
    expect(benign).toEqual([]);
  });

  test('camera keyframes move the camera and the keyframe mode plays them', async ({ page }) => {
    collectConsoleErrors(page);
    await page.goto(`/import/?take=/recordings/arm-raise.mocap.json&model=${MODEL}&kiosk=1`);
    await waitFor(page, (st) => st.ready && !!st.model && st.framesSolved > 30);
    const before = await state(page);
    await page.evaluate(() => (window as unknown as ImportWindow).cameraCharacterImport!.addOrbitShot({ turns: 1 }));
    const after = await waitFor(page, (st) => st.cameraKeys >= 8 && st.cameraMode === 'track');
    expect(after.cameraKeys).toBeGreaterThanOrEqual(8);
    // The orbit moves the camera around the character: wait for a clearly different position.
    const moved = await waitFor(page, (st) => Math.hypot(st.cameraPosition[0] - before.cameraPosition[0], st.cameraPosition[2] - before.cameraPosition[2]) > 0.5, 20_000);
    expect(Math.hypot(moved.cameraPosition[0], moved.cameraPosition[2])).toBeGreaterThan(1);
    await page.screenshot({ path: resolve(SHOTS, 'import-camera-track.png') });
    await page.evaluate(() => (window as unknown as ImportWindow).cameraCharacterImport!.setCameraMode('orbit'));
    await page.evaluate(() => (window as unknown as ImportWindow).cameraCharacterImport!.addCameraKey());
    const s = await state(page);
    expect(s.cameraMode).toBe('orbit');
    expect(s.cameraKeys).toBeGreaterThanOrEqual(8);
    expect(s.errors).toEqual([]);
  });

  test('bakes the take offline into an animation', async ({ page }) => {
    collectConsoleErrors(page);
    await page.goto(`/import/?take=/recordings/squat.mocap.json&model=${MODEL}&kiosk=1`);
    await waitFor(page, (st) => st.ready && !!st.model && st.framesSolved > 10);
    await page.evaluate(() => (window as unknown as ImportWindow).cameraCharacterImport!.bake());
    const s = await waitFor(page, (st) => st.hasTake && !st.baking, 60_000);
    expect(s.hasTake).toBe(true);
    expect(s.errors).toEqual([]);
    // Playback resumes after baking.
    const again = await waitFor(page, (st) => st.framesSolved > s.framesSolved + 10, 20_000);
    expect(again.present).toBe(true);
  });

  test('imports a video clip: frames are decoded, analysed and stored', async ({ page }) => {
    test.skip(!existsSync(TEST_VIDEO), 'test video not generated (ffmpeg or Chromium unavailable in setup)');
    test.skip(!existsSync(LOCAL_POSE_MODEL), 'pose model not downloaded (offline setup)');
    test.setTimeout(300_000);
    const consoleErrors = collectConsoleErrors(page);
    await page.goto(`/import/?video=/recordings/walk.webm&model=${MODEL}&kiosk=1&poseModel=lite&delegate=CPU&fps=10`);
    const s = await waitFor(page, (st) => st.ready && st.clips.length === 1 && st.processing === null && st.activeClip !== null, 180_000);
    expect(s.clips[0].name).toBe('walk.webm');
    expect(s.clips[0].hasVideo).toBe(true);
    // 3 s at 10 samples/s → 30 frames (± the last-frame guard).
    expect(s.clips[0].frames).toBeGreaterThanOrEqual(28);
    expect(s.clips[0].frames).toBeLessThanOrEqual(31);
    expect(s.storeKind).toBe('indexeddb');
    // eslint-disable-next-line no-console
    console.log(`video import: ${s.clips[0].detectedFrames}/${s.clips[0].frames} frames with a detected subject`);
    const playing = await waitFor(page, (st) => (st.playback?.timeMs ?? 0) > 200 && st.framesProcessed > 3, 30_000);
    expect(playing.playback?.durationMs).toBeGreaterThan(2000);
    await page.screenshot({ path: resolve(SHOTS, 'import-video.png') });
    expect(s.errors).toEqual([]);
    const benign = consoleErrors.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED|net::ERR|GPU|WebGL|TensorFlow|INFO:|XNNPACK/i.test(e));
    expect(benign).toEqual([]);

    // The clip survives a reload (IndexedDB) and is re-activated with its video.
    await page.goto(`/import/?model=${MODEL}&kiosk=1`);
    const back = await waitFor(page, (st) => st.ready && st.clips.length === 1 && st.activeClip === 'walk.webm', 60_000);
    expect(back.clips[0].hasVideo).toBe(true);
    expect(back.clips[0].frames).toBe(s.clips[0].frames);
  });
});
