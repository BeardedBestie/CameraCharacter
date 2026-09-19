/**
 * Tracking layer public API (docs/DESIGN.md §3, §10, §11).
 *
 * Node-safe: PoseSource, protocol, convert, PoseFilter, RecordingSource,
 * WebSocketSource (parsePoseFrame), mediapipeModels, landmarks.
 * Browser-only: MediaPipeSource, camera.
 */
export type { PoseSource, SourceStatus, SourceState, SourceKind, FrameListener, StatusListener } from './PoseSource';
export { BaseSource, FpsMeter } from './PoseSource';

export * from './landmarks';

export { validatePoseFrame, parsePoseFrameText, parseMocapRecording, MOCAP_FORMAT, MOCAP_VERSION } from './protocol';

export {
  landmarksToTuples,
  pointsToTuples,
  blendshapesToRecord,
  matrixToArray,
  assignHandSides,
  swapHandednessLabel,
  makeHandFrame,
  mirrorBlendshapeName,
  mirrorMatrixYZ,
  mirrorFaceFrame,
  HAND_ANCHOR_MIN_VISIBILITY,
} from './convert';
export type { LandmarkLike, CategoryLike, MatrixLike, DetectedHandLike, HandSide } from './convert';

export { PoseFilter, worldToThree, ABSENCE_RESET_MS, VISIBILITY_ALPHA } from './PoseFilter';
export type { FilteredPose } from './PoseFilter';

export { WebSocketSource, parsePoseFrame, WS_RECONNECT_MIN_MS, WS_RECONNECT_MAX_MS } from './WebSocketSource';
export { RecordingSource, RECORDING_SRC } from './RecordingSource';

export {
  MODEL_ASSETS,
  LOCAL_MODEL_DIR,
  MODEL_CACHE_NAME,
  MEDIAPIPE_VERSION,
  LOCAL_WASM_PATH,
  CDN_WASM_PATH,
  WASM_PROBE_FILE,
  poseModelAsset,
  localModelUrl,
  loadModelAsset,
  resolveWasmBasePath,
  looksLikeTaskBundle,
} from './mediapipeModels';
export type { ModelAssetName, ModelAsset, LoadModelOptions, FetchLike } from './mediapipeModels';

export { MediaPipeSource, MEDIAPIPE_SRC } from './MediaPipeSource';
export type { MediaPipeSourceOptions, MediaPipeLastResult } from './MediaPipeSource';

export { listCameras, openCamera, closeCamera, captureSize } from './camera';
export type { OpenCameraOptions, OpenedCamera } from './camera';
