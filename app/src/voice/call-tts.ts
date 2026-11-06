import type { BotConfig } from "../config.js";
import { resolveElevenVoiceId } from "../voice-out.js";
import { VoiceTtsStream, type CallTtsStream } from "../voice-tts-stream.js";
import { ElevenHttpTtsStream } from "../voice-tts-eleven-http.js";
import { FailoverTtsStream } from "./tts-failover.js";
import { GeminiHttpTtsStream, GEMINI_TTS_MODEL_DEFAULT, GEMINI_TTS_SAMPLE_RATE, geminiRequestBody } from "../voice-tts-gemini-http.js";
import {
  ElevenTtsStream,
  ELEVEN_STREAM_FALLBACK_MODEL_DEFAULT,
  ELEVEN_STREAM_MODEL_DEFAULT,
  ELEVEN_STREAM_SAMPLE_RATE,
  stripAudioTags,
  upsample2x,
} from "../voice-tts-eleven.js";

/* ============================================================
   call-tts.ts — which voice a call speaks in, and the filler's audio.

   One Michael (10/13): a call speaks in the voice his voice notes use.
   So the call's provider FOLLOWS the notes provider — when notes are
   ElevenLabs, the call streams ElevenLabs on the same voice id; Cartesia
   stays the call voice only where it is also the note voice, or as the
   fallback when ElevenLabs is unreachable. Override per agent with
   `{AGENT}_VOICE_MODE_TTS=cartesia|elevenlabs|gemini` (default `notes`).

   Miriam (10/13): her notes are Gemini TTS ("Aoede" + her style prompt), so
   her calls speak Gemini too (voice-tts-gemini-http.ts) — the voice a family member
   knows, not a stand-in.

   Plumbing stays split per mode (voice-tts-stream.ts header): nothing here
   touches the voice-note REST/OGG path.
   ============================================================ */

export type CallTtsProvider = "cartesia" | "elevenlabs" | "gemini";

export function elevenStreamModel(bot: Pick<BotConfig, "name">): string {
  const P = bot.name.toUpperCase();
  return process.env[`${P}_ELEVEN_STREAM_MODEL`] || process.env.ELEVEN_STREAM_MODEL || ELEVEN_STREAM_MODEL_DEFAULT;
}

/** What a call drops to if the socket refuses the streaming model. */
export function elevenStreamFallbackModel(bot: Pick<BotConfig, "name">): string {
  const P = bot.name.toUpperCase();
  return (
    process.env[`${P}_ELEVEN_STREAM_FALLBACK_MODEL`] || process.env.ELEVEN_STREAM_FALLBACK_MODEL || ELEVEN_STREAM_FALLBACK_MODEL_DEFAULT
  );
}

/** The provider a call should speak through. Pure given env. */
export function callTtsProviderFor(
  bot: Pick<BotConfig, "name" | "ttsProvider">,
  env: NodeJS.ProcessEnv = process.env,
): CallTtsProvider {
  const raw = (env[`${bot.name.toUpperCase()}_VOICE_MODE_TTS`] || env.VOICE_MODE_TTS || "notes").toLowerCase();
  const want = raw === "notes" ? bot.ttsProvider : raw;
  if (want === "elevenlabs" && env.ELEVENLABS_API_KEY) return "elevenlabs";
  if (want === "gemini" && env.GEMINI_API_KEY) return "gemini";
  return "cartesia";
}

/**
 * How an ElevenLabs call reaches the voice. `http` (default): one
 * request per sentence on the HTTP stream, because the socket refuses the v4
 * family. `socket`: the stream-input socket for the whole call — the rollback,
 * which speaks on the fallback model since v4 is refused there.
 */
export function elevenCallTransport(bot: Pick<BotConfig, "name">, env: NodeJS.ProcessEnv = process.env): "http" | "socket" {
  const raw = (env[`${bot.name.toUpperCase()}_ELEVEN_CALL_TRANSPORT`] || env.ELEVEN_CALL_TRANSPORT || "http").toLowerCase();
  return raw === "socket" ? "socket" : "http";
}

/** The Gemini TTS model a call speaks on: the notes model unless overridden. */
export function geminiCallModel(bot: Pick<BotConfig, "name">, env: NodeJS.ProcessEnv = process.env): string {
  return env[`${bot.name.toUpperCase()}_GEMINI_CALL_MODEL`] || env.GEMINI_CALL_MODEL || GEMINI_TTS_MODEL_DEFAULT;
}

/** `full` (default) sends the same style prompt the notes send; `none` sends the bare sentence. */
export function geminiCallStyle(bot: Pick<BotConfig, "name" | "styleInstructions">, env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[`${bot.name.toUpperCase()}_GEMINI_CALL_STYLE`] || env.GEMINI_CALL_STYLE || "full").toLowerCase();
  return raw === "none" ? "" : bot.styleInstructions;
}

export function createCallTtsStream(
  bot: BotConfig,
  provider: CallTtsProvider = callTtsProviderFor(bot),
  /** For log lines: the call's id. */
  label?: string,
): CallTtsStream {
  if (provider === "gemini") {
    return new GeminiHttpTtsStream({
      model: geminiCallModel(bot),
      voiceName: bot.geminiVoice,
      styleInstructions: geminiCallStyle(bot),
      label,
    });
  }
  // B3: an ElevenLabs turn that cannot finish — HTTP and its socket
  // both down — speaks its unspoken rest on Cartesia instead of going quiet.
  // Cartesia renders at ElevenLabs' sample rate so the turn's clock holds.
  const cartesiaAt = (sampleRate: number) => new VoiceTtsStream({ ...bot.cartesia, sampleRate });
  if (provider === "elevenlabs" && elevenCallTransport(bot) === "http") {
    return new FailoverTtsStream(
      new ElevenHttpTtsStream({
        eleven: bot.eleven,
        model: elevenStreamModel(bot),
        fallbackModel: elevenStreamFallbackModel(bot),
        resolveVoiceId: resolveElevenVoiceId,
        label,
      }),
      cartesiaAt,
      label,
    );
  }
  if (provider === "elevenlabs") {
    return new FailoverTtsStream(
      new ElevenTtsStream({
        eleven: bot.eleven,
        model: elevenStreamModel(bot),
        fallbackModel: elevenStreamFallbackModel(bot),
        resolveVoiceId: resolveElevenVoiceId,
      }),
      cartesiaAt,
      label,
    );
  }
  return new VoiceTtsStream(bot.cartesia);
}

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const CARTESIA_BYTES_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_VERSION = "2026-03-01";
const FILLER_RENDER_TIMEOUT_MS = 4_000;

/** The sample rate `renderFillerPcm` returns for a provider (the call stream's own). */
export function fillerSampleRate(bot: Pick<BotConfig, "cartesia">, provider: CallTtsProvider): number {
  if (provider === "gemini") return GEMINI_TTS_SAMPLE_RATE;
  if (provider === "elevenlabs") return ELEVEN_STREAM_SAMPLE_RATE;
  return bot.cartesia.sampleRate;
}

/**
 * Render one short filler line as PCM at the call's sample rate, in the same
 * voice the call is speaking. Separate from the call's streaming socket so it
 * can never collide with the answer's context.
 */
export async function renderFillerPcm(
  bot: BotConfig,
  provider: CallTtsProvider,
  text: string,
  /** The model the call is actually speaking on — the filler matches it. */
  model?: string,
): Promise<Buffer> {
  if (provider === "gemini") {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("no GEMINI_API_KEY");
    const res = await fetch(`${GEMINI_BASE}/${model || geminiCallModel(bot)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: geminiRequestBody({ voiceName: bot.geminiVoice, styleInstructions: geminiCallStyle(bot) }, text),
      signal: AbortSignal.timeout(FILLER_RENDER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
    const b64 = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!b64) throw new Error("gemini: no audio");
    const pcm = Buffer.from(b64, "base64");
    return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
  }
  if (provider === "elevenlabs") {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("no ELEVENLABS_API_KEY");
    const voiceId = await resolveElevenVoiceId(key, bot.eleven);
    const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${voiceId}/stream?output_format=pcm_${ELEVEN_STREAM_SAMPLE_RATE / 2}`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: stripAudioTags(text), model_id: model || elevenStreamModel(bot) }),
      signal: AbortSignal.timeout(FILLER_RENDER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`eleven ${res.status}`);
    return upsample2x(Buffer.from(await res.arrayBuffer()), { last: null });
  }
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error("no CARTESIA_API_KEY");
  const c = bot.cartesia;
  const res = await fetch(CARTESIA_BYTES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Cartesia-Version": CARTESIA_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: c.model,
      transcript: text,
      voice: { mode: "id", id: c.voiceId },
      language: c.language,
      speed: c.speed,
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: c.sampleRate },
    }),
    signal: AbortSignal.timeout(FILLER_RENDER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`cartesia ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The filler line, streamed (voice-speed): PCM handed to `onPcm` as the
 * voice sends it, at the same rate `renderFillerPcm` returns. A whole render
 * waited 0.7–0.8 s (p50) before the first
 * word; ElevenLabs' stream sends its first bytes in about 0.2 s. Other voices
 * have no streaming path here: their whole render is handed over at once.
 * Resolves when the line is complete; rejects on an error or `signal`.
 */
export async function streamFillerPcm(
  bot: BotConfig,
  provider: CallTtsProvider,
  text: string,
  model: string | undefined,
  onPcm: (pcm: Buffer) => void,
  signal: AbortSignal,
): Promise<void> {
  if (provider !== "elevenlabs") {
    onPcm(await renderFillerPcm(bot, provider, text, model));
    return;
  }
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("no ELEVENLABS_API_KEY");
  const voiceId = await resolveElevenVoiceId(key, bot.eleven);
  const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${voiceId}/stream?output_format=pcm_${ELEVEN_STREAM_SAMPLE_RATE / 2}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text: stripAudioTags(text), model_id: model || elevenStreamModel(bot) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(FILLER_RENDER_TIMEOUT_MS)]),
  });
  if (!res.ok || !res.body) throw new Error(`eleven ${res.status}`);
  const carry = { last: null as number | null };
  let odd: Buffer | null = null;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    let pcm = Buffer.from(chunk);
    if (odd) {
      pcm = Buffer.concat([odd, pcm]);
      odd = null;
    }
    // A network chunk can split a 16-bit sample: keep the odd byte for the next one.
    if (pcm.length % 2) {
      odd = pcm.subarray(pcm.length - 1);
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    if (pcm.length) onPcm(upsample2x(pcm, carry));
  }
}
