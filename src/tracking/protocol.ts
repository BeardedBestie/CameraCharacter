/**
 * PoseFrame v2 / .mocap.json validation (docs/DESIGN.md §10). Pure and
 * defensive: anything that comes over a socket or from a file passes through
 * here before the rest of the pipeline sees it. Validated frames are fresh
 * objects (no aliasing of the input) with visibility filled in.
 */
import type { FaceFrame, HandFrame, LandmarkTuple, MocapRecording, PointTuple, PoseFrame } from '../core/types';
import { HAND_LANDMARK_COUNT, POSE_LANDMARK_COUNT } from './landmarks';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** [x, y, z] or [x, y, z, visibility]; visibility defaults to 1 when absent. */
function toLandmarkTuple(v: unknown): LandmarkTuple | null {
  if (!Array.isArray(v) || v.length < 3 || v.length > 4) return null;
  const x = v[0];
  const y = v[1];
  const z = v[2];
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
  let vis = 1;
  if (v.length === 4) {
    const raw = v[3];
    if (!isFiniteNumber(raw)) return null;
    vis = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  }
  return [x, y, z, vis];
}

function toPointTuple(v: unknown): PointTuple | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const x = v[0];
  const y = v[1];
  const z = v[2];
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
  return [x, y, z];
}

function toLandmarkArray(v: unknown, count: number): LandmarkTuple[] | null {
  if (!Array.isArray(v) || v.length !== count) return null;
  const out: LandmarkTuple[] = new Array<LandmarkTuple>(count);
  for (let i = 0; i < count; i++) {
    const t = toLandmarkTuple(v[i]);
    if (!t) return null;
    out[i] = t;
  }
  return out;
}

function toPointArray(v: unknown, count: number): PointTuple[] | null {
  if (!Array.isArray(v) || v.length !== count) return null;
  const out: PointTuple[] = new Array<PointTuple>(count);
  for (let i = 0; i < count; i++) {
    const t = toPointTuple(v[i]);
    if (!t) return null;
    out[i] = t;
  }
  return out;
}

/** Validate a hand entry; `null`/`undefined` → null, malformed → undefined. */
function toHandFrame(v: unknown): HandFrame | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) return undefined;
  const world = toPointArray(v.world, HAND_LANDMARK_COUNT);
  const image = toPointArray(v.image, HAND_LANDMARK_COUNT);
  if (!world || !image) return undefined;
  const score = isFiniteNumber(v.score) ? Math.min(1, Math.max(0, v.score)) : 1;
  return { world, image, score };
}

function toFaceFrame(v: unknown): FaceFrame | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) return undefined;
  const blendshapes: Record<string, number> = {};
  if (v.blendshapes !== undefined && v.blendshapes !== null) {
    if (!isRecord(v.blendshapes)) return undefined;
    for (const [name, score] of Object.entries(v.blendshapes)) {
      if (!isFiniteNumber(score)) return undefined;
      blendshapes[name] = score;
    }
  }
  let matrix: number[] | null = null;
  if (v.matrix !== undefined && v.matrix !== null) {
    if (!Array.isArray(v.matrix) || v.matrix.length !== 16) return undefined;
    matrix = [];
    for (const n of v.matrix) {
      if (!isFiniteNumber(n)) return undefined;
      matrix.push(n);
    }
  }
  return { blendshapes, matrix };
}

/**
 * Validate an already-parsed JSON value as a PoseFrame v2. Returns a fresh,
 * normalized frame or null when the value is not a valid frame.
 */
export function validatePoseFrame(value: unknown): PoseFrame | null {
  if (!isRecord(value)) return null;
  if (value.v !== 2) return null;
  if (!isFiniteNumber(value.t)) return null;
  const src = typeof value.src === 'string' && value.src.length > 0 ? value.src : 'unknown';
  const sizeRaw = value.size;
  let size: [number, number] = [0, 0];
  if (Array.isArray(sizeRaw) && sizeRaw.length === 2 && isFiniteNumber(sizeRaw[0]) && isFiniteNumber(sizeRaw[1])) {
    size = [sizeRaw[0], sizeRaw[1]];
  } else if (sizeRaw !== undefined && sizeRaw !== null) {
    return null;
  }

  let pose: PoseFrame['pose'] = null;
  if (value.pose !== null && value.pose !== undefined) {
    if (!isRecord(value.pose)) return null;
    const world = toLandmarkArray(value.pose.world, POSE_LANDMARK_COUNT);
    const image = toLandmarkArray(value.pose.image, POSE_LANDMARK_COUNT);
    if (!world || !image) return null;
    pose = { world, image };
  }

  const frame: PoseFrame = { v: 2, t: value.t, src, size, pose };

  if (value.hands !== undefined) {
    if (value.hands === null) {
      frame.hands = null;
    } else {
      if (!isRecord(value.hands)) return null;
      const left = toHandFrame(value.hands.left);
      const right = toHandFrame(value.hands.right);
      if (left === undefined || right === undefined) return null;
      frame.hands = { left, right };
    }
  }

  if (value.face !== undefined) {
    const face = toFaceFrame(value.face);
    if (face === undefined) return null;
    frame.face = face;
  }

  return frame;
}

/** Parse one JSON text message into a PoseFrame v2, or null when invalid. */
export function parsePoseFrameText(text: string): PoseFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validatePoseFrame(parsed);
}

export const MOCAP_FORMAT = 'cameracharacter-mocap';
export const MOCAP_VERSION = 2;

/**
 * Validate a parsed `.mocap.json` document. Throws an Error with a readable
 * message when the document is not a version-2 recording; frames that fail
 * validation are rejected (the index is reported) rather than silently dropped.
 */
export function parseMocapRecording(json: unknown): MocapRecording {
  if (!isRecord(json)) throw new Error('Recording must be a JSON object');
  if (json.format !== MOCAP_FORMAT) {
    throw new Error(`Unsupported recording format "${String(json.format)}" (expected "${MOCAP_FORMAT}")`);
  }
  if (json.version !== MOCAP_VERSION) {
    throw new Error(`Unsupported recording version ${String(json.version)} (expected ${MOCAP_VERSION})`);
  }
  if (!Array.isArray(json.frames)) throw new Error('Recording is missing the "frames" array');

  const frames: PoseFrame[] = new Array<PoseFrame>(json.frames.length);
  for (let i = 0; i < json.frames.length; i++) {
    const f = validatePoseFrame(json.frames[i]);
    if (!f) throw new Error(`Recording frame ${i} is not a valid PoseFrame v2`);
    frames[i] = f;
  }

  const metaRaw = isRecord(json.meta) ? json.meta : {};
  let size: [number, number] = [0, 0];
  const sizeRaw = metaRaw.size;
  if (Array.isArray(sizeRaw) && sizeRaw.length === 2 && isFiniteNumber(sizeRaw[0]) && isFiniteNumber(sizeRaw[1])) {
    size = [sizeRaw[0], sizeRaw[1]];
  } else if (frames.length > 0) {
    size = [frames[0].size[0], frames[0].size[1]];
  }

  const meta: MocapRecording['meta'] = {
    createdAt: typeof metaRaw.createdAt === 'string' ? metaRaw.createdAt : '',
    source: typeof metaRaw.source === 'string' ? metaRaw.source : frames[0]?.src ?? 'unknown',
    size,
    mirror: metaRaw.mirror === true,
  };
  if (typeof metaRaw.notes === 'string') meta.notes = metaRaw.notes;
  if (isFiniteNumber(metaRaw.fovDeg)) meta.fovDeg = metaRaw.fovDeg;
  if (isRecord(metaRaw.calibration) && metaRaw.calibration.version === 2) {
    meta.calibration = metaRaw.calibration as unknown as MocapRecording['meta']['calibration'];
  } else if (metaRaw.calibration === null) {
    meta.calibration = null;
  }

  return { format: MOCAP_FORMAT, version: MOCAP_VERSION, meta, frames };
}
