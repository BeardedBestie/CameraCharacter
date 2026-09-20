/**
 * Landmark overlay for the webcam picture-in-picture (docs/DESIGN.md §12).
 *
 * The overlay canvas sits on top of the (possibly CSS-flipped) video element
 * and is sized to its own CSS box, devicePixelRatio aware. The video is shown
 * with `object-fit: contain`, so the frame is letterboxed inside the box; the
 * same rectangle is computed here (`containRect`) so normalized landmark
 * coordinates land on the video pixels.
 *
 * Mirror handling. Mirror mode is a pipeline step (§3): MediaPipe runs on the
 * un-flipped frame, `PoseFilter` maps image x -> 1 - x when `pose.mirror` is
 * true, and the preview <video> is CSS-flipped when `previewMirrored` is true.
 * The overlay canvas itself is never flipped. Therefore a landmark lands on
 * the person when
 *
 *     x' = (previewMirrored !== pose.mirror) ? 1 - x : x
 *
 * (both flipped: the data already matches the flipped preview; only the
 * preview flipped: undo it for the raw data; only the data flipped: undo it
 * for the raw preview).
 */
import type { FilteredPose, HandPose } from '../core/pose';
import type { FramingFit } from '../core/types';
import { HAND_CONNECTIONS, HAND_LANDMARK_COUNT, POSE_CONNECTIONS, POSE_LANDMARK_COUNT } from '../tracking/landmarks';
import { OVERLAY_COLORS, confidenceCss } from './colors';

export interface OverlayDrawInput {
  pose: FilteredPose | null;
  fit: FramingFit | null;
  /** Native size of the video frame in pixels (letterboxing is computed from its aspect). */
  videoWidth: number;
  videoHeight: number;
  /** True when the preview <video> is CSS-flipped (mirror mode). */
  previewMirrored: boolean;
  /** Draw the framing fit (two crop lines and the state). Default false. */
  showFit?: boolean;
}

export interface ContainRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rectangle of a `width x height` picture fitted into a `boxW x boxH` box with
 * `object-fit: contain` (centered, letterboxed). Degenerate inputs fill the box.
 */
export function containRect(boxW: number, boxH: number, width: number, height: number): ContainRect {
  if (!(boxW > 0) || !(boxH > 0)) return { x: 0, y: 0, width: Math.max(0, boxW), height: Math.max(0, boxH) };
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0, width: boxW, height: boxH };
  const scale = Math.min(boxW / width, boxH / height);
  const w = width * scale;
  const h = height * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, width: w, height: h };
}

/** Horizontal flip decision shared by the overlay and the snapshot compositor. */
export function overlayFlipsX(previewMirrored: boolean, poseMirrored: boolean): boolean {
  return previewMirrored !== poseMirrored;
}

export class Overlay2D {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Last letterbox rectangle in canvas pixels (for compositing the video into a snapshot). */
  private lastRect: ContainRect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Overlay2D: 2D canvas context unavailable');
    this.ctx = ctx;
  }

  /** The letterbox rectangle used by the last draw, in canvas pixels. */
  get videoRect(): ContainRect {
    return this.lastRect;
  }

  /**
   * Sizes the backing store to the CSS box times devicePixelRatio. Returns
   * false when the canvas has no layout size (hidden), in which case nothing
   * should be drawn.
   */
  private resize(): boolean {
    const canvas = this.canvas;
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const rect = canvas.getBoundingClientRect();
    let cssW = rect.width;
    let cssH = rect.height;
    if (!(cssW > 0) || !(cssH > 0)) {
      cssW = canvas.clientWidth;
      cssH = canvas.clientHeight;
    }
    if (!(cssW > 0) || !(cssH > 0)) return false;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return true;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(input: OverlayDrawInput): void {
    if (!this.resize()) return;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const rect = containRect(W, H, input.videoWidth, input.videoHeight);
    this.lastRect = rect;
    const pose = input.pose;
    const flip = overlayFlipsX(input.previewMirrored, pose?.mirror ?? input.previewMirrored);
    const px = (x: number) => rect.x + (flip ? 1 - x : x) * rect.width;
    const py = (y: number) => rect.y + y * rect.height;
    // Stroke widths and marker radii scale with the rendered frame so the overlay reads at any PiP size.
    const unit = Math.max(1, Math.min(rect.width, rect.height) / 240);

    if (pose && pose.present && pose.image.length >= POSE_LANDMARK_COUNT) {
      this.drawPose(pose, px, py, unit);
      if (pose.hands.left) this.drawHand(pose.hands.left, px, py, unit);
      if (pose.hands.right) this.drawHand(pose.hands.right, px, py, unit);
    }
    if (input.showFit && input.fit) this.drawFit(input.fit, rect, py, unit);
  }

  private drawPose(pose: FilteredPose, px: (x: number) => number, py: (y: number) => number, unit: number): void {
    const ctx = this.ctx;
    const img = pose.image;
    const ok = (i: number): boolean => {
      const p = img[i];
      return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
    };
    const live = (i: number): boolean => pose.gated[i] && pose.inFrame[i];

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [a, b] of POSE_CONNECTIONS) {
      if (!ok(a) || !ok(b)) continue;
      const both = live(a) && live(b);
      const c = Math.min(pose.confidence[a] ?? 0, pose.confidence[b] ?? 0);
      ctx.strokeStyle = both ? confidenceCss(c, 0.9) : OVERLAY_COLORS.ungated;
      ctx.lineWidth = (both ? 2.2 : 1.2) * unit;
      if (!both) ctx.setLineDash([4 * unit, 4 * unit]);
      ctx.beginPath();
      ctx.moveTo(px(img[a].x), py(img[a].y));
      ctx.lineTo(px(img[b].x), py(img[b].y));
      ctx.stroke();
      if (!both) ctx.setLineDash([]);
    }

    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      if (!ok(i)) continue;
      const x = px(img[i].x);
      const y = py(img[i].y);
      const c = pose.confidence[i] ?? 0;
      const r = (i === 0 ? 4 : i <= 10 ? 2.2 : 3.4) * unit;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (live(i)) {
        ctx.fillStyle = confidenceCss(c, 0.95);
        ctx.fill();
      } else {
        // Hollow marker: gate closed or landmark outside the frame (drawn at the edge-clamped position).
        ctx.lineWidth = 1.5 * unit;
        ctx.strokeStyle = pose.inFrame[i] ? OVERLAY_COLORS.ungated : OVERLAY_COLORS.outOfFrame;
        ctx.stroke();
      }
    }
  }

  private drawHand(hand: HandPose, px: (x: number) => number, py: (y: number) => number, unit: number): void {
    const ctx = this.ctx;
    const pts = hand.image;
    if (!pts || pts.length < HAND_LANDMARK_COUNT) return;
    const alpha = 0.35 + 0.6 * Math.max(0, Math.min(1, hand.score));
    ctx.strokeStyle = OVERLAY_COLORS.hand;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.4 * unit;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = pts[a];
      const pb = pts[b];
      if (!pa || !pb || !Number.isFinite(pa.x) || !Number.isFinite(pa.y) || !Number.isFinite(pb.x) || !Number.isFinite(pb.y)) continue;
      ctx.moveTo(px(pa.x), py(pa.y));
      ctx.lineTo(px(pb.x), py(pb.y));
    }
    ctx.stroke();
    ctx.fillStyle = OVERLAY_COLORS.hand;
    for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
      const p = pts[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      ctx.beginPath();
      ctx.arc(px(p.x), py(p.y), 1.6 * unit, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Framing fit: `y_img = a·h + b`. The visible span [visibleBottom,
   * visibleTop] (height units) maps through the fit to two horizontal crop
   * lines; the state and span are labelled next to the top line.
   */
  private drawFit(fit: FramingFit, rect: ContainRect, py: (y: number) => number, unit: number): void {
    const ctx = this.ctx;
    const fontPx = Math.max(10, Math.round(11 * unit));
    ctx.font = `${fontPx}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    const label = `${fit.state}${fit.valid ? ` · span ${fit.span.toFixed(2)} H` : ' · no fit'}`;
    const drawText = (text: string, x: number, y: number) => {
      ctx.fillStyle = OVERLAY_COLORS.textShadow;
      ctx.fillText(text, x + 1, y + 1);
      ctx.fillStyle = OVERLAY_COLORS.text;
      ctx.fillText(text, x, y);
    };
    if (!fit.valid || !Number.isFinite(fit.a) || !Number.isFinite(fit.b)) {
      drawText(label, rect.x + 6 * unit, rect.y + fontPx + 4 * unit);
      return;
    }
    const lines: { h: number; name: string }[] = [
      { h: fit.visibleTop, name: 'top' },
      { h: fit.visibleBottom, name: 'bottom' },
    ];
    ctx.lineWidth = 1.5 * unit;
    ctx.setLineDash([6 * unit, 4 * unit]);
    for (const { h, name } of lines) {
      const yNorm = fit.a * h + fit.b;
      if (!Number.isFinite(yNorm)) continue;
      // A crop line at the frame edge is the interesting case; keep it just inside the frame so it stays visible.
      const yClamped = Math.min(1, Math.max(0, yNorm));
      const y = Math.min(rect.y + rect.height - ctx.lineWidth, Math.max(rect.y + ctx.lineWidth, py(yClamped)));
      ctx.strokeStyle = yNorm < 0 || yNorm > 1 ? OVERLAY_COLORS.cropLine : OVERLAY_COLORS.fitLine;
      ctx.beginPath();
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.width, y);
      ctx.stroke();
      const text = `${name} h=${h.toFixed(2)}`;
      const ty = name === 'top' ? y + fontPx + 2 * unit : y - 2 * unit;
      drawText(text, rect.x + 6 * unit, ty);
    }
    ctx.setLineDash([]);
    drawText(label, rect.x + 6 * unit, rect.y + rect.height - 4 * unit);
  }
}
