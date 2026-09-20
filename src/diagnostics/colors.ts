/**
 * Confidence → color mapping shared by the 2D overlay, the 3D landmark
 * skeleton and the snapshot error bars. Pure.
 */

export type RGB = [number, number, number];

/** Red (0) → amber (0.5) → green (1), components in 0..1. */
export function confidenceColor(c: number, out: RGB = [0, 0, 0]): RGB {
  const t = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
  if (t < 0.5) {
    const k = t / 0.5;
    out[0] = 0.95;
    out[1] = 0.2 + 0.6 * k;
    out[2] = 0.2;
  } else {
    const k = (t - 0.5) / 0.5;
    out[0] = 0.95 - 0.75 * k;
    out[1] = 0.8 + 0.05 * k;
    out[2] = 0.2 + 0.1 * k;
  }
  return out;
}

/** CSS `rgba()` string for a confidence value. */
export function confidenceCss(c: number, alpha = 1): string {
  const [r, g, b] = confidenceColor(c);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/** Color of a per-bone error bar: grey when not confident, green when within tolerance, red when flagged. */
export function errorBarCss(errorDeg: number | null, confident: boolean, flagged: boolean): string {
  if (errorDeg === null) return 'rgba(120, 120, 130, 0.6)';
  if (!confident) return 'rgba(140, 140, 150, 0.8)';
  return flagged ? 'rgba(235, 70, 70, 0.95)' : 'rgba(70, 200, 110, 0.95)';
}

export const OVERLAY_COLORS = {
  outOfFrame: 'rgba(255, 90, 60, 0.95)',
  ungated: 'rgba(255, 255, 255, 0.55)',
  hand: 'rgba(120, 200, 255, 0.9)',
  fitLine: 'rgba(255, 220, 90, 0.9)',
  cropLine: 'rgba(255, 120, 60, 0.9)',
  text: 'rgba(255, 255, 255, 0.92)',
  textShadow: 'rgba(0, 0, 0, 0.8)',
} as const;
