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
 * Residual scale (in units of the user's height) of the robust fit: a landmark
 * that sits `FIT_OUTLIER_H` off the fitted line keeps half its weight, one at
 * twice that a fifth. A swinging ankle or a raised knee sits far above its
 * standing proportion (and, close to the camera, perspective pushes a forward
 * foot down the image), so it must not bend the line when it enters or
 * leaves the frame.
 */
export const FIT_OUTLIER_H = 0.05;
/** Reweighting passes after the initial unweighted fit. */
const FIT_ROBUST_PASSES = 2;
/** Weight below which a point no longer counts toward the two-height-classes requirement. */
const FIT_CLASS_MIN_WEIGHT = 0.25;

/** Weighted least-squares accumulator over (h, y) pairs; reused between frames. */
const _acc = { n: 0, sw: 0, sh: 0, sy: 0, shh: 0, shy: 0, classes: 0 };
const MAX_POINTS = 64;
const _ptH = new Float64Array(MAX_POINTS);
const _ptY = new Float64Array(MAX_POINTS);
const _ptW = new Float64Array(MAX_POINTS);
const _ptCls = new Int32Array(MAX_POINTS);

function clearAcc(): void {
  const A = _acc;
  A.n = 0;
  A.sw = 0;
  A.sh = 0;
  A.sy = 0;
  A.shh = 0;
  A.shy = 0;
  A.classes = 0;
}

function accumulate(h: number, y: number, w: number, cls: number): void {
  const A = _acc;
  A.n++;
  A.sw += w;
  A.sh += w * h;
  A.sy += w * y;
  A.shh += w * h * h;
  A.shy += w * h * y;
  if (w >= FIT_CLASS_MIN_WEIGHT) A.classes |= 1 << cls;
}

function solveLine(): { a: number; b: number } | null {
  const A = _acc;
  let distinct = 0;
  for (let c = A.classes; c; c >>= 1) distinct += c & 1;
  if (A.n < 2 || distinct < 2 || A.sw < 1e-9) return null;
  const det = A.sw * A.shh - A.sh * A.sh;
  if (Math.abs(det) < 1e-12) return null;
  const a = (A.sw * A.shy - A.sh * A.sy) / det;
  const b = (A.sy - a * A.sh) / A.sw;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= -1e-6) return null; // y must decrease with height
  return { a, b };
}

/**
 * Least-squares fit of image y against proportion heights. Returns null when
 * fewer than two distinct height classes are usable. After the plain fit the
 * points are reweighted by their residual (Cauchy weights with scale
 * {@link FIT_OUTLIER_H}) and refitted, so limbs in motion do not tilt the
 * line and the span stays continuous when they enter or leave the frame.
 */
export function fitHeightLine(pose: FilteredPose): { a: number; b: number } | null {
  clearAcc();
  let count = 0;
  for (const g of GROUPS) {
    for (const i of g.indices) {
      if (!pose.gated[i] || !pose.inFrame[i] || count >= MAX_POINTS) continue;
      const y = pose.image[i].y;
      if (!Number.isFinite(y)) continue;
      _ptH[count] = g.h;
      _ptY[count] = y;
      _ptCls[count] = g.cls;
      count++;
      accumulate(g.h, y, 1, g.cls);
    }
  }
  let line = solveLine();
  if (!line) return null;
  for (let pass = 0; pass < FIT_ROBUST_PASSES; pass++) {
    const scale = FIT_OUTLIER_H * Math.abs(line.a);
    clearAcc();
    for (let k = 0; k < count; k++) {
      const r = (_ptY[k] - (line.a * _ptH[k] + line.b)) / scale;
      _ptW[k] = 1 / (1 + r * r);
      accumulate(_ptH[k], _ptY[k], _ptW[k], _ptCls[k]);
    }
    const next = solveLine();
    if (!next) break;
    line = next;
  }
  return line;
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
