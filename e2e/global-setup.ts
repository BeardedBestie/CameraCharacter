import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateRecording, listSyntheticPresets } from '../src/testing/syntheticHuman';

/** Generates the synthetic .mocap.json takes the end-to-end tests load from public/recordings. */
export default function globalSetup(): void {
  const out = resolve(process.cwd(), 'public/recordings');
  mkdirSync(out, { recursive: true });
  for (const name of listSyntheticPresets()) {
    const rec = generateRecording(name, { fps: 30 });
    writeFileSync(resolve(out, `${name}.mocap.json`), JSON.stringify(rec));
  }
}
