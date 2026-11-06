/**
 * Turn resume — production wiring. The pure logic is turn-resume.ts (tested
 * with injected deps); this file binds it to the gateway's real reply paths so
 * a resumed turn lands exactly where the original reply would have:
 *   app        → the app thread (as /app/send does)
 *   app-reply  → the dashboard reply path (voice-aware, Telegram copy)
 *   ui-send    → the app thread + Telegram copy (as /ui/send does)
 *   telegram   → Telegram + the app thread (text; see REPORT.md)
 * App-surface resumes run through the same per-user lane as new app messages,
 * so they serialize with anything the owner sends meanwhile and Stop still works.
 *
 * installTurnResume() never throws: if it cannot start, the gateway boots
 * without it and the markers simply wait for the next boot.
 */
import { broadcast, broadcastEvent, type MessageEvent } from "./websocket.js";
import { lookupByUserId } from "./users.js";
import { invokeAgent } from "./claude-invoke.js";
import { ConcurrencyCapError, withBotSlot } from "./concurrency.js";
import { isManualTurnCancel, runDashboardTurn } from "./dashboard-turns.js";
import { broadcastDashboardAgentReply } from "./dashboard.js";
import { restrictionAt } from "./review/sacred-time.js";
import { scheduleConfigFromEnv } from "./review/schedule.js";
import { isShuttingDown, turnJournal, turnResumeEnabled, type InflightTurn } from "./turn-journal.js";
import { TransientResumeError, TurnResumer } from "./turn-resume.js";
import type { GatewayConfig } from "./config.js";
import type { BotInstance } from "./telegram.js";

const TELEGRAM_CHUNK = 4000;

function chunks(text: string, size = TELEGRAM_CHUNK): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}

function sourceFor(m: InflightTurn): MessageEvent["source"] {
  return m.surface === "telegram" ? "telegram" : m.surface === "ui-send" ? "ui-send" : "app";
}

export function installTurnResume(instances: BotInstance[], config: GatewayConfig): TurnResumer | null {
  if (!turnResumeEnabled()) {
    console.log("[turn-resume] off (TURN_RESUME=false)");
    return null;
  }
  try {
    const place = scheduleConfigFromEnv().place;
    const instanceFor = (bot: string): BotInstance => {
      const i = instances.find((x) => x.config.name === bot);
      if (!i) throw new Error(`unknown bot ${bot}`);
      return i;
    };

    const outRecord = (m: InflightTurn, text: string): MessageEvent => {
      const user = lookupByUserId(m.userId);
      return {
        type: "message",
        bot: m.bot,
        direction: "out",
        contentType: "text",
        text,
        timestamp: new Date().toISOString(),
        chatId: m.chatId,
        userId: m.userId,
        senderName: user?.name ?? m.userId,
        source: sourceFor(m),
      };
    };

    const telegramCopy = async (m: InflightTurn, text: string): Promise<void> => {
      const instance = instanceFor(m.bot);
      const target = m.surface === "telegram" ? m.chatId : lookupByUserId(m.userId)?.telegramChatId;
      if (!target) return;
      for (const part of chunks(text)) await instance.bot.api.sendMessage(target, part);
    };

    const resumer = new TurnResumer({
      journal: turnJournal(),
      restriction: (at) => {
        const r = restrictionAt(at, place);
        return { restricted: r.restricted, reason: r.restricted ? `${r.reason} — waits for nightfall` : null, until: r.until ?? null };
      },
      timeZone: (userId) => lookupByUserId(userId)?.timezone ?? null,
      userName: (userId) => lookupByUserId(userId)?.name ?? userId,
      run: async (m, prompt) => {
        const instance = instanceFor(m.bot);
        const user = lookupByUserId(m.userId);
        const invoke = (abortSignal?: AbortSignal) =>
          invokeAgent({
            chatId: m.chatId,
            botName: m.bot,
            message: prompt,
            sessionMap: instance.sessionMap,
            config,
            model: instance.config.model,
            abortSignal,
            onStreamEvent: (e) => broadcastEvent({ ...e, userId: m.userId, senderName: user?.name ?? m.userId }),
            thread: { userId: m.userId, excludeMessageId: m.messageId, alwaysTail: true },
          });

        let response: string;
        try {
          response =
            m.surface === "telegram"
              ? (await withBotSlot(m.bot, () => invoke())).response
              : (await runDashboardTurn(m.userId, m.bot, (signal) => invoke(signal))).response;
        } catch (err) {
          if (err instanceof ConcurrencyCapError) throw new TransientResumeError(err.message);
          if (m.surface !== "telegram" && isManualTurnCancel(err)) return "cancelled";
          throw err;
        }
        // A second restart mid-resume: the turn died with the process — leave
        // the marker for the next boot rather than deliver a cut-short line.
        if (isShuttingDown()) throw new Error("gateway shutting down");

        if (m.surface === "app-reply") {
          if (!user) throw new Error(`unknown user ${m.userId}`);
          await broadcastDashboardAgentReply({ instance, botName: m.bot, response, inputWasVoice: m.inputWasVoice, user, chatId: m.chatId, source: "app" });
        } else {
          broadcast(outRecord(m, response));
          if (m.surface === "telegram" || m.surface === "ui-send") await telegramCopy(m, response).catch((e) => console.warn(`[turn-resume] Telegram copy failed: ${(e as Error).message}`));
        }
        return "delivered";
      },
      notice: async (m, text) => {
        broadcast(outRecord(m, text));
        if (m.surface === "telegram" || m.surface === "ui-send") await telegramCopy(m, text).catch((e) => console.warn(`[turn-resume] Telegram copy failed: ${(e as Error).message}`));
      },
    });
    console.log(`[turn-resume] up — markers ${turnJournal().root}`);
    return resumer;
  } catch (err) {
    console.error("[turn-resume] FAILED to start — interrupted turns wait for the next boot:", err);
    return null;
  }
}
