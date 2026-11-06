import { randomUUID } from "node:crypto";
import type { CallTtsStream, VoiceTtsStreamHandlers, WordTimestamps } from "./voice-tts-stream.js";
import { stripAudioTags } from "./voice-tts-eleven.js";

/* ============================================================
   voice-tts-gemini-http.ts — a call's voice on Gemini TTS, one request per
   sentence.

   Miriam's voice notes are Gemini TTS (voice "Aoede" + her style prompt), and
   a family member knows that voice. Until now a Miriam call fell back to a Cartesia
   voice that is not hers. This path speaks the call in the note voice: the
   SAME model, voice name and style prompt the note path sends
   (voice-out.ts synthesizeGemini), one request per sentence.

   ── Transport ────────────────────────────────────────────────────────────
   `streamGenerateContent?alt=sse` first: audio arrives in pieces, so a
   sentence starts playing before it is fully rendered. If the streaming
   endpoint refuses (4xx), the call switches to unary `generateContent` for
   the rest of the call — same voice, whole sentence at once.

   ── Pipelining ───────────────────────────────────────────────────────────
   Same shape as the ElevenLabs HTTP path: a sentence's request goes out the
   moment the sentence exists, up to MAX_IN_FLIGHT at once, and audio is
   released strictly in order. Rendering is faster than speech, so after the
   first sentence the listener does not wait on a gap.

   ── Failure ──────────────────────────────────────────────────────────────
   A sentence that errors, returns no audio, or produces nothing within the
   first-audio timeout is retried once. A second failure skips that sentence
   (its words are still on screen) and logs it. There is deliberately NO
   switch to another provider mid-turn: the owner's rule for this voice is never
   to swap it silently.

   ── Word timings ─────────────────────────────────────────────────────────
   Gemini returns no timings. Once a sentence's audio is complete its words
   are spread across that audio by character weight and shifted by the audio
   already released this turn — the same {words,start,end} seconds shape the
   other paths emit, so karaoke and the spoken-record clip work unchanged.
   Estimated, not measured; good enough to clip a barged-in reply at the
   right sentence.
   ============================================================ */

export const GEMINI_TTS_MODEL_DEFAULT = "gemini-2.5-flash-preview-tts";
export const GEMINI_TTS_SAMPLE_RATE = 24_000;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_IN_FLIGHT = 3;
const RETRIES = 1;

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface GeminiHttpStreamConfig {
  model: string;
  voiceName: string;
  /** The agent's style prompt — the same one its notes send. Empty = none. */
  styleInstructions: string;
  label?: string;
  /** Test seams. */
  base?: string;
  apiKey?: string;
  stream?: boolean;
  firstAudioTimeoutMs?: number;
  totalTimeoutMs?: number;
}

/** The text a sentence request sends: identical to the note path's prompt. */
export function geminiPromptText(styleInstructions: string, text: string): string {
  return styleInstructions ? `${styleInstructions}\n\nNow say the following:\n\n${text}` : text;
}

export function geminiRequestBody(cfg: Pick<GeminiHttpStreamConfig, "voiceName" | "styleInstructions">, text: string): string {
  return JSON.stringify({
    contents: [{ parts: [{ text: geminiPromptText(cfg.styleInstructions, text) }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voiceName } } },
    },
  });
}

interface GeminiChunk {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  }>;
  error?: { message?: string };
}

/** Every audio part in one response object, decoded. */
export function audioFromChunk(chunk: GeminiChunk): Buffer[] {
  const out: Buffer[] = [];
  for (const c of chunk.candidates ?? []) {
    for (const p of c.content?.parts ?? []) {
      if (p.inlineData?.data) out.push(Buffer.from(p.inlineData.data, "base64"));
    }
  }
  return out;
}

/** Spreads a sentence's words across its audio by character weight. Pure. */
export function estimateWordTimes(text: string, durationSec: number, offsetSec: number): WordTimestamps | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || durationSec <= 0) return null;
  // A little lead and tail silence is normal in rendered speech.
  const lead = Math.min(0.08, durationSec * 0.05);
  const span = Math.max(0.01, durationSec - lead * 2);
  const weights = words.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: WordTimestamps = { words: [], start: [], end: [] };
  let t = offsetSec + lead;
  for (let i = 0; i < words.length; i++) {
    const d = (span * weights[i]) / total;
    out.words.push(words[i]);
    out.start.push(round3(t));
    out.end.push(round3(t + d));
    t += d;
  }
  return out;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Splits an SSE byte stream into `data:` payloads. */
export class SseSplitter {
  private buf = "";
  push(text: string): string[] {
    this.buf += text.replace(/\r\n/g, "\n");
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const event = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  }
  flush(): string[] {
    const rest = this.buf;
    this.buf = "";
    return rest.trim() ? this.push(`${rest}\n\n`) : [];
  }
}

interface Job {
  index: number;
  text: string;
  pending: Buffer[];
  audioBytes: number;
  /** One odd trailing byte carried to the next piece, so samples stay aligned. */
  carry: Buffer | null;
  done: boolean;
  failed: boolean;
  started: boolean;
  attempts: number;
  startedAt: number;
  firstAudioMs: number;
  controller?: AbortController;
  /** Words emitted for this job already. */
  wordsSent: boolean;
}

interface Turn {
  contextId: string;
  number: number;
  jobs: Job[];
  head: number;
  /** Seconds released this turn before the head job. */
  releasedSec: number;
  ended: boolean;
  doneSent: boolean;
  openedAt: number;
}

export class GeminiHttpTtsStream implements CallTtsStream {
  readonly provider = "gemini" as const;
  private handlers: VoiceTtsStreamHandlers = {};
  private apiKey: string | null = null;
  private closed = false;
  private turn: Turn | null = null;
  private turnCount = 0;
  /** False once the streaming endpoint refused: unary for the rest of the call. */
  private streaming: boolean;

  charsSent = 0;
  lastTurnModels: string[] = [];
  /** First-audio ms of each sentence of the last turn — the latency proof. */
  lastTurnFirstAudioMs: number[] = [];

  constructor(private readonly cfg: GeminiHttpStreamConfig) {
    this.streaming = cfg.stream ?? (process.env.GEMINI_CALL_STREAM ?? "on") !== "off";
  }

  get activeModel(): string {
    return this.cfg.model;
  }

  get sampleRate(): number {
    return GEMINI_TTS_SAMPLE_RATE;
  }

  get ready(): boolean {
    return !this.closed && this.apiKey !== null;
  }

  on(handlers: VoiceTtsStreamHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  private get tag(): string {
    return `[tts-gemini-http]${this.cfg.label ? ` ${this.cfg.label}` : ""}`;
  }

  async connect(): Promise<void> {
    const key = this.cfg.apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) throw new Error("[tts-gemini-http] No GEMINI_API_KEY set");
    this.apiKey = key;
    // Warm the TLS connection so the first sentence does not pay a handshake.
    void fetch(`${this.cfg.base ?? GEMINI_BASE}/${this.cfg.model}`, {
      headers: { "x-goog-api-key": key },
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
      ended: false,
      doneSent: false,
      openedAt: Date.now(),
    };
    this.turn = t;
    this.charsSent = 0;
    this.lastTurnModels = [];
    this.lastTurnFirstAudioMs = [];
    return t.contextId;
  }

  speakPiece(text: string): void {
    const t = this.turn;
    if (!this.ready || !t || t.ended) return;
    const clean = stripAudioTags(text).replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.charsSent += clean.length + 1;
    t.jobs.push({
      index: t.jobs.length,
      text: clean,
      pending: [],
      audioBytes: 0,
      carry: null,
      done: false,
      failed: false,
      started: false,
      attempts: 0,
      startedAt: 0,
      firstAudioMs: 0,
      wordsSent: false,
    });
    this.pump(t);
  }

  endTurn(): void {
    const t = this.turn;
    if (!t || t.ended) return;
    t.ended = true;
    this.release(t);
  }

  cancel(): void {
    this.retireTurn();
  }

  close(): void {
    this.closed = true;
    this.retireTurn();
  }

  private retireTurn(): void {
    const t = this.turn;
    if (!t) return;
    for (const j of t.jobs) j.controller?.abort();
    t.ended = true;
    t.doneSent = true;
    this.turn = null;
  }

  private pump(t: Turn): void {
    if (this.turn !== t) return;
    let inFlight = 0;
    for (let i = t.head; i < t.jobs.length; i++) {
      const j = t.jobs[i];
      if (j.started && !j.done) inFlight++;
    }
    for (let i = t.head; i < t.jobs.length && inFlight < MAX_IN_FLIGHT; i++) {
      const j = t.jobs[i];
      if (j.started) continue;
      j.started = true;
      inFlight++;
      void this.render(t, j);
    }
  }

  private async render(t: Turn, j: Job): Promise<void> {
    j.attempts++;
    j.startedAt = Date.now();
    const controller = new AbortController();
    j.controller = controller;
    const firstAudioMs = this.cfg.firstAudioTimeoutMs ?? envMs("GEMINI_CALL_FIRST_AUDIO_TIMEOUT_MS", 8_000);
    const totalMs = this.cfg.totalTimeoutMs ?? envMs("GEMINI_CALL_SENTENCE_TIMEOUT_MS", 30_000);
    const firstTimer = setTimeout(() => controller.abort(new Error("no audio in time")), firstAudioMs);
    const totalTimer = setTimeout(() => controller.abort(new Error("sentence took too long")), totalMs);
    const streaming = this.streaming;
    try {
      const url = `${this.cfg.base ?? GEMINI_BASE}/${this.cfg.model}:${streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey ?? "" },
        body: geminiRequestBody(this.cfg, j.text),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        // The streaming endpoint refused this model: same voice, unary, for the rest of the call.
        if (streaming && res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.streaming = false;
          j.attempts--; // the switch is not the sentence's failure
          console.warn(`${this.tag} streaming refused (${res.status}); unary for the rest of the call: ${body}`);
          throw new RetryNow();
        }
        throw new Error(`gemini ${res.status}: ${body}`);
      }
      const onAudio = (pcm: Buffer): void => {
        if (!j.firstAudioMs) {
          j.firstAudioMs = Date.now() - j.startedAt;
          clearTimeout(firstTimer);
        }
        this.onJobAudio(t, j, pcm);
      };
      if (streaming && res.body) {
        const sse = new SseSplitter();
        const dec = new TextDecoder();
        for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
          for (const data of sse.push(dec.decode(piece, { stream: true }))) this.onPayload(data, onAudio);
        }
        for (const data of sse.flush()) this.onPayload(data, onAudio);
      } else {
        this.onPayload(await res.text(), onAudio);
      }
      if (!j.audioBytes) throw new Error("no audio in response");
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      j.done = true;
      this.lastTurnModels[j.index] = `${this.cfg.model}${streaming ? "" : "(unary)"}`;
      this.lastTurnFirstAudioMs[j.index] = j.firstAudioMs;
      console.log(
        `${this.tag} turn ${t.number} sentence ${j.index + 1}: first audio ${j.firstAudioMs} ms, ` +
          `${(this.jobSec(j)).toFixed(2)} s audio, ${streaming ? "stream" : "unary"}${j.attempts > 1 ? `, attempt ${j.attempts}` : ""}`,
      );
    } catch (err) {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      if (this.turn !== t || this.closed) return;
      const retryNow = err instanceof RetryNow;
      // Audio already released for this sentence cannot be taken back: keep what played.
      if ((retryNow || j.attempts <= RETRIES) && !j.audioBytes) {
        if (!retryNow) console.warn(`${this.tag} turn ${t.number} sentence ${j.index + 1} failed, retrying: ${reason(err, controller)}`);
        return this.render(t, j);
      }
      j.done = true;
      j.failed = !j.audioBytes;
      this.lastTurnModels[j.index] = j.audioBytes ? `${this.cfg.model}(cut)` : "skipped";
      console.warn(`${this.tag} turn ${t.number} sentence ${j.index + 1} ${j.audioBytes ? "cut short" : "skipped"}: ${reason(err, controller)}`);
      this.handlers.onError?.(new Error(`gemini sentence ${j.index + 1} ${j.audioBytes ? "cut short" : "not spoken"}`));
    }
    if (this.turn !== t) return;
    this.release(t);
    this.pump(t);
  }

  private onPayload(data: string, onAudio: (pcm: Buffer) => void): void {
    let parsed: GeminiChunk | GeminiChunk[];
    try {
      parsed = JSON.parse(data) as GeminiChunk | GeminiChunk[];
    } catch {
      return;
    }
    for (const chunk of Array.isArray(parsed) ? parsed : [parsed]) {
      if (chunk.error) throw new Error(`gemini error: ${chunk.error.message ?? "unknown"}`);
      for (const pcm of audioFromChunk(chunk)) onAudio(pcm);
    }
  }

  private onJobAudio(t: Turn, j: Job, raw: Buffer): void {
    if (this.turn !== t) return;
    let pcm = j.carry ? Buffer.concat([j.carry, raw]) : raw;
    j.carry = null;
    if (pcm.length % 2) {
      j.carry = pcm.subarray(pcm.length - 1);
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    if (!pcm.length) return;
    j.audioBytes += pcm.length;
    j.pending.push(pcm);
    this.release(t);
  }

  private jobSec(j: Job): number {
    return j.audioBytes / 2 / GEMINI_TTS_SAMPLE_RATE;
  }

  /** Releases the head job's audio in order; advances when it is complete. */
  private release(t: Turn): void {
    if (this.turn !== t) return;
    while (t.head < t.jobs.length) {
      const j = t.jobs[t.head];
      for (const pcm of j.pending.splice(0)) this.handlers.onAudio?.(pcm, t.contextId);
      if (!j.done) return;
      if (!j.wordsSent) {
        j.wordsSent = true;
        const wt = estimateWordTimes(j.text, this.jobSec(j), t.releasedSec);
        if (wt && !j.failed) this.handlers.onTimestamps?.(wt, t.contextId);
      }
      t.releasedSec += this.jobSec(j);
      t.head++;
    }
    if (t.ended && !t.doneSent) {
      t.doneSent = true;
      const spoken = this.lastTurnModels.filter((m) => m !== "skipped").length;
      console.log(
        `${this.tag} turn ${t.number} done: ${t.jobs.length} sentence(s), ${spoken} spoken, ` +
          `first audio ${this.lastTurnFirstAudioMs.filter((n) => n > 0).join("/") || "-"} ms`,
      );
      this.handlers.onDone?.(t.contextId);
    }
  }
}

class RetryNow extends Error {}

function reason(err: unknown, controller: AbortController): string {
  if (controller.signal.aborted && controller.signal.reason instanceof Error) return controller.signal.reason.message;
  return err instanceof Error ? err.message : String(err);
}
