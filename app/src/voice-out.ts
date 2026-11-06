import OpenAI from "openai";
import { execSync, spawn } from "child_process";
import { writeFileSync, unlinkSync, readFileSync, mkdirSync, appendFile } from "fs";
import { readFile, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { resolve } from "path";
import { randomUUID } from "crypto";
import type { TTSProvider, ElevenConfig, CartesiaConfig } from "./config.js";
import { loadCartesiaConfig } from "./config.js";
import { gatewayStateRoot } from "./multi-user-paths.js";
import { logSayText, sayText } from "./voice/say-text.js";
import { unshieldChild } from "./lifecycle.js";

// Last-resort Cartesia config, used ONLY when a caller passes no `cartesia`
// (e.g. an ad-hoc script). Every real call site threads BotConfig.cartesia,
// which is env-bootstrapped and then overridden by the dashboard's saved
// settings — that is the single source of truth.
const CARTESIA_FALLBACK_CONFIG: CartesiaConfig = loadCartesiaConfig("");

export interface TTSOptions {
  text: string;
  voice?: string;
  speed?: number;
  provider?: TTSProvider;
  googleVoice?: string;   // Chirp voice name
  geminiVoice?: string;   // Gemini voice name (same name pool — Charon, Orus, etc.)
  styleInstructions?: string;  // For Gemini only — the per-agent style prompt
  languageCode?: string;
  agentName?: string;     // For the ElevenLabs/Cartesia usage counters
  eleven?: ElevenConfig;  // ElevenLabs voice config (Step 6)
  // Cartesia voice config — thread BotConfig.cartesia here. Omitting it
  // falls back to bare env defaults and should only happen in scripts.
  cartesia?: CartesiaConfig;
}

export interface TTSResult {
  audioBuffer: Buffer;
  mimeType: string;
}

// ── OpenAI client (lazy) ──────────────────────────────────────────────

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// ── Chunk limits ──────────────────────────────────────────────────────
// OpenAI: ~4096 chars per request, chunk at 3500
// Chirp:  5000 bytes per request, chunk at 4000 (English) / 2000 (Hebrew)
// Gemini: 4000 bytes text + 4000 bytes prompt, combined ≤8000. Chunk text at 3500.

const OPENAI_CHUNK_SIZE = 3500;
const CHIRP_CHUNK_SIZE = 4000;
const GEMINI_CHUNK_SIZE = 3500;
// ElevenLabs v3 accepts long text; 2500 keeps requests safe and matches the
// existing chunk/concat pattern. Splitting is bracket-aware (see
// chunkTextEleven) so a [tag] never gets cut in half.
const ELEVEN_CHUNK_SIZE = 2500;

// Resolve ffmpeg across the Mac source checkout and Linux live host.
const FFMPEG_PATH = (() => {
  for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    try {
      execSync("test -x " + p, { stdio: "ignore" });
      return p;
    } catch {}
  }
  return "ffmpeg";
})();

// A chunk must not END on a sentence this short. An LLM voice dropped "On the
// team." outright when it was the last thing in a chunk,
// so a short trailing sentence moves forward to open the next chunk instead.
const SHORT_TAIL_CHARS = 40;

/**
 * Pull `splitAt` back past any short trailing sentence(s) in the head, as long
 * as the head stays above `minSplit`. A sentence starts after `.!?` + space or
 * after a newline.
 */
function mergeShortTail(window: string, splitAt: number, minSplit: number): number {
  for (;;) {
    let prev = -1;
    for (let i = splitAt - 2; i > minSplit; i--) {
      if (window[i] === "\n" || (".!?".includes(window[i - 1]) && " \n\r".includes(window[i]))) {
        prev = i;
        break;
      }
    }
    if (prev === -1 || window.substring(prev, splitAt).trim().length >= SHORT_TAIL_CHARS) return splitAt;
    splitAt = prev;
  }
}

export function chunkText(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;
    const window = remaining.substring(0, maxSize);

    // Sentence boundaries
    for (let i = window.length - 1; i > maxSize * 0.5; i--) {
      if (".!?".includes(window[i]) && (i + 1 >= window.length || " \n\r".includes(window[i + 1]))) {
        splitAt = i + 1;
        break;
      }
    }

    // Paragraph break fallback
    if (splitAt === -1) {
      const lastNewline = window.lastIndexOf("\n", maxSize);
      if (lastNewline > maxSize * 0.3) {
        splitAt = lastNewline + 1;
      }
    }

    if (splitAt === -1) splitAt = maxSize;
    else splitAt = mergeShortTail(window, splitAt, maxSize * 0.3);

    chunks.push(remaining.substring(0, splitAt).trim());
    remaining = remaining.substring(splitAt).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

// ── OpenAI TTS ────────────────────────────────────────────────────────

async function synthesizeOpenAI(
  text: string,
  voice: string,
  speed: number,
  instructions?: string
): Promise<TTSResult> {
  const client = getOpenAIClient();
  const params: Parameters<typeof client.audio.speech.create>[0] = {
    model: "gpt-4o-mini-tts",
    voice: voice as "cedar",
    input: text,
    response_format: "opus",
    speed,
  };
  // gpt-4o-mini-tts accepts an `instructions` field for style/tone control
  if (instructions && instructions.length > 0) {
    (params as { instructions?: string }).instructions = instructions;
  }
  const response = await client.audio.speech.create(params);
  const arrayBuffer = await response.arrayBuffer();
  return { audioBuffer: Buffer.from(arrayBuffer), mimeType: "audio/ogg" };
}

// ── Google Cloud TTS (Chirp 3 HD) ─────────────────────────────────────

const CHIRP_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";

async function synthesizeChirp(
  text: string,
  voiceName: string,
  languageCode: string,
  speed: number
): Promise<TTSResult> {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) throw new Error("[tts-chirp] No GOOGLE_TTS_API_KEY set");

  const fullVoiceName = `${languageCode}-Chirp3-HD-${voiceName}`;

  const res = await fetch(CHIRP_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: fullVoiceName },
      audioConfig: { audioEncoding: "OGG_OPUS", speakingRate: speed },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[tts-chirp] ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { audioContent: string };
  return {
    audioBuffer: Buffer.from(data.audioContent, "base64"),
    mimeType: "audio/ogg",
  };
}

// ── Google Gemini 2.5 Flash TTS (with style instructions) ─────────────

const GEMINI_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Convert raw PCM (s16le @ 24000Hz mono) to OGG Opus via ffmpeg.
 * Uses tmpfiles to avoid piping large buffers through shell.
 */
export function pcmToOgg(pcmBuffer: Buffer, sampleRate = 24000): Buffer {
  const id = randomUUID();
  const pcmPath = resolve(tmpdir(), `tts-${id}.pcm`);
  const oggPath = resolve(tmpdir(), `tts-${id}.ogg`);
  try {
    writeFileSync(pcmPath, pcmBuffer);
    execSync(
      `"${FFMPEG_PATH}" -y -f s16le -ar ${sampleRate} -ac 1 -i "${pcmPath}" -c:a libopus -b:a 64k "${oggPath}" 2>/dev/null`
    );
    return readFileSync(oggPath);
  } finally {
    try { unlinkSync(pcmPath); } catch {}
    try { unlinkSync(oggPath); } catch {}
  }
}

/**
 * `pcmToOgg` without blocking the event loop.
 *
 * The sync version is fine where it has always run: a voice NOTE is
 * transcoded once, off the request path, with nothing else happening. Voice
 * MODE calls it mid-call, on the same event loop that is feeding 50 mic
 * frames a second into the recognizer and streaming reply audio back — and
 * `execSync` stops every one of those for as long as ffmpeg takes on the
 * whole reply. The user hears it as the call going deaf right after the agent
 * finishes speaking.
 *
 * Deliberately a SEPARATE function rather than a change to `pcmToOgg`: the
 * note path is outside this feature's flag and does not get touched by it.
 */
export async function pcmToOggAsync(pcmBuffer: Buffer, sampleRate = 24000): Promise<Buffer> {
  const id = randomUUID();
  const pcmPath = resolve(tmpdir(), `tts-${id}.pcm`);
  const oggPath = resolve(tmpdir(), `tts-${id}.ogg`);
  try {
    await writeFile(pcmPath, pcmBuffer);
    await new Promise<void>((resolveRun, reject) => {
      const proc = spawn(
        FFMPEG_PATH,
        // Argv, not a shell string — no quoting to get wrong, and the tmp
        // paths never reach a shell.
        ["-y", "-f", "s16le", "-ar", String(sampleRate), "-ac", "1",
         "-i", pcmPath, "-c:a", "libopus", "-b:a", "64k", oggPath],
        { stdio: "ignore" },
      );
      unshieldChild(proc.pid);
      proc.once("error", reject);
      proc.once("close", (code) =>
        code === 0 ? resolveRun() : reject(new Error(`ffmpeg exited ${code}`)),
      );
    });
    return await readFile(oggPath);
  } finally {
    await unlink(pcmPath).catch(() => {});
    await unlink(oggPath).catch(() => {});
  }
}

async function synthesizeGemini(
  text: string,
  voiceName: string,
  styleInstructions: string,
  attempt = 1
): Promise<TTSResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("[tts-gemini] No GEMINI_API_KEY set");

  const promptText = styleInstructions
    ? `${styleInstructions}\n\nNow say the following:\n\n${text}`
    : text;

  const res = await fetch(GEMINI_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
    }),
  });

  // Retry on rate limit with backoff
  if (res.status === 429 && attempt < 4) {
    const wait = attempt * 15000;
    console.warn(`[tts-gemini] rate limited, retrying in ${wait / 1000}s (attempt ${attempt}/3)`);
    await new Promise((r) => setTimeout(r, wait));
    return synthesizeGemini(text, voiceName, styleInstructions, attempt + 1);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[tts-gemini] ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ inlineData?: { data: string; mimeType: string } }> };
    }>;
  };

  const audioPart = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!audioPart) {
    const reason = data.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`[tts-gemini] No audio in response. finishReason: ${reason}`);
  }

  const pcm = Buffer.from(audioPart.data, "base64");

  // Extract sample rate from MIME if present (e.g. "audio/L16;codec=pcm;rate=24000")
  const rateMatch = audioPart.mimeType.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

  const oggBuffer = pcmToOgg(pcm, sampleRate);

  return {
    audioBuffer: oggBuffer,
    mimeType: "audio/ogg",
  };
}

// ── ElevenLabs v3 (Step 6 — michael's "Daniel" voice) ─────────────────
//
// v3 is directed by inline audio tags ([dry], [pause], [chuckles], ...)
// authored by the agent inside its spoken text. The text passes through
// UNTOUCHED — never strip tags here. Style prompts (voice-styles.ts) do
// not apply to this provider.

const ELEVEN_TTS_BASE = "https://api.elevenlabs.io/v1";
// Synthesis budget: v3 renders long text slower than realtime — a ~2.2k-char
// voice note blew the original 30s and fell back to cedar. Voice notes are
// produced, not real-time, so latency is acceptable; the metadata lookups
// below stay on a short leash.
const ELEVEN_SYNTH_TIMEOUT_MS = 120_000;
const ELEVEN_LOOKUP_TIMEOUT_MS = 30_000;
// Append-only spend ledgers (read by scripts/elevenlabs-usage.mjs and the
// costs view). Not a corruption risk, but they ARE accounting: an isolated
// test instance billing its own synthesis into production's ledger makes the
// numbers wrong, so they move with the state root like everything else there.
const VOICE_USAGE_DIR = resolve(gatewayStateRoot(), "voice-usage");
const ELEVEN_USAGE_LOG = resolve(VOICE_USAGE_DIR, "elevenlabs.jsonl");

/**
 * Like chunkText, but never splits inside a [tag] and never mid-word
 * (a hard split can land mid-Hebrew-word; we fall back to the last
 * whitespace instead). Sentence boundary → newline → whitespace → hard.
 */
export function chunkTextEleven(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    const window = remaining.substring(0, maxSize);
    let splitAt = -1;

    for (let i = window.length - 1; i > maxSize * 0.5; i--) {
      if (".!?".includes(window[i]) && (i + 1 >= window.length || " \n\r".includes(window[i + 1]))) {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt === -1) {
      const lastNewline = window.lastIndexOf("\n");
      if (lastNewline > maxSize * 0.3) splitAt = lastNewline + 1;
    }
    if (splitAt !== -1) splitAt = mergeShortTail(window, splitAt, maxSize * 0.3);
    if (splitAt === -1) {
      const lastSpace = window.lastIndexOf(" ");
      if (lastSpace > maxSize * 0.3) splitAt = lastSpace + 1;
    }
    if (splitAt === -1) splitAt = maxSize; // degenerate: no whitespace at all

    // Never split inside a [tag]: if the head has an unclosed '[', back up
    // to just before it.
    const head = window.substring(0, splitAt);
    const lastOpen = head.lastIndexOf("[");
    if (lastOpen !== -1 && head.indexOf("]", lastOpen) === -1) {
      if (lastOpen > 0) splitAt = lastOpen;
    }

    chunks.push(remaining.substring(0, splitAt).trim());
    remaining = remaining.substring(splitAt).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

/** Convert mp3 (ElevenLabs default output) to OGG Opus via ffmpeg. */
function mp3ToOgg(mp3Buffer: Buffer): Buffer {
  const id = randomUUID();
  const mp3Path = resolve(tmpdir(), `tts-${id}.mp3`);
  const oggPath = resolve(tmpdir(), `tts-${id}.ogg`);
  try {
    writeFileSync(mp3Path, mp3Buffer);
    execSync(
      `"${FFMPEG_PATH}" -y -i "${mp3Path}" -c:a libopus -b:a 64k "${oggPath}" 2>/dev/null`
    );
    return readFileSync(oggPath);
  } finally {
    try { unlinkSync(mp3Path); } catch {}
    try { unlinkSync(oggPath); } catch {}
  }
}

// In-process cache: saved-voice name (lowercased) → voice_id.
const elevenVoiceIdCache = new Map<string, string>();

export async function resolveElevenVoiceId(apiKey: string, eleven: ElevenConfig): Promise<string> {
  if (eleven.voiceId) return eleven.voiceId;

  const cacheKey = eleven.voiceName.toLowerCase();
  const cached = elevenVoiceIdCache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(`${ELEVEN_TTS_BASE}/voices`, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(ELEVEN_LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`[tts-eleven] voice lookup failed ${res.status}: ${(await res.text()).substring(0, 200)}`);
  }
  const data = (await res.json()) as {
    voices?: Array<{ voice_id: string; name: string; category?: string }>;
  };
  const voices = data.voices ?? [];

  // Exact name match first; otherwise prefix match ("Daniel" matches
  // "Daniel - Clean, Balanced and Clear"). The owner's saved voices coexist with
  // ElevenLabs' stock premades (which include their own "Daniel - Steady
  // Broadcaster"), so on an ambiguous prefix we prefer non-premade
  // categories — the voice the owner deliberately added, not the stock one.
  let match = voices.find((v) => v.name?.toLowerCase() === cacheKey);
  if (!match) {
    const prefixed = voices.filter((v) => v.name?.toLowerCase().startsWith(`${cacheKey} `));
    const nonPremade = prefixed.filter((v) => v.category && v.category !== "premade");
    const pool = nonPremade.length > 0 ? nonPremade : prefixed;
    if (pool.length === 1 || (pool.length > 1 && nonPremade.length === 1)) {
      match = pool[0];
    } else if (pool.length > 1) {
      throw new Error(
        `[tts-eleven] voice name "${eleven.voiceName}" is ambiguous: ` +
          `${pool.map((v) => `"${v.name}" (${v.category})`).join(", ")}. ` +
          `Set MICHAEL_ELEVEN_VOICE_ID to pick one.`,
      );
    }
  }
  if (!match) {
    const available = voices.map((v) => v.name).join(", ") || "none";
    throw new Error(`[tts-eleven] saved voice "${eleven.voiceName}" not found. Available: ${available}`);
  }
  elevenVoiceIdCache.set(cacheKey, match.voice_id);
  console.log(
    `[tts-eleven] resolved voice "${eleven.voiceName}" → "${match.name}" (${match.category}) ${match.voice_id}`,
  );
  return match.voice_id;
}

async function synthesizeElevenLabs(text: string, eleven: ElevenConfig): Promise<TTSResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("[tts-eleven] No ELEVENLABS_API_KEY set");

  const voiceId = await resolveElevenVoiceId(apiKey, eleven);

  // Default output is mp3_44100_128 — transcode to OGG Opus to match the
  // voice-note pipeline's output contract (same as the other providers).
  const res = await fetch(`${ELEVEN_TTS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, model_id: eleven.model }),
    signal: AbortSignal.timeout(ELEVEN_SYNTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`[tts-eleven] ${res.status}: ${(await res.text()).substring(0, 300)}`);
  }

  const mp3 = Buffer.from(await res.arrayBuffer());
  return { audioBuffer: mp3ToOgg(mp3), mimeType: "audio/ogg" };
}

/**
 * Usage counter — the whole point of the experiment. One JSON line per
 * reply that used ElevenLabs; chars = text length INCLUDING tags (that is
 * what ElevenLabs bills — 1 char = 1 credit on v3). Fire-and-forget: the
 * subscription read for remainingCredits is best-effort and nothing here
 * may fail the reply.
 */
function logElevenUsage(agent: string, chars: number, chunks: number, eleven: ElevenConfig): void {
  void (async () => {
    let remainingCredits: number | null = null;
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (apiKey) {
        const res = await fetch(`${ELEVEN_TTS_BASE}/user/subscription`, {
          headers: { "xi-api-key": apiKey },
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const sub = (await res.json()) as { character_count?: number; character_limit?: number };
          if (typeof sub.character_count === "number" && typeof sub.character_limit === "number") {
            remainingCredits = sub.character_limit - sub.character_count;
          }
        }
      }
    } catch {}
    try {
      mkdirSync(VOICE_USAGE_DIR, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        agent,
        chars,
        chunks,
        model: eleven.model,
        voiceName: eleven.voiceName,
        ...(remainingCredits !== null ? { remainingCredits } : {}),
      });
      appendFile(ELEVEN_USAGE_LOG, line + "\n", (err) => {
        if (err) console.warn(`[tts-eleven] usage log write failed: ${err.message}`);
      });
    } catch (err) {
      console.warn(`[tts-eleven] usage log failed: ${(err as Error).message}`);
    }
  })();
}

// ── Cartesia Sonic (Voice Mode Phase 1 — michael's "Benedict" voice) ──
//
// Sonic takes the transcript as written: no style prompt, no audio tags.
// We ask for raw PCM and run it through the SAME pcmToOgg helper the Gemini
// path uses, so Cartesia lands on the pipeline's OGG-Opus output contract
// with exactly one lossy stage (mp3 would add a second).
//
// English only on this voice for now. Hebrew is a separate localized
// voice_id (later ticket) — stray Hebrew inside an English line should be
// transliterated upstream so Benedict says it in-voice.

const CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_VERSION = "2026-03-01";
// Sonic renders faster than realtime, but a long voice note is still a long
// request; matched to the ElevenLabs synthesis budget.
const CARTESIA_SYNTH_TIMEOUT_MS = 120_000;
const CARTESIA_CHUNK_SIZE = 2500;
const CARTESIA_USAGE_LOG = resolve(VOICE_USAGE_DIR, "cartesia.jsonl");

async function synthesizeCartesia(text: string, cartesia: CartesiaConfig): Promise<TTSResult> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) throw new Error("[tts-cartesia] No CARTESIA_API_KEY set");

  const res = await fetch(CARTESIA_TTS_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Cartesia-Version": CARTESIA_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: cartesia.model,
      transcript: text,
      voice: { mode: "id", id: cartesia.voiceId },
      language: cartesia.language,
      speed: cartesia.speed,
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: cartesia.sampleRate,
      },
    }),
    signal: AbortSignal.timeout(CARTESIA_SYNTH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`[tts-cartesia] ${res.status}: ${(await res.text()).substring(0, 300)}`);
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length === 0) throw new Error("[tts-cartesia] empty audio response");

  return { audioBuffer: pcmToOgg(pcm, cartesia.sampleRate), mimeType: "audio/ogg" };
}

/**
 * Credit counter — Cartesia bills ~1 credit per character, and the owner is on a
 * fixed free-plan allotment, so every reply that used Sonic gets a line.
 * Fire-and-forget: nothing here may fail a reply.
 */
function logCartesiaUsage(agent: string, chars: number, chunks: number, cartesia: CartesiaConfig): void {
  try {
    mkdirSync(VOICE_USAGE_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agent,
      chars,
      chunks,
      model: cartesia.model,
      voiceId: cartesia.voiceId,
      language: cartesia.language,
    });
    appendFile(CARTESIA_USAGE_LOG, line + "\n", (err) => {
      if (err) console.warn(`[tts-cartesia] usage log write failed: ${err.message}`);
    });
  } catch (err) {
    console.warn(`[tts-cartesia] usage log failed: ${(err as Error).message}`);
  }
}

const ELEVEN_DEFAULTS: ElevenConfig = {
  voiceName: "Daniel",
  model: "eleven_v4_turbo",
  fallbackProvider: "openai",
};

// ── Unified synthesis ─────────────────────────────────────────────────

interface ChunkCtx {
  voice: string;
  speed: number;
  googleVoice: string;
  geminiVoice: string;
  styleInstructions: string;
  lang: string;
  eleven: ElevenConfig;
  cartesia: CartesiaConfig;
  agentName: string;
  // Per-reply tally of chunks that ElevenLabs actually synthesized (excludes
  // fallback chunks) — flushed to the usage log by the caller.
  elevenTally: { chars: number; chunks: number };
  // Same, for Cartesia credits.
  cartesiaTally: { chars: number; chunks: number };
}

async function synthesizeChunk(text: string, provider: TTSProvider, ctx: ChunkCtx): Promise<TTSResult> {
  if (provider === "cartesia") {
    try {
      const result = await synthesizeCartesia(text, ctx.cartesia);
      ctx.cartesiaTally.chars += text.length;
      ctx.cartesiaTally.chunks += 1;
      return result;
    } catch (err) {
      // Fail-soft, same contract as ElevenLabs: out of credits, 5xx, network,
      // bad voice_id — LOG and fall back. A TTS outage never eats a reply.
      const fallback = ctx.cartesia.fallbackProvider === "cartesia" ? "openai" : ctx.cartesia.fallbackProvider;
      console.error(
        `[tts-cartesia] synthesis failed, falling back to "${fallback}": ${(err as Error).message}`,
      );
      return synthesizeChunk(text, fallback, ctx);
    }
  }
  if (provider === "elevenlabs") {
    try {
      const result = await synthesizeElevenLabs(text, ctx.eleven);
      ctx.elevenTally.chars += text.length;
      ctx.elevenTally.chunks += 1;
      return result;
    } catch (err) {
      // Fail-soft: 429 quota, 5xx, network, bad voice — LOG and fall back to
      // the agent's previous provider chain. A TTS outage never eats a reply.
      const fallback = ctx.eleven.fallbackProvider === "elevenlabs" ? "openai" : ctx.eleven.fallbackProvider;
      console.error(
        `[tts-eleven] synthesis failed, falling back to "${fallback}": ${(err as Error).message}`,
      );
      return synthesizeChunk(text, fallback, ctx);
    }
  }
  if (provider === "gemini") {
    return synthesizeGemini(text, ctx.geminiVoice, ctx.styleInstructions);
  }
  if (provider === "google" || provider === "chirp") {
    return synthesizeChirp(text, ctx.googleVoice, ctx.lang, ctx.speed);
  }
  return synthesizeOpenAI(text, ctx.voice, ctx.speed, ctx.styleInstructions);
}

function detectLanguage(text: string): string {
  const hebrewChars = text.match(/[\u0590-\u05FF]/g);
  if (hebrewChars && hebrewChars.length > text.length * 0.3) {
    return "he-IL";
  }
  return "en-US";
}

function getChunkSize(provider: TTSProvider, lang: string): number {
  if (provider === "cartesia") return CARTESIA_CHUNK_SIZE;
  if (provider === "elevenlabs") return ELEVEN_CHUNK_SIZE;
  if (provider === "gemini") return GEMINI_CHUNK_SIZE;
  if (provider === "google" || provider === "chirp") {
    return lang === "he-IL" ? 2000 : CHIRP_CHUNK_SIZE;
  }
  return OPENAI_CHUNK_SIZE;
}

function envKeyPresent(provider: TTSProvider): boolean {
  if (provider === "cartesia") return !!process.env.CARTESIA_API_KEY;
  if (provider === "elevenlabs") return !!process.env.ELEVENLABS_API_KEY;
  if (provider === "gemini") return !!process.env.GEMINI_API_KEY;
  if (provider === "google" || provider === "chirp") return !!process.env.GOOGLE_TTS_API_KEY;
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Entry-level provider resolution: if elevenlabs is configured but its key
 * is missing, fall straight back to the agent's fallback provider (spec §1
 * fail-soft — a reply must always go out). Returns null if no usable
 * provider has a key.
 */
function resolveProvider(
  provider: TTSProvider,
  eleven: ElevenConfig,
  cartesia: CartesiaConfig,
): TTSProvider | null {
  if (provider === "cartesia" && !process.env.CARTESIA_API_KEY) {
    const fallback = cartesia.fallbackProvider === "cartesia" ? "openai" : cartesia.fallbackProvider;
    console.error(`[tts-cartesia] No CARTESIA_API_KEY — falling back to "${fallback}"`);
    provider = fallback;
  }
  if (provider === "elevenlabs" && !process.env.ELEVENLABS_API_KEY) {
    const fallback = eleven.fallbackProvider === "elevenlabs" ? "openai" : eleven.fallbackProvider;
    console.error(`[tts-eleven] No ELEVENLABS_API_KEY — falling back to "${fallback}"`);
    provider = fallback;
  }
  return envKeyPresent(provider) ? provider : null;
}

/** Shared per-call setup for both public entry points. */
function prepareCall(opts: TTSOptions): {
  provider: TTSProvider;
  chunks: string[];
  lang: string;
  voiceLabel: string;
  ctx: ChunkCtx;
} | null {
  const {
    text: written,
    voice = "cedar",
    speed = 1.0,
    googleVoice = "Charon",
    geminiVoice = "Charon",
    styleInstructions = "",
    languageCode,
    agentName = "unknown",
    eleven = ELEVEN_DEFAULTS,
  } = opts;

  const cartesia = opts.cartesia ?? CARTESIA_FALLBACK_CONFIG;

  const provider = resolveProvider(opts.provider ?? "openai", eleven, cartesia);
  if (!provider) {
    console.warn(`[tts] No API key for provider "${opts.provider}" — skipping TTS`);
    return null;
  }
  if (!written || written.length < 2) return null;
  // Every provider gets the text as it should be SAID: no period after an
  // initial ("Y. Orzechowitz"), no "one." <pause> on a numbered line.
  const text = sayText(written);
  logSayText("voice-note", written, text);

  const lang = languageCode || detectLanguage(text);
  const chunkSize = getChunkSize(provider, lang);
  // ElevenLabs text carries [tags]; use the bracket-aware splitter.
  const chunks = provider === "elevenlabs" ? chunkTextEleven(text, chunkSize) : chunkText(text, chunkSize);
  const voiceLabel =
    provider === "cartesia" ? cartesia.voiceName :
    provider === "elevenlabs" ? eleven.voiceName :
    provider === "gemini" ? geminiVoice :
    provider === "openai" ? voice : googleVoice;

  return {
    provider,
    chunks,
    lang,
    voiceLabel,
    ctx: {
      voice, speed, googleVoice, geminiVoice, styleInstructions, lang,
      eleven, cartesia, agentName,
      elevenTally: { chars: 0, chunks: 0 },
      cartesiaTally: { chars: 0, chunks: 0 },
    },
  };
}

function flushTallies(ctx: ChunkCtx): void {
  if (ctx.elevenTally.chunks > 0) {
    logElevenUsage(ctx.agentName, ctx.elevenTally.chars, ctx.elevenTally.chunks, ctx.eleven);
  }
  if (ctx.cartesiaTally.chunks > 0) {
    logCartesiaUsage(ctx.agentName, ctx.cartesiaTally.chars, ctx.cartesiaTally.chunks, ctx.cartesia);
  }
}

// Telegram caps a multipart sendVoice upload at 50 MB (Bot API, "Sending
// files"). Stay a little under it. At the 64 kbps the join encodes to, that
// is roughly 100 minutes of speech — a reply never gets near it in practice.
export const TELEGRAM_VOICE_MAX_BYTES = 48 * 1024 * 1024;

// Every provider's chunk is decoded to this, so a reply whose chunks came from
// different providers (fail-soft fallback mid-reply) still joins cleanly.
// 48 kHz is Opus's native rate.
const JOIN_SAMPLE_RATE = 48000;

function oggToPcmAsync(oggBuffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolveRun, reject) => {
    const proc = spawn(
      FFMPEG_PATH,
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0",
       "-f", "s16le", "-ac", "1", "-ar", String(JOIN_SAMPLE_RATE), "pipe:1"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    unshieldChild(proc.pid);
    const out: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.once("error", reject);
    proc.stdin.on("error", () => {}); // surfaced by the exit code instead
    proc.once("close", (code) =>
      code === 0 ? resolveRun(Buffer.concat(out)) : reject(new Error(`ffmpeg decode exited ${code}`)),
    );
    proc.stdin.end(oggBuffer);
  });
}

/**
 * Join per-chunk OGG/Opus notes into ONE Opus stream: decode every chunk to
 * PCM, concatenate, encode once. Byte-concatenating the OGG files instead
 * gives a chained stream whose duration metadata is only the last link's, so
 * players show the wrong length and some stop at the first boundary.
 */
export async function joinOggChunks(buffers: Buffer[]): Promise<Buffer> {
  if (buffers.length === 1) return buffers[0];
  const pcm: Buffer[] = [];
  for (const buf of buffers) pcm.push(await oggToPcmAsync(buf));
  return pcmToOggAsync(Buffer.concat(pcm), JOIN_SAMPLE_RATE);
}

/** Every chunk of a reply, synthesized in order. Flushes the usage tallies. */
async function synthesizeChunks(opts: TTSOptions, mode: string): Promise<TTSResult[]> {
  const prepared = prepareCall(opts);
  if (!prepared) return [];
  const { provider, chunks, lang, voiceLabel, ctx } = prepared;

  console.log(
    chunks.length === 1
      ? `[tts:${provider}] ${chunks[0].length} chars, voice "${voiceLabel}" (${lang})`
      : `[tts:${provider}] ${opts.text.length} chars in ${chunks.length} chunks ${mode}, voice "${voiceLabel}" (${lang})`,
  );
  const results: TTSResult[] = [];
  for (const chunk of chunks) {
    results.push(await chunkSynthesizer(chunk, provider, ctx));
  }
  flushTallies(ctx);
  return results;
}

type ChunkSynthesizer = (text: string, provider: TTSProvider) => Promise<TTSResult>;
let chunkSynthesizer: (text: string, provider: TTSProvider, ctx: ChunkCtx) => Promise<TTSResult> = synthesizeChunk;

/** Test seam: replace the per-chunk provider call (no network, no spend). */
export function __setChunkSynthesizerForTests(fn: ChunkSynthesizer | null): void {
  chunkSynthesizer = fn ?? synthesizeChunk;
}

/**
 * Synthesize speech as one OGG/Opus note, however long the text. Supports
 * OpenAI, Chirp 3 HD, Gemini Flash TTS, ElevenLabs v3 and Cartesia (with
 * fail-soft fallback to the agent's previous provider).
 */
export async function synthesizeSpeech(opts: TTSOptions): Promise<TTSResult | null> {
  const results = await synthesizeChunks(opts, "joined into one note");
  if (results.length === 0) return null;
  const buffers = results.map((r) => r.audioBuffer);
  try {
    return { audioBuffer: await joinOggChunks(buffers), mimeType: "audio/ogg" };
  } catch (err) {
    // The audio is already paid for; never lose it to the join. A chained
    // OGG still plays, just with the wrong length shown.
    console.error(`[tts] join failed, byte-concatenating ${buffers.length} chunks: ${(err as Error).message}`);
    return { audioBuffer: Buffer.concat(buffers), mimeType: "audio/ogg" };
  }
}

/**
 * The voice-note reply path (dashboard and Telegram): ONE note, however long
 * the reply. Only if the joined note would exceed `maxBytes` (Telegram's
 * upload cap) does it fall back to the per-chunk parts — already synthesized,
 * so the fallback costs no extra TTS.
 */
export async function synthesizeVoiceNotes(
  opts: TTSOptions,
  maxBytes = TELEGRAM_VOICE_MAX_BYTES,
): Promise<TTSResult[]> {
  const results = await synthesizeChunks(opts, "joined into one note");
  if (results.length <= 1) return results;
  let joined: Buffer;
  try {
    joined = await joinOggChunks(results.map((r) => r.audioBuffer));
  } catch (err) {
    console.error(`[tts] join failed, sending ${results.length} parts: ${(err as Error).message}`);
    return results;
  }
  if (joined.length <= maxBytes) return [{ audioBuffer: joined, mimeType: "audio/ogg" }];
  console.warn(
    `[tts] joined note is ${joined.length} bytes, over the ${maxBytes}-byte voice cap — ` +
      `sending ${results.length} parts instead`,
  );
  return results;
}

/**
 * Synthesize speech as separate voice notes (multi-part responses).
 */
export async function synthesizeSpeechChunked(opts: TTSOptions): Promise<TTSResult[]> {
  return synthesizeChunks(opts, "as separate voice notes");
}
