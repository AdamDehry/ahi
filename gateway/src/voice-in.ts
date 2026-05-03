import OpenAI from "openai";
import { toFile } from "openai";

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

export async function transcribeAudio(
  fileBuffer: Buffer,
  mimeType: string
): Promise<TranscriptionResult> {
  const client = getClient();

  // Map MIME types to file extensions OpenAI expects
  const extMap: Record<string, string> = {
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
  const ext = extMap[mimeType] || "ogg";

  const file = await toFile(fileBuffer, `voice.${ext}`, { type: mimeType });

  const transcription = await client.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file,
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
