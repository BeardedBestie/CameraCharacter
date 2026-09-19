import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, SkinnedMesh, Vector3 } from 'three';
import { disposeObject, enableShadows, findSpawn, isSpawnNode } from '../../src/stage/placement';

describe('findSpawn', () => {
  it('returns the world position of a nested node named spawn (case-insensitive)', () => {
    const root = new Group();
    const parent = new Group();
    parent.position.set(1, 0, 2);
    parent.rotation.y = Math.PI / 2;
    root.add(parent);
    const marker = new Object3D();
    marker.name = ' Spawn ';
    marker.position.set(1, 0, 0);
    parent.add(marker);
    const p = findSpawn(root);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(1, 9);
    expect(p!.y).toBeCloseTo(0, 9);
    expect(p!.z).toBeCloseTo(1, 9);
    expect(isSpawnNode(marker)).toBe(true);
    expect(isSpawnNode(parent)).toBe(false);
  });

  it('returns null when there is no marker', () => {
    const root = new Group();
    const child = new Object3D();
    child.name = 'spawnpoint';
    root.add(child);
    expect(findSpawn(root)).toBeNull();
  });
});

describe('enableShadows / disposeObject', () => {
  it('flags every mesh and never frustum-culls skinned meshes', () => {
    const root = new Group();
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const skinned = new SkinnedMesh(new BoxGeometry(), new MeshStandardMaterial());
    root.add(mesh, skinned, new Object3D());
    expect(enableShadows(root, { cast: true, receive: false })).toBe(2);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(false);
    expect(skinned.castShadow).toBe(true);
    expect(skinned.frustumCulled).toBe(false);

    let disposed = 0;
    mesh.geometry.addEventListener('dispose', () => disposed++);
    mesh.material.addEventListener('dispose', () => disposed++);
    disposeObject(root);
    expect(disposed).toBe(2);
    expect(findSpawn(root, new Vector3())).toBeNull();
  });
});
