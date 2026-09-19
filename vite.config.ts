import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { cpSync, existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
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

/**
 * Serves the sample model pack from the repository's models/ folder at
 * /models/characters/* and /models/weapons/* during development, and copies it
 * into dist/models on build, so the bundled samples work in both modes without
 * duplicating 50 MB of binaries under public/.
 */
function serveSampleModels(): Plugin {
  const modelsDir = resolve(root, 'models');
  const types: Record<string, string> = { '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream' };
  return {
    name: 'cameracharacter:sample-models',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/models/characters/') && !url.startsWith('/models/weapons/')) return next();
        const rel = normalize(decodeURIComponent(url.slice('/models/'.length)));
        if (rel.startsWith('..')) return next();
        const file = join(modelsDir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(modelsDir)) return;
      const dst = resolve(root, 'dist/models');
      mkdirSync(dst, { recursive: true });
      cpSync(modelsDir, dst, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [copyMediaPipeWasm(), serveSampleModels()],
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
