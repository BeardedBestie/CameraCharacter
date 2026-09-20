/**
 * Rig analysis public API (docs/DESIGN.md §5): loading, bind pose and
 * skeleton graph, name detector, topology detector, automatic humanoid
 * mapping, rest analysis, the App-facing `analyzeModel`, profiles, presets
 * and the Node GLB skeleton reader.
 *
 * Every module except `loadModel` runs in Node; the loaders themselves import
 * cleanly there too, they just need a browser to load anything.
 */
export { loadModel, loadModelFromFile, loadModelFromUrl, detectFormat, createGltfLoader, convertFbxMaterials, humanoidHintFromVrm, disposeLoaders, DRACO_DECODER_PATH, KTX2_TRANSCODER_PATH, type LoadModelOptions } from './loadModel';
export { analyzeModel, type AnalyzedModel, type AnalyzeModelOptions, type LoadedModel, type ModelFormat } from './analyzeModel';
export {
  applyBindPose,
  buildGraphFromObject3D,
  buildRigGraph,
  collectSkeletons,
  computeSkinWeights,
  groupSkins,
  selectPrimarySkeleton,
  defaultExclude,
  finalizeGraph,
  findNodeByName,
  nodeIndexByName,
  isDescendant,
  subtree,
  subtreeDepth,
  subtreeLength,
  ancestors,
  lca,
  pathDown,
  graphExtent,
  hasJoints,
  type SkeletonGraph,
  type SkeletonNode,
  type BuildGraphOptions,
  type SkinGroup,
} from './skeletonGraph';
export {
  classifyBone,
  parseBoneName,
  stripPrefix,
  tokenize,
  mergePhrases,
  isSegmentOf,
  normalizedName,
  detectFamily,
  type BoneNameInfo,
  type BoneNodeContext,
  type BoneClass,
  type BoneGroup,
  type FingerInfo,
  type FingerDigit,
  type FingerSegment,
  type NameSide,
  type FamilyHints,
} from './boneNames';
export {
  analyzeTopology,
  rootCorrectionFromAxes,
  snapToAxis,
  type TopologyResult,
  type TopologyOptions,
  type ArmChain,
  type LegChain,
  type FingerChain,
  type NodeKind,
  type LimbSide,
} from './topology';
export {
  autoMapHumanoid,
  remapAutoResult,
  isAutoMapResult,
  computeKeys,
  isHierarchyConsistent,
  nameOnlyRole,
  mappedParentRole,
  mappedChildRoles,
  CONF_CHAIN_AND_NAME,
  CONF_CHAIN_ONLY,
  CONF_NAME_ONLY,
  CONF_PRESET,
  CONF_HINT,
  type AutoMapResult,
  type AutoMapOptions,
} from './autoMap';
export { analyzeRig, computeHeightTable, measureMeshExtents, indexObjectsByName, BIND_BEND_MIN_DEG, type AnalyzeRigOptions, type MeshExtents } from './restPose';
export {
  createRigProfile,
  applyProfile,
  validateProfile,
  isRigProfile,
  exportProfileJson,
  importProfileJson,
  ProfileStore,
  MemoryStorage,
  localStorageAdapter,
  PROFILE_VERSION,
  type AppliedProfile,
  type StorageLike,
} from './profile';
export { MIXAMO_PRESET, MIXAMO_FBX_PRESET, MIXAMO_UNPREFIXED_PRESET, MESHY_PRESET, PRESETS, presetFor, type PresetMatch } from './presets';
export { readGlbSkeleton, parseGlbChunks, type GlbSkeletonResult, type GltfJson } from './glbSkeleton';
