/**
 * WebM (Matroska/EBML) Duration patcher. MediaRecorder streams the file, so it
 * cannot know the duration up front and leaves the Segment Information's
 * Duration element out; players then cannot seek. `patchWebmDuration` writes
 * a Duration element (or updates an existing one) with the measured elapsed
 * time. Compact, in the spirit of fix-webm-duration, plus SeekHead / Cues
 * position fix-ups for the bytes inserted. Pure: no DOM.
 */

export const EBML_ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTrackPositions: 0xb7,
  CueClusterPosition: 0xf1,
  Void: 0xec,
} as const;

/** Matroska default: 1 000 000 ns per timecode unit (= 1 ms). */
export const DEFAULT_TIMECODE_SCALE = 1_000_000;

export interface EbmlElement {
  id: number;
  /** Offset of the ID's first byte. */
  start: number;
  /** Byte length of the ID. */
  idLength: number;
  /** Byte length of the size vint. */
  sizeLength: number;
  /** Data length in bytes; null for "unknown size" (extends to `end`). */
  size: number | null;
  dataStart: number;
  dataEnd: number;
}

interface Vint {
  length: number;
  value: number;
  unknown: boolean;
}

function readVint(bytes: Uint8Array, pos: number): Vint {
  if (pos >= bytes.length) throw new Error('EBML: unexpected end of data');
  const first = bytes[pos];
  if (first === 0) throw new Error(`EBML: invalid vint at ${pos}`);
  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (pos + length > bytes.length) throw new Error('EBML: truncated vint');
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = bytes[pos + i];
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { length, value, unknown: allOnes };
}

function readId(bytes: Uint8Array, pos: number): { length: number; id: number } {
  const first = bytes[pos];
  if (first === undefined || first === 0) throw new Error(`EBML: invalid element ID at ${pos}`);
  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    mask >>= 1;
    length++;
    if (length > 4) throw new Error(`EBML: invalid element ID at ${pos}`);
  }
  if (pos + length > bytes.length) throw new Error('EBML: truncated element ID');
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[pos + i];
  return { length, id };
}

/** Reads the element at `pos`; `end` bounds unknown-sized elements. */
export function readEbmlElement(bytes: Uint8Array, pos: number, end = bytes.length): EbmlElement {
  const { length: idLength, id } = readId(bytes, pos);
  const sz = readVint(bytes, pos + idLength);
  const dataStart = pos + idLength + sz.length;
  const size = sz.unknown ? null : sz.value;
  const dataEnd = size === null ? end : Math.min(end, dataStart + size);
  return { id, start: pos, idLength, sizeLength: sz.length, size, dataStart, dataEnd };
}

/** Reads consecutive elements in [start, end). Stops at the first unreadable element. */
export function readEbmlChildren(bytes: Uint8Array, start: number, end: number): EbmlElement[] {
  const out: EbmlElement[] = [];
  let pos = start;
  while (pos < end) {
    let el: EbmlElement;
    try {
      el = readEbmlElement(bytes, pos, end);
    } catch {
      break;
    }
    out.push(el);
    if (el.dataEnd <= pos) break;
    pos = el.dataEnd;
  }
  return out;
}

function readUint(bytes: Uint8Array, el: EbmlElement): number {
  let v = 0;
  for (let i = el.dataStart; i < el.dataEnd; i++) v = v * 256 + bytes[i];
  return v;
}

function writeUint(bytes: Uint8Array, el: EbmlElement, value: number): boolean {
  const width = el.dataEnd - el.dataStart;
  if (width <= 0 || width > 8 || value < 0 || value >= 2 ** (8 * width)) return false;
  let v = value;
  for (let i = el.dataEnd - 1; i >= el.dataStart; i--) {
    bytes[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return true;
}

function readFloat(bytes: Uint8Array, el: EbmlElement): number | null {
  const width = el.dataEnd - el.dataStart;
  const view = new DataView(bytes.buffer, bytes.byteOffset + el.dataStart, width);
  if (width === 8) return view.getFloat64(0);
  if (width === 4) return view.getFloat32(0);
  return null;
}

function writeFloat(bytes: Uint8Array, el: EbmlElement, value: number): boolean {
  const width = el.dataEnd - el.dataStart;
  const view = new DataView(bytes.buffer, bytes.byteOffset + el.dataStart, width);
  if (width === 8) view.setFloat64(0, value);
  else if (width === 4) view.setFloat32(0, value);
  else return false;
  return true;
}

/** Encodes a size vint using at least `minLength` bytes (at most 8). */
function encodeSize(value: number, minLength = 1): Uint8Array {
  let length = minLength;
  // A length-n vint holds values < 2^(7n) - 1 (all ones is reserved for "unknown").
  while (length < 8 && value >= 2 ** (7 * length) - 1) length++;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function encodeId(id: number): Uint8Array {
  const parts: number[] = [];
  let v = id;
  while (v > 0) {
    parts.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

interface WebmLayout {
  segment: EbmlElement;
  info: EbmlElement | null;
  timecodeScale: number;
  timecodeScaleEl: EbmlElement | null;
  duration: EbmlElement | null;
}

function locate(bytes: Uint8Array): WebmLayout | null {
  const top = readEbmlChildren(bytes, 0, bytes.length);
  const segment = top.find((e) => e.id === EBML_ID.Segment);
  if (!segment) return null;
  const children = readEbmlChildren(bytes, segment.dataStart, segment.dataEnd);
  const info = children.find((e) => e.id === EBML_ID.Info) ?? null;
  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  let timecodeScaleEl: EbmlElement | null = null;
  let duration: EbmlElement | null = null;
  if (info) {
    for (const el of readEbmlChildren(bytes, info.dataStart, info.dataEnd)) {
      if (el.id === EBML_ID.TimecodeScale) {
        timecodeScaleEl = el;
        const v = readUint(bytes, el);
        if (v > 0) timecodeScale = v;
      } else if (el.id === EBML_ID.Duration) {
        duration = el;
      }
    }
  }
  return { segment, info, timecodeScale, timecodeScaleEl, duration };
}

/** Reads the Duration of a WebM buffer in milliseconds, or null when absent. */
export function readWebmDuration(buffer: ArrayBuffer | Uint8Array): { durationMs: number | null; timecodeScale: number } {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const layout = locate(bytes);
  if (!layout) return { durationMs: null, timecodeScale: DEFAULT_TIMECODE_SCALE };
  if (!layout.duration) return { durationMs: null, timecodeScale: layout.timecodeScale };
  const raw = readFloat(bytes, layout.duration);
  if (raw === null) return { durationMs: null, timecodeScale: layout.timecodeScale };
  return { durationMs: (raw * layout.timecodeScale) / 1e6, timecodeScale: layout.timecodeScale };
}

/**
 * Adds `delta` to every SeekPosition / CueClusterPosition (relative to the
 * Segment data start) that points at or beyond `fromRelOffset`. Values that
 * would not fit their current width are left unchanged.
 */
function shiftPositions(bytes: Uint8Array, segment: EbmlElement, fromRelOffset: number, delta: number): void {
  const fix = (el: EbmlElement) => {
    const v = readUint(bytes, el);
    if (v >= fromRelOffset) writeUint(bytes, el, v + delta);
  };
  for (const child of readEbmlChildren(bytes, segment.dataStart, segment.dataEnd)) {
    if (child.id === EBML_ID.SeekHead) {
      for (const seek of readEbmlChildren(bytes, child.dataStart, child.dataEnd)) {
        if (seek.id !== EBML_ID.Seek) continue;
        for (const e of readEbmlChildren(bytes, seek.dataStart, seek.dataEnd)) if (e.id === EBML_ID.SeekPosition) fix(e);
      }
    } else if (child.id === EBML_ID.Cues) {
      for (const point of readEbmlChildren(bytes, child.dataStart, child.dataEnd)) {
        if (point.id !== EBML_ID.CuePoint) continue;
        for (const tp of readEbmlChildren(bytes, point.dataStart, point.dataEnd)) {
          if (tp.id !== EBML_ID.CueTrackPositions) continue;
          for (const e of readEbmlChildren(bytes, tp.dataStart, tp.dataEnd)) if (e.id === EBML_ID.CueClusterPosition) fix(e);
        }
      }
    }
  }
}

/**
 * Returns a copy of the WebM buffer whose Segment Information carries
 * `durationMs`. An existing Duration element is updated in place; otherwise a
 * float64 Duration is appended to Info, Info's (and a known Segment's) size is
 * grown, and SeekHead / Cues positions after Info are shifted. Buffers that
 * are not EBML (no Segment / no Info) are returned unchanged (as a copy).
 */
export function patchWebmDuration(buffer: ArrayBuffer | Uint8Array, durationMs: number): ArrayBuffer {
  const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const bytes = new Uint8Array(src); // copy
  if (!(durationMs >= 0) || !Number.isFinite(durationMs)) return toArrayBuffer(bytes);
  const layout = locate(bytes);
  if (!layout || !layout.info) return toArrayBuffer(bytes);
  const value = (durationMs * 1e6) / layout.timecodeScale;

  if (layout.duration && writeFloat(bytes, layout.duration, value)) return toArrayBuffer(bytes);

  const { segment, info } = layout;
  const durationEl = concat([encodeId(EBML_ID.Duration), encodeSize(8), float64(value)]);
  const infoData = bytes.subarray(info.dataStart, info.dataEnd);
  const newInfoSize = encodeSize(infoData.length + durationEl.length, info.sizeLength);
  const newInfo = concat([encodeId(EBML_ID.Info), newInfoSize, infoData, durationEl]);
  const infoOld = bytes.subarray(info.start, info.dataEnd);
  const delta = newInfo.length - infoOld.length;

  const segHeader =
    segment.size === null
      ? bytes.subarray(segment.start, segment.dataStart)
      : concat([encodeId(EBML_ID.Segment), encodeSize(segment.size + delta, segment.sizeLength)]);

  const out = concat([
    bytes.subarray(0, segment.start),
    segHeader,
    bytes.subarray(segment.dataStart, info.start),
    newInfo,
    bytes.subarray(info.dataEnd, segment.dataEnd),
    bytes.subarray(segment.dataEnd),
  ]);

  const relayout = locate(out);
  if (relayout) shiftPositions(out, relayout.segment, info.dataEnd - segment.dataStart, delta);
  return toArrayBuffer(out);
}

function float64(v: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, v);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
