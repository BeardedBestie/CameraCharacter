/**
 * Library versions recorded in every diagnostic bundle so a reader (human or
 * LLM) knows which code produced it.
 */
import { REVISION } from 'three';
import pkg from '../../package.json';

export const THREE_REVISION: string = REVISION;
/** Pinned in package.json; kept as a constant so the bundle never needs the (browser-only) MediaPipe module. */
export const MEDIAPIPE_VERSION = '1.0.1';
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
