/**
 * PoseSource that receives PoseFrame v2 JSON messages over a WebSocket, e.g.
 * from the optional Python provider (backend/stream_pose.py). Reconnects with
 * exponential backoff until stopped. Only `start()` touches the WebSocket
 * API, so the module (and `parsePoseFrame`) loads in Node.
 *
 * Timestamps: the provider's `t` is re-based by an offset so the emitted
 * stream stays monotonic across reconnects and provider restarts while the
 * provider's own inter-frame spacing is preserved. `now` is stamped locally at
 * receipt (the provider's clock is not comparable with performance.now()).
 */
import type { PoseFrame } from '../core/types';
import { BaseSource } from './PoseSource';
import { parsePoseFrameText } from './protocol';

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Parse one JSON text message into a validated PoseFrame v2, or null. */
export function parsePoseFrame(text: string): PoseFrame | null {
  return parsePoseFrameText(text);
}

export const WS_RECONNECT_MIN_MS = 500;
export const WS_RECONNECT_MAX_MS = 10_000;
/** Inter-frame spacing assumed until the provider's own spacing has been observed (ms). */
export const WS_DEFAULT_GAP_MS = 1000 / 30;
/** Raw gaps above this (ms) are treated as a stall, not as the provider's spacing. */
const MAX_PLAUSIBLE_GAP_MS = 1000;

export class WebSocketSource extends BaseSource {
  readonly kind = 'websocket' as const;

  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = WS_RECONNECT_MIN_MS;
  private active = false;
  private invalidCount = 0;

  /** Added to the provider's `t` to keep the emitted stream monotonic. */
  private tOffset = 0;
  /** Last emitted `t`, NaN before the first frame. */
  private lastOut = NaN;
  /** Last raw provider `t`, NaN before the first frame of a session. */
  private lastRaw = NaN;
  /** Provider inter-frame spacing as last observed (ms). */
  private gapMs = WS_DEFAULT_GAP_MS;
  /** Set on (re)connect: the next frame continues one gap after the last emitted one. */
  private rebasePending = false;

  constructor(public readonly url: string) {
    super();
  }

  /** Number of messages rejected by validation since start(). */
  get invalidMessages(): number {
    return this.invalidCount;
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (typeof WebSocket === 'undefined') {
      this.setStatus({ state: 'error', message: 'WebSocket is not available in this environment' });
      throw new Error('WebSocket is not available in this environment');
    }
    this.active = true;
    this.backoffMs = WS_RECONNECT_MIN_MS;
    this.invalidCount = 0;
    this.tOffset = 0;
    this.lastOut = NaN;
    this.lastRaw = NaN;
    this.gapMs = WS_DEFAULT_GAP_MS;
    this.rebasePending = false;
    this.connect();
  }

  stop(): void {
    this.active = false;
    this.clearTimer();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      try {
        s.close();
      } catch {
        // ignore
      }
    }
    this.setStatus({ state: 'stopped' });
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(): void {
    if (!this.active) return;
    this.setStatus({ state: 'starting', message: `Connecting to ${this.url}` });
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.setStatus({ state: 'error', message: `Invalid WebSocket URL: ${err instanceof Error ? err.message : String(err)}` });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.backoffMs = WS_RECONNECT_MIN_MS;
      this.rebasePending = true;
      this.lastRaw = NaN;
      this.setStatus({ state: 'running', message: `Connected to ${this.url}` });
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (this.socket !== socket) return;
      const data: unknown = ev.data;
      if (typeof data === 'string') {
        this.handleText(data);
      } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data.text().then((text) => {
          if (this.socket === socket) this.handleText(text);
        }).catch(() => {
          this.invalidCount++;
        });
      } else if (data instanceof ArrayBuffer) {
        this.handleText(new TextDecoder().decode(data));
      } else {
        this.invalidCount++;
      }
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.setStatus({ state: 'error', message: `WebSocket error on ${this.url}` });
    };
    socket.onclose = (ev: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.active) return;
      const reason = ev.reason ? ` (${ev.reason})` : '';
      this.setStatus({ state: 'error', message: `Disconnected${reason}; reconnecting in ${(this.backoffMs / 1000).toFixed(1)} s` });
      this.scheduleReconnect();
    };
  }

  /** Parse one text message and emit it with a re-based, monotonic timestamp. Exposed for tests. */
  handleText(text: string): void {
    const frame = parsePoseFrame(text);
    if (!frame) {
      this.invalidCount++;
      return;
    }
    frame.t = this.rebase(frame.t);
    frame.now = nowMs();
    this.emitFrame(frame);
  }

  /**
   * Offset re-base: within a session the provider's spacing is kept verbatim;
   * on reconnect, or whenever the provider's clock jumps backwards, the offset
   * is recomputed once so the stream continues one observed gap after the last
   * emitted frame.
   */
  private rebase(rawT: number): number {
    if (!Number.isNaN(this.lastRaw)) {
      const g = rawT - this.lastRaw;
      if (g > 0 && g <= MAX_PLAUSIBLE_GAP_MS) this.gapMs = g;
    }
    this.lastRaw = rawT;
    if (Number.isNaN(this.lastOut)) {
      this.rebasePending = false;
      this.tOffset = 0;
    } else if (this.rebasePending || rawT + this.tOffset <= this.lastOut) {
      this.rebasePending = false;
      this.tOffset = this.lastOut + this.gapMs - rawT;
    }
    const out = rawT + this.tOffset;
    this.lastOut = out;
    return out;
  }

  private scheduleReconnect(): void {
    if (!this.active) return;
    this.clearTimer();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, WS_RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
