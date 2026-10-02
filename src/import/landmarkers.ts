/**
 * Creates the MediaPipe landmarker set used by the offline video importer
 * (docs/DESIGN.md §17.2): a PoseLandmarker in VIDEO mode plus optional
 * HandLandmarker and FaceLandmarker, with the same GPU → CPU fallback as the
 * live source. Each importer run gets its own instances because VIDEO mode
 * needs strictly increasing timestamps per instance. Browser only.
 */
import { FaceLandmarker, FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseModelVariant } from '../core/types';
import { loadModelAsset, poseModelAsset, resolveWasmBasePath } from '../tracking/mediapipeModels';

export type Delegate = 'GPU' | 'CPU';
type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

export interface LandmarkerOptions {
  poseModel: PoseModelVariant;
  delegate: Delegate;
  hands: boolean;
  face: boolean;
  /** Detection/presence/tracking confidence (default 0.5). */
  confidence?: number;
  onStatus?: (message: string) => void;
}

export interface LandmarkerSet {
  pose: PoseLandmarker;
  hand: HandLandmarker | null;
  face: FaceLandmarker | null;
  /** Delegate actually in use after fallback. */
  delegate: Delegate;
  /** Optional features that could not be loaded, with the reason. */
  disabled: { hands?: string; face?: string };
  close(): void;
}

let filesetPromise: Promise<WasmFileset> | null = null;

/** The WASM fileset is shared by every landmarker on the page. */
export function getVisionFileset(): Promise<WasmFileset> {
  if (!filesetPromise) {
    filesetPromise = resolveWasmBasePath()
      .then((path) => FilesetResolver.forVisionTasks(path))
      .catch((err: unknown) => {
        filesetPromise = null;
        throw err;
      });
  }
  return filesetPromise;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withFallback<T>(requested: Delegate, create: (delegate: Delegate) => Promise<T>, onStatus?: (m: string) => void): Promise<{ value: T; delegate: Delegate }> {
  try {
    return { value: await create(requested), delegate: requested };
  } catch (err) {
    if (requested !== 'GPU') throw err;
    onStatus?.(`GPU delegate unavailable (${errorText(err)}); using CPU`);
    return { value: await create('CPU'), delegate: 'CPU' };
  }
}

export async function createLandmarkers(opts: LandmarkerOptions): Promise<LandmarkerSet> {
  const confidence = opts.confidence ?? 0.5;
  const status = opts.onStatus;
  status?.('Loading MediaPipe runtime');
  const fileset = await getVisionFileset();

  status?.(`Loading pose model (${opts.poseModel})`);
  const poseBytes = await loadModelAsset(poseModelAsset(opts.poseModel));
  const poseResult = await withFallback(
    opts.delegate,
    (delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: poseBytes, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: confidence,
        minPosePresenceConfidence: confidence,
        minTrackingConfidence: confidence,
      }),
    status,
  );
  const delegate = poseResult.delegate;
  const set: LandmarkerSet = {
    pose: poseResult.value,
    hand: null,
    face: null,
    delegate,
    disabled: {},
    close() {
      for (const lm of [set.pose, set.hand, set.face]) {
        try {
          lm?.close();
        } catch {
          // ignore
        }
      }
      set.hand = null;
      set.face = null;
    },
  };

  if (opts.hands) {
    status?.('Loading hand model');
    try {
      const bytes = await loadModelAsset('hand');
      const r = await withFallback(
        delegate,
        (d) =>
          HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: bytes, delegate: d },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: confidence,
            minHandPresenceConfidence: confidence,
            minTrackingConfidence: confidence,
          }),
        status,
      );
      set.hand = r.value;
    } catch (err) {
      set.disabled.hands = errorText(err);
      status?.(`Hand tracking unavailable: ${set.disabled.hands}`);
    }
  }

  if (opts.face) {
    status?.('Loading face model');
    try {
      const bytes = await loadModelAsset('face');
      const r = await withFallback(
        delegate,
        (d) =>
          FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: bytes, delegate: d },
            runningMode: 'VIDEO',
            numFaces: 1,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
            minFaceDetectionConfidence: confidence,
            minFacePresenceConfidence: confidence,
            minTrackingConfidence: confidence,
          }),
        status,
      );
      set.face = r.value;
    } catch (err) {
      set.disabled.face = errorText(err);
      status?.(`Face tracking unavailable: ${set.disabled.face}`);
    }
  }
  return set;
}
