/**
 * Downloads the MediaPipe `.task` bundles into public/models/mediapipe so the
 * app serves them itself: offline use, or when the browser cannot reach
 * storage.googleapis.com (proxy, content filter). The in-browser loader
 * prefers this self-hosted copy over the download.
 *
 *   npm run fetch:models              # pose lite/full/heavy, hand, face
 *   npm run fetch:models -- full hand # a subset
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ASSETS, looksLikeTaskBundle, type ModelAssetName } from '../src/tracking/mediapipeModels';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/models/mediapipe');
const ALL: ModelAssetName[] = ['pose_lite', 'pose_full', 'pose_heavy', 'hand', 'face'];

function toName(arg: string): ModelAssetName {
  const n = arg.toLowerCase();
  const name = (n === 'lite' || n === 'full' || n === 'heavy' ? `pose_${n}` : n) as ModelAssetName;
  if (!(name in MODEL_ASSETS)) throw new Error(`unknown model "${arg}"; expected one of lite, full, heavy, hand, face`);
  return name;
}

async function fetchOne(name: ModelAssetName): Promise<void> {
  const asset = MODEL_ASSETS[name];
  const target = resolve(outDir, asset.basename);
  if (existsSync(target) && statSync(target).size > 0) {
    console.log(`${asset.basename}: already present (${(statSync(target).size / 1e6).toFixed(1)} MB)`);
    return;
  }
  console.log(`${asset.basename}: downloading ${asset.url}`);
  const res = await fetch(asset.url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok || !looksLikeTaskBundle(res.headers.get('content-type'), bytes)) {
    throw new Error(`${asset.basename}: unexpected answer (HTTP ${res.status}, ${res.headers.get('content-type') ?? 'no content-type'}, ${bytes.length} bytes)`);
  }
  writeFileSync(target, bytes);
  console.log(`${asset.basename}: saved ${(bytes.length / 1e6).toFixed(1)} MB to ${target}`);
}

const names = process.argv.slice(2).length ? process.argv.slice(2).map(toName) : ALL;
mkdirSync(outDir, { recursive: true });
for (const name of names) await fetchOne(name);
console.log(`done; the app now serves these from /models/mediapipe (see README "Troubleshooting a start-up problem")`);
