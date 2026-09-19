/**
 * PoseSource that receives PoseFrame v2 JSON messages over a WebSocket, e.g.
 * from the optional Python provider (backend/stream_pose.py). Reconnects with
 * exponential backoff until stopped. Only `start()` touches the WebSocket
 * API, so the module (and `parsePoseFrame`) loads in Node.
 */
import type { PoseFrame } from '../core/types';
import { BaseSource } from './PoseSource';
import { parsePoseFrameText } from './protocol';

/** Parse one JSON text message into a validated PoseFrame v2, or null. */
export function parsePoseFrame(text: string): PoseFrame | null {
  return parsePoseFrameText(text);
}

export const WS_RECONNECT_MIN_MS = 500;
export const WS_RECONNECT_MAX_MS = 10_000;

export class WebSocketSource extends BaseSource {
  readonly kind = 'websocket' as const;

  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = WS_RECONNECT_MIN_MS;
  private active = false;
  private lastT = -Infinity;
  private invalidCount = 0;

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
    this.lastT = -Infinity;
    this.invalidCount = 0;
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

  private handleText(text: string): void {
    const frame = parsePoseFrame(text);
    if (!frame) {
      this.invalidCount++;
      return;
    }
    // Enforce a monotonic timestamp per source (the filter relies on it).
    if (frame.t <= this.lastT) frame.t = this.lastT + 1;
    this.lastT = frame.t;
    this.emitFrame(frame);
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
