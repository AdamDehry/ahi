/**
 * Chat files — production wiring. The only file in src/chat-files/ that knows
 * about the gateway's sockets, users and stores; everything else takes them
 * as injected deps (and is tested that way).
 *
 * installChatFiles() never throws: if it cannot start it logs loudly and the
 * gateway boots without it (the routes then 404).
 */
import type { Context, Hono } from "hono";
import { broadcast } from "../websocket.js";
import { lookupByUserId } from "../users.js";
import { getFullThreadForUser } from "../message-store.js";
import type { BotInstance } from "../telegram.js";
import { registerChatFilesRoutes, type ChatFilesAppUser } from "./routes.js";
import { setSentinelDeps } from "./sentinel.js";
import type { ChatFilesDeps } from "./service.js";

export function installChatFiles(
  app: Hono<any>,
  instances: BotInstance[],
  resolveUser: (c: Context) => ChatFilesAppUser | null,
): boolean {
  try {
    const deps: ChatFilesDeps = {
      user: (userId) => {
        const u = lookupByUserId(userId);
        return u ? { userId: u.userId, name: u.name, agents: u.agents, telegramChatId: u.telegramChatId } : null;
      },
      bots: () => instances.map((i) => i.config.name),
      broadcast,
    };
    registerChatFilesRoutes(app, { ...deps, resolveUser, thread: getFullThreadForUser });
    // `[[send_file:]]` in any reply now lands in the app chat too (sentinel.ts).
    setSentinelDeps(deps);
    console.log(
      `[chat-files] up — agent file sends ${process.env.REVIEW_DESK_TOKEN ? "on" : "OFF (no REVIEW_DESK_TOKEN)"} · media panel /app/media`,
    );
    return true;
  } catch (err) {
    console.error("[chat-files] FAILED to start — gateway continues without it:", err);
    return false;
  }
}
