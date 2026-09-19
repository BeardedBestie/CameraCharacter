/**
 * Tracking layer public API (docs/DESIGN.md §3, §10, §11).
 *
 * Node-safe: PoseSource, protocol, convert, PoseFilter, scaleFreeOneEuro,
 * RecordingSource, SyntheticSource, WebSocketSource (parsePoseFrame),
 * mediapipeModels, landmarks.
 * Browser-only: MediaPipeSource, camera.
 */
export type { PoseSource, SourceStatus, SourceState, SourceKind, FrameListener, StatusListener } from './PoseSource';
export { BaseSource, FpsMeter } from './PoseSource';

export * from './landmarks';

export {
  validatePoseFrame,
  parsePoseFrameText,
  parseMocapRecording,
  parseMocapMeta,
  buildMocapMeta,
  MOCAP_FORMAT,
  MOCAP_VERSION,
  TRACKER_LIB,
  TRACKER_VERSION,
} from './protocol';

export {
  landmarksToTuples,
  pointsToTuples,
  blendshapesToRecord,
  matrixToArray,
  assignHandSides,
  swapHandednessLabel,
  normalizeHandednessLabel,
  makeHandFrame,
  mirrorBlendshapeName,
  mirrorMatrixYZ,
  mirrorFaceFrame,
  mirrorHandFrame,
  mirrorPoseFrame,
  HAND_ANCHOR_MIN_VISIBILITY,
} from './convert';
export type { LandmarkLike, CategoryLike, MatrixLike, DetectedHandLike, HandSide } from './convert';

export {
  PoseFilter,
  worldToThree,
  faceRotationFromMatrix,
  landmarkGroup,
  FACE_BASIS_CHANGE,
  VISIBILITY_TAU_MS,
  IN_FRAME_MARGIN,
  IMAGE_SCALE_FALLBACK,
  WORLD_SCALE_FALLBACK,
} from './PoseFilter';
export type { FilteredPose } from './PoseFilter';
export { ScaleFreeOneEuro, ScaleFreeOneEuro3 } from './scaleFreeOneEuro';

export { WebSocketSource, parsePoseFrame, WS_RECONNECT_MIN_MS, WS_RECONNECT_MAX_MS, WS_DEFAULT_GAP_MS } from './WebSocketSource';
export { RecordingSource, RECORDING_SRC } from './RecordingSource';
export { SyntheticSource, SYNTHETIC_SRC } from './SyntheticSource';
export type { SyntheticSourceOptions } from './SyntheticSource';

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
export type { MediaPipeSourceOptions, MediaPipeLastResult, AuxFeatureState } from './MediaPipeSource';

export { listCameras, openCamera, closeCamera, captureSize, isDeviceUnavailableError, RETRYABLE_CAMERA_ERRORS } from './camera';
export type { OpenCameraOptions, OpenedCamera } from './camera';
