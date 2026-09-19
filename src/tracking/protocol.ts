/**
 * PoseFrame v2 / .mocap.json validation (docs/DESIGN.md §10). Pure and
 * defensive: anything that comes over a socket or from a file passes through
 * here before the rest of the pipeline sees it. Validated frames are fresh
 * objects (no aliasing of the input) with visibility filled in.
 */
import type {
  CameraMeta,
  FaceFrame,
  HandFrame,
  LandmarkTuple,
  MocapMeta,
  MocapRecording,
  PointTuple,
  PoseCalibration,
  PoseFrame,
  SmoothingSettings,
  TrackerMeta,
} from '../core/types';
import { DEFAULT_SETTINGS } from '../core/types';
import { normalizeHandednessLabel } from './convert';
import { HAND_LANDMARK_COUNT, POSE_LANDMARK_COUNT } from './landmarks';
import { MEDIAPIPE_VERSION } from './mediapipeModels';

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
  // `local` per the v2 protocol; `world` is accepted as the pre-2.1 name of the same array.
  const local = toPointArray(v.local !== undefined ? v.local : v.world, HAND_LANDMARK_COUNT);
  const image = toPointArray(v.image, HAND_LANDMARK_COUNT);
  if (!local || !image) return undefined;
  const score = isFiniteNumber(v.score) ? Math.min(1, Math.max(0, v.score)) : 1;
  const hand: HandFrame = { local, image, score };
  const handedness = normalizeHandednessLabel(v.handedness);
  if (handedness) hand.handedness = handedness;
  return hand;
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
  // Optional capture clock; anything that is not a finite number is dropped, not rejected.
  if (isFiniteNumber(value.now)) frame.now = value.now;

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

  const meta = parseMocapMeta(isRecord(json.meta) ? json.meta : {}, frames);
  return { format: MOCAP_FORMAT, version: MOCAP_VERSION, meta, frames };
}

const DELEGATES = new Set(['GPU', 'CPU']);
const POSE_MODELS = new Set(['lite', 'full', 'heavy']);

function parseCameraMeta(v: unknown): CameraMeta | undefined {
  if (!isRecord(v)) return undefined;
  const out: CameraMeta = {};
  if (typeof v.deviceLabel === 'string') out.deviceLabel = v.deviceLabel;
  if (typeof v.facingMode === 'string') out.facingMode = v.facingMode;
  if (isFiniteNumber(v.frameRate)) out.frameRate = v.frameRate;
  if (isFiniteNumber(v.vfovDeg)) out.vfovDeg = v.vfovDeg;
  return out;
}

function parseTrackerMeta(v: unknown): TrackerMeta | undefined {
  if (!isRecord(v)) return undefined;
  const out: TrackerMeta = {
    lib: typeof v.lib === 'string' ? v.lib : 'unknown',
    version: typeof v.version === 'string' ? v.version : 'unknown',
  };
  if (typeof v.poseModel === 'string' && POSE_MODELS.has(v.poseModel)) out.poseModel = v.poseModel as TrackerMeta['poseModel'];
  if (typeof v.delegate === 'string' && DELEGATES.has(v.delegate)) out.delegate = v.delegate as TrackerMeta['delegate'];
  if (typeof v.hands === 'boolean') out.hands = v.hands;
  if (typeof v.face === 'boolean') out.face = v.face;
  if (isFiniteNumber(v.minPoseDetectionConfidence)) out.minPoseDetectionConfidence = v.minPoseDetectionConfidence;
  if (isFiniteNumber(v.minTrackingConfidence)) out.minTrackingConfidence = v.minTrackingConfidence;
  return out;
}

/** Lenient: every known numeric field is taken when finite, the defaults fill the rest. */
function parseSmoothingMeta(v: unknown): SmoothingSettings | undefined {
  if (!isRecord(v)) return undefined;
  const d = DEFAULT_SETTINGS.smoothing;
  const num = (key: keyof SmoothingSettings, fallback: number): number => {
    const raw = v[key];
    return isFiniteNumber(raw) ? raw : fallback;
  };
  const gate = (key: 'gateBody' | 'gateFeet' | 'gateFace') => {
    const raw = v[key];
    const on = isRecord(raw) && isFiniteNumber(raw.on) ? raw.on : d[key].on;
    const off = isRecord(raw) && isFiniteNumber(raw.off) ? raw.off : d[key].off;
    return { on, off };
  };
  const holdRaw = isRecord(v.poseHoldMs) ? v.poseHoldMs : {};
  return {
    oneEuroMinCutoff: num('oneEuroMinCutoff', d.oneEuroMinCutoff),
    oneEuroBeta: num('oneEuroBeta', d.oneEuroBeta),
    oneEuroDCutoff: num('oneEuroDCutoff', d.oneEuroDCutoff),
    boneRate: num('boneRate', d.boneRate),
    boneRateVelocityGain: num('boneRateVelocityGain', d.boneRateVelocityGain),
    gateBody: gate('gateBody'),
    gateFeet: gate('gateFeet'),
    gateFace: gate('gateFace'),
    gateDwellMs: num('gateDwellMs', d.gateDwellMs),
    gateReleaseMs: num('gateReleaseMs', d.gateReleaseMs),
    outOfFrameReleaseMs: num('outOfFrameReleaseMs', d.outOfFrameReleaseMs),
    poseHoldMs: {
      arms: isFiniteNumber(holdRaw.arms) ? holdRaw.arms : d.poseHoldMs.arms,
      legs: isFiniteNumber(holdRaw.legs) ? holdRaw.legs : d.poseHoldMs.legs,
      torso: isFiniteNumber(holdRaw.torso) ? holdRaw.torso : d.poseHoldMs.torso,
    },
    relaxRate: num('relaxRate', d.relaxRate),
    twistTau: num('twistTau', d.twistTau),
    lowerArmTwistFraction: num('lowerArmTwistFraction', d.lowerArmTwistFraction),
    reacquireRampMs: num('reacquireRampMs', d.reacquireRampMs),
    standingBaselineSec: num('standingBaselineSec', d.standingBaselineSec),
  };
}

/**
 * Parse the `meta` block of a recording leniently: unknown or malformed
 * optional fields are dropped, never fatal. `size` defaults to the first
 * frame's size and `source` to the first frame's `src`.
 */
export function parseMocapMeta(metaRaw: Record<string, unknown>, frames: readonly PoseFrame[]): MocapMeta {
  let size: [number, number] = [0, 0];
  const sizeRaw = metaRaw.size;
  if (Array.isArray(sizeRaw) && sizeRaw.length === 2 && isFiniteNumber(sizeRaw[0]) && isFiniteNumber(sizeRaw[1])) {
    size = [sizeRaw[0], sizeRaw[1]];
  } else if (frames.length > 0) {
    size = [frames[0].size[0], frames[0].size[1]];
  }
  const meta: MocapMeta = {
    createdAt: typeof metaRaw.createdAt === 'string' ? metaRaw.createdAt : '',
    source: typeof metaRaw.source === 'string' ? metaRaw.source : frames[0]?.src ?? 'unknown',
    size,
    mirror: metaRaw.mirror === true,
  };
  if (typeof metaRaw.notes === 'string') meta.notes = metaRaw.notes;
  if (isFiniteNumber(metaRaw.fovDeg)) meta.fovDeg = metaRaw.fovDeg;
  const t0 = metaRaw.t0;
  if (isRecord(t0) && typeof t0.wallclock === 'string' && isFiniteNumber(t0.performanceNow)) {
    meta.t0 = { wallclock: t0.wallclock, performanceNow: t0.performanceNow };
  }
  const camera = parseCameraMeta(metaRaw.camera);
  if (camera) meta.camera = camera;
  const tracker = parseTrackerMeta(metaRaw.tracker);
  if (tracker) meta.tracker = tracker;
  const smoothing = parseSmoothingMeta(metaRaw.smoothing);
  if (smoothing) meta.smoothing = smoothing;
  const cal = metaRaw.calibration;
  if (isRecord(cal) && cal.version === 3 && isRecord(cal.bases)) {
    meta.calibration = cal as unknown as PoseCalibration;
  } else if (cal === null) {
    meta.calibration = null;
  }
  const ref = metaRaw.referenceModel;
  if (isRecord(ref) && typeof ref.familyKey === 'string' && typeof ref.displayName === 'string') {
    meta.referenceModel = { familyKey: ref.familyKey, displayName: ref.displayName };
    if (typeof ref.instanceKey === 'string') meta.referenceModel.instanceKey = ref.instanceKey;
  } else if (ref === null) {
    meta.referenceModel = null;
  }
  return meta;
}

/** Library identity written into `meta.tracker` by the browser recorder. */
export const TRACKER_LIB = '@mediapipe/tasks-vision';
export const TRACKER_VERSION = MEDIAPIPE_VERSION;

/**
 * Fill a MocapMeta for the recorder: `createdAt` defaults to now, the tracker
 * block to this build's MediaPipe library/version, everything else to the
 * protocol defaults. Fields in `partial` win; `undefined` entries are dropped.
 */
export function buildMocapMeta(partial: Partial<MocapMeta> = {}, now: Date = new Date()): MocapMeta {
  const meta: MocapMeta = {
    createdAt: partial.createdAt ?? now.toISOString(),
    source: partial.source ?? 'unknown',
    size: partial.size ? [partial.size[0], partial.size[1]] : [0, 0],
    mirror: partial.mirror ?? false,
    tracker: { lib: TRACKER_LIB, version: TRACKER_VERSION, ...(partial.tracker ?? {}) },
  };
  if (partial.fovDeg !== undefined) meta.fovDeg = partial.fovDeg;
  if (partial.t0 !== undefined) meta.t0 = { ...partial.t0 };
  if (partial.camera !== undefined) meta.camera = { ...partial.camera };
  if (partial.smoothing !== undefined) meta.smoothing = { ...partial.smoothing };
  if (partial.calibration !== undefined) meta.calibration = partial.calibration;
  if (partial.referenceModel !== undefined) meta.referenceModel = partial.referenceModel;
  if (partial.notes !== undefined) meta.notes = partial.notes;
  return meta;
}
