import OpenAI from "openai";
import { toFile } from "openai";

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

let openaiClient: OpenAI | null = null;

const AHI_VOCAB = "Conversation between a person and their AHI agents. Proper nouns that may appear: Michael, Zali, Avi, Miriam, AHI.";

function getClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// MIME types the transcriber reads, with the file extension OpenAI expects for each.
const TRANSCRIBE_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/oga": "ogg",
  "audio/opus": "opus",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

/** Whether a recording of this MIME type can be transcribed as it is, without converting it first. */
export const transcribable = (mime: string): boolean => Object.hasOwn(TRANSCRIBE_EXT, mime);

/** Cartesia's API version, as the rest of the server sends it (voice-out.ts, voice-tts-stream.ts). */
const CARTESIA_VERSION = "2026-03-01";

/**
 * Which batch transcriber voice notes use: OpenAI when its key is set, else Cartesia (setup can save Cartesia as the
 * only listening provider). Null when neither key is set.
 */
export function noteTranscriber(env: NodeJS.ProcessEnv = process.env): "openai" | "cartesia" | null {
  if (env.OPENAI_API_KEY) return "openai";
  if (env.CARTESIA_API_KEY) return "cartesia";
  return null;
}

export async function transcribeAudio(
  fileBuffer: Buffer,
  mimeType: string,
  { env = process.env, fetchImpl = fetch }: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<TranscriptionResult> {
  const ext = TRANSCRIBE_EXT[mimeType] || "ogg";
  const provider = noteTranscriber(env);
  if (!provider) throw new Error("Voice notes need an OpenAI or Cartesia key to be transcribed. Add one in AHI Setup → Find your voice.");

  if (provider === "cartesia") {
    // Cartesia batch speech-to-text: multipart file + model, answered with { text, language, duration }.
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), `voice.${ext}`);
    form.append("model", env.CARTESIA_STT_MODEL || "ink-whisper");
    const res = await fetchImpl("https://api.cartesia.ai/stt", {
      method: "POST",
      headers: { "X-API-Key": env.CARTESIA_API_KEY as string, "Cartesia-Version": CARTESIA_VERSION },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Cartesia could not transcribe the voice note (HTTP ${res.status}).`);
    const out = (await res.json()) as { text?: unknown; language?: unknown; duration?: unknown };
    const text = typeof out.text === "string" ? out.text : "";
    console.log(`[stt] Transcribed via Cartesia: "${text.substring(0, 80)}..." (${ext})`);
    return {
      text,
      language: typeof out.language === "string" ? out.language : undefined,
      duration: typeof out.duration === "number" ? out.duration : undefined,
    };
  }

  const client = getClient();
  const file = await toFile(fileBuffer, `voice.${ext}`, { type: mimeType });
  const transcription = await client.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file,
    prompt: AHI_VOCAB,
  });

  console.log(`[stt] Transcribed: "${transcription.text.substring(0, 80)}..." (${ext})`);

  return {
    text: transcription.text,
  };
}

export async function downloadTelegramFile(
  fileId: string,
  botToken: string
): Promise<Buffer> {
  const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
  const fileInfo = (await fetch(fileInfoUrl).then((r) => r.json())) as {
    result: { file_path: string };
  };
  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const response = await fetch(fileUrl);
  return Buffer.from(await response.arrayBuffer());
}
