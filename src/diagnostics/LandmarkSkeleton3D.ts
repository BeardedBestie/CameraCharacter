/**
 * Measured landmark skeleton drawn in world space over the model
 * (docs/DESIGN.md §7 snapshot, §12 Stage "show landmark skeleton").
 *
 * three.js core only (no examples/jsm), so it constructs and updates in Node
 * for unit tests. Landmark positions are the filtered `pose.world` values
 * (hip-centred, meters) offset by the solver's hips world position, so the
 * skeleton sits on the model wherever the hips have been translated.
 */
import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
} from 'three';
import type { FilteredPose } from '../core/pose';
import { POSE_CONNECTIONS, POSE_LANDMARK_COUNT } from '../tracking/landmarks';
import { confidenceColor, type RGB } from './colors';

export interface LandmarkSkeleton3DOptions {
  /** Multiplier on landmark coordinates (1 = meters, the pose's native unit). Default 1. */
  scale?: number;
  /** Joint sphere radius in meters before `scale`. Default 0.018. */
  jointRadius?: number;
  /** Draw on top of the model (depth test off). Default true. */
  overlay?: boolean;
}

const _m = new Matrix4();
const _p = new Vector3();
const _c = new Color();
const _rgb: RGB = [0, 0, 0];

export class LandmarkSkeleton3D {
  readonly object: Object3D;
  readonly lines: LineSegments;
  readonly joints: InstancedMesh;
  readonly scale: number;
  readonly jointRadius: number;

  private readonly linePositions: Float32BufferAttribute;
  private readonly lineColors: Float32BufferAttribute;
  private readonly lineMaterial: LineBasicMaterial;
  private readonly jointMaterial: MeshBasicMaterial;
  private readonly jointGeometry: SphereGeometry;
  private visibleFlag = true;
  private hasPose = false;

  constructor(opts: LandmarkSkeleton3DOptions = {}) {
    this.scale = opts.scale ?? 1;
    this.jointRadius = opts.jointRadius ?? 0.018;
    const overlay = opts.overlay ?? true;

    const group = new Group();
    group.name = 'LandmarkSkeleton3D';
    this.object = group;

    const segCount = POSE_CONNECTIONS.length;
    const lineGeom = new BufferGeometry();
    this.linePositions = new Float32BufferAttribute(new Float32Array(segCount * 2 * 3), 3);
    this.lineColors = new Float32BufferAttribute(new Float32Array(segCount * 2 * 3), 3);
    this.linePositions.setUsage(DynamicDrawUsage);
    this.lineColors.setUsage(DynamicDrawUsage);
    lineGeom.setAttribute('position', this.linePositions);
    lineGeom.setAttribute('color', this.lineColors);
    this.lineMaterial = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: !overlay, depthWrite: false });
    this.lines = new LineSegments(lineGeom, this.lineMaterial);
    this.lines.name = 'LandmarkSkeleton3D.lines';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = overlay ? 1000 : 0;

    this.jointGeometry = new SphereGeometry(1, 10, 8);
    this.jointMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: !overlay, depthWrite: false });
    this.joints = new InstancedMesh(this.jointGeometry, this.jointMaterial, POSE_LANDMARK_COUNT);
    this.joints.name = 'LandmarkSkeleton3D.joints';
    this.joints.frustumCulled = false;
    this.joints.renderOrder = overlay ? 1001 : 0;
    this.joints.instanceMatrix.setUsage(DynamicDrawUsage);
    // Allocate the per-instance color buffer up front so it exists before the first render.
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      this.joints.setMatrixAt(i, _m.makeScale(0, 0, 0));
      this.joints.setColorAt(i, _c.setRGB(1, 1, 1));
    }
    this.joints.instanceMatrix.needsUpdate = true;
    if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true;

    group.add(this.lines, this.joints);
    this.applyVisibility();
  }

  /** Whether the user wants the skeleton shown; it is still hidden while no pose is present. */
  set visible(v: boolean) {
    this.visibleFlag = v;
    this.applyVisibility();
  }

  get visible(): boolean {
    return this.visibleFlag;
  }

  private applyVisibility(): void {
    this.object.visible = this.visibleFlag && this.hasPose;
  }

  /**
   * Writes the landmark positions and confidence colors. `hipsWorld` is the
   * solved hips world position (the landmarks are hip-centred). Passing a
   * null or absent pose hides the skeleton.
   */
  update(pose: FilteredPose | null, hipsWorld: Vector3): void {
    if (!pose || !pose.present || pose.world.length < POSE_LANDMARK_COUNT) {
      this.hasPose = false;
      this.applyVisibility();
      return;
    }
    this.hasPose = true;
    this.applyVisibility();
    const s = this.scale;
    const r = this.jointRadius * s;
    const conf = pose.confidence;

    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      const w = pose.world[i];
      const c = clamp01(conf[i] ?? 0);
      _p.set(hipsWorld.x + w.x * s, hipsWorld.y + w.y * s, hipsWorld.z + w.z * s);
      if (!Number.isFinite(_p.x) || !Number.isFinite(_p.y) || !Number.isFinite(_p.z)) {
        _m.makeScale(0, 0, 0);
      } else {
        // Ungated or out-of-frame joints shrink so their state is visible in 3D as well.
        const k = pose.gated[i] && pose.inFrame[i] ? r : r * 0.45;
        _m.makeScale(k, k, k).setPosition(_p);
      }
      this.joints.setMatrixAt(i, _m);
      confidenceColor(c, _rgb);
      this.joints.setColorAt(i, _c.setRGB(_rgb[0], _rgb[1], _rgb[2]));
    }
    this.joints.instanceMatrix.needsUpdate = true;
    if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true;

    const pos = this.linePositions.array as Float32Array;
    const col = this.lineColors.array as Float32Array;
    for (let k = 0; k < POSE_CONNECTIONS.length; k++) {
      const [a, b] = POSE_CONNECTIONS[k];
      const wa = pose.world[a];
      const wb = pose.world[b];
      const o = k * 6;
      const ok = finite3(wa) && finite3(wb);
      if (ok) {
        pos[o] = hipsWorld.x + wa.x * s;
        pos[o + 1] = hipsWorld.y + wa.y * s;
        pos[o + 2] = hipsWorld.z + wa.z * s;
        pos[o + 3] = hipsWorld.x + wb.x * s;
        pos[o + 4] = hipsWorld.y + wb.y * s;
        pos[o + 5] = hipsWorld.z + wb.z * s;
      } else {
        // Collapse the segment onto the hips so it draws nothing visible.
        pos[o] = pos[o + 3] = hipsWorld.x;
        pos[o + 1] = pos[o + 4] = hipsWorld.y;
        pos[o + 2] = pos[o + 5] = hipsWorld.z;
      }
      const c = Math.min(clamp01(conf[a] ?? 0), clamp01(conf[b] ?? 0));
      confidenceColor(c, _rgb);
      col[o] = col[o + 3] = _rgb[0];
      col[o + 1] = col[o + 4] = _rgb[1];
      col[o + 2] = col[o + 5] = _rgb[2];
    }
    this.linePositions.needsUpdate = true;
    this.lineColors.needsUpdate = true;
  }

  dispose(): void {
    this.object.parent?.remove(this.object);
    this.lines.geometry.dispose();
    this.lineMaterial.dispose();
    this.jointGeometry.dispose();
    this.jointMaterial.dispose();
    this.joints.dispose();
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

function finite3(v: Vector3 | undefined): v is Vector3 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
