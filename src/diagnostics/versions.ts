/**
 * Library versions recorded in every diagnostic bundle so a reader (human or
 * LLM) knows which code produced it. Pure; safe in Node.
 */
import { REVISION } from 'three';
import pkg from '../../package.json';
import { MEDIAPIPE_VERSION as TRACKING_MEDIAPIPE_VERSION } from '../tracking/mediapipeModels';

export const THREE_REVISION: string = REVISION;
/** The pinned `@mediapipe/tasks-vision` version (single source of truth in src/tracking/mediapipeModels.ts). */
export const MEDIAPIPE_VERSION: string = TRACKING_MEDIAPIPE_VERSION;
export const APP_VERSION: string = pkg.version;
export const APP_NAME: string = pkg.name;

export interface LibraryVersions {
  app: string;
  three: string;
  mediapipe: string;
}

export function libraryVersions(): LibraryVersions {
  return { app: APP_VERSION, three: THREE_REVISION, mediapipe: MEDIAPIPE_VERSION };
}
