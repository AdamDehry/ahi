/**
 * Inline search — production wiring. The only file in src/search/ that knows
 * the gateway's sockets, users, stores and env; the rest take them as deps.
 *
 * installSearch() never throws. With no SERPAPI_API_KEY the routes still
 * answer (status says enabled=false, so the app hides search), Michael is not
 * told about it, and the gateway logs one line.
 *
 * Provider: Serper (SERPER_API_KEY); SerpApi (SERPAPI_API_KEY) only when
 * there is no Serper key. See providers.ts.
 *
 * SEARCH_FIXTURE_DIR (preview/tests ONLY): answer from recorded Serper bodies
 * in that folder (search.json, images.json) instead of the network. Logged
 * loudly; never set it in production.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Context, Hono } from "hono";
import { broadcast } from "../websocket.js";
import { lookupByUserId } from "../users.js";
import { getFullThreadForUser, getMessagesForUser } from "../message-store.js";
import { mediaRef, registerMedia } from "../media-store.js";
import { getFilePath, saveFile } from "../uploads.js";
import type { BotInstance } from "../telegram.js";
import { normalizeSerper, providerFromEnv, type SearchProvider } from "./providers.js";
import { countLoggedThisMonth, findCard, SearchService, type SearchCardMeta } from "./service.js";
import { registerSearchRoutes, type SearchUser } from "./routes.js";
import { setSearchSentinelDeps } from "./sentinel.js";

/** A Serper stand-in that answers every query from recorded bodies. */
export function fixtureProvider(dir: string): SearchProvider {
  return {
    name: "serper",
    async search(kind, query) {
      const file = join(dir, kind === "web" ? "search.json" : "images.json");
      if (!existsSync(file)) throw new Error(`fixture missing: ${file}`);
      await new Promise((r) => setTimeout(r, 300)); // a little realism for the UI's busy state
      return normalizeSerper(kind, query, JSON.parse(readFileSync(file, "utf-8")));
    },
  };
}

let service: SearchService | null = null;

/** The running service (null before install / when install failed). */
export function searchService(): SearchService | null {
  return service;
}

export function installSearch(
  app: Hono<any>,
  instances: BotInstance[],
  resolveUser: (c: Context) => SearchUser | null,
): boolean {
  try {
    const fixtureDir = process.env.SEARCH_FIXTURE_DIR?.trim();
    const fixture = fixtureDir ? fixtureProvider(fixtureDir) : null;
    // Read at call time: a .env edit + restart is the only switch.
    const provider = (): SearchProvider | null => fixture ?? providerFromEnv();
    service = new SearchService({ provider, loggedThisMonth: () => countLoggedThisMonth() });
    const svc = service;

    const user = (userId: string): SearchUser | null => {
      const u = lookupByUserId(userId);
      return u ? { userId: u.userId, name: u.name, agents: u.agents, telegramChatId: u.telegramChatId } : null;
    };
    const botLabel = (bot: string): string => (bot.charAt(0).toUpperCase() + bot.slice(1));
    // Cards never change once written: remember the ones we have looked up.
    const cards = new Map<string, SearchCardMeta>();
    const card = (bot: string, userId: string, messageId: string): SearchCardMeta | null => {
      const k = `${bot}/${userId}/${messageId}`;
      const hit = cards.get(k);
      if (hit) return hit;
      const found = findCard(getMessagesForUser(bot, userId, 500), messageId) ?? findCard(getFullThreadForUser(bot, userId), messageId);
      if (found) {
        if (cards.size > 2000) cards.clear();
        cards.set(k, found);
      }
      return found;
    };

    registerSearchRoutes(app, {
      service: svc,
      resolveUser,
      user,
      bots: () => instances.map((i) => i.config.name),
      broadcast,
      card,
      botLabel,
      // Exactly what /ui/upload does without a `bot`: save to the user's
      // files, register as media, broadcast nothing, run no turn.
      saveImage: async (userId, name, bytes, mime) => {
        const saved = await saveFile(userId, name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        const fullPath = getFilePath(userId, saved);
        if (!fullPath) throw new Error("saved picture could not be resolved");
        const record = await registerMedia({ userId, source: "ui-upload", type: "image", filePath: fullPath, originalName: name, mime });
        return mediaRef(record);
      },
    });
    setSearchSentinelDeps({ service: svc, user, broadcast, botLabel });

    if (fixture) console.warn(`[search] FIXTURE MODE — answering from ${fixtureDir}, not the network. Never in production.`);
    else if (svc.enabled()) {
      console.log(`[search] up — ${svc.providerName()} web + images · ${svc.limits().perHour}/h per user · cache ${svc.limits().cacheHours} h`);
      void svc.refreshAccount();
    } else console.log("[search] off — no SERPER_API_KEY (or SERPAPI_API_KEY); the app hides search");
    return true;
  } catch (err) {
    console.error("[search] FAILED to start — gateway continues without it:", err);
    return false;
  }
}
