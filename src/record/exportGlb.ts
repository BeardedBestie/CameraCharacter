/**
 * GLB export of the driven model with a recorded animation clip
 * (docs/DESIGN.md §9). Browser only: uses GLTFExporter (which needs canvases
 * for textures) and, for compressed textures, a WebGLRenderer.
 */
import type { AnimationClip, Object3D, Quaternion, Texture, Vector3, WebGLRenderer } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { decompress } from 'three/addons/utils/WebGLTextureUtils.js';
import { assertTracksResolvable } from './ClipRecorder';

export interface ExportGlbOptions {
  /** The model wrapper group (scale + root correction + loader root). Exported instead of the Scene. */
  wrapper: Object3D;
  /** Restores the rig's bind pose (provided by the rig module). */
  applyBindPose: () => void;
  clip: AnimationClip;
  /** Optional environment scene exported next to the model. */
  environment?: Object3D | null;
  /** Needed to decompress KTX2 / compressed textures during export. */
  renderer?: WebGLRenderer;
  /** Include the model's pre-existing animations (found on `.animations` of the wrapper and its descendants). Default false. */
  includeExistingAnimations?: boolean;
  /** Extra exporter options (e.g. maxTextureSize). */
  maxTextureSize?: number;
}

interface TrsSnapshot {
  node: Object3D;
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
}

/** Records the local TRS of every node under `root` (including `root`). */
export function snapshotTransforms(root: Object3D): TrsSnapshot[] {
  const out: TrsSnapshot[] = [];
  root.traverse((node) => {
    out.push({ node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone() });
  });
  return out;
}

export function restoreTransforms(snapshot: TrsSnapshot[]): void {
  for (const s of snapshot) {
    s.node.position.copy(s.position);
    s.node.quaternion.copy(s.quaternion);
    s.node.scale.copy(s.scale);
  }
}

/** Collects `.animations` of `root` and its descendants (GLTFLoader results are usually kept on the loader root). */
export function collectExistingAnimations(root: Object3D): AnimationClip[] {
  const out: AnimationClip[] = [];
  root.traverse((node) => {
    for (const clip of node.animations) if (!out.includes(clip)) out.push(clip);
  });
  return out;
}

/**
 * Exports the wrapper (and optionally the environment) as a binary glTF with
 * the clip as its animation. The rig is put back into its bind pose for the
 * export so the exported skin matches the inverse bind matrices, and the
 * current pose is restored afterwards (also on failure).
 */
export async function exportGlbWithTake(opts: ExportGlbOptions): Promise<ArrayBuffer> {
  const { wrapper, clip, environment } = opts;
  assertTracksResolvable(clip, wrapper);
  const exporter = new GLTFExporter();
  if (opts.renderer) {
    const renderer = opts.renderer;
    exporter.setTextureUtils({
      decompress: (texture: Texture, maxTextureSize?: number) => {
        decompress(texture, maxTextureSize, renderer);
      },
    });
  }
  const modelClips = [clip];
  if (opts.includeExistingAnimations) {
    for (const c of collectExistingAnimations(wrapper)) if (c !== clip) modelClips.push(c);
  }
  const snapshot = snapshotTransforms(wrapper);
  try {
    opts.applyBindPose();
    wrapper.updateMatrixWorld(true);
    let result: ArrayBuffer | { [key: string]: unknown };
    // Object.assign in the exporter would copy an explicit `undefined` over its Infinity default.
    const common: { binary: boolean; onlyVisible: boolean; maxTextureSize?: number } = { binary: true, onlyVisible: false };
    if (opts.maxTextureSize !== undefined) common.maxTextureSize = opts.maxTextureSize;
    if (environment) {
      environment.updateMatrixWorld(true);
      result = await exporter.parseAsync([wrapper, environment], { ...common, animations: [modelClips, []] });
    } else {
      result = await exporter.parseAsync(wrapper, { ...common, animations: modelClips });
    }
    if (!(result instanceof ArrayBuffer)) throw new Error('exportGlbWithTake: GLTFExporter did not return a binary buffer');
    return result;
  } finally {
    restoreTransforms(snapshot);
    wrapper.updateMatrixWorld(true);
  }
}
