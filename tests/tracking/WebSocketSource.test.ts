import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoseFrame } from '../../src/core/types';
import type { SourceStatus } from '../../src/tracking/PoseSource';
import { WS_DEFAULT_GAP_MS, WS_RECONNECT_MAX_MS, WS_RECONNECT_MIN_MS, WebSocketSource } from '../../src/tracking/WebSocketSource';
import { makePoseFrame } from './fixtures';

/** Minimal stand-in for the browser WebSocket: records instances, lets tests fire the handlers. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static throwOnConstruct = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { reason: string }) => void) | null = null;
  closed = false;
  constructor(public readonly url: string) {
    if (FakeWebSocket.throwOnConstruct) throw new SyntaxError('bad url');
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  send(text: string): void {
    this.onmessage?.({ data: text });
  }
  drop(reason = ''): void {
    this.onclose?.({ reason });
  }
}

function msg(t: number): string {
  return JSON.stringify(makePoseFrame(t));
}

describe('WebSocketSource', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.throwOnConstruct = false;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('handleText validates, stamps `now` locally and keeps the provider spacing within a session', () => {
    const src = new WebSocketSource('ws://localhost:8765');
    const frames: PoseFrame[] = [];
    src.onFrame((f) => frames.push(f));
    src.handleText('garbage');
    src.handleText(JSON.stringify({ v: 1 }));
    expect(src.invalidMessages).toBe(2);
    src.handleText(JSON.stringify({ ...makePoseFrame(1000), now: 5 }));
    src.handleText(msg(1033));
    src.handleText(msg(1099));
    expect(frames.map((f) => f.t)).toEqual([1000, 1033, 1099]);
    expect(frames[0].now).not.toBe(5);
    expect(frames.every((f) => Number.isFinite(f.now))).toBe(true);
  });

  it('re-bases once on reconnect: two sessions of timestamps become one monotonic stream', async () => {
    const src = new WebSocketSource('ws://localhost:8765');
    const frames: PoseFrame[] = [];
    src.onFrame((f) => frames.push(f));
    await src.start();
    const s1 = FakeWebSocket.instances[0];
    expect(s1.url).toBe('ws://localhost:8765');
    expect(src.status.state).toBe('starting');
    s1.open();
    expect(src.status.state).toBe('running');
    s1.send(msg(1000));
    s1.send(msg(1033));
    s1.send(msg(1066));
    // The provider restarts: its clock begins again near zero.
    s1.drop('restart');
    expect(src.status.state).toBe('error');
    expect(src.status.message).toMatch(/reconnecting in 0\.5 s/);
    vi.advanceTimersByTime(WS_RECONNECT_MIN_MS);
    const s2 = FakeWebSocket.instances[1];
    expect(s2).toBeDefined();
    s2.open();
    s2.send(msg(5));
    s2.send(msg(38));
    s2.send(msg(71));
    // Offset re-base: continues one observed gap (33 ms) after the last frame, spacing preserved.
    expect(frames.map((f) => f.t)).toEqual([1000, 1033, 1066, 1099, 1132, 1165]);
    // A backwards jump inside a session also re-bases (monotonic guarantee) using the last spacing.
    s2.send(msg(10));
    expect(frames[6].t).toBe(1198);
    s2.send(msg(43));
    expect(frames[7].t).toBe(1231);
    src.stop();
    expect(s2.closed).toBe(true);
    expect(src.status.state).toBe('stopped');
  });

  it('a first session with no observed spacing continues with the default gap after reconnect', async () => {
    const src = new WebSocketSource('ws://x');
    const frames: PoseFrame[] = [];
    src.onFrame((f) => frames.push(f));
    await src.start();
    const s1 = FakeWebSocket.instances[0];
    s1.open();
    s1.send(msg(500));
    s1.drop();
    vi.advanceTimersByTime(WS_RECONNECT_MIN_MS);
    const s2 = FakeWebSocket.instances[1];
    s2.open();
    s2.send(msg(0));
    expect(frames.map((f) => f.t)).toEqual([500, 500 + WS_DEFAULT_GAP_MS]);
  });

  it('schedules reconnects with exponential backoff, resets it on open and stops cleanly', async () => {
    const src = new WebSocketSource('ws://x');
    const statuses: SourceStatus[] = [];
    src.onStatus((s) => statuses.push(s));
    await src.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].drop();
    vi.advanceTimersByTime(WS_RECONNECT_MIN_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // Never opened: the next delay doubles.
    FakeWebSocket.instances[1].drop();
    vi.advanceTimersByTime(2 * WS_RECONNECT_MIN_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.instances[2].drop();
    vi.advanceTimersByTime(4 * WS_RECONNECT_MIN_MS);
    expect(FakeWebSocket.instances).toHaveLength(4);
    // A successful open resets the backoff to the minimum.
    FakeWebSocket.instances[3].open();
    FakeWebSocket.instances[3].drop();
    vi.advanceTimersByTime(WS_RECONNECT_MIN_MS);
    expect(FakeWebSocket.instances).toHaveLength(5);
    // The backoff is capped.
    for (let i = 0; i < 10; i++) {
      FakeWebSocket.instances[FakeWebSocket.instances.length - 1].drop();
      vi.advanceTimersByTime(WS_RECONNECT_MAX_MS);
    }
    expect(FakeWebSocket.instances).toHaveLength(15);
    // stop() cancels the pending reconnect and detaches the socket.
    FakeWebSocket.instances[14].drop();
    src.stop();
    vi.advanceTimersByTime(WS_RECONNECT_MAX_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(15);
    expect(src.status.state).toBe('stopped');
    expect(statuses.some((s) => s.state === 'error')).toBe(true);
  });

  it('a stale socket cannot deliver frames after stop() or after being replaced', async () => {
    const src = new WebSocketSource('ws://x');
    const frames: PoseFrame[] = [];
    src.onFrame((f) => frames.push(f));
    await src.start();
    const s1 = FakeWebSocket.instances[0];
    s1.open();
    s1.send(msg(1));
    src.stop();
    s1.send(msg(2));
    expect(frames).toHaveLength(1);
    // Restart: a new socket; the old one's handlers were detached.
    await src.start();
    expect(s1.onmessage).toBeNull();
    const s2 = FakeWebSocket.instances[1];
    s2.open();
    s2.send(msg(3));
    expect(frames).toHaveLength(2);
    src.stop();
  });

  it('reports an invalid URL and keeps retrying', async () => {
    FakeWebSocket.throwOnConstruct = true;
    const src = new WebSocketSource('nonsense');
    await src.start();
    expect(src.status.state).toBe('error');
    expect(src.status.message).toMatch(/Invalid WebSocket URL/);
    FakeWebSocket.throwOnConstruct = false;
    vi.advanceTimersByTime(WS_RECONNECT_MIN_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
    src.stop();
  });

  it('start() throws when WebSocket is unavailable', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const src = new WebSocketSource('ws://x');
    await expect(src.start()).rejects.toThrow(/not available/);
    expect(src.status.state).toBe('error');
  });
});
