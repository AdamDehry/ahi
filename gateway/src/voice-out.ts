import OpenAI from "openai";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { randomUUID } from "crypto";
import type { TTSProvider } from "./config.js";

export interface TTSOptions {
  text: string;
  voice?: string;
  speed?: number;
  provider?: TTSProvider;
  googleVoice?: string;   // Chirp voice name
  geminiVoice?: string;   // Gemini voice name (same name pool — Charon, Orus, etc.)
  styleInstructions?: string;  // For Gemini only — the per-agent style prompt
  languageCode?: string;
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

// Hard-coded ffmpeg path — LaunchAgents don't inherit homebrew PATH
const FFMPEG_PATH = "/opt/homebrew/bin/ffmpeg";

function chunkText(text: string, maxSize: number): string[] {
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
function pcmToOgg(pcmBuffer: Buffer, sampleRate = 24000): Buffer {
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

// ── Unified synthesis ─────────────────────────────────────────────────

async function synthesizeChunk(
  text: string,
  voice: string,
  speed: number,
  provider: TTSProvider,
  googleVoice: string,
  geminiVoice: string,
  styleInstructions: string,
  languageCode: string
): Promise<TTSResult> {
  if (provider === "gemini") {
    return synthesizeGemini(text, geminiVoice, styleInstructions);
  }
  if (provider === "google" || provider === "chirp") {
    return synthesizeChirp(text, googleVoice, languageCode, speed);
  }
  return synthesizeOpenAI(text, voice, speed, styleInstructions);
}

function detectLanguage(text: string): string {
  const hebrewChars = text.match(/[\u0590-\u05FF]/g);
  if (hebrewChars && hebrewChars.length > text.length * 0.3) {
    return "he-IL";
  }
  return "en-US";
}

function getChunkSize(provider: TTSProvider, lang: string): number {
  if (provider === "gemini") return GEMINI_CHUNK_SIZE;
  if (provider === "google" || provider === "chirp") {
    return lang === "he-IL" ? 2000 : CHIRP_CHUNK_SIZE;
  }
  return OPENAI_CHUNK_SIZE;
}

function envKeyPresent(provider: TTSProvider): boolean {
  if (provider === "gemini") return !!process.env.GEMINI_API_KEY;
  if (provider === "google" || provider === "chirp") return !!process.env.GOOGLE_TTS_API_KEY;
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Synthesize speech. Supports OpenAI, Chirp 3 HD, and Gemini Flash TTS.
 */
export async function synthesizeSpeech(opts: TTSOptions): Promise<TTSResult | null> {
  const {
    text,
    voice = "cedar",
    speed = 1.0,
    provider = "openai",
    googleVoice = "Charon",
    geminiVoice = "Charon",
    styleInstructions = "",
    languageCode,
  } = opts;

  if (!envKeyPresent(provider)) {
    console.warn(`[tts] No API key for provider "${provider}" — skipping TTS`);
    return null;
  }
  if (!text || text.length < 2) return null;

  const lang = languageCode || detectLanguage(text);
  const chunkSize = getChunkSize(provider, lang);
  const chunks = chunkText(text, chunkSize);
  const voiceLabel = provider === "gemini" ? geminiVoice : provider === "openai" ? voice : googleVoice;

  if (chunks.length === 1) {
    console.log(`[tts:${provider}] ${chunks[0].length} chars, voice "${voiceLabel}" (${lang})`);
    return synthesizeChunk(chunks[0], voice, speed, provider, googleVoice, geminiVoice, styleInstructions, lang);
  }

  console.log(`[tts:${provider}] ${text.length} chars in ${chunks.length} chunks, voice "${voiceLabel}" (${lang})`);
  const results: Buffer[] = [];
  for (const chunk of chunks) {
    const result = await synthesizeChunk(chunk, voice, speed, provider, googleVoice, geminiVoice, styleInstructions, lang);
    results.push(result.audioBuffer);
  }

  return { audioBuffer: Buffer.concat(results), mimeType: "audio/ogg" };
}

/**
 * Synthesize speech as separate voice notes (multi-part responses).
 */
export async function synthesizeSpeechChunked(opts: TTSOptions): Promise<TTSResult[]> {
  const {
    text,
    voice = "cedar",
    speed = 1.0,
    provider = "openai",
    googleVoice = "Charon",
    geminiVoice = "Charon",
    styleInstructions = "",
    languageCode,
  } = opts;

  if (!envKeyPresent(provider) || !text || text.length < 2) return [];

  const lang = languageCode || detectLanguage(text);
  const chunkSize = getChunkSize(provider, lang);
  const chunks = chunkText(text, chunkSize);
  const voiceLabel = provider === "gemini" ? geminiVoice : provider === "openai" ? voice : googleVoice;

  console.log(`[tts:${provider}] ${text.length} chars as ${chunks.length} separate voice notes, voice "${voiceLabel}" (${lang})`);

  const results: TTSResult[] = [];
  for (const chunk of chunks) {
    results.push(await synthesizeChunk(chunk, voice, speed, provider, googleVoice, geminiVoice, styleInstructions, lang));
  }
  return results;
}
