/* ============================================================
   stt-select.ts — one uniform STT stream for voice mode.

   Voice mode can run on three providers with quite different shapes:

     cartesia (ink-2) — native turn detection. The model decides where a
                        thought ends; there is no client-side boundary.
     openai           — batch transcription behind its own VAD, plus a
                        synthesised live preview.
     google           — the incumbent streaming recognizer (stt.ts). Emits
                        `isFinal` per SEGMENT, not per utterance, so it has
                        no idea where a turn ends; the client's VAD commit
                        is the only boundary it gets.

   Callers should not care. This module presents all three as one
   `VoiceSttStream` with the same callbacks, and resolves provider choice +
   runtime fallback in one place — the same "single source of truth" shape as
   the TTS provider selection in bot-settings.ts.

   `endUtterance()` is the seam: providers with native turn detection treat it
   as advisory (they have already emitted their own turns), while Google uses
   it to close and flush the segment buffer.
   ============================================================ */

import type { VoiceSttProvider } from "../config.js";
import { startStreamingRecognize, transcribeShort, type StreamingSttHandle } from "../stt.js";
import { CartesiaStt, type SttUsage } from "./stt-cartesia.js";
import { OpenAiStt } from "./stt-openai.js";
import type { TurnMeta } from "./turn-composer.js";

export interface VoiceSttCallbacks {
  /** An utterance opened — speech onset. */
  onSpeechStart?: () => void;
  /** Cumulative provisional transcript for the OPEN utterance. */
  onPartial?: (text: string) => void;
  /** The utterance closed. */
  onSpeechEnd?: () => void;
  /** One closed utterance's final transcript. */
  onTurnEnd?: (text: string, meta: TurnMeta) => void;
  onError?: (err: Error) => void;
  /**
   * The provider degraded (streaming auth failed, upstream refused). The
   * caller tells the client its live preview is gone.
   */
  onDegraded?: (mode: string, reason: string) => void;
  /**
   * The provider's upstream socket dropped mid-call and is being reopened.
   * `onRecovered` follows if it comes back; `onLost` if it does not, and from
   * then on the call cannot hear. Neither may be silent: a call that stops
   * hearing without saying so is the mute bug.
   */
  onReconnecting?: (reason: string) => void;
  /**
   * Back. `lostMs` > 0 means audio said during the reconnect overflowed the
   * held buffer and that much of the OLDEST speech was dropped (B4): the
   * caller must be asked to repeat, not told everything is fine.
   */
  onRecovered?: (attempt: number, lostMs?: number) => void;
  onLost?: (reason: string) => void;
}

export interface VoiceSttStream {
  readonly provider: VoiceSttProvider;
  /** False once degraded to a batch path — the client hides its live preview. */
  readonly supportsPartials: boolean;
  feed(frame: Buffer): void;
  /**
   * The client's VAD says the utterance ended. Native-turn providers have
   * already emitted their turn and ignore this; Google flushes here.
   */
  endUtterance(): Promise<void>;
  close(agent?: string): Promise<SttUsage | null>;
  readonly usage: SttUsage | null;
}

// ── Per-bot provider registry ─────────────────────────────────────────
//
// index.ts registers each bot's resolved provider at startup, AFTER
// applySavedSettings has folded in any dashboard override — so this reflects
// the same precedence as ttsProvider (saved setting beats env bootstrap).

const providers = new Map<string, VoiceSttProvider>();

export function setVoiceSttProvider(bot: string, provider: VoiceSttProvider): void {
  providers.set(bot, provider);
}

export function voiceSttProviderFor(bot: string): VoiceSttProvider {
  return providers.get(bot) ?? "cartesia";
}

// ── Test seam ─────────────────────────────────────────────────────────
//
// `createVoiceStt` is the ONLY door websocket.ts has to a provider, and every
// provider behind it opens a real socket to a paid API. The voice-mode socket
// tests drive the real websocket wiring end to end, so they need a stream they
// can script — utterance here, silence there, a connect that stalls — without
// audio, credits, or a network.
//
// This is that seam and nothing more: one factory override, consulted first,
// null everywhere except inside a test. When it is null (i.e. always, in
// production) `createVoiceStt` is byte-for-byte the code it was before.

export type VoiceSttFactory = (
  bot: string,
  cb: VoiceSttCallbacks,
) => Promise<VoiceSttStream>;

let testFactory: VoiceSttFactory | null = null;

/** TEST ONLY. Route `createVoiceStt` to a scripted stream. */
export function __setVoiceSttFactoryForTests(fn: VoiceSttFactory): void {
  testFactory = fn;
}

/** TEST ONLY. Restore the real provider selection. */
export function __resetVoiceSttFactoryForTests(): void {
  testFactory = null;
}

/**
 * Open a voice-mode STT stream for `bot`.
 *
 * Falls back to Google if the configured provider cannot start, so a missing
 * or rejected Cartesia key degrades voice mode instead of killing it. The
 * fallback is announced through `onDegraded` and reflected in `provider`.
 */
export async function createVoiceStt(
  bot: string,
  cb: VoiceSttCallbacks,
): Promise<VoiceSttStream> {
  if (testFactory) return testFactory(bot, cb);

  const configured = voiceSttProviderFor(bot);

  if (configured === "cartesia" || configured === "openai") {
    try {
      return await startNativeTurnStream(configured, cb, bot);
    } catch (err) {
      const reason = (err as Error).message;
      console.warn(`[voice-stt] ${configured} unavailable, falling back to google: ${reason}`);
      cb.onDegraded?.("final-only", `${configured}-unavailable`);
      return startGoogleStream(cb);
    }
  }

  return startGoogleStream(cb);
}

/**
 * Delay before each reopen attempt after an unexpected upstream close. Three
 * tries over about four seconds (plus up to four seconds each to open): long
 * enough to ride out a blip, short enough that the app hears about a real
 * outage while the owner is still waiting on his sentence.
 */
const REOPEN_DELAYS_MS = [0, 1_000, 3_000];

let reopenDelaysOverride: number[] | null = null;
/** TEST ONLY. Shrink the reopen backoff. */
export function __setSttReopenDelaysForTests(delays: number[] | null): void {
  reopenDelaysOverride = delays;
}

/** cartesia + openai — both already speak the callback shape natively. */
async function startNativeTurnStream(
  provider: "cartesia" | "openai",
  cb: VoiceSttCallbacks,
  bot = "unknown",
): Promise<VoiceSttStream> {
  if (provider === "cartesia") return startCartesiaStream(cb, bot);

  // VOICE_STT_MODEL (.env) picks the OpenAI transcription model; default stays
  // gpt-4o-mini-transcribe (gpt-transcribe also works).
  const model = process.env.VOICE_STT_MODEL?.trim() || undefined;
  const language = voiceSttLanguage(bot);
  const stt = new OpenAiStt({ ...(model ? { model } : {}), ...(language ? { language } : {}) });
  wireNativeCallbacks(stt, cb);
  await stt.start();

  return {
    provider,
    supportsPartials: stt.supportsPartials,
    feed: (frame) => stt.feed(frame),
    // The model owns the turn boundary here; the client's VAD commit is
    // advisory and must NOT force a second turn on top of the one the
    // provider already emitted.
    endUtterance: async () => {},
    close: (agent) => stt.stop(agent),
    get usage() {
      return stt.usage;
    },
  };
}

/**
 * The recognizer's language for an agent's calls (voice step 5): <BOT>_STT_LANGUAGE,
 * else VOICE_STT_LANGUAGE, else English for Michael (the owner speaks English to him;
 * a short "wait, stop" was heard as French) and the model's own guess
 * for everyone else. "auto" = the model guesses.
 */
export function voiceSttLanguage(bot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env[`${bot.toUpperCase()}_STT_LANGUAGE`] ?? env.VOICE_STT_LANGUAGE ?? (bot === "michael" ? "en" : "")).trim().toLowerCase();
  return raw && raw !== "auto" ? raw : undefined;
}

type NativeStt = CartesiaStt | OpenAiStt;

function wireNativeCallbacks(stt: NativeStt, cb: VoiceSttCallbacks): void {
  stt.onSpeechStart = () => cb.onSpeechStart?.();
  stt.onSpeechEnd = () => cb.onSpeechEnd?.();
  stt.onPartial = (text: string) => cb.onPartial?.(text);
  stt.onTurnEnd = (text: string, meta: { sttMs: number; turnDurMs: number; nativeTurnEnd?: boolean }) => {
    cb.onTurnEnd?.(text, {
      sttMs: meta.sttMs,
      audioSec: Number((meta.turnDurMs / 1000).toFixed(2)),
      nativeTurnEnd: true,
    });
  };
  stt.onError = (err: Error) => cb.onError?.(err);
}

/**
 * Audio held across a reconnect: ten seconds of 16 kHz s16le mono. The whole
 * reopen schedule (0 + 1 + 3 s of backoff, plus the opens) usually fits; if
 * it does not, the OLDEST audio goes and the recovery says how much.
 */
export const RECONNECT_QUEUE_MAX_BYTES = 16_000 * 2 * 10;

/**
 * Cartesia ink-2 behind a self-healing handle. The upstream socket can close
 * under a live call (idle timeout, a deploy on their side, a network blip);
 * when it does, a fresh one is opened behind the same handle, so websocket.ts
 * keeps feeding the stream it already holds and never sees the swap.
 *
 * B4: audio fed while reconnecting — through the backoff waits AND
 * failed opens — is held HERE, in one bounded queue owned by this handle,
 * and flushed once into the socket that succeeds. Before, frames in the
 * backoff went into a stopped recognizer and frames queued in a failed
 * socket were cleared by its stop(); recovery then announced "ok" anyway.
 */
async function startCartesiaStream(cb: VoiceSttCallbacks, bot: string): Promise<VoiceSttStream> {
  let current = new CartesiaStt();
  let closed = false;
  let lost = false;
  let reconnecting = false;
  let held: Buffer[] = [];
  let heldBytes = 0;
  let droppedBytes = 0;

  const hold = (frame: Buffer): void => {
    held.push(frame);
    heldBytes += frame.length;
    while (heldBytes > RECONNECT_QUEUE_MAX_BYTES && held.length > 1) {
      const old = held.shift()!;
      heldBytes -= old.length;
      droppedBytes += old.length;
    }
  };
  const retired = { audioSec: 0, credits: 0, turns: 0 };

  const retire = (stt: CartesiaStt): void => {
    const u = stt.usage;
    retired.audioSec += u.audioSec;
    retired.credits += u.credits;
    retired.turns += u.turns;
    // stop() on a dead socket just writes its usage line; the swap must not
    // lose the credits it burned.
    void stt.stop(bot);
  };

  const arm = (stt: CartesiaStt): void => {
    wireNativeCallbacks(stt, cb);
    stt.onClose = (code, reason) => {
      // A socket failing DURING the reopen loop is that loop's to handle; a
      // nested reopen would discard the audio held so far.
      if (closed || stt !== current || reconnecting) return;
      void reopen(`closed code=${code}${reason ? ` ${reason}` : ""}`);
    };
  };

  const reopen = async (why: string): Promise<void> => {
    // From here until a socket is up, every frame is held by this handle.
    reconnecting = true;
    held = [];
    heldBytes = 0;
    droppedBytes = 0;
    retire(current);
    console.warn(`[voice-stt] cartesia dropped mid-call for ${bot} (${why}); reopening`);
    cb.onReconnecting?.(why);
    const delays = reopenDelaysOverride ?? REOPEN_DELAYS_MS;
    let lastErr = why;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
      if (closed) return;
      const next = new CartesiaStt();
      current = next;
      arm(next);
      try {
        await next.start();
        if (closed) {
          void next.stop(bot);
          return;
        }
        // Everything said while we were away, once, in order — then live.
        for (const frame of held) next.feed(frame);
        const lostMs = Math.round((droppedBytes / 2 / 16_000) * 1000);
        held = [];
        heldBytes = 0;
        reconnecting = false;
        console.log(
          `[voice-stt] cartesia reopened for ${bot} on attempt ${i + 1}` +
            (lostMs ? ` — ${lostMs} ms of the oldest held speech overflowed and was dropped` : ""),
        );
        cb.onRecovered?.(i + 1, lostMs);
        return;
      } catch (err) {
        lastErr = (err as Error).message;
        console.warn(`[voice-stt] cartesia reopen attempt ${i + 1} failed for ${bot}: ${lastErr}`);
        retire(next);
      }
    }
    if (closed) return;
    lost = true;
    reconnecting = false;
    held = [];
    heldBytes = 0;
    console.error(`[voice-stt] cartesia LOST for ${bot}: the call cannot hear (${lastErr})`);
    cb.onLost?.(lastErr);
  };

  arm(current);
  await current.start();

  return {
    provider: "cartesia",
    supportsPartials: true,
    feed: (frame) => {
      if (lost) return;
      if (reconnecting) hold(frame);
      else current.feed(frame);
    },
    // ink-2 owns the turn boundary; the client's VAD commit is advisory and
    // must NOT force a second turn on top of the one the provider emitted.
    endUtterance: async () => {},
    close: async (agent) => {
      closed = true;
      const u = await current.stop(agent ?? bot);
      return {
        audioSec: Number((retired.audioSec + u.audioSec).toFixed(2)),
        credits: retired.credits + u.credits,
        turns: retired.turns + u.turns,
      };
    },
    get usage() {
      const u = current.usage;
      return {
        audioSec: Number((retired.audioSec + u.audioSec).toFixed(2)),
        credits: retired.credits + u.credits,
        turns: retired.turns + u.turns,
      };
    },
  };
}

/**
 * The incumbent Google recognizer, wrapped to look like the others.
 *
 * Google emits `isFinal: true` at every end-of-segment it detects — phrase
 * breaks, breaths, mid-utterance pauses — not once per utterance. Those
 * segments are accumulated and only released as ONE turn at `endUtterance()`.
 * Emitting them as they arrive is the original behaviour that produced
 * the split, out-of-order transcript.
 */
function startGoogleStream(cb: VoiceSttCallbacks): VoiceSttStream {
  let handle: StreamingSttHandle | null = null;
  let pcmFallback: Buffer[] | null = null;
  let degraded = false;
  const segments: string[] = [];
  let lastInterim = "";
  let speaking = false;
  let startedAt = 0;

  /** Everything committed so far plus the live hypothesis. */
  const compose = (interim: string): string => {
    const committed = segments.join(" ").trim();
    const live = interim.trim();
    if (committed && live) return `${committed} ${live}`;
    return committed || live;
  };

  const markSpeaking = (): void => {
    if (speaking) return;
    speaking = true;
    startedAt = Date.now();
    cb.onSpeechStart?.();
  };

  try {
    handle = startStreamingRecognize({
      onInterim: (text) => {
        if (!text || text === lastInterim) return;
        lastInterim = text;
        markSpeaking();
        cb.onPartial?.(compose(text));
      },
      onFinal: (text) => {
        if (!text) return;
        markSpeaking();
        segments.push(text);
        lastInterim = "";
        // Keep the full running transcript visible even as Google moves a
        // phrase from interim → final (its interim buffer clears on
        // finalization).
        cb.onPartial?.(compose(""));
      },
      onError: (err) => {
        console.warn("[voice-stt] streaming STT failed, enabling REST fallback:", err.message);
        handle = null;
        degraded = true;
        pcmFallback = pcmFallback ?? [];
        cb.onDegraded?.("final-only", "streaming-auth-fallback");
      },
    });
  } catch (err) {
    console.warn(
      "[voice-stt] could not start streaming STT, using REST fallback:",
      (err as Error).message,
    );
    degraded = true;
    pcmFallback = [];
    cb.onDegraded?.("final-only", "no-streaming-client");
  }

  return {
    provider: "google",
    get supportsPartials() {
      return !degraded;
    },
    feed(frame: Buffer) {
      if (handle) handle.write(frame);
      if (pcmFallback) pcmFallback.push(frame);
    },
    async endUtterance() {
      if (handle) {
        try {
          handle.end();
        } catch {
          /* noop */
        }
        // Short drain window — onFinal events may still land after .end().
        await new Promise((r) => setTimeout(r, 350));
        handle = null;
      }

      let transcript = segments.join(" ").trim();
      const tail = lastInterim.trim();
      if (tail) transcript = transcript ? `${transcript} ${tail}` : tail;

      // REST fallback: no streaming final, so run one-shot recognize over
      // the buffered PCM.
      if (!transcript && pcmFallback && pcmFallback.length > 0) {
        try {
          transcript = (await transcribeShort(Buffer.concat(pcmFallback))).trim();
        } catch (err) {
          console.error("[voice-stt] REST transcribe failed:", (err as Error).message);
        }
      }

      const durMs = startedAt ? Date.now() - startedAt : 0;
      segments.length = 0;
      lastInterim = "";
      pcmFallback = pcmFallback ? [] : null;
      speaking = false;
      startedAt = 0;

      cb.onSpeechEnd?.();
      if (transcript) {
        cb.onTurnEnd?.(transcript, { sttMs: 0, audioSec: Number((durMs / 1000).toFixed(2)) });
      }
    },
    async close() {
      if (handle) {
        try {
          handle.destroy();
        } catch {
          /* noop */
        }
        handle = null;
      }
      pcmFallback = null;
      return null;
    },
    usage: null,
  };
}
