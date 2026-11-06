/* ============================================================
   stt-openai.ts — ported from the voice-mode simulator.

   STT provider: OpenAI gpt-4o-mini-transcribe — what the gateway's voice-in
   path already uses. Batch per utterance: the local VAD segments speech and
   decides end-of-thought; the whole utterance is then transcribed in one shot.

   LIVE PREVIEW (round-2 item 2). "As I'm speaking, it's not transcribing what
   I'm saying… everything I'm saying should be transcribing live, small at the
   bottom, in italics — that was part of the design, I'm not seeing it at all."

   The model has no streaming mode, so there is no partial to forward: this
   provider genuinely had nothing to send and `supportsPartials` said so. The
   preview is therefore synthesised — every `partialIntervalMs` the
   utterance-so-far is transcribed alongside the capture and emitted as a
   provisional. It costs one extra (cheap) transcription per interval and lags
   speech by roughly one round trip; it does NOT touch turn segmentation, which
   stays with the VAD + turn composer. Set partialIntervalMs to 0 to disable,
   which also flips `supportsPartials` back to false.

   Interface (shared with stt-cartesia.ts, so the two are drop-in swappable):
     start()            — begin a call session
     feed(pcmFrame)     — 16 kHz s16le mono mic frames
     stop(agent)        — end the call session, return + log the session usage
     events (callbacks set by the orchestrator):
       onSpeechStart()          — user began speaking (VAD onset; barge-in signal)
       onSpeechEnd()            — VAD closed the utterance (before transcription)
       onPartial(text)          — live provisional transcript (synthesised, see above)
       onTurnEnd(text, meta)    — end-of-thought: final transcript for the turn

   GATEWAY ADAPTATIONS (behaviour otherwise identical to the sim):
     - Options arrive via the constructor instead of sim-config.json, with the
       sim's values as defaults.
     - The OpenAI SDK client replaces the sim's raw fetch, matching voice-in.ts
       and voice-out.ts. maxRetries is pinned to 0 so a slow request still fails
       in one round trip the way the sim's bare fetch did — retries behind a live
       preview would only pile latency onto the next one.
     - onTurnEnd meta carries the shared { sttMs, turnDurMs } shape. turnDurMs is
       derived from the captured audio (the sim reported the same number as
       `audioSec`), which for this path is the utterance window including the
       pre-roll and the trailing silence the VAD waited out.
     - stop() returns and logs a usage line, mirroring stt-cartesia.ts, so burn is
       observable across providers. Requests are counted separately because the
       synthesised previews are the part that can quietly multiply cost.
   ============================================================ */

import { appendFile, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import OpenAI, { toFile } from "openai";

import type { CartesiaTurnMeta, SttUsage } from "./stt-cartesia.js";
import { Vad } from "./vad.js";
import { gatewayStateRoot } from "../multi-user-paths.js";

// Spend ledger — moves with the state root, same as the Cartesia counter.
const STT_USAGE_DIR = resolve(gatewayStateRoot(), "voice-usage");
const STT_USAGE_LOG = resolve(STT_USAGE_DIR, "stt-openai.jsonl");

/** Anything shorter than this is a VAD misfire, not speech — dropped unsent. */
const MIN_UTTERANCE_SEC = 0.25;

/**
 * Audio retained ahead of VAD onset. Onset needs a few consecutive speech
 * frames to confirm, so without a pre-roll the first word gets clipped.
 */
const PRE_ROLL_SEC = 0.3;

/** Ceiling on one transcription round trip, preview or final. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Shared turn-meta shape. Both STT providers emit the same fields so the caller
 * can swap them without branching; the type lives in stt-cartesia.ts because
 * that provider landed first.
 */
export type SttTurnMeta = CartesiaTurnMeta;

export interface OpenAiSttOptions {
  model?: string;
  sampleRate?: number;
  /** RMS (0..1) above which a frame counts as speech. */
  vadThreshold?: number;
  /** Sustained silence that ends an utterance. */
  vadSilenceMs?: number;
  /** Cadence of the synthesised live preview. 0 disables it entirely. */
  partialIntervalMs?: number;
  /** Don't spend a preview request on less audio than this. */
  partialMinMs?: number;
  /**
   * ISO-639-1 language for every request ("en"); absent = the model guesses.
   * Once it guessed French for a short "wait, stop" ("Oui, top.") on both
   * doors (voice step 5, stt-select.ts voiceSttLanguage).
   */
  language?: string;
  apiKey?: string;
}

export interface OpenAiSttUsage extends SttUsage {
  /** Transcription requests sent, including the synthesised live previews. */
  requests: number;
}

/** PCM s16le mono → WAV container (for the multipart upload). */
function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class OpenAiStt {
  private readonly model: string;
  private readonly sampleRate: number;
  private readonly partialIntervalMs: number;
  private readonly partialMinMs: number;
  private readonly apiKey: string | undefined;
  private readonly language: string | undefined;
  private readonly vad: Vad;
  private readonly preRollMaxBytes: number;

  private client: OpenAI | null = null;
  private active = false;
  private capturing = false;
  private buffer: Buffer[] = [];

  // Live-preview pacing (round-2 item 2). One transcription in flight at a
  // time — a slow round trip throttles the preview instead of queueing
  // requests behind it.
  private lastPartialAt = 0;
  private partialInFlight = false;
  private utteranceSeq = 0;

  // Pre-roll ring: keep ~300ms of audio before VAD onset so the first
  // word isn't clipped by onset confirmation latency.
  private preRoll: Buffer[] = [];
  private preRollBytes = 0;

  private bytesFed = 0;
  private turns = 0;
  private requests = 0;

  onSpeechStart: () => void = () => {};
  /** VAD closed the utterance (before transcription). */
  onSpeechEnd: () => void = () => {};
  onPartial: (text: string) => void = () => {};
  onTurnEnd: (text: string, meta: SttTurnMeta) => void = () => {};
  onError: (err: Error) => void = () => {};

  constructor({
    model = "gpt-4o-mini-transcribe",
    sampleRate = 16000,
    vadThreshold = 0.012,
    vadSilenceMs = 850,
    partialIntervalMs = 900,
    partialMinMs = 700,
    apiKey = process.env.OPENAI_API_KEY,
    language,
  }: OpenAiSttOptions = {}) {
    this.model = model;
    this.language = language || undefined;
    this.sampleRate = sampleRate;
    this.partialIntervalMs = partialIntervalMs;
    this.partialMinMs = partialMinMs;
    this.apiKey = apiKey;
    this.vad = new Vad({ threshold: vadThreshold, silenceMs: vadSilenceMs });
    this.preRollMaxBytes = this.bytesPerSec * PRE_ROLL_SEC;
  }

  private get bytesPerSec(): number {
    return this.sampleRate * 2;
  }

  get name(): string {
    return `openai/${this.model}`;
  }

  /**
   * Synthesised, not native — see the header. True because the UI contract is
   * "will a live preview arrive?", and now it does.
   */
  get supportsPartials(): boolean {
    return this.partialIntervalMs > 0;
  }

  get inFlight(): boolean {
    return this.active;
  }

  /** Audio captured so far, and what it cost. Safe to read at any time. */
  get usage(): OpenAiSttUsage {
    const audioSec = this.bytesFed / this.bytesPerSec;
    return {
      audioSec: Number(audioSec.toFixed(2)),
      // OpenAI bills per minute of audio in USD, not against a credit pool.
      // Kept at 0 so the shape stays identical to the Cartesia path.
      credits: 0,
      turns: this.turns,
      requests: this.requests,
    };
  }

  async start(): Promise<void> {
    if (!this.apiKey) throw new Error("[stt-openai] No OPENAI_API_KEY set");
    this.active = true;
  }

  feed(frame: Buffer): void {
    if (!this.active) return;
    this.bytesFed += frame.length;

    if (!this.capturing) {
      this.preRoll.push(frame);
      this.preRollBytes += frame.length;
      while (this.preRollBytes > this.preRollMaxBytes && this.preRoll.length > 1) {
        const dropped = this.preRoll.shift();
        this.preRollBytes -= dropped?.length ?? 0;
      }
    } else {
      this.buffer.push(frame);
    }

    const ev = this.vad.feed(frame);
    if (ev === "onset") {
      this.capturing = true;
      this.utteranceSeq += 1;
      this.lastPartialAt = Date.now();
      this.buffer = [...this.preRoll];
      this.preRoll = [];
      this.preRollBytes = 0;
      this.onSpeechStart();
    } else if (ev === "end" && this.capturing) {
      const utterance = Buffer.concat(this.buffer);
      this.capturing = false;
      this.buffer = [];
      // Fires NOW, not when the transcript comes back — the turn composer gates
      // committing on whether the user is still talking, and transcription is a
      // round trip behind the audio.
      this.onSpeechEnd();
      void this.transcribe(utterance);
    } else if (this.capturing) {
      this.maybePartial();
    }
  }

  /** Live preview: transcribe the utterance-so-far, alongside the capture. */
  private maybePartial(): void {
    if (!this.partialIntervalMs || this.partialInFlight) return;
    const now = Date.now();
    if (now - this.lastPartialAt < this.partialIntervalMs) return;
    const pcm = Buffer.concat(this.buffer);
    if (pcm.length < this.bytesPerSec * (this.partialMinMs / 1000)) return;

    this.lastPartialAt = now;
    this.partialInFlight = true;
    const seq = this.utteranceSeq;
    this.transcribeOnce(pcm)
      .then((text) => {
        // Discard anything that lands after its utterance was committed —
        // a late preview must never overwrite the real transcript.
        if (text && this.active && this.capturing && seq === this.utteranceSeq) {
          this.onPartial(text);
        }
      })
      .catch(() => {}) // a dropped preview is cosmetic, never fatal
      .finally(() => {
        this.partialInFlight = false;
      });
  }

  private getClient(): OpenAI {
    if (!this.client) this.client = new OpenAI({ apiKey: this.apiKey });
    return this.client;
  }

  /** One transcription request. Shared by the final turn and the live preview. */
  private async transcribeOnce(pcm: Buffer, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
    this.requests += 1;
    const file = await toFile(pcmToWav(pcm, this.sampleRate), "utterance.wav", {
      type: "audio/wav",
    });
    const res = await this.getClient().audio.transcriptions.create(
      { model: this.model, file, ...(this.language ? { language: this.language } : {}) },
      // One shot, like the sim's bare fetch: a retry behind a live preview only
      // stacks latency onto the next one.
      { timeout: timeoutMs, maxRetries: 0 },
    );
    return (res.text || "").trim();
  }

  private async transcribe(pcm: Buffer): Promise<void> {
    if (pcm.length < this.bytesPerSec * MIN_UTTERANCE_SEC) return; // <250ms — misfire, drop
    const t0 = Date.now();
    try {
      const text = await this.transcribeOnce(pcm);
      if (text) {
        this.turns += 1;
        this.onTurnEnd(text, {
          sttMs: Date.now() - t0,
          turnDurMs: Math.round((pcm.length / this.bytesPerSec) * 1000),
          nativeTurnEnd: true,
        });
      }
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(`[stt-openai] ${String(err)}`));
    }
  }

  /** End the session and write the usage line. */
  async stop(agent = "unknown"): Promise<OpenAiSttUsage> {
    const usage = this.usage;
    this.active = false;
    this.capturing = false;
    this.partialInFlight = false;
    this.buffer = [];
    this.preRoll = [];
    this.preRollBytes = 0;
    this.vad.reset();
    if (usage.audioSec > 0) logSttUsage(agent, usage, this.model);
    return usage;
  }
}

/**
 * Burn counter, matching stt-cartesia.ts. The synthesised live preview means
 * request count and audio seconds diverge here, so both get a line.
 * Fire-and-forget: nothing here may fail a turn.
 */
function logSttUsage(agent: string, usage: OpenAiSttUsage, model: string): void {
  try {
    mkdirSync(STT_USAGE_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agent,
      audioSec: usage.audioSec,
      turns: usage.turns,
      requests: usage.requests,
      model,
    });
    appendFile(STT_USAGE_LOG, line + "\n", (err) => {
      if (err) console.warn(`[stt-openai] usage log write failed: ${err.message}`);
    });
  } catch (err) {
    console.warn(`[stt-openai] usage log failed: ${(err as Error).message}`);
  }
}
