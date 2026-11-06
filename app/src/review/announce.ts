/**
 * announce.ts — a new review card, said in the owner's chat by Michael.
 *
 * One message, with a voice note of the same words, delivered by ONE
 * broadcast — so it is persisted once and pushes once (websocket.ts →
 * sendPushForMessage). That push is the card's only notification, and its tap
 * opens the card in Review (meta.review → /?review=<id>).
 *
 * TTS first, then the broadcast: the usual voice-reply pattern (a fast text
 * record later upgraded in place) would push twice. A one-sentence note takes
 * a second or two to synthesise. If TTS is off or fails, the same words go out
 * as text — still one message, still one push. Never to Telegram.
 */
import type { MessageEvent } from "../websocket.js";
import type { MediaRef } from "../media-store.js";

export interface AnnounceDeps {
  /** Synthesise the note and register its media; null when TTS is unavailable. */
  voiceNote(bot: string, userId: string, text: string): Promise<{ media: MediaRef; durationSec: number } | null>;
  /** Persist + deliver (production: websocket broadcast, which also pushes). */
  broadcast(event: MessageEvent): void;
  user(userId: string): { name: string; telegramChatId?: number | null } | null;
}

export async function announceCard(
  deps: AnnounceDeps,
  msg: { userId: string; bot: string; text: string; itemId: string; turnId: string },
): Promise<MessageEvent> {
  let voice: { media: MediaRef; durationSec: number } | null = null;
  try {
    voice = await deps.voiceNote(msg.bot, msg.userId, msg.text);
  } catch (err) {
    console.warn(`[review] card voice note failed — sending text: ${(err as Error).message}`);
  }
  const user = deps.user(msg.userId);
  const event: MessageEvent = {
    type: "message",
    bot: msg.bot,
    direction: "out",
    contentType: voice ? "voice" : "text",
    text: msg.text,
    timestamp: new Date().toISOString(),
    chatId: user?.telegramChatId ?? 0,
    userId: msg.userId,
    senderName: user?.name ?? msg.userId,
    source: "app",
    meta: { turnId: msg.turnId, review: { item: msg.itemId }, ...(voice ? { voiceDuration: voice.durationSec } : {}) },
    ...(voice ? { media: voice.media } : {}),
  };
  deps.broadcast(event);
  return event;
}
