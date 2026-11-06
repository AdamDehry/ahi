/* ============================================================
   stt-cartesia.ts — ported from the voice-mode simulator.

   STT provider: Cartesia ink-2 over the auto turn-detection WebSocket —
   wss://api.cartesia.ai/stt/turns/websocket. Native turn lifecycle:

     turn.start → turn.update (cumulative partials) → turn.eager_end /
     turn.resume → turn.end (final transcript for the turn).

   Model-driven end-of-thought instead of dumb silence-VAD, at 0.6–1.4s.
   Latency is the whole point — this is the default inside voice mode; the
   Google path in `stt.ts` stays as the configured fallback.

   English-only (ink-2), which matches the two-voice architecture this phase.

   GATEWAY ADAPTATION — the pre-open queue. In the sim the caller awaited
   `start()` before any audio existed. Here the PWA's PCM frames are already
   arriving on the gateway socket by the time `voice-start` is handled, so
   frames fed before the upstream socket opens would be silently dropped and
   the user would lose their first word or two. Frames are therefore queued
   until open (bounded — a connect that never completes must not grow without
   limit).

   BURN. ink-2 bills ~3 credits/sec of audio against a fixed Cartesia Pro
   pool (~900 credits of STT per 5-minute session). Every session writes a
   usage line, matching the TTS counters in voice-out.ts, so the first week of
   burn is observable and we can fall back if it is too hot.

   IDLE CLOSE (the mute bug, 2026-10-13). Cartesia closes an STT socket after
   3 minutes with no audio; any chunk, silence included, resets the clock.
   MUTE stops every frame (client and server both drop them), so a mute longer
   than 3 minutes let the socket die, and the close handler used to just go
   quiet: every word after unmute was fed into a dead stream. Two fixes, both
   here and in stt-select.ts:
     - KEEPALIVE. When nothing has gone upstream for KEEPALIVE_IDLE_MS, send
       100 ms of digital silence. Billed as audio, so 0.2 s a minute, about
       0.6 credits a minute of mute. Streaming silence continuously would hold
       the socket too, at 3 credits a second; closing on mute and reopening on
       unmute would cost nothing while muted but pays a reconnect (and can lose
       the first word) on every mute tap. The trickle is the cheap middle.
       Zeros are not the room: nothing captured while muted is ever sent.
     - CLOSE IS NEVER SILENT. A close we did not ask for is logged and reported
       through onClose; the wrapper in stt-select.ts reopens.
   ============================================================ */

import { appendFile, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { gatewayStateRoot } from "../multi-user-paths.js";

const STT_URL = "wss://api.cartesia.ai/stt/turns/websocket";
const CARTESIA_VERSION = "2026-03-01";
// Spend ledger — moves with the state root so an isolated instance bills its
// own credits into its own sandbox instead of production's accounting.
const STT_USAGE_DIR = resolve(gatewayStateRoot(), "voice-usage");
const STT_USAGE_LOG = resolve(STT_USAGE_DIR, "stt-cartesia.jsonl");

/**
 * ink-2 bills per second of audio streamed, not per character returned.
 * The owner's pool is 100k credits; at this rate a 5-minute session is ~900.
 */
export const INK2_CREDITS_PER_AUDIO_SEC = 3;

/** How long to wait for the upstream socket before giving up and falling back. */
const OPEN_TIMEOUT_MS = 4000;

/**
 * Cap on audio buffered before the socket opens. 16kHz s16le = 32kB/sec, so
 * this is ~4 seconds — comfortably past OPEN_TIMEOUT_MS.
 */
const MAX_PENDING_BYTES = 128 * 1024;

/**
 * Send a keepalive once nothing has gone upstream for this long. Cartesia's
 * idle close is 3 minutes; 30 s leaves a wide margin for a slow event loop.
 */
const KEEPALIVE_IDLE_MS = 30_000;
/** 100 ms of 16 kHz s16le silence. */
const KEEPALIVE_SILENCE_MS = 100;

// ── Test seam ─────────────────────────────────────────────────────────
// The upstream URL and keepalive clock, overridable only from a test so a
// fake Cartesia server with a scaled-down idle close can stand in for the
// real one. Null (production) leaves the constants above in force.
let testOverrides: { url?: string; keepAliveIdleMs?: number } | null = null;

/** TEST ONLY. */
export function __setCartesiaSttOverridesForTests(o: { url?: string; keepAliveIdleMs?: number } | null): void {
  testOverrides = o;
}

export interface CartesiaSttOptions {
  model?: string;
  sampleRate?: number;
  turnEndTimeoutMs?: number;
  apiKey?: string;
}

export interface CartesiaTurnMeta {
  sttMs: number;
  turnDurMs: number;
  nativeTurnEnd: true;
}

export interface CartesiaSttCallbacks {
  /** A turn opened upstream — speech onset. */
  onSpeechStart?: () => void;
  /** The turn closed. Mirrors the VAD "end" event on the other paths. */
  onSpeechEnd?: () => void;
  /** Cumulative provisional transcript for the open turn. */
  onPartial?: (text: string) => void;
  /** Final transcript for one closed turn. */
  onTurnEnd?: (text: string, meta: CartesiaTurnMeta) => void;
  onError?: (err: Error) => void;
  /** The upstream socket closed without stop() asking it to. */
  onClose?: (code: number, reason: string) => void;
}

export interface SttUsage {
  audioSec: number;
  credits: number;
  turns: number;
}

export class CartesiaStt {
  private readonly model: string;
  private readonly sampleRate: number;
  private readonly turnEndTimeoutMs: number;
  private readonly apiKey: string | undefined;

  private ws: WebSocket | null = null;
  private active = false;
  private opened = false;
  private turnStartedAt = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private bytesFed = 0;
  private turns = 0;
  private lastSentAt = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private keepAlives = 0;

  onSpeechStart: () => void = () => {};
  onSpeechEnd: () => void = () => {};
  onPartial: (text: string) => void = () => {};
  onTurnEnd: (text: string, meta: CartesiaTurnMeta) => void = () => {};
  onError: (err: Error) => void = () => {};
  onClose: (code: number, reason: string) => void = () => {};

  constructor({
    model = "ink-2",
    sampleRate = 16000,
    turnEndTimeoutMs = 3000,
    apiKey = process.env.CARTESIA_API_KEY,
  }: CartesiaSttOptions = {}) {
    this.model = model;
    this.sampleRate = sampleRate;
    this.turnEndTimeoutMs = turnEndTimeoutMs;
    this.apiKey = apiKey;
  }

  get name(): string {
    return `cartesia/${this.model}`;
  }

  get supportsPartials(): boolean {
    return true;
  }

  get inFlight(): boolean {
    return this.active;
  }

  /** Audio streamed so far, and what it cost. Safe to read at any time. */
  get usage(): SttUsage {
    const audioSec = this.bytesFed / (this.sampleRate * 2);
    return {
      audioSec: Number(audioSec.toFixed(2)),
      credits: Math.round(audioSec * INK2_CREDITS_PER_AUDIO_SEC),
      turns: this.turns,
    };
  }

  async start(): Promise<void> {
    if (!this.apiKey) throw new Error("[stt-cartesia] No CARTESIA_API_KEY set");

    const params = new URLSearchParams({
      model: this.model,
      encoding: "pcm_s16le",
      sample_rate: String(this.sampleRate),
      cartesia_version: CARTESIA_VERSION,
      turn_end_timeout_ms: String(this.turnEndTimeoutMs),
    });
    const ws = new WebSocket(`${testOverrides?.url ?? STT_URL}?${params}`, {
      headers: { "X-API-Key": this.apiKey },
    });
    this.ws = ws;
    this.active = true;

    ws.on("message", (raw: WebSocket.RawData) => this.handleMessage(raw));
    ws.on("error", (err: Error) => {
      if (this.active) this.onError(err);
    });
    ws.on("close", (code: number, reasonBuf: Buffer) => {
      // stop() nulls this.ws before the close lands, so a close on the socket
      // we still hold is one nobody asked for. That used to be silent.
      // A socket that never opened is start()'s failure to report, not ours.
      const unexpected = this.ws === ws && this.active && this.opened;
      this.active = false;
      this.opened = false;
      this.clearKeepAlive();
      if (!unexpected) return;
      const reason = reasonBuf?.toString() || "";
      console.warn(
        `[stt-cartesia] upstream closed unexpectedly code=${code}` +
          `${reason ? ` reason=${JSON.stringify(reason.slice(0, 120))}` : ""}` +
          ` idle=${this.lastSentAt ? Date.now() - this.lastSentAt : 0}ms`,
      );
      this.onClose(code, reason);
    });

    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        rejectOpen(new Error("[stt-cartesia] timed out opening turn socket"));
      }, OPEN_TIMEOUT_MS);
      timer.unref?.();
      ws.once("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      ws.once("error", (err: Error) => {
        clearTimeout(timer);
        rejectOpen(err);
      });
    });

    this.opened = true;
    this.lastSentAt = Date.now();
    this.flushPending();
    this.armKeepAlive();
  }

  /** Keepalives sent so far (each is KEEPALIVE_SILENCE_MS of silence). */
  get keepAliveCount(): number {
    return this.keepAlives;
  }

  private armKeepAlive(): void {
    this.clearKeepAlive();
    const idleMs = testOverrides?.keepAliveIdleMs ?? KEEPALIVE_IDLE_MS;
    // Check at a quarter of the idle window: the worst case gap upstream is
    // then 1.25 x idleMs, still far inside Cartesia's 3 minutes.
    const timer = setInterval(() => {
      if (!this.opened || this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSentAt < idleMs) return;
      const silence = Buffer.alloc(((this.sampleRate * KEEPALIVE_SILENCE_MS) / 1000) * 2);
      this.send(silence);
      this.keepAlives += 1;
    }, Math.max(10, Math.floor(idleMs / 4)));
    timer.unref?.();
    this.keepAliveTimer = timer;
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private send(frame: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(frame);
    this.bytesFed += frame.length;
    this.lastSentAt = Date.now();
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const transcript = typeof msg.transcript === "string" ? msg.transcript : "";

    switch (msg.type) {
      case "turn.start":
        this.turnStartedAt = Date.now();
        this.onSpeechStart();
        break;
      case "turn.update":
      case "turn.eager_end":
        if (transcript) this.onPartial(transcript);
        break;
      case "turn.resume":
        // The model changed its mind about the turn ending — the composer's
        // hold covers this, nothing to do here.
        break;
      case "turn.end": {
        this.onSpeechEnd();
        const text = transcript.trim();
        if (text) {
          this.turns += 1;
          // sttMs here = detection latency after the turn closed, effectively
          // ~0 by arrival; report time-since-turn-start for context instead.
          this.onTurnEnd(text, {
            sttMs: 0,
            turnDurMs: Date.now() - this.turnStartedAt,
            nativeTurnEnd: true,
          });
        }
        break;
      }
      case "error":
        this.onError(
          new Error(`[stt-cartesia] ${msg.title ?? ""} ${msg.message ?? ""}`.trim()),
        );
        break;
    }
  }

  /** Feed one raw s16le frame. Safe before the socket opens (queued). */
  feed(frame: Buffer): void {
    if (!this.active) return;

    if (!this.opened) {
      // Drop the OLDEST audio if a stalled connect overruns the cap — losing
      // the head of a queue we are about to abandon is better than growing
      // without bound.
      this.pending.push(frame);
      this.pendingBytes += frame.length;
      while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
        const dropped = this.pending.shift();
        this.pendingBytes -= dropped?.length ?? 0;
      }
      return;
    }

    this.send(frame);
  }

  private flushPending(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const frame of this.pending) this.send(frame);
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** Close the upstream socket and write the session's usage line. */
  async stop(agent = "unknown"): Promise<SttUsage> {
    const usage = this.usage;
    this.active = false;
    this.opened = false;
    this.clearKeepAlive();
    this.pending = [];
    this.pendingBytes = 0;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "close" }));
        this.ws.close();
      }
    } catch {
      /* noop */
    }
    this.ws = null;
    if (usage.audioSec > 0) logSttUsage(agent, usage, this.model);
    return usage;
  }
}

/**
 * Credit counter — ink-2 bills per second of audio against a fixed pool, so
 * every voice session that used it gets a line. Fire-and-forget: nothing here
 * may fail a turn.
 */
function logSttUsage(agent: string, usage: SttUsage, model: string): void {
  try {
    mkdirSync(STT_USAGE_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agent,
      audioSec: usage.audioSec,
      credits: usage.credits,
      turns: usage.turns,
      model,
    });
    appendFile(STT_USAGE_LOG, line + "\n", (err) => {
      if (err) console.warn(`[stt-cartesia] usage log write failed: ${err.message}`);
    });
  } catch (err) {
    console.warn(`[stt-cartesia] usage log failed: ${(err as Error).message}`);
  }
}
