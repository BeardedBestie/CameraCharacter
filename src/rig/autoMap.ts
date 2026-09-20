/**
 * Automatic humanoid bone mapping (docs/DESIGN.md §5.4 "Reconciliation",
 * §5.6 keys): chain-order roles from the topology detector are the result;
 * name classes constrain chain membership and decide the two name-driven
 * choices (inside topology.ts); name-only and preset candidates fill roles the
 * chains left empty when they are hierarchy-consistent. Also detects the rig
 * family, no-knee / no-elbow chains, forearm twist helpers and computes the
 * family/instance keys.
 *
 * Pure: works on a {@link SkeletonGraph}, so it runs in Node.
 */
import { Quaternion, Vector3 } from 'three';
import type { HumanoidBone, HumanoidMap, RigAxes, RigFamily, Vec3Tuple } from '../core/types';
import { HUMANOID_BONES, HUMANOID_PARENT, REQUIRED_BONES, boneSide } from '../core/types';
import { fnv1a } from '../core/math';
import { detectFamily, normalizedName, type BoneNameInfo, type FamilyHints } from './boneNames';
import { presetFor } from './presets';
import { isDescendant, subtree, type SkeletonGraph } from './skeletonGraph';
import { analyzeTopology, rootCorrectionFromAxes, type TopologyResult } from './topology';

export interface AutoMapOptions {
  /** Roles known from the file format (VRM humanoid); they override detection with confidence 1. */
  hint?: HumanoidMap;
  /** VRM: axes known, facing detector skipped. */
  vrm?: boolean;
  /** Loader hints for the family detector. */
  family?: FamilyHints;
  /** Disable the family preset pass. */
  noPresets?: boolean;
}

export interface AutoMapResult {
  map: HumanoidMap;
  confidence: Partial<Record<HumanoidBone, number>>;
  warnings: string[];
  family: RigFamily;
  axes: RigAxes;
  /** Unit vector toward the rig's left in loader space. */
  left: Vec3Tuple;
  /** Node index per mapped role. */
  roleIndex: Partial<Record<HumanoidBone, number>>;
  topology: TopologyResult;
  noKnee: { left: boolean; right: boolean };
  noElbow: { left: boolean; right: boolean };
  hasForearmTwist: { left: boolean; right: boolean };
  familyKey: string;
  instanceKey: string;
  /** Skeleton extent along the up axis in loader units. */
  height: number;
  /** True when the graph has no skin joints at all. */
  unrigged: boolean;
}

export const CONF_CHAIN_AND_NAME = 0.95;
export const CONF_CHAIN_ONLY = 0.7;
export const CONF_NAME_ONLY = 0.6;
export const CONF_PRESET = 0.6;
export const CONF_HINT = 1;

const SIDED_KEYWORD_ROLE: Record<string, string> = {
  clavicle: 'Shoulder',
  clav: 'Shoulder',
  collar: 'Shoulder',
  collarbone: 'Shoulder',
  upperarm: 'UpperArm',
  arm: 'UpperArm',
  humerus: 'UpperArm',
  shldr: 'UpperArm',
  bicep: 'UpperArm',
  biceps: 'UpperArm',
  forearm: 'LowerArm',
  lowerarm: 'LowerArm',
  elbow: 'LowerArm',
  ulna: 'LowerArm',
  hand: 'Hand',
  wrist: 'Hand',
  thigh: 'UpperLeg',
  upleg: 'UpperLeg',
  upperleg: 'UpperLeg',
  femur: 'UpperLeg',
  hip: 'UpperLeg',
  shin: 'LowerLeg',
  calf: 'LowerLeg',
  lowerleg: 'LowerLeg',
  tibia: 'LowerLeg',
  knee: 'LowerLeg',
  foot: 'Foot',
  ankle: 'Foot',
  toe: 'Toes',
  toes: 'Toes',
  toebase: 'Toes',
  ball: 'Toes',
};
const CENTER_KEYWORD_ROLE: Record<string, HumanoidBone> = {
  hips: 'hips',
  pelvis: 'hips',
  spine: 'spine',
  chest: 'chest',
  upperchest: 'upperChest',
  neck: 'neck',
  head: 'head',
};

const EYE_KEYWORDS = new Set(['eye', 'eyes', 'eyeball', 'faceeye']);
const JAW_KEYWORDS = new Set(['jaw', 'lowerjaw', 'jawroot', 'mandible']);

/** Role a bone name suggests on its own (name-only candidate), or null. */
export function nameOnlyRole(info: BoneNameInfo): HumanoidBone | null {
  if (!info.keyword) return null;
  if (info.group === 'torso') return CENTER_KEYWORD_ROLE[info.keyword] ?? null;
  if (info.group === 'face') {
    if (EYE_KEYWORDS.has(info.keyword) && (info.side === 'left' || info.side === 'right')) return `${info.side}Eye`;
    if (JAW_KEYWORDS.has(info.keyword) && info.side !== 'left' && info.side !== 'right') return 'jaw';
    return null;
  }
  if ((info.group === 'arm' || info.group === 'leg') && (info.side === 'left' || info.side === 'right')) {
    const suffix = SIDED_KEYWORD_ROLE[info.keyword];
    if (!suffix) return null;
    if (info.keyword === 'shoulder') return null; // the shoulder-vs-upperArm rule is chain-driven
    return `${info.side}${suffix}` as HumanoidBone;
  }
  if (info.group === 'finger' && info.finger && info.finger.segment && info.finger.segment !== 'Tip' && (info.side === 'left' || info.side === 'right')) {
    if (info.finger.digit !== 'Thumb' && info.finger.segment === 'Metacarpal') return null;
    if (info.finger.digit === 'Thumb' && info.finger.segment === 'Intermediate') return null;
    return `${info.side}${info.finger.digit}${info.finger.segment}` as HumanoidBone;
  }
  return null;
}

/** Nearest mapped ancestor role in the humanoid chain. */
export function mappedParentRole(role: HumanoidBone, roleIndex: Partial<Record<HumanoidBone, number>>): HumanoidBone | null {
  let p = HUMANOID_PARENT[role];
  while (p && roleIndex[p] === undefined) p = HUMANOID_PARENT[p];
  return p;
}

/** Mapped roles whose nearest mapped humanoid ancestor is `role`. */
export function mappedChildRoles(role: HumanoidBone, roleIndex: Partial<Record<HumanoidBone, number>>): HumanoidBone[] {
  const out: HumanoidBone[] = [];
  for (const b of HUMANOID_BONES) {
    if (roleIndex[b] === undefined || b === role) continue;
    if (mappedParentRole(b, roleIndex) === role) out.push(b);
  }
  return out;
}

/**
 * Hierarchy consistency of a candidate: it must descend from the bone of its
 * mapped parent role and be an ancestor of the bones of its mapped child roles.
 */
export function isHierarchyConsistent(graph: SkeletonGraph, role: HumanoidBone, index: number, roleIndex: Partial<Record<HumanoidBone, number>>): boolean {
  const parentRole = mappedParentRole(role, roleIndex);
  if (parentRole) {
    const pi = roleIndex[parentRole]!;
    if (pi !== index && !isDescendant(graph, index, pi)) return false;
  }
  for (const child of mappedChildRoles(role, roleIndex)) {
    const ci = roleIndex[child]!;
    if (ci !== index && !isDescendant(graph, ci, index)) return false;
  }
  return true;
}

export function autoMapHumanoid(graph: SkeletonGraph, opts: AutoMapOptions = {}): AutoMapResult {
  const warnings: string[] = [];
  const topo = analyzeTopology(graph, { vrm: opts.vrm });
  for (const w of topo.warnings) warnings.push(w);
  const names = graph.nodes.map((n) => n.name);
  const unrigged = !graph.nodes.some((n) => n.isJoint) && graph.skinnedMeshCount === 0;

  // Duplicate names cannot be addressed by a name map.
  const seen = new Map<string, number>();
  for (const n of graph.nodes) seen.set(n.name, (seen.get(n.name) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  if (duplicates.length) warnings.push(`Duplicate node names (${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? ', …' : ''}); mapping uses the first occurrence.`);

  const roleIndex: Partial<Record<HumanoidBone, number>> = {};
  const confidence: Partial<Record<HumanoidBone, number>> = {};
  const usedIndex = new Set<number>();
  const assign = (role: HumanoidBone, index: number, conf: number) => {
    const prev = roleIndex[role];
    if (prev !== undefined) usedIndex.delete(prev);
    roleIndex[role] = index;
    confidence[role] = conf;
    usedIndex.add(index);
  };

  // 1. Chain-order roles.
  for (const [index, role] of topo.roles) {
    if (roleIndex[role] !== undefined) continue;
    assign(role, index, topo.nameAgrees.get(index) ? CONF_CHAIN_AND_NAME : CONF_CHAIN_ONLY);
  }
  if (topo.sideSource === 'geometry' && topo.hips >= 0) {
    // Sided names that disagree with the geometric sides lower the confidence.
    for (const role of Object.keys(roleIndex) as HumanoidBone[]) {
      const side = boneSide(role);
      if (side === 'center') continue;
      const s = topo.info[roleIndex[role]!].side;
      if (s && s !== 'center' && s !== side) {
        confidence[role] = Math.min(confidence[role] ?? CONF_CHAIN_ONLY, CONF_CHAIN_ONLY);
        warnings.push(`Bone '${names[roleIndex[role]!]}' is named ${s} but sits on the ${side} side; mapped by position.`);
      }
    }
  }

  // 2. Format hints (VRM humanoid) override everything.
  if (opts.hint) {
    for (const [role, name] of Object.entries(opts.hint) as [HumanoidBone, string][]) {
      if (!name) continue;
      const idx = names.indexOf(name);
      if (idx < 0) continue;
      for (const r of Object.keys(roleIndex) as HumanoidBone[]) if (roleIndex[r] === idx && r !== role) delete roleIndex[r];
      assign(role, idx, CONF_HINT);
    }
  }

  // 3. Name-only candidates for roles the chains left empty (unique, hierarchy-consistent).
  {
    const byRole = new Map<HumanoidBone, number[]>();
    graph.nodes.forEach((_, i) => {
      if (topo.kinds[i] !== 'link' || usedIndex.has(i)) return;
      const role = nameOnlyRole(topo.info[i]);
      if (!role || roleIndex[role] !== undefined) return;
      const list = byRole.get(role) ?? [];
      list.push(i);
      byRole.set(role, list);
    });
    for (const [role, list] of byRole) {
      if (list.length !== 1) continue;
      const i = list[0];
      if (!isHierarchyConsistent(graph, role, i, roleIndex)) {
        warnings.push(`Name candidate '${names[i]}' for ${role} contradicts the detected hierarchy; dropped.`);
        continue;
      }
      assign(role, i, CONF_NAME_ONLY);
    }
  }

  // 4. Family and presets.
  const family = detectFamily(names, { ...opts.family, vrm: opts.vrm || opts.family?.vrm });
  if (!opts.noPresets) {
    const preset = presetFor(family, names);
    if (preset) {
      for (const [role, name] of Object.entries(preset.map) as [HumanoidBone, string][]) {
        if (roleIndex[role] !== undefined) continue;
        const idx = names.indexOf(name);
        if (idx < 0 || usedIndex.has(idx) || topo.kinds[idx] !== 'link') continue;
        if (!isHierarchyConsistent(graph, role, idx, roleIndex)) continue;
        assign(role, idx, CONF_PRESET);
      }
    }
  }

  return finishAutoMap(graph, topo, roleIndex, confidence, warnings, family, unrigged);
}

/** True when `value` is an {@link AutoMapResult} rather than a plain humanoid map. */
export function isAutoMapResult(value: unknown): value is AutoMapResult {
  return !!value && typeof value === 'object' && 'topology' in (value as AutoMapResult) && 'roleIndex' in (value as AutoMapResult);
}

/**
 * Re-derives an {@link AutoMapResult} for an explicit role -> bone name map
 * (a profile diff, a user override): keeps the topology, axes and family of
 * `auto`, replaces the roles, and recomputes the required-role warnings,
 * no-knee / no-elbow flags, forearm twist helpers and the keys. Roles whose
 * bone does not exist are dropped with a warning; roles unchanged from the
 * auto result keep their confidence, others get confidence 1 (user intent).
 */
export function remapAutoResult(graph: SkeletonGraph, auto: AutoMapResult, map: HumanoidMap): AutoMapResult {
  const warnings = auto.warnings.filter((w) => !w.startsWith('Required roles not mapped') && !w.startsWith('No spine/chest bone mapped') && !w.startsWith('Rig has no knee joint') && !w.startsWith('Rig has no elbow joint'));
  const byName = new Map<string, number>();
  graph.nodes.forEach((n) => {
    if (!byName.has(n.name)) byName.set(n.name, n.index);
  });
  const roleIndex: Partial<Record<HumanoidBone, number>> = {};
  const confidence: Partial<Record<HumanoidBone, number>> = {};
  const used = new Set<number>();
  for (const role of HUMANOID_BONES) {
    const name = map[role];
    if (!name) continue;
    const idx = byName.get(name);
    if (idx === undefined) {
      warnings.push(`Mapped bone '${name}' for ${role} does not exist in the model; role left unmapped.`);
      continue;
    }
    if (used.has(idx)) {
      warnings.push(`Bone '${name}' is mapped to several roles; keeping the first (${role} dropped).`);
      continue;
    }
    used.add(idx);
    roleIndex[role] = idx;
    confidence[role] = auto.map[role] === name ? (auto.confidence[role] ?? CONF_HINT) : CONF_HINT;
  }
  return finishAutoMap(graph, auto.topology, roleIndex, confidence, warnings, auto.family, auto.unrigged);
}

/** Shared tail of the auto mapper: required-role checks, chain flags and keys. */
function finishAutoMap(
  graph: SkeletonGraph,
  topo: TopologyResult,
  roleIndex: Partial<Record<HumanoidBone, number>>,
  confidence: Partial<Record<HumanoidBone, number>>,
  warnings: string[],
  family: RigFamily,
  unrigged: boolean,
): AutoMapResult {
  const names = graph.nodes.map((n) => n.name);

  // 5. Required roles.
  const map: HumanoidMap = {};
  for (const role of HUMANOID_BONES) if (roleIndex[role] !== undefined) map[role] = names[roleIndex[role]!];
  if (!unrigged) {
    const missing = REQUIRED_BONES.filter((r) => map[r] === undefined);
    if (missing.length) warnings.push(`Required roles not mapped: ${missing.join(', ')}.`);
    if (!map.spine && !map.chest && !map.upperChest && map.hips) warnings.push('No spine/chest bone mapped; the torso is driven by the hips alone.');
    if (graph.hasSkinWeights) {
      const unweighted = (Object.keys(roleIndex) as HumanoidBone[]).filter((r) => !(graph.nodes[roleIndex[r]!].weight > 0));
      if (unweighted.length) warnings.push(`Mapped bones without skin weight (they move nothing by themselves): ${unweighted.map((r) => `${r}='${map[r]}'`).join(', ')}.`);
    }
  }

  // 6. No-knee / no-elbow chains, forearm twist helpers.
  const up = new Vector3().fromArray(topo.axes.up);
  const pos = (i: number) => new Vector3().fromArray(graph.nodes[i].restPos);
  const childEnd = (i: number): Vector3 | null => {
    // Farthest descendant position along the chain (for a lower segment without a mapped child).
    const desc = subtree(graph, i).filter((d) => topo.kinds[d] !== 'passthrough');
    if (!desc.length) return null;
    let best = desc[0];
    let bestD = -1;
    for (const d of desc) {
      const dd = pos(d).distanceTo(pos(i));
      if (dd > bestD) {
        bestD = dd;
        best = d;
      }
    }
    return pos(best);
  };
  const noKnee = { left: false, right: false };
  const noElbow = { left: false, right: false };
  const hasForearmTwist = { left: false, right: false };
  for (const side of ['left', 'right'] as const) {
    const ul = roleIndex[`${side}UpperLeg`];
    const ll = roleIndex[`${side}LowerLeg`];
    if (ul !== undefined && ll !== undefined) {
      const ft = roleIndex[`${side}Foot`];
      const pUl = pos(ul);
      const pLl = pos(ll);
      const end = ft !== undefined ? pos(ft) : childEnd(ll);
      if (end) {
        const upperLen = pUl.distanceTo(pLl);
        const lowerLen = pLl.distanceTo(end);
        const legLen = upperLen + lowerLen;
        const drop = pUl.dot(up) - pLl.dot(up);
        if (legLen > 0 && (upperLen < 0.3 * lowerLen || drop < 0.2 * legLen)) {
          noKnee[side] = true;
          warnings.push(`Rig has no knee joint on the ${side} leg ('${names[ul]}' is a stub); leg driven as one segment.`);
        }
      }
    }
    const ua = roleIndex[`${side}UpperArm`];
    const la = roleIndex[`${side}LowerArm`];
    if (ua !== undefined && la !== undefined) {
      const hd = roleIndex[`${side}Hand`];
      const pUa = pos(ua);
      const pLa = pos(la);
      const end = hd !== undefined ? pos(hd) : childEnd(la);
      if (end) {
        const upperLen = pUa.distanceTo(pLa);
        const lowerLen = pLa.distanceTo(end);
        const armLen = upperLen + lowerLen;
        if (armLen > 0 && (upperLen < 0.3 * lowerLen || upperLen < 0.2 * armLen)) {
          noElbow[side] = true;
          warnings.push(`Rig has no elbow joint on the ${side} arm ('${names[ua]}' is a stub); arm driven as one segment.`);
        }
      }
      hasForearmTwist[side] = subtree(graph, la).some((d) => topo.info[d].twist);
    }
  }

  // 7. Keys.
  const { familyKey, instanceKey } = computeKeys(graph, roleIndex, topo.axes, topo.height);

  return {
    map,
    confidence,
    warnings,
    family,
    axes: topo.axes,
    left: topo.left,
    roleIndex,
    topology: topo,
    noKnee,
    noElbow,
    hasForearmTwist,
    familyKey,
    instanceKey,
    height: topo.height,
    unrigged,
  };
}

/**
 * `familyKey` = hash of the mapped humanoid subgraph (role -> normalized bone
 * name and role parent relations). `instanceKey` = familyKey + quantized bind
 * signature (per mapped bone: rest direction toward the mapped child rounded
 * to 5° and length rounded to 1 cm in height-normalized units, both in the
 * corrected Y-up / +Z frame).
 */
export function computeKeys(graph: SkeletonGraph, roleIndex: Partial<Record<HumanoidBone, number>>, axes: RigAxes, height: number): { familyKey: string; instanceKey: string } {
  const lines: string[] = [];
  for (const role of HUMANOID_BONES) {
    const i = roleIndex[role];
    if (i === undefined) continue;
    const parent = mappedParentRole(role, roleIndex);
    lines.push(`${role}:${normalizedName(graph.nodes[i].name)}<${parent ?? ''}`);
  }
  lines.sort();
  const familyKey = fnv1a(lines.join('\n'));

  const q = rootCorrectionFromAxes(axes, new Quaternion());
  const h = height > 0 ? height : 1;
  const corrected = (i: number) => new Vector3().fromArray(graph.nodes[i].restPos).applyQuaternion(q);
  const sig: string[] = [];
  for (const role of HUMANOID_BONES) {
    const i = roleIndex[role];
    if (i === undefined) continue;
    const childRole = mappedChildRoles(role, roleIndex).find((c) => boneSide(c) === boneSide(role) || boneSide(role) === 'center');
    if (!childRole) continue;
    const d = corrected(roleIndex[childRole]!).sub(corrected(i));
    const len = d.length();
    if (len < 1e-9) continue;
    d.multiplyScalar(1 / len);
    const theta = Math.round((Math.acos(Math.max(-1, Math.min(1, d.y))) * 180) / Math.PI / 5) * 5;
    let phi = Math.round((Math.atan2(d.x, d.z) * 180) / Math.PI / 5) * 5;
    if (phi <= -180) phi += 360;
    if (theta === 0 || theta === 180) phi = 0;
    sig.push(`${role}:${theta},${phi},${(len / h).toFixed(2)}`);
  }
  const instanceKey = `${familyKey}-${fnv1a(sig.join('\n'))}`;
  return { familyKey, instanceKey };
}
