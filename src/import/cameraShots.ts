/**
 * Camera shot presets for the import page (docs/DESIGN.md §17.4): framed from
 * the rig's height table so "front", "three-quarter", "close-up" fit any
 * character height. Pure three.js math.
 */
import { Vector3 } from 'three';
import { DEG2RAD } from '../core/math';
import type { HeightTable } from '../core/types';
import { distanceForSpan, sanitizeHeightTable } from '../stage/MirrorCamera';

export type ShotName = 'front' | 'threeQuarterLeft' | 'threeQuarterRight' | 'sideLeft' | 'sideRight' | 'back' | 'closeUp' | 'low' | 'high';

export const SHOT_LABELS: Record<ShotName, string> = {
  front: 'Front',
  threeQuarterLeft: '¾ left',
  threeQuarterRight: '¾ right',
  sideLeft: 'Side (left)',
  sideRight: 'Side (right)',
  back: 'Back',
  closeUp: 'Close-up',
  low: 'Low angle',
  high: 'High angle',
};

export const SHOT_NAMES: readonly ShotName[] = ['front', 'threeQuarterLeft', 'threeQuarterRight', 'sideLeft', 'sideRight', 'back', 'closeUp', 'low', 'high'];

export interface Shot {
  position: Vector3;
  target: Vector3;
  fov: number;
}

export interface ShotOptions {
  /** Vertical FOV in degrees (default 35). */
  fov?: number;
  /** Headroom multiplier on the framed span (default 1.15). */
  margin?: number;
  /** Where the character stands. */
  origin?: Vector3;
}

/** Yaw about +Y (degrees) of the camera position around the character: 0 = in front (+Z), 90 = at the character's left (+X). */
const SHOT_YAW: Record<ShotName, number> = {
  front: 0,
  threeQuarterLeft: 35,
  threeQuarterRight: -35,
  sideLeft: 90,
  sideRight: -90,
  back: 180,
  closeUp: 0,
  low: 20,
  high: -20,
};

/**
 * Camera placement for a shot. Full-body shots frame floor-to-head with
 * headroom; the close-up frames hips-to-head-top; low/high angles pitch the
 * camera while keeping the character framed.
 */
export function shotFor(name: ShotName, table: HeightTable, opts: ShotOptions = {}): Shot {
  const t = sanitizeHeightTable(table);
  const fov = opts.fov ?? 35;
  const margin = opts.margin ?? 1.15;
  const origin = opts.origin ?? new Vector3();
  const height = t.headTop - t.floor;
  let bottom = t.floor;
  let top = t.headTop;
  if (name === 'closeUp') {
    bottom = t.hips + 0.5 * (t.shoulders - t.hips);
    top = t.headTop + 0.05 * height;
  }
  const span = Math.max(top - bottom, 0.1);
  const distance = distanceForSpan(span, fov, margin);
  const targetY = 0.5 * (bottom + top);
  const yaw = SHOT_YAW[name] * DEG2RAD;
  let camY = targetY;
  let horizontal = distance;
  if (name === 'low') {
    camY = t.floor + 0.25 * height;
    horizontal = Math.sqrt(Math.max(distance * distance - (targetY - camY) ** 2, 0.25));
  } else if (name === 'high') {
    camY = t.headTop + 0.6 * height;
    horizontal = Math.sqrt(Math.max(distance * distance - (camY - targetY) ** 2, 0.25));
  }
  const position = new Vector3(origin.x + Math.sin(yaw) * horizontal, origin.y + camY, origin.z + Math.cos(yaw) * horizontal);
  const target = new Vector3(origin.x, origin.y + targetY, origin.z);
  return { position, target, fov };
}
