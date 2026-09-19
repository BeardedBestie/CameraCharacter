/**
 * Pure scene-graph helpers shared by the stage and the environment loader
 * (docs/DESIGN.md §8). No DOM, no WebGL: safe to unit-test in Node.
 */
import { Mesh, Object3D, Vector3 } from 'three';

/** Name of the empty that marks where the character stands in an environment. */
export const SPAWN_NAME = 'spawn';

/** True when the node is the environment's spawn marker (name 'spawn', case-insensitive, trimmed). */
export function isSpawnNode(node: Object3D): boolean {
  return node.name.trim().toLowerCase() === SPAWN_NAME;
}

/**
 * World position of the first node named 'spawn' (case-insensitive) under
 * `root`, or null. World matrices are refreshed first so the result is valid
 * right after loading.
 */
export function findSpawn(root: Object3D, out = new Vector3()): Vector3 | null {
  root.updateMatrixWorld(true);
  let found: Object3D | null = null;
  root.traverse((node) => {
    if (!found && isSpawnNode(node)) found = node;
  });
  if (!found) return null;
  return (found as Object3D).getWorldPosition(out);
}

/**
 * Enables shadow casting/receiving on every mesh under `root`. Skinned meshes
 * are never frustum-culled (their bounds are computed from the bind pose).
 */
export function enableShadows(root: Object3D, opts: { cast?: boolean; receive?: boolean } = {}): number {
  const cast = opts.cast ?? true;
  const receive = opts.receive ?? true;
  let count = 0;
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) mesh.frustumCulled = false;
    count++;
  });
  return count;
}

/** Releases geometries and materials (and their textures) under `root`. */
export function disposeObject(root: Object3D): void {
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      if (!m) continue;
      for (const value of Object.values(m)) {
        const tex = value as { isTexture?: boolean; dispose?: () => void } | null;
        if (tex && typeof tex === 'object' && tex.isTexture && tex.dispose) tex.dispose();
      }
      m.dispose();
    }
  });
}
