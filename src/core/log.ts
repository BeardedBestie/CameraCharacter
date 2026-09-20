/**
 * Console diagnostics. Every line is prefixed with `[cameracharacter +s.sss]`
 * (seconds since the module loaded) so it can be filtered in the browser's
 * devtools. Boot logging covers the build, the settings, WebGL, the model, the
 * source and the camera, so a failed start can be diagnosed from the console
 * alone. Works in Node too (tests, scripts); there it only prints.
 */

/** Commit, branch and build time baked in by Vite; "unknown" outside a Vite build. */
export const BUILD_INFO = {
  commit: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'unknown',
  branch: typeof __APP_BRANCH__ === 'string' ? __APP_BRANCH__ : 'unknown',
  builtAt: typeof __APP_BUILD_TIME__ === 'string' ? __APP_BUILD_TIME__ : 'unknown',
};

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const t0 = now();

function prefix(): string {
  return `[cameracharacter +${((now() - t0) / 1000).toFixed(3)}s]`;
}

export const log = {
  info(message: string, ...data: unknown[]): void {
    console.info(`${prefix()} ${message}`, ...data);
  },
  warn(message: string, ...data: unknown[]): void {
    console.warn(`${prefix()} ${message}`, ...data);
  },
  error(message: string, ...data: unknown[]): void {
    console.error(`${prefix()} ${message}`, ...data);
  },
};
