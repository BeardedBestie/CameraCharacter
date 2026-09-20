/**
 * Name detector (docs/DESIGN.md §5.4): namespace-prefix stripping, side
 * detection, longest-phrase-first tokenization, helper classification and the
 * CLASS + SIDE + ORDINAL output per bone. Names never decide roles here; the
 * chain order does (topology.ts). Only two decisions are name-driven and both
 * are taken by the topology step from the information produced here: the
 * shoulder-vs-upperArm rule and finger digit identity.
 *
 * Pure: no three.js, no DOM.
 */
import type { RigFamily } from '../core/types';

export type NameSide = 'left' | 'right' | 'center' | null;
export type BoneGroup = 'torso' | 'arm' | 'leg' | 'finger' | 'face' | 'ignore' | 'marker' | 'unknown';
/** Group plus side for the limb groups: `armL`, `legR`, ... */
export type BoneClass = 'torso' | 'arm' | 'armL' | 'armR' | 'leg' | 'legL' | 'legR' | 'finger' | 'face' | 'ignore' | 'marker' | 'unknown';
export type FingerDigit = 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Little';
export type FingerSegment = 'Metacarpal' | 'Proximal' | 'Intermediate' | 'Distal' | 'Tip';

export interface FingerInfo {
  digit: FingerDigit;
  /** Segment from a segment word or a 1..4 ordinal (thumb: 1 = metacarpal; others: 1 = proximal), or null. */
  segment: FingerSegment | null;
  ordinal: number | null;
}

export interface BoneNameInfo {
  raw: string;
  /** Name after namespace-prefix removal (case preserved). */
  stripped: string;
  /** Lower-case tokens after phrase merging; side tokens removed; digits are separate tokens. */
  tokens: string[];
  side: NameSide;
  /** Tokens minus side, twist/roll/bend and numeric tokens, joined (`lShldrTwist` -> `shldr`). */
  stem: string;
  /** Last numeric token, or null. */
  ordinal: number | null;
  /** Carries a `twist` or `roll` token. */
  twist: boolean;
  /** Carries a `.NNN` three-digit segment suffix (Rigify B-bone segments). */
  segment: boolean;
  group: BoneGroup;
  class: BoneClass;
  /** Lexicon word that decided the group (e.g. `forearm`, `toebase`), or null. */
  keyword: string | null;
  finger: FingerInfo | null;
  /** Tail-marker token present (`end`, `nub`, `tip`, `site`, `leaf`), regardless of leaf/weight status. */
  markerToken: boolean;
}

/** Hierarchy context that helper classification needs (leaf status, skin weight). */
export interface BoneNodeContext {
  isLeaf: boolean;
  /** Summed skin weight; ignored when `hasWeights` is false. */
  weight: number;
  hasWeights: boolean;
}

// ---------------------------------------------------------------------------
// Prefixes and tokenization
// ---------------------------------------------------------------------------

/** True namespace prefixes only (never `Armature|`, `Armature_`, `root|`). */
const PREFIX_PATTERNS: RegExp[] = [
  /^mixamorig\d*:?/i,
  /^DEF-/,
  /^ORG-/,
  /^MCH-/,
  /^CC_Base_/i,
  /^Character1_/i,
  /^Genesis\d*(Female|Male)?_?(?=[A-Za-z])/,
  /^Bip0?0?1[\s_]/i,
  /^bone_/i,
  /^b_/i,
];

/** VRoid secondary/adjust/optional bones: never roles. */
const VROID_IGNORE = /^J_(Sec|Adj|Opt)_/;

/** Strips namespace prefixes; `J_Bip_` keeps its `C_/L_/R_` as the side. */
export function stripPrefix(name: string): { stripped: string; side: NameSide } {
  let s = name.trim();
  let side: NameSide = null;
  const vroid = /^J_Bip_(?:([CLR])_)?/.exec(s);
  if (vroid) {
    s = s.slice(vroid[0].length);
    if (vroid[1] === 'L') side = 'left';
    else if (vroid[1] === 'R') side = 'right';
    else if (vroid[1] === 'C') side = 'center';
    return { stripped: s, side };
  }
  for (const re of PREFIX_PATTERNS) {
    const m = re.exec(s);
    if (m && m[0].length > 0 && m[0].length < s.length) {
      s = s.slice(m[0].length);
      break;
    }
  }
  return { stripped: s, side };
}

/** Multi-word lexicon phrases merged into one token (longest first). */
const PHRASES = [
  'centerofmass',
  'upperchest',
  'lowerchest',
  'collarbone',
  'metatarsals',
  'metatarsal',
  'upperarm',
  'lowerarm',
  'upperleg',
  'lowerleg',
  'forearm',
  'toebase',
  'headtop',
  'kneeback',
  'eyelid',
  'eyeball',
  'faceeye',
  'anklebck',
  'anklefwd',
  'bigtoe',
  'smalltoe',
  'lowerjaw',
  'upperjaw',
  'jawroot',
  'upleg',
];
const PHRASE_SET = new Set(PHRASES);
const MAX_PHRASE_TOKENS = 3;

function splitRaw(s: string): string[] {
  const spaced = s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Merges consecutive tokens that form a lexicon phrase, longest phrase first. */
export function mergePhrases(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let merged = false;
    for (let n = Math.min(MAX_PHRASE_TOKENS, tokens.length - i); n >= 2; n--) {
      const joined = tokens.slice(i, i + n).join('');
      if (PHRASE_SET.has(joined)) {
        out.push(joined);
        i += n;
        merged = true;
        break;
      }
    }
    if (!merged) {
      out.push(tokens[i]);
      i++;
    }
  }
  return out;
}

/**
 * Splits a prefix-stripped name into lower-case tokens and extracts the side:
 * `left|right` words, `l|r` single-letter tokens (`.L`, `_L`, `L_`, UE5 `_l`,
 * Daz `lShldrBend` whose leading `l` splits off at the capital), and glued
 * lower-case `leftfoot`.
 */
export function tokenize(stripped: string, presetSide: NameSide = null): { tokens: string[]; side: NameSide } {
  const raw = splitRaw(stripped);
  const expanded: string[] = [];
  for (const t of raw) {
    const glued = /^(left|right)([a-z]{2,})$/.exec(t);
    if (glued) {
      expanded.push(glued[1], glued[2]);
    } else expanded.push(t);
  }
  let side: NameSide = presetSide;
  let contradiction = false;
  const tokens: string[] = [];
  for (const t of expanded) {
    let s: NameSide = null;
    if (t === 'left' || t === 'l') s = 'left';
    else if (t === 'right' || t === 'r') s = 'right';
    if (s) {
      if (side && side !== 'center' && side !== s) contradiction = true;
      side = s;
      continue;
    }
    tokens.push(t);
  }
  if (contradiction) side = null;
  return { tokens: mergePhrases(tokens), side };
}

// ---------------------------------------------------------------------------
// Lexicons (whole tokens)
// ---------------------------------------------------------------------------

const MARKER_TOKENS = new Set(['end', 'nub', 'tip', 'site', 'leaf', 'endsite']);

const IGNORE_TOKENS = new Set([
  'ik',
  'fk',
  'mch',
  'ctrl',
  'ctl',
  'con',
  'pole',
  'target',
  'tweak',
  'prop',
  'weapon',
  'socket',
  'attach',
  'centerofmass',
  'interaction',
  'camera',
  'heel',
  'sole',
  'anklebck',
  'anklefwd',
  'bck',
  'fwd',
  'hair',
  'skirt',
  'breast',
  'breasts',
  'bust',
  'boob',
  'tail',
  'wing',
  'wings',
  'eyelid',
  'lid',
  'lids',
  // UE5 side-branch correctives and similar helpers.
  'corrective',
  'correctiveroot',
  'latissimus',
  'scap',
  'pec',
  'inner',
  'outer',
  'out',
  'in',
  'kneeback',
  'cor',
  'ribs',
  'pectoral',
  'trapezius',
  'scapula',
]);

const TORSO_TOKENS = new Set(['hips', 'hip', 'pelvis', 'abdomen', 'waist', 'torso', 'spine', 'chest', 'upperchest', 'lowerchest', 'neck', 'head']);
const ARM_TOKENS = new Set([
  'clavicle',
  'clav',
  'collar',
  'collarbone',
  'shoulder',
  'shldr',
  'arm',
  'upperarm',
  'humerus',
  'bicep',
  'biceps',
  'forearm',
  'elbow',
  'lowerarm',
  'ulna',
  'wrist',
  'hand',
  'palm',
]);
const LEG_TOKENS = new Set([
  'thigh',
  'upleg',
  'upperleg',
  'femur',
  'leg',
  'knee',
  'shin',
  'calf',
  'lowerleg',
  'tibia',
  'ankle',
  'foot',
  'toe',
  'toes',
  'toebase',
  'ball',
  'metatarsal',
  'metatarsals',
  'bigtoe',
  'smalltoe',
]);
const FACE_TOKENS = new Set(['eye', 'eyes', 'eyeball', 'faceeye', 'jaw', 'lowerjaw', 'upperjaw', 'jawroot', 'chin', 'mandible', 'tongue', 'teeth', 'tooth', 'nose', 'mouth', 'brow', 'eyebrow', 'cheek', 'ear', 'ears', 'lip', 'lips', 'facial', 'face']);
const FINGER_DIGITS: Record<string, FingerDigit> = {
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
const FINGER_SEGMENTS: Record<string, FingerSegment> = {
  metacarpal: 'Metacarpal',
  meta: 'Metacarpal',
  proximal: 'Proximal',
  prox: 'Proximal',
  intermediate: 'Intermediate',
  inter: 'Intermediate',
  medial: 'Intermediate',
  distal: 'Distal',
  dist: 'Distal',
};
const STEM_DROP = new Set(['twist', 'roll', 'bend']);

/** Shoulder-rule keywords: `clavicle|collar` always make a shoulder. */
export const CLAVICLE_TOKENS = new Set(['clavicle', 'clav', 'collar', 'collarbone']);
/** Shoulder-rule keywords: a `shoulder` followed by one of these is a shoulder, not the upper arm. */
export const UPPER_ARM_TOKENS = new Set(['arm', 'upperarm', 'humerus', 'shldr', 'bicep', 'biceps']);
export const TOE_TOKENS = new Set(['toe', 'toes', 'toebase', 'ball', 'bigtoe']);
export const HEAD_TOKENS = new Set(['head']);
export const METACARPAL_TOKENS = new Set(['metacarpal', 'meta', 'palm']);

function isNumeric(t: string): boolean {
  return /^\d+$/.test(t);
}

const _cache = new Map<string, BoneNameInfo>();

/** Name-only classification (no hierarchy context). Cached. */
export function parseBoneName(name: string): BoneNameInfo {
  const cached = _cache.get(name);
  if (cached) return cached;
  const { stripped, side: presetSide } = stripPrefix(name);
  const { tokens, side } = tokenize(stripped, presetSide);
  const info = classifyTokens(name, stripped, tokens, side);
  _cache.set(name, info);
  return info;
}

function classifyTokens(name: string, stripped: string, tokens: string[], side: NameSide): BoneNameInfo {
  const numeric = tokens.filter(isNumeric);
  const ordinal = numeric.length ? parseInt(numeric[numeric.length - 1], 10) : null;
  const twist = tokens.includes('twist') || tokens.includes('roll');
  const segment = numeric.some((t) => t.length === 3);
  const stem = tokens.filter((t) => !isNumeric(t) && !STEM_DROP.has(t)).join('');
  const markerToken = tokens.some((t) => MARKER_TOKENS.has(t));

  let group: BoneGroup = 'unknown';
  let keyword: string | null = null;
  let finger: FingerInfo | null = null;

  const ignored = VROID_IGNORE.test(name.trim()) || tokens.some((t) => IGNORE_TOKENS.has(t));
  const hasTorso = tokens.find((t) => TORSO_TOKENS.has(t));
  const hasArm = tokens.find((t) => ARM_TOKENS.has(t));
  const hasLeg = tokens.find((t) => LEG_TOKENS.has(t));
  const hasFace = tokens.find((t) => FACE_TOKENS.has(t));
  const digitToken = tokens.find((t) => FINGER_DIGITS[t] !== undefined);

  if (ignored) {
    group = 'ignore';
  } else if (markerToken) {
    group = 'marker';
  } else if (digitToken && fingerPlausible(digitToken, tokens, side, hasTorso, hasLeg)) {
    group = 'finger';
    keyword = digitToken;
    const segWord = tokens.find((t) => FINGER_SEGMENTS[t] !== undefined);
    const fingerOrdinal = ordinal !== null && ordinal >= 1 && ordinal <= 4 ? ordinal : null;
    let seg: FingerSegment | null = segWord ? FINGER_SEGMENTS[segWord] : null;
    const digit = FINGER_DIGITS[digitToken];
    if (!seg && fingerOrdinal !== null) {
      if (digit === 'Thumb') seg = fingerOrdinal === 1 ? 'Metacarpal' : fingerOrdinal === 2 ? 'Proximal' : fingerOrdinal === 3 ? 'Distal' : 'Tip';
      else seg = fingerOrdinal === 1 ? 'Proximal' : fingerOrdinal === 2 ? 'Intermediate' : fingerOrdinal === 3 ? 'Distal' : 'Tip';
    }
    finger = { digit, segment: seg, ordinal: fingerOrdinal };
  } else if (hasFace) {
    group = 'face';
    keyword = hasFace;
  } else if (hasTorso && !((hasTorso === 'hip' || hasTorso === 'pelvis') && (side === 'left' || side === 'right'))) {
    group = 'torso';
    keyword = hasTorso;
  } else if (hasArm) {
    group = 'arm';
    keyword = hasArm;
  } else if (hasLeg) {
    group = 'leg';
    keyword = hasLeg;
  } else if (hasTorso === 'hip' && (side === 'left' || side === 'right')) {
    group = 'leg';
    keyword = 'hip';
  }

  const cls = classOf(group, side);
  return { raw: name, stripped, tokens, side, stem, ordinal, twist, segment, group, class: cls, keyword, finger, markerToken };
}

function fingerPlausible(digitToken: string, tokens: string[], side: NameSide, hasTorso: string | undefined, hasLeg: string | undefined): boolean {
  if (hasLeg) return false; // "middle toe" etc.
  if (digitToken === 'middle' || digitToken === 'ring' || digitToken === 'mid') {
    if (hasTorso) return false;
    const sided = side === 'left' || side === 'right';
    const cue = tokens.some((t) => t === 'hand' || t === 'finger' || t === 'f' || isNumeric(t) || FINGER_SEGMENTS[t] !== undefined);
    return sided || cue;
  }
  return true;
}

function classOf(group: BoneGroup, side: NameSide): BoneClass {
  if (group === 'arm') return side === 'left' ? 'armL' : side === 'right' ? 'armR' : 'arm';
  if (group === 'leg') return side === 'left' ? 'legL' : side === 'right' ? 'legR' : 'leg';
  return group;
}

/**
 * Full classification with hierarchy context: a tail marker must be a leaf
 * with zero skin weight (a weighted `*_End` is a real bone); a Mixamo-style
 * finger tip (`Thumb4`, `Index4`) with no children and no weight is a marker.
 */
export function classifyBone(name: string, node?: BoneNodeContext): BoneNameInfo {
  const base = parseBoneName(name);
  if (!node) return base;
  const zeroWeight = !node.hasWeights || !(node.weight > 0);
  if (base.group === 'marker') {
    if (node.isLeaf && zeroWeight) return base;
    // A weighted or non-leaf "end" bone is a real link: classify without the marker token.
    const rest = base.tokens.filter((t) => !MARKER_TOKENS.has(t));
    const re = classifyTokens(name, base.stripped, rest, base.side);
    return { ...re, tokens: base.tokens, markerToken: true, group: re.group === 'marker' ? 'unknown' : re.group, class: re.group === 'marker' ? 'unknown' : re.class };
  }
  if (base.group === 'finger' && base.finger && base.finger.ordinal === 4 && node.isLeaf && zeroWeight) {
    return { ...base, group: 'marker', class: 'marker' };
  }
  return base;
}

/**
 * Segment/twist merge rule: `child` is a continuation of `parent` (skipped as
 * an unmapped intermediate) when it carries a twist/roll token or a `.NNN`
 * segment suffix, is sided, and its stem equals the parent's stem
 * (`lShldrTwist` after `lShldrBend`, `DEF-upper_arm.L.001` after
 * `DEF-upper_arm.L`). Torso chains (unsided) never merge: their links are
 * ordinal by nature (`DEF-spine.001`, CC4 `NeckTwist02`).
 */
export function isSegmentOf(child: BoneNameInfo, parent: BoneNameInfo): boolean {
  if (!(child.twist || child.segment)) return false;
  if (child.side !== 'left' && child.side !== 'right') return false;
  if (parent.side !== child.side) return false;
  if (!child.stem || child.stem !== parent.stem) return false;
  return true;
}

/** Normalized bone name for hashing: stripped, lower-case, separators removed. */
export function normalizedName(name: string): string {
  return stripPrefix(name).stripped.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ---------------------------------------------------------------------------
// Rig family
// ---------------------------------------------------------------------------

export interface FamilyHints {
  /** glTF `asset.generator` string when known. */
  generator?: string;
  /** Mesh node names (the bundled pack uses `part_*` / `cap_*` meshes). */
  meshNames?: readonly string[];
  /** The file was a VRM. */
  vrm?: boolean;
}

/** Rig family guess from raw bone names and loader hints (docs/DESIGN.md §5.4). */
export function detectFamily(names: readonly string[], hints: FamilyHints = {}): RigFamily {
  const set = new Set(names);
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (hints.vrm || has(/^J_Bip_/)) return 'vrm';
  if (has(/^mixamorig\d*:?[A-Z]/i)) return 'mixamo';
  if (has(/^DEF-/)) return 'rigify';
  if (has(/^CC_Base_/i)) return 'cc';
  if (set.has('pelvis') && (set.has('spine_01') || set.has('spine_02')) && (set.has('thigh_l') || set.has('upperarm_l'))) return 'ue';
  if (set.has('abdomenLower') || set.has('lShldrBend') || set.has('rShldrBend') || has(/^Genesis\d/)) return 'daz';
  if (set.has('pelvis') && (set.has('left_hip') || set.has('right_hip')) && (set.has('left_knee') || set.has('left_collar') || set.has('left_shoulder'))) return 'smpl';
  const meshySpine = set.has('Spine02') && set.has('Spine') && set.has('Hips');
  if (meshySpine) {
    const gen = hints.generator ?? '';
    const packGenerator = /compress_glb|game-parts/i.test(gen);
    const packMeshes = (hints.meshNames ?? []).some((m) => /^(part|cap)_/.test(m) || m === 'char1');
    if (packGenerator || packMeshes) return 'game-parts';
    return 'meshy';
  }
  if (set.has('Hips') && set.has('Spine') && set.has('LeftArm') && set.has('LeftForeArm')) return 'mixamo';
  if (has(/^(spine|upper_arm|forearm|thigh|shin|shoulder|hand|foot)(\.\d{3})?(\.[LR])?$/)) return 'blender';
  return 'unknown';
}
