/**
 * Automatic humanoid bone mapping: reconciles the name detector and the
 * topology detector (docs/DESIGN.md §5.4) into a `HumanoidMap` with per-role
 * confidence and warnings.
 *
 * Pure: works on a {@link SkeletonGraph}, so it runs in Node.
 */
import { Vector3 } from 'three';
import type { HumanoidBone, HumanoidMap, RigProfile } from '../core/types';
import { HUMANOID_BONES, HUMANOID_PARENT, REQUIRED_BONES, isFingerBone } from '../core/types';
import { detectFamilyFromNames, scoreNameCandidates, type NameCandidate } from './boneNames';
import { presetFor } from './presets';
import { isDescendant, type SkeletonGraph } from './skeletonGraph';
import { analyzeTopology, type ArmChain, type FingerChain, type LegChain, type RigAxes, type TopologyResult } from './topology';

export interface AutoMapOptions {
  /** Roles known from the file format (VRM humanoid); they override detection with confidence 1. */
  hint?: HumanoidMap;
  /** Disable the family preset pass. */
  noPresets?: boolean;
}

export interface AutoMapResult {
  map: HumanoidMap;
  confidence: Partial<Record<HumanoidBone, number>>;
  warnings: string[];
  family: RigProfile['family'];
  axes: RigAxes;
  /** Node index per mapped role (same content as `map`, by index). */
  roleIndex: Partial<Record<HumanoidBone, number>>;
  topology: TopologyResult;
}

const CONF_AGREE = 0.95;
const CONF_AGREE_WEAK = 0.9;
const CONF_TOPOLOGY = 0.7;
const CONF_NAME = 0.6;
const CONF_NAME_OVER_TOPOLOGY = 0.65;
const CONF_TOPOLOGY_FINGER = 0.5;

type Assign = { index: number; conf: number };

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const SIDES = ['left', 'right'] as const;

export function autoMapHumanoid(graph: SkeletonGraph, opts: AutoMapOptions = {}): AutoMapResult {
  const warnings: string[] = [];
  const names = scoreNameCandidates(graph);
  const topo = analyzeTopology(graph);
  for (const w of topo.warnings) warnings.push(w);
  const assigned = new Map<HumanoidBone, Assign>();
  const nameOf = (i: number) => graph.nodes[i].name;

  const topName = (role: HumanoidBone): NameCandidate | undefined => names.get(role)?.[0];
  const isNameCandidate = (role: HumanoidBone, index: number): number => {
    const list = names.get(role);
    if (!list) return -1;
    const pos = list.findIndex((c) => c.index === index);
    return pos;
  };
  const set = (role: HumanoidBone, index: number, conf: number) => assigned.set(role, { index, conf });
  const conflictWarn = (role: HumanoidBone, chosen: number, other: number, chosenBy: string) =>
    warnings.push(`${role}: name detector and topology disagree ('${nameOf(chosen)}' by ${chosenBy} vs '${nameOf(other)}'); using '${nameOf(chosen)}'.`);

  // Confidence for a topology pick given the name candidates for the role (or sibling roles).
  const reconcileTorso = (role: HumanoidBone, index: number, altRoles: HumanoidBone[] = []) => {
    const pos = isNameCandidate(role, index);
    if (pos === 0) return set(role, index, CONF_AGREE);
    if (pos > 0) return set(role, index, CONF_AGREE_WEAK);
    for (const alt of altRoles) if (isNameCandidate(alt, index) >= 0) return set(role, index, CONF_AGREE_WEAK);
    return set(role, index, CONF_TOPOLOGY);
  };

  // ---------------------------------------------------------------- hips
  const nameHips = topName('hips');
  if (topo.hips !== undefined) {
    reconcileTorso('hips', topo.hips);
    if (nameHips && nameHips.index !== topo.hips && isNameCandidate('hips', topo.hips) < 0) {
      conflictWarn('hips', topo.hips, nameHips.index, 'topology');
    }
  } else if (nameHips) {
    set('hips', nameHips.index, CONF_NAME);
  }
  const hips = assigned.get('hips')?.index;

  // ---------------------------------------------------------------- spine chain
  let spineChain: number[] = [];
  if (topo.hips !== undefined) {
    spineChain = topo.spineChain;
  } else if (hips !== undefined) {
    // Names only: spine-ish candidates under the hips ordered by depth.
    const cands = new Set<number>();
    for (const r of ['spine', 'chest', 'upperChest'] as HumanoidBone[]) for (const c of names.get(r) ?? []) if (isDescendant(graph, c.index, hips)) cands.add(c.index);
    spineChain = [...cands].sort((a, b) => depthOf(graph, a) - depthOf(graph, b));
    // Keep only a single ancestor line.
    spineChain = spineChain.filter((n, i) => i === 0 || isDescendant(graph, n, spineChain[i - 1]) || spineChain.slice(0, i).every((p) => isDescendant(graph, n, p)));
  }
  const spineRoles = spineRolesFor(spineChain.length);
  spineChain.forEach((index, i) => {
    const role = spineRoles[i];
    if (role) reconcileTorso(role, index, ['spine', 'chest', 'upperChest']);
  });
  const branch = spineChain.length ? spineChain[spineChain.length - 1] : hips;

  // ---------------------------------------------------------------- neck / head
  {
    const armRoots = new Set<number>();
    for (const s of SIDES) {
      const a = topo.arms[s];
      if (a) for (const n of a.chain) armRoots.add(n);
    }
    const underTorso = (i: number) => branch === undefined || isDescendant(graph, i, branch);
    const nameHead = (names.get('head') ?? []).find((c) => underTorso(c.index) && !armRoots.has(c.index));
    const nameNeck = (names.get('neck') ?? []).find((c) => underTorso(c.index) && !armRoots.has(c.index));
    let head: number | undefined;
    let neck: number | undefined;
    if (nameHead) {
      head = nameHead.index;
      if (topo.head !== undefined && topo.head !== head) conflictWarn('head', head, topo.head, 'name');
      set('head', head, topo.head === head ? CONF_AGREE : topo.head === undefined ? CONF_NAME : CONF_NAME_OVER_TOPOLOGY);
    } else if (topo.head !== undefined) {
      head = topo.head;
      set('head', head, CONF_TOPOLOGY);
    }
    if (nameNeck && (head === undefined || isDescendant(graph, head, nameNeck.index))) {
      neck = nameNeck.index;
      if (topo.neck !== undefined && topo.neck !== neck) conflictWarn('neck', neck, topo.neck, 'name');
      set('neck', neck, topo.neck === neck ? CONF_AGREE : topo.neck === undefined ? CONF_NAME : CONF_NAME_OVER_TOPOLOGY);
    } else if (topo.neck !== undefined && (head === undefined || isDescendant(graph, head, topo.neck))) {
      set('neck', topo.neck, CONF_TOPOLOGY);
    }
    // Jaw / eyes: names only, under the head.
    for (const role of ['jaw', 'leftEye', 'rightEye'] as HumanoidBone[]) {
      const c = (names.get(role) ?? []).find((x) => head === undefined || isDescendant(graph, x.index, head));
      if (c) set(role, c.index, head === undefined ? CONF_NAME * 0.8 : CONF_NAME);
    }
  }

  // ---------------------------------------------------------------- limbs
  for (const side of SIDES) {
    const arm = topo.arms[side];
    const leg = topo.legs[side];
    reconcileChain(
      graph,
      names,
      assigned,
      warnings,
      [`${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`, `${side}Hand`] as HumanoidBone[],
      arm ? [arm.shoulder, arm.upperArm, arm.lowerArm, arm.hand] : [undefined, undefined, undefined, undefined],
      branch,
    );
    reconcileChain(
      graph,
      names,
      assigned,
      warnings,
      [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`, `${side}Toes`] as HumanoidBone[],
      leg ? [leg.upperLeg, leg.lowerLeg, leg.foot, leg.toes] : [undefined, undefined, undefined, undefined],
      hips,
    );
    mapFingers(graph, names, assigned, side, arm);
  }

  // ---------------------------------------------------------------- hint (VRM humanoid)
  if (opts.hint) {
    for (const [role, name] of Object.entries(opts.hint) as [HumanoidBone, string][]) {
      const node = graph.nodes.find((n) => n.name === name);
      if (node) set(role, node.index, 1);
    }
  }

  // ---------------------------------------------------------------- family + presets
  const allNames = graph.nodes.map((n) => n.name);
  const family = detectFamilyFromNames(allNames);
  if (!opts.noPresets && !opts.hint) {
    const preset = presetFor(family, allNames);
    if (preset) {
      for (const [role, name] of Object.entries(preset.map) as [HumanoidBone, string][]) {
        const node = graph.nodes.find((n) => n.name === name);
        if (!node) continue;
        const cur = assigned.get(role);
        if (cur && cur.index !== node.index) warnings.push(`${role}: preset '${preset.name}' overrides '${nameOf(cur.index)}' with '${name}'.`);
        set(role, node.index, Math.max(cur?.conf ?? 0, 0.98));
      }
    }
  }

  // ---------------------------------------------------------------- consistency
  enforceUnique(graph, assigned, warnings);
  enforceHierarchy(graph, assigned, warnings);

  // Sides vs axes: the mapped left side must be at up × forward.
  const axes: RigAxes = { up: [...topo.axes.up] as RigAxes['up'], forward: [...topo.axes.forward] as RigAxes['forward'] };
  {
    const up = new Vector3().fromArray(axes.up);
    const fwd = new Vector3().fromArray(axes.forward);
    const left = new Vector3().crossVectors(up, fwd);
    const acc = new Vector3();
    for (const [l, r] of [
      ['leftUpperLeg', 'rightUpperLeg'],
      ['leftUpperArm', 'rightUpperArm'],
      ['leftShoulder', 'rightShoulder'],
    ] as [HumanoidBone, HumanoidBone][]) {
      const a = assigned.get(l);
      const b = assigned.get(r);
      if (a && b) acc.add(new Vector3().fromArray(graph.nodes[a.index].restPos).sub(new Vector3().fromArray(graph.nodes[b.index].restPos)));
    }
    if (acc.length() > 1e-6 && acc.dot(left) < 0) {
      warnings.push('Mapped left/right bones are on the opposite side of the detected facing; flipping the forward axis.');
      axes.forward = [-axes.forward[0], -axes.forward[1], -axes.forward[2]];
    }
  }

  for (const role of REQUIRED_BONES) if (!assigned.has(role)) warnings.push(`Required role '${role}' is not mapped.`);

  const map: HumanoidMap = {};
  const confidence: Partial<Record<HumanoidBone, number>> = {};
  const roleIndex: Partial<Record<HumanoidBone, number>> = {};
  for (const role of HUMANOID_BONES) {
    const a = assigned.get(role);
    if (!a) continue;
    map[role] = nameOf(a.index);
    confidence[role] = Math.round(a.conf * 100) / 100;
    roleIndex[role] = a.index;
    if (allNames.filter((n) => n === map[role]).length > 1) warnings.push(`Bone name '${map[role]}' (${role}) is not unique in the hierarchy.`);
  }
  return { map, confidence, warnings, family, axes, roleIndex, topology: topo };
}

/** Roles for a spine chain of `n` links from the hips upward (docs/DESIGN.md §5.4). */
export function spineRolesFor(n: number): (HumanoidBone | null)[] {
  if (n <= 0) return [];
  if (n === 1) return ['spine'];
  if (n === 2) return ['spine', 'chest'];
  if (n === 3) return ['spine', 'chest', 'upperChest'];
  const out: (HumanoidBone | null)[] = new Array(n).fill(null);
  out[0] = 'spine';
  out[n - 2] = 'chest';
  out[n - 1] = 'upperChest';
  return out;
}

function depthOf(graph: SkeletonGraph, i: number): number {
  let d = 0;
  let p = graph.nodes[i].parent;
  while (p >= 0) {
    d++;
    p = graph.nodes[p].parent;
  }
  return d;
}

/**
 * Reconciles one limb chain (shoulder?, upperArm, lowerArm, hand or upperLeg,
 * lowerLeg, foot, toes) between the topology picks and the name picks.
 */
function reconcileChain(
  graph: SkeletonGraph,
  names: Map<HumanoidBone, NameCandidate[]>,
  assigned: Map<HumanoidBone, Assign>,
  warnings: string[],
  roles: HumanoidBone[],
  topo: (number | undefined)[],
  root: number | undefined,
): void {
  const nameOf = (i: number) => graph.nodes[i].name;
  // Name picks: best candidate per role, distinct nodes, under the torso root.
  const used = new Set<number>();
  const namePick: (number | undefined)[] = roles.map(() => undefined);
  const order = [...roles.keys()].sort((a, b) => (names.get(roles[b])?.[0]?.score ?? 0) - (names.get(roles[a])?.[0]?.score ?? 0));
  for (const k of order) {
    const list = names.get(roles[k]) ?? [];
    const c = list.find((x) => !used.has(x.index) && (root === undefined || isDescendant(graph, x.index, root)));
    if (c) {
      namePick[k] = c.index;
      used.add(c.index);
    }
  }
  // Consistency: defined name picks must form a strict ancestor chain in role order.
  let consistent = true;
  const defined = namePick.map((v, k) => [v, k] as const).filter(([v]) => v !== undefined) as [number, number][];
  for (let i = 1; i < defined.length; i++) {
    if (!isDescendant(graph, defined[i][0], defined[i - 1][0])) consistent = false;
  }
  if (!consistent) warnings.push(`${roles[0]}..${roles[roles.length - 1]}: name candidates are not in hierarchy order (${defined.map(([v]) => `'${nameOf(v)}'`).join(' > ')}); using topology.`);

  for (let k = 0; k < roles.length; k++) {
    const role = roles[k];
    const t = topo[k];
    const n = consistent ? namePick[k] : undefined;
    if (t !== undefined && n !== undefined) {
      if (t === n) assigned.set(role, { index: t, conf: CONF_AGREE });
      else {
        warnings.push(`${role}: name detector says '${nameOf(n)}', topology says '${nameOf(t)}'; using the name.`);
        assigned.set(role, { index: n, conf: CONF_NAME_OVER_TOPOLOGY });
      }
    } else if (t !== undefined) {
      // Topology pick not named for this role: verify it is not named as another body role.
      assigned.set(role, { index: t, conf: CONF_TOPOLOGY });
    } else if (n !== undefined) {
      assigned.set(role, { index: n, conf: CONF_NAME });
    }
  }
}

function mapFingers(
  graph: SkeletonGraph,
  names: Map<HumanoidBone, NameCandidate[]>,
  assigned: Map<HumanoidBone, Assign>,
  side: 'left' | 'right',
  arm: ArmChain | undefined,
): void {
  const hand = assigned.get(`${side}Hand`)?.index;
  const underHand = (i: number) => hand === undefined || isDescendant(graph, i, hand);
  let anyByName = false;
  for (const finger of FINGERS) {
    const segs = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    for (const seg of segs) {
      const role = `${side}${finger}${seg}` as HumanoidBone;
      const c = (names.get(role) ?? []).find((x) => underHand(x.index));
      if (c) {
        assigned.set(role, { index: c.index, conf: CONF_NAME });
        anyByName = true;
      }
    }
  }
  if (anyByName || !arm || arm.fingers.length === 0) return;
  for (const chain of arm.fingers) applyFingerChain(assigned, side, chain);
}

function applyFingerChain(assigned: Map<HumanoidBone, Assign>, side: 'left' | 'right', chain: FingerChain): void {
  const segs = chain.finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
  const links = chain.links.slice(0, 3);
  links.forEach((index, i) => {
    const role = `${side}${chain.finger}${segs[i]}` as HumanoidBone;
    if (!assigned.has(role)) assigned.set(role, { index, conf: CONF_TOPOLOGY_FINGER });
  });
}

/** A node may hold only one role: keep the most confident (required roles win ties). */
function enforceUnique(graph: SkeletonGraph, assigned: Map<HumanoidBone, Assign>, warnings: string[]): void {
  const byNode = new Map<number, HumanoidBone[]>();
  for (const [role, a] of assigned) {
    const list = byNode.get(a.index) ?? [];
    list.push(role);
    byNode.set(a.index, list);
  }
  for (const [index, roles] of byNode) {
    if (roles.length < 2) continue;
    roles.sort((a, b) => {
      const ca = assigned.get(a)!.conf + (REQUIRED_BONES.includes(a) ? 0.01 : 0);
      const cb = assigned.get(b)!.conf + (REQUIRED_BONES.includes(b) ? 0.01 : 0);
      return cb - ca;
    });
    for (const r of roles.slice(1)) {
      assigned.delete(r);
      warnings.push(`'${graph.nodes[index].name}' was mapped to both ${roles[0]} and ${r}; dropped ${r}.`);
    }
  }
}

/** Every mapped role must be a descendant of its nearest mapped ancestor role. */
function enforceHierarchy(graph: SkeletonGraph, assigned: Map<HumanoidBone, Assign>, warnings: string[]): void {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    for (const role of HUMANOID_BONES) {
      const a = assigned.get(role);
      if (!a || role === 'hips') continue;
      let p = HUMANOID_PARENT[role];
      while (p && !assigned.has(p)) p = HUMANOID_PARENT[p];
      if (!p) continue;
      const pa = assigned.get(p)!;
      if (pa.index === a.index || !isDescendant(graph, a.index, pa.index)) {
        // Drop the less confident of the two (never drop the hips).
        const dropChild = p === 'hips' || pa.conf >= a.conf || isFingerBone(role);
        const victim = dropChild ? role : p;
        assigned.delete(victim);
        warnings.push(`${role} ('${graph.nodes[a.index].name}') is not under ${p} ('${graph.nodes[pa.index].name}'); dropped ${victim}.`);
        changed = true;
      }
    }
  }
}

export type { ArmChain, LegChain };
