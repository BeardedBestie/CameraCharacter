/** Diagnostics (docs/DESIGN.md §7 snapshot and self-check, §12 overlay). */
export * from './types';
export * from './colors';
export * from './versions';
export { summarize, flaggedRoles, ErrorStats } from './BoneError';
export { LandmarkSkeleton3D } from './LandmarkSkeleton3D';
export type { LandmarkSkeleton3DOptions } from './LandmarkSkeleton3D';
export { Overlay2D, containRect, overlayFlipsX } from './Overlay2D';
export type { OverlayDrawInput, ContainRect } from './Overlay2D';
export {
  buildDiagnosticsJson,
  captureSnapshot,
  snapshotBundleName,
  toJsonValue,
  DIAGNOSTICS_FORMAT,
  DIAGNOSTICS_VERSION,
  SNAPSHOT_PREFIX,
} from './Snapshot';
export type { DiagnosticsJsonInput, CaptureSnapshotOptions, CapturedSnapshot } from './Snapshot';
