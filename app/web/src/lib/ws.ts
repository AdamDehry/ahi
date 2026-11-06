import type { ServerEvent } from "./types";

export type ConnectionStatus = "connecting" | "open" | "closed";

interface WsClientOptions {
  onEvent: (ev: ServerEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  /**
   * Raw binary frame from the server — voice-mode TTS PCM. Optional so every
   * other consumer of this client is unaffected: with voice mode off, no
   * binary is ever sent and this is never called.
   */
  onBinary?: (data: ArrayBuffer | Blob) => void;
  /** The server closed with 1012 ("service restart") — a planned restart, not a drop. */
  onRestart?: () => void;
  /**
   * Reconnect urgently: a live voice call is waiting on this socket (the
   * gateway parks the call for a grace window; every second of backoff is a
   * second of silence). The ordinary chat path keeps its gentle backoff.
   */
  urgent?: () => boolean;
}

/** The gateway's answer to our ping, verbatim (websocket.ts, voice step 2). */
const PONG = '{"type":"pong"}';
/** How often the liveness tick runs, and how often a ping goes out. */
const TICK_MS = 5_000;
const PING_EVERY_MS = 15_000;
/**
 * A ping nothing has answered for this long, while a call is live, means
 * the socket is dead even if the browser has not noticed (a network that
 * vanished never sends a close on mobile). Measured from the PING, not from
 * the last frame: a hidden tab's timers can be slowed to once a minute, and
 * a slow tick must not read as a dead socket.
 */
export const DEAD_AFTER_MS = 10_000;

/**
 * WS client for wss://<host>/ui/ws. Auth rides on the ahi_token cookie
 * (same-origin via the Vite proxy). Reconnects with capped exponential
 * backoff; the server replays session + last-100 history on every
 * connect, so reconnects self-heal missed messages.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private opts: WsClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private stopped = false;
  /** Liveness (voice step 2): last frame in, the unanswered ping, and whether this gateway answers pings at all. */
  private lastInAt = 0;
  private pingAt = 0;
  private lastPingAt = 0;
  private pongSeen = false;
  private lifecycleBound = false;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    this.stopped = false;
    this.bindLifecycle();
    this.open();
  }

  /**
   * Ask the socket to prove it is alive now: a ping, and the same rule as the
   * tick. For the moments a dead socket is likely — the page coming back
   * from the background, the network changing, a reply that went quiet.
   */
  probe(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!this.pingAt || this.lastInAt >= this.pingAt) this.ping(ws);
  }

  private ping(ws: WebSocket): void {
    const t = Date.now();
    this.pingAt = t;
    this.lastPingAt = t;
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      /* the close handler reconnects */
    }
  }

  private bindLifecycle(): void {
    if (this.lifecycleBound) return;
    this.lifecycleBound = true;
    const doc = globalThis.document as Document | undefined;
    const win = globalThis.window as Window | undefined;
    if (doc && typeof doc.addEventListener === "function") {
      doc.addEventListener("visibilitychange", () => {
        if (doc.visibilityState === "visible" && this.opts.urgent?.()) this.probe();
      });
    }
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("online", () => {
        if (this.opts.urgent?.()) this.probe();
      });
    }
  }

  /**
   * Give up on a socket the browser still calls open: unhook it, close it
   * without waiting for a handshake a dead network will never finish, and
   * reconnect now — a live call claims itself back by id on the new one.
   */
  private abandon(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    try {
      ws.close(4000, "no pong");
    } catch {
      /* already gone */
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws === ws) this.ws = null;
    this.opts.onStatus("closed");
    if (!this.stopped) this.scheduleReconnect();
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.opts.onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ui/ws`);
    // Voice-mode TTS frames must land as ArrayBuffer, not Blob — a Blob would
    // force an async read per frame, which is exactly the wrong tax on the
    // audio hot path.
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.lastInAt = Date.now();
      this.pingAt = 0;
      this.lastPingAt = 0;
      this.pongSeen = false;
      this.opts.onStatus("open");
      // App-level keepalive: it keeps intermediaries (cloudflared) warm, and
      // since voice step 2 the gateway answers it — so a live call can tell
      // a dead socket from a quiet one. The rule applies only once this
      // gateway has answered a ping (an older one never would), and only
      // while a call is live: the chat path reconnects as it always did.
      this.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const t = Date.now();
        const unanswered = this.pingAt > 0 && this.lastInAt < this.pingAt;
        if (unanswered && this.pongSeen && this.opts.urgent?.() && t - this.pingAt >= DEAD_AFTER_MS) {
          this.abandon(ws);
          return;
        }
        // A gateway that never answered still gets the periodic keepalive it
        // always had; one that answers is pinged again only
        // once the last ping is answered, so its deadline is never reset.
        if ((!unanswered || !this.pongSeen) && t - this.lastPingAt >= PING_EVERY_MS) this.ping(ws);
      }, TICK_MS);
    };

    ws.onmessage = (e) => {
      this.lastInAt = Date.now();
      if (e.data === PONG) {
        this.pongSeen = true;
        return;
      }
      // Binary server→client is voice-mode TTS: raw PCM s16le frames of a
      // reply being spoken as it generates. It arrives on the same socket as
      // the JSON events and is handed straight to the audio path — decoding
      // or buffering it here would put latency back into the one payload
      // this whole path exists to make fast.
      if (typeof e.data !== "string") {
        this.opts.onBinary?.(e.data as ArrayBuffer | Blob);
        return;
      }
      try {
        this.opts.onEvent(JSON.parse(e.data));
      } catch {
        /* malformed frame — drop */
      }
    };

    ws.onclose = (e) => {
      if (e.code === 1012) this.opts.onRestart?.();
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.opts.onStatus("closed");
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.opts.urgent?.() ? Math.min(250 * 2 ** this.attempts, 3_000) : Math.min(1000 * 2 ** this.attempts, 15_000);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  /** Send a JSON control frame (ack, ping, voice-*). Silently
   *  dropped when the socket isn't open — acks are recovered by the
   *  server's replay-on-reconnect, so best-effort is correct here. */
  send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch {
        /* noop */
      }
    }
  }

  /** Send a binary frame — the voice channel's raw s16le PCM @16kHz
   *  (AUDIT.md §2.2). */
  sendBinary(data: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data);
      } catch {
        /* noop */
      }
    }
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
