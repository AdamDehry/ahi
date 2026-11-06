/**
 * Foreman messages — production wiring. The only file in src/foreman-messages/
 * that knows about the gateway's sockets, Telegram and the agent runtime;
 * everything else takes them as injected deps (and is tested that way).
 *
 * installForemanMessages() never throws: if the desk cannot start it logs
 * loudly and the gateway boots without it — the /foreman routes then 404, and
 * the foreman's patched lib.sh falls back to /ui/send, i.e. today's behaviour.
 */
import type { Context, Hono } from "hono";
import { broadcast, broadcastEvent } from "../websocket.js";
import { lookupByUserId } from "../users.js";
import { invokeAgent } from "../claude-invoke.js";
import type { GatewayConfig } from "../config.js";
import type { BotInstance } from "../telegram.js";
import { ForemanMessages } from "./service.js";
import { registerForemanRoutes, type ForemanRouteUser } from "./routes.js";
import { DEFAULT_ANSWERED_SCRIPT, MAX_ANSWERS, parseAnswers, recordBuildAnswers, runWriter, type AnswerOutcome } from "./answer.js";

const AGENT = "michael";
const ANSWER_TIMEOUT_MS = 20_000;

/** The running desk, for the /app/send hook below (null until installed, or if it failed). */
let active: { desk: ForemanMessages; port: number } | null = null;

/**
 * /app/send hook: the owner's message answered build questions (the app sends, per
 * question, the asking run, the needs_operator record id and the words he added). Call AFTER the message is on its way to Michael —
 * this only clears the cards. Admin + Michael's thread only; never throws.
 * FOREMAN_ANSWERED_SCRIPT overrides the writer (empty = off).
 */
export function recordAppAnswers(user: { userId: string; admin: boolean }, bot: string, answers: unknown, text: string): Promise<AnswerOutcome[]> {
  if (!active || !user.admin || bot !== AGENT) return Promise.resolve([]);
  const parsed = parseAnswers(answers);
  if (parsed.malformed) console.warn(`[foreman-messages] /app/send: ${parsed.malformed} malformed or repeated answer link(s) ignored`);
  if (parsed.overCap) console.warn(`[foreman-messages] /app/send: ${parsed.overCap} answer link(s) over the cap of ${MAX_ANSWERS} not recorded — those cards keep asking`);
  if (!parsed.answers.length) return Promise.resolve([]);
  const script = process.env.FOREMAN_ANSWERED_SCRIPT ?? DEFAULT_ANSWERED_SCRIPT;
  if (!script) return Promise.resolve([]);
  const { desk, port } = active;
  return recordBuildAnswers(
    {
      read: (build) => desk.timeline.read(build),
      guard: (build, record, line) => desk.guardAnswer(build, record, line),
      // The script posts back to THIS gateway (its default port is production's). Own process
      // group: a timeout kills all of it, and the guard holds until the group is gone.
      run: (build, line) => runWriter(script, [build, line], { timeoutMs: ANSWER_TIMEOUT_MS, env: { ...process.env, GATEWAY_URL: `http://localhost:${port}` } }),
      log: (m) => console.warn(m),
    },
    parsed.answers,
    text,
  ).then((outs) => {
    for (const o of outs) if (o.result === "answered") console.log(`[foreman-messages] the owner's answer cleared the question on ${o.build}`);
    return outs;
  });
}

export function installForemanMessages(
  app: Hono<any>,
  instances: BotInstance[],
  config: GatewayConfig,
  resolveUser: (c: Context) => ForemanRouteUser | null,
): ForemanMessages | null {
  try {
    const desk = new ForemanMessages({
      agent: AGENT,
      telegramCopy: process.env.FOREMAN_MESSAGES_TELEGRAM === "true",
      deps: {
        postAsAgent: ({ userId, bot, text, build, kind }) => {
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
            meta: { foreman: { build, kind } },
          });
        },
        telegram: async (userId, text) => {
          const user = lookupByUserId(userId);
          const instance = instances.find((i) => i.config.name === AGENT);
          if (!user?.telegramChatId || !instance) return;
          await instance.bot.api.sendMessage(user.telegramChatId, text);
        },
        // Same turn /ui/send runs — same chat id, session and model — so
        // Michael keeps one continuous context. Only the surface differs: no
        // broadcast of the wake, no stream events, no reply into the feed.
        invokeWake: async (userId, text) => {
          const instance = instances.find((i) => i.config.name === AGENT);
          if (!instance) throw new Error(`unknown bot ${AGENT}`);
          const user = lookupByUserId(userId);
          const result = await invokeAgent({
            chatId: user?.telegramChatId ?? instance.lastChatId ?? 0,
            botName: AGENT,
            message: text,
            sessionMap: instance.sessionMap,
            config,
            model: instance.config.model,
          });
          return result.response;
        },
        // The app refetches its board and the open card on this (badge, attention bar, ship stepper).
        onBuildChange: (build) => broadcastEvent({ type: "builds-update", build, adminOnly: true }),
        log: (m) => console.warn(m),
      },
    });
    registerForemanRoutes(app, desk, { resolveUser });
    active = { desk, port: config.port };
    console.log(
      `[foreman-messages] up — state ${desk.timeline.root} · Telegram copy ${process.env.FOREMAN_MESSAGES_TELEGRAM === "true" ? "on" : "off"}`,
    );
    return desk;
  } catch (err) {
    console.error("[foreman-messages] FAILED to start — gateway continues without it:", err);
    return null;
  }
}
