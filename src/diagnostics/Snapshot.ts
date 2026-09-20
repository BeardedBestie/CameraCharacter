/**
 * Diagnostic snapshot (docs/DESIGN.md §7.4): a JSON bundle that a human or an
 * LLM can read, and a composite PNG (webcam frame with landmarks | 3D view |
 * per-bone error bars).
 *
 * `buildDiagnosticsJson` is pure (Node-safe). `captureSnapshot` needs a
 * browser: it composites canvases and reads the WebGL view back by calling
 * `renderer.render()` and `drawImage()` synchronously in the same task, so the
 * renderer does not need `preserveDrawingBuffer`.
 */
import type { Camera, Scene, WebGLRenderer } from 'three';
import type { FilteredPose } from '../core/pose';
import type { AppSettings, FramingFit, HumanoidBone, RigAnalysis, RigProfile } from '../core/types';
import { HUMANOID_BONES } from '../core/types';
import { RAD2DEG } from '../core/math';
import type { BodyModelResult, MeasuredBasis } from '../retarget/bodyModel';
import { referenceBasisFor } from '../retarget/calibration';
import type { SolveResult } from '../retarget/solver';
import { POSE_LANDMARK_NAMES } from '../tracking/landmarks';
import { summarize, flaggedRoles } from './BoneError';
import { errorBarCss } from './colors';
import { containRect, type Overlay2D } from './Overlay2D';
import type { LandmarkSkeleton3D } from './LandmarkSkeleton3D';
import { CHAIN_NAMES, FLAG_CONFIDENCE, FLAG_ERROR_DEG, type BoneErrorSummary } from './types';
import { libraryVersions } from './versions';

export const DIAGNOSTICS_FORMAT = 'cameracharacter-diagnostics';
export const DIAGNOSTICS_VERSION = 1;
export const SNAPSHOT_PREFIX = 'cameracharacter-snapshot';

export interface DiagnosticsJsonInput {
  analysis: RigAnalysis | null;
  profile: RigProfile | null;
  pose: FilteredPose | null;
  body: BodyModelResult | null;
  solve: SolveResult | null;
  framing: FramingFit | null;
  settings: AppSettings;
  mirror: boolean;
  sourceKind: string;
  /** Free-form additions (source status, frame counters, errors, ...). */
  extra?: Record<string, unknown>;
  /** Timestamp override for deterministic output (defaults to now). */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isVector3Like(v: unknown): v is { x: number; y: number; z: number } {
  return typeof v === 'object' && v !== null && (v as { isVector3?: boolean }).isVector3 === true;
}

function isQuaternionLike(v: unknown): v is { x: number; y: number; z: number; w: number } {
  return typeof v === 'object' && v !== null && (v as { isQuaternion?: boolean }).isQuaternion === true;
}

function num(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

/**
 * Converts any value into plain JSON: three.js Vector3 -> [x, y, z],
 * Quaternion -> [x, y, z, w], typed arrays -> arrays, NaN/±Infinity -> null,
 * undefined -> null, functions dropped. Key order is preserved unless
 * `sortKeys` is set, in which case plain objects get alphabetical keys.
 */
export function toJsonValue(value: unknown, sortKeys = false, depth = 0): Json {
  if (depth > 64) return null;
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'number':
      return num(value);
    case 'boolean':
    case 'string':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return null;
    default:
      break;
  }
  if (isQuaternionLike(value)) return [num(value.x), num(value.y), num(value.z), num(value.w)];
  if (isVector3Like(value)) return [num(value.x), num(value.y), num(value.z)];
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>, (x) => num(x));
  }
  if (Array.isArray(value)) return value.map((x) => toJsonValue(x, sortKeys, depth + 1));
  if (value instanceof Map) {
    const out: { [k: string]: Json } = {};
    const entries = Array.from(value.entries()).map(([k, v]) => [String(k), v] as const);
    if (sortKeys) entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [k, v] of entries) out[k] = toJsonValue(v, sortKeys, depth + 1);
    return out;
  }
  if (value instanceof Set) return Array.from(value, (x) => toJsonValue(x, sortKeys, depth + 1));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (sortKeys) keys.sort();
    const out: { [k: string]: Json } = {};
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'function' || typeof v === 'symbol') continue;
      out[k] = toJsonValue(v, sortKeys, depth + 1);
    }
    return out;
  }
  return null;
}

/** Roles of `record` in canonical HUMANOID_BONES order (stable regardless of insertion order). */
function orderedRoles<T>(record: Partial<Record<HumanoidBone, T>>): HumanoidBone[] {
  return HUMANOID_BONES.filter((b) => record[b] !== undefined);
}

function basisJson(b: MeasuredBasis): Json {
  return { d: toJsonValue(b.d), u: toJsonValue(b.u), c: num(b.c), cU: num(b.cU), source: b.source };
}

function poseJson(pose: FilteredPose | null): Json {
  if (!pose) return null;
  const landmarks: Json[] = [];
  for (let i = 0; i < pose.world.length; i++) {
    landmarks.push({
      index: i,
      name: POSE_LANDMARK_NAMES[i] ?? `landmark_${i}`,
      world: toJsonValue(pose.world[i]),
      image: toJsonValue(pose.image[i]),
      visibility: num(pose.visibility[i] ?? NaN),
      inFrame: !!pose.inFrame[i],
      gated: !!pose.gated[i],
      confidence: num(pose.confidence[i] ?? NaN),
    });
  }
  const hand = (h: FilteredPose['hands']['left']): Json => (h ? { present: true, score: num(h.score), points: h.image.length } : null);
  return {
    present: pose.present,
    t: num(pose.t),
    now: num(pose.now),
    absentFor: num(pose.absentFor),
    reacquireRamp: num(pose.reacquireRamp),
    size: toJsonValue(pose.size),
    mirror: pose.mirror,
    hands: { left: hand(pose.hands.left), right: hand(pose.hands.right) },
    face: pose.face
      ? { present: true, rotation: toJsonValue(pose.face.rotation), blendshapeCount: Object.keys(pose.face.blendshapes).length }
      : null,
    landmarks,
  };
}

function bodyJson(body: BodyModelResult | null): Json {
  if (!body) return null;
  const bases: { [k: string]: Json } = {};
  for (const role of orderedRoles(body.bases)) bases[role] = basisJson(body.bases[role]!);
  const bendAnglesDeg: { [k: string]: Json } = {};
  for (const role of orderedRoles(body.bendAngles)) bendAnglesDeg[role] = num(body.bendAngles[role]! * RAD2DEG);
  return {
    torso: { hips: basisJson(body.torso.hips), shoulders: basisJson(body.torso.shoulders) },
    hipsConfidence: num(body.hipsConfidence),
    hipsLost: body.hipsLost,
    segmentLengths: toJsonValue(body.segmentLengths, true),
    bendAnglesDeg,
    bases,
  };
}

function solveJson(solve: SolveResult | null, analysis: RigAnalysis | null, profile: RigProfile | null): Json {
  if (!solve) return null;
  const summary = summarize(solve, analysis);
  const perRole: { [k: string]: Json } = {};
  const calibration = profile?.calibration ?? null;
  for (const role of orderedRoles(solve.perRole)) {
    const r = solve.perRole[role]!;
    let reference: Json = null;
    if (analysis) {
      const roll = profile?.bones[role]?.rollOffsetDeg ?? analysis.defaultBones[role]?.rollOffsetDeg ?? 0;
      const ref = referenceBasisFor(role, r.mode, analysis, calibration, roll);
      if (ref) reference = { d: toJsonValue(ref.d), u: toJsonValue(ref.u) };
    }
    perRole[role] = {
      bone: analysis?.map[role] ?? null,
      mode: r.mode,
      source: r.source,
      confidence: num(r.confidence),
      cU: num(r.cU),
      measuredDir: toJsonValue(r.measuredDir),
      solvedDir: toJsonValue(r.solvedDir),
      errorDeg: num(r.errorDeg ?? NaN),
      reference,
      worldQuat: toJsonValue(r.worldQuat),
      localQuat: toJsonValue(r.localQuat),
    };
  }
  const chainErrorDeg: { [k: string]: Json } = {};
  for (const name of CHAIN_NAMES) chainErrorDeg[name] = num(solve.chainErrorDeg[name] ?? NaN);
  return {
    framing: solve.framing,
    depthZ: num(solve.depthZ ?? NaN),
    hipsWorldPos: toJsonValue(solve.hipsWorldPos),
    roles: [...solve.roles],
    perRole,
    chainErrorDeg,
    summary: {
      maxErrorDeg: num(summary.maxErrorDeg ?? NaN),
      meanErrorDeg: num(summary.meanErrorDeg ?? NaN),
      worst: summary.worst,
      ok: summary.ok,
      flagged: flaggedRoles(summary),
      thresholds: { errorDeg: FLAG_ERROR_DEG, confidence: FLAG_CONFIDENCE },
    },
  };
}

/**
 * The diagnostic bundle as a JSON string (2-space indented). Sections, in
 * order: format/version/createdAt, library versions, source (kind, mirror,
 * video size), settings, rig analysis, profile (user diff), filtered pose
 * (with hand/face presence), measured bases (d, u, c, cU, source), solve
 * (reference modes and bases, measured and solved directions, per-bone and
 * per-chain error, summary), framing fit, extra. Role-keyed maps use the
 * canonical HUMANOID_BONES order; foreign objects (analysis, profile,
 * settings, extra) are emitted with sorted keys. No NaN/Infinity ever appear
 * (they become null) and three.js vectors/quaternions are plain arrays.
 */
export function buildDiagnosticsJson(input: DiagnosticsJsonInput): string {
  const createdAt = (input.now ?? new Date()).toISOString();
  const doc: { [k: string]: Json } = {
    format: DIAGNOSTICS_FORMAT,
    version: DIAGNOSTICS_VERSION,
    createdAt,
    versions: toJsonValue(libraryVersions(), true),
    source: {
      kind: input.sourceKind,
      mirror: input.mirror,
      videoSize: input.pose ? toJsonValue(input.pose.size) : null,
    },
    settings: toJsonValue(input.settings, true),
    analysis: input.analysis ? toJsonValue(input.analysis, true) : null,
    profile: input.profile ? toJsonValue(input.profile, true) : null,
    pose: poseJson(input.pose),
    body: bodyJson(input.body),
    solve: solveJson(input.solve, input.analysis, input.profile),
    framing: input.framing ? toJsonValue(input.framing, true) : null,
    extra: input.extra ? toJsonValue(input.extra, true) : null,
  };
  return JSON.stringify(doc, null, 2);
}

// ---------------------------------------------------------------------------
// Composite PNG
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `cameracharacter-snapshot-YYYYMMDD-HHMMSS` in local time. */
export function snapshotBundleName(date = new Date()): string {
  return (
    `${SNAPSHOT_PREFIX}-${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

export interface CaptureSnapshotOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  /** The webcam preview element, or null when the source has no video (recording / synthetic / websocket). */
  video: HTMLVideoElement | null;
  /** The PiP overlay (drawn on top of the webcam frame), or null. */
  overlay: Overlay2D | null;
  /** True when the preview is CSS-flipped: the composite flips the frame the same way so the overlay matches. */
  previewMirrored: boolean;
  summary: BoneErrorSummary | null;
  /** The JSON bundle (its size is printed in the header; the bundle itself is downloaded separately). */
  json: string;
  /** Optional: force the 3D landmark skeleton visible while rendering the 3D view. */
  skeleton?: LandmarkSkeleton3D | null;
  /** Maximum panel height in pixels (default 1080). */
  maxPanelHeight?: number;
  /** Timestamp override for the bundle name. */
  now?: Date;
}

export interface CapturedSnapshot {
  png: Blob;
  bundleName: string;
  width: number;
  height: number;
}

interface Panel {
  width: number;
  height: number;
}

const GAP = 8;
const STRIP_ROW = 22;
const STRIP_HEADER = 44;
const STRIP_PAD = 12;
/** Bar length scale: a bar reaches full width at this error. */
const BAR_MAX_DEG = 30;

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Snapshot: canvas.toBlob produced no data'))), 'image/png');
  });
}

function videoSize(video: HTMLVideoElement | null): Panel | null {
  if (!video || !(video.videoWidth > 0) || !(video.videoHeight > 0)) return null;
  return { width: video.videoWidth, height: video.videoHeight };
}

/**
 * Captures the composite PNG. Layout: left = webcam frame (letterboxed like
 * the PiP, flipped when `previewMirrored`) with the overlay canvas on top;
 * right = the 3D view; bottom = per-bone and per-chain error bars. Both top
 * panels are scaled to a common height. The 3D view is rendered and read back
 * synchronously (`renderer.render` then `drawImage` in the same task).
 */
export async function captureSnapshot(opts: CaptureSnapshotOptions): Promise<CapturedSnapshot> {
  const bundleName = snapshotBundleName(opts.now);
  const maxH = opts.maxPanelHeight ?? 1080;

  // Left panel geometry: the overlay's pixel box when it has one (so the overlay drawing aligns), else the video, else a placeholder.
  const overlayCanvas = opts.overlay && opts.overlay.canvas.width > 0 && opts.overlay.canvas.height > 0 ? opts.overlay.canvas : null;
  const vSize = videoSize(opts.video);
  const leftNative: Panel = overlayCanvas
    ? { width: overlayCanvas.width, height: overlayCanvas.height }
    : vSize ?? { width: 640, height: 360 };
  const rightNative: Panel = { width: Math.max(1, opts.renderer.domElement.width), height: Math.max(1, opts.renderer.domElement.height) };

  const panelH = Math.max(240, Math.min(maxH, Math.max(leftNative.height, rightNative.height)));
  const leftW = Math.round((leftNative.width / leftNative.height) * panelH);
  const rightW = Math.round((rightNative.width / rightNative.height) * panelH);
  const width = leftW + GAP + rightW;

  const perBone = opts.summary?.perBone ?? [];
  const chains = opts.summary?.chains ?? [];
  const rowsTotal = perBone.length + chains.length;
  const columns = rowsTotal > 12 ? 2 : 1;
  const rows = Math.ceil(rowsTotal / columns);
  const stripH = STRIP_HEADER + rows * STRIP_ROW + STRIP_PAD;
  const height = panelH + GAP + stripH;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Snapshot: 2D canvas context unavailable');
  ctx.fillStyle = '#101216';
  ctx.fillRect(0, 0, width, height);

  // Left: webcam frame + overlay.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, leftW, panelH);
  ctx.clip();
  if (opts.video && vSize) {
    const box: Panel = overlayCanvas ? leftNative : vSize;
    const rect = overlayCanvas && opts.overlay ? opts.overlay.videoRect : containRect(box.width, box.height, vSize.width, vSize.height);
    const r = rect.width > 0 && rect.height > 0 ? rect : containRect(box.width, box.height, vSize.width, vSize.height);
    const k = panelH / box.height;
    ctx.save();
    ctx.scale(k, k);
    if (opts.previewMirrored) {
      ctx.translate(r.x + r.width, r.y);
      ctx.scale(-1, 1);
      ctx.drawImage(opts.video, 0, 0, r.width, r.height);
    } else {
      ctx.drawImage(opts.video, r.x, r.y, r.width, r.height);
    }
    ctx.restore();
  } else {
    ctx.fillStyle = '#1b1e25';
    ctx.fillRect(0, 0, leftW, panelH);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('no video frame (source has no webcam)', leftW / 2, panelH / 2);
    ctx.textAlign = 'left';
  }
  if (overlayCanvas) ctx.drawImage(overlayCanvas, 0, 0, leftW, panelH);
  ctx.restore();

  // Right: 3D view, rendered and read back in the same task.
  const skeleton = opts.skeleton ?? null;
  const skeletonWasVisible = skeleton ? skeleton.visible : false;
  if (skeleton) skeleton.visible = true;
  try {
    opts.renderer.setRenderTarget(null);
    opts.renderer.render(opts.scene, opts.camera);
    ctx.drawImage(opts.renderer.domElement, leftW + GAP, 0, rightW, panelH);
  } finally {
    if (skeleton) skeleton.visible = skeletonWasVisible;
  }

  // Bottom strip: error bars.
  drawErrorStrip(ctx, 0, panelH + GAP, width, stripH, opts.summary, columns, bundleName, opts.json.length);

  const png = await canvasToBlob(canvas);
  return { png, bundleName, width, height };
}

function drawErrorStrip(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  width: number,
  height: number,
  summary: BoneErrorSummary | null,
  columns: number,
  bundleName: string,
  jsonBytes: number,
): void {
  ctx.fillStyle = '#171a20';
  ctx.fillRect(x0, y0, width, height);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const v = libraryVersions();
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(`${bundleName}  ·  app ${v.app} · three r${v.three} · mediapipe ${v.mediapipe} · json ${(jsonBytes / 1024).toFixed(1)} kB`, x0 + STRIP_PAD, y0 + 14);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  if (!summary) {
    ctx.fillText('per-bone error: no solve this frame (no model loaded or no subject)', x0 + STRIP_PAD, y0 + 32);
    return;
  }
  const fmt = (n: number | null) => (n === null ? '–' : `${n.toFixed(1)}°`);
  ctx.fillText(
    `per-bone error (measured vs solved direction): max ${fmt(summary.maxErrorDeg)}${summary.worst ? ` (${summary.worst})` : ''} · mean ${fmt(summary.meanErrorDeg)} over confident bones · ${summary.ok ? 'OK' : `${flaggedRoles(summary).length} flagged (> ${FLAG_ERROR_DEG}°, c > ${FLAG_CONFIDENCE}, auto/calibrated)`}`,
    x0 + STRIP_PAD,
    y0 + 32,
  );

  const rowsTotal = summary.perBone.length + summary.chains.length;
  const rows = Math.ceil(rowsTotal / columns);
  const colW = (width - STRIP_PAD * 2) / columns;
  const labelW = Math.min(300, colW * 0.48);
  const valueW = 130;
  const barW = Math.max(40, colW - labelW - valueW - 16);
  const thresholdX = (FLAG_ERROR_DEG / BAR_MAX_DEG) * barW;

  const entries: { label: string; errorDeg: number | null; confident: boolean; flagged: boolean; detail: string }[] = [];
  for (const b of summary.perBone) {
    entries.push({
      label: `${b.role}${b.bone ? ` (${b.bone})` : ''}`,
      errorDeg: b.errorDeg,
      confident: b.confidence > FLAG_CONFIDENCE,
      flagged: b.flagged,
      detail: `${fmt(b.errorDeg)}  ${b.mode}/${b.source}  c ${b.confidence.toFixed(2)}`,
    });
  }
  for (const c of summary.chains) {
    entries.push({ label: `chain ${c.name}`, errorDeg: c.errorDeg, confident: true, flagged: c.errorDeg !== null && c.errorDeg > FLAG_ERROR_DEG, detail: fmt(c.errorDeg) });
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = x0 + STRIP_PAD + col * colW;
    const y = y0 + STRIP_HEADER + row * STRIP_ROW + STRIP_ROW / 2;
    ctx.fillStyle = e.flagged ? 'rgba(255, 170, 170, 0.95)' : 'rgba(255,255,255,0.85)';
    ctx.font = `${e.flagged ? 'bold ' : ''}12px system-ui, sans-serif`;
    ctx.fillText(truncate(ctx, e.label, labelW - 8), x, y);
    const bx = x + labelW;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(bx, y - 7, barW, 14);
    if (e.errorDeg !== null) {
      const w = Math.max(2, Math.min(barW, (e.errorDeg / BAR_MAX_DEG) * barW));
      ctx.fillStyle = errorBarCss(e.errorDeg, e.confident, e.flagged);
      ctx.fillRect(bx, y - 7, w, 14);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(bx + thresholdX, y - 9, 1, 18);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(truncate(ctx, e.detail, valueW - 4), bx + barW + 8, y);
  }
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
