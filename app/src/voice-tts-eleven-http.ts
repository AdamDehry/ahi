import { randomUUID } from "node:crypto";
import type { ElevenConfig } from "./config.js";
import type { CallTtsStream, VoiceTtsStreamHandlers, WordTimestamps } from "./voice-tts-stream.js";
import { ElevenTtsStream, ELEVEN_STREAM_SAMPLE_RATE, stripAudioTags, upsample2x } from "./voice-tts-eleven.js";
import { formatSeamLine, PlayoutModel, type PieceReason } from "./voice/seam-log.js";

/* ============================================================
   voice-tts-eleven-http.ts — a call's voice on eleven_v4_turbo, one HTTP
   request per sentence.

   Why not the socket (10/13): ElevenLabs refuses the whole v4 family (and v3)
   on `stream-input` and `multi-stream-input` with a 400 at the handshake, so a
   socket call silently drops to flash v2.5 — and the owner hears the difference.
   v4_turbo IS served on the HTTP stream endpoints, ~200 ms to first audio. So
   each sentence the agent produces becomes its own POST to
   `/stream/with-timestamps`, raw PCM and per-character timings streamed back.

   ── Pipelining ───────────────────────────────────────────────────────────
   A sentence's request goes out the moment the sentence exists, up to
   MAX_IN_FLIGHT at once, so sentence N+1 renders while N plays. Audio is
   released strictly in order: a later sentence that finishes first waits in
   memory behind the one before it. Rendering is several times faster than
   speech, so after the first sentence the listener never waits on a gap.

   ── Fallback ─────────────────────────────────────────────────────────────
   A sentence that errors, or produces no audio within FIRST_AUDIO_TIMEOUT_MS,
   or stalls mid-stream, hands the REST of the turn — the unspoken remainder
   of that sentence, every later one, and whatever text is still to come — to
   the flash v2.5 `stream-input` socket (ElevenTtsStream, the path calls ran
   on until now). Its audio queues behind whatever v4 already rendered, so the
   turn still plays in order. A call whose turns fail twice stays on the
   socket for the rest of the call instead of paying the timeout again.

   ── Word timings ─────────────────────────────────────────────────────────
   Characters are folded into words and shifted by the audio already released
   this turn, in the same {words,start,end} seconds shape the socket paths
   emit, so karaoke never knows which path spoke.

   Every sentence logs the model that actually spoke it, and the turn logs a
   one-line summary — the proof the brief asks for lives in the gateway log.
   ============================================================ */

const ELEVEN_HTTP_BASE = "https://api.elevenlabs.io/v1";
/** What we ask for; doubled to ELEVEN_STREAM_SAMPLE_RATE on arrival (see voice-tts-eleven.ts). */
const SOURCE_SAMPLE_RATE = ELEVEN_STREAM_SAMPLE_RATE / 2;
const MAX_IN_FLIGHT = 2;
/** Sentence text before this one, sent as `previous_text` so prosody carries across requests. */
const PREVIOUS_TEXT_CHARS = 300;
/** Failed turns before the call stops trying v4 and stays on the socket. */
const STICKY_AFTER_FAILED_TURNS = 2;
/** While a turn waits on the model, keep the TLS connection to ElevenLabs warm this often. */
const KEEP_WARM_EVERY_MS = 3_000;
const KEEP_WARM_MAX = 20;
/**
 * Once a sentence's whole text has its audio (every character aligned), how
 * long its response may stay open before the sentence is finished anyway.
 * Later sentences are released only behind it, so a response that lingers
 * after its last audio holds them all (call-pauses diagnosis #4/#6).
 */
const COMPLETE_TIMEOUT_MS = 1_000;

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ElevenHttpStreamConfig {
  eleven: ElevenConfig;
  /** The call's model on the HTTP path (eleven_v4_turbo). */
  model: string;
  /** The socket model the rest of a turn drops to (eleven_flash_v2_5). */
  fallbackModel: string;
  resolveVoiceId: (apiKey: string, eleven: ElevenConfig) => Promise<string>;
  /** For log lines: which call this is. */
  label?: string;
  /** Test seams. */
  httpBase?: string;
  wsBase?: string;
  firstAudioTimeoutMs?: number;
  /** No NEW AUDIO for this long mid-sentence fails the sentence over. */
  stallTimeoutMs?: number;
  /** All text aligned, response still open this long: the sentence is finished. */
  completeTimeoutMs?: number;
  /** Send `previous_text` with each sentence. Default on; ELEVEN_HTTP_PREVIOUS_TEXT=off disables. */
  previousText?: boolean;
  keepWarm?: boolean;
}

interface CharAlignment {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
}

/**
 * Folds one request's per-character timings into words, in seconds from the
 * start of THAT request's audio.
 *
 * Whether a chunk's times count from the request's start or from the chunk's
 * own start isn't something to trust either way, so it is read off the data:
 * a chunk whose first character starts before the previous chunk's last one
 * ended must be chunk-relative, and is shifted by the audio already received
 * for this request.
 */
export class SentenceWordFolder {
  private word = "";
  private wordStart = 0;
  private wordEnd = 0;
  private lastEnd = 0;
  /** Characters folded so far — where a replay would resume. */
  consumedChars = 0;

  push(al: CharAlignment, audioBeforeSec: number): WordTimestamps | null {
    const chars = al.characters ?? [];
    const starts = al.character_start_times_seconds ?? [];
    const ends = al.character_end_times_seconds ?? [];
    if (!chars.length) return null;
    const relative = this.lastEnd > 0 && (starts[0] ?? 0) + 0.05 < this.lastEnd;
    const base = relative ? audioBeforeSec : 0;
    const out: WordTimestamps = { words: [], start: [], end: [] };
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const t0 = base + (starts[i] ?? 0);
      const t1 = base + (ends[i] ?? starts[i] ?? 0);
      this.consumedChars++;
      if (/\s/.test(ch)) {
        this.emit(out);
        continue;
      }
      if (!this.word) this.wordStart = t0;
      this.word += ch;
      this.wordEnd = t1;
    }
    this.lastEnd = Math.max(this.lastEnd, base + (ends[ends.length - 1] ?? 0));
    return out.words.length ? out : null;
  }

  flush(): WordTimestamps | null {
    const out: WordTimestamps = { words: [], start: [], end: [] };
    this.emit(out);
    return out.words.length ? out : null;
  }

  private emit(out: WordTimestamps): void {
    if (!this.word) return;
    out.words.push(this.word);
    out.start.push(round3(this.wordStart));
    out.end.push(round3(this.wordEnd));
    this.word = "";
  }
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Splits a byte stream of concatenated JSON objects — newline-delimited or
 * not — into whole objects. String-aware, so braces inside base64 or text
 * cannot cut an object short.
 */
export class JsonObjectSplitter {
  private buf = "";
  private depth = 0;
  private inString = false;
  private escaped = false;
  private start = -1;
  private scanned = 0;

  push(text: string): unknown[] {
    this.buf += text;
    const out: unknown[] = [];
    for (let i = this.scanned; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') this.inString = true;
      else if (c === "{") {
        if (this.depth === 0) this.start = i;
        this.depth++;
      } else if (c === "}") {
        this.depth--;
        if (this.depth === 0 && this.start >= 0) {
          try {
            out.push(JSON.parse(this.buf.slice(this.start, i + 1)));
          } catch {
            /* a malformed object is skipped, not fatal */
          }
          this.start = -1;
        }
      }
    }
    if (this.depth === 0) {
      this.buf = "";
      this.scanned = 0;
    } else {
      // Keep only the open object; rescan nothing already scanned.
      const keepFrom = Math.max(0, this.start);
      this.buf = this.buf.slice(keepFrom);
      this.start = this.start >= 0 ? 0 : -1;
      this.scanned = this.buf.length;
    }
    return out;
  }
}

/** One unit of the turn's ordered output: a v4 sentence, or the socket carrying the rest. */
interface Job {
  kind: "http" | "socket";
  index: number;
  text: string;
  model: string;
  /** Released to the listener already: audio frames and word batches, in order. */
  pending: Array<{ pcm?: Buffer; words?: WordTimestamps }>;
  audioSec: number;
  heard: boolean;
  done: boolean;
  failed: boolean;
  startedAt: number;
  firstAudioMs: number;
  controller?: AbortController;
  timer?: NodeJS.Timeout;
  folder?: SentenceWordFolder;
  carry: { last: number | null };
  started: boolean;
  /** Seam telemetry (voice/seam-log.ts): why the piece was cut, and when each stage happened. */
  why: PieceReason | "socket" | "unknown";
  readyAt: number;
  firstPcmAt: number;
  lastPcmAt: number;
  eofAt: number;
  releaseStartAt: number;
  gapMs: number;
  innerMs: number;
  /**
   * Characters of the ORIGINAL text with timings so far. Only `alignment`
   * counts: `normalized_alignment` spells numbers out ("3" → "three"), so it
   * can pass the text's length before the audio is all in.
   */
  alignedChars: number;
}

/** A job's seam-telemetry fields, all unset. */
const seamFields = (why: Job["why"], readyAt: number) => ({
  why,
  readyAt,
  firstPcmAt: 0,
  lastPcmAt: 0,
  eofAt: 0,
  releaseStartAt: 0,
  gapMs: 0,
  innerMs: 0,
  alignedChars: 0,
});

interface Turn {
  contextId: string;
  number: number;
  jobs: Job[];
  /** The job being released to the listener. */
  head: number;
  /** Seconds of audio released this turn before the head job — the words' shift. */
  releasedSec: number;
  headStartSec: number;
  ended: boolean;
  /** The socket job the rest of this turn rides on, once v4 failed. */
  socket: Job | null;
  socketContext: string | null;
  /** A v4 sentence failed this turn (counted once toward stickiness). */
  failed: boolean;
  spoken: string;
  doneSent: boolean;
  warmTimer?: NodeJS.Timeout;
  /**
   * Both v4 and the socket failed this turn (B3): the text never spoken, to
   * hand over through `onFailed` once everything before it is released.
   */
  handoff: { unspoken: string; reason: string; sent: boolean } | null;
  /** When the turn opened — the zero of its seam lines. */
  openedAt: number;
  /** The listener's playout as the server models it, for each seam's gap. */
  playout: PlayoutModel;
}

export class ElevenHttpTtsStream implements CallTtsStream {
  readonly provider = "elevenlabs" as const;
  private handlers: VoiceTtsStreamHandlers = {};
  private voiceId: string | null = null;
  private apiKey: string | null = null;
  private closed = false;
  private turn: Turn | null = null;
  private turnCount = 0;
  private failedTurns = 0;
  /** The flash socket path — the fallback, and the whole call once sticky. */
  private readonly socket: ElevenTtsStream;
  private socketReady = false;

  charsSent = 0;
  /** Per-turn proof: the model that spoke each sentence of the LAST turn, in order. */
  lastTurnModels: string[] = [];

  constructor(private readonly cfg: ElevenHttpStreamConfig) {
    this.socket = new ElevenTtsStream({
      eleven: cfg.eleven,
      model: cfg.fallbackModel,
      resolveVoiceId: cfg.resolveVoiceId,
      wsBase: cfg.wsBase,
    });
    this.socket.on({
      onAudio: (pcm, ctx) => this.onSocketAudio(pcm, ctx),
      onTimestamps: (wt, ctx) => this.onSocketWords(wt, ctx),
      onDone: (ctx) => this.onSocketDone(ctx),
      onError: (err) => this.onSocketError(err),
      onFailed: (f) => this.onSocketFailed(f),
    });
  }

  /** True once two turns have failed on v4: the call now speaks on the socket only. */
  get sticky(): boolean {
    return this.failedTurns >= STICKY_AFTER_FAILED_TURNS;
  }

  get activeModel(): string {
    return this.sticky ? this.cfg.fallbackModel : this.cfg.model;
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

  private get tag(): string {
    return `[tts-eleven-http]${this.cfg.label ? ` ${this.cfg.label}` : ""}`;
  }

  async connect(): Promise<void> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("[tts-eleven-http] No ELEVENLABS_API_KEY set");
    this.apiKey = key;
    this.voiceId = await this.cfg.resolveVoiceId(key, this.cfg.eleven);
    // The fallback socket comes up beside it, so a failed sentence does not
    // also pay a handshake. Its failure is not the call's failure.
    this.socket.connect().then(
      () => (this.socketReady = true),
      (err) => console.warn(`${this.tag} fallback socket unavailable: ${(err as Error).message}`),
    );
    this.keepWarm();
  }

  /**
   * A cheap authenticated GET, so the first sentence's POST rides an already
   * open TLS connection instead of paying the handshake. Fire-and-forget.
   */
  private keepWarm(): void {
    if (this.cfg.keepWarm === false || !this.apiKey || this.closed) return;
    void fetch(`${this.cfg.httpBase ?? ELEVEN_HTTP_BASE}/models`, {
      headers: { "xi-api-key": this.apiKey },
      signal: AbortSignal.timeout(3_000),
    })
      .then((r) => r.arrayBuffer())
      .catch(() => {});
  }

  beginTurn(): string {
    this.retireTurn();
    const t: Turn = {
      contextId: `turn-${randomUUID()}`,
      number: ++this.turnCount,
      jobs: [],
      head: 0,
      releasedSec: 0,
      headStartSec: 0,
      ended: false,
      socket: null,
      socketContext: null,
      failed: false,
      spoken: "",
      doneSent: false,
      handoff: null,
      openedAt: Date.now(),
      playout: new PlayoutModel(),
    };
    this.turn = t;
    this.charsSent = 0;
    this.lastTurnModels = [];
    if (this.sticky) this.toSocket(t, "", "call is on the fallback after repeated failures");
    else this.armKeepWarm(t);
    return t.contextId;
  }

  /** Until the first sentence goes out, keep the connection warm through the model's think time. */
  private armKeepWarm(t: Turn): void {
    if (this.cfg.keepWarm === false) return;
    this.keepWarm();
    let n = 0;
    t.warmTimer = setInterval(() => {
      if (this.turn !== t || t.jobs.length || ++n > KEEP_WARM_MAX) {
        clearInterval(t.warmTimer);
        return;
      }
      this.keepWarm();
    }, KEEP_WARM_EVERY_MS);
    t.warmTimer.unref?.();
  }

  speakPiece(text: string, why?: PieceReason): void {
    const t = this.turn;
    if (!this.ready || !t || t.ended) return;
    const clean = stripAudioTags(text).replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.charsSent += clean.length + 1;
    if (t.handoff) {
      // Nothing here can speak it: it rides the handoff (or, once that is
      // sent, the failover routes later pieces itself).
      if (!t.handoff.sent) t.handoff.unspoken = `${t.handoff.unspoken} ${clean}`.trim();
      return;
    }
    if (t.socket) {
      this.socket.speakPiece(clean);
      t.socket.text += `${clean} `;
      return;
    }
    if (t.warmTimer) clearInterval(t.warmTimer);
    const job: Job = {
      kind: "http",
      index: t.jobs.length,
      text: clean,
      model: this.cfg.model,
      pending: [],
      audioSec: 0,
      heard: false,
      done: false,
      failed: false,
      startedAt: 0,
      firstAudioMs: 0,
      carry: { last: null },
      started: false,
      ...seamFields(why ?? "unknown", Date.now()),
    };
    t.jobs.push(job);
    this.pump(t);
  }

  endTurn(): void {
    const t = this.turn;
    if (!t || t.ended) return;
    t.ended = true;
    if (t.warmTimer) clearInterval(t.warmTimer);
    if (t.socket) this.socket.endTurn();
    this.release(t);
  }

  cancel(): void {
    const t = this.turn;
    this.turn = null;
    if (t) this.abortTurn(t);
  }

  close(): void {
    this.closed = true;
    this.cancel();
    this.socket.close();
  }

  private retireTurn(): void {
    const t = this.turn;
    this.turn = null;
    if (t) this.abortTurn(t);
  }

  private abortTurn(t: Turn): void {
    if (t.warmTimer) clearInterval(t.warmTimer);
    for (const j of t.jobs) {
      if (j.timer) clearTimeout(j.timer);
      j.controller?.abort();
    }
    if (t.socket) this.socket.cancel();
  }

  /* ── v4 sentences ─────────────────────────────────────────────────── */

  private pump(t: Turn): void {
    if (t.socket) return;
    let inFlight = t.jobs.filter((j) => j.kind === "http" && j.started && !j.done).length;
    for (const j of t.jobs) {
      if (inFlight >= MAX_IN_FLIGHT) break;
      if (j.kind !== "http" || j.started) continue;
      inFlight++;
      void this.fetchSentence(t, j);
    }
  }

  private previousTextFor(t: Turn, j: Job): string {
    return t.jobs
      .slice(0, j.index)
      .map((x) => x.text)
      .join(" ")
      .slice(-PREVIOUS_TEXT_CHARS);
  }

  private async fetchSentence(t: Turn, j: Job): Promise<void> {
    j.started = true;
    j.startedAt = Date.now();
    j.controller = new AbortController();
    j.folder = new SentenceWordFolder();
    const firstAudioMs = this.cfg.firstAudioTimeoutMs ?? envMs("ELEVEN_HTTP_FIRST_AUDIO_TIMEOUT_MS", 2_500);
    const stallMs = this.cfg.stallTimeoutMs ?? envMs("ELEVEN_HTTP_STALL_TIMEOUT_MS", 3_000);
    const completeMs = this.cfg.completeTimeoutMs ?? envMs("ELEVEN_HTTP_COMPLETE_TIMEOUT_MS", COMPLETE_TIMEOUT_MS);
    const arm = (ms: number, why: string) => {
      if (j.timer) clearTimeout(j.timer);
      j.timer = setTimeout(() => {
        j.controller?.abort();
        this.failJob(t, j, why);
      }, ms);
      j.timer.unref?.();
    };
    arm(firstAudioMs, `no audio in ${firstAudioMs} ms`);
    // All of the text has audio: what is left is the end of the response.
    // Bounded on its own — finishing it early loses nothing and changes no
    // model, so it is a finish, not a failure.
    const armComplete = () => {
      if (j.timer) clearTimeout(j.timer);
      j.timer = setTimeout(() => {
        if (this.turn !== t || j.done || j.failed) return;
        console.warn(
          `${this.tag} t${t.number} s${j.index + 1} all audio in, response still open after ${completeMs} ms — finishing the sentence`,
        );
        j.controller?.abort();
        this.finishJob(t, j);
      }, completeMs);
      j.timer.unref?.();
    };

    const body: Record<string, unknown> = { text: j.text, model_id: j.model };
    const usePrevious = this.cfg.previousText ?? process.env.ELEVEN_HTTP_PREVIOUS_TEXT !== "off";
    const previous = usePrevious ? this.previousTextFor(t, j) : "";
    if (previous) body.previous_text = previous;
    const url =
      `${this.cfg.httpBase ?? ELEVEN_HTTP_BASE}/text-to-speech/${this.voiceId}/stream/with-timestamps` +
      `?output_format=pcm_${SOURCE_SAMPLE_RATE}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "xi-api-key": this.apiKey!, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: j.controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = (await res.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
        throw new Error(`http ${res.status}${detail ? ` ${detail}` : ""}`);
      }
      const splitter = new JsonObjectSplitter();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      let completing = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.turn !== t || j.failed || j.done) return;
        const audioBefore = j.audioSec;
        for (const obj of splitter.push(decoder.decode(value, { stream: true }))) {
          this.onSentenceChunk(t, j, obj as Record<string, unknown>);
        }
        // The stall watchdog is fed by AUDIO, not by bytes: metadata or a
        // half-received object used to re-arm it, so a response could keep
        // the voice starved indefinitely without ever failing over.
        const progressed = j.audioSec > audioBefore;
        if (j.heard && j.alignedChars >= j.text.length) {
          if (progressed || !completing) armComplete();
          completing = true;
        } else if (progressed) {
          arm(stallMs, `no new audio for ${stallMs} ms mid-sentence`);
        }
      }
      j.eofAt = Date.now();
      if (j.timer) clearTimeout(j.timer);
      if (this.turn !== t || j.failed || j.done) return;
      if (!j.heard) throw new Error("ended with no audio");
      this.finishJob(t, j);
    } catch (err) {
      if (j.timer) clearTimeout(j.timer);
      if (this.turn !== t || j.failed || j.done) return;
      this.failJob(t, j, (err as Error).message);
    }
  }

  /** A sentence's audio is all in: release it and start the next request. */
  private finishJob(t: Turn, j: Job): void {
    if (j.done || j.failed || this.turn !== t) return;
    if (j.timer) clearTimeout(j.timer);
    const tail = j.folder?.flush();
    if (tail) j.pending.push({ words: tail });
    j.done = true;
    console.log(
      `${this.tag} t${t.number} s${j.index + 1} ${j.model} first-audio=${j.firstAudioMs}ms ` +
        `audio=${j.audioSec.toFixed(2)}s chars=${j.text.length}`,
    );
    this.lastTurnModels[j.index] = j.model;
    this.release(t);
    this.pump(t);
  }

  private onSentenceChunk(t: Turn, j: Job, obj: Record<string, unknown>): void {
    const b64 = obj.audio_base64 ?? obj.audio;
    const al = (obj.alignment ?? obj.normalized_alignment) as CharAlignment | null | undefined;
    const audioBefore = j.audioSec;
    if (typeof b64 === "string" && b64.length) {
      const src = Buffer.from(b64, "base64");
      const now = Date.now();
      if (!j.heard) {
        j.firstAudioMs = now - j.startedAt;
        j.firstPcmAt = now;
      }
      j.lastPcmAt = now;
      j.heard = true;
      j.audioSec += Math.floor(src.length / 2) / SOURCE_SAMPLE_RATE;
      const pcm = upsample2x(src, j.carry);
      if (pcm.length) j.pending.push({ pcm });
    }
    const original = obj.alignment as CharAlignment | null | undefined;
    if (original?.characters) j.alignedChars += original.characters.length;
    if (al && j.folder) {
      const wt = j.folder.push(al, audioBefore);
      if (wt) j.pending.push({ words: wt });
    }
    this.release(t);
  }

  /**
   * A v4 sentence failed. The rest of the turn moves to the socket: the part
   * of this sentence not yet rendered, every later sentence, and any text
   * still to come. Already-rendered audio of this sentence is kept.
   */
  private failJob(t: Turn, j: Job, reason: string): void {
    if (j.failed || j.done || this.turn !== t) return;
    j.failed = true;
    j.done = true;
    // Everything after this sentence is re-routed in one piece — later v4
    // sentences AND a socket already carrying a later failure's text (two
    // sentences in flight can both fail). None of it has been heard: release
    // is strictly in order and this sentence was never finished.
    const later = t.jobs.filter((x) => x.index > j.index);
    for (const x of later) {
      // Discarded, not failed: its aborted fetch must not re-enter here.
      x.failed = true;
      x.done = true;
      if (x.timer) clearTimeout(x.timer);
      x.controller?.abort();
    }
    if (t.socket) {
      this.socket.cancel();
      t.socket = null;
      t.socketContext = null;
    }
    const unrendered = j.heard ? remainderAfter(j.text, j.folder?.consumedChars ?? 0) : j.text;
    if (j.heard) {
      const tail = j.folder?.flush();
      if (tail) j.pending.push({ words: tail });
    }
    const rest = [unrendered, ...later.map((x) => x.text)]
      .map((x) => x.trim())
      .filter(Boolean)
      .join(" ");
    t.jobs.length = j.index + 1;
    for (let i = j.index; i < this.lastTurnModels.length; i++) delete this.lastTurnModels[i];
    if (!t.failed) {
      t.failed = true;
      this.failedTurns++;
    }
    console.warn(
      `${this.tag} t${t.number} s${j.index + 1} ${j.model} FAILED (${reason.slice(0, 160)}) — ` +
        `the rest of the turn speaks on ${this.cfg.fallbackModel} over the socket` +
        (this.sticky ? "; the call stays there from now on" : ""),
    );
    this.toSocket(t, rest, reason);
    this.release(t);
  }

  /* ── the socket fallback ──────────────────────────────────────────── */

  private toSocket(t: Turn, text: string, reason: string): void {
    const job: Job = {
      kind: "socket",
      index: t.jobs.length,
      text: "",
      model: this.cfg.fallbackModel,
      pending: [],
      audioSec: 0,
      heard: false,
      done: false,
      failed: false,
      startedAt: Date.now(),
      firstAudioMs: 0,
      carry: { last: null },
      started: true,
      ...seamFields("socket", Date.now()),
    };
    t.jobs.push(job);
    t.socket = job;
    if (!this.socketReady && !this.socket.ready) {
      // No socket to fall to. The rest of the turn is handed over (B3) once
      // what v4 already rendered has been released; without a failover it is
      // text only, as before.
      console.warn(`${this.tag} t${t.number} no fallback socket (${reason.slice(0, 80)}) — handing the rest of this turn over`);
      job.done = true;
      t.handoff = { unspoken: text.trim(), reason, sent: false };
      this.handlers.onError?.(new Error(`${this.tag} ${reason}`));
      return;
    }
    t.socketContext = this.socket.beginTurn();
    if (text.trim()) {
      this.socket.speakPiece(text);
      job.text = `${text} `;
    }
    if (t.ended) this.socket.endTurn();
  }

  private onSocketAudio(pcm: Buffer, ctx: string): void {
    const t = this.turn;
    if (!t?.socket || ctx !== t.socketContext) return;
    const j = t.socket;
    const now = Date.now();
    if (!j.heard) {
      j.firstAudioMs = now - j.startedAt;
      j.firstPcmAt = now;
    }
    j.lastPcmAt = now;
    j.heard = true;
    j.audioSec += Math.floor(pcm.length / 2) / ELEVEN_STREAM_SAMPLE_RATE;
    j.pending.push({ pcm });
    this.release(t);
  }

  private onSocketWords(wt: WordTimestamps, ctx: string): void {
    const t = this.turn;
    if (!t?.socket || ctx !== t.socketContext) return;
    t.socket.pending.push({ words: wt });
    this.release(t);
  }

  private onSocketDone(ctx: string): void {
    const t = this.turn;
    if (!t?.socket || ctx !== t.socketContext) return;
    const j = t.socket;
    j.done = true;
    j.eofAt = Date.now();
    if (j.text.trim()) {
      this.lastTurnModels[j.index] = `${j.model}(socket)`;
      console.log(
        `${this.tag} t${t.number} s${j.index + 1}+ ${j.model} (socket) first-audio=${j.firstAudioMs}ms ` +
          `audio=${j.audioSec.toFixed(2)}s chars=${j.text.trim().length}`,
      );
    }
    this.release(t);
  }

  private onSocketError(err: Error): void {
    const t = this.turn;
    if (!t?.socket || t.socket.done) return;
    this.handlers.onError?.(err);
  }

  /** The socket carrying the rest of the turn failed too: hand over what it never spoke (B3). */
  private onSocketFailed(f: { contextId: string; unspoken: string; reason: string }): void {
    const t = this.turn;
    if (!t?.socket || f.contextId !== t.socketContext || t.socket.done) return;
    t.socket.done = true;
    t.handoff = { unspoken: f.unspoken.trim(), reason: f.reason, sent: false };
    console.warn(`${this.tag} t${t.number} fallback socket failed (${f.reason.slice(0, 80)}) — handing the rest of this turn over`);
    this.release(t);
  }

  /* ── ordered release ──────────────────────────────────────────────── */

  /**
   * Hand the listener everything that is next in order: the head job's
   * pending audio and words (words shifted to the turn's clock), then — once
   * the head is done — the next job. Ends the turn when the last one is.
   */
  private release(t: Turn): void {
    if (this.turn !== t) return;
    while (t.head < t.jobs.length) {
      const j = t.jobs[t.head];
      for (const item of j.pending) {
        if (item.pcm) {
          this.trackPlayout(t, j, item.pcm);
          this.handlers.onAudio?.(item.pcm, t.contextId);
        }
        if (item.words) {
          const shift = (xs: number[]) => xs.map((x) => round3(x + t.headStartSec));
          this.handlers.onTimestamps?.(
            { words: item.words.words, start: shift(item.words.start), end: shift(item.words.end) },
            t.contextId,
          );
        }
      }
      j.pending = [];
      if (!j.done) return;
      this.logSeam(t, j);
      t.headStartSec += j.audioSec;
      t.head++;
    }
    // Everything this stream will ever play for the turn is out: now the
    // unspoken rest may be handed to another voice, in order (B3).
    if (t.handoff && !t.handoff.sent) {
      t.handoff.sent = true;
      this.handlers.onFailed?.({ contextId: t.contextId, unspoken: t.handoff.unspoken, reason: t.handoff.reason });
      if (this.turn !== t) return;
    }
    if (t.ended && !t.doneSent && t.jobs.every((j) => j.done)) {
      t.doneSent = true;
      const models = this.lastTurnModels.filter(Boolean);
      if (models.length) {
        const counts = new Map<string, number>();
        for (const m of models) counts.set(m, (counts.get(m) ?? 0) + 1);
        console.log(
          `${this.tag} t${t.number} done: ${[...counts].map(([m, n]) => `${n}× ${m}`).join(", ")} · ` +
            `${t.headStartSec.toFixed(2)}s audio`,
        );
      }
      this.handlers.onDone?.(t.contextId);
    }
  }

  /* ── seam telemetry ───────────────────────────────────────────────── */

  /** One released frame against the modelled playout: the silence before it, if any. */
  private trackPlayout(t: Turn, j: Job, pcm: Buffer): void {
    const now = Date.now();
    const gap = t.playout.release(now, Math.floor(pcm.length / 2) / ELEVEN_STREAM_SAMPLE_RATE);
    if (!j.releaseStartAt) {
      j.releaseStartAt = now;
      j.gapMs = gap;
    } else {
      j.innerMs += gap;
    }
  }

  /** The piece is fully out: its one `[call-seam]` line. Text is never logged. */
  private logSeam(t: Turn, j: Job): void {
    const chars = j.kind === "socket" ? j.text.trim().length : j.text.length;
    if (!chars && !j.heard) return;
    console.log(
      formatSeamLine(this.cfg.label ?? "", t.openedAt, {
        turn: t.number,
        piece: j.index + 1,
        reason: j.why,
        chars,
        model: j.kind === "socket" ? `${j.model}(socket)` : j.model,
        readyAt: j.readyAt,
        postAt: j.startedAt,
        firstPcmAt: j.firstPcmAt,
        lastPcmAt: j.lastPcmAt,
        eofAt: j.eofAt,
        releaseStartAt: j.releaseStartAt,
        releaseEndAt: Date.now(),
        audioSec: j.audioSec,
        atSec: t.headStartSec,
        gapMs: j.gapMs,
        innerMs: j.innerMs,
        failed: j.failed,
      }),
    );
  }
}

/** The part of `text` after the first `consumed` characters, cut back to a word boundary. */
export function remainderAfter(text: string, consumed: number): string {
  if (consumed <= 0) return text;
  if (consumed >= text.length) return "";
  const cut = text.lastIndexOf(" ", consumed);
  return text.slice(cut < 0 ? 0 : cut + 1).trim();
}
