import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Copies the MediaPipe Tasks Vision WASM runtime from node_modules into
 * public/mediapipe/wasm so the app serves it itself (works offline, no CDN
 * dependency, correct MIME types via Vite's static file handling).
 */
function copyMediaPipeWasm(): Plugin {
  return {
    name: 'cameracharacter:copy-mediapipe-wasm',
    configResolved() {
      const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
      const dst = resolve(root, 'public/mediapipe/wasm');
      if (!existsSync(src)) return;
      mkdirSync(dst, { recursive: true });
      cpSync(src, dst, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [copyMediaPipeWasm()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
