import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateRecording, listSyntheticPresets } from '../src/testing/syntheticHuman';
import { MODEL_ASSETS, looksLikeTaskBundle } from '../src/tracking/mediapipeModels';
import { makeTestVideo } from './fixtures/make-video';

/**
 * Generates the fixtures the end-to-end tests load from public/:
 * - one synthetic .mocap.json take per preset (public/recordings/);
 * - a short WebM clip of a drawn figure for the import page (public/recordings/walk.webm),
 *   when Chromium and ffmpeg are available;
 * - a self-hosted copy of the lite pose model (public/models/mediapipe/), when the network allows.
 * Missing optional fixtures make the video import test skip rather than fail.
 */
export default async function globalSetup(): Promise<void> {
  const out = resolve(process.cwd(), 'public/recordings');
  mkdirSync(out, { recursive: true });
  for (const name of listSyntheticPresets()) {
    const rec = generateRecording(name, { fps: 30 });
    writeFileSync(resolve(out, `${name}.mocap.json`), JSON.stringify(rec));
  }

  try {
    await makeTestVideo({ preset: 'walk', durationSec: 3 });
  } catch (err) {
    console.warn(`[e2e setup] test video not generated: ${(err as Error).message ?? err}`);
  }

  const modelDir = resolve(process.cwd(), 'public/models/mediapipe');
  const asset = MODEL_ASSETS.pose_lite;
  const modelFile = resolve(modelDir, asset.basename);
  if (!existsSync(modelFile)) {
    try {
      const res = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!looksLikeTaskBundle(res.headers.get('content-type'), bytes)) throw new Error('not a task bundle');
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(modelFile, bytes);
    } catch (err) {
      console.warn(`[e2e setup] pose model not downloaded (${(err as Error).message ?? err}); the video import test will skip`);
    }
  }
}
