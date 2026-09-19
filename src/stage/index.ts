export { Stage, type StageOptions } from './Stage';
export {
  DEFAULT_MARGIN,
  DEFAULT_MAX_DISTANCE,
  DEFAULT_MIN_DISTANCE,
  DEFAULT_MIRROR_FOV_DEG,
  FULL_BODY_BOTTOM,
  FULL_BODY_TOP,
  MirrorCameraController,
  computeMirrorFraming,
  distanceForSpan,
  modelHeightAt,
  sanitizeHeightTable,
  type MirrorCameraInput,
  type MirrorCameraOptions,
  type MirrorFraming,
  type MirrorFramingOptions,
  type OrbitLike,
} from './MirrorCamera';
export {
  ENV_DRACO_DECODER_PATH,
  ENV_KTX2_TRANSCODER_PATH,
  createEnvironmentLoader,
  disposeEnvironmentLoaders,
  loadEnvironment,
  type LoadEnvironmentOptions,
  type LoadedEnvironment,
} from './environment';
export { SPAWN_NAME, disposeObject, enableShadows, findSpawn, isSpawnNode } from './placement';
