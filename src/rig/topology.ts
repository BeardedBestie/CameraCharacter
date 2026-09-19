/**
 * Topology detector: finds the humanoid structure of a {@link SkeletonGraph}
 * from rest positions and hierarchy alone (docs/DESIGN.md §5.4, "Topology
 * detector"). Names are consulted only to exclude helper bones, to collapse
 * Rigify-style continuation segments and, as a fallback, to orient the rig.
 *
 * Pure: three.js math classes only.
 */
import { Vector3 } from 'three';
import type { Vec3Tuple } from '../core/types';
import { isHelperBone, isSegmentOf, isTailMarker, normalizeBoneName } from './boneNames';
import { graphExtent, type SkeletonGraph } from './skeletonGraph';

export interface FingerChain {
  finger: 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Little';
  /** Node indices from the finger root outward (tail markers excluded). */
  links: number[];
}

export interface ArmChain {
  shoulder?: number;
  upperArm: number;
  lowerArm?: number;
  hand?: number;
  fingers: FingerChain[];
  /** Full walked chain (after helper/segment removal), for diagnostics. */
  chain: number[];
}

export interface LegChain {
  upperLeg: number;
  lowerLeg?: number;
  foot?: number;
  toes?: number;
  chain: number[];
}

export interface RigAxes {
  up: Vec3Tuple;
  forward: Vec3Tuple;
}

export interface TopologyResult {
  hips?: number;
  /** From the hips upward, excluding the hips, ending at the arm branch node. */
  spineChain: number[];
  neck?: number;
  head?: number;
  /** Nodes of the head chain from the branch node upward (neck..head). */
  headChain: number[];
  arms: { left?: ArmChain; right?: ArmChain };
  legs: { left?: LegChain; right?: LegChain };
  axes: RigAxes;
  /** Which cue decided the forward axis. */
  forwardSource: 'toes' | 'foot' | 'names' | 'head' | 'default' | 'override';
  warnings: string[];
}

export interface TopologyOptions {
  /** Force the forward axis (used when reconciling with name sides). */
  forward?: Vec3Tuple;
  /** Force the up axis. */
  up?: Vec3Tuple;
}

const PRINCIPAL: Vec3Tuple[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const v3 = (t: Vec3Tuple) => new Vector3(t[0], t[1], t[2]);
const tup = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];

/** Snap a direction to the nearest principal axis when within `maxDeg`, else return it normalized. */
export function snapToAxis(dir: Vector3, maxDeg = 35): { axis: Vector3; snapped: boolean } {
  const d = dir.clone().normalize();
  let best = PRINCIPAL[2];
  let bestDot = -Infinity;
  for (const p of PRINCIPAL) {
    const dot = d.x * p[0] + d.y * p[1] + d.z * p[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = p;
    }
  }
  if (bestDot >= Math.cos((maxDeg * Math.PI) / 180)) return { axis: v3(best), snapped: true };
  return { axis: d, snapped: false };
}

class Ctx {
  pos: Vector3[];
  helper: boolean[];
  tail: boolean[];
  effChildren: number[][];
  depth: number[];
  extent: number;
  constructor(public g: SkeletonGraph) {
    this.pos = g.nodes.map((n) => v3(n.restPos));
    this.helper = g.nodes.map((n) => isHelperBone(n.name));
    this.tail = g.nodes.map((n) => isTailMarker(n.name));
    this.extent = graphExtent(g) || 1;
    this.effChildren = g.nodes.map((n) => n.children.filter((c) => !this.helper[c] && !this.tail[c]));
    this.depth = g.nodes.map((_, i) => this.effDepth(i));
  }
  private effDepth(i: number): number {
    let best = 0;
    for (const c of this.effChildren[i]) best = Math.max(best, 1 + this.effDepth(c));
    return best;
  }
  /** Children that continue a chain: helpers, tail markers and zero-length duplicates skipped. */
  chainChildren(i: number): number[] {
    return this.effChildren[i];
  }
  link(a: number, b: number): Vector3 {
    return this.pos[b].clone().sub(this.pos[a]);
  }
  mainChild(i: number): number {
    let best = -1;
    let bestDepth = -1;
    let bestLen = -1;
    for (const c of this.effChildren[i]) {
      const d = this.depth[c];
      const len = this.link(i, c).length();
      if (d > bestDepth || (d === bestDepth && len > bestLen)) {
        best = c;
        bestDepth = d;
        bestLen = len;
      }
    }
    return best;
  }
  /**
   * Walks a limb chain from `start`, collapsing continuation segments and
   * zero-length links, stopping at the end-effector (leaf or finger branch).
   */
  walkLimb(start: number, maxLinks = 8): number[] {
    const chain: number[] = [start];
    let cur = start;
    let guard = 0;
    while (guard++ < 64) {
      const kids = this.effChildren[cur];
      if (kids.length === 0) break;
      let next: number;
      if (kids.length === 1) next = kids[0];
      else if (kids.length >= 3) break; // fingers / toes: end effector
      else {
        const [a, b] = kids;
        const da = this.depth[a];
        const db = this.depth[b];
        if (Math.min(da, db) >= 1 && Math.abs(da - db) <= 1) break; // two finger chains
        next = this.mainChild(cur);
      }
      const nameNext = this.g.nodes[next].name;
      const nameCur = this.g.nodes[cur].name;
      const len = this.link(cur, next).length();
      const segment = isSegmentOf(nameNext, nameCur) || len < 0.005 * this.extent;
      if (!segment) {
        chain.push(next);
        if (chain.length > maxLinks) break;
      }
      cur = next;
    }
    return chain;
  }
  lowest(i: number, up: Vector3): number {
    let m = this.pos[i].dot(up);
    for (const c of this.g.nodes[i].children) m = Math.min(m, this.lowest(c, up));
    return m;
  }
  minAlong(up: Vector3): number {
    let m = Infinity;
    for (const p of this.pos) m = Math.min(m, p.dot(up));
    return m;
  }
}

interface Pair {
  a: number;
  b: number;
  /** Pass-through node between `at` and the pair (e.g. pelvis), or -1. */
  via: number;
  score: number;
  latA: Vector3;
  latB: Vector3;
}

/**
 * Finds the best mirrored pair of chains hanging from `at` (children or
 * grandchildren through a single pass-through node). `accept` filters chain
 * roots by their walked chain; `weight` scores a single chain.
 */
function findMirroredPair(
  ctx: Ctx,
  at: number,
  up: Vector3,
  accept: (root: number, chain: number[]) => boolean,
  weight: (root: number, chain: number[]) => number,
): Pair | null {
  const roots: { root: number; via: number; chain: number[]; lat: Vector3; w: number }[] = [];
  const consider = (root: number, via: number) => {
    const chain = ctx.walkLimb(root, 5);
    if (chain.length < 2 || !accept(root, chain)) return;
    const ref = chain[Math.min(1, chain.length - 1)];
    const off = ctx.pos[ref].clone().sub(ctx.pos[at]);
    const lat = off.clone().addScaledVector(up, -off.dot(up));
    if (lat.length() < 0.01 * ctx.extent) return;
    roots.push({ root, via, chain, lat, w: weight(root, chain) });
  };
  for (const c of ctx.effChildren[at]) {
    consider(c, -1);
    for (const gc of ctx.effChildren[c]) consider(gc, c);
  }
  let best: Pair | null = null;
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const A = roots[i];
      const B = roots[j];
      if (A.via !== B.via) continue;
      // Mirror symmetry across a plane containing `up`: equal and opposite
      // components along the lateral axis, equal components perpendicular to it.
      const diff = A.lat.clone().sub(B.lat);
      const dl = diff.length();
      if (dl < 0.02 * ctx.extent) continue;
      const axis = diff.clone().multiplyScalar(1 / dl);
      const xA = A.lat.dot(axis);
      const xB = B.lat.dot(axis);
      if (Math.min(Math.abs(xA), Math.abs(xB)) < 0.25 * dl) continue;
      const pA = A.lat.clone().addScaledVector(axis, -xA);
      const pB = B.lat.clone().addScaledVector(axis, -xB);
      const sym = 1 - (Math.abs(Math.abs(xA) - Math.abs(xB)) + pA.sub(pB).length()) / dl;
      const lenA = ctx.pos[A.chain[A.chain.length - 1]].distanceTo(ctx.pos[A.root]);
      const lenB = ctx.pos[B.chain[B.chain.length - 1]].distanceTo(ctx.pos[B.root]);
      const lenSim = 1 - Math.abs(lenA - lenB) / Math.max(lenA, lenB, 1e-6);
      if (sym < 0.5 || lenSim < 0.5) continue;
      const score = sym + lenSim + 0.5 * (A.w + B.w) + (A.via < 0 ? 0.2 : 0);
      if (!best || score > best.score) best = { a: A.root, b: B.root, via: A.via, score, latA: A.lat, latB: B.lat };
    }
  }
  return best;
}

interface HipsCandidate {
  node: number;
  up: Vector3;
  legs: Pair;
  spine: number;
  score: number;
}

function evaluateHips(ctx: Ctx, node: number, up: Vector3, floor: number): HipsCandidate | null {
  const h = ctx.pos[node].dot(up);
  const above = h - floor;
  if (above <= 0.05 * ctx.extent) return null;
  const legs = findMirroredPair(
    ctx,
    node,
    up,
    (root, chain) => {
      const end = ctx.pos[chain[chain.length - 1]];
      const d = end.clone().sub(ctx.pos[root]);
      if (d.length() < 0.05 * ctx.extent) return false;
      if (d.dot(up) / d.length() > -0.5) return false;
      const low = ctx.lowest(root, up);
      return (low - floor) / above < 0.45;
    },
    (root, chain) => {
      const low = ctx.lowest(root, up);
      const reach = 1 - (low - floor) / above;
      return reach + Math.min(chain.length, 4) / 8;
    },
  );
  if (!legs) return null;
  // Spine child: another child whose subtree rises above the node and is not a leg / leg pass-through.
  let spine = -1;
  let spineSize = -1;
  for (const c of ctx.effChildren[node]) {
    if (c === legs.a || c === legs.b || c === legs.via) continue;
    const size = 1 + countSubtree(ctx.g, c);
    const top = highest(ctx, c, up);
    if (top - h < 0.05 * ctx.extent) continue;
    if (size > spineSize) {
      spineSize = size;
      spine = c;
    }
  }
  if (spine < 0) return null;
  const legLow = Math.min(ctx.lowest(legs.a, up), ctx.lowest(legs.b, up));
  const reach = 1 - (legLow - floor) / above;
  const depthBonus = 0.02 * ancestorsCount(ctx.g, node);
  const score = legs.score + 2 * reach + Math.min(spineSize, 30) / 30 + depthBonus;
  return { node, up: up.clone(), legs, spine, score };
}

function countSubtree(g: SkeletonGraph, i: number): number {
  let n = 0;
  for (const c of g.nodes[i].children) n += 1 + countSubtree(g, c);
  return n;
}
function highest(ctx: Ctx, i: number, up: Vector3): number {
  let m = ctx.pos[i].dot(up);
  for (const c of ctx.g.nodes[i].children) m = Math.max(m, highest(ctx, c, up));
  return m;
}
function ancestorsCount(g: SkeletonGraph, i: number): number {
  let n = 0;
  let p = g.nodes[i].parent;
  while (p >= 0) {
    n++;
    p = g.nodes[p].parent;
  }
  return n;
}

function legChainFromWalk(chain: number[]): LegChain {
  const c = chain.slice(0, 4);
  return { upperLeg: c[0], lowerLeg: c[1], foot: c[2], toes: c[3], chain };
}

function armChainFromWalk(ctx: Ctx, chain: number[]): ArmChain {
  let shoulder: number | undefined;
  let upperArm: number;
  let lowerArm: number | undefined;
  let hand: number | undefined;
  const k = chain.length;
  if (k >= 4) {
    shoulder = chain[k - 4];
    upperArm = chain[k - 3];
    lowerArm = chain[k - 2];
    hand = chain[k - 1];
  } else if (k === 3) {
    const l0 = ctx.link(chain[0], chain[1]).length();
    const l1 = ctx.link(chain[1], chain[2]).length();
    if (l0 < 0.45 * l1) {
      shoulder = chain[0];
      upperArm = chain[1];
      lowerArm = chain[2];
    } else {
      upperArm = chain[0];
      lowerArm = chain[1];
      hand = chain[2];
    }
  } else if (k === 2) {
    upperArm = chain[0];
    lowerArm = chain[1];
  } else {
    upperArm = chain[0];
  }
  const fingers = hand !== undefined ? findFingers(ctx, hand, lowerArm ?? upperArm) : [];
  return { shoulder, upperArm, lowerArm, hand, fingers, chain };
}

/**
 * Groups the hand's child chains into up to five fingers ordered thumb..little.
 * The thumb is the chain whose root is closest to the wrist and most displaced
 * from the others; the rest are ordered along the thumb→little axis.
 */
function findFingers(ctx: Ctx, hand: number, forearm: number): FingerChain[] {
  const roots = ctx.effChildren[hand].filter((c) => ctx.depth[c] >= 1 || ctx.effChildren[hand].length >= 4);
  if (roots.length < 2) return [];
  const chains = roots.map((r) => ctx.walkLimb(r, 5));
  const armDir = ctx.link(forearm, hand).normalize();
  const handPos = ctx.pos[hand];
  const mean = new Vector3();
  for (const r of roots) mean.add(ctx.pos[r]);
  mean.multiplyScalar(1 / roots.length);
  // Thumb: closest to the hand root along the arm and farthest from the mean sideways.
  let thumb = 0;
  let thumbScore = -Infinity;
  const along = roots.map((r) => ctx.pos[r].clone().sub(handPos).dot(armDir));
  const maxAlong = Math.max(...along, 1e-6);
  for (let i = 0; i < roots.length; i++) {
    const off = ctx.pos[roots[i]].clone().sub(mean);
    const lateral = off.addScaledVector(armDir, -off.dot(armDir)).length();
    const s = lateral / Math.max(ctx.extent * 0.01, 1e-6) + (1 - along[i] / maxAlong) * 2;
    if (s > thumbScore) {
      thumbScore = s;
      thumb = i;
    }
  }
  const others = roots.map((_, i) => i).filter((i) => i !== thumb);
  const axis = ctx.pos[roots[thumb]].clone().sub(mean);
  axis.addScaledVector(armDir, -axis.dot(armDir));
  if (axis.length() < 1e-9) return [];
  axis.normalize();
  others.sort((a, b) => ctx.pos[roots[b]].dot(axis) - ctx.pos[roots[a]].dot(axis));
  const names: FingerChain['finger'][] = ['Index', 'Middle', 'Ring', 'Little'];
  const out: FingerChain[] = [{ finger: 'Thumb', links: chains[thumb] }];
  for (let i = 0; i < Math.min(others.length, 4); i++) out.push({ finger: names[i], links: chains[others[i]] });
  return out;
}

/**
 * Detects hips, spine chain, head chain, arm and leg chains and the rig axes
 * from the graph's rest pose.
 */
export function analyzeTopology(graph: SkeletonGraph, opts: TopologyOptions = {}): TopologyResult {
  const warnings: string[] = [];
  const result: TopologyResult = {
    spineChain: [],
    headChain: [],
    arms: {},
    legs: {},
    axes: { up: [0, 1, 0], forward: [0, 0, 1] },
    forwardSource: 'default',
    warnings,
  };
  if (graph.nodes.length < 3) {
    warnings.push('Topology: too few nodes to analyze.');
    return result;
  }
  const ctx = new Ctx(graph);

  // 1. Hips: try every principal axis as "up" unless one is forced.
  const upCandidates = opts.up ? [v3(opts.up).normalize()] : PRINCIPAL.map(v3);
  let best: HipsCandidate | null = null;
  for (const up of upCandidates) {
    const floor = ctx.minAlong(up);
    for (let i = 0; i < graph.nodes.length; i++) {
      if (ctx.helper[i] || ctx.tail[i]) continue;
      const cand = evaluateHips(ctx, i, up, floor);
      if (cand && (!best || cand.score > best.score)) best = cand;
    }
  }
  if (!best) {
    warnings.push('Topology: no node with two mirrored downward leg chains and an upward spine chain was found.');
    return result;
  }
  const hips = best.node;
  result.hips = hips;
  let up = best.up.clone();

  // 2. Spine chain up to the arm branch node.
  const spineChain: number[] = [];
  let cur = best.spine;
  let armPair: Pair | null = null;
  let guard = 0;
  while (cur >= 0 && guard++ < 32) {
    spineChain.push(cur);
    armPair = findMirroredPair(
      ctx,
      cur,
      up,
      (root, chain) => {
        const d = ctx.link(root, chain[Math.min(chain.length - 1, 2)]);
        const lat = d.clone().addScaledVector(up, -d.dot(up));
        return lat.length() > 0.3 * d.length() && ctx.pos[root].dot(up) > ctx.pos[hips].dot(up);
      },
      (_root, chain) => Math.min(chain.length, 4) / 4,
    );
    if (armPair) {
      // Arms reached through a pass-through node: that node is the real branch.
      if (armPair.via >= 0) spineChain.push(armPair.via);
      break;
    }
    cur = ctx.mainChild(cur);
  }
  result.spineChain = spineChain;
  const branch = spineChain[spineChain.length - 1];
  if (!armPair) warnings.push('Topology: no arm branch found along the spine; arms are unmapped.');

  // 3. Head chain from the branch node.
  {
    const exclude = new Set<number>();
    if (armPair) {
      exclude.add(armPair.a);
      exclude.add(armPair.b);
      if (armPair.via >= 0) exclude.add(armPair.via);
    }
    let headRoot = -1;
    let headScore = -Infinity;
    for (const c of ctx.effChildren[branch]) {
      if (exclude.has(c)) continue;
      const d = ctx.link(branch, c);
      const upness = d.length() > 1e-9 ? d.dot(up) / d.length() : 0;
      const top = highest(ctx, c, up) - ctx.pos[branch].dot(up);
      const s = upness + top / ctx.extent + ctx.depth[c] * 0.05;
      if (upness > 0.2 && s > headScore) {
        headScore = s;
        headRoot = c;
      }
    }
    if (headRoot >= 0) {
      const chain = [headRoot];
      let n = headRoot;
      let g2 = 0;
      while (g2++ < 16) {
        const kids = ctx.effChildren[n];
        if (kids.length !== 1) break;
        const d = ctx.link(n, kids[0]);
        if (d.length() > 1e-9 && d.dot(up) / d.length() < 0.5) break;
        n = kids[0];
        chain.push(n);
      }
      result.headChain = chain;
      result.head = chain[chain.length - 1];
      if (chain.length >= 2) result.neck = chain[0];
    } else {
      warnings.push('Topology: no upward head chain found at the arm branch node.');
    }
  }

  // 4. Refine the up axis from hips -> head, snapped to a principal axis.
  const headTop = result.head ?? branch;
  const rawUp = ctx.link(hips, headTop);
  if (rawUp.length() > 1e-6 && !opts.up) {
    const snap = snapToAxis(rawUp, 35);
    if (!snap.snapped) warnings.push('Topology: the rig up axis (hips→head) is not aligned with a principal axis; using it as-is.');
    if (snap.axis.dot(up) > 0.5) up = snap.axis;
  }

  // 5. Forward axis.
  const legWalkA = ctx.walkLimb(best.legs.a, 6);
  const legWalkB = ctx.walkLimb(best.legs.b, 6);
  const legA = legChainFromWalk(legWalkA);
  const legB = legChainFromWalk(legWalkB);
  const armA = armPair ? armChainFromWalk(ctx, ctx.walkLimb(armPair.a, 8)) : undefined;
  const armB = armPair ? armChainFromWalk(ctx, ctx.walkLimb(armPair.b, 8)) : undefined;

  let forward: Vector3 | null = null;
  let forwardSource: TopologyResult['forwardSource'] = 'default';
  const perpUp = (v: Vector3) => v.clone().addScaledVector(up, -v.dot(up));

  if (opts.forward) {
    forward = perpUp(v3(opts.forward));
    forwardSource = 'override';
  }
  if (!forward) {
    const acc = new Vector3();
    for (const leg of [legA, legB]) {
      if (leg.foot !== undefined && leg.toes !== undefined) acc.add(perpUp(ctx.link(leg.foot, leg.toes)));
    }
    if (acc.length() > 0.01 * ctx.extent) {
      forward = acc;
      forwardSource = 'toes';
    }
  }
  if (!forward) {
    const acc = new Vector3();
    for (const leg of [legA, legB]) {
      if (leg.foot === undefined) continue;
      for (const c of graph.nodes[leg.foot].children) acc.add(perpUp(ctx.link(leg.foot, c)));
    }
    if (acc.length() > 0.01 * ctx.extent) {
      forward = acc;
      forwardSource = 'foot';
    }
  }
  // Name sides: left - right, then forward = cross(left, up).
  const nameLeftVec = (() => {
    const acc = new Vector3();
    let n = 0;
    const pairs: [number, number][] = [[best.legs.a, best.legs.b]];
    if (armPair) pairs.push([armPair.a, armPair.b]);
    for (const [a, b] of pairs) {
      const sa = normalizeBoneName(graph.nodes[a].name).side;
      const sb = normalizeBoneName(graph.nodes[b].name).side;
      if (sa === 'left' && sb === 'right') {
        acc.add(perpUp(ctx.link(b, a)));
        n++;
      } else if (sa === 'right' && sb === 'left') {
        acc.add(perpUp(ctx.link(a, b)));
        n++;
      }
    }
    return n > 0 && acc.length() > 1e-6 ? acc.normalize() : null;
  })();
  if (nameLeftVec) {
    const fromNames = new Vector3().crossVectors(nameLeftVec, up);
    if (forward && forwardSource !== 'override') {
      if (forward.dot(fromNames) < 0) {
        warnings.push(
          `Topology: the ${forwardSource} direction says the rig faces the opposite way from what the left/right bone names imply; trusting the names.`,
        );
        forward = fromNames;
        forwardSource = 'names';
      }
    } else if (!forward) {
      forward = fromNames;
      forwardSource = 'names';
    }
  }
  if (!forward && result.head !== undefined) {
    const acc = new Vector3();
    for (const c of graph.nodes[result.head].children) {
      if (ctx.tail[c]) continue;
      acc.add(perpUp(ctx.link(result.head, c)));
    }
    if (acc.length() > 0.01 * ctx.extent) {
      forward = acc;
      forwardSource = 'head';
    }
  }
  if (!forward || forward.length() < 1e-9) {
    forward = Math.abs(up.y) > 0.7 || Math.abs(up.x) > 0.7 ? new Vector3(0, 0, 1) : new Vector3(0, -1, 0);
    forward = perpUp(forward);
    forwardSource = 'default';
    warnings.push('Topology: could not determine the facing direction (no toes, side names or face bones); assuming the default.');
  }
  forward.normalize();
  if (forwardSource !== 'override') {
    const snap = snapToAxis(forward, 35);
    if (snap.snapped) forward = perpUp(snap.axis).normalize();
  }
  result.axes = { up: tup(up), forward: tup(forward) };
  result.forwardSource = forwardSource;

  // 6. Sides: left = up × forward.
  const left = new Vector3().crossVectors(up, forward).normalize();
  const sideOf = (root: number, ref: number) => ctx.pos[ref].clone().sub(ctx.pos[root]).dot(left) > 0;
  const hipsIdx = best.legs.via >= 0 ? best.legs.via : hips;
  if (sideOf(hipsIdx, legA.upperLeg)) {
    result.legs.left = legA;
    result.legs.right = legB;
  } else {
    result.legs.left = legB;
    result.legs.right = legA;
  }
  if (armPair && armA && armB) {
    const refA = armA.lowerArm ?? armA.upperArm;
    const at = armPair.via >= 0 ? armPair.via : branch;
    if (sideOf(at, refA)) {
      result.arms.left = armA;
      result.arms.right = armB;
    } else {
      result.arms.left = armB;
      result.arms.right = armA;
    }
  }
  return result;
}

/**
 * Axes from an already-mapped rig: up = hips→head snapped to a principal axis,
 * forward from foot→toes when available, validated against the mapped sides
 * (left must be at up × forward). Used by the rest-pose analysis.
 */
export function axesFromRoles(
  pos: { hips?: Vec3Tuple; head?: Vec3Tuple; top?: Vec3Tuple; leftUpperLeg?: Vec3Tuple; rightUpperLeg?: Vec3Tuple; leftUpperArm?: Vec3Tuple; rightUpperArm?: Vec3Tuple; feet?: [Vec3Tuple, Vec3Tuple][] },
): { axes: RigAxes; warnings: string[]; leftAtPositiveX: boolean } {
  const warnings: string[] = [];
  let up = new Vector3(0, 1, 0);
  if (pos.hips && (pos.head || pos.top)) {
    const raw = v3(pos.head ?? pos.top!).sub(v3(pos.hips));
    if (raw.length() > 1e-9) {
      const snap = snapToAxis(raw, 35);
      up = snap.axis;
      if (!snap.snapped) warnings.push('Rig up axis (hips→head) is not aligned with a principal axis; using it as-is.');
    }
  }
  const perpUp = (v: Vector3) => v.addScaledVector(up, -v.dot(up));
  let leftVec: Vector3 | null = null;
  const pairs: [Vec3Tuple | undefined, Vec3Tuple | undefined][] = [
    [pos.leftUpperLeg, pos.rightUpperLeg],
    [pos.leftUpperArm, pos.rightUpperArm],
  ];
  const acc = new Vector3();
  for (const [l, r] of pairs) if (l && r) acc.add(perpUp(v3(l).sub(v3(r))));
  if (acc.length() > 1e-6) leftVec = acc.normalize();

  let forward: Vector3 | null = null;
  if (pos.feet && pos.feet.length) {
    const f = new Vector3();
    for (const [foot, toes] of pos.feet) f.add(perpUp(v3(toes).sub(v3(foot))));
    if (f.length() > 1e-6) forward = f.normalize();
  }
  if (leftVec) {
    const fromSides = new Vector3().crossVectors(leftVec, up).normalize();
    if (forward && forward.dot(fromSides) < 0) {
      warnings.push('Left/right inversion: the feet point the opposite way from what the mapped left/right bones imply; using the mapped sides for the facing.');
    }
    forward = fromSides;
  }
  if (!forward) {
    forward = Math.abs(up.y) > 0.7 || Math.abs(up.x) > 0.7 ? new Vector3(0, 0, 1) : new Vector3(0, -1, 0);
    warnings.push('Could not determine the facing direction from the mapped bones; assuming the default.');
  }
  forward = perpUp(forward.clone()).normalize();
  const snap = snapToAxis(forward, 35);
  if (snap.snapped) forward = perpUp(snap.axis).normalize();
  const left = new Vector3().crossVectors(up, forward);
  const leftAtPositiveX = leftVec ? leftVec.dot(left) > 0 : true;
  return { axes: { up: tup(up), forward: tup(forward) }, warnings, leftAtPositiveX };
}
