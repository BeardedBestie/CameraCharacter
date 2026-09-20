/**
 * ClipRecorder: samples the solved skeleton (local quaternions per mapped role
 * and the hips' local position) onto a uniform time grid and converts the
 * resulting Take into a THREE.AnimationClip (docs/DESIGN.md §9).
 *
 * No DOM; three.js math and animation classes only, so it runs in Node.
 */
import {
  AnimationClip,
  type Object3D,
  PropertyBinding,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
} from 'three';
import type { Take, TakeSample } from '../core/types';

export class ClipRecorder {
  private readonly header: Omit<Take, 'samples' | 't0'>;
  private readonly fps: number;
  private samples: TakeSample[] = [];
  /** Distance (seconds) of the last stored sample from its grid time. */
  private lastSlotError = Infinity;
  private t0 = 0;
  private recording = false;

  constructor(header: Omit<Take, 'samples' | 't0'>, fps: number) {
    if (!(fps > 0)) throw new Error(`ClipRecorder: fps must be positive, got ${fps}`);
    this.header = header;
    this.fps = fps;
  }

  /** Starts a take; `t0` = performance.now() at start (shared with the other recorders). */
  start(t0: number): void {
    this.t0 = t0;
    this.samples = [];
    this.lastSlotError = Infinity;
    this.recording = true;
  }

  /**
   * Adds a sample. `sample.t` is seconds since the take started. Samples are
   * snapped to the nearest grid time k/fps: a second sample for a slot that is
   * already filled replaces it only when it is closer to the grid time
   * (samples arriving faster than fps are dropped); slots skipped by a gap are
   * filled by holding the previous sample so the take stays uniform.
   * Arrays are copied, so callers may reuse their buffers.
   */
  push(sample: TakeSample): void {
    if (!this.recording) return;
    const t = sample.t;
    if (!Number.isFinite(t)) return;
    const slot = Math.max(0, Math.round(t * this.fps));
    const slotTime = slot / this.fps;
    const err = Math.abs(t - slotTime);
    const n = this.samples.length;
    if (n > 0 && slot < n - 1) return; // arrived late for an older slot: drop
    if (n > 0 && slot === n - 1) {
      if (err < this.lastSlotError) {
        this.samples[n - 1] = copySample(sample, slotTime);
        this.lastSlotError = err;
      }
      return;
    }
    // Fill any gap by holding the previous sample.
    if (n > 0) {
      const prev = this.samples[n - 1];
      for (let k = n; k < slot; k++) this.samples.push(copySample(prev, k / this.fps));
    }
    this.samples.push(copySample(sample, slotTime));
    this.lastSlotError = err;
  }

  /** Stops and returns the Take. */
  stop(): Take {
    this.recording = false;
    const take: Take = {
      fps: this.fps,
      roles: [...this.header.roles],
      boneNames: [...this.header.boneNames],
      bindWorldQuat: this.header.bindWorldQuat.map((q) => [q[0], q[1], q[2], q[3]]),
      bindWorldPos: this.header.bindWorldPos.map((p) => [p[0], p[1], p[2]]),
      parentIndex: [...this.header.parentIndex],
      lengths: [...this.header.lengths],
      samples: this.samples,
      t0: this.t0,
    };
    this.samples = [];
    return take;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  get isRecording(): boolean {
    return this.recording;
  }
}

function copySample(s: TakeSample, t: number): TakeSample {
  return {
    t,
    local: new Float32Array(s.local),
    world: new Float32Array(s.world),
    hipsLocal: [s.hipsLocal[0], s.hipsLocal[1], s.hipsLocal[2]],
    hipsWorld: [s.hipsWorld[0], s.hipsWorld[1], s.hipsWorld[2]],
  };
}

/**
 * Converts a Take into an AnimationClip: one QuaternionKeyframeTrack per role
 * named `${bone.uuid}.quaternion` (uuids, because names collide between meshes
 * and bones and `PropertyBinding.findNode` matches uuids) and one
 * VectorKeyframeTrack `${hips.uuid}.position` from the hips' local position.
 * `bones` must be in the same order as `take.roles`.
 */
export function takeToAnimationClip(take: Take, bones: Object3D[], hips: Object3D, name = 'take'): AnimationClip {
  const n = take.samples.length;
  const roleCount = take.roles.length;
  if (bones.length !== roleCount) {
    throw new Error(`takeToAnimationClip: ${bones.length} bones given for ${roleCount} roles`);
  }
  if (n === 0) throw new Error('takeToAnimationClip: the take has no samples');
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = take.samples[i].t;
  const tracks = [];
  for (let r = 0; r < roleCount; r++) {
    const values = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const src = take.samples[i].local;
      if (src.length < roleCount * 4) throw new Error(`takeToAnimationClip: sample ${i} has ${src.length} local values, expected ${roleCount * 4}`);
      values[i * 4] = src[r * 4];
      values[i * 4 + 1] = src[r * 4 + 1];
      values[i * 4 + 2] = src[r * 4 + 2];
      values[i * 4 + 3] = src[r * 4 + 3];
    }
    tracks.push(new QuaternionKeyframeTrack(`${bones[r].uuid}.quaternion`, times, values));
  }
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = take.samples[i].hipsLocal;
    pos[i * 3] = p[0];
    pos[i * 3 + 1] = p[1];
    pos[i * 3 + 2] = p[2];
  }
  tracks.push(new VectorKeyframeTrack(`${hips.uuid}.position`, times, pos));
  return new AnimationClip(name, -1, tracks);
}

/** The node part of a track name (`<uuid>.quaternion` -> `<uuid>`). */
export function trackNodeName(trackName: string): string {
  const parsed = PropertyBinding.parseTrackName(trackName);
  return parsed.nodeName ?? '';
}

/**
 * Throws unless every track of the clip resolves to a node under `root`
 * (the export root: the model wrapper group), the same way GLTFExporter
 * resolves them (`PropertyBinding.findNode`, matching name or uuid).
 */
export function assertTracksResolvable(clip: AnimationClip, root: Object3D): void {
  const missing: string[] = [];
  for (const track of clip.tracks) {
    const nodeName = trackNodeName(track.name);
    const node = nodeName ? PropertyBinding.findNode(root, nodeName) : null;
    if (!node) missing.push(track.name);
  }
  if (missing.length > 0) {
    throw new Error(
      `AnimationClip "${clip.name}": ${missing.length} track(s) do not resolve under the export root "${root.name || root.uuid}": ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`,
    );
  }
}
