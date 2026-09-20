import { describe, expect, it } from 'vitest';
import { timestamp, timestampedFilename } from '../../src/record/download';

describe('timestampedFilename', () => {
  it('formats a local timestamp and sanitizes the prefix', () => {
    const d = new Date(2026, 8, 19, 7, 5, 9); // local time
    expect(timestamp(d)).toBe('20260919-070509');
    expect(timestampedFilename('my take', 'bvh', d)).toBe('my_take-20260919-070509.bvh');
    expect(timestampedFilename('clip', '.glb', d)).toBe('clip-20260919-070509.glb');
    expect(timestampedFilename('///', 'json', d)).toBe('take-20260919-070509.json');
  });
});
