/**
 * BodyModel: turns a FilteredPose into per-role measured bases
 * (docs/DESIGN.md §6.1). Pure three.js math, no DOM.
 *
 * Every basis is (d, u, c, cU): unit bone direction, unit up reference,
 * landmark confidence and up-reference confidence. The same definitions are
 * used for the rig's bind pose (§6.2 auto mode), so the solver only ever
 * compares like with like.
 *
 * The result object returned by `update()` is reused between frames; copy
 * what must outlive the next call.
 */
import { Vector3 } from 'three';
import type { FilteredPose } from '../core/pose';
import type { FramingState, HumanoidBone, SegmentName, SmoothingSettings } from '../core/types';
import { LM, POSE_LANDMARK_COUNT } from '../tracking/landmarks';
import {
  DEG2RAD,
  angleBetween,
  anyPerpendicular,
  bendBlendWeight,
  clamp,
  dorsalNormal,
  expFactor,
  flexionUp,
  kneecapUp,
  perpendicularComponent,
} from '../core/math';

export type BasisSource = 'measured' | 'fallback' | 'chord' | 'twoBone' | 'hold';

export interface MeasuredBasis {
  d: Vector3;
  u: Vector3;
  /** Landmark confidence 0..1 (min over the role's landmarks). */
  c: number;
  /** Up-reference confidence 0..1. */
  cU: number;
  source: BasisSource;
}

export interface BodyModelResult {
  bases: Partial<Record<HumanoidBone, MeasuredBasis>>;
  /** Pelvis basis (d = torso up, u = pelvis forward) and shoulders basis (u = shoulder-line forward). */
  torso: { hips: MeasuredBasis; shoulders: MeasuredBasis };
  /** Confidence of the hip landmarks themselves (0 when the framing policy ignores them). */
  hipsConfidence: number;
  /** True while the hips-lost policy is active. */
  hipsLost: boolean;
  /** Running medians of the user's segment lengths (meters), once enough samples exist. */
  segmentLengths: Partial<Record<SegmentName, number>>;
  /** Filtered elbow/knee bend angles (radians) keyed by the upper bone. */
  bendAngles: Partial<Record<HumanoidBone, number>>;
  /** Effective landmark positions (three.js world coords) after fallback substitution, 33 entries. */
  joints: Vector3[];
}

export interface BodyModelOptions {
  framing: FramingState;
  noKnee: { left: boolean; right: boolean };
  noElbow: { left: boolean; right: boolean };
  /**
   * Whether the pose was mirrored. Informational: FilteredPose is already
   * mirrored and its indices swapped, so 'left' landmarks are the driven
   * model's left side and the dorsal-normal sign follows the role's side.
   */
  mirror: boolean;
}

/** Samples of a segment length needed before the two-bone fallback may use its median. */
export const MIN_SEGMENT_SAMPLES = 60;
/** Two-bone fallback gating: reach ratio r = |S-W| / (L1+L2). */
export const TWO_BONE_R_MIN = 0.55;
export const TWO_BONE_R_MAX = 0.98;
/** Two-bone fallback gating: |z| of the unit S->W direction must stay below this. */
export const TWO_BONE_MAX_Z = 0.7;
/** Seconds over which a stored bend normal decays toward torso forward while a joint is lost. */
export const NORMAL_DECAY_SEC = 1;
/** Seconds over which the pelvis eases to the shoulder yaw after the hips are lost. */
export const HIPS_LOST_EASE_SEC = 2;
/** Seconds over which a held confidence fades to zero after the hold time. */
export const HOLD_FADE_SEC = 0.3;
/** Time constant (s) of the bend-angle low-pass. */
const BEND_TAU = 0.06;
/** Landmark confidence below which a gated middle joint is in the "ambiguous band" (50/50 blend). */
const AMBIGUOUS_CONF = 0.5;

const Y_UP = new Vector3(0, 1, 0);
const Z_FWD = new Vector3(0, 0, 1);

export function makeBasis(): MeasuredBasis {
  return { d: new Vector3(0, 1, 0), u: new Vector3(0, 0, 1), c: 0, cU: 0, source: 'hold' };
}

export function copyBasis(dst: MeasuredBasis, src: MeasuredBasis): MeasuredBasis {
  dst.d.copy(src.d);
  dst.u.copy(src.u);
  dst.c = src.c;
  dst.cU = src.cU;
  dst.source = src.source;
  return dst;
}

/** Bounded running median (ring buffer). */
export class RunningMedian {
  private buf: number[];
  private scratch: number[];
  private idx = 0;
  private count = 0;
  private cached = NaN;
  private dirty = true;
  constructor(readonly capacity = 240) {
    this.buf = new Array(capacity);
    this.scratch = new Array(capacity);
  }
  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.dirty = true;
  }
  get size(): number {
    return this.count;
  }
  value(): number {
    if (this.count === 0) return NaN;
    if (!this.dirty) return this.cached;
    const n = this.count;
    for (let i = 0; i < n; i++) this.scratch[i] = this.buf[i];
    const s = this.scratch;
    s.length = n;
    s.sort((a, b) => a - b);
    this.cached = n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
    s.length = this.capacity;
    this.dirty = false;
    return this.cached;
  }
  reset(): void {
    this.idx = 0;
    this.count = 0;
    this.dirty = true;
  }
}

/**
 * Two-bone placement of a middle joint: given the ends S and W, the segment
 * lengths L1 (S->joint) and L2 (joint->W), and the direction `bendDir` in
 * which the joint bulges away from the chord, returns the joint on the
 * solution circle. False when the chord is degenerate or `bendDir` is
 * parallel to it. The joint is clamped onto the chord when unreachable.
 */
export function twoBoneJoint(S: Vector3, W: Vector3, L1: number, L2: number, bendDir: Vector3, out: Vector3): boolean {
  _tbAxis.subVectors(W, S);
  const D = _tbAxis.length();
  if (D < 1e-6) return false;
  _tbAxis.multiplyScalar(1 / D);
  const a = clamp((L1 * L1 - L2 * L2 + D * D) / (2 * D), -L1, L1);
  const h = Math.sqrt(Math.max(L1 * L1 - a * a, 0));
  const perp = perpendicularComponent(bendDir, _tbAxis, _tbPerp);
  if (!perp) return false;
  out.copy(S).addScaledVector(_tbAxis, a).addScaledVector(perp, h);
  return true;
}
const _tbAxis = new Vector3();
const _tbPerp = new Vector3();

/** Normalized linear blend of two unit vectors (t = 0 -> a, 1 -> b). */
export function blendUnit(a: Vector3, b: Vector3, t: number, out: Vector3): Vector3 {
  out.copy(a).multiplyScalar(1 - t).addScaledVector(b, t);
  const l = out.length();
  if (l < 1e-6) return out.copy(t < 0.5 ? a : b);
  return out.multiplyScalar(1 / l);
}

type Group = 'arms' | 'legs' | 'torso';

interface SideIdx {
  shoulder: number;
  elbow: number;
  wrist: number;
  index: number;
  pinky: number;
  hip: number;
  knee: number;
  ankle: number;
  heel: number;
  foot: number;
}

interface SideRoles {
  shoulder: HumanoidBone;
  upperArm: HumanoidBone;
  lowerArm: HumanoidBone;
  hand: HumanoidBone;
  upperLeg: HumanoidBone;
  lowerLeg: HumanoidBone;
  foot: HumanoidBone;
  toes: HumanoidBone;
}

const IDX: Record<'left' | 'right', SideIdx> = {
  left: {
    shoulder: LM.LEFT_SHOULDER,
    elbow: LM.LEFT_ELBOW,
    wrist: LM.LEFT_WRIST,
    index: LM.LEFT_INDEX,
    pinky: LM.LEFT_PINKY,
    hip: LM.LEFT_HIP,
    knee: LM.LEFT_KNEE,
    ankle: LM.LEFT_ANKLE,
    heel: LM.LEFT_HEEL,
    foot: LM.LEFT_FOOT_INDEX,
  },
  right: {
    shoulder: LM.RIGHT_SHOULDER,
    elbow: LM.RIGHT_ELBOW,
    wrist: LM.RIGHT_WRIST,
    index: LM.RIGHT_INDEX,
    pinky: LM.RIGHT_PINKY,
    hip: LM.RIGHT_HIP,
    knee: LM.RIGHT_KNEE,
    ankle: LM.RIGHT_ANKLE,
    heel: LM.RIGHT_HEEL,
    foot: LM.RIGHT_FOOT_INDEX,
  },
};

const ROLES: Record<'left' | 'right', SideRoles> = {
  left: {
    shoulder: 'leftShoulder',
    upperArm: 'leftUpperArm',
    lowerArm: 'leftLowerArm',
    hand: 'leftHand',
    upperLeg: 'leftUpperLeg',
    lowerLeg: 'leftLowerLeg',
    foot: 'leftFoot',
    toes: 'leftToes',
  },
  right: {
    shoulder: 'rightShoulder',
    upperArm: 'rightUpperArm',
    lowerArm: 'rightLowerArm',
    hand: 'rightHand',
    upperLeg: 'rightUpperLeg',
    lowerLeg: 'rightLowerLeg',
    foot: 'rightFoot',
    toes: 'rightToes',
  },
};

/** Roles this model measures (everything else is left to the solver's distribution or kept at bind). */
export const MEASURED_ROLES: readonly HumanoidBone[] = [
  'hips',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToes',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToes',
];

interface RoleState {
  last: MeasuredBasis;
  lostFor: number;
  ever: boolean;
}

interface BendState {
  normal: Vector3;
  has: boolean;
  bend: number;
  hasBend: boolean;
}

interface LimbFallback {
  /** Seconds since the middle joint's landmark was last usable. */
  lostFor: number;
  /** Bend normal stored when the joint was last measured (decays toward torso forward). */
  stored: Vector3;
  hasStored: boolean;
  /** Last effective joint position (landmark or solved). */
  lastJoint: Vector3;
  hasLastJoint: boolean;
}

const SEGMENT_NAMES: readonly SegmentName[] = ['upperArm', 'lowerArm', 'upperLeg', 'lowerLeg', 'shoulderWidth', 'hipWidth', 'torso'];

export class BodyModel {
  private settings: SmoothingSettings;
  private readonly result: BodyModelResult;
  private readonly states = new Map<HumanoidBone, RoleState>();
  private readonly shouldersState: RoleState = { last: makeBasis(), lostFor: 0, ever: false };
  private readonly bends = new Map<HumanoidBone, BendState>();
  private readonly dorsalPrev = new Map<HumanoidBone, Vector3>();
  private readonly limbs: Record<'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg', LimbFallback>;
  private readonly medians = new Map<SegmentName, RunningMedian>();
  private hipsLostFor = 0;
  private readonly pelvisAtLoss = makeBasis();
  private pelvisEver = false;

  // scratch
  private readonly midHip = new Vector3();
  private readonly midShoulder = new Vector3();
  private readonly torsoD = new Vector3();
  private readonly shoulderFwd = new Vector3();
  private readonly hipFwd = new Vector3();
  private readonly pelvisFwd = new Vector3();
  private readonly _a = new Vector3();
  private readonly _b = new Vector3();
  private readonly _c = new Vector3();
  private readonly _d = new Vector3();
  private readonly _u = new Vector3();
  private readonly _fwdPerp = new Vector3();
  private readonly _child = new Vector3();
  private readonly _flex = new Vector3();
  private readonly _norm = new Vector3();
  private readonly _solved = new Vector3();
  private readonly _bendDir = new Vector3();
  private readonly _dorsal = new Vector3();

  constructor(settings: SmoothingSettings) {
    this.settings = settings;
    const bases: Partial<Record<HumanoidBone, MeasuredBasis>> = {};
    for (const r of MEASURED_ROLES) {
      bases[r] = makeBasis();
      this.states.set(r, { last: makeBasis(), lostFor: 0, ever: false });
    }
    for (const r of ['leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg'] as const) {
      this.bends.set(r, { normal: new Vector3(0, 0, 1), has: false, bend: 0, hasBend: false });
    }
    for (const r of ['leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'leftLowerLeg', 'rightLowerLeg'] as const) {
      this.dorsalPrev.set(r, new Vector3(0, 0, 0));
    }
    const limb = (): LimbFallback => ({
      lostFor: 0,
      stored: new Vector3(0, 0, 1),
      hasStored: false,
      lastJoint: new Vector3(),
      hasLastJoint: false,
    });
    this.limbs = { leftArm: limb(), rightArm: limb(), leftLeg: limb(), rightLeg: limb() };
    for (const s of SEGMENT_NAMES) this.medians.set(s, new RunningMedian(240));
    const joints: Vector3[] = [];
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) joints.push(new Vector3());
    this.result = {
      bases,
      torso: { hips: bases.hips!, shoulders: makeBasis() },
      hipsConfidence: 0,
      hipsLost: true,
      segmentLengths: {},
      bendAngles: {},
      joints,
    };
  }

  setSettings(settings: SmoothingSettings): void {
    this.settings = settings;
  }

  reset(): void {
    for (const st of this.states.values()) {
      st.lostFor = 0;
      st.ever = false;
      st.last.c = 0;
      st.last.cU = 0;
    }
    this.shouldersState.ever = false;
    this.shouldersState.lostFor = 0;
    for (const b of this.bends.values()) {
      b.has = false;
      b.hasBend = false;
    }
    for (const v of this.dorsalPrev.values()) v.set(0, 0, 0);
    for (const l of Object.values(this.limbs)) {
      l.lostFor = 0;
      l.hasStored = false;
      l.hasLastJoint = false;
    }
    for (const m of this.medians.values()) m.reset();
    this.hipsLostFor = 0;
    this.pelvisEver = false;
    this.result.segmentLengths = {};
    this.result.bendAngles = {};
  }

  /** Median length of a segment, or NaN before enough samples exist. */
  segmentLength(name: SegmentName): number {
    const m = this.medians.get(name)!;
    return m.size >= MIN_SEGMENT_SAMPLES ? m.value() : NaN;
  }

  update(pose: FilteredPose, dt: number, opts: BodyModelOptions): BodyModelResult {
    const R = this.result;
    const W = pose.world;
    const cf = pose.confidence;
    const gated = pose.gated;
    const framing = opts.framing;
    const present = pose.present && W.length >= POSE_LANDMARK_COUNT;
    const conf = (i: number): number => (present ? cf[i] ?? 0 : 0);
    const isGated = (i: number): boolean => present && !!gated[i];

    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      if (present) R.joints[i].copy(W[i]);
    }
    const J = R.joints;

    // ---------------------------------------------------------------- torso
    this.midHip.addVectors(J[LM.LEFT_HIP], J[LM.RIGHT_HIP]).multiplyScalar(0.5);
    this.midShoulder.addVectors(J[LM.LEFT_SHOULDER], J[LM.RIGHT_SHOULDER]).multiplyScalar(0.5);
    this.torsoD.subVectors(this.midShoulder, this.midHip);
    if (this.torsoD.lengthSq() < 1e-8) this.torsoD.copy(Y_UP);
    else this.torsoD.normalize();

    // Shoulder-line forward (horizontal): cross(up, shoulderL -> shoulderR).
    this._a.subVectors(J[LM.RIGHT_SHOULDER], J[LM.LEFT_SHOULDER]);
    this.shoulderFwd.crossVectors(Y_UP, this._a);
    if (this.shoulderFwd.lengthSq() < 1e-8) this.shoulderFwd.copy(Z_FWD);
    else this.shoulderFwd.normalize();

    // Pelvis forward: cross(torso up, hipL -> hipR).
    this._a.subVectors(J[LM.RIGHT_HIP], J[LM.LEFT_HIP]);
    this.hipFwd.crossVectors(this.torsoD, this._a);
    if (this.hipFwd.lengthSq() < 1e-8) this.hipFwd.copy(this.shoulderFwd);
    else this.hipFwd.normalize();

    const ignoreBelowShoulders = framing === 'bust' || framing === 'face';
    const shoulderConf = Math.min(conf(LM.LEFT_SHOULDER), conf(LM.RIGHT_SHOULDER));
    let hipsConf = Math.min(conf(LM.LEFT_HIP), conf(LM.RIGHT_HIP));
    if (ignoreBelowShoulders || !isGated(LM.LEFT_HIP) || !isGated(LM.RIGHT_HIP)) hipsConf = 0;
    const hipsLost = hipsConf <= 0;
    R.hipsConfidence = hipsConf;
    R.hipsLost = hipsLost;

    const holdTorso = this.settings.poseHoldMs.torso / 1000;
    const pelvis = R.torso.hips;
    const shoulders = R.torso.shoulders;
    if (framing === 'face') {
      // Last upper-spine yaw held.
      this.freeze(this.states.get('hips')!, pelvis);
      this.freeze(this.shouldersState, shoulders);
    } else if (!hipsLost) {
      this.hipsLostFor = 0;
      // Ambiguous band: hip-line yaw blended with the shoulder yaw.
      blendUnit(this.shoulderFwd, this.hipFwd, hipsConf, this.pelvisFwd);
      this.finish('hips', 'torso', dt, this.torsoD, this.pelvisFwd, shoulderConf, shoulderConf, 'measured');
      if (pelvis.c > 0) {
        copyBasis(this.pelvisAtLoss, pelvis);
        this.pelvisEver = true;
      }
      this._u.crossVectors(this.torsoD, this._a.subVectors(J[LM.RIGHT_SHOULDER], J[LM.LEFT_SHOULDER]));
      if (this._u.lengthSq() < 1e-8) this._u.copy(this.shoulderFwd);
      else this._u.normalize();
      this.finishState(this.shouldersState, shoulders, 'torso', dt, this.torsoD, this._u, shoulderConf, shoulderConf, 'measured', false);
    } else {
      this.hipsLostFor += dt;
      if (!this.pelvisEver) {
        this.pelvisAtLoss.d.copy(Y_UP);
        this.pelvisAtLoss.u.copy(this.shoulderFwd);
      }
      let k: number;
      if (this.hipsLostFor <= holdTorso) k = 0;
      else k = clamp((this.hipsLostFor - holdTorso) / HIPS_LOST_EASE_SEC, 0, 1);
      k = k * k * (3 - 2 * k);
      blendUnit(this.pelvisAtLoss.d, Y_UP, k, this._d);
      blendUnit(this.pelvisAtLoss.u, this.shoulderFwd, k, this._u);
      this.finish('hips', 'torso', dt, this._d, this._u, shoulderConf, shoulderConf, k === 0 ? 'hold' : 'fallback');
      // Spine driven from the shoulders basis relative to that pelvis.
      this._c.crossVectors(this._d, this._a.subVectors(J[LM.RIGHT_SHOULDER], J[LM.LEFT_SHOULDER]));
      if (this._c.lengthSq() < 1e-8) this._c.copy(this.shoulderFwd);
      else this._c.normalize();
      this.finishState(this.shouldersState, shoulders, 'torso', dt, this._d, this._c, shoulderConf, shoulderConf, 'fallback', false);
    }
    // Forward used by the limbs as "torso forward".
    const armFwd = shoulders.u;
    const legFwd = pelvis.u;

    // ------------------------------------------------------- segment medians
    if (present && framing !== 'bust' && framing !== 'face') this.updateSegments(pose);
    for (const s of SEGMENT_NAMES) {
      const m = this.medians.get(s)!;
      if (m.size >= MIN_SEGMENT_SAMPLES) R.segmentLengths[s] = m.value();
      else delete R.segmentLengths[s];
    }

    // ----------------------------------------------------------- neck / head
    this.neckHead(pose, dt, framing, present, conf, isGated);

    // ----------------------------------------------------------------- limbs
    const armsRelax = framing === 'face';
    const legsRelax = framing === 'waist' || framing === 'bust' || framing === 'face';
    for (const side of ['left', 'right'] as const) {
      this.arm(side, dt, conf, isGated, pose, armFwd, opts.noElbow[side], armsRelax);
      this.leg(side, dt, conf, isGated, legFwd, opts.noKnee[side], legsRelax);
    }
    return R;
  }

  // --------------------------------------------------------------------------

  private neckHead(
    pose: FilteredPose,
    dt: number,
    framing: FramingState,
    present: boolean,
    conf: (i: number) => number,
    isGated: (i: number) => boolean,
  ): void {
    const J = this.result.joints;
    const faceRot = pose.face?.rotation ?? null;
    // Landmark head basis.
    const earL = J[LM.LEFT_EAR];
    const earR = J[LM.RIGHT_EAR];
    this._a.subVectors(earR, earL); // ear axis (left -> right)
    this._b.addVectors(earL, earR).multiplyScalar(0.5); // mid ear
    this._c.addVectors(J[LM.LEFT_EYE], J[LM.RIGHT_EYE]).multiplyScalar(0.5); // mid eye
    this._d.subVectors(this._c, this._b); // forward raw
    let headOk = false;
    let headFwd: Vector3 = this._fwdPerp;
    let headUp: Vector3 = this._u;
    if (this._a.lengthSq() > 1e-8 && this._d.lengthSq() > 1e-8) {
      const f = perpendicularComponent(this._d, this._norm.copy(this._a).normalize(), this._fwdPerp);
      if (f) {
        this._u.crossVectors(this._a, f);
        if (this._u.lengthSq() > 1e-8) {
          this._u.normalize();
          headOk = true;
        }
      }
    }
    const lmHeadConf = Math.min(conf(LM.LEFT_EAR), conf(LM.RIGHT_EAR), conf(LM.LEFT_EYE), conf(LM.RIGHT_EYE));
    // The FaceLandmarker matrix replaces the landmark head basis whenever it is present.
    const useFace = faceRot !== null;
    if (faceRot !== null) {
      headUp = this._flex.set(0, 1, 0).applyQuaternion(faceRot);
      headFwd = this._child.set(0, 0, 1).applyQuaternion(faceRot);
    }
    const headConf = useFace ? 1 : headOk ? lmHeadConf : 0;
    // Neck: midShoulder -> midEar, u = head forward.
    const neckGated = isGated(LM.LEFT_SHOULDER) && isGated(LM.RIGHT_SHOULDER) && isGated(LM.LEFT_EAR) && isGated(LM.RIGHT_EAR);
    let neckConf = Math.min(conf(LM.LEFT_SHOULDER), conf(LM.RIGHT_SHOULDER), conf(LM.LEFT_EAR), conf(LM.RIGHT_EAR));
    this._solved.subVectors(this._b, this.midShoulder);
    let neckD: Vector3 = this._solved;
    if (framing === 'face' && useFace) {
      neckD = headUp;
      neckConf = 1;
    } else if (!present || !neckGated || this._solved.lengthSq() < 1e-8) {
      neckConf = 0;
    } else {
      this._solved.normalize();
    }
    const neckU = useFace ? headFwd : headOk ? this._fwdPerp : this.shoulderFwd;
    this.finish('neck', 'torso', dt, neckD, neckU, neckConf, headConf > 0 ? Math.min(neckConf, headConf) : 0, 'measured');
    this.finish('head', 'torso', dt, headUp, headFwd, headConf, headConf, 'measured');
  }

  private arm(
    side: 'left' | 'right',
    dt: number,
    conf: (i: number) => number,
    isGated: (i: number) => boolean,
    pose: FilteredPose,
    torsoFwd: Vector3,
    noElbow: boolean,
    forcedRelax: boolean,
  ): void {
    const L = IDX[side];
    const roles = ROLES[side];
    const J = this.result.joints;
    const S = J[L.shoulder];
    const E = J[L.elbow];
    const Wr = J[L.wrist];
    const cS = conf(L.shoulder);
    const cE = conf(L.elbow);
    const cW = conf(L.wrist);
    const fb = this.limbs[side === 'left' ? 'leftArm' : 'rightArm'];
    const bend = this.bends.get(roles.upperArm)!;

    // ------------------------------------------------ elbow (with fallback)
    const elbowUsable = isGated(L.elbow) && cE > 0;
    let c = Math.min(cS, cE);
    let source: BasisSource = 'measured';
    if (!elbowUsable) fb.lostFor += dt;
    if (!elbowUsable || cE < AMBIGUOUS_CONF) {
      const L1 = this.segmentLength('upperArm');
      const L2 = this.segmentLength('lowerArm');
      if (isGated(L.shoulder) && isGated(L.wrist) && Number.isFinite(L1) && Number.isFinite(L2)) {
        this._a.subVectors(Wr, S);
        const D = this._a.length();
        const r = D / (L1 + L2);
        const z = D > 1e-6 ? Math.abs(this._a.z) / D : 1;
        if (r >= TWO_BONE_R_MIN && r <= TWO_BONE_R_MAX && z < TWO_BONE_MAX_Z) {
          // Elbow bulges opposite to the flexion normal; the stored normal decays to torso forward.
          const decay = clamp(fb.lostFor / NORMAL_DECAY_SEC, 0, 1);
          const fwdPerp = perpendicularComponent(torsoFwd, this._a.normalize(), this._fwdPerp) ?? anyPerpendicular(this._a, this._fwdPerp);
          if (fb.hasStored) blendUnit(fb.stored, fwdPerp, decay, this._norm);
          else this._norm.copy(fwdPerp);
          this._bendDir.copy(this._norm).negate();
          if (twoBoneJoint(S, Wr, L1, L2, this._bendDir, this._solved)) {
            if (!elbowUsable) {
              E.copy(this._solved);
              c = Math.min(cS, cW);
            } else {
              E.lerp(this._solved, 0.5);
              c = Math.max(cE, Math.min(cS, cW));
            }
            source = 'twoBone';
          }
        }
      }
    }
    if (source === 'measured' && !elbowUsable) c = 0;

    // ------------------------------------------------------------ upper arm
    this._d.subVectors(E, S);
    const dLen = this._d.length();
    if (dLen < 1e-6) c = 0;
    else this._d.multiplyScalar(1 / dLen);
    this._child.subVectors(Wr, E);
    const bendRaw = angleBetween(this._d, this._child);
    if (!bend.hasBend || !(c > 0) || cW <= 0) {
      if (c > 0 && cW > 0) {
        bend.bend = bendRaw;
        bend.hasBend = true;
      }
    } else {
      bend.bend += (bendRaw - bend.bend) * expFactor(1 / BEND_TAU, dt);
    }
    const w = cW > 0 ? bendBlendWeight(bend.bend) : 0;
    const fwdPerp = perpendicularComponent(torsoFwd, this._d, this._fwdPerp) ?? anyPerpendicular(this._d, this._fwdPerp);
    const cand = cW > 0 && isGated(L.wrist) ? flexionUp(this._d, this._child, this._flex) : null;
    const normal = this.acceptNormal(bend, cand, bend.bend, fwdPerp);
    blendUnit(fwdPerp, normal, w, this._u);
    const cU = w * Math.min(c, cW);
    if (elbowUsable) {
      fb.lostFor = 0;
      if (bend.has) {
        fb.stored.copy(bend.normal);
        fb.hasStored = true;
      }
    }
    if (c > 0) {
      fb.lastJoint.copy(E);
      fb.hasLastJoint = true;
    }
    this.result.bendAngles[roles.upperArm] = bend.bend;

    // ------------------------------------------------------------- dorsal
    const dorsal = this.dorsal(side, pose, conf, roles.lowerArm);
    const cHand = dorsal.c;
    const cLower = Math.min(cE, cW);

    if (noElbow) {
      // Chord shoulder -> wrist drives the lower arm; the upper arm follows.
      this._a.subVectors(Wr, S);
      const chordC = Math.min(cS, cW);
      if (this._a.lengthSq() < 1e-8) {
        this.finish(roles.upperArm, 'arms', dt, this._d, this._u, 0, 0, 'chord', forcedRelax);
        this.finish(roles.lowerArm, 'arms', dt, this._d, this._u, 0, 0, 'chord', forcedRelax);
      } else {
        this._a.normalize();
        const chordFwd = perpendicularComponent(torsoFwd, this._a, this._b) ?? anyPerpendicular(this._a, this._b);
        blendUnit(chordFwd, normal, w, this._c);
        this.finish(roles.upperArm, 'arms', dt, this._a, this._c, chordC, w * chordC, 'chord', forcedRelax);
        this.finish(roles.lowerArm, 'arms', dt, this._a, dorsal.v, chordC, Math.min(chordC, cHand), 'chord', forcedRelax);
      }
    } else {
      this.finish(roles.upperArm, 'arms', dt, this._d, this._u, c, cU, source, forcedRelax);
      this._b.subVectors(Wr, E);
      let cl = source === 'twoBone' ? Math.min(c, cW) : cLower;
      if (this._b.lengthSq() < 1e-8) cl = 0;
      else this._b.normalize();
      this.finish(roles.lowerArm, 'arms', dt, this._b, dorsal.v, cl, Math.min(cl, cHand), source === 'twoBone' ? 'twoBone' : 'measured', forcedRelax);
    }

    // ---------------------------------------------------------------- hand
    this._c.addVectors(J[L.index], J[L.pinky]).multiplyScalar(0.5).sub(Wr);
    let cH = Math.min(cW, conf(L.index), conf(L.pinky));
    if (this._c.lengthSq() < 1e-8) cH = 0;
    else this._c.normalize();
    this.finish(roles.hand, 'arms', dt, this._c, dorsal.v, cH, Math.min(cH, cHand), 'measured', forcedRelax);

    // ------------------------------------------------------------ shoulder
    this._a.subVectors(S, this.midShoulder);
    let cSh = Math.min(conf(LM.LEFT_SHOULDER), conf(LM.RIGHT_SHOULDER));
    if (this._a.lengthSq() < 1e-8) cSh = 0;
    else this._a.normalize();
    this.finish(roles.shoulder, 'arms', dt, this._a, torsoFwd, cSh, cSh, 'measured', forcedRelax);
  }

  /** Dorsal (back-of-hand) normal for a side: hand tracker when present, else pose landmarks. */
  private dorsal(
    side: 'left' | 'right',
    pose: FilteredPose,
    conf: (i: number) => number,
    prevKey: HumanoidBone,
  ): { v: Vector3; c: number } {
    const prev = this.dorsalPrev.get(prevKey)!;
    const hand = pose.hands?.[side] ?? null;
    let n: Vector3 | null = null;
    let c = 0;
    if (hand && hand.local.length >= 18 && hand.score > 0) {
      n = dorsalNormal(hand.local[0], hand.local[5], hand.local[17], side, this._dorsal);
      c = n ? clamp(hand.score, 0, 1) : 0;
    }
    if (!n) {
      const L = IDX[side];
      const J = this.result.joints;
      n = dorsalNormal(J[L.wrist], J[L.index], J[L.pinky], side, this._dorsal);
      c = n ? Math.min(conf(L.wrist), conf(L.index), conf(L.pinky)) : 0;
    }
    if (n && c > 0) {
      prev.copy(n);
      return { v: n, c };
    }
    if (prev.lengthSq() > 0.5) return { v: prev, c: 0 };
    return { v: this._dorsal.copy(Y_UP), c: 0 };
  }

  private leg(
    side: 'left' | 'right',
    dt: number,
    conf: (i: number) => number,
    isGated: (i: number) => boolean,
    torsoFwd: Vector3,
    noKnee: boolean,
    forcedRelax: boolean,
  ): void {
    const L = IDX[side];
    const roles = ROLES[side];
    const J = this.result.joints;
    const H = J[L.hip];
    const K = J[L.knee];
    const A = J[L.ankle];
    const cH = forcedRelax ? 0 : conf(L.hip);
    const cK = forcedRelax ? 0 : conf(L.knee);
    const cA = forcedRelax ? 0 : conf(L.ankle);
    const cHe = forcedRelax ? 0 : conf(L.heel);
    const cF = forcedRelax ? 0 : conf(L.foot);
    const fb = this.limbs[side === 'left' ? 'leftLeg' : 'rightLeg'];
    const bend = this.bends.get(roles.upperLeg)!;

    // ------------------------------------------------- knee (with fallback)
    const kneeUsable = isGated(L.knee) && cK > 0;
    let c = Math.min(cH, cK);
    let source: BasisSource = 'measured';
    if (!kneeUsable) fb.lostFor += dt;
    if (!kneeUsable || cK < AMBIGUOUS_CONF) {
      const L1 = this.segmentLength('upperLeg');
      const L2 = this.segmentLength('lowerLeg');
      if (isGated(L.hip) && isGated(L.ankle) && Number.isFinite(L1) && Number.isFinite(L2)) {
        this._a.subVectors(A, H);
        const D = this._a.length();
        const r = D / (L1 + L2);
        const z = D > 1e-6 ? Math.abs(this._a.z) / D : 1;
        if (r >= TWO_BONE_R_MIN && r <= TWO_BONE_R_MAX && z < TWO_BONE_MAX_Z) {
          const decay = clamp(fb.lostFor / NORMAL_DECAY_SEC, 0, 1);
          const fwdPerp = perpendicularComponent(torsoFwd, this._a.normalize(), this._fwdPerp) ?? anyPerpendicular(this._a, this._fwdPerp);
          if (fb.hasStored) blendUnit(fb.stored, fwdPerp, decay, this._norm);
          else this._norm.copy(fwdPerp);
          // Knees never bend backward: the bulge direction stays in the forward hemisphere.
          if (this._norm.dot(torsoFwd) < 0) this._norm.copy(fwdPerp);
          this._bendDir.copy(this._norm);
          if (twoBoneJoint(H, A, L1, L2, this._bendDir, this._solved)) {
            if (!kneeUsable) {
              K.copy(this._solved);
              c = Math.min(cH, cA);
            } else {
              K.lerp(this._solved, 0.5);
              c = Math.max(cK, Math.min(cH, cA));
            }
            source = 'twoBone';
          }
        }
      }
    }
    if (source === 'measured' && !kneeUsable) c = 0;

    // ------------------------------------------------------------ upper leg
    this._d.subVectors(K, H);
    const dLen = this._d.length();
    if (dLen < 1e-6) c = 0;
    else this._d.multiplyScalar(1 / dLen);
    this._child.subVectors(A, K);
    const bendRaw = angleBetween(this._d, this._child);
    if (!bend.hasBend || !(c > 0) || cA <= 0) {
      if (c > 0 && cA > 0) {
        bend.bend = bendRaw;
        bend.hasBend = true;
      }
    } else {
      bend.bend += (bendRaw - bend.bend) * expFactor(1 / BEND_TAU, dt);
    }
    const w = cA > 0 ? bendBlendWeight(bend.bend) : 0;
    const fwdPerp = perpendicularComponent(torsoFwd, this._d, this._fwdPerp) ?? anyPerpendicular(this._d, this._fwdPerp);
    let cand = cA > 0 && isGated(L.ankle) ? kneecapUp(this._d, this._child, this._flex) : null;
    // Knees do not hyperextend: the kneecap stays in the forward hemisphere.
    if (cand && cand.dot(torsoFwd) < 0) cand = null;
    const normal = this.acceptNormal(bend, cand, bend.bend, fwdPerp);
    blendUnit(fwdPerp, normal, w, this._u);
    const cU = w * Math.min(c, cA);
    if (kneeUsable) {
      fb.lostFor = 0;
      if (bend.has) {
        fb.stored.copy(bend.normal);
        fb.hasStored = true;
      }
    }
    if (c > 0) {
      fb.lastJoint.copy(K);
      fb.hasLastJoint = true;
    }
    this.result.bendAngles[roles.upperLeg] = bend.bend;

    // ------------------------------------------------------------ lower leg
    const prevFoot = this.dorsalPrev.get(roles.lowerLeg)!;
    this._b.subVectors(A, K);
    let cl = source === 'twoBone' ? Math.min(c, cA) : Math.min(cK, cA);
    if (this._b.lengthSq() < 1e-8) cl = 0;
    else this._b.normalize();
    this._c.subVectors(J[L.foot], J[L.heel]);
    let footNormal: Vector3 | null = null;
    let cFootN = Math.min(cHe, cF, cl);
    if (cFootN > 0) footNormal = perpendicularComponent(this._c, this._b, this._norm);
    if (footNormal) prevFoot.copy(footNormal);
    else {
      cFootN = 0;
      footNormal = prevFoot.lengthSq() > 0.5 ? this._norm.copy(prevFoot) : this._norm.copy(fwdPerp);
    }

    if (noKnee) {
      // Chord hip -> ankle with the kneecap direction as u; the upper leg follows.
      this._a.subVectors(A, H);
      const chordC = Math.min(cH, cA);
      if (this._a.lengthSq() < 1e-8) {
        this.finish(roles.upperLeg, 'legs', dt, this._d, this._u, 0, 0, 'chord', forcedRelax);
        this.finish(roles.lowerLeg, 'legs', dt, this._d, this._u, 0, 0, 'chord', forcedRelax);
      } else {
        this._a.normalize();
        const chordFwd = perpendicularComponent(torsoFwd, this._a, this._solved) ?? anyPerpendicular(this._a, this._solved);
        blendUnit(chordFwd, normal, w, this._bendDir);
        this.finish(roles.upperLeg, 'legs', dt, this._a, this._bendDir, chordC, w * chordC, 'chord', forcedRelax);
        this.finish(roles.lowerLeg, 'legs', dt, this._a, this._bendDir, chordC, w * chordC, 'chord', forcedRelax);
      }
    } else {
      this.finish(roles.upperLeg, 'legs', dt, this._d, this._u, c, cU, source, forcedRelax);
      this.finish(roles.lowerLeg, 'legs', dt, this._b, footNormal, cl, cFootN, source === 'twoBone' ? 'twoBone' : 'measured', forcedRelax);
    }

    // ----------------------------------------------------------------- foot
    this._c.subVectors(J[L.foot], A);
    let cFt = Math.min(cA, cF);
    if (this._c.lengthSq() < 1e-8) cFt = 0;
    else this._c.normalize();
    this._child.subVectors(K, A);
    const footUp = perpendicularComponent(this._child, this._c, this._flex) ?? perpendicularComponent(Y_UP, this._c, this._flex) ?? anyPerpendicular(this._c, this._flex);
    const cFootUp = Math.min(cFt, cK);
    this.finish(roles.foot, 'legs', dt, this._c, footUp, cFt, cFootUp, 'measured', forcedRelax);

    // ----------------------------------------------------------------- toes
    this._a.subVectors(J[L.foot], J[L.heel]);
    this._a.y = 0;
    let cT = Math.min(cHe, cF);
    if (this._a.lengthSq() < 1e-8) cT = 0;
    else this._a.normalize();
    this.finish(roles.toes, 'legs', dt, this._a, footUp, cT, Math.min(cT, cK, cA), 'measured', forcedRelax);
  }

  private acceptNormal(bs: BendState, cand: Vector3 | null, bend: number, fallback: Vector3): Vector3 {
    if (cand) {
      if (bs.has && bend < 45 * DEG2RAD && angleBetween(cand, bs.normal) > 90 * DEG2RAD) return bs.normal;
      bs.normal.copy(cand);
      bs.has = true;
      return bs.normal;
    }
    return bs.has ? bs.normal : fallback;
  }

  private updateSegments(pose: FilteredPose): void {
    const W = pose.world;
    const g = pose.gated;
    const push = (name: SegmentName, i: number, j: number): void => {
      if (g[i] && g[j]) this.medians.get(name)!.push(W[i].distanceTo(W[j]));
    };
    for (const side of ['left', 'right'] as const) {
      const L = IDX[side];
      if (g[L.shoulder] && g[L.elbow] && g[L.wrist]) {
        push('upperArm', L.shoulder, L.elbow);
        push('lowerArm', L.elbow, L.wrist);
      }
      if (g[L.hip] && g[L.knee] && g[L.ankle]) {
        push('upperLeg', L.hip, L.knee);
        push('lowerLeg', L.knee, L.ankle);
      }
    }
    push('shoulderWidth', LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
    push('hipWidth', LM.LEFT_HIP, LM.RIGHT_HIP);
    if (g[LM.LEFT_SHOULDER] && g[LM.RIGHT_SHOULDER] && g[LM.LEFT_HIP] && g[LM.RIGHT_HIP]) {
      this.medians.get('torso')!.push(this.midShoulder.distanceTo(this.midHip));
    }
  }

  private finish(
    role: HumanoidBone,
    group: Group,
    dt: number,
    d: Vector3,
    u: Vector3,
    c: number,
    cU: number,
    source: BasisSource,
    forcedRelax = false,
  ): void {
    this.finishState(this.states.get(role)!, this.result.bases[role]!, group, dt, d, u, c, cU, source, forcedRelax);
  }

  /** Hold/relax bookkeeping: fresh measurements are stored; losses hold, then the confidence fades. */
  private finishState(
    st: RoleState,
    out: MeasuredBasis,
    group: Group,
    dt: number,
    d: Vector3,
    u: Vector3,
    c: number,
    cU: number,
    source: BasisSource,
    forcedRelax: boolean,
  ): void {
    const ok = !forcedRelax && c > 0 && Number.isFinite(c) && Number.isFinite(d.x) && Number.isFinite(u.x);
    if (ok) {
      out.d.copy(d);
      out.u.copy(u);
      out.c = clamp(c, 0, 1);
      out.cU = clamp(Number.isFinite(cU) ? cU : 0, 0, 1);
      out.source = source;
      copyBasis(st.last, out);
      st.lostFor = 0;
      st.ever = true;
      return;
    }
    if (forcedRelax) st.lostFor = 1e9;
    else st.lostFor += dt;
    const hold = this.settings.poseHoldMs[group] / 1000;
    if (st.ever) {
      out.d.copy(st.last.d);
      out.u.copy(st.last.u);
      out.c = st.lostFor <= hold ? st.last.c : st.last.c * clamp(1 - (st.lostFor - hold) / HOLD_FADE_SEC, 0, 1);
    } else {
      if (Number.isFinite(d.x) && d.lengthSq() > 0.5) out.d.copy(d);
      if (Number.isFinite(u.x) && u.lengthSq() > 0.5) out.u.copy(u);
      out.c = 0;
    }
    out.cU = 0;
    out.source = 'hold';
  }

  /** Face framing: the torso keeps its last basis without fading. */
  private freeze(st: RoleState, out: MeasuredBasis): void {
    if (st.ever) {
      out.d.copy(st.last.d);
      out.u.copy(st.last.u);
      out.c = st.last.c;
      out.cU = 0;
    } else {
      out.c = 0;
      out.cU = 0;
    }
    out.source = 'hold';
  }
}
