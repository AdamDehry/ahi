/* ============================================================
   voice-media.ts — MAT RELAY CP2 / P0 (canonical voice reply upsert)

   Saves an outbound TTS audio buffer to the user's media store and
   registers it so it can be referenced by a persisted message and
   served over /ui/media/:id. Used by the PWA Voice Mode reply path
   (index.ts) to turn a fast text out-message into a durable voice
   message once TTS finishes — so a reconnect/delta shows the voice
   reply instead of stale text.

   The dashboard's own /ui/voice-send path has an equivalent inline
   helper (registerDashboardOutboundVoice) that additionally probes
   exact duration via ffprobe; this leaner version estimates from
   word count to avoid adding ffprobe latency on the live voice
   turn (the <audio> element reports true duration on load anyway).
   ============================================================ */

import { saveTelegramMediaFile, registerMedia, mediaRef, type MediaRef } from "./media-store.js";

function audioExtFromMime(mime: string): string {
  const normalized = (mime || "").split(";")[0].trim().toLowerCase();
  const byMime: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/oga": "ogg",
    "audio/opus": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/aac": "aac",
    "audio/webm": "webm",
  };
  return byMime[normalized] || "ogg";
}

function estimateVoiceDurationSec(text: string): number {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 2.6));
}

/**
 * Persist + register an outbound voice reply's audio. Returns the
 * public MediaRef and an estimated duration, or null on failure
 * (caller keeps the text reply — nothing is lost).
 */
export async function registerOutboundVoiceMedia(opts: {
  userId: string;
  bot: string;
  audioBuffer: Buffer;
  mimeType: string;
  transcript: string;
}): Promise<{ media: MediaRef; durationSec: number } | null> {
  try {
    if (!opts.audioBuffer || opts.audioBuffer.length === 0) return null;
    const ext = audioExtFromMime(opts.mimeType);
    const filename = `${opts.bot}-voice-reply-${Date.now()}.${ext}`;
    const filePath = await saveTelegramMediaFile(opts.userId, filename, opts.audioBuffer);
    const durationSec = estimateVoiceDurationSec(opts.transcript);
    const record = await registerMedia({
      userId: opts.userId,
      bot: opts.bot,
      source: "ui-upload",
      type: "voice",
      filePath,
      originalName: filename,
      mime: opts.mimeType || `audio/${ext}`,
      durationSec,
      transcript: opts.transcript,
    });
    return { media: mediaRef(record), durationSec };
  } catch (err) {
    console.warn(`[voice-media] outbound voice register failed: ${(err as Error).message}`);
    return null;
  }
}
