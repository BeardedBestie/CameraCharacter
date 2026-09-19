/**
 * Bone name normalization, the synonym lexicon and the name-based role
 * detector (docs/DESIGN.md §5.4, "Name detector").
 *
 * Pure: no three.js, no DOM.
 */
import type { HumanoidBone, Side } from '../core/types';
import type { SkeletonGraph } from './skeletonGraph';

export type NameSide = Side | null;

export interface NormalizedBoneName {
  /** Lower-case tokens without side tokens (digits are separate tokens). */
  tokens: string[];
  side: NameSide;
  raw: string;
  /** Name with namespace prefixes removed. */
  stripped: string;
}

/** Namespace / rig-family prefixes removed before tokenizing. Order matters. */
const PREFIX_PATTERNS: RegExp[] = [
  /^mixamorig\d*[:_]/i,
  /^Armature[|_.:]/i,
  /^DEF-/,
  /^ORG-/,
  /^MCH-/,
  /^(DEF|ORG|MCH)_/i,
  /^J_Sec_/,
  /^J_Opt_/,
  /^Bip0?0?1[ _]/i,
  /^CC_Base_/i,
  /^Character\d*[_:]/i,
  /^Genesis\d*(Female|Male)?[_:]?(?=[A-Za-z])/,
  /^root\|/i,
  /^b_/i,
  /^bone_/i,
  /^[^:|]+[:|]/, // any remaining "namespace:" or "Object|" prefix
];

const SIDE_TOKENS: Record<string, Side> = {
  left: 'left',
  right: 'right',
  l: 'left',
  r: 'right',
  lt: 'left',
  rt: 'right',
  lft: 'left',
  rgt: 'right',
  c: 'center',
  m: 'center',
  center: 'center',
  centre: 'center',
};

const _cache = new Map<string, NormalizedBoneName>();

/**
 * Strips namespace prefixes, detects the side and splits the remainder into
 * lower-case tokens (camelCase, snake_case, dots, spaces and digit boundaries).
 */
export function normalizeBoneName(name: string): NormalizedBoneName {
  const cached = _cache.get(name);
  if (cached) return cached;

  let side: NameSide = null;
  let s = name.trim();

  const vroid = /^J_(Bip|Adj)_([CLR])_/.exec(s);
  if (vroid) {
    side = vroid[2] === 'L' ? 'left' : vroid[2] === 'R' ? 'right' : 'center';
    s = s.slice(vroid[0].length);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const re of PREFIX_PATTERNS) {
      const m = re.exec(s);
      if (m && m[0].length > 0 && m[0].length < s.length) {
        s = s.slice(m[0].length);
        changed = true;
      }
    }
  }
  const stripped = s;

  // Glued lower-case "leftarm" / "armleft" forms that camelCase splitting cannot separate.
  let body = stripped;
  const lower = body.toLowerCase();
  const lead = /^(left|right)(?=[a-z_.\-\s0-9])/i.exec(lower);
  if (lead && body.length > lead[0].length && /^[a-z]+$/.test(body.slice(0, lead[0].length))) {
    side = side ?? (lead[1] === 'left' ? 'left' : 'right');
    body = body.slice(lead[0].length);
  } else {
    const trail = /(left|right)$/i.exec(lower);
    if (trail && body.length > trail[0].length && /^[a-z]+$/.test(body.slice(body.length - trail[0].length))) {
      side = side ?? (trail[1] === 'left' ? 'left' : 'right');
      body = body.slice(0, body.length - trail[0].length);
    }
  }

  let spaced = body
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
  const rawTokens = spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const t = rawTokens[i];
    const st = SIDE_TOKENS[t];
    if (st !== undefined && (t.length > 1 || i === 0 || i === rawTokens.length - 1 || side === null)) {
      if (side === null || side === 'center') side = st === 'center' && side ? side : st;
      continue;
    }
    tokens.push(t);
  }

  const out: NormalizedBoneName = { tokens, side, raw: name, stripped };
  _cache.set(name, out);
  return out;
}

/** Tokens without digits, joined; e.g. `LeftHandThumb1` -> `handthumb`. */
export function nameKey(n: NormalizedBoneName): string {
  return n.tokens.filter((t) => !/^\d+$/.test(t)).join('');
}

/** Last numeric token as a number, or null. */
export function numericSuffix(n: NormalizedBoneName): number | null {
  for (let i = n.tokens.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(n.tokens[i])) return parseInt(n.tokens[i], 10);
  }
  return null;
}

const HELPER_TOKENS = new Set([
  'twist',
  'roll',
  'ik',
  'fk',
  'pole',
  'nub',
  'end',
  'tip',
  'target',
  'ctrl',
  'control',
  'controller',
  'helper',
  'attach',
  'attachment',
  'prop',
  'weapon',
  'gun',
  'sword',
  'shield',
  'eyelid',
  'lid',
  'lids',
  'hair',
  'skirt',
  'breast',
  'bust',
  'boob',
  'tail',
  'wing',
  'wings',
  'cloth',
  'cape',
  'scarf',
  'sleeve',
  'dress',
  'coat',
  'ponytail',
  'bang',
  'bangs',
  'tongue',
  'teeth',
  'tooth',
  'ear',
  'ears',
  'nose',
  'cheek',
  'brow',
  'eyebrow',
  'glasses',
  'hat',
  'palm',
  'corrective',
  'driver',
  'dummy',
  'aux',
  'muscle',
  'volume',
  'socket',
  'camera',
  'light',
  'jiggle',
  'physics',
  'spring',
  'dynamic',
  'grip',
  'handle',
  'holder',
  'item',
  'accessory',
  'armor',
  'armour',
  'opt',
  'ribs',
  'pectoral',
  'trapezius',
  'scapula',
  'bigtoe',
  'smalltoe',
  'eff',
  'effector',
  'bbone',
  'stretch',
  'tweak',
  'mech',
  'vis',
  'widget',
  'mirror',
]);

const TAIL_TOKENS = new Set(['end', 'nub', 'tip', 'endsite', 'eff', 'effector', 'leaf']);

/**
 * Bones that must never take a body role: twist/roll helpers, IK/pole targets,
 * tail markers, props and secondary motion bones (hair, skirt, breast, tail...).
 */
export function isHelperBone(name: string): boolean {
  const n = normalizeBoneName(name);
  const key = nameKey(n);
  // Character Creator names its real neck bones NeckTwist01/02.
  if (key === 'necktwist') return false;
  for (const t of n.tokens) {
    if (HELPER_TOKENS.has(t)) return true;
  }
  return false;
}

/** Leaf "tail" markers (`*_end`, `*Nub`, `*Tip`): tail hints only, never roles. */
export function isTailMarker(name: string): boolean {
  const n = normalizeBoneName(name);
  return n.tokens.some((t) => TAIL_TOKENS.has(t));
}

/**
 * True when `name` is a continuation segment of `parentName`: same key with
 * an extra numeric suffix (Rigify B-bone segments `DEF-upper_arm.L.001`).
 */
export function isSegmentOf(name: string, parentName: string): boolean {
  const a = normalizeBoneName(name);
  const b = normalizeBoneName(parentName);
  if (a.side !== b.side || (a.side !== 'left' && a.side !== 'right')) return false;
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || ka !== kb || !(ka in SIDE_LEXICON)) return false;
  const na = numericSuffix(a);
  const nb = numericSuffix(b);
  return na !== null && (nb === null || na > nb) && a.tokens.length === b.tokens.length + (nb === null ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

type CenterRole = 'hips' | 'spine' | 'chest' | 'upperChest' | 'neck' | 'head' | 'jaw';
type SideRole =
  | 'Shoulder'
  | 'UpperArm'
  | 'LowerArm'
  | 'Hand'
  | 'UpperLeg'
  | 'LowerLeg'
  | 'Foot'
  | 'Toes'
  | 'Eye';

/** Key -> [role, score] for roles that must not carry a side token. */
const CENTER_LEXICON: Record<string, [CenterRole, number]> = {
  hips: ['hips', 1],
  hip: ['hips', 0.9],
  pelvis: ['hips', 0.9],
  cog: ['hips', 0.5],
  root: ['hips', 0.3],
  spine: ['spine', 1],
  spinelower: ['spine', 0.9],
  lowerspine: ['spine', 0.9],
  spinemiddle: ['spine', 0.85],
  spineupper: ['chest', 0.8],
  upperspine: ['chest', 0.8],
  abdomen: ['spine', 0.9],
  abdomenlower: ['spine', 0.95],
  abdomenupper: ['spine', 0.9],
  waist: ['spine', 0.9],
  torso: ['spine', 0.8],
  lowerback: ['spine', 0.8],
  back: ['spine', 0.5],
  belly: ['spine', 0.6],
  stomach: ['spine', 0.6],
  body: ['spine', 0.4],
  chest: ['chest', 1],
  chestlower: ['chest', 0.95],
  lowerchest: ['chest', 0.95],
  thorax: ['chest', 0.8],
  ribcage: ['chest', 0.7],
  upperbody: ['chest', 0.6],
  upperchest: ['upperChest', 1],
  chestupper: ['upperChest', 1],
  neck: ['neck', 1],
  necktwist: ['neck', 0.9],
  necklower: ['neck', 0.95],
  neckupper: ['neck', 0.8],
  cervical: ['neck', 0.7],
  head: ['head', 1],
  skull: ['head', 0.8],
  jaw: ['jaw', 1],
  jawroot: ['jaw', 0.9],
  chin: ['jaw', 0.6],
  mandible: ['jaw', 0.8],
};

/** Key -> [role suffix, score] for roles that require a side token. */
const SIDE_LEXICON: Record<string, [SideRole, number]> = {
  shoulder: ['Shoulder', 1],
  clavicle: ['Shoulder', 1],
  clav: ['Shoulder', 0.9],
  collar: ['Shoulder', 1],
  collarbone: ['Shoulder', 0.9],
  upperarm: ['UpperArm', 1],
  uparm: ['UpperArm', 1],
  arm: ['UpperArm', 0.95],
  armupper: ['UpperArm', 1],
  humerus: ['UpperArm', 0.9],
  bicep: ['UpperArm', 0.8],
  biceps: ['UpperArm', 0.8],
  shldr: ['UpperArm', 0.95],
  shldrbend: ['UpperArm', 1],
  shoulderbend: ['UpperArm', 0.9],
  upperarmbend: ['UpperArm', 1],
  forearm: ['LowerArm', 1],
  forearmbend: ['LowerArm', 1],
  lowerarm: ['LowerArm', 1],
  loarm: ['LowerArm', 1],
  lowarm: ['LowerArm', 1],
  armlower: ['LowerArm', 1],
  elbow: ['LowerArm', 0.9],
  ulna: ['LowerArm', 0.7],
  radius: ['LowerArm', 0.6],
  hand: ['Hand', 1],
  wrist: ['Hand', 0.9],
  upleg: ['UpperLeg', 1],
  upperleg: ['UpperLeg', 1],
  legupper: ['UpperLeg', 1],
  thigh: ['UpperLeg', 1],
  thighbend: ['UpperLeg', 1],
  femur: ['UpperLeg', 0.9],
  hip: ['UpperLeg', 0.85],
  lowerleg: ['LowerLeg', 1],
  loleg: ['LowerLeg', 1],
  lowleg: ['LowerLeg', 1],
  leglower: ['LowerLeg', 1],
  calf: ['LowerLeg', 1],
  shin: ['LowerLeg', 1],
  shinbend: ['LowerLeg', 1],
  knee: ['LowerLeg', 0.9],
  tibia: ['LowerLeg', 0.8],
  foot: ['Foot', 1],
  feet: ['Foot', 0.9],
  ankle: ['Foot', 0.9],
  toe: ['Toes', 1],
  toes: ['Toes', 1],
  toebase: ['Toes', 1],
  ball: ['Toes', 0.9],
  eye: ['Eye', 1],
  eyeball: ['Eye', 0.9],
  faceeye: ['Eye', 1],
};

const UPPER_LEG_KEYS = new Set(['upleg', 'upperleg', 'legupper', 'thigh', 'thighbend', 'femur', 'hip']);
const LOWER_LEG_KEYS = new Set(['leg', 'lowerleg', 'loleg', 'lowleg', 'leglower', 'calf', 'shin', 'shinbend', 'knee', 'tibia']);

const FINGER_NAMES: Record<string, 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Little'> = {
  thumb: 'Thumb',
  index: 'Index',
  pointer: 'Index',
  middle: 'Middle',
  mid: 'Middle',
  ring: 'Ring',
  pinky: 'Little',
  pinkie: 'Little',
  little: 'Little',
};
const FINGER_FILLER = new Set(['hand', 'f', 'finger', 'fingers', 'digit']);
const SEGMENT_WORDS: Record<string, 'Metacarpal' | 'Proximal' | 'Intermediate' | 'Distal' | 'tip'> = {
  metacarpal: 'Metacarpal',
  meta: 'Metacarpal',
  proximal: 'Proximal',
  prox: 'Proximal',
  intermediate: 'Intermediate',
  inter: 'Intermediate',
  medial: 'Intermediate',
  middle: 'Intermediate',
  distal: 'Distal',
  dist: 'Distal',
  tip: 'tip',
  end: 'tip',
};

export interface FingerNameInfo {
  finger: 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Little';
  segment: 'Metacarpal' | 'Proximal' | 'Intermediate' | 'Distal' | 'tip' | null;
  side: NameSide;
}

/**
 * Finger and segment carried by a bone name (`LeftHandThumb1`, `index_02_l`,
 * `DEF-f_ring.03.L`, `J_Bip_L_Little2`...). Digit convention: thumb 1/2/3 =
 * metacarpal/proximal/distal, other fingers 1/2/3 = proximal/intermediate/distal,
 * 4 = tip. Non-thumb fingers named `*_metacarpal` get segment `Metacarpal`
 * (no humanoid role).
 */
export function fingerNameInfo(name: string): FingerNameInfo | null {
  const n = normalizeBoneName(name);
  let finger: FingerNameInfo['finger'] | null = null;
  let segment: FingerNameInfo['segment'] = null;
  let digit: number | null = null;
  for (const t of n.tokens) {
    if (/^\d+$/.test(t)) {
      digit = parseInt(t, 10);
      continue;
    }
    if (finger === null && FINGER_NAMES[t]) {
      finger = FINGER_NAMES[t];
      continue;
    }
    if (finger !== null && SEGMENT_WORDS[t]) {
      segment = SEGMENT_WORDS[t];
      continue;
    }
    if (FINGER_FILLER.has(t)) continue;
    // Any other token means this is not a plain finger bone (e.g. thumb_ik, ThumbTarget).
    return null;
  }
  if (finger === null) return null;
  if (segment === null && digit !== null) {
    if (finger === 'Thumb') segment = digit === 1 ? 'Metacarpal' : digit === 2 ? 'Proximal' : digit === 3 ? 'Distal' : 'tip';
    else segment = digit === 1 ? 'Proximal' : digit === 2 ? 'Intermediate' : digit === 3 ? 'Distal' : 'tip';
  }
  return { finger, segment, side: n.side };
}

export interface NameCandidate {
  index: number;
  score: number;
}

function sidePrefix(side: NameSide): 'left' | 'right' | null {
  return side === 'left' || side === 'right' ? side : null;
}

/**
 * Per-role ranked candidate lists from names only. Sides must match; helper
 * bones are skipped; rig-family conventions are resolved with the light
 * structural rules from docs/DESIGN.md §5.4 (Mixamo `Leg` after `UpLeg` is a
 * lower leg, a side-qualified `hip` is an upper leg, `shoulder` is a clavicle
 * only when the same side also has an arm candidate).
 */
export function scoreNameCandidates(graph: SkeletonGraph): Map<HumanoidBone, NameCandidate[]> {
  const out = new Map<HumanoidBone, NameCandidate[]>();
  const push = (role: HumanoidBone, index: number, score: number) => {
    let list = out.get(role);
    if (!list) {
      list = [];
      out.set(role, list);
    }
    const existing = list.find((c) => c.index === index);
    if (existing) existing.score = Math.max(existing.score, score);
    else list.push({ index, score });
  };

  const norms = graph.nodes.map((n) => normalizeBoneName(n.name));
  const keys = norms.map(nameKey);
  const helper = graph.nodes.map((n) => isHelperBone(n.name));

  const sameSideAncestorHasKey = (index: number, keySet: Set<string>): boolean => {
    const side = norms[index].side;
    let p = graph.nodes[index].parent;
    while (p >= 0) {
      if (keySet.has(keys[p]) && norms[p].side === side && !helper[p]) return true;
      p = graph.nodes[p].parent;
    }
    return false;
  };
  const sameSideDescendantHasKey = (index: number, keySet: Set<string>): boolean => {
    const side = norms[index].side;
    const stack = [...graph.nodes[index].children];
    while (stack.length) {
      const i = stack.pop()!;
      if (keySet.has(keys[i]) && norms[i].side === side && !helper[i]) return true;
      for (const c of graph.nodes[i].children) stack.push(c);
    }
    return false;
  };

  // Which sides carry an explicit arm candidate (for the shoulder rule).
  const armSides = new Set<string>();
  for (let i = 0; i < graph.nodes.length; i++) {
    if (helper[i]) continue;
    const s = sidePrefix(norms[i].side);
    if (!s) continue;
    const entry = SIDE_LEXICON[keys[i]];
    if (entry && entry[0] === 'UpperArm') armSides.add(s);
  }

  for (let i = 0; i < graph.nodes.length; i++) {
    if (helper[i]) continue;
    const norm = norms[i];
    const key = keys[i];
    if (!key) continue;
    const side = sidePrefix(norm.side);
    const suffix = numericSuffix(norm);
    const chainPenalty = suffix === null ? 0 : 0.01 * Math.min(suffix, 20);

    // Fingers first: they carry finger tokens that would otherwise not match.
    const finger = fingerNameInfo(graph.nodes[i].name);
    if (finger && side) {
      if (finger.segment && finger.segment !== 'tip') {
        if (finger.finger === 'Thumb' && finger.segment === 'Intermediate') continue;
        if (finger.finger !== 'Thumb' && finger.segment === 'Metacarpal') continue;
        push(`${side}${finger.finger}${finger.segment}` as HumanoidBone, i, 1);
      }
      continue;
    }

    if (side === null) {
      const center = CENTER_LEXICON[key];
      if (center) {
        let [role, score] = center;
        if (role === 'hips') {
          const kids = graph.nodes[i].children.length;
          if (key === 'root' || key === 'cog') {
            if (kids < 2) continue;
            score += 0.2;
          } else if (kids >= 2) score += 0.05;
        }
        push(role, i, score - chainPenalty);
      }
      continue;
    }

    // Side-qualified roles.
    if (key === 'leg') {
      if (sameSideAncestorHasKey(i, UPPER_LEG_KEYS)) push(`${side}LowerLeg`, i, 1 - chainPenalty);
      else if (sameSideDescendantHasKey(i, LOWER_LEG_KEYS)) push(`${side}UpperLeg`, i, 0.9 - chainPenalty);
      else push(`${side}LowerLeg`, i, 0.6 - chainPenalty);
      continue;
    }
    const entry = SIDE_LEXICON[key];
    if (!entry) continue;
    let [role, score] = entry;
    if (role === 'Shoulder' && !armSides.has(side)) {
      // "shoulder" with no separate arm bone on this side is the upper arm itself.
      role = 'UpperArm';
      score = 0.8;
    }
    push(`${side}${role}` as HumanoidBone, i, score - chainPenalty);
  }

  for (const list of out.values()) list.sort((a, b) => b.score - a.score || a.index - b.index);
  return out;
}

/** Rig family guess from raw bone names (docs/DESIGN.md §5.5 presets). */
export function detectFamilyFromNames(names: string[]): 'mixamo' | 'meshy' | 'vrm' | 'rigify' | 'ue' | 'cc' | 'daz' | 'blender' | 'unknown' {
  const set = new Set(names);
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (has(/^mixamorig\d*:/i)) return 'mixamo';
  if (has(/^J_Bip_/)) return 'vrm';
  if (has(/^DEF-/)) return 'rigify';
  if (has(/^CC_Base_/i)) return 'cc';
  if (set.has('pelvis') && (set.has('spine_01') || set.has('spine_02'))) return 'ue';
  if (set.has('abdomenLower') || set.has('lShldrBend') || set.has('rShldrBend')) return 'daz';
  if (set.has('Spine02') && (set.has('neck') || set.has('head_end') || set.has('Spine01'))) return 'meshy';
  if (set.has('Hips') && set.has('Spine') && set.has('LeftArm') && set.has('LeftForeArm')) return 'mixamo';
  if (has(/^(spine|upper_arm|forearm|thigh|shin)(\.\d{3})?(\.[LR])?$/)) return 'blender';
  return 'unknown';
}
