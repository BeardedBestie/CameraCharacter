/**
 * Renders a test clip for the import page: a cartoon figure drawn from the
 * synthetic human's image landmarks (so the motion is known), rasterized in
 * headless Chromium frame by frame and encoded with ffmpeg as VP9/WebM (the
 * open-source Chromium that Playwright ships has no H.264 decoder).
 * Writes public/recordings/<preset>.webm. Used by the Playwright global setup;
 * also runnable directly: npx tsx e2e/fixtures/make-video.ts walk 3
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import type { PoseFrame } from '../../src/core/types';
import { generateRecording } from '../../src/testing/syntheticHuman';

export interface MakeVideoOptions {
  preset?: string;
  durationSec?: number;
  fps?: number;
  width?: number;
  height?: number;
  out?: string;
  force?: boolean;
}

/**
 * Draws one frame onto a canvas from normalized image landmarks. Plain
 * JavaScript source (not a TS function) because it runs inside the page and
 * tsx/esbuild would otherwise inject `__name` helpers into a stringified
 * function.
 */
const DRAW_JS = String.raw`
function drawFigure(canvas, image, w, h) {
  const ctx = canvas.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#dfe6ee');
  sky.addColorStop(1, '#b9c2cc');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#8d9096';
  ctx.fillRect(0, h * 0.86, w, h * 0.14);
  if (!image) return;
  const P = image.map(function (l) { return [l[0] * w, l[1] * h]; });
  function line(a, b, width, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(P[a][0], P[a][1]);
    ctx.lineTo(P[b][0], P[b][1]);
    ctx.stroke();
  }
  function dot(x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const unit = Math.hypot(P[11][0] - P[12][0], P[11][1] - P[12][1]) || 40;
  const skin = '#e0b088';
  const shirt = '#3b6fd1';
  const pants = '#2f3542';
  const shoes = '#1b1d22';
  line(23, 25, unit * 0.42, pants);
  line(25, 27, unit * 0.36, pants);
  line(24, 26, unit * 0.42, pants);
  line(26, 28, unit * 0.36, pants);
  line(27, 31, unit * 0.3, shoes);
  line(28, 32, unit * 0.3, shoes);
  line(29, 31, unit * 0.3, shoes);
  line(30, 32, unit * 0.3, shoes);
  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.moveTo(P[11][0], P[11][1]);
  ctx.lineTo(P[12][0], P[12][1]);
  ctx.lineTo(P[24][0], P[24][1]);
  ctx.lineTo(P[23][0], P[23][1]);
  ctx.closePath();
  ctx.fill();
  line(11, 12, unit * 0.35, shirt);
  line(23, 24, unit * 0.45, pants);
  line(11, 13, unit * 0.3, shirt);
  line(12, 14, unit * 0.3, shirt);
  line(13, 15, unit * 0.24, skin);
  line(14, 16, unit * 0.24, skin);
  dot(P[15][0], P[15][1], unit * 0.16, skin);
  dot(P[16][0], P[16][1], unit * 0.16, skin);
  dot((P[17][0] + P[19][0]) / 2, (P[17][1] + P[19][1]) / 2, unit * 0.13, skin);
  dot((P[18][0] + P[20][0]) / 2, (P[18][1] + P[20][1]) / 2, unit * 0.13, skin);
  const neckX = (P[11][0] + P[12][0]) / 2;
  const neckY = (P[11][1] + P[12][1]) / 2;
  const earMidX = (P[7][0] + P[8][0]) / 2;
  const earMidY = (P[7][1] + P[8][1]) / 2;
  ctx.strokeStyle = skin;
  ctx.lineWidth = unit * 0.22;
  ctx.beginPath();
  ctx.moveTo(neckX, neckY);
  ctx.lineTo(earMidX, earMidY + unit * 0.1);
  ctx.stroke();
  const headR = Math.max(Math.hypot(P[7][0] - P[8][0], P[7][1] - P[8][1]) * 0.75, unit * 0.3);
  dot(earMidX, earMidY, headR, skin);
  ctx.fillStyle = '#4a2f1a';
  ctx.beginPath();
  ctx.arc(earMidX, earMidY, headR, Math.PI, 2 * Math.PI);
  ctx.fill();
  dot(P[2][0], P[2][1], headR * 0.11, '#ffffff');
  dot(P[5][0], P[5][1], headR * 0.11, '#ffffff');
  dot(P[2][0], P[2][1], headR * 0.06, '#222');
  dot(P[5][0], P[5][1], headR * 0.06, '#222');
  dot(P[0][0], P[0][1], headR * 0.08, '#c98a60');
  ctx.strokeStyle = '#8a4a3a';
  ctx.lineWidth = Math.max(1.5, headR * 0.06);
  ctx.beginPath();
  ctx.moveTo(P[9][0], P[9][1]);
  ctx.lineTo(P[10][0], P[10][1]);
  ctx.stroke();
}
window.__draw = drawFigure;
`;

export async function makeTestVideo(opts: MakeVideoOptions = {}): Promise<string> {
  const preset = opts.preset ?? 'walk';
  const fps = opts.fps ?? 30;
  const durationSec = opts.durationSec ?? 3;
  const width = opts.width ?? 640;
  const height = opts.height ?? 360;
  const out = resolve(opts.out ?? `public/recordings/${preset}.webm`);
  if (existsSync(out) && !opts.force) return out;
  mkdirSync(resolve(out, '..'), { recursive: true });
  const rec = generateRecording(preset, { fps, durationSec });
  const dir = mkdtempSync(join(tmpdir(), 'cc-video-'));
  const executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(`<canvas id="c" width="${width}" height="${height}"></canvas>`);
    await page.addScriptTag({ content: DRAW_JS });
    for (let i = 0; i < rec.frames.length; i++) {
      const frame: PoseFrame = rec.frames[i];
      const image = frame.pose ? frame.pose.image.map((l) => [l[0], l[1]]) : null;
      const dataUrl: string = await page.evaluate(
        ([img, w, h]) => {
          const canvas = document.getElementById('c') as HTMLCanvasElement;
          (window as unknown as { __draw: (c: HTMLCanvasElement, i: number[][] | null, w: number, h: number) => void }).__draw(canvas, img as number[][] | null, w as number, h as number);
          return canvas.toDataURL('image/png');
        },
        [image, width, height] as const,
      );
      writeFileSync(join(dir, `frame-${String(i).padStart(4, '0')}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
  } finally {
    await browser.close();
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, 'frame-%04d.png'), '-c:v', 'libvpx-vp9', '-b:v', '1M', '-pix_fmt', 'yuv420p', out], { stdio: 'inherit' });
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const invokedDirectly = process.argv[1] && /make-video\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  const preset = process.argv[2] ?? 'walk';
  const durationSec = Number(process.argv[3] ?? 3);
  makeTestVideo({ preset, durationSec, force: true })
    .then((file) => console.log(`wrote ${file}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
