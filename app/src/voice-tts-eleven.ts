import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { ElevenConfig } from "./config.js";
import type { CallTtsStream, VoiceTtsStreamHandlers, WordTimestamps } from "./voice-tts-stream.js";

/* ============================================================
   voice-tts-eleven.ts — VOICE MODE streaming TTS in the voice-note voice.

   One Michael (the owner, 2026-10-13): a call speaks in the same voice as his
   voice notes. Notes are ElevenLabs (Daniel) over REST → OGG in voice-out.ts
   and stay exactly that. This is the call's plumbing for the same voice:
   ElevenLabs' `stream-input` WebSocket, text in as it generates, raw PCM out
   as it renders. Same voice id (the shared `resolveElevenVoiceId` lookup),
   separate pipeline — the per-mode split in voice-tts-stream.ts still holds.

   ── Why one socket per TURN, not per call ────────────────────────────────
   `stream-input` is one utterance per socket: an empty text closes it. The
   socket for a turn is opened in `beginTurn`, which index.ts calls BEFORE
   the agent is invoked — so the handshake overlaps the model's think time
   and costs the listener nothing. `connect()` pre-opens the first one.

   ── Model ────────────────────────────────────────────────────────────────
   Notes use eleven_v3, which the streaming socket refuses (HTTP 400 at the
   handshake, measured 10/13). Calls use eleven_v4_turbo on the SAME voice id
   (the owner picked Daniel; Michael measured ~200 ms to first audio on the HTTP
   stream, half the credits of full v4, same v4 family as the notes). If the
   socket refuses a model — at the handshake or with an error before any
   audio — the stream drops to `fallbackModel` (eleven_flash_v2_5) for the
   rest of the call, replays the turn's text, and says so in the log.

   ── Sample rate ──────────────────────────────────────────────────────────
   PCM at 44.1 kHz is a Pro-tier output format on ElevenLabs. The PWA opens
   its call AudioContext at 44.1 kHz during the user's tap, and a different
   rate forces it to rebuild the context inside a socket handler (autoplay
   policy territory — see voicebus.ts). So we take 22.05 kHz, which every
   tier gets, and double it here: exactly 2×, linear interpolation.

   ── Word timings ─────────────────────────────────────────────────────────
   Each audio message carries a per-character `alignment`. Characters are
   folded into words (a word may straddle two messages) and emitted in the
   same {words,start,end} seconds shape Cartesia's word_timestamps use, so
   the karaoke clock does not know which provider spoke.
   ============================================================ */

const ELEVEN_WS_BASE = "wss://api.elevenlabs.io/v1/text-to-speech";
/** What we ask ElevenLabs for. Doubled to OUTPUT_SAMPLE_RATE on arrival. */
const SOURCE_SAMPLE_RATE = 22050;
export const ELEVEN_STREAM_SAMPLE_RATE = SOURCE_SAMPLE_RATE * 2;
/** Max idle seconds ElevenLabs allows; a tool-using turn can think a while. */
const INACTIVITY_TIMEOUT_S = 180;
export const ELEVEN_STREAM_MODEL_DEFAULT = "eleven_v4_turbo";
export const ELEVEN_STREAM_FALLBACK_MODEL_DEFAULT = "eleven_flash_v2_5";

export interface ElevenStreamConfig {
  eleven: ElevenConfig;
  /** Streaming model for calls (notes keep eleven.model). */
  model: string;
  /** Voice-id resolver — the SAME lookup voice notes use. */
  resolveVoiceId: (apiKey: string, eleven: ElevenConfig) => Promise<string>;
  /** Test seam: the done watchdog (ELEVEN_SOCKET_DONE_TIMEOUT_MS). */
  doneTimeoutMs?: number;
  /** Socket base URL. Defaults to ElevenLabs; a test points it at a local server. */
  wsBase?: string;
  /** Used for the rest of the call if the socket refuses `model`. */
  fallbackModel?: string;
}

/** Linear 2× upsample of s16le mono PCM. Pure. */
export function upsample2x(pcm: Buffer, carry: { last: number | null }): Buffer {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return Buffer.alloc(0);
  const out = Buffer.alloc(n * 4);
  let prev = carry.last ?? pcm.readInt16LE(0);
  for (let i = 0; i < n; i++) {
    const cur = pcm.readInt16LE(i * 2);
    // Midpoint between the previous sample and this one, then this one —
    // the carry keeps the seam between two network frames smooth too.
    out.writeInt16LE(Math.round((prev + cur) / 2), i * 4);
    out.writeInt16LE(cur, i * 4 + 2);
    prev = cur;
  }
  carry.last = prev;
  return out;
}

/** v3 audio tags ([dry], [pause]) mean nothing to a streaming model — it
 *  would read them aloud. Notes keep them; a call never needs them. */
export function stripAudioTags(text: string): string {
  return text.replace(/\[[a-z][a-z\s'-]{0,30}\]\s*/gi, "");
}

interface Alignment {
  chars?: string[];
  charStartTimesMs?: number[];
  charDurationsMs?: number[];
}

/**
 * Folds per-character alignment into word timings, across messages.
 *
 * `offsetMs` is how much audio this turn had already produced before the
 * message — ElevenLabs reports a message's character times relative to that
 * message's own audio. If a message's first time already sits at or past the
 * offset it is taken as absolute instead, so either convention lands right.
 */
/** How long a refused model sits out before the next turn tries it again. */
const FALLBACK_RETRY_MS = 30_000;

export class WordFolder {
  private word = "";
  private wordStart = 0;
  private wordEnd = 0;

  push(al: Alignment, offsetMs: number): WordTimestamps | null {
    const chars = al.chars ?? [];
    const starts = al.charStartTimesMs ?? [];
    const durs = al.charDurationsMs ?? [];
    if (!chars.length) return null;
    const absolute = offsetMs > 0 && (starts[0] ?? 0) >= offsetMs * 0.5;
    const base = absolute ? 0 : offsetMs;
    const out: WordTimestamps = { words: [], start: [], end: [] };
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const t0 = base + (starts[i] ?? 0);
      const t1 = t0 + (durs[i] ?? 0);
      if (/\s/.test(ch)) {
        this.emit(out);
        continue;
      }
      if (!this.word) this.wordStart = t0;
      this.word += ch;
      this.wordEnd = t1;
    }
    return out.words.length ? out : null;
  }

  /** End of the utterance: the last word has no trailing space. */
  flush(): WordTimestamps | null {
    const out: WordTimestamps = { words: [], start: [], end: [] };
    this.emit(out);
    return out.words.length ? out : null;
  }

  private emit(out: WordTimestamps): void {
    if (!this.word) return;
    out.words.push(this.word);
    out.start.push(this.wordStart / 1000);
    out.end.push(this.wordEnd / 1000);
    this.word = "";
  }
}

interface TurnSocket {
  /** Set when the handshake was refused: the status line, kept for the error handler. */
  refused?: string;
  contextId: string;
  ws: WebSocket;
  model: string;
  open: boolean;
  /** Any audio arrived — after that, a failure is an error, not a refusal. */
  heard: boolean;
  /** Every piece of this turn's text, in order — replayed if the model is refused. */
  pieces: string[];
  /** Text sent before the socket opened, in order. */
  queue: string[];
  ended: boolean;
  carry: { last: number | null };
  sourceBytes: number;
  words: WordFolder;
  /** Words already timed (released) this turn — where a handoff resumes. */
  wordsHeard: number;
  /** isFinal arrived, or the turn failed: nothing more is owed for it. */
  finished: boolean;
  /** Fires when the turn has ended but no completion came (B3). */
  watchdog?: NodeJS.Timeout;
}

/** After the turn's text is complete, how long the socket may go silent before the turn is failed. */
const DONE_TIMEOUT_MS_DEFAULT = 10_000;

/** `text` without its first `n` words. */
export function remainderAfterWords(text: string, n: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(Math.max(0, n)).join(" ");
}

/**
 * Same surface as the Cartesia `VoiceTtsStream`, so index.ts drives either
 * without knowing which is speaking.
 */
export class ElevenTtsStream implements CallTtsStream {
  readonly provider = "elevenlabs" as const;
  private handlers: VoiceTtsStreamHandlers = {};
  private voiceId: string | null = null;
  private apiKey: string | null = null;
  private current: TurnSocket | null = null;
  /** A socket opened ahead of the next turn so it starts warm. */
  private spare: TurnSocket | null = null;
  private closed = false;

  charsSent = 0;
  /** The model actually speaking (changes once if the socket refuses the first). */
  activeModel: string;
  /** Set when the socket refused the configured model: which one, and why. */
  fellBack: { from: string; reason: string } | null = null;
  /** When the fallback began. Not sticky: a later turn retries the configured model. */
  private fellBackAt = 0;

  constructor(private readonly cfg: ElevenStreamConfig) {
    this.activeModel = cfg.model;
  }

  get sampleRate(): number {
    return ELEVEN_STREAM_SAMPLE_RATE;
  }

  get ready(): boolean {
    return !this.closed && this.voiceId !== null && this.apiKey !== null;
  }

  on(handlers: VoiceTtsStreamHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  async connect(): Promise<void> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("[tts-eleven-stream] No ELEVENLABS_API_KEY set");
    this.apiKey = key;
    this.voiceId = await this.cfg.resolveVoiceId(key, this.cfg.eleven);
    if (!this.closed) this.spare = this.openSocket();
  }

  private url(model: string): string {
    const q = new URLSearchParams({
      model_id: model,
      output_format: `pcm_${SOURCE_SAMPLE_RATE}`,
      inactivity_timeout: String(INACTIVITY_TIMEOUT_S),
      sync_alignment: "true",
      // We already feed whole clauses (chunkForSpeech) — let it render each
      // one as it lands instead of waiting to fill its own buffer.
      auto_mode: "true",
    });
    return `${this.cfg.wsBase ?? ELEVEN_WS_BASE}/${this.voiceId}/stream-input?${q}`;
  }

  private openSocket(contextId = `turn-${randomUUID()}`): TurnSocket {
    // Retry the configured model once FALLBACK_RETRY_MS has passed; a fresh refusal falls back again.
    if (this.fellBack && this.activeModel !== this.cfg.model && Date.now() - this.fellBackAt >= FALLBACK_RETRY_MS) {
      console.warn(`[tts-eleven-stream] retrying ${this.cfg.model} after fallback (${this.fellBack.reason})`);
      this.activeModel = this.cfg.model;
      this.fellBack = null;
    }
    const model = this.activeModel;
    const ws = new WebSocket(this.url(model), { headers: { "xi-api-key": this.apiKey! } });
    const sock: TurnSocket = {
      contextId,
      ws,
      model,
      open: false,
      heard: false,
      pieces: [],
      queue: [],
      ended: false,
      carry: { last: null },
      sourceBytes: 0,
      words: new WordFolder(),
      wordsHeard: 0,
      finished: false,
    };
    ws.on("open", () => {
      sock.open = true;
      // The first message opens the utterance; a single space is the API's
      // documented "begin" text.
      ws.send(JSON.stringify({ text: " " }));
      for (const t of sock.queue) ws.send(JSON.stringify({ text: t }));
      sock.queue = [];
      if (sock.ended) ws.send(JSON.stringify({ text: "" }));
    });
    ws.on("message", (raw: Buffer) => this.onMessage(sock, raw));
    // Log WHY ElevenLabs refused (the body), then abort as ws would have.
    ws.on("unexpected-response", (_req, res) => {
      sock.refused = `Unexpected server response: ${res.statusCode}`;
      let body = "";
      const done = () => {
        console.warn(`[tts-eleven-stream] ${model} handshake ${res.statusCode} body: ${body.slice(0, 400) || "(empty)"}`);
        ws.terminate();
      };
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", done);
      res.on("error", done);
    });
    ws.on("error", (err: Error) => {
      const msg = sock.refused ?? err.message;
      // A refusal at the handshake ("Unexpected server response: 400") is
      // how the socket says it does not serve this model.
      if (!sock.open && /Unexpected server response: 4\d\d/.test(msg) && this.refuse(sock, msg)) return;
      this.fail(sock, err);
    });
    ws.on("close", () => {
      if (this.spare === sock) this.spare = null;
      // B3: the live turn's socket closing before its isFinal — cleanly or
      // not — is a failed turn, not a silent one. Previously nothing
      // propagated and the five-second settle timer masked it.
      this.fail(sock, new Error("[tts-eleven-stream] socket closed before the turn finished"));
    });
    return sock;
  }

  /**
   * The socket refused `sock.model` before any audio. Switch the whole call to
   * the fallback model, once, and put a fresh socket in this one's place —
   * same turn context, same text — so the turn still speaks. Returns false if
   * there is nothing to fall back to (the caller then reports the error).
   */
  private refuse(sock: TurnSocket, reason: string): boolean {
    const fallback = this.cfg.fallbackModel;
    if (!fallback || sock.model === fallback || sock.heard || this.closed) return false;
    if (this.activeModel !== fallback) {
      this.fellBack = { from: this.activeModel, reason: reason.slice(0, 160) };
      this.activeModel = fallback;
      this.fellBackAt = Date.now();
      console.warn(`[tts-eleven-stream] ${sock.model} refused on the streaming socket (${this.fellBack.reason}) — using ${fallback}, retrying ${sock.model} in ${FALLBACK_RETRY_MS / 1000}s`);
    }
    try {
      sock.ws.close();
    } catch {
      /* already closing */
    }
    if (this.spare === sock) {
      this.spare = this.openSocket();
      return true;
    }
    if (this.current === sock) {
      const next = this.openSocket(sock.contextId);
      next.queue = [...sock.pieces];
      next.pieces = [...sock.pieces];
      next.ended = sock.ended;
      this.current = next;
      return true;
    }
    return true; // a retired socket: nothing to replace
  }

  private onMessage(sock: TurnSocket, raw: Buffer): void {
    // Context guard, as in voice-tts-stream.ts: only the live turn's socket
    // may speak. A cancelled turn's late frames are dropped here.
    if (this.current !== sock) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (sock.finished) return;
    if (sock.ended) this.armWatchdog(sock);
    if (typeof msg.error === "string" || (msg.message && !msg.audio && msg.isFinal === undefined)) {
      const reason = String(msg.error ?? msg.message);
      if (!sock.heard && this.refuse(sock, reason)) return;
      this.fail(sock, new Error(`[tts-eleven-stream] ${reason}`));
      return;
    }
    if (typeof msg.audio === "string" && msg.audio.length) {
      sock.heard = true;
      const offsetMs = (sock.sourceBytes / 2 / SOURCE_SAMPLE_RATE) * 1000;
      const src = Buffer.from(msg.audio, "base64");
      sock.sourceBytes += src.length;
      const al = (msg.alignment ?? msg.normalizedAlignment) as Alignment | null | undefined;
      if (al) {
        const wt = sock.words.push(al, offsetMs);
        if (wt) {
          sock.wordsHeard += wt.words.length;
          this.handlers.onTimestamps?.(wt, sock.contextId);
        }
      }
      const pcm = upsample2x(src, sock.carry);
      if (pcm.length) this.handlers.onAudio?.(pcm, sock.contextId);
    }
    if (msg.isFinal === true) {
      sock.finished = true;
      if (sock.watchdog) clearTimeout(sock.watchdog);
      const tail = sock.words.flush();
      if (tail) this.handlers.onTimestamps?.(tail, sock.contextId);
      this.handlers.onDone?.(sock.contextId);
      try {
        sock.ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  beginTurn(): string {
    this.retire(this.current);
    const usable = this.spare && this.spare.ws.readyState <= WebSocket.OPEN ? this.spare : null;
    this.spare = null;
    this.current = usable ?? this.openSocket();
    this.charsSent = 0;
    return this.current.contextId;
  }

  speakPiece(text: string): void {
    const sock = this.current;
    if (!this.ready || !sock || sock.ended) return;
    const clean = stripAudioTags(text);
    if (!clean.trim()) return;
    // The API wants each piece to end in a space so words never fuse.
    const piece = /\s$/.test(clean) ? clean : `${clean} `;
    this.charsSent += piece.length;
    sock.pieces.push(piece);
    if (sock.open && sock.ws.readyState === WebSocket.OPEN) sock.ws.send(JSON.stringify({ text: piece }));
    else sock.queue.push(piece);
  }

  endTurn(): void {
    const sock = this.current;
    if (!sock || sock.ended) return;
    sock.ended = true;
    if (sock.open && sock.ws.readyState === WebSocket.OPEN) sock.ws.send(JSON.stringify({ text: "" }));
    this.armWatchdog(sock);
    // Warm the next turn's socket now, while this one drains.
    if (!this.closed && !this.spare) this.spare = this.openSocket();
  }

  cancel(): void {
    const sock = this.current;
    this.current = null;
    this.retire(sock);
  }

  close(): void {
    this.closed = true;
    this.retire(this.current);
    this.retire(this.spare);
    this.current = null;
    this.spare = null;
  }

  /** The turn's text is complete: completion must arrive, or the turn fails (B3). */
  private armWatchdog(sock: TurnSocket): void {
    if (sock.finished) return;
    if (sock.watchdog) clearTimeout(sock.watchdog);
    const ms = this.cfg.doneTimeoutMs ?? (Number(process.env.ELEVEN_SOCKET_DONE_TIMEOUT_MS) || DONE_TIMEOUT_MS_DEFAULT);
    sock.watchdog = setTimeout(() => this.fail(sock, new Error(`[tts-eleven-stream] no completion within ${ms} ms`)), ms);
    sock.watchdog.unref?.();
  }

  /**
   * The live turn cannot finish on this socket. Reported once: the error,
   * then the text it never spoke (`onFailed`), so a failover can speak it.
   * Nothing more is released for this turn afterwards.
   */
  private fail(sock: TurnSocket, err: Error): void {
    if (this.current !== sock || sock.finished) return;
    sock.finished = true;
    if (sock.watchdog) clearTimeout(sock.watchdog);
    this.handlers.onError?.(err);
    this.handlers.onFailed?.({
      contextId: sock.contextId,
      unspoken: remainderAfterWords(sock.pieces.join(""), sock.wordsHeard),
      reason: err.message,
    });
    this.retire(sock);
  }

  private retire(sock: TurnSocket | null): void {
    if (!sock) return;
    if (sock.watchdog) clearTimeout(sock.watchdog);
    try {
      sock.ws.close();
    } catch {
      /* already closing */
    }
  }
}
