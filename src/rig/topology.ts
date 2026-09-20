/**
 * Topology detector (docs/DESIGN.md §5.4): finds the humanoid structure of a
 * bind-pose {@link SkeletonGraph} with an extremity-path search, assigns roles
 * by chain order and takes the sides + facing decision.
 *
 * Names are consulted only through {@link classifyBone}: helper classification
 * (markers, ignore class, twist/segment merges), class constraints on chain
 * membership, the shoulder-vs-upperArm rule, finger digits and the sided-name
 * facing rule.
 *
 * Pure: three.js math classes only.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { HumanoidBone, RigAxes, Vec3Tuple } from '../core/types';
import {
  CLAVICLE_TOKENS,
  HEAD_TOKENS,
  METACARPAL_TOKENS,
  TOE_TOKENS,
  UPPER_ARM_TOKENS,
  classifyBone,
  isSegmentOf,
  type BoneNameInfo,
  type FingerDigit,
} from './boneNames';
import { isDescendant, lca, pathDown, type SkeletonGraph } from './skeletonGraph';

export type NodeKind = 'link' | 'passthrough' | 'marker';
export type LimbSide = 'left' | 'right';

export interface FingerChain {
  digit: FingerDigit;
  /** Chain links from the hand outward (metacarpal/tip links included). */
  links: number[];
  /** Role links: index -> role suffix (`Metacarpal`, `Proximal`, `Intermediate`, `Distal`). */
  roles: { index: number; segment: 'Metacarpal' | 'Proximal' | 'Intermediate' | 'Distal' }[];
  /** Whether the digit came from names or from rest positions. */
  digitSource: 'name' | 'position';
}

export interface ArmChain {
  side: LimbSide;
  /** Extremity leaf used to find the chain (a fingertip, the hand, ...). */
  end: number;
  /** Chain links between the spine branch (exclusive) and the hand (inclusive). */
  links: number[];
  /** Path nodes skipped as unmapped intermediates. */
  intermediates: number[];
  shoulder?: number;
  upperArm?: number;
  lowerArm?: number;
  hand?: number;
  fingers: FingerChain[];
}

export interface LegChain {
  side: LimbSide;
  end: number;
  links: number[];
  intermediates: number[];
  upperLeg?: number;
  lowerLeg?: number;
  foot?: number;
  toes?: number;
}

export interface TopologyResult {
  hips: number;
  spineBranch: number;
  headLeaf: number;
  /** Torso links from the hips (exclusive) to the spine branch (inclusive). */
  torso: number[];
  torsoIntermediates: number[];
  /** Head chain links from the spine branch (exclusive) to the head. */
  headChain: number[];
  headIntermediates: number[];
  arms: { left: ArmChain | null; right: ArmChain | null };
  legs: { left: LegChain | null; right: LegChain | null };
  /** Chain-order role of every mapped node. */
  roles: Map<number, HumanoidBone>;
  /** Whether the name class agreed with the chain role (for confidence). */
  nameAgrees: Map<number, boolean>;
  axes: RigAxes;
  /** Unit vector toward the rig's left side (loader space). */
  left: Vec3Tuple;
  /** Skeleton extent along the up axis (links and markers), loader units. */
  height: number;
  sideSource: 'names' | 'geometry';
  info: BoneNameInfo[];
  kinds: NodeKind[];
  /** Marker children per node. */
  markers: number[][];
  warnings: string[];
}

export interface TopologyOptions {
  /** VRM: axes are known (+Y up, +Z forward) and the facing detector is skipped. */
  vrm?: boolean;
}

const v3 = (t: Vec3Tuple) => new Vector3(t[0], t[1], t[2]);
const tup = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];

const AXES: Vector3[] = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

/** Snap a direction to the nearest principal axis when within `maxDeg`, else return it normalized. */
export function snapToAxis(dir: Vector3, maxDeg = 35): { axis: Vector3; snapped: boolean } {
  const d = dir.clone().normalize();
  let best = new Vector3(0, 1, 0);
  let bestDot = -Infinity;
  for (const a of AXES) {
    for (const s of [1, -1]) {
      const dot = d.dot(a) * s;
      if (dot > bestDot) {
        bestDot = dot;
        best = a.clone().multiplyScalar(s);
      }
    }
  }
  if (bestDot >= Math.cos((maxDeg * Math.PI) / 180)) return { axis: best, snapped: true };
  return { axis: d, snapped: false };
}

// ---------------------------------------------------------------------------
// Working context
// ---------------------------------------------------------------------------

class Ctx {
  pos: Vector3[];
  info: BoneNameInfo[];
  kinds: NodeKind[];
  effParent: number[];
  effChildren: number[][];
  markers: number[][];
  hasWeights: boolean;

  constructor(public g: SkeletonGraph) {
    const n = g.nodes.length;
    this.pos = g.nodes.map((nd) => v3(nd.restPos));
    this.hasWeights = g.hasSkinWeights;
    this.info = g.nodes.map((nd) => classifyBone(nd.name, { isLeaf: nd.children.length === 0, weight: nd.weight, hasWeights: g.hasSkinWeights }));
    this.kinds = new Array<NodeKind>(n).fill('link');
    this.effParent = new Array<number>(n).fill(-1);
    this.effChildren = g.nodes.map(() => []);
    this.markers = g.nodes.map(() => []);

    // Parent-first order (BFS from the roots) so a merge can look at the parent link.
    const order: number[] = [];
    const queue = [...g.roots];
    while (queue.length) {
      const i = queue.shift()!;
      order.push(i);
      for (const c of g.nodes[i].children) queue.push(c);
    }
    // Full Rigify exports carry DEF- (weighted) plus ORG-/MCH-/control duplicates: only DEF- is eligible.
    const defOnly = g.nodes.some((nd) => nd.name.startsWith('DEF-'));
    const hasJoints = g.nodes.some((nd) => nd.isJoint);
    for (const i of order) {
      const nd = g.nodes[i];
      const inf = this.info[i];
      let kind: NodeKind = 'link';
      if (inf.group === 'marker') kind = 'marker';
      else if (inf.group === 'ignore') kind = 'passthrough';
      else if (hasJoints && !nd.isJoint) kind = 'passthrough';
      else if (defOnly && !nd.name.startsWith('DEF-')) kind = 'passthrough';
      else if (g.hasSkinWeights && !(nd.weight > 0) && nd.children.length === 0 && inf.group === 'unknown') kind = 'marker';
      // Effective parent: nearest link ancestor.
      let p = nd.parent;
      while (p >= 0 && this.kinds[p] !== 'link') p = g.nodes[p].parent;
      if (kind === 'link' && p >= 0 && isSegmentOf(inf, this.info[p])) kind = 'passthrough';
      this.kinds[i] = kind;
      this.effParent[i] = p;
      if (p >= 0) {
        if (kind === 'link') this.effChildren[p].push(i);
        else if (kind === 'marker') this.markers[p].push(i);
      }
    }
  }
  isLink(i: number): boolean {
    return this.kinds[i] === 'link';
  }
  /** Leaves of the reduced tree. */
  leaves(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.g.nodes.length; i++) if (this.isLink(i) && this.effChildren[i].length === 0) out.push(i);
    return out;
  }
  /** Links and total length from `leaf` up to (and including the link into) the first branching ancestor or the root. */
  leafChain(leaf: number): { links: number; length: number; top: number } {
    let links = 0;
    let length = 0;
    let cur = leaf;
    let p = this.effParent[cur];
    while (p >= 0) {
      links++;
      length += this.pos[cur].distanceTo(this.pos[p]);
      cur = p;
      if (this.effChildren[cur].length >= 2) break;
      p = this.effParent[cur];
    }
    return { links, length, top: cur };
  }
  /** Reduced-tree ancestors of `i` (effective parents upward). */
  effAncestors(i: number): number[] {
    const out: number[] = [];
    let p = this.effParent[i];
    while (p >= 0) {
      out.push(p);
      p = this.effParent[p];
    }
    return out;
  }
  /** Any ancestor (full tree) of `i` is in `set`. */
  underAny(i: number, set: ReadonlySet<number>): boolean {
    let p = this.g.nodes[i].parent;
    while (p >= 0) {
      if (set.has(p)) return true;
      p = this.g.nodes[p].parent;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Symmetric 3x3 eigenvectors (Jacobi), columns sorted by descending eigenvalue. */
function eigen3(m: number[][]): Vector3[] {
  const a = m.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return order.map((i) => new Vector3(v[0][i], v[1][i], v[2][i]).normalize());
}

interface AxisEstimate {
  up: Vector3;
  lateral: Vector3;
  height: number;
  warnings: string[];
}

/**
 * Up axis (unsigned lateral + signed up) from the joint cloud: the lateral
 * axis is the mirror-symmetry normal (candidates: coordinate axes and PCA
 * axes), the up axis is the larger extent of the remaining two, and the up
 * sign points toward the extreme leaf that sits on the mid-plane (the head),
 * away from the paired extremes (the feet).
 */
function estimateAxes(ctx: Ctx, forcedUp: Vector3 | null): AxisEstimate {
  const warnings: string[] = [];
  const pts: Vector3[] = [];
  const idx: number[] = [];
  for (let i = 0; i < ctx.g.nodes.length; i++) {
    if (ctx.kinds[i] === 'passthrough') continue;
    pts.push(ctx.pos[i]);
    idx.push(i);
  }
  if (pts.length < 3) {
    return { up: forcedUp ?? new Vector3(0, 1, 0), lateral: new Vector3(1, 0, 0), height: 0, warnings };
  }
  const c = new Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const d = new Vector3();
  for (const p of pts) {
    d.subVectors(p, c);
    const e = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += e[i] * e[j];
  }
  const extentAlong = (axis: Vector3): number => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const h = p.dot(axis);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    return hi - lo;
  };
  const extent = Math.max(extentAlong(AXES[0]), extentAlong(AXES[1]), extentAlong(AXES[2]), 1e-9);

  // Mirror symmetry score for a candidate normal: mean nearest-neighbour
  // distance of the mirrored cloud over the points that are displaced from
  // the mirror plane (a thin axis, e.g. the depth of a flat T-pose, has too
  // few displaced points to count as a bilateral symmetry).
  const symmetryError = (n: Vector3): number => {
    let total = 0;
    let count = 0;
    const q = new Vector3();
    for (const p of pts) {
      const s = p.clone().sub(c).dot(n);
      if (Math.abs(s) < 0.05 * extent) continue;
      q.copy(p).addScaledVector(n, -2 * s);
      let best = Infinity;
      for (const r of pts) {
        const dd = q.distanceToSquared(r);
        if (dd < best) best = dd;
      }
      total += Math.sqrt(best);
      count++;
    }
    if (count < 0.2 * pts.length) return Infinity;
    return total / count / extent;
  };

  const pca = eigen3(cov);
  const candidateSets: Vector3[][] = [AXES, pca];
  let bestLateral: Vector3 | null = null;
  let bestErr = Infinity;
  let bestSet = AXES;
  for (const set of candidateSets) {
    for (const axis of set) {
      const err = symmetryError(axis);
      if (err < bestErr - 1e-9) {
        bestErr = err;
        bestLateral = axis.clone();
        bestSet = set;
      }
    }
  }
  const lateral = bestLateral ?? new Vector3(1, 0, 0);
  if (bestErr > 0.08) warnings.push('Topology: the skeleton has no clear left/right symmetry plane; the axes may be unreliable.');

  let up: Vector3;
  if (forcedUp) {
    up = forcedUp.clone().normalize();
  } else {
    const others = bestSet.filter((a) => Math.abs(a.dot(lateral)) < 0.999);
    others.sort((a, b) => extentAlong(b) - extentAlong(a));
    up = others[0].clone();
    if (bestSet !== AXES) {
      const snap = snapToAxis(up, 35);
      if (snap.snapped) up = snap.axis;
      else warnings.push('Topology: the rig up axis is not aligned with a principal axis; using the estimated axis as-is.');
    }
    if (resolveUpSign(ctx, up, lateral, extentAlong(up))) up.negate();
  }
  // Keep the lateral axis perpendicular to up.
  lateral.addScaledVector(up, -lateral.dot(up)).normalize();
  return { up, lateral, height: extentAlong(up), warnings };
}

interface LeafPair {
  a: number;
  b: number;
  lca: number;
  /** Shorter of the two chain lengths from the common ancestor. */
  length: number;
}

/**
 * Mirrored pairs of leaf chains: two link leaves mirrored across the lateral
 * axis (|x_a + x_b| < 0.15·height, |x_a − x_b| ≥ 0.04·height) whose paths
 * from their common ancestor each have ≥ 2 links and ≥ 0.25·height of chain.
 * Legs, arms and finger/toe chains qualify; skirts, tails, breasts, eyes and
 * one-link helpers do not.
 */
function mirroredLeafPairs(ctx: Ctx, lateral: Vector3, height: number): LeafPair[] {
  const leaves = ctx.leaves();
  const allLinkPts = ctx.pos.filter((_, i) => ctx.isLink(i));
  const xMid = median(allLinkPts.map((p) => p.dot(lateral)));
  const x = (i: number) => ctx.pos[i].dot(lateral) - xMid;
  const chainStats = (top: number, leaf: number): { links: number; length: number } => {
    let links = 0;
    let length = 0;
    let prev = top;
    for (const i of pathDown(ctx.g, top, leaf)) {
      if (!ctx.isLink(i)) continue;
      links++;
      length += ctx.pos[i].distanceTo(ctx.pos[prev]);
      prev = i;
    }
    return { links, length };
  };
  const pairs: LeafPair[] = [];
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i];
      const b = leaves[j];
      if (Math.abs(x(a) + x(b)) >= 0.15 * height) continue;
      if (Math.abs(x(a) - x(b)) < 0.04 * height) continue;
      const l = lca(ctx.g, [a, b]);
      if (l < 0 || l === a || l === b) continue;
      const sa = chainStats(l, a);
      const sb = chainStats(l, b);
      if (sa.links < 2 || sb.links < 2) continue;
      if (sa.length < 0.25 * height || sb.length < 0.25 * height) continue;
      pairs.push({ a, b, lca: l, length: Math.min(sa.length, sb.length) });
    }
  }
  return pairs;
}

/**
 * Whether the unsigned up axis must be negated. Topological rule first: among
 * the mirrored leaf-chain pairs, the legs are the pair whose common ancestor
 * (the hips) is an ancestor of every other pair's ancestor (the arms branch
 * off the spine, above the hips); down = feet − hips. Falls back to leaf
 * clustering (a centered head leaf at one end, paired feet at the other; then
 * the end with more leaves; then the half with more nodes) when the pairs do
 * not separate (arms attached directly to the hips, no arms, ...).
 */
function resolveUpSign(ctx: Ctx, up: Vector3, lateral: Vector3, extent: number): boolean {
  const pairs = mirroredLeafPairs(ctx, lateral, Math.max(extent, 1e-9));
  if (pairs.length) {
    const lcas = [...new Set(pairs.map((p) => p.lca))];
    const rootMost = lcas.find((l) => lcas.every((m) => m === l || isDescendant(ctx.g, m, l)));
    if (rootMost !== undefined && lcas.length > 1) {
      let legPair = pairs[0];
      for (const p of pairs) if (p.lca === rootMost && (legPair.lca !== rootMost || p.length > legPair.length)) legPair = p;
      if (legPair.lca === rootMost) {
        const feet = ctx.pos[legPair.a].clone().add(ctx.pos[legPair.b]).multiplyScalar(0.5);
        const down = feet.sub(ctx.pos[rootMost]);
        if (Math.abs(down.dot(up)) > 0.05 * extent) return down.dot(up) > 0;
      }
    }
  }
  // Fallback: leaf clustering.
  const pts: Vector3[] = [];
  for (let i = 0; i < ctx.g.nodes.length; i++) if (ctx.kinds[i] !== 'passthrough') pts.push(ctx.pos[i]);
  const xMid = median(pts.map((p) => p.dot(lateral)));
  const leafIdx: number[] = [];
  for (let i = 0; i < ctx.g.nodes.length; i++) if (ctx.kinds[i] === 'link' && ctx.effChildren[i].length === 0) leafIdx.push(i);
  const leafPts = leafIdx.length >= 2 ? leafIdx.map((i) => ctx.pos[i]) : pts;
  let hi = -Infinity;
  let lo = Infinity;
  for (const p of leafPts) {
    const h = p.dot(up);
    if (h > hi) hi = h;
    if (h < lo) lo = h;
  }
  const band = 0.1 * extent;
  let topMin = Infinity;
  let botMin = Infinity;
  let above = 0;
  let below = 0;
  const mid = 0.5 * (hi + lo);
  for (const p of leafPts) {
    const h = p.dot(up);
    const lat = Math.abs(p.dot(lateral) - xMid);
    if (h >= hi - band) topMin = Math.min(topMin, lat);
    if (h <= lo + band) botMin = Math.min(botMin, lat);
    if (h > mid) above++;
    else if (h < mid) below++;
  }
  const centered = 0.03 * extent;
  if (topMin < centered !== botMin < centered) return botMin < centered;
  if (above !== below) return below > above;
  let nodesAbove = 0;
  for (const p of pts) if (p.dot(up) > mid) nodesAbove++;
  return nodesAbove < pts.length - nodesAbove;
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

function isChainLinkForLimb(inf: BoneNameInfo, limb: 'arm' | 'leg'): boolean {
  if (limb === 'arm') return inf.group !== 'torso' && inf.group !== 'leg' && inf.group !== 'face' && inf.group !== 'finger';
  return inf.group !== 'torso' && inf.group !== 'arm' && inf.group !== 'face' && inf.group !== 'finger';
}

function fingerRolesFor(ctx: Ctx, digit: FingerDigit, links: number[]): FingerChain['roles'] {
  let usable = links.filter((i) => {
    const inf = ctx.info[i];
    if (inf.finger?.segment === 'Tip') return false;
    if (digit !== 'Thumb' && (inf.finger?.segment === 'Metacarpal' || (inf.keyword !== null && METACARPAL_TOKENS.has(inf.keyword)))) return false;
    return true;
  });
  if (digit !== 'Thumb' && usable.length >= 4) usable = usable.slice(usable.length - 3);
  if (digit === 'Thumb' && usable.length > 3) usable = usable.slice(0, 3);
  const roles: FingerChain['roles'] = [];
  const segs: FingerChain['roles'][number]['segment'][] =
    digit === 'Thumb'
      ? usable.length >= 3
        ? ['Metacarpal', 'Proximal', 'Distal']
        : usable.length === 2
          ? ['Proximal', 'Distal']
          : ['Proximal']
      : usable.length >= 3
        ? ['Proximal', 'Intermediate', 'Distal']
        : usable.length === 2
          ? ['Proximal', 'Intermediate']
          : ['Proximal'];
  for (let k = 0; k < usable.length && k < segs.length; k++) roles.push({ index: usable[k], segment: segs[k] });
  return roles;
}

const DIGIT_ORDER: FingerDigit[] = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];

/**
 * Finger chains under `hand`, ordered thumb -> little. Digits from names when
 * every chain is consistently named, else from rest positions: the thumb is
 * the chain root that is most forward and closest to the wrist; the others are
 * ordered by distance from the thumb across the hand.
 */
function findFingers(ctx: Ctx, hand: number, wrist: number, forward: Vector3, height: number): FingerChain[] {
  const roots = ctx.effChildren[hand].filter((c) => ctx.info[c].group !== 'face');
  if (roots.length === 0) return [];
  type Cand = { root: number; links: number[]; digit: FingerDigit | null; length: number };
  const cands: Cand[] = roots.map((r) => {
    const links = [r];
    let cur = r;
    while (ctx.effChildren[cur].length === 1) {
      cur = ctx.effChildren[cur][0];
      links.push(cur);
    }
    let digit: FingerDigit | null = null;
    let consistent = true;
    for (const l of links) {
      const f = ctx.info[l].finger;
      if (!f) continue;
      if (digit === null) digit = f.digit;
      else if (digit !== f.digit) consistent = false;
    }
    let length = 0;
    for (let k = 1; k < links.length; k++) length += ctx.pos[links[k]].distanceTo(ctx.pos[links[k - 1]]);
    return { root: r, links, digit: consistent ? digit : null, length };
  });
  // Keep at most five chains: named digits first, then the longest.
  cands.sort((a, b) => Number(b.digit !== null) - Number(a.digit !== null) || b.length - a.length);
  const kept = cands.slice(0, 5);
  const allNamed = kept.every((c) => c.digit !== null) && new Set(kept.map((c) => c.digit)).size === kept.length;
  const out: FingerChain[] = [];
  if (allNamed) {
    kept.sort((a, b) => DIGIT_ORDER.indexOf(a.digit!) - DIGIT_ORDER.indexOf(b.digit!));
    for (const c of kept) out.push({ digit: c.digit!, links: c.links, roles: fingerRolesFor(ctx, c.digit!, c.links), digitSource: 'name' });
    return out;
  }
  // Position-based ordering.
  const wristPos = ctx.pos[wrist];
  const handPos = ctx.pos[hand];
  const scale = Math.max(height, 1e-6);
  let thumb = 0;
  let best = -Infinity;
  kept.forEach((c, k) => {
    const rp = ctx.pos[c.root];
    const forwardness = rp.clone().sub(handPos).dot(forward) / scale;
    const closeness = -rp.distanceTo(wristPos) / scale;
    const s = forwardness + closeness;
    if (s > best) {
      best = s;
      thumb = k;
    }
  });
  const thumbPos = ctx.pos[kept[thumb].root];
  const others = kept.filter((_, k) => k !== thumb);
  others.sort((a, b) => ctx.pos[a.root].distanceTo(thumbPos) - ctx.pos[b.root].distanceTo(thumbPos));
  const ordered = [kept[thumb], ...others];
  ordered.forEach((c, k) => {
    if (k >= DIGIT_ORDER.length) return;
    const digit = DIGIT_ORDER[k];
    out.push({ digit, links: c.links, roles: fingerRolesFor(ctx, digit, c.links), digitSource: 'position' });
  });
  return out;
}

interface WalkResult {
  links: number[];
  intermediates: number[];
}

/** Path links after class constraints, leading displacement rule and near-zero merges. */
function walkLimb(ctx: Ctx, start: number, end: number, limb: 'arm' | 'leg', height: number): WalkResult {
  const path = pathDown(ctx.g, start, end);
  const links: number[] = [];
  const intermediates: number[] = [];
  const startPos = ctx.pos[start];
  for (const i of path) {
    if (!ctx.isLink(i)) {
      if (ctx.kinds[i] === 'passthrough') intermediates.push(i);
      continue;
    }
    const inf = ctx.info[i];
    if (!isChainLinkForLimb(inf, limb)) {
      intermediates.push(i);
      continue;
    }
    if (links.length === 0) {
      // Leading intermediates: nodes that do not displace from the chain start (Genesis pelvis).
      if (limb === 'leg' && ctx.pos[i].distanceTo(startPos) < 0.05 * height) {
        intermediates.push(i);
        continue;
      }
    } else {
      const prev = links[links.length - 1];
      if (ctx.pos[i].distanceTo(ctx.pos[prev]) < 0.02 * height) {
        intermediates.push(i);
        continue;
      }
    }
    links.push(i);
  }
  return { links, intermediates };
}

function buildLeg(ctx: Ctx, hips: number, end: number, height: number, side: LimbSide): LegChain {
  const { links, intermediates } = walkLimb(ctx, hips, end, 'leg', height);
  const leg: LegChain = { side, end, links, intermediates: [...intermediates] };
  if (links.length >= 1) leg.upperLeg = links[0];
  if (links.length >= 2) leg.lowerLeg = links[1];
  if (links.length >= 3) leg.foot = links[2];
  if (links.length >= 4) {
    const rest = links.slice(3);
    const named = rest.find((i) => ctx.info[i].keyword !== null && TOE_TOKENS.has(ctx.info[i].keyword!));
    leg.toes = named ?? rest[rest.length - 1];
    for (const i of rest) if (i !== leg.toes) leg.intermediates.push(i);
  }
  return leg;
}

function buildArm(ctx: Ctx, branch: number, end: number, height: number, side: LimbSide, forward: Vector3): ArmChain {
  const path = pathDown(ctx.g, branch, end);
  // Hand cut: deepest branching link that is not a finger; else the last non-finger link.
  let hand = -1;
  for (const i of path) {
    if (!ctx.isLink(i)) continue;
    if (ctx.info[i].group === 'finger') break;
    if (ctx.effChildren[i].length >= 2) hand = i;
  }
  if (hand < 0) {
    for (const i of path) {
      if (!ctx.isLink(i)) continue;
      if (ctx.info[i].group === 'finger') break;
      hand = i;
    }
  }
  if (hand < 0) hand = end;
  const { links, intermediates } = walkLimb(ctx, branch, hand, 'arm', height);
  const arm: ArmChain = { side, end, links, intermediates, fingers: [] };
  const n = links.length;
  const kw = (i: number) => ctx.info[i].keyword;
  const firstIsShoulder = (): boolean => {
    const k0 = kw(links[0]);
    if (n >= 4) return true;
    if (k0 !== null && CLAVICLE_TOKENS.has(k0)) return true;
    if (k0 === 'shoulder' && n >= 2) {
      const k1 = kw(links[1]);
      if (k1 !== null && UPPER_ARM_TOKENS.has(k1)) return true;
    }
    return false;
  };
  if (n >= 4) {
    arm.shoulder = links[0];
    arm.upperArm = links[n - 3];
    arm.lowerArm = links[n - 2];
    arm.hand = links[n - 1];
    for (let k = 1; k < n - 3; k++) arm.intermediates.push(links[k]);
  } else if (n === 3) {
    if (firstIsShoulder()) {
      arm.shoulder = links[0];
      arm.upperArm = links[1];
      arm.lowerArm = links[2];
    } else {
      arm.upperArm = links[0];
      arm.lowerArm = links[1];
      arm.hand = links[2];
    }
  } else if (n === 2) {
    if (firstIsShoulder()) {
      arm.shoulder = links[0];
      arm.upperArm = links[1];
    } else {
      arm.upperArm = links[0];
      arm.lowerArm = links[1];
    }
  } else if (n === 1) {
    arm.upperArm = links[0];
  }
  if (arm.hand !== undefined) arm.fingers = findFingers(ctx, arm.hand, arm.lowerArm ?? arm.upperArm ?? arm.hand, forward, height);
  return arm;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function emptyResult(ctx: Ctx | null, warnings: string[]): TopologyResult {
  return {
    hips: -1,
    spineBranch: -1,
    headLeaf: -1,
    torso: [],
    torsoIntermediates: [],
    headChain: [],
    headIntermediates: [],
    arms: { left: null, right: null },
    legs: { left: null, right: null },
    roles: new Map(),
    nameAgrees: new Map(),
    axes: { up: [0, 1, 0], forward: [0, 0, 1], facingSource: 'assumed' },
    left: [1, 0, 0],
    height: 0,
    sideSource: 'geometry',
    info: ctx ? ctx.info : [],
    kinds: ctx ? ctx.kinds : [],
    markers: ctx ? ctx.markers : [],
    warnings,
  };
}

/**
 * Detects hips, torso chain, head chain, arm and leg chains, the rig axes and
 * the sides from the graph's bind pose (docs/DESIGN.md §5.4).
 */
export function analyzeTopology(graph: SkeletonGraph, opts: TopologyOptions = {}): TopologyResult {
  const warnings: string[] = [];
  if (graph.nodes.length < 3) {
    warnings.push('Topology: too few nodes to analyze.');
    return emptyResult(null, warnings);
  }
  const ctx = new Ctx(graph);
  const est = estimateAxes(ctx, opts.vrm ? new Vector3(0, 1, 0) : null);
  for (const w of est.warnings) warnings.push(w);
  const up = est.up;
  const lateral = est.lateral;
  const height = est.height > 0 ? est.height : Math.max(1e-6, 1);
  const h = (i: number) => ctx.pos[i].dot(up);
  const allLinkPts = ctx.pos.filter((_, i) => ctx.isLink(i));
  const xMid = median(allLinkPts.map((p) => p.dot(lateral)));
  const x = (i: number) => ctx.pos[i].dot(lateral) - xMid;

  const result = emptyResult(ctx, warnings);
  result.height = height;

  // ---------------------------------------------------------------- feet
  // The lowest mirrored pair of leaf chains (>= 2 links, >= 0.25·height from
  // the common ancestor: drops skirts, tails, heel helpers; individual toe
  // chains still find the feet because the chain is measured from the pair's
  // common ancestor).
  const leaves = ctx.leaves();
  let footA = -1;
  let footB = -1;
  {
    const pairs = mirroredLeafPairs(ctx, lateral, height).map((p) => ({ ...p, top: Math.max(h(p.a), h(p.b)) }));
    pairs.sort((p, q) => p.top - q.top);
    if (pairs.length) {
      footA = pairs[0].a;
      footB = pairs[0].b;
    }
  }
  if (footA < 0) warnings.push('Topology: no mirrored pair of leg chains found (feet); legs are unmapped.');
  const legLca = footA >= 0 ? lca(graph, [footA, footB]) : -1;
  const legPathNodes = new Set<number>();
  if (legLca >= 0) {
    for (const f of [footA, footB]) for (const i of pathDown(graph, legLca, f)) legPathNodes.add(i);
  }
  const onLeg = (i: number) => legPathNodes.has(i) || ctx.underAny(i, legPathNodes);

  // ---------------------------------------------------------------- hands
  const handCands = leaves.filter((l) => !onLeg(l) && Math.abs(x(l)) >= 0.1 * height);
  handCands.sort((a, b) => Math.abs(x(b)) - Math.abs(x(a)));
  let handA = -1;
  let handB = -1;
  outer: for (let i = 0; i < handCands.length; i++) {
    const a = handCands[i];
    for (let j = i + 1; j < handCands.length; j++) {
      const b = handCands[j];
      if (Math.sign(x(a)) === Math.sign(x(b))) continue;
      if (Math.abs(x(a) + x(b)) >= 0.15 * height) continue;
      const l = lca(graph, [a, b]);
      if (l < 0 || l === a || l === b) continue;
      if (pathDown(graph, l, a).filter((k) => ctx.isLink(k)).length < 2 || pathDown(graph, l, b).filter((k) => ctx.isLink(k)).length < 2) continue;
      handA = a;
      handB = b;
      break outer;
    }
  }
  if (handA < 0) warnings.push('Topology: no mirrored pair of arm chains found (hands); arms are unmapped.');
  const armLca = handA >= 0 ? lca(graph, [handA, handB]) : -1;
  const armPathNodes = new Set<number>();
  if (armLca >= 0) {
    for (const hnd of [handA, handB]) for (const i of pathDown(graph, armLca, hnd)) armPathNodes.add(i);
  }
  const onArm = (i: number) => armPathNodes.has(i) || ctx.underAny(i, armPathNodes);

  // ---------------------------------------------------------------- head leaf
  let headLeaf = -1;
  {
    const minH = armLca >= 0 ? h(armLca) + 0.05 * height : legLca >= 0 ? h(legLca) : -Infinity;
    const cands = leaves.filter((l) => !onLeg(l) && !onArm(l) && h(l) > minH);
    cands.sort((a, b) => h(b) - h(a));
    if (cands.length) headLeaf = cands[0];
  }
  if (headLeaf < 0) warnings.push('Topology: no head chain found above the arm branch.');
  result.headLeaf = headLeaf;

  // ---------------------------------------------------------------- hips and spine branch
  const hipsSet = [footA, footB, headLeaf >= 0 ? headLeaf : armLca].filter((i) => i >= 0);
  let hips = hipsSet.length ? lca(graph, hipsSet) : -1;
  if (hips >= 0 && !ctx.isLink(hips)) {
    if (graph.nodes[hips].isJoint || !graph.hasSkinWeights) warnings.push(`Topology: the hips node '${graph.nodes[hips].name}' carries no skin weight.`);
    else {
      warnings.push(`Topology: the common ancestor of the legs and the head ('${graph.nodes[hips].name}') is not a skin joint; the rig cannot be driven as a humanoid.`);
      hips = -1;
    }
  }
  const branchSet = [handA, handB, headLeaf].filter((i) => i >= 0);
  let spineBranch = branchSet.length ? lca(graph, branchSet) : -1;
  if (hips >= 0 && spineBranch >= 0 && spineBranch !== hips && pathDown(graph, hips, spineBranch).length === 0) {
    warnings.push('Topology: the arm branch is not below the hips; torso unmapped.');
    spineBranch = -1;
  }
  result.hips = hips;
  result.spineBranch = spineBranch;
  if (hips < 0) {
    warnings.push('Topology: no hips (common ancestor of both legs and the head) found.');
  }

  // ---------------------------------------------------------------- sides and facing (one decision)
  const legA = footA >= 0 && hips >= 0 ? walkLimb(ctx, hips, footA, 'leg', height) : null;
  const legB = footB >= 0 && hips >= 0 ? walkLimb(ctx, hips, footB, 'leg', height) : null;
  const armA = handA >= 0 && spineBranch >= 0 ? pathDown(graph, spineBranch, handA).filter((i) => ctx.isLink(i) && ctx.info[i].group !== 'finger') : null;
  const armB = handB >= 0 && spineBranch >= 0 ? pathDown(graph, spineBranch, handB).filter((i) => ctx.isLink(i) && ctx.info[i].group !== 'finger') : null;

  const chainSide = (links: number[] | null): { side: LimbSide | null; count: number; contradiction: boolean } => {
    if (!links) return { side: null, count: 0, contradiction: false };
    let side: LimbSide | null = null;
    let count = 0;
    let contradiction = false;
    for (const i of links) {
      const s = ctx.info[i].side;
      if (s !== 'left' && s !== 'right') continue;
      count++;
      if (side === null) side = s;
      else if (side !== s) contradiction = true;
    }
    return { side, count, contradiction };
  };
  const sLegA = chainSide(legA?.links ?? null);
  const sLegB = chainSide(legB?.links ?? null);
  const sArmA = chainSide(armA);
  const sArmB = chainSide(armB);
  const sidedCount = sLegA.count + sLegB.count + sArmA.count + sArmB.count;
  let namesConsistent = sidedCount >= 4 && !sLegA.contradiction && !sLegB.contradiction && !sArmA.contradiction && !sArmB.contradiction;
  const leftDirFromNames = new Vector3();
  if (namesConsistent) {
    const pairs: [{ side: LimbSide | null }, { side: LimbSide | null }, number, number][] = [];
    if (legA && legB && legA.links.length && legB.links.length) pairs.push([sLegA, sLegB, legA.links[0], legB.links[0]]);
    if (armA && armB && armA.length && armB.length) pairs.push([sArmA, sArmB, armA[armA.length - 1], armB[armB.length - 1]]);
    let used = 0;
    for (const [sa, sb, ia, ib] of pairs) {
      if (sa.side === null && sb.side === null) continue;
      if (sa.side !== null && sb.side !== null && sa.side === sb.side) {
        namesConsistent = false;
        break;
      }
      const leftIdx = sa.side === 'left' || sb.side === 'right' ? ia : ib;
      const rightIdx = leftIdx === ia ? ib : ia;
      const d = ctx.pos[leftIdx].clone().sub(ctx.pos[rightIdx]);
      d.addScaledVector(up, -d.dot(up));
      if (d.length() < 0.02 * height) continue;
      leftDirFromNames.add(d.normalize());
      used++;
    }
    if (used === 0 || leftDirFromNames.length() < 0.5) namesConsistent = false;
    // Arms and legs must agree on which x sign is left.
    if (namesConsistent && pairs.length === 2) {
      const dirs = pairs.map(([sa, sb, ia, ib]) => {
        if (sa.side === null && sb.side === null) return null;
        const leftIdx = sa.side === 'left' || sb.side === 'right' ? ia : ib;
        const rightIdx = leftIdx === ia ? ib : ia;
        const d = ctx.pos[leftIdx].clone().sub(ctx.pos[rightIdx]);
        return d.addScaledVector(up, -d.dot(up)).normalize();
      });
      if (dirs[0] && dirs[1] && dirs[0].dot(dirs[1]) < 0) {
        namesConsistent = false;
        warnings.push('Topology: the left/right bone names of the arms and the legs contradict each other; sides taken from geometry.');
      }
    }
  }

  // Facing cues from geometry.
  const toesForward = new Vector3();
  for (const leg of [legA, legB]) {
    if (!leg || leg.links.length < 4) continue;
    const foot = leg.links[2];
    const rest = leg.links.slice(3);
    const toes = rest.find((i) => ctx.info[i].keyword !== null && TOE_TOKENS.has(ctx.info[i].keyword!)) ?? rest[rest.length - 1];
    const d = ctx.pos[toes].clone().sub(ctx.pos[foot]);
    d.addScaledVector(up, -d.dot(up));
    toesForward.add(d);
  }
  const toesUsable = toesForward.length() > 0.02 * height;
  const frontMarker = ((): Vector3 | null => {
    if (headLeaf < 0 || spineBranch < 0) return null;
    const headPath = pathDown(graph, spineBranch, headLeaf).filter((i) => ctx.isLink(i));
    for (const node of headPath) {
      for (const c of graph.nodes[node].children) {
        if (ctx.isLink(c) && headPath.includes(c)) continue;
        const inf = ctx.info[c];
        if (inf.tokens.includes('front') || inf.tokens.includes('headfront')) {
          const d = ctx.pos[c].clone().sub(ctx.pos[node]);
          d.addScaledVector(up, -d.dot(up));
          if (d.length() > 0.01 * height) return d.normalize();
        }
      }
    }
    return null;
  })();

  let forward: Vector3;
  let facingSource: RigAxes['facingSource'];
  let left: Vector3;
  let sideSource: TopologyResult['sideSource'] = 'geometry';
  if (opts.vrm) {
    forward = new Vector3(0, 0, 1);
    facingSource = 'vrm';
    left = new Vector3().crossVectors(up, forward).normalize();
    if (namesConsistent) sideSource = 'names';
  } else if (namesConsistent) {
    left = leftDirFromNames.normalize();
    forward = new Vector3().crossVectors(left, up).normalize();
    facingSource = 'names';
    sideSource = 'names';
    if (toesUsable && toesForward.dot(forward) < 0) {
      warnings.push('Topology: the feet point the opposite way from what the left/right bone names imply; trusting the names (use "swap sides" if the model faces backward).');
    } else if (frontMarker && frontMarker.dot(forward) < 0) {
      warnings.push('Topology: the head front marker points the opposite way from what the left/right bone names imply; trusting the names.');
    }
  } else if (toesUsable) {
    forward = toesForward.clone().normalize();
    facingSource = 'toes';
    left = new Vector3().crossVectors(up, forward).normalize();
  } else if (frontMarker) {
    forward = frontMarker.clone();
    facingSource = 'marker';
    left = new Vector3().crossVectors(up, forward).normalize();
  } else {
    forward = Math.abs(up.z) > 0.7 ? new Vector3(0, -1, 0) : new Vector3(0, 0, 1);
    forward.addScaledVector(up, -forward.dot(up)).normalize();
    facingSource = 'assumed';
    left = new Vector3().crossVectors(up, forward).normalize();
    warnings.push(`Topology: facing assumed (${forward.z > 0.5 ? '+Z' : '-Y'}): no sided bone names, toes or front marker found. Use "swap sides" if the model faces backward.`);
  }
  // Snap the facing to a principal axis when it is close to one (asymmetric rigs give slightly skewed estimates).
  if (facingSource !== 'vrm') {
    const snap = snapToAxis(forward, 25);
    if (snap.snapped) {
      forward = snap.axis.clone().addScaledVector(up, -snap.axis.dot(up)).normalize();
      left = new Vector3().crossVectors(up, forward).normalize();
    }
  }
  result.axes = { up: tup(up), forward: tup(forward), facingSource };
  result.left = tup(left);
  result.sideSource = sideSource;

  // ---------------------------------------------------------------- assign sides
  const sideOfLeg = (links: number[] | null, named: { side: LimbSide | null }, end: number): LimbSide => {
    if (sideSource === 'names' && named.side) return named.side;
    const ref = links && links.length ? links[0] : end;
    return ctx.pos[ref].clone().sub(ctx.pos[hips >= 0 ? hips : ref]).dot(left) >= 0 ? 'left' : 'right';
  };
  const legs: { left: LegChain | null; right: LegChain | null } = { left: null, right: null };
  if (hips >= 0 && footA >= 0 && legA && legB) {
    let sa = sideOfLeg(legA.links, sLegA, footA);
    let sb = sideOfLeg(legB.links, sLegB, footB);
    if (sa === sb) {
      // Geometry tie-break.
      sa = x(footA) * (left.dot(lateral) >= 0 ? 1 : -1) >= 0 ? 'left' : 'right';
      sb = sa === 'left' ? 'right' : 'left';
    }
    legs[sa] = buildLeg(ctx, hips, footA, height, sa);
    legs[sb] = buildLeg(ctx, hips, footB, height, sb);
  }
  const arms: { left: ArmChain | null; right: ArmChain | null } = { left: null, right: null };
  if (spineBranch >= 0 && handA >= 0 && armA && armB) {
    const sideOfArm = (links: number[], named: { side: LimbSide | null }, end: number): LimbSide => {
      if (sideSource === 'names' && named.side) return named.side;
      const ref = links.length ? links[links.length - 1] : end;
      return ctx.pos[ref].clone().sub(ctx.pos[spineBranch]).dot(left) >= 0 ? 'left' : 'right';
    };
    let sa = sideOfArm(armA, sArmA, handA);
    let sb = sideOfArm(armB, sArmB, handB);
    if (sa === sb) {
      sa = x(handA) * (left.dot(lateral) >= 0 ? 1 : -1) >= 0 ? 'left' : 'right';
      sb = sa === 'left' ? 'right' : 'left';
    }
    arms[sa] = buildArm(ctx, spineBranch, handA, height, sa, forward);
    arms[sb] = buildArm(ctx, spineBranch, handB, height, sb, forward);
  }
  result.legs = legs;
  result.arms = arms;

  // ---------------------------------------------------------------- torso chain
  const roles = result.roles;
  const agrees = result.nameAgrees;
  const setRole = (i: number, role: HumanoidBone, agree: boolean) => {
    roles.set(i, role);
    agrees.set(i, agree);
  };
  if (hips >= 0) setRole(hips, 'hips', ctx.info[hips].group === 'torso');
  if (hips >= 0 && spineBranch >= 0 && spineBranch !== hips) {
    const path = pathDown(graph, hips, spineBranch);
    const links: number[] = [];
    let prevPos = ctx.pos[hips];
    for (const i of path) {
      if (!ctx.isLink(i)) {
        result.torsoIntermediates.push(i);
        continue;
      }
      const g = ctx.info[i].group;
      if (g === 'arm' || g === 'leg' || g === 'finger' || g === 'face') {
        result.torsoIntermediates.push(i);
        warnings.push(`Topology: '${graph.nodes[i].name}' lies on the torso chain but is named like a ${g} bone; left unmapped.`);
        continue;
      }
      if (ctx.pos[i].distanceTo(prevPos) < 0.02 * height && i !== spineBranch) {
        result.torsoIntermediates.push(i);
        continue;
      }
      links.push(i);
      prevPos = ctx.pos[i];
    }
    result.torso = links;
    const n = links.length;
    if (n >= 1) setRole(links[0], 'spine', ctx.info[links[0]].group === 'torso');
    if (n >= 2) {
      const chestIdx = Math.floor(n / 2); // link round(N/2) toward the upper link, 0-based: N=2 -> 2nd, N=3 -> 2nd, N=4 -> 3rd, N=5 -> 3rd
      setRole(links[chestIdx], 'chest', ctx.info[links[chestIdx]].group === 'torso');
    }
    if (n >= 3) setRole(links[n - 1], 'upperChest', ctx.info[links[n - 1]].group === 'torso');
    for (const i of links) if (!roles.has(i)) result.torsoIntermediates.push(i);
  } else if (hips >= 0 && spineBranch === hips) {
    warnings.push('Topology: the arms attach directly to the hips; no spine bone.');
  }

  // ---------------------------------------------------------------- head chain
  if (headLeaf >= 0 && (spineBranch >= 0 || hips >= 0)) {
    const from = spineBranch >= 0 ? spineBranch : hips;
    const path = pathDown(graph, from, headLeaf);
    const links: number[] = [];
    for (const i of path) {
      if (!ctx.isLink(i)) {
        result.headIntermediates.push(i);
        continue;
      }
      const g = ctx.info[i].group;
      if (g === 'face') break;
      if (g === 'arm' || g === 'leg' || g === 'finger') {
        result.headIntermediates.push(i);
        continue;
      }
      links.push(i);
    }
    if (links.length) {
      let head = -1;
      // The link named `head`: exactly the head token (Head, J_Bip_C_Head, CC_Base_Head)
      // or a head-class link that carries skin weight; a zero-weight leaf such as
      // the Meshy `headfront` marker never wins over its parent.
      const namedHead = (i: number): boolean => {
        const inf = ctx.info[i];
        if (inf.group !== 'torso' || inf.keyword === null || !HEAD_TOKENS.has(inf.keyword)) return false;
        if (inf.tokens.length === 1) return true;
        const nd = graph.nodes[i];
        return !graph.hasSkinWeights || nd.weight > 0;
      };
      for (const i of links) {
        if (namedHead(i)) {
          head = i;
          break;
        }
      }
      if (head < 0) {
        // Else the last link before facial/hair branching.
        for (const i of links) if (ctx.effChildren[i].length >= 2) head = i;
      }
      if (head < 0) {
        const last = links[links.length - 1];
        const lastIsMarkerLike = ctx.effChildren[last].length === 0 && graph.hasSkinWeights && !(graph.nodes[last].weight > 0) && links.length >= 2;
        head = lastIsMarkerLike ? links[links.length - 2] : last;
      }
      const headPos = links.indexOf(head);
      const chain = links.slice(0, headPos + 1);
      result.headChain = chain;
      setRole(head, 'head', ctx.info[head].group === 'torso');
      if (chain.length >= 2) setRole(chain[0], 'neck', ctx.info[chain[0]].group === 'torso');
      for (const i of links) if (!roles.has(i)) result.headIntermediates.push(i);
    }
  }

  // ---------------------------------------------------------------- limb roles
  const sideAgrees = (i: number, side: LimbSide, group: 'arm' | 'leg'): boolean => {
    const inf = ctx.info[i];
    return inf.group === group && (inf.side === side || inf.side === null);
  };
  for (const side of ['left', 'right'] as const) {
    const leg = legs[side];
    if (leg) {
      if (leg.upperLeg !== undefined) setRole(leg.upperLeg, `${side}UpperLeg`, sideAgrees(leg.upperLeg, side, 'leg'));
      if (leg.lowerLeg !== undefined) setRole(leg.lowerLeg, `${side}LowerLeg`, sideAgrees(leg.lowerLeg, side, 'leg'));
      if (leg.foot !== undefined) setRole(leg.foot, `${side}Foot`, sideAgrees(leg.foot, side, 'leg'));
      if (leg.toes !== undefined) setRole(leg.toes, `${side}Toes`, sideAgrees(leg.toes, side, 'leg'));
    }
    const arm = arms[side];
    if (arm) {
      if (arm.shoulder !== undefined) setRole(arm.shoulder, `${side}Shoulder`, sideAgrees(arm.shoulder, side, 'arm'));
      if (arm.upperArm !== undefined) setRole(arm.upperArm, `${side}UpperArm`, sideAgrees(arm.upperArm, side, 'arm'));
      if (arm.lowerArm !== undefined) setRole(arm.lowerArm, `${side}LowerArm`, sideAgrees(arm.lowerArm, side, 'arm'));
      if (arm.hand !== undefined) setRole(arm.hand, `${side}Hand`, sideAgrees(arm.hand, side, 'arm'));
      for (const f of arm.fingers) {
        for (const r of f.roles) setRole(r.index, `${side}${f.digit}${r.segment}` as HumanoidBone, f.digitSource === 'name' && (ctx.info[r.index].side === side || ctx.info[r.index].side === null));
      }
    }
  }
  return result;
}

/**
 * Quaternion mapping the detected `up` to +Y and `forward` to +Z (left = up × forward
 * ends at +X). Identity for a standard Y-up, +Z-facing rig.
 */
export function rootCorrectionFromAxes(axes: RigAxes, out = new Quaternion()): Quaternion {
  const up = new Vector3().fromArray(axes.up).normalize();
  let fwd = new Vector3().fromArray(axes.forward);
  fwd.addScaledVector(up, -fwd.dot(up));
  if (fwd.length() < 1e-6) {
    fwd = Math.abs(up.z) > 0.7 ? new Vector3(0, -1, 0) : new Vector3(0, 0, 1);
    fwd.addScaledVector(up, -fwd.dot(up));
  }
  fwd.normalize();
  const left = new Vector3().crossVectors(up, fwd).normalize();
  const m = new Matrix4().makeBasis(left, up, fwd); // canonical -> rig
  return out.setFromRotationMatrix(m).invert(); // rig -> canonical
}
