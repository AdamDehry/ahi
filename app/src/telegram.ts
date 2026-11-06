import { Bot, Context, GrammyError, webhookCallback } from "grammy";
import type { Hono } from "hono";
import type { GatewayConfig, BotConfig } from "./config.js";
import { SessionMap } from "./session-map.js";
import { invokeAgent } from "./claude-invoke.js";
import { transcribeAudio, downloadTelegramFile } from "./voice-in.js";
import { synthesizeVoiceNotes } from "./voice-out.js";
import { formatForVoice } from "./voice-format.js";
import { broadcast, broadcastUpdate, broadcastEvent, type MessageEvent } from "./websocket.js";
import { InputFile } from "grammy";
import { existsSync } from "fs";
import { extname, basename } from "path";
import { loadOffset, saveOffset } from "./polling-offset.js";
import { lookupByChatId, lookupByUserId } from "./users.js";
import { resolveSentinelPath, takeBillLines, takeSentinelFiles } from "./chat-files/sentinel.js";
import { withBotSlot, ConcurrencyCapError } from "./concurrency.js";
import { drainStaleBacklog } from "./backlog-drain.js";
import { trackTurn, UNTRACKED, type TrackedTurn } from "./turn-journal.js";
import { isDiskFullError, notifyDegraded } from "./degraded-notifier.js";
import { mediaRef, registerMedia, saveTelegramMediaFile, type MediaRef } from "./media-store.js";

/**
 * Resolve a telegram chat id to `{ userId, senderName }` for message
 * attribution. Falls back to `"unknown"` for both when the sender isn't
 * in users.json — the event is still persisted and broadcast, but lands
 * in the `unknown` bucket instead of polluting a real user's thread.
 */
function attribution(chatId: number): { userId: string; senderName: string } {
  const user = lookupByChatId(chatId);
  return user
    ? { userId: user.userId, senderName: user.name }
    : { userId: "unknown", senderName: "unknown" };
}

function scopedStreamEvent(event: Record<string, unknown>, attr: { userId: string; senderName: string }): Record<string, unknown> {
  return { ...event, userId: attr.userId, senderName: attr.senderName };
}

export interface BotInstance {
  bot: Bot;
  config: BotConfig;
  sessionMap: SessionMap;
  lastMessageTime?: string;
  lastChatId?: number;
}

type ChatAction = "typing" | "record_voice" | "upload_voice" | "upload_document" | "upload_photo";

function keepAction(ctx: Context, action: ChatAction): () => void {
  const interval = setInterval(() => {
    ctx.replyWithChatAction(action).catch(() => {});
  }, 4000);
  ctx.replyWithChatAction(action).catch(() => {});
  return () => clearInterval(interval);
}

// Bots that always respond with voice, even to text input
const ALWAYS_VOICE_BOTS = new Set(["miriam"]);

// Bots that NEVER voice-respond, even to voice input (Step 9C fix #1):
// the customer agent's quote blocks are written artifacts the owner copies/forwards to
// customers — TTS defeats them. Voice notes IN are still transcribed.
const TEXT_ONLY_BOTS = new Set<string>([]);

// Bots that require a resolved sender-identity tag on every inbound message.
// Miriam serves two distinct people (the owner, a family member) and must reliably know
// who is messaging without parsing content — so we prepend "[from: <name>]".
const IDENTITY_TAGGED_BOTS = new Set(["miriam"]);

/**
 * Resolves a Telegram user ID to a friendly identifier ("owner"/"family"/...).
 * Returns "unknown" for unrecognized senders so the downstream agent can
 * still behave safely (e.g., decline to share private info).
 */
function resolveSenderIdentity(ctx: Context, cfg: GatewayConfig): string {
  const userId = ctx.from?.id;
  if (userId != null && cfg.userIdentityMap[userId]) {
    return cfg.userIdentityMap[userId];
  }
  return "unknown";
}

/**
 * For identity-tagged bots, prepend "[from: <name>]\n" to the message so the
 * agent sees the sender's friendly identifier before any user content.
 * Non-tagged bots receive the message unchanged.
 */
function tagMessageForBot(
  message: string,
  botName: string,
  ctx: Context,
  cfg: GatewayConfig,
): string {
  if (!IDENTITY_TAGGED_BOTS.has(botName)) return message;
  const identity = resolveSenderIdentity(ctx, cfg);
  return `[from: ${identity}]\n${message}`;
}

// a learning agent sends PDF transcription for long responses
const PDF_TRANSCRIPTION_BOTS = new Set<string>([]);
const PDF_THRESHOLD_CHARS = 1500;

// Zali: don't voice-respond if response contains code
function containsCode(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /`[^`]+`/.test(text) && text.split("`").length > 4;
}

function shouldVoiceRespond(botName: string, response: string, inputWasVoice: boolean): boolean {
  if (TEXT_ONLY_BOTS.has(botName)) {
    return false;
  }
  if (botName === "zali") {
    // Zali: voice only if input was voice AND response is conversational (no code)
    return inputWasVoice && !containsCode(response);
  }
  // a learning agent, Miriam: always voice regardless of input
  if (ALWAYS_VOICE_BOTS.has(botName)) {
    return true;
  }
  // Michael + default: mirror input — voice in = voice out, text in = text out
  return inputWasVoice;
}

/**
 * Scan the agent response for `[[send_file: /abs/path]]` sentinels, upload
 * each referenced file to Telegram (as photo for images, document otherwise),
 * and return the response with the sentinel lines stripped.
 *
 * Contract with agents: place the sentinel on its own line. Only absolute
 * paths are accepted — relative paths are ignored (and stripped) to avoid
 * ambiguity about the agent's cwd.
 *
 * Used by any agent that produces files for the user (Miriam's generated
 * PDFs/Excel/booklets, etc.). Generic helper — not Miriam-specific.
 */
const SEND_FILE_RE = /^[ \t]*\[\[send_file:\s*([^\]\n]+?)\s*\]\][ \t]*$/gm;
const PHOTO_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export async function deliverSentinelFiles(
  ctx: Context,
  botName: string,
  response: string,
): Promise<string> {
  const paths: string[] = [];
  // Collect all matches first so we can strip them in one pass
  let match: RegExpExecArray | null;
  const re = new RegExp(SEND_FILE_RE.source, "gm");
  while ((match = re.exec(response)) !== null) {
    const p = resolveSentinelPath(match[1]);
    if (p.startsWith("/") && existsSync(p)) {
      paths.push(p);
    } else {
      console.warn(`[${botName}] send_file sentinel ignored (not abs or missing): ${p}`);
    }
  }
  if (paths.length === 0) return response;

  // Strip ALL sentinel lines (even ones whose paths we rejected) so the user
  // never sees the internal syntax.
  const cleaned = response.replace(SEND_FILE_RE, "").replace(/\n{3,}/g, "\n\n").trim();

  for (const path of paths) {
    const ext = extname(path).toLowerCase();
    const name = basename(path);
    const isPhoto = PHOTO_EXTS.has(ext);
    const action: ChatAction = isPhoto ? "upload_photo" : "upload_document";
    const stopAction = keepAction(ctx, action);
    try {
      if (isPhoto) {
        await ctx.replyWithPhoto(new InputFile(path));
      } else {
        await ctx.replyWithDocument(new InputFile(path, name));
      }
      console.log(`[${botName}] Delivered file: ${path}`);
    } catch (err) {
      console.error(`[${botName}] Failed to send file ${path}:`, err);
    } finally {
      stopAction();
    }
  }
  return cleaned;
}

/**
 * The reply as the app thread should show it: sentinel lines stripped, and
 * the files themselves posted into the user's app chat (chat-files/sentinel.ts)
 * — Telegram still gets them through deliverSentinelFiles.
 */
function appReplyText(response: string, bot: string, userId: string): string {
  return takeSentinelFiles(response, { userId, admin: lookupByUserId(userId)?.admin, bot });
}

function generatePdfBuffer(title: string, text: string): Buffer {
  // Minimal PDF generation — plain text content
  const escapedText = text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

  // Split into lines that fit ~80 chars
  const lines: string[] = [];
  for (const paragraph of escapedText.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      if (current.length + word.length + 1 > 80) {
        lines.push(current);
        current = word;
      } else {
        current = current ? current + " " + word : word;
      }
    }
    if (current) lines.push(current);
  }

  const textLines = lines
    .map((line, i) => `BT /F1 10 Tf 50 ${750 - i * 14} Td (${line}) Tj ET`)
    .join("\n");

  const content = `1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${textLines.length} >>
stream
${textLines}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`;

  return Buffer.from(`%PDF-1.4\n${content}`, "utf-8");
}

function estimateVoiceDurationSec(text: string): number {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 2.6));
}

function splitTranscriptForVoiceMedia(text: string, count: number): string[] {
  if (count <= 1) return [text];
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return Array.from({ length: count }, () => text);
  const per = Math.ceil(words.length / count);
  return Array.from({ length: count }, (_, i) => {
    const part = words.slice(i * per, (i + 1) * per).join(" ");
    return part || text;
  });
}

async function registerOutboundVoiceMedia(opts: {
  userId: string;
  botName: string;
  audioBuffer: Buffer;
  transcript: string;
  durationText?: string;
  part?: number;
  total?: number;
}): Promise<{ media: MediaRef; durationSec: number } | null> {
  try {
    const suffix = opts.total && opts.total > 1 ? `-part-${opts.part || 1}-of-${opts.total}` : "";
    const filename = `${opts.botName}-reply-${Date.now()}${suffix}.ogg`;
    const filePath = await saveTelegramMediaFile(opts.userId, filename, opts.audioBuffer);
    const durationSec = estimateVoiceDurationSec(opts.durationText || opts.transcript);
    const record = await registerMedia({
      userId: opts.userId,
      bot: opts.botName,
      source: "telegram",
      type: "voice",
      filePath,
      originalName: filename,
      mime: "audio/ogg",
      durationSec,
      transcript: opts.transcript,
    });
    return { media: mediaRef(record), durationSec };
  } catch (err) {
    console.warn(`[${opts.botName}] outbound voice media registration failed: ${(err as Error).message}`);
    return null;
  }
}

export async function sendResponse(
  ctx: Context,
  botName: string,
  voice: string,
  response: string,
  inputWasVoice: boolean,
  userId?: string,
  ttsProvider?: import("./config.js").TTSProvider,
  googleVoice?: string,
  geminiVoice?: string,
  styleInstructions?: string,
  eleven?: import("./config.js").ElevenConfig,
  cartesia?: import("./config.js").CartesiaConfig,
): Promise<{ voiceMedia: Array<{ media: MediaRef; durationSec: number }> }> {
  const result = { voiceMedia: [] as Array<{ media: MediaRef; durationSec: number }> };
  // Guard against empty responses (happens when the agent only ran tools
  // or tried to spawn a subagent that doesn't exist in the gateway's -p
  // Claude CLI context). Telegram 400s on empty sendMessage.
  if (!response || !response.trim()) {
    console.warn(`[${botName}] Empty response from agent — sending fallback.`);
    await ctx.reply(
      "(No text came back from the agent this turn. Try rephrasing, or send /reset to clear the session.)",
    );
    return result;
  }

  // Handle `[[send_file: /abs/path]]` sentinels — upload referenced files
  // and strip the sentinel lines from what the user sees. If the response
  // becomes empty after stripping (agent sent only a file, no prose), we're
  // already done.
  response = await deliverSentinelFiles(ctx, botName, response);
  if (!response.trim()) {
    return result;
  }

  const useVoice = shouldVoiceRespond(botName, response, inputWasVoice);

  if (useVoice) {
    try {
      // Format response for voice: clean speech + structured text summary
      const { speakable, textSummary } = formatForVoice(response);
      const mediaUserId = userId || (ctx.chat ? attribution(ctx.chat.id).userId : "unknown");

      // Telegram voice caption limit is 1024 chars
      const CAPTION_LIMIT = 1024;

      // Determine caption: attach summary directly to voice note if it fits
      const caption = textSummary && textSummary.length <= CAPTION_LIMIT
        ? textSummary
        : undefined;

      // Synthesize the clean speakable version
      // One note however long the reply; parts only past Telegram's upload cap.
      const stopAction = keepAction(ctx, "record_voice");
      let chunks;
      try {
        chunks = await synthesizeVoiceNotes({ text: speakable, voice, provider: ttsProvider, googleVoice, geminiVoice, styleInstructions, agentName: botName, eleven, cartesia });
      } finally {
        stopAction();
      }

      if (chunks.length === 0) {
        // TTS returned no audio — switch action to typing before text fallback
        await ctx.replyWithChatAction("typing").catch(() => {});
        await sendChunkedText(ctx, response, 4000);
        return result;
      }

      // First note gets the caption if it fits. Store the full original
      // markdown response as the dashboard transcript; only TTS uses
      // `speakable`, so prompt/code fences remain copyable but are not read.
      const spokenParts = splitTranscriptForVoiceMedia(speakable, chunks.length);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0 && caption) {
          await ctx.replyWithVoice(
            new InputFile(chunks[i].audioBuffer, "response.ogg"),
            { caption }
          );
        } else {
          await ctx.replyWithVoice(new InputFile(chunks[i].audioBuffer, "response.ogg"));
        }
        const media = await registerOutboundVoiceMedia({
          userId: mediaUserId,
          botName,
          audioBuffer: chunks[i].audioBuffer,
          transcript: response,
          durationText: spokenParts[i] || speakable,
          part: i + 1,
          total: chunks.length,
        });
        if (media) result.voiceMedia.push(media);
      }

      // If summary was too long for caption, send as follow-up text
      if (textSummary && textSummary.length > CAPTION_LIMIT) {
        await ctx.replyWithChatAction("typing").catch(() => {});
        await sendChunkedText(ctx, textSummary, 4000);
      }

      // PDF transcription for long responses (agents in PDF_TRANSCRIPTION_BOTS)
      if (PDF_TRANSCRIPTION_BOTS.has(botName) && response.length > PDF_THRESHOLD_CHARS) {
        const stopDoc = keepAction(ctx, "upload_document");
        let pdf;
        try {
          pdf = generatePdfBuffer(`${botName} — Response`, response);
        } finally {
          stopDoc();
        }
        await ctx.replyWithDocument(
          new InputFile(pdf, `${botName}-response.pdf`),
          { caption: "Full transcription" }
        );
      }

      return result;
    } catch (ttsErr) {
      console.error(`[${botName}] TTS failed, falling back to text:`, ttsErr);
      // Switch action away from record_voice before text fallback so the
      // user doesn't see a microphone animation for a text reply.
      await ctx.replyWithChatAction("typing").catch(() => {});
    }
  }

  // Text fallback (or Michael/Zali default for text input)
  // Telegram hard-caps sendMessage at 4096 chars; we keep a 96-char safety
  // margin (split threshold 4000) so Markdown/formatting don't push us over.
  // When a chunk still exceeds the limit, we cascade: paragraph → line → hard.
  await sendChunkedText(ctx, response, 4000);
  return result;
}

/**
 * Split a long text response into Telegram-safe chunks and send them in order.
 *
 * Strategy: split on paragraph boundaries (\n\n) first, then single newlines
 * for any oversize paragraph, then hard-split at `maxLen` as a last resort.
 * This preserves structure for normal prose while staying under Telegram's
 * 4096-char sendMessage cap.
 */
async function sendChunkedText(
  ctx: Context,
  text: string,
  maxLen: number,
): Promise<void> {
  if (text.length <= maxLen) {
    await ctx.reply(text);
    return;
  }

  const chunks = splitForTelegram(text, maxLen);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    await ctx.reply(chunk);
  }
}

/** Greedy pack `pieces` into chunks of at most `maxLen`, joined by `sep`. */
function packChunks(pieces: string[], maxLen: number, sep: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) {
      current = piece;
      continue;
    }
    if (current.length + sep.length + piece.length <= maxLen) {
      current = current + sep + piece;
    } else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Hard split a string every `maxLen` chars. */
function hardSplit(text: string, maxLen: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    out.push(text.slice(i, i + maxLen));
  }
  return out;
}

/**
 * Produce a list of chunks all ≤ `maxLen`.
 * Cascade: paragraph → line → hard.
 */
function splitForTelegram(text: string, maxLen: number): string[] {
  // Step 1: split on paragraph boundaries and pack
  const paragraphs = text.split("\n\n");
  const paraChunks = packChunks(paragraphs, maxLen, "\n\n");

  // Step 2: any oversize chunk gets line-split + repacked
  const lineChunks: string[] = [];
  for (const chunk of paraChunks) {
    if (chunk.length <= maxLen) {
      lineChunks.push(chunk);
      continue;
    }
    const lines = chunk.split("\n");
    lineChunks.push(...packChunks(lines, maxLen, "\n"));
  }

  // Step 3: anything STILL oversize (single giant line) hard-splits
  const final: string[] = [];
  for (const chunk of lineChunks) {
    if (chunk.length <= maxLen) {
      final.push(chunk);
    } else {
      final.push(...hardSplit(chunk, maxLen));
    }
  }
  return final;
}

export function createBot(botCfg: BotConfig, gatewayCfg: GatewayConfig): BotInstance {
  // No Telegram token = the agent lives in the app only; the placeholder never connects (index.ts skips it).
  const bot = new Bot(botCfg.token || "0:telegram-off");
  const sessionMap = new SessionMap(gatewayCfg.sessionDir);
  const { name, voice, model, ttsProvider, googleVoice, geminiVoice, styleInstructions, eleven, cartesia } = botCfg;
  const instance: BotInstance = { bot, config: botCfg, sessionMap };

  // Restore lastChatId from session map so Telegram forwarding works after restart
  const latestSession = sessionMap.getLatest(name);
  if (latestSession) {
    instance.lastChatId = latestSession.chatId;
    instance.lastMessageTime = latestSession.lastActive;
  }

  // Persist the Telegram long-polling offset after every update. This runs
  // BEFORE the rest of the handlers (grammY runs middleware in order) — we
  // save the offset regardless of whether downstream throws, because the
  // alternative is an infinite redelivery loop on any poison-pill message.
  // Guard: bail if `ctx.update` is somehow missing (shouldn't happen).
  bot.use(async (ctx, next) => {
    const updateId = ctx.update?.update_id;
    if (typeof updateId === "number") {
      saveOffset(name, updateId);
    }
    await next();
  });

  // /start
  bot.command("start", async (ctx) => {
    const greetings: Record<string, string> = {
      michael: "Hi! Michael is online. Send me a message.",
      miriam: "Hi! Miriam is here. How can I help you today?",
      zali: "Hi! Zali is online. What are we building?",
      avi: "Hi! Avi is here. What are we making?",
    };
    await ctx.reply(greetings[name] || `${name} is online.`);
  });

  // /status
  bot.command("status", async (ctx) => {
    await ctx.reply(
      [
        `Bot: ${name}`,
        `Model: ${model}`,
        `Voice: ${voice}`,
        `Gateway: online`,
        `Mode: ${gatewayCfg.mode}`,
        `Port: ${gatewayCfg.port}`,
      ].join("\n")
    );
  });

  // /reset — clear the stored Claude session for this bot+chat so the next
  // message starts a fresh conversation. Used when an agent loops on a
  // broken tool call or an unrecoverable state.
  bot.command("reset", async (ctx) => {
    const chatId = ctx.chat.id;
    sessionMap.delete(chatId, name);
    await ctx.reply(`Session cleared. Next message starts fresh.`);
  });

  // Voice messages — STT → Claude → response (voice or text per bot rules)
  bot.on("message:voice", async (ctx) => {
    const voiceMsg = ctx.message.voice;
    const chatId = ctx.chat.id;
    let turn: TrackedTurn = UNTRACKED;

    try {
      console.log(`[${name}] Voice note ${voiceMsg.duration}s from ${chatId}`);
      const now = new Date().toISOString();
      if (instance) { instance.lastChatId = chatId; instance.lastMessageTime = now; }

      const audioBuffer = await downloadTelegramFile(voiceMsg.file_id, botCfg.token);

      const stopAction = keepAction(ctx, "typing");
      try {
        const transcription = await transcribeAudio(audioBuffer, voiceMsg.mime_type || "audio/ogg");
        const voiceAttr = attribution(chatId);
        let media;
        try {
          const voicePath = await saveTelegramMediaFile(
            voiceAttr.userId,
            `${voiceMsg.file_unique_id || voiceMsg.file_id}.ogg`,
            audioBuffer,
          );
          const record = await registerMedia({
            userId: voiceAttr.userId,
            bot: name,
            source: "telegram",
            type: "voice",
            filePath: voicePath,
            fileId: voiceMsg.file_id,
            originalName: `voice-${voiceMsg.file_unique_id || voiceMsg.file_id}.ogg`,
            mime: voiceMsg.mime_type || "audio/ogg",
            durationSec: voiceMsg.duration,
            transcript: transcription.text,
          });
          media = mediaRef(record);
        } catch (saveErr) {
          if (isDiskFullError(saveErr)) {
            await notifyDegraded("file-save-enospc", `voice note from ${chatId} couldn't write`);
            await ctx.reply("Got your voice note but couldn't save it — disk full. The transcript was received; resend the audio after cleanup.");
          } else {
            throw saveErr;
          }
        }

        if (!transcription.text.trim()) {
          if (media) {
            broadcast({ type: "message", bot: name, direction: "in", contentType: "voice", text: "[voice note]", timestamp: now, chatId, userId: voiceAttr.userId, senderName: voiceAttr.senderName, source: "telegram", meta: { voiceDuration: voiceMsg.duration }, media });
          }
          await ctx.reply("Couldn't make out what you said. Try again?");
          return;
        }

        const inEvent: MessageEvent = { type: "message", bot: name, direction: "in", contentType: "voice", text: transcription.text, timestamp: now, chatId, userId: voiceAttr.userId, senderName: voiceAttr.senderName, source: "telegram", meta: { voiceDuration: voiceMsg.duration }, media };
        broadcast(inEvent);

        const prompt = tagMessageForBot(transcription.text, name, ctx, gatewayCfg);
        turn = trackTurn({ bot: name, userId: voiceAttr.userId, chatId, surface: "telegram", inputWasVoice: true, messageId: inEvent.meta?.messageId ?? null, prompt, said: transcription.text, startedAt: now });
        const result = await withBotSlot(name, () =>
          invokeAgent({
            chatId,
            botName: name,
            message: prompt,
            sessionMap,
            config: gatewayCfg,
            model,
            onStreamEvent: (e) => broadcastEvent(scopedStreamEvent(e, voiceAttr)),
            thread: { userId: voiceAttr.userId, excludeMessageId: inEvent.meta?.messageId ?? null },
          }),
        );

        // LOST-OUTBOUND FIX: persist the reply BEFORE attempting
        // delivery. sendResponse can throw (TTS provider failure, Telegram
        // 429/400, media registration) and this path used to broadcast only
        // AFTER it returned — the agent's reply then never reached the store
        // or the app. Now a text record lands first (same order as the text
        // handler) and is upgraded in place to voice once TTS succeeds — the
        // dashboard's P0 upsert pattern.
        // Bill lines are applied once and never reach either surface.
        result.response = takeBillLines(result.response, { userId: voiceAttr.userId, bot: name });
        const outRecord: MessageEvent = { type: "message", bot: name, direction: "out", contentType: "text", text: appReplyText(result.response, name, voiceAttr.userId), timestamp: new Date().toISOString(), chatId, userId: voiceAttr.userId, senderName: voiceAttr.senderName, source: "telegram" };
        if (outRecord.text) broadcast(outRecord); // stamps meta.messageId for the voice upgrade below
        turn.done(); // the reply is in the thread — a restart from here must not redo the turn

        const sent = await sendResponse(ctx, name, voice, result.response, true, voiceAttr.userId, ttsProvider, googleVoice, geminiVoice, styleInstructions, eleven, cartesia);
        if (sent.voiceMedia.length > 0) {
          sent.voiceMedia.forEach((voiceItem, i) => {
            const voiceEvent: MessageEvent = {
              type: "message",
              bot: name,
              direction: "out",
              contentType: "voice",
              text: voiceItem.media.transcript || result.response,
              timestamp: new Date().toISOString(),
              chatId,
              userId: voiceAttr.userId,
              senderName: voiceAttr.senderName,
              source: "telegram",
              meta: { voiceDuration: voiceItem.durationSec },
              media: voiceItem.media,
            };
            if (i === 0) {
              // Upgrade the persisted text record in place (same messageId).
              broadcastUpdate({ ...voiceEvent, meta: { ...voiceEvent.meta, messageId: outRecord.meta?.messageId } });
            } else {
              broadcast(voiceEvent); // extra chunks append as their own records
            }
          });
        }
      } finally {
        stopAction();
      }
    } catch (err) {
      if (err instanceof ConcurrencyCapError) {
        console.warn(`[${name}] Dropped voice message from ${chatId}: ${err.message}`);
        await ctx.reply("I'm handling another message right now. Give me a sec and try again.");
      } else {
        console.error(`[${name}] Voice pipeline error:`, err);
        await ctx.reply("Voice processing hit a snag. Send as text and I'll respond.");
      }
    } finally {
      turn.done();
    }
  });

  // Text messages — Claude → response (voice or text per bot rules)
  bot.on("message:text", async (ctx) => {
    const message = ctx.message.text;
    const chatId = ctx.chat.id;

    console.log(`[${name}] ${chatId}: ${message.substring(0, 100)}`);

    // Track for dashboard
    const now = new Date().toISOString();
    if (instance) { instance.lastChatId = chatId; instance.lastMessageTime = now; }
    const textAttr = attribution(chatId);
    const inEvent: MessageEvent = { type: "message", bot: name, direction: "in", contentType: "text", text: message, timestamp: now, chatId, userId: textAttr.userId, senderName: textAttr.senderName, source: "telegram" };
    broadcast(inEvent);
    const prompt = tagMessageForBot(message, name, ctx, gatewayCfg);
    const turn = trackTurn({ bot: name, userId: textAttr.userId, chatId, surface: "telegram", inputWasVoice: false, messageId: inEvent.meta?.messageId ?? null, prompt, said: message, startedAt: now });

    const stopTyping = keepAction(ctx, "typing");
    try {
      const result = await withBotSlot(name, () =>
        invokeAgent({
          chatId,
          botName: name,
          message: prompt,
          sessionMap,
          config: gatewayCfg,
          model,
          onStreamEvent: (e) => broadcastEvent(scopedStreamEvent(e, textAttr)),
          thread: { userId: textAttr.userId, excludeMessageId: inEvent.meta?.messageId ?? null },
        }),
      );

      result.response = takeBillLines(result.response, { userId: textAttr.userId, bot: name });
      const shown = appReplyText(result.response, name, textAttr.userId);
      if (shown) broadcast({ type: "message", bot: name, direction: "out", contentType: "text", text: shown, timestamp: new Date().toISOString(), chatId, userId: textAttr.userId, senderName: textAttr.senderName, source: "telegram" });
      turn.done();
      await sendResponse(ctx, name, voice, result.response, false, textAttr.userId, ttsProvider, googleVoice, geminiVoice, styleInstructions, eleven, cartesia);
    } catch (err) {
      if (err instanceof ConcurrencyCapError) {
        console.warn(`[${name}] Dropped text message from ${chatId}: ${err.message}`);
        await ctx.reply("I'm handling another message right now. Give me a sec and try again.");
      } else {
        console.error(`[${name}] Message error:`, err);
        await ctx.reply("Something went wrong. Try again in a moment.");
      }
    } finally {
      stopTyping();
      turn.done();
    }
  });

  // Photos — download, save, tell Claude to read it
  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    // Telegram sends multiple sizes — grab the largest
    const photo = photos[photos.length - 1];
    const caption = ctx.message.caption || "";
    const chatId = ctx.chat.id;

    const now = new Date().toISOString();
    if (instance) { instance.lastChatId = chatId; instance.lastMessageTime = now; }
    const photoAttr = attribution(chatId);
    let turn: TrackedTurn = UNTRACKED;

    const stopTyping = keepAction(ctx, "typing");
    try {
      // Download photo
      const photoBuffer = await downloadTelegramFile(photo.file_id, botCfg.token);
      let photoPath = "";
      let media;
      try {
        photoPath = await saveTelegramMediaFile(photoAttr.userId, `${photo.file_unique_id}.jpg`, photoBuffer);
        const record = await registerMedia({
          userId: photoAttr.userId,
          bot: name,
          source: "telegram",
          type: "image",
          filePath: photoPath,
          fileId: photo.file_id,
          originalName: `${photo.file_unique_id}.jpg`,
          mime: "image/jpeg",
        });
        media = mediaRef(record);
      } catch (saveErr) {
        if (isDiskFullError(saveErr)) {
          await notifyDegraded("file-save-enospc", `photo from ${chatId} couldn't write`);
          await ctx.reply("Got your image but couldn't save it — disk full. The message itself was received; resend the file after cleanup.");
          return;
        }
        throw saveErr;
      }

      const inEvent: MessageEvent = { type: "message", bot: name, direction: "in", contentType: "photo", text: caption || "[photo]", timestamp: now, chatId, userId: photoAttr.userId, senderName: photoAttr.senderName, source: "telegram", media };
      broadcast(inEvent);

      console.log(`[${name}] Photo saved: ${photoPath} (${(photoBuffer.length / 1024).toFixed(0)}KB)`);

      // Build message that tells Claude to look at the image
      const message = caption
        ? `[The user sent a photo. Read and analyze the image at ${photoPath} then respond to their message.]\n\n${caption}`
        : `[The user sent a photo. Read and analyze the image at ${photoPath} and describe what you see or respond appropriately.]`;

      const prompt = tagMessageForBot(message, name, ctx, gatewayCfg);
      turn = trackTurn({ bot: name, userId: photoAttr.userId, chatId, surface: "telegram", inputWasVoice: false, messageId: inEvent.meta?.messageId ?? null, prompt, said: caption || "[photo]", startedAt: now });
      const result = await withBotSlot(name, () =>
        invokeAgent({
          chatId,
          botName: name,
          message: prompt,
          sessionMap,
          config: gatewayCfg,
          model,
          onStreamEvent: (e) => broadcastEvent(scopedStreamEvent(e, photoAttr)),
          thread: { userId: photoAttr.userId, excludeMessageId: inEvent.meta?.messageId ?? null },
        }),
      );

      result.response = takeBillLines(result.response, { userId: photoAttr.userId, bot: name });
      const shown = appReplyText(result.response, name, photoAttr.userId);
      if (shown) broadcast({ type: "message", bot: name, direction: "out", contentType: "text", text: shown, timestamp: new Date().toISOString(), chatId, userId: photoAttr.userId, senderName: photoAttr.senderName, source: "telegram" });
      turn.done();
      await sendResponse(ctx, name, voice, result.response, false, photoAttr.userId, ttsProvider, googleVoice, geminiVoice, styleInstructions, eleven, cartesia);
    } catch (err) {
      if (err instanceof ConcurrencyCapError) {
        console.warn(`[${name}] Dropped photo message from ${chatId}: ${err.message}`);
        await ctx.reply("I'm handling another message right now. Give me a sec and try again.");
      } else {
        console.error(`[${name}] Photo processing error:`, err);
        await ctx.reply("Had trouble processing that image. Try again?");
      }
    } finally {
      stopTyping();
      turn.done();
    }
  });

  // Documents — download, save, tell Claude to read it
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption || "";
    const chatId = ctx.chat.id;

    if (!doc) {
      await ctx.reply("Couldn't read that document.");
      return;
    }

    const now = new Date().toISOString();
    if (instance) { instance.lastChatId = chatId; instance.lastMessageTime = now; }
    const docAttr = attribution(chatId);
    let turn: TrackedTurn = UNTRACKED;

    const stopTyping = keepAction(ctx, "typing");
    try {
      const docBuffer = await downloadTelegramFile(doc.file_id, botCfg.token);
      const ext = doc.file_name?.split(".").pop() || "bin";
      let docPath = "";
      let media;
      try {
        docPath = await saveTelegramMediaFile(docAttr.userId, `${doc.file_unique_id}.${ext}`, docBuffer);
        const record = await registerMedia({
          userId: docAttr.userId,
          bot: name,
          source: "telegram",
          type: "document",
          filePath: docPath,
          fileId: doc.file_id,
          originalName: doc.file_name || `${doc.file_unique_id}.${ext}`,
          mime: doc.mime_type || "application/octet-stream",
        });
        media = mediaRef(record);
      } catch (saveErr) {
        if (isDiskFullError(saveErr)) {
          await notifyDegraded("file-save-enospc", `document ${doc.file_name || doc.file_id} couldn't write`);
          await ctx.reply("Got your document but couldn't save it — disk full. The message itself was received; resend the file after cleanup.");
          return;
        }
        throw saveErr;
      }

      const inEvent: MessageEvent = { type: "message", bot: name, direction: "in", contentType: "document", text: caption || `[${doc.file_name}]`, timestamp: now, chatId, userId: docAttr.userId, senderName: docAttr.senderName, source: "telegram", meta: { fileName: doc.file_name }, media };
      broadcast(inEvent);

      console.log(`[${name}] Document saved: ${docPath} (${doc.file_name}, ${(docBuffer.length / 1024).toFixed(0)}KB)`);

      const message = caption
        ? `[The user sent a document: "${doc.file_name}" (${doc.mime_type}). Read the file at ${docPath} then respond to their message.]\n\n${caption}`
        : `[The user sent a document: "${doc.file_name}" (${doc.mime_type}). Read the file at ${docPath} and respond appropriately.]`;

      const prompt = tagMessageForBot(message, name, ctx, gatewayCfg);
      turn = trackTurn({ bot: name, userId: docAttr.userId, chatId, surface: "telegram", inputWasVoice: false, messageId: inEvent.meta?.messageId ?? null, prompt, said: caption || `[${doc.file_name}]`, startedAt: now });
      const result = await withBotSlot(name, () =>
        invokeAgent({
          chatId,
          botName: name,
          message: prompt,
          sessionMap,
          config: gatewayCfg,
          model,
          onStreamEvent: (e) => broadcastEvent(scopedStreamEvent(e, docAttr)),
          thread: { userId: docAttr.userId, excludeMessageId: inEvent.meta?.messageId ?? null },
        }),
      );

      result.response = takeBillLines(result.response, { userId: docAttr.userId, bot: name });
      const shown = appReplyText(result.response, name, docAttr.userId);
      if (shown) broadcast({ type: "message", bot: name, direction: "out", contentType: "text", text: shown, timestamp: new Date().toISOString(), chatId, userId: docAttr.userId, senderName: docAttr.senderName, source: "telegram" });
      turn.done();
      await sendResponse(ctx, name, voice, result.response, false, docAttr.userId, ttsProvider, googleVoice, geminiVoice, styleInstructions, eleven, cartesia);
    } catch (err) {
      if (err instanceof ConcurrencyCapError) {
        console.warn(`[${name}] Dropped document message from ${chatId}: ${err.message}`);
        await ctx.reply("I'm handling another message right now. Give me a sec and try again.");
      } else {
        console.error(`[${name}] Document processing error:`, err);
        await ctx.reply("Had trouble processing that document. Try again?");
      }
    } finally {
      stopTyping();
      turn.done();
    }
  });

  // Catch-all
  bot.on("message", async (ctx) => {
    await ctx.reply("Got your message. I can handle text and voice right now.");
  });

  bot.catch((err) => {
    console.error(`[${name}] Bot error:`, err);
  });

  return instance;
}

export function setupWebhook(app: Hono, instance: BotInstance, basePath: string): void {
  const path = `${basePath}/${instance.config.name}`;
  const handleUpdate = webhookCallback(instance.bot, "hono");
  app.post(path, (c) => handleUpdate(c));
  console.log(`[webhook] ${instance.config.name} → ${path}`);
}

export async function startPolling(instance: BotInstance): Promise<void> {
  const { name } = instance.config;
  console.log(`[${name}] Starting long-polling...`);

  // Restore the persisted update offset so Telegram doesn't re-deliver
  // updates we already processed across a restart.
  //
  // grammY only tracks the offset in memory (`lastTriedUpdateId`). When the
  // gateway crashes, that counter is lost; the next `getUpdates()` call has
  // no offset, and Telegram re-delivers every pending update — including
  // ones we already acted on. Observed: "yes" was replayed 20× in 14
  // minutes after one crash loop.
  //
  // Fix: before starting the poll loop, call `getUpdates({offset: N+1})`
  // once. Telegram treats this as an acknowledgement that everything up to
  // N has been handled and stops re-delivering those updates. Also pre-seed
  // grammY's internal counter via the documented-but-private field so its
  // graceful-stop confirmation offset is correct too.
  const storedOffset = loadOffset(name);
  if (storedOffset > 0) {
    try {
      await instance.bot.api.getUpdates({
        offset: storedOffset + 1,
        limit: 1,
        timeout: 0,
      });
      // Pre-seed grammY's internal counter so its own offset tracking
      // starts from the persisted value. Uses `any` to reach past the TS
      // private modifier; the field is a plain assignment at runtime.
      (instance.bot as unknown as { lastTriedUpdateId: number }).lastTriedUpdateId = storedOffset;
      console.log(`[${name}] Restored polling offset ${storedOffset}`);
    } catch (err) {
      console.warn(`[${name}] Failed to confirm stored offset ${storedOffset}:`, err);
    }
  }

  // Cold-start backlog drain (protection #5).
  // If Telegram has a stale backlog (>10min old) for this bot, ACK all
  // pending updates without processing them, and notify each affected
  // chat once. See backlog-drain.ts for rationale.
  try {
    const drain = await drainStaleBacklog(instance.bot, name);
    if (drain.drained) {
      // Bump grammY's internal counter past the drained offset so its
      // next poll starts after what we just ACK'd.
      (instance.bot as unknown as { lastTriedUpdateId: number }).lastTriedUpdateId = drain.newestUpdateId;
    }
  } catch (err) {
    console.warn(`[${name}] backlog drain failed:`, (err as Error).message);
  }

  // Polling supervisor: grammY rethrows on 409 (Conflict: terminated by other
  // getUpdates request) — see node_modules/grammy/out/bot.js handlePollingError.
  // This rejection used to bubble out of `bot.start()`, become an unhandled
  // rejection, and leave the bot silently dead until launchctl kicked us.
  //
  // 409 happens during the brief overlap when `launchctl kickstart -k` is
  // restarting the gateway and old + new instances both poll Telegram for ~1s.
  // It's normal, expected, transient. We log it and re-enter polling.
  //
  // Any other rejection (auth failure, network, etc.) bubbles up so the
  // top-level handlers can decide.
  while (true) {
    try {
      await instance.bot.start({
        onStart: () => console.log(`[${name}] Bot is live (polling mode)`),
      });
      // Clean exit (e.g. bot.stop() was called) — leave the loop.
      return;
    } catch (err) {
      const isConflict =
        err instanceof GrammyError &&
        (err.error_code === 409 ||
          /Conflict: terminated by other getUpdates/i.test(err.description ?? ""));
      if (!isConflict) {
        // Re-throw — caller / process-level handler decides.
        throw err;
      }
      console.warn(
        `[gateway-409-suppressed] bot=${name} reason=getUpdates-conflict — ` +
          `another poller is active (likely a restart overlap); retrying in 2s`,
      );
      // Short backoff: the conflicting poller is almost always a doomed
      // predecessor that's about to exit. 2s is enough for it to release.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // Loop and call bot.start() again.
    }
  }
}
