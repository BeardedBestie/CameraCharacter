/**
 * Retargeter: the world-delta solver (docs/DESIGN.md §6.3).
 *
 * For every mapped role, parent first, the measured basis is compared with
 * the reference basis of the bone's mode; the resulting world rotation is
 * split into swing and twist about the pre-rotation axis, the twist is
 * low-passed and weighted by the up-reference confidence, and the delta is
 * applied on top of the bone's bind-pose WORLD orientation. The local
 * quaternion is recovered through the solver's own world chain (seeded from
 * the hips' parent and composed through every intermediate node), so the
 * rig's local axis conventions never enter the math.
 *
 * The hot path allocates nothing: results, scratch vectors and quaternions
 * are reused between frames. Copy what must outlive the next call.
 */
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { FilteredPose } from '../core/pose';
import type {
  BoneRefMode,
  BoneSettings,
  FramingFit,
  FramingState,
  HipsMode,
  HumanoidBone,
  PoseCalibration,
  QuatTuple,
  RefBasisRecord,
  RigAnalysis,
  SmoothingSettings,
  Take,
  TakeSample,
  Vec3Tuple,
} from '../core/types';
import { BODY_BONES, HUMANOID_PARENT, HUMANOID_SOLVE_ORDER, TORSO_BONES, boneSide } from '../core/types';
import { OneEuroFilter, RAD2DEG, angleBetween, clamp, expFactor, quatAngle, quatFromDirUp, slerpShortest, swingTwist } from '../core/math';
import { LM } from '../tracking/landmarks';
import type { BodyModelResult, MeasuredBasis } from './bodyModel';
import { RunningMedian } from './bodyModel';
import { CANONICAL } from './canonical';
import { canonicalUpMinRotated, effectiveTorsoBaseline, referenceBasisFor } from './calibration';

export interface RetargeterOptions {
  /** Mapped three.js nodes by role (in their bind pose, matrixWorld up to date). */
  bones: Partial<Record<HumanoidBone, Object3D>>;
  analysis: RigAnalysis;
  settings: SmoothingSettings;
  boneSettings: Partial<Record<HumanoidBone, BoneSettings>>;
  calibration?: PoseCalibration | null;
  hipsMode: HipsMode;
  /** Webcam vertical field of view (degrees): sets the absolute depth scale. */
  cameraVfovDeg: number;
  /** Apply the depth estimate to the hips translation (false when the mirror camera consumes it). Default true. */
  depthTranslation?: boolean;
  /** Standing torso baseline from `StandingBaseline` (optional; the calibration's baseline wins). */
  torsoBaseline?: RefBasisRecord | null;
  /**
   * Standing bases of the neck and head from `StandingBaseline` (optional). In
   * `relative` mode their pitch relative to the torso baseline is folded into
   * the reference, so a level head drives the model's head to its bind pose
   * (MediaPipe's eye landmarks sit above the ears, which tilts the raw head
   * basis back).
   */
  standingBases?: Partial<Record<HumanoidBone, RefBasisRecord>> | null;
}

export interface SolveRoleResult {
  worldQuat: Quaternion;
  localQuat: Quaternion;
  measuredDir: Vector3 | null;
  solvedDir: Vector3 | null;
  errorDeg: number | null;
  confidence: number;
  cU: number;
  mode: BoneRefMode;
  source: string;
}

export interface SolveResult {
  roles: HumanoidBone[];
  perRole: Partial<Record<HumanoidBone, SolveRoleResult>>;
  chainErrorDeg: { leftArm: number | null; rightArm: number | null; leftLeg: number | null; rightLeg: number | null };
  hipsWorldPos: Vector3;
  /** Estimated camera distance of the subject (meters), or null when no segment was usable. */
  depthZ: number | null;
  framing: FramingState;
}

/** Fraction of the upper arm swing applied to the shoulder (clavicle) bone. */
export const SHOULDER_SWING_FRACTION = 0.3;
/** Pronation fraction for rigs without forearm twist helpers: none (the hand takes all of it), per DESIGN §6.3. */
export const DEFAULT_LOWER_ARM_TWIST_FRACTION = 0;
/** Seconds of running history for the depth reference median. */
export const Z_REF_WINDOW_SEC = 20;
const Z_REF_SAMPLE_SEC = 0.1;
/** Seconds over which the vertical hips offset blends back in when the ankles return. */
const VERTICAL_BLEND_SEC = 1;
/**
 * Very slow decay (m/s) of the standing running max (DESIGN §6.3 asks for a
 * running max): a single noisy spike heals within a minute or two, while a
 * user who stays crouched does not see the model rise.
 */
const STANDING_MAX_DECAY = 0.001;

/** Preferred humanoid child used for a role's direction when the analysis gives none. */
const PREFERRED_CHILD: Partial<Record<HumanoidBone, readonly HumanoidBone[]>> = {
  hips: ['spine', 'chest', 'upperChest', 'neck', 'head'],
  spine: ['chest', 'upperChest', 'neck', 'head'],
  chest: ['upperChest', 'neck', 'head'],
  upperChest: ['neck', 'head'],
  neck: ['head'],
  leftShoulder: ['leftUpperArm'],
  leftUpperArm: ['leftLowerArm'],
  leftLowerArm: ['leftHand'],
  leftHand: ['leftMiddleProximal', 'leftIndexProximal', 'leftRingProximal'],
  rightShoulder: ['rightUpperArm'],
  rightUpperArm: ['rightLowerArm'],
  rightLowerArm: ['rightHand'],
  rightHand: ['rightMiddleProximal', 'rightIndexProximal', 'rightRingProximal'],
  leftUpperLeg: ['leftLowerLeg'],
  leftLowerLeg: ['leftFoot'],
  leftFoot: ['leftToes'],
  rightUpperLeg: ['rightLowerLeg'],
  rightLowerLeg: ['rightFoot'],
  rightFoot: ['rightToes'],
};

/** Depth segments: landmark pairs whose camera-plane length is compared with their image length. */
const DEPTH_SEGMENTS: readonly [number, number][] = [
  [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
  [LM.LEFT_SHOULDER, LM.LEFT_HIP],
  [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
  [LM.LEFT_HIP, LM.RIGHT_HIP],
  [LM.LEFT_SHOULDER, LM.LEFT_ELBOW],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
];

interface TorsoLink {
  node: Object3D;
  entry: RoleEntry | null;
  restQ: Quaternion;
  bindLocalQ: Quaternion;
  /** Cumulative chain-length fraction at the link's tail (0..1]. */
  fraction: number;
  rK: Quaternion;
}

interface RoleEntry {
  role: HumanoidBone;
  bone: Object3D;
  parent: RoleEntry | null;
  intermediates: Object3D[];
  /** Torso links driven by the spine distribution, parallel to `intermediates` (null = holds its local). */
  interLinks: (TorsoLink | null)[];
  childEntry: RoleEntry | null;
  bindLocalQ: Quaternion;
  bindLocalPos: Vector3;
  restQ: Quaternion;
  restQInv: Quaternion;
  restPos: Vector3;
  restDir: Vector3;
  length: number;
  mode: BoneRefMode;
  rollOffsetDeg: number;
  smoothing: number;
  refD: Vector3 | null;
  refU: Vector3 | null;
  qRefInv: Quaternion;
  twist: Quaternion;
  prevLocalTarget: Quaternion;
  hasPrevTarget: boolean;
  torsoLink: TorsoLink | null;
  isTorsoChain: boolean;
  // per frame
  driven: boolean;
  relax: boolean;
  c: number;
  cU: number;
  source: string;
  measuredD: Vector3;
  hasMeasured: boolean;
  rPrime: Quaternion;
  swing: Quaternion;
  qNow: Quaternion;
  mNow: Matrix4;
  out: SolveRoleResult;
}

const IDENTITY = new Quaternion();

export class Retargeter {
  private settings: SmoothingSettings;
  private boneSettings: Partial<Record<HumanoidBone, BoneSettings>>;
  private calibration: PoseCalibration | null;
  private hipsMode: HipsMode;
  private cameraVfovDeg: number;
  private depthTranslation: boolean;
  private standingBaseline: RefBasisRecord | null;
  private standingBases: Partial<Record<HumanoidBone, RefBasisRecord>> | null;
  private readonly analysis: RigAnalysis;
  /** Shoulder/upper-arm pairs for the clavicle share of the arm swing (built once). */
  private readonly shoulderPairs: { shoulder: RoleEntry; upperArm: RoleEntry }[] = [];

  private readonly entries: RoleEntry[] = [];
  private readonly byRole = new Map<HumanoidBone, RoleEntry>();
  private readonly hips: RoleEntry | null;
  private readonly hipsParent: Object3D | null;
  private readonly torsoLinks: TorsoLink[] = [];
  private torsoTop: RoleEntry | null = null;
  private refsDirty = true;
  private readonly t5 = new Quaternion();
  private readonly result: SolveResult;

  // hips translation state
  private readonly zFilter: OneEuroFilter;
  private readonly xFilter: OneEuroFilter;
  private readonly zRefMedian = new RunningMedian(Math.round(Z_REF_WINDOW_SEC / Z_REF_SAMPLE_SEC));
  private zRefSampleAccum = 0;
  private elapsed = 0;
  private standingMax = NaN;
  private verticalOffset = 0;
  private heldVertical = 0;
  private verticalBlend = 0;
  private readonly hipsTarget = new Vector3();
  private hipsTargetValid = false;
  private depthZ: number | null = null;
  /** Rig leg geometry for the vertical policy: thigh head -> ankle length, hips bone -> thigh head drop, ankle rest height. */
  private modelLeg = 0;
  private hipJointDrop = 0;
  private ankleRest = 0;

  constructor(opts: RetargeterOptions) {
    this.settings = opts.settings;
    this.boneSettings = opts.boneSettings;
    this.calibration = opts.calibration ?? null;
    this.hipsMode = opts.hipsMode;
    this.cameraVfovDeg = opts.cameraVfovDeg;
    this.depthTranslation = opts.depthTranslation ?? true;
    this.standingBaseline = opts.torsoBaseline ?? null;
    this.standingBases = opts.standingBases ?? null;
    this.analysis = opts.analysis;
    this.zFilter = new OneEuroFilter({ minCutoff: 1.0, beta: 0.5, dCutoff: 1.0 });
    this.xFilter = new OneEuroFilter({ minCutoff: 1.0, beta: 0.5, dCutoff: 1.0 });

    const hipsBone = opts.bones.hips ?? null;
    this.hipsParent = hipsBone?.parent ?? null;
    // Bind transforms are read from the nodes' local TRS (DESIGN §5.3 wrote them); refresh the world
    // matrices of the whole skeleton from those locals so stale matrices never leak into rest data.
    if (hipsBone) hipsBone.updateWorldMatrix(true, true);

    // Entries in parent-first order (canonical order, then verified against the hierarchy).
    const mapped = new Map<Object3D, HumanoidBone>();
    for (const role of BODY_BONES) {
      const b = opts.bones[role];
      if (b) mapped.set(b, role);
    }
    for (const role of HUMANOID_SOLVE_ORDER) {
      const bone = opts.bones[role];
      if (!bone || !mapped.has(bone) || mapped.get(bone) !== role) continue;
      const entry = this.makeEntry(role, bone);
      this.entries.push(entry);
      this.byRole.set(role, entry);
    }
    // Parents and intermediates from the real hierarchy.
    for (const e of this.entries) {
      const inter: Object3D[] = [];
      let p = e.bone.parent;
      let parentEntry: RoleEntry | null = null;
      while (p) {
        const r = mapped.get(p);
        if (r !== undefined && this.byRole.has(r)) {
          parentEntry = this.byRole.get(r)!;
          break;
        }
        if (p === this.hipsParent) break;
        inter.push(p);
        p = p.parent;
      }
      inter.reverse();
      e.parent = parentEntry;
      e.intermediates = inter;
      e.interLinks = inter.map(() => null);
    }
    this.sortParentFirst();
    for (const e of this.entries) e.childEntry = this.findChild(e);
    this.hips = this.byRole.get('hips') ?? null;
    this.buildTorsoChain();
    for (const side of ['left', 'right'] as const) {
      const shoulder = this.byRole.get(`${side}Shoulder`);
      const upperArm = this.byRole.get(`${side}UpperArm`);
      if (shoulder && upperArm) this.shoulderPairs.push({ shoulder, upperArm });
    }

    const perRole: Partial<Record<HumanoidBone, SolveRoleResult>> = {};
    for (const e of this.entries) perRole[e.role] = e.out;
    this.result = {
      roles: this.entries.map((e) => e.role),
      perRole,
      chainErrorDeg: { leftArm: null, rightArm: null, leftLeg: null, rightLeg: null },
      hipsWorldPos: new Vector3(),
      depthZ: null,
      framing: 'none',
    };
    if (this.hips) this.result.hipsWorldPos.copy(this.hips.restPos);
    this.measureLegs();
    this.rebuildReferences();
  }

  /** Vertical leg geometry of the rig (mean over the mapped sides; height-table fallbacks). */
  private measureLegs(): void {
    const ht = this.analysis.heightTable;
    let legs = 0;
    let legSum = 0;
    let dropSum = 0;
    let ankleSum = 0;
    for (const side of ['left', 'right'] as const) {
      const upper = this.byRole.get(`${side}UpperLeg`);
      const foot = this.byRole.get(`${side}Foot`) ?? this.byRole.get(`${side}LowerLeg`);
      if (!upper || !foot || !this.hips) continue;
      let ankleY = foot.restPos.y;
      if (foot.role !== `${side}Foot`) ankleY = foot.restPos.y + foot.restDir.y * Math.max(foot.length, 0);
      const leg = upper.restPos.y - ankleY;
      if (!(leg > 1e-3)) continue;
      legs++;
      legSum += leg;
      dropSum += this.hips.restPos.y - upper.restPos.y;
      ankleSum += ankleY;
    }
    if (legs > 0) {
      this.modelLeg = legSum / legs;
      this.hipJointDrop = dropSum / legs;
      this.ankleRest = ankleSum / legs;
    } else {
      this.modelLeg = Math.max(ht.hips - ht.ankles, 1e-3);
      this.hipJointDrop = 0;
      this.ankleRest = ht.ankles;
    }
  }

  // ------------------------------------------------------------------ setup

  private makeEntry(role: HumanoidBone, bone: Object3D): RoleEntry {
    const a = this.analysis.analysis[role];
    const restQ = new Quaternion();
    const restPos = new Vector3();
    const restDir = new Vector3();
    let length = 0;
    if (a) {
      restQ.fromArray(a.restQuat).normalize();
      restPos.fromArray(a.restPos);
      restDir.fromArray(a.restDir).normalize();
      length = a.length;
    } else {
      bone.updateWorldMatrix(true, false);
      bone.matrixWorld.decompose(restPos, restQ, _scale);
      restDir.fromArray(CANONICAL[role].dir);
    }
    if (restDir.lengthSq() < 1e-8) restDir.fromArray(CANONICAL[role].dir);
    const bs = this.boneSettings[role] ?? this.analysis.defaultBones[role];
    return {
      role,
      bone,
      parent: null,
      intermediates: [],
      interLinks: [],
      childEntry: null,
      bindLocalQ: bone.quaternion.clone(),
      bindLocalPos: bone.position.clone(),
      restQ,
      restQInv: restQ.clone().invert(),
      restPos,
      restDir,
      length,
      mode: bs?.mode ?? (TORSO_BONES.includes(role) ? 'relative' : 'auto'),
      rollOffsetDeg: bs?.rollOffsetDeg ?? 0,
      smoothing: bs?.smoothing ?? 1,
      refD: null,
      refU: null,
      qRefInv: new Quaternion(),
      twist: new Quaternion(),
      prevLocalTarget: new Quaternion(),
      hasPrevTarget: false,
      torsoLink: null,
      isTorsoChain: false,
      driven: false,
      relax: false,
      c: 0,
      cU: 0,
      source: 'none',
      measuredD: new Vector3(),
      hasMeasured: false,
      rPrime: new Quaternion(),
      swing: new Quaternion(),
      qNow: restQ.clone(),
      mNow: new Matrix4(),
      out: {
        worldQuat: restQ.clone(),
        localQuat: bone.quaternion.clone(),
        measuredDir: null,
        solvedDir: null,
        errorDeg: null,
        confidence: 0,
        cU: 0,
        mode: bs?.mode ?? 'auto',
        source: 'none',
      },
    };
  }

  private sortParentFirst(): void {
    const depth = (e: RoleEntry): number => {
      let d = 0;
      let p = e.parent;
      while (p) {
        d++;
        p = p.parent;
      }
      return d;
    };
    const order = this.entries.map((e, i) => ({ e, i, d: depth(e) }));
    order.sort((a, b) => a.d - b.d || a.i - b.i);
    this.entries.length = 0;
    for (const o of order) this.entries.push(o.e);
  }

  private findChild(e: RoleEntry): RoleEntry | null {
    const a = this.analysis.analysis[e.role];
    if (a?.childRole) {
      const c = this.byRole.get(a.childRole);
      if (c) return c;
    }
    for (const r of PREFERRED_CHILD[e.role] ?? []) {
      const c = this.byRole.get(r);
      if (c) return c;
    }
    return null;
  }

  private buildTorsoChain(): void {
    const chainRoles: HumanoidBone[] = ['spine', 'chest', 'upperChest'];
    const torsoEntries = chainRoles.map((r) => this.byRole.get(r)).filter((e): e is RoleEntry => !!e);
    if (!this.hips || torsoEntries.length === 0) return;
    // Nodes from the hips (exclusive) to the top torso bone (inclusive).
    const nodes: { node: Object3D; entry: RoleEntry | null }[] = [];
    for (const e of torsoEntries) {
      for (const n of e.intermediates) nodes.push({ node: n, entry: null });
      nodes.push({ node: e.bone, entry: e });
      e.isTorsoChain = true;
    }
    this.torsoTop = torsoEntries[torsoEntries.length - 1];
    // Head positions (rest) and tail of the top link.
    const heads = nodes.map(({ node, entry }) => (entry ? entry.restPos.clone() : new Vector3().setFromMatrixPosition(node.matrixWorld)));
    const neck = this.byRole.get('neck') ?? this.byRole.get('head');
    const top = this.torsoTop;
    const tail = neck ? neck.restPos.clone() : top.restPos.clone().addScaledVector(top.restDir, Math.max(top.length, 1e-3));
    const lengths: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const next = i + 1 < nodes.length ? heads[i + 1] : tail;
      lengths.push(Math.max(next.distanceTo(heads[i]), 1e-4));
    }
    const total = lengths.reduce((s, l) => s + l, 0);
    let cum = 0;
    for (let i = 0; i < nodes.length; i++) {
      cum += lengths[i];
      const { node, entry } = nodes[i];
      const restQ = entry ? entry.restQ.clone() : new Quaternion().setFromRotationMatrix(_rotOnly.extractRotation(node.matrixWorld));
      const link: TorsoLink = {
        node,
        entry,
        restQ,
        bindLocalQ: node.quaternion.clone(),
        fraction: i === nodes.length - 1 ? 1 : cum / total,
        rK: new Quaternion(),
      };
      this.torsoLinks.push(link);
      if (entry) entry.torsoLink = link;
    }
    // Attach intermediate links to the entry whose parent walk passes them.
    for (const e of torsoEntries) {
      for (let i = 0; i < e.intermediates.length; i++) {
        const link = this.torsoLinks.find((l) => l.node === e.intermediates[i]) ?? null;
        e.interLinks[i] = link;
      }
    }
  }

  private rebuildReferences(): void {
    const baseline = effectiveTorsoBaseline(this.calibration, this.standingBaseline);
    quatFromDirUp(_v1.fromArray(baseline.d), _v2.fromArray(baseline.u), _qa);
    const c = CANONICAL.hips;
    quatFromDirUp(_v1.fromArray(c.restDir), _v2.fromArray(c.restUp), _qb);
    this.t5.copy(_qa).multiply(_qb.invert());
    for (const e of this.entries) {
      const bs = this.boneSettings[e.role] ?? this.analysis.defaultBones[e.role];
      e.mode = bs?.mode ?? (TORSO_BONES.includes(e.role) ? 'relative' : 'auto');
      e.rollOffsetDeg = bs?.rollOffsetDeg ?? 0;
      e.smoothing = bs?.smoothing ?? 1;
      e.out.mode = e.mode;
      const ref = referenceBasisFor(e.role, e.mode, this.analysis, this.calibration, e.rollOffsetDeg);
      if (!ref) {
        e.refD = null;
        e.refU = null;
        continue;
      }
      if (e.mode === 'auto') this.applyChordReference(e, ref);
      e.refD = ref.d;
      e.refU = ref.u;
      quatFromDirUp(ref.d, ref.u, _qa);
      const torsoLike = TORSO_BONES.includes(e.role);
      if (torsoLike && e.mode !== 'calibrated') {
        if (e.role === 'neck' || e.role === 'head') this.applyPitchBaseline(e.role, baseline, _qa);
        _qa.premultiply(this.t5);
      }
      e.qRefInv.copy(_qa).invert();
    }
    this.refsDirty = false;
  }

  /**
   * No-knee / no-elbow chains (DESIGN §5.4, §6.2): the lower bone is driven
   * from the chord (upper head -> end head), so its reference direction is the
   * rig's bind chord rather than the bone's own direction; the upper bone
   * follows. The up reference is re-orthogonalized against the chord.
   */
  private applyChordReference(e: RoleEntry, ref: { d: Vector3; u: Vector3 }): void {
    const side = boneSide(e.role);
    if (side === 'center') return;
    let upper: HumanoidBone;
    let end: HumanoidBone;
    if (e.role === 'leftLowerLeg' || e.role === 'rightLowerLeg') {
      if (!this.analysis.noKnee[side]) return;
      upper = `${side}UpperLeg`;
      end = `${side}Foot`;
    } else if (e.role === 'leftLowerArm' || e.role === 'rightLowerArm') {
      if (!this.analysis.noElbow[side]) return;
      upper = `${side}UpperArm`;
      end = `${side}Hand`;
    } else return;
    const up = this.byRole.get(upper);
    if (!up) return;
    const endEntry = this.byRole.get(end);
    if (endEntry) _v1.copy(endEntry.restPos);
    else _v1.copy(e.restPos).addScaledVector(e.restDir, Math.max(e.length, 1e-3));
    _v1.sub(up.restPos);
    if (_v1.lengthSq() < 1e-8) return;
    ref.d.copy(_v1.normalize());
    ref.u.addScaledVector(ref.d, -ref.u.dot(ref.d));
    if (ref.u.lengthSq() < 1e-8) canonicalUpMinRotated(e.role, ref.d, ref.u);
    ref.u.normalize();
  }

  /**
   * Folds the standing pitch of the neck/head (relative to the torso
   * baseline, about the lateral axis only, so the head's yaw and roll during
   * the baseline window are not baked in) into the reference frame `q`.
   */
  private applyPitchBaseline(role: HumanoidBone, torso: RefBasisRecord, q: Quaternion): void {
    const sb = this.standingBases?.[role];
    if (!sb) return;
    quatFromDirUp(_v1.fromArray(torso.d), _v2.fromArray(torso.u), _qb);
    quatFromDirUp(_v1.fromArray(sb.d), _v2.fromArray(sb.u), _qc);
    if (_v1.lengthSq() < 1e-8) return;
    // Standing basis expressed in the torso frame (x = up, y = lateral, z = forward).
    _qRel.copy(_qb).invert().multiply(_qc);
    swingTwist(_qRel, _LATERAL, _qSwing, _qTwist);
    q.multiply(_qTwist);
  }

  // --------------------------------------------------------------- settings

  setSettings(settings: SmoothingSettings): void {
    this.settings = settings;
  }

  setBoneSettings(boneSettings: Partial<Record<HumanoidBone, BoneSettings>>): void {
    this.boneSettings = boneSettings;
    this.refsDirty = true;
  }

  setHipsMode(mode: HipsMode): void {
    this.hipsMode = mode;
  }

  setCalibration(calibration: PoseCalibration | null): void {
    this.calibration = calibration;
    this.refsDirty = true;
  }

  /** Standing baseline from `StandingBaseline` (ignored when the calibration carries one). */
  setTorsoBaseline(baseline: RefBasisRecord | null): void {
    this.standingBaseline = baseline;
    this.refsDirty = true;
  }

  /** Standing neck/head bases from `StandingBaseline` (pitch correction for `relative` mode). */
  setStandingBases(bases: Partial<Record<HumanoidBone, RefBasisRecord>> | null): void {
    this.standingBases = bases;
    this.refsDirty = true;
  }

  setCameraVfovDeg(deg: number): void {
    this.cameraVfovDeg = deg;
  }

  setDepthTranslation(enabled: boolean): void {
    this.depthTranslation = enabled;
  }

  get roles(): readonly HumanoidBone[] {
    return this.result.roles;
  }

  boneOf(role: HumanoidBone): Object3D | null {
    return this.byRole.get(role)?.bone ?? null;
  }

  /** Reference basis currently in use for a role (null for follow/off). */
  referenceOf(role: HumanoidBone): { d: Vector3; u: Vector3; mode: BoneRefMode } | null {
    if (this.refsDirty) this.rebuildReferences();
    const e = this.byRole.get(role);
    if (!e || !e.refD || !e.refU) return null;
    return { d: e.refD, u: e.refU, mode: e.mode };
  }

  /**
   * Places the hips at a WORLD position through the parent's local space (the
   * same conversion the translation policy uses). Useful for spawn points and tests.
   */
  placeHips(worldPos: Vector3): void {
    const hips = this.hips;
    if (!hips) return;
    this.hipsTarget.copy(worldPos);
    this.hipsTargetValid = true;
    this.result.hipsWorldPos.copy(worldPos);
    if (this.hipsParent) hips.bone.position.copy(this.hipsParent.worldToLocal(_p.copy(worldPos)));
    else hips.bone.position.copy(worldPos);
  }

  /** Puts every mapped bone back into its bind local transform and clears the filters. */
  reset(): void {
    for (const e of this.entries) {
      e.bone.quaternion.copy(e.bindLocalQ);
      e.bone.position.copy(e.bindLocalPos);
      e.twist.identity();
      e.hasPrevTarget = false;
      e.qNow.copy(e.restQ);
    }
    for (const l of this.torsoLinks) l.node.quaternion.copy(l.bindLocalQ);
    this.zFilter.reset();
    this.xFilter.reset();
    this.zRefMedian.reset();
    this.zRefSampleAccum = 0;
    this.elapsed = 0;
    this.standingMax = NaN;
    this.verticalOffset = 0;
    this.heldVertical = 0;
    this.verticalBlend = 0;
    this.hipsTargetValid = false;
    this.depthZ = null;
    if (this.hips) this.result.hipsWorldPos.copy(this.hips.restPos);
  }

  // ------------------------------------------------------------------ solve

  solve(result: BodyModelResult, pose: FilteredPose, dt: number, framing: FramingFit): SolveResult {
    if (this.refsDirty) this.rebuildReferences();
    const R = this.result;
    R.framing = framing.state;
    if (dt > 0) this.elapsed += dt;

    // Seed the world chain from the hips' parent (armature/wrapper transforms included).
    if (this.hipsParent) {
      this.hipsParent.getWorldQuaternion(_seedQ);
      _seedM.copy(this.hipsParent.matrixWorld);
    } else {
      _seedQ.identity();
      _seedM.identity();
    }

    // ---- pass 1: world deltas
    for (const e of this.entries) {
      e.driven = false;
      e.relax = false;
      e.c = 0;
      e.cU = 0;
      e.source = 'none';
      e.hasMeasured = false;
    }
    this.torsoDeltas(result);
    for (const e of this.entries) {
      if (e.isTorsoChain || e.role === 'hips') continue;
      if (e.mode === 'off' || e.mode === 'follow') continue;
      const basis = result.bases[e.role];
      if (!basis) continue;
      this.genericDelta(e, basis, dt);
    }
    this.combineShoulders();
    this.resolveFollow();

    // ---- pass 2: parent-first application through the solver's world chain
    for (const e of this.entries) {
      this.composeParent(e, dt);
      if (e === this.hips) this.hipsTranslation(result, pose, dt, framing);
      this.applyEntry(e, dt);
      e.qNow.multiplyQuaternions(_qP, e.bone.quaternion);
      _local.compose(e.bone.position, e.bone.quaternion, e.bone.scale);
      e.mNow.multiplyMatrices(_mP, _local);
    }

    // ---- pass 3: diagnostics
    this.finishResults(result);
    R.depthZ = this.depthZ;
    return R;
  }

  private torsoDeltas(result: BodyModelResult): void {
    const hips = this.hips;
    if (!hips) return;
    const hb = result.torso.hips;
    const sb = result.torso.shoulders;
    // R_hips relative to the baseline-adjusted reference.
    hips.c = hb.c;
    hips.cU = hb.cU;
    hips.source = hb.source;
    hips.measuredD.copy(hb.d);
    hips.hasMeasured = true;
    if (hips.mode === 'off' || hips.mode === 'follow' || !hips.refD) {
      hips.c = 0;
      hips.hasMeasured = false;
    } else if (hb.c > 0) {
      quatFromDirUp(hb.d, hb.u, _qMeas);
      hips.rPrime.multiplyQuaternions(_qMeas, hips.qRefInv);
      hips.swing.copy(hips.rPrime);
      hips.driven = true;
    } else {
      hips.relax = true;
    }
    const top = this.torsoTop;
    if (!top || this.torsoLinks.length === 0) return;
    let rTopOk = false;
    if (top.refD && sb.c > 0) {
      quatFromDirUp(sb.d, sb.u, _qMeas);
      _rTop.multiplyQuaternions(_qMeas, top.qRefInv);
      rTopOk = true;
    }
    const rHipsOk = hips.driven;
    const c = Math.min(hb.c, sb.c);
    for (const link of this.torsoLinks) {
      if (rTopOk && rHipsOk) link.rK.copy(hips.rPrime).slerp(_rTop, link.fraction);
      else if (rTopOk) link.rK.copy(_rTop);
      else if (rHipsOk) link.rK.copy(hips.rPrime);
      else link.rK.identity();
      const e = link.entry;
      if (!e) continue;
      e.measuredD.copy(sb.d);
      e.hasMeasured = rTopOk;
      e.source = sb.source;
      e.cU = sb.cU;
      if (e.mode === 'off' || e.mode === 'follow') continue;
      if (rTopOk || rHipsOk) {
        e.c = rTopOk && rHipsOk ? c : rTopOk ? sb.c : hb.c;
        e.rPrime.copy(link.rK);
        e.swing.copy(link.rK);
        e.driven = e.c > 0;
        e.relax = !e.driven;
      } else {
        e.c = 0;
        e.relax = true;
      }
    }
  }

  private genericDelta(e: RoleEntry, basis: MeasuredBasis, dt: number): void {
    if (!e.refD) return;
    e.c = basis.c;
    e.cU = basis.cU;
    e.source = basis.source;
    e.measuredD.copy(basis.d);
    e.hasMeasured = true;
    if (!(basis.c > 0)) {
      e.relax = true;
      return;
    }
    quatFromDirUp(basis.d, basis.u, _qMeas);
    _R.multiplyQuaternions(_qMeas, e.qRefInv);
    swingTwist(_R, e.refD, e.swing, _T);
    if (e.role === 'leftLowerArm' || e.role === 'rightLowerArm') {
      // Forearm pronation split: only a fraction of the palm twist goes to the forearm; the hand takes the rest.
      const side = boneSide(e.role) as 'left' | 'right';
      const fraction = this.analysis.hasForearmTwist[side] ? this.settings.lowerArmTwistFraction : DEFAULT_LOWER_ARM_TWIST_FRACTION;
      _T2.copy(_T);
      _T.copy(IDENTITY).slerp(_T2, clamp(fraction, 0, 1));
    }
    let tau = this.settings.twistTau;
    if (e.role === 'neck' || e.role === 'head') {
      // Yaw is the head's primary signal: never slower than the swing response.
      tau = Math.min(tau, 1 / Math.max(this.settings.boneRate * e.smoothing, 1e-3));
    }
    const alpha = expFactor(1 / Math.max(tau, 1e-3), dt);
    const cU = clamp(basis.cU, 0, 1);
    if (cU > 0) slerpShortest(e.twist, _T, alpha * cU);
    if (cU < 1) slerpShortest(e.twist, IDENTITY, alpha * (1 - cU));
    e.rPrime.multiplyQuaternions(e.swing, e.twist);
    e.driven = true;
  }

  private combineShoulders(): void {
    for (let i = 0; i < this.shoulderPairs.length; i++) {
      const { shoulder: sh, upperArm: ua } = this.shoulderPairs[i];
      if (!sh.driven || !ua.driven) continue;
      _qa.copy(IDENTITY).slerp(ua.swing, SHOULDER_SWING_FRACTION);
      sh.rPrime.premultiply(_qa);
    }
  }

  private resolveFollow(): void {
    // Children first so a stub takes its driven child's delta (no-knee thighs), then parents.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.mode !== 'follow') continue;
      const src = e.childEntry;
      if (src && src.driven) this.follow(e, src);
    }
    for (const e of this.entries) {
      if (e.mode !== 'follow' || e.driven) continue;
      const src = e.parent;
      if (src && src.driven) this.follow(e, src);
      else if (src && src.relax) e.relax = true;
    }
  }

  private follow(e: RoleEntry, src: RoleEntry): void {
    e.rPrime.copy(src.rPrime);
    e.swing.copy(src.swing);
    e.c = src.c;
    e.cU = src.cU;
    e.source = 'follow';
    e.driven = true;
    e.hasMeasured = false;
  }

  /** Fills _qP / _mP with the world transform of the bone's direct parent, driving torso intermediates on the way. */
  private composeParent(e: RoleEntry, dt: number): void {
    if (e.parent) {
      _qP.copy(e.parent.qNow);
      _mP.copy(e.parent.mNow);
    } else {
      _qP.copy(_seedQ);
      _mP.copy(_seedM);
    }
    for (let i = 0; i < e.intermediates.length; i++) {
      const node = e.intermediates[i];
      const link = e.interLinks[i];
      if (link && e.isTorsoChain) {
        if (e.driven) {
          _qWT.multiplyQuaternions(link.rK, link.restQ);
          _qPinv.copy(_qP).invert();
          _qLT.multiplyQuaternions(_qPinv, _qWT);
          const k = expFactor(this.settings.boneRate * e.smoothing, dt) * e.c;
          slerpShortest(node.quaternion, _qLT, k);
        } else if (e.relax) {
          slerpShortest(node.quaternion, link.bindLocalQ, expFactor(this.settings.relaxRate, dt));
        }
      }
      _qP.multiply(node.quaternion);
      _local.compose(node.position, node.quaternion, node.scale);
      _mP.multiply(_local);
    }
  }

  private applyEntry(e: RoleEntry, dt: number): void {
    const bone = e.bone;
    if (e.driven) {
      _qWT.multiplyQuaternions(e.rPrime, e.restQ);
      _qPinv.copy(_qP).invert();
      _qLT.multiplyQuaternions(_qPinv, _qWT);
      let omega = 0;
      if (e.hasPrevTarget && dt > 0) omega = quatAngle(_qLT, e.prevLocalTarget) / dt;
      const rate = this.settings.boneRate * e.smoothing * (1 + this.settings.boneRateVelocityGain * omega);
      const k = expFactor(rate, dt) * clamp(e.c, 0, 1);
      slerpShortest(bone.quaternion, _qLT, k);
      e.prevLocalTarget.copy(_qLT);
      e.hasPrevTarget = true;
    } else if (e.mode === 'off') {
      slerpShortest(bone.quaternion, e.bindLocalQ, expFactor(this.settings.boneRate * e.smoothing, dt));
      e.hasPrevTarget = false;
    } else if (e.relax) {
      slerpShortest(bone.quaternion, e.bindLocalQ, expFactor(this.settings.relaxRate, dt));
      e.hasPrevTarget = false;
    }
  }

  // ------------------------------------------------------- hips translation

  private hipsTranslation(result: BodyModelResult, pose: FilteredPose, dt: number, framing: FramingFit): void {
    const hips = this.hips;
    if (!hips) return;
    const W = pose.size[0];
    const H = pose.size[1];
    const f = (H / 2) / Math.tan((this.cameraVfovDeg * Math.PI) / 360);
    const present = pose.present;

    // Depth from world-vs-image segment lengths (length-weighted median).
    let depth: number | null = null;
    if (present && W > 0 && H > 0) {
      let n = 0;
      let wsum = 0;
      for (let k = 0; k < DEPTH_SEGMENTS.length; k++) {
        const i = DEPTH_SEGMENTS[k][0];
        const j = DEPTH_SEGMENTS[k][1];
        if (!pose.gated[i] || !pose.gated[j] || !pose.inFrame[i] || !pose.inFrame[j]) continue;
        if (pose.confidence[i] <= 0 || pose.confidence[j] <= 0) continue;
        const a = pose.world[i];
        const b = pose.world[j];
        const lw = Math.hypot(a.x - b.x, a.y - b.y);
        const li = Math.hypot((pose.image[i].x - pose.image[j].x) * W, (pose.image[i].y - pose.image[j].y) * H);
        if (lw < 1e-4 || li < 1) continue;
        _zVals[n] = (f * lw) / li;
        _zW[n] = lw;
        wsum += lw;
        n++;
      }
      if (n > 0) {
        // insertion sort by z (n <= 6)
        for (let i = 0; i < n; i++) _zIdx[i] = i;
        for (let i = 1; i < n; i++) {
          const key = _zIdx[i];
          let j = i - 1;
          while (j >= 0 && _zVals[_zIdx[j]] > _zVals[key]) {
            _zIdx[j + 1] = _zIdx[j];
            j--;
          }
          _zIdx[j + 1] = key;
        }
        let acc = 0;
        let z = _zVals[_zIdx[n - 1]];
        for (let i = 0; i < n; i++) {
          acc += _zW[_zIdx[i]];
          if (acc >= wsum / 2) {
            z = _zVals[_zIdx[i]];
            break;
          }
        }
        depth = this.zFilter.filter(z, this.elapsed);
      }
    }
    this.depthZ = depth;
    if (depth !== null) {
      this.zRefSampleAccum += dt;
      if (this.zRefMedian.size === 0 || this.zRefSampleAccum >= Z_REF_SAMPLE_SEC) {
        this.zRefMedian.push(depth);
        this.zRefSampleAccum = 0;
      }
    }
    const zRef = this.calibration?.zRef ?? (this.zRefMedian.size > 0 ? this.zRefMedian.value() : depth);

    const state = framing.state;
    const locked = this.hipsMode === 'locked' || result.hipsLost || state === 'bust' || state === 'face' || state === 'none' || !present;
    const rest = hips.restPos;
    if (!this.hipsTargetValid) {
      this.hipsTarget.copy(rest);
      this.hipsTargetValid = true;
    }
    if (!locked) {
      // Lateral (metric, consistent with depth; the image x is already mirrored by the filter).
      const hl = LM.LEFT_HIP;
      const hr = LM.RIGHT_HIP;
      const z = depth ?? zRef ?? null;
      if (z !== null && pose.gated[hl] && pose.gated[hr] && pose.inFrame[hl] && pose.inFrame[hr]) {
        const xImg = 0.5 * (pose.image[hl].x + pose.image[hr].x);
        const x = ((xImg - 0.5) * W * z) / f;
        this.hipsTarget.x = rest.x + this.xFilter.filter(x, this.elapsed);
      }
      // Depth: the subject approaching the camera moves the model toward the viewer (+Z).
      if (this.depthTranslation && depth !== null && zRef !== null) this.hipsTarget.z = rest.z - (depth - zRef);
      else if (!this.depthTranslation) this.hipsTarget.z = rest.z;

      // Vertical from the ankles (world landmarks), only in full mode with both ankles gated and in frame.
      const al = LM.LEFT_ANKLE;
      const ar = LM.RIGHT_ANKLE;
      const anklesOk =
        this.hipsMode === 'full' && state === 'full' && pose.gated[al] && pose.gated[ar] && pose.inFrame[al] && pose.inFrame[ar];
      // The user's hips-above-ankles height (leg extension) maps onto the rig's thigh-head-to-ankle length.
      if (anklesOk) {
        const hipsHeight = -Math.min(pose.world[al].y, pose.world[ar].y);
        if (!Number.isFinite(this.standingMax) || hipsHeight > this.standingMax) this.standingMax = hipsHeight;
        else this.standingMax = Math.max(hipsHeight, this.standingMax - STANDING_MAX_DECAY * dt);
        const s = this.modelLeg / Math.max(this.standingMax, 1e-3);
        const measured = (hipsHeight - this.standingMax) * s;
        this.verticalBlend = Math.min(1, this.verticalBlend + dt / VERTICAL_BLEND_SEC);
        this.verticalOffset = this.heldVertical + (measured - this.heldVertical) * this.verticalBlend;
        if (this.verticalBlend >= 1) this.heldVertical = measured;
        let y = rest.y + this.verticalOffset;
        // Floor clamp: the predicted ankle (thigh heads sit `hipJointDrop` below the hips bone) never goes
        // below its rest height above the floor, so the soles stay on the floor.
        const ankleY = y - this.hipJointDrop - hipsHeight * s;
        if (ankleY < this.ankleRest) y = this.ankleRest + this.hipJointDrop + hipsHeight * s;
        this.hipsTarget.y = y;
      } else {
        this.heldVertical = this.verticalOffset;
        this.verticalBlend = 0;
        this.hipsTarget.y = rest.y + this.verticalOffset;
      }
    }
    if (this.hipsMode === 'locked') {
      this.hipsTarget.copy(rest);
    }
    const P = this.result.hipsWorldPos;
    P.copy(this.hipsTarget);
    if (this.hipsParent) {
      // World -> the parent's local space (a rotated or scaled armature must not turn a lift into a slide).
      hips.bone.position.copy(this.hipsParent.worldToLocal(_p.copy(P)));
    } else {
      hips.bone.position.copy(P);
    }
  }

  // ------------------------------------------------------------ diagnostics

  private finishResults(result: BodyModelResult): void {
    for (const e of this.entries) {
      const o = e.out;
      o.worldQuat.copy(e.qNow);
      o.localQuat.copy(e.bone.quaternion);
      o.confidence = e.c;
      o.cU = e.cU;
      o.mode = e.mode;
      o.source = e.source;
      if (e.hasMeasured) {
        o.measuredDir = (o.measuredDir ?? new Vector3()).copy(e.measuredD);
        o.solvedDir = this.solvedDirection(e, o.solvedDir ?? new Vector3());
        o.errorDeg = angleBetween(o.measuredDir, o.solvedDir) * RAD2DEG;
      } else {
        o.measuredDir = null;
        o.solvedDir = null;
        o.errorDeg = null;
      }
    }
    const ce = this.result.chainErrorDeg;
    const J = result.joints;
    ce.leftArm = this.chainError('leftUpperArm', 'leftLowerArm', 'leftHand', J[LM.LEFT_SHOULDER], J[LM.LEFT_WRIST], result.bases.leftUpperArm);
    ce.rightArm = this.chainError('rightUpperArm', 'rightLowerArm', 'rightHand', J[LM.RIGHT_SHOULDER], J[LM.RIGHT_WRIST], result.bases.rightUpperArm);
    ce.leftLeg = this.chainError('leftUpperLeg', 'leftLowerLeg', 'leftFoot', J[LM.LEFT_HIP], J[LM.LEFT_ANKLE], result.bases.leftUpperLeg);
    ce.rightLeg = this.chainError('rightUpperLeg', 'rightLowerLeg', 'rightFoot', J[LM.RIGHT_HIP], J[LM.RIGHT_ANKLE], result.bases.rightUpperLeg);
  }

  /**
   * Actual world direction of a bone from the solver's world chain (child
   * position minus bone position). A chord-driven bone (no-knee / no-elbow)
   * reports the rig chord from its parent's head, which is what it was driven to.
   */
  private solvedDirection(e: RoleEntry, out: Vector3): Vector3 {
    const child = e.childEntry;
    if (e.source === 'chord' && child && e.parent) {
      out.setFromMatrixPosition(child.mNow).sub(_v1.setFromMatrixPosition(e.parent.mNow));
      if (out.lengthSq() > 1e-10) return out.normalize();
    }
    if (child) {
      out.setFromMatrixPosition(child.mNow).sub(_v1.setFromMatrixPosition(e.mNow));
      if (out.lengthSq() > 1e-10) return out.normalize();
    }
    _qa.copy(e.qNow).multiply(e.restQInv);
    return out.copy(e.restDir).applyQuaternion(_qa).normalize();
  }

  private tailPosition(e: RoleEntry, out: Vector3): Vector3 {
    const child = e.childEntry;
    if (child) return out.setFromMatrixPosition(child.mNow);
    this.solvedDirection(e, _v2);
    return out.setFromMatrixPosition(e.mNow).addScaledVector(_v2, Math.max(e.length, 1e-3));
  }

  private chainError(
    upper: HumanoidBone,
    lower: HumanoidBone,
    end: HumanoidBone,
    from: Vector3,
    to: Vector3,
    basis: MeasuredBasis | undefined,
  ): number | null {
    const u = this.byRole.get(upper);
    const l = this.byRole.get(lower);
    if (!u || !l || !basis || basis.c <= 0) return null;
    _v3.subVectors(to, from);
    if (_v3.lengthSq() < 1e-8) return null;
    const endEntry = this.byRole.get(end);
    if (endEntry) _v4.setFromMatrixPosition(endEntry.mNow);
    else this.tailPosition(l, _v4);
    _v4.sub(_v1.setFromMatrixPosition(u.mNow));
    if (_v4.lengthSq() < 1e-10) return null;
    return angleBetween(_v3, _v4) * RAD2DEG;
  }

  // ---------------------------------------------------------------- takes

  /** Samples the current solved state for the clip recorder. `t` = seconds since the take started. */
  sampleTake(t: number = this.elapsed): TakeSample {
    const n = this.entries.length;
    const local = new Float32Array(4 * n);
    const world = new Float32Array(4 * n);
    for (let i = 0; i < n; i++) {
      const e = this.entries[i];
      e.bone.quaternion.toArray(local, 4 * i);
      e.qNow.toArray(world, 4 * i);
    }
    const hl = this.hips ? this.hips.bone.position : _zero;
    const hw = this.result.hipsWorldPos;
    return {
      t,
      local,
      world,
      hipsLocal: [hl.x, hl.y, hl.z],
      hipsWorld: [hw.x, hw.y, hw.z],
    };
  }

  /** Static take description (roles, bind transforms, hierarchy) for a `Take`. */
  takeHeader(fps: number): Omit<Take, 'samples' | 't0'> {
    const roles = this.entries.map((e) => e.role);
    const index = new Map<HumanoidBone, number>();
    roles.forEach((r, i) => index.set(r, i));
    const bindWorldQuat: QuatTuple[] = [];
    const bindWorldPos: Vec3Tuple[] = [];
    const parentIndex: number[] = [];
    const lengths: number[] = [];
    const boneNames: string[] = [];
    for (const e of this.entries) {
      const q = e.restQ;
      bindWorldQuat.push([q.x, q.y, q.z, q.w]);
      bindWorldPos.push([e.restPos.x, e.restPos.y, e.restPos.z]);
      parentIndex.push(e.parent ? index.get(e.parent.role)! : -1);
      lengths.push(e.length);
      boneNames.push(e.bone.name);
    }
    return { fps, roles, boneNames, bindWorldQuat, bindWorldPos, parentIndex, lengths };
  }

  /** Canonical humanoid parent of a role (for callers that need the role graph without the rig). */
  static parentRole(role: HumanoidBone): HumanoidBone | null {
    return HUMANOID_PARENT[role];
  }
}

export function makeTakeHeader(retargeter: Retargeter, fps: number): Omit<Take, 'samples' | 't0'> {
  return retargeter.takeHeader(fps);
}

// scratch (module level: the solver never allocates per frame)
const _seedQ = new Quaternion();
const _seedM = new Matrix4();
const _qP = new Quaternion();
const _mP = new Matrix4();
const _local = new Matrix4();
const _rotOnly = new Matrix4();
const _qMeas = new Quaternion();
const _R = new Quaternion();
const _T = new Quaternion();
const _T2 = new Quaternion();
const _rTop = new Quaternion();
const _qWT = new Quaternion();
const _qLT = new Quaternion();
const _qPinv = new Quaternion();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _qc = new Quaternion();
const _qRel = new Quaternion();
const _qSwing = new Quaternion();
const _qTwist = new Quaternion();
const _LATERAL = new Vector3(0, 1, 0);
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _p = new Vector3();
const _scale = new Vector3();
const _zero = new Vector3();
const _zVals = new Float64Array(DEPTH_SEGMENTS.length);
const _zW = new Float64Array(DEPTH_SEGMENTS.length);
const _zIdx = new Int32Array(DEPTH_SEGMENTS.length);
