/**
 * Rig analysis public API: skeleton graph, name lexicon, topology detector,
 * automatic humanoid mapping, bind-pose analysis, profiles and presets.
 *
 * `loadModel.ts` is browser-only and intentionally not re-exported here so
 * this entry point stays importable from Node (tests, scripts).
 */
export {
  applyBindPose,
  buildGraphFromObject3D,
  finalizeGraph,
  fingerprintGraph,
  findNodeByName,
  isDescendant,
  subtree,
  subtreeDepth,
  ancestors,
  graphExtent,
  unitHintFromExtent,
  type SkeletonGraph,
  type SkeletonNode,
  type BuildGraphOptions,
} from './skeletonGraph';
export {
  normalizeBoneName,
  nameKey,
  numericSuffix,
  isHelperBone,
  isTailMarker,
  isSegmentOf,
  fingerNameInfo,
  scoreNameCandidates,
  detectFamilyFromNames,
  type NormalizedBoneName,
  type NameCandidate,
  type FingerNameInfo,
  type NameSide,
} from './boneNames';
export {
  analyzeTopology,
  axesFromRoles,
  snapToAxis,
  type TopologyResult,
  type TopologyOptions,
  type ArmChain,
  type LegChain,
  type FingerChain,
  type RigAxes,
} from './topology';
export { autoMapHumanoid, spineRolesFor, type AutoMapResult, type AutoMapOptions } from './autoMap';
export { analyzeRig, rootCorrectionFromAxes, indexObjectsByName, measureHeight, type AnalyzeRigOptions, type RigAnalysisResult } from './restPose';
export {
  createRigProfile,
  defaultBoneSettings,
  validateProfile,
  isRigProfile,
  exportProfileJson,
  importProfileJson,
  ProfileStore,
  MemoryStorage,
  localStorageAdapter,
  PROFILE_VERSION,
  type KeyValueStorage,
  type ProfileSummary,
} from './profile';
export { MIXAMO_PRESET, MIXAMO_UNPREFIXED_PRESET, MESHY_PRESET, PRESETS, presetFor, type PresetMatch } from './presets';
export { readGlbSkeleton, parseGlbChunks, type GlbSkeletonResult } from './glbSkeleton';
