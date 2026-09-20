import { describe, expect, it } from 'vitest';
import { EBML_ID, patchWebmDuration, readEbmlChildren, readEbmlElement, readWebmDuration } from '../../src/record/webmDuration';

const bytes = (...parts: (number[] | Uint8Array)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) out.push(...Array.from(p));
  return Uint8Array.from(out);
};

const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]; // DocType "webm"
const TIMECODE_SCALE = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]; // 1 000 000
const INFO_NO_DURATION = [0x15, 0x49, 0xa9, 0x66, 0x87, ...TIMECODE_SCALE];
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75, 0x84, 0xe7, 0x81, 0x00, 0xa3]; // Timecode 0 + a stray byte
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function float64(v: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return Array.from(b);
}

describe('patchWebmDuration', () => {
  it('inserts a Duration element into an Info that lacks one (unknown-size Segment)', () => {
    const input = bytes(EBML_HEADER, [0x18, 0x53, 0x80, 0x67], UNKNOWN_SIZE, INFO_NO_DURATION, CLUSTER);
    expect(readWebmDuration(input).durationMs).toBeNull();
    const out = new Uint8Array(patchWebmDuration(input, 12345));
    expect(out.length).toBe(input.length + 11);
    expect(readWebmDuration(out)).toEqual({ durationMs: 12345, timecodeScale: 1_000_000 });
    // Header untouched, Segment still unknown-sized, Info grown by 11 bytes, then the Duration bytes.
    expect(Array.from(out.subarray(0, EBML_HEADER.length))).toEqual(EBML_HEADER);
    const segment = readEbmlChildren(out, 0, out.length).find((e) => e.id === EBML_ID.Segment)!;
    expect(segment.size).toBeNull();
    const [info, cluster] = readEbmlChildren(out, segment.dataStart, segment.dataEnd);
    expect(info.id).toBe(EBML_ID.Info);
    expect(info.size).toBe(7 + 11);
    const children = readEbmlChildren(out, info.dataStart, info.dataEnd);
    expect(children.map((c) => c.id)).toEqual([EBML_ID.TimecodeScale, EBML_ID.Duration]);
    const dur = children[1];
    expect(Array.from(out.subarray(dur.start, dur.dataEnd))).toEqual([0x44, 0x89, 0x88, ...float64(12345)]);
    expect(cluster.id).toBe(EBML_ID.Cluster);
    expect(Array.from(out.subarray(cluster.start, cluster.dataEnd))).toEqual(CLUSTER);
    // Input not mutated.
    expect(readWebmDuration(input).durationMs).toBeNull();
  });

  it('honours a non-default TimecodeScale', () => {
    const scale = [0x2a, 0xd7, 0xb1, 0x82, 0x03, 0xe8]; // 1000 ns
    const info = [0x15, 0x49, 0xa9, 0x66, 0x86, ...scale];
    const input = bytes(EBML_HEADER, [0x18, 0x53, 0x80, 0x67], UNKNOWN_SIZE, info, CLUSTER);
    const out = patchWebmDuration(input, 2.5);
    const r = readWebmDuration(out);
    expect(r.timecodeScale).toBe(1000);
    expect(r.durationMs).toBeCloseTo(2.5, 9);
    const seg = readEbmlChildren(new Uint8Array(out), 0, out.byteLength).find((e) => e.id === EBML_ID.Segment)!;
    const infoEl = readEbmlChildren(new Uint8Array(out), seg.dataStart, seg.dataEnd)[0];
    const dur = readEbmlChildren(new Uint8Array(out), infoEl.dataStart, infoEl.dataEnd).find((e) => e.id === EBML_ID.Duration)!;
    expect(new DataView(out, dur.dataStart, 8).getFloat64(0)).toBe(2.5e6 / 1000);
  });

  it('updates an existing Duration in place', () => {
    const duration = [0x44, 0x89, 0x88, ...float64(0)];
    const info = [0x15, 0x49, 0xa9, 0x66, 0x87 + 11, ...TIMECODE_SCALE, ...duration];
    const input = bytes(EBML_HEADER, [0x18, 0x53, 0x80, 0x67], UNKNOWN_SIZE, info, CLUSTER);
    expect(readWebmDuration(input).durationMs).toBe(0);
    const out = new Uint8Array(patchWebmDuration(input, 987.5));
    expect(out.length).toBe(input.length);
    expect(readWebmDuration(out).durationMs).toBe(987.5);
    // Everything except the 8 float bytes is identical.
    let diff = 0;
    for (let i = 0; i < out.length; i++) if (out[i] !== input[i]) diff++;
    expect(diff).toBeLessThanOrEqual(8);
  });

  it('grows a known-size Segment and shifts SeekHead positions past Info', () => {
    // SeekHead with two Seek entries: one to Info (position 0x1B rel. to segment data), one to the Cluster.
    const seek = (idBytes: number[], pos: number) => [0x4d, 0xbb, 0x80 | (idBytes.length + 7), 0x53, 0xab, 0x80 | idBytes.length, ...idBytes, 0x53, 0xac, 0x81, pos];
    const seekInfo = seek([0x15, 0x49, 0xa9, 0x66], 0);
    const seekCluster = seek([0x1f, 0x43, 0xb6, 0x75], 0);
    const seekHeadLen = seekInfo.length + seekCluster.length;
    const seekHeadTotal = 4 + 1 + seekHeadLen;
    const infoPos = seekHeadTotal;
    const clusterPos = infoPos + INFO_NO_DURATION.length;
    seekInfo[seekInfo.length - 1] = infoPos;
    seekCluster[seekCluster.length - 1] = clusterPos;
    const seekHead = [0x11, 0x4d, 0x9b, 0x74, 0x80 | seekHeadLen, ...seekInfo, ...seekCluster];
    const segData = [...seekHead, ...INFO_NO_DURATION, ...CLUSTER];
    const input = bytes(EBML_HEADER, [0x18, 0x53, 0x80, 0x67], [0x80 | segData.length], segData);
    const out = new Uint8Array(patchWebmDuration(input, 1500));
    expect(readWebmDuration(out).durationMs).toBe(1500);
    const seg = readEbmlChildren(out, 0, out.length).find((e) => e.id === EBML_ID.Segment)!;
    expect(seg.size).toBe(segData.length + 11);
    const [sh, info, cluster] = readEbmlChildren(out, seg.dataStart, seg.dataEnd);
    expect(sh.id).toBe(EBML_ID.SeekHead);
    expect(info.id).toBe(EBML_ID.Info);
    expect(cluster.id).toBe(EBML_ID.Cluster);
    const positions: number[] = [];
    for (const s of readEbmlChildren(out, sh.dataStart, sh.dataEnd)) {
      for (const e of readEbmlChildren(out, s.dataStart, s.dataEnd)) if (e.id === EBML_ID.SeekPosition) positions.push(out[e.dataStart]);
    }
    expect(positions).toEqual([infoPos, clusterPos + 11]);
    expect(info.start - seg.dataStart).toBe(infoPos);
    expect(cluster.start - seg.dataStart).toBe(clusterPos + 11);
  });

  it('returns a copy of non-WebM input unchanged', () => {
    const input = Uint8Array.from([1, 2, 3, 4]);
    const out = new Uint8Array(patchWebmDuration(input, 100));
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    const el = readEbmlElement(bytes(EBML_HEADER), 0);
    expect(el.id).toBe(EBML_ID.EBML);
    expect(el.size).toBe(7);
  });
});
