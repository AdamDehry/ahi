/**
 * Review desk — production wiring. The only file in src/review/ that knows
 * about the gateway's sockets, message store, push and Telegram; everything
 * else takes them as injected deps (and is tested that way).
 *
 * installReviewDesk() never throws: if the desk cannot start (say a corrupt
 * items.json), it logs loudly and the gateway boots without it — the review
 * routes simply 404. A queue problem must never take the gateway down.
 */
import { APP_URL } from "../app-url.js";
import type { Context, Hono } from "hono";
import { broadcast, broadcastEvent } from "../websocket.js";
import { sendPushToUser } from "../push.js";
import { getMessagesForUser } from "../message-store.js";
import { lookupByUserId } from "../users.js";
import type { BotInstance } from "../telegram.js";
import { ReviewDesk } from "./desk.js";
import { announceCard } from "./announce.js";
import { synthesizeVoiceNotes } from "../voice-out.js";
import { registerOutboundVoiceMedia } from "../voice-media.js";
import { setAlertSink } from "../degraded-notifier.js";
import { LANES, type Lane } from "./types.js";
import { defaultForemanBuildsDir } from "./ledger.js";
import { ForemanTimeline } from "../foreman-messages/timeline.js";
import { registerReviewRoutes, type ReviewUser } from "./routes.js";
import { FeedDesk } from "./feed-desk.js";
import { registerFeedRoutes } from "./feed-routes.js";
import { resolve } from "path";
import { homedir } from "os";

let active: ReviewDesk | null = null;

/** The Feed (start-button-feed): one list of what needs the owner, what is parked, and the ideas — with Start. */
export function installFeed(app: Hono<any>, desk: ReviewDesk, resolveUser: (c: Context) => ReviewUser | null): FeedDesk | null {
  try {
    const foremanRoot = process.env.FEED_FOREMAN_ROOT ? resolve(process.env.FEED_FOREMAN_ROOT) : resolve(homedir(), "AHI/AHI_OS/foreman");
    const feed = new FeedDesk({
      desk,
      root: desk.store.root,
      foremanBuildsDir: defaultForemanBuildsDir(),
      briefsDir: process.env.FEED_BRIEFS_DIR ? resolve(process.env.FEED_BRIEFS_DIR) : resolve(foremanRoot, "briefs"),
      ideasPath: process.env.FEED_IDEAS_PATH === "none" ? null : process.env.FEED_IDEAS_PATH ? resolve(process.env.FEED_IDEAS_PATH) : resolve(homedir(), "AHI/personal/creative/ideas-future-build/IDEAS.md"),
      launchScript: process.env.FEED_LAUNCH_SCRIPT ? resolve(process.env.FEED_LAUNCH_SCRIPT) : resolve(foremanRoot, "bin/build_from_brief.sh"),
      foremanRoot,
      cap: Number(process.env.FEED_SLOT_CAP ?? process.env.FM_CAP ?? 5) || 5,
      // The wake is the review desk's own (bound in src/index.ts after the foreman desk is up).
      wake: (owner, text) => desk.wakeMichael(owner, text),
    });
    registerFeedRoutes(app, feed, { resolveUser });
    // A launch resolves out of process; fold its result in (and tell Michael) even when nobody has the app open.
    setInterval(() => {
      try {
        feed.reconcile();
      } catch (err) {
        console.error("[feed] reconcile failed:", err);
      }
    }, 30_000).unref();
    console.log(`[feed] up — briefs ${feed["opts"].briefsDir} · launcher ${feed["opts"].launchScript} · cap ${feed.cap}`);
    return feed;
  } catch (err) {
    console.error("[feed] FAILED to start — gateway continues without it:", err);
    return null;
  }
}

const AGENT = "michael";

function splitForTelegram(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max) > max / 2 ? rest.lastIndexOf("\n", max) : max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** REVIEW_ANNOUNCE_LANES="YELLOW,RED" narrows which new cards Michael announces; unset = every lane. */
function announceLanes(): Lane[] {
  const raw = process.env.REVIEW_ANNOUNCE_LANES;
  if (!raw) return [...LANES];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Lane => (LANES as readonly string[]).includes(s));
}

/**
 * The Builds panel starts with the honest backlog (design §8): every build
 * since the configured floor that nobody closed. REVIEW_TRACKS_SINCE sets the floor;
 * "none" turns the backfill off.
 */
function tracksSince(): Date | null {
  const raw = process.env.REVIEW_TRACKS_SINCE ?? "2026-10-01T00:00:00Z";
  if (raw === "none") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function installReviewDesk(
  app: Hono<any>,
  instances: BotInstance[],
  resolveUser: (c: Context) => ReviewUser | null,
): ReviewDesk | null {
  try {
    const desk = new ReviewDesk({
      agent: AGENT,
      foremanBuildsDir: defaultForemanBuildsDir(),
      foremanQueuePath: process.env.REVIEW_FOREMAN_QUEUE
        ? resolve(process.env.REVIEW_FOREMAN_QUEUE)
        : resolve(homedir(), "AHI/AHI_OS/foreman/QUEUE.md"),
      telegramCopy: process.env.REVIEW_TELEGRAM_COPY === "true",
      chatReplies: process.env.REVIEW_CHAT_REPLIES !== "false",
      // Read-only here: the Builds panel reads the status timelines the
      // foreman-messages desk writes (same root, FOREMAN_MESSAGES_STATE_DIR).
      timelines: new ForemanTimeline(),
      tracksSince: tracksSince(),
      appUrl: process.env.REVIEW_APP_URL || APP_URL,
      announceLanes: announceLanes(),
      deps: {
        // A new card: Michael says it in the chat, with a voice note — one
        // broadcast, so one push, whose tap opens the card.
        announce: async (msg) => {
          await announceCard(
            {
              voiceNote: async (bot, userId, text) => {
                const cfg = instances.find((i) => i.config.name === bot)?.config;
                if (!cfg) return null;
                const notes = await synthesizeVoiceNotes({
                  text,
                  voice: cfg.voice,
                  provider: cfg.ttsProvider,
                  googleVoice: cfg.googleVoice,
                  geminiVoice: cfg.geminiVoice,
                  styleInstructions: cfg.styleInstructions,
                  agentName: bot,
                  eleven: cfg.eleven,
                  cartesia: cfg.cartesia,
                });
                // One or two sentences are always one note; a stray extra part is not worth a second push.
                if (!notes.length) return null;
                return registerOutboundVoiceMedia({ userId, bot, audioBuffer: notes[0].audioBuffer, mimeType: notes[0].mimeType, transcript: text });
              },
              broadcast,
              user: (userId) => lookupByUserId(userId),
            },
            msg,
          );
        },
        postAsAgent: ({ userId, bot, text, turnId }) => {
          const user = lookupByUserId(userId);
          broadcast({
            type: "message",
            bot,
            direction: "out",
            contentType: "text",
            text,
            timestamp: new Date().toISOString(),
            chatId: user?.telegramChatId ?? 0,
            userId,
            senderName: user?.name ?? userId,
            source: "app",
            meta: { turnId },
          });
        },
        push: (userId, p) => sendPushToUser(userId, { agent: AGENT, source: "review", event: "requests", timeSensitive: true, ...p }),
        notifyClients: (userId, event) => broadcastEvent({ ...event, userId }),
        lastAgentTurnId: (userId, bot) => {
          const out = getMessagesForUser(bot, userId, 30).filter((m) => m.direction === "out");
          return out.length ? out[out.length - 1].meta?.turnId ?? null : null;
        },
        recentUserMessages: (userId) => {
          const user = lookupByUserId(userId);
          return (user?.agents ?? [AGENT])
            .flatMap((bot) => getMessagesForUser(bot, userId, 200))
            .filter((m) => m.direction === "in" && m.source !== "ui-send");
        },
        telegram: async (userId, text) => {
          const user = lookupByUserId(userId);
          const instance = instances.find((i) => i.config.name === AGENT);
          if (!user?.telegramChatId || !instance) return;
          for (const chunk of splitForTelegram(text)) await instance.bot.api.sendMessage(user.telegramChatId, chunk);
        },
      },
    });
    registerReviewRoutes(app, desk, { resolveUser });
    active = desk;
    installFeed(app, desk, resolveUser);
    // Gateway health alerts (degraded-notifier) land in Review → System —
    // never Telegram. Anything raised before this line was queued and lands now.
    setAlertSink({
      record: (a) => {
        const r = desk.recordAlert(a, "gateway");
        if (!r.ok) console.error(`[review] gateway alert refused: ${r.reason}`);
      },
      resolve: (cls) => void desk.resolveAlerts({ class: cls }, "gateway"),
    });
    // Approval wakes that wait (Shabbat gate, a failed turn) and alert pushes /
    // wakes that come due (6 h unacknowledged, nightfall) don't depend on the
    // review cron: the gateway drains them itself every minute.
    setInterval(() => {
      void desk.drainWakes().catch((err) => console.error("[review] wake drain failed:", err));
      void desk.drainAlerts().catch((err) => console.error("[review] alert drain failed:", err));
    }, 60_000).unref();
    const pk = desk.passkeys.config;
    console.log(
      `[review] desk up — state ${desk.store.root} · passkey RP ${pk.rpID} (${pk.origins.join(", ")}) · ` +
        `service API ${process.env.REVIEW_DESK_TOKEN ? "on" : "OFF (no REVIEW_DESK_TOKEN)"} · ` +
        `chat replies ${process.env.REVIEW_CHAT_REPLIES === "false" ? "off" : "on"} · Telegram copy ${process.env.REVIEW_TELEGRAM_COPY === "true" ? "on" : "off"}`,
    );
    return desk;
  } catch (err) {
    console.error("[review] desk FAILED to start — gateway continues without it:", err);
    active = null;
    return null;
  }
}

/**
 * /app/send hook: true when the message was a digest answer and has been
 * handled (the caller then skips the agent turn). Never throws.
 */
export function tryReviewChatReply(user: { userId: string; admin: boolean }, bot: string, text: string): boolean {
  if (!active || typeof text !== "string") return false;
  try {
    return active.tryChatReply(user, bot, text);
  } catch (err) {
    console.error("[review] chat reply handling failed — passing the message to the agent:", err);
    return false;
  }
}
