/**
 * Writes one .mocap.json recording per synthetic preset into public/recordings.
 * Usage: npx tsx scripts/gen-synthetic-mocap.ts [--fps 30] [--out public/recordings] [preset ...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateRecording, listSyntheticPresets } from '../src/testing/syntheticHuman';

const args = process.argv.slice(2);
let fps = 30;
let out = 'public/recordings';
const presets: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--fps') fps = Number(args[++i]);
  else if (a === '--out') out = args[++i];
  else presets.push(a);
}
const names = presets.length ? presets : listSyntheticPresets();
mkdirSync(resolve(out), { recursive: true });
for (const name of names) {
  const rec = generateRecording(name, { fps });
  const file = resolve(out, `${name}.mocap.json`);
  writeFileSync(file, JSON.stringify(rec));
  console.log(`${file}: ${rec.frames.length} frames`);
}
