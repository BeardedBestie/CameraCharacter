/**
 * Framing fit and degradation state machine (docs/DESIGN.md §6.4). Pure.
 *
 * Every frame, image y is fitted against the user-proportion height of the
 * in-frame gated landmarks: y_img = a * h + b (h in units of the user's
 * height, 0 = floor, 1 = head top). The frame edges then give the visible
 * body span, which selects the framing state with hysteresis.
 */
import type { FilteredPose } from '../core/pose';
import type { FramingFit, FramingState } from '../core/types';
import { USER_PROPORTIONS } from '../core/types';
import { LM } from '../tracking/landmarks';

/** Span thresholds (units of the user's height) and hysteresis parameters. */
export const FRAMING_BOUNDS = {
  /** span >= full -> 'full' */
  full: 0.85,
  /** waist <= span < full -> 'waist' */
  waist: 0.45,
  /** bust <= span < waist -> 'bust'; below -> 'face' */
  bust: 0.2,
  /** A state change needs the span beyond the boundary by this much ... */
  hysteresis: 0.05,
  /** ... for this long (seconds). */
  dwellSec: 0.4,
  /** Without a pose the last state is kept this long before 'none'. */
  absentHoldSec: 3,
  /** The visible top is clamped to this (slightly above the head). */
  maxTop: 1.05,
} as const;

interface HeightGroup {
  h: number;
  /** Distinct height class used for the >= 2 groups requirement. */
  cls: number;
  indices: readonly number[];
}

const GROUPS: readonly HeightGroup[] = [
  { h: USER_PROPORTIONS.eyes, cls: 0, indices: [LM.LEFT_EYE_INNER, LM.LEFT_EYE, LM.LEFT_EYE_OUTER, LM.RIGHT_EYE_INNER, LM.RIGHT_EYE, LM.RIGHT_EYE_OUTER] },
  { h: USER_PROPORTIONS.ears, cls: 0, indices: [LM.LEFT_EAR, LM.RIGHT_EAR] },
  { h: USER_PROPORTIONS.nose, cls: 0, indices: [LM.NOSE] },
  { h: USER_PROPORTIONS.shoulders, cls: 1, indices: [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER] },
  { h: USER_PROPORTIONS.hips, cls: 2, indices: [LM.LEFT_HIP, LM.RIGHT_HIP] },
  { h: USER_PROPORTIONS.knees, cls: 3, indices: [LM.LEFT_KNEE, LM.RIGHT_KNEE] },
  { h: USER_PROPORTIONS.ankles, cls: 4, indices: [LM.LEFT_ANKLE, LM.RIGHT_ANKLE] },
];

interface Pending {
  candidate: FramingState | null;
  forSec: number;
}

/** Hysteresis bookkeeping attached to the fit objects this module returns. */
const pendingByFit = new WeakMap<FramingFit, Pending>();

export function emptyFramingFit(state: FramingState = 'none'): FramingFit {
  return { a: 0, b: 0, valid: false, visibleTop: 0, visibleBottom: 0, span: 0, state };
}

/** Raw state for a span, without hysteresis. */
export function stateForSpan(span: number): FramingState {
  if (span >= FRAMING_BOUNDS.full) return 'full';
  if (span >= FRAMING_BOUNDS.waist) return 'waist';
  if (span >= FRAMING_BOUNDS.bust) return 'bust';
  return 'face';
}

/** Lower and upper span limits of a state (Infinity / -Infinity when open). */
function bandOf(state: FramingState): [number, number] {
  switch (state) {
    case 'full':
      return [FRAMING_BOUNDS.full, Infinity];
    case 'waist':
      return [FRAMING_BOUNDS.waist, FRAMING_BOUNDS.full];
    case 'bust':
      return [FRAMING_BOUNDS.bust, FRAMING_BOUNDS.waist];
    case 'face':
      return [-Infinity, FRAMING_BOUNDS.bust];
    default:
      return [-Infinity, -Infinity];
  }
}

/**
 * Least-squares fit of image y against proportion heights. Returns null when
 * fewer than two distinct height classes are usable.
 */
export function fitHeightLine(pose: FilteredPose): { a: number; b: number } | null {
  let n = 0;
  let sh = 0;
  let sy = 0;
  let shh = 0;
  let shy = 0;
  let classes = 0;
  for (const g of GROUPS) {
    let used = false;
    for (const i of g.indices) {
      if (!pose.gated[i] || !pose.inFrame[i]) continue;
      const y = pose.image[i].y;
      if (!Number.isFinite(y)) continue;
      n++;
      sh += g.h;
      sy += y;
      shh += g.h * g.h;
      shy += g.h * y;
      used = true;
    }
    if (used) classes |= 1 << g.cls;
  }
  let distinct = 0;
  for (let c = classes; c; c >>= 1) distinct += c & 1;
  if (n < 2 || distinct < 2) return null;
  const det = n * shh - sh * sh;
  if (Math.abs(det) < 1e-9) return null;
  const a = (n * shy - sh * sy) / det;
  const b = (sy - a * sh) / n;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= -1e-6) return null; // y must decrease with height
  return { a, b };
}

/**
 * Fits the framing for one frame and advances the state machine.
 * `prev` is the fit returned for the previous frame (or null), `dt` seconds.
 */
export function fitFraming(pose: FilteredPose, prev: FramingFit | null, dt: number): FramingFit {
  const prevPending = prev ? pendingByFit.get(prev) : undefined;
  const pending: Pending = { candidate: prevPending?.candidate ?? null, forSec: prevPending?.forSec ?? 0 };
  const prevState: FramingState = prev?.state ?? 'none';
  const faceTracked = pose.face !== null && pose.face !== undefined;

  let out: FramingFit;
  if (!pose.present) {
    // No pose: keep the last fit and state for a while, unless a face carries on.
    out = prev ? { ...prev } : emptyFramingFit('none');
    if (faceTracked) out.state = 'face';
    else if (pose.absentFor > FRAMING_BOUNDS.absentHoldSec || !prev) out.state = 'none';
    pendingByFit.set(out, { candidate: null, forSec: 0 });
    return out;
  }

  const line = fitHeightLine(pose);
  if (line) {
    const top = Math.min(FRAMING_BOUNDS.maxTop, (0 - line.b) / line.a);
    const bottom = Math.max(0, (1 - line.b) / line.a);
    out = { a: line.a, b: line.b, valid: true, visibleTop: top, visibleBottom: bottom, span: Math.max(0, top - bottom), state: prevState };
  } else if (prev && prev.valid) {
    out = { ...prev };
  } else {
    // A pose without a usable fit: treat as a close-up when a face is tracked, else unknown span.
    out = emptyFramingFit(faceTracked ? 'face' : prevState === 'none' ? 'bust' : prevState);
    pendingByFit.set(out, { candidate: null, forSec: 0 });
    return out;
  }

  // State machine with hysteresis: the span must leave the current band by
  // `hysteresis` for `dwellSec` before the state changes.
  const raw = stateForSpan(out.span);
  const current: FramingState = prevState === 'none' ? raw : prevState;
  if (prevState === 'none') {
    out.state = raw;
    pending.candidate = null;
    pending.forSec = 0;
  } else if (raw === current) {
    out.state = current;
    pending.candidate = null;
    pending.forSec = 0;
  } else {
    const [lo, hi] = bandOf(current);
    const outside = out.span < lo - FRAMING_BOUNDS.hysteresis || out.span >= hi + FRAMING_BOUNDS.hysteresis;
    if (!outside) {
      out.state = current;
      pending.candidate = null;
      pending.forSec = 0;
    } else {
      if (pending.candidate === raw) pending.forSec += dt;
      else {
        pending.candidate = raw;
        pending.forSec = dt;
      }
      if (pending.forSec >= FRAMING_BOUNDS.dwellSec) {
        out.state = raw;
        pending.candidate = null;
        pending.forSec = 0;
      } else {
        out.state = current;
      }
    }
  }
  pendingByFit.set(out, pending);
  return out;
}
