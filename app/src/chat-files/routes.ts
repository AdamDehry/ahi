/**
 * HTTP surface of chat files. Two audiences, the two auth schemes this
 * gateway already uses (see src/review/routes.ts):
 *
 *   POST /api/chat/files    Michael / foreman (scripts/send-file.mjs).
 *                           `Authorization: Bearer $REVIEW_DESK_TOKEN` — the
 *                           same service token review.mjs carries, read from
 *                           the environment, never from argv. Unset = 503.
 *                           multipart: to, bot, caption?, file (repeatable).
 *
 *   GET /app/media          The user in the app (existing user auth). The
 *                           paged catalog behind the Media / Files / Links
 *                           panel: ?category=media|files|links
 *                           &bot=<agent>|all &cursor=&limit=. Versioned beside
 *                           the old /ui/media, which stays untouched for the
 *                           legacy dashboard.
 *   GET /app/media/context  ?bot=&id=&span= — the messages around one message,
 *                           so "Show in chat" can reach past the loaded window.
 */
import { createHash } from "crypto";
import type { Context, Hono } from "hono";
import {
  buildCatalog,
  CATEGORIES,
  contextAround,
  pageCatalog,
  type CatalogCategory,
  type CatalogItem,
} from "./catalog.js";
import { MAX_FILES, sendAgentFiles, checkRecipient, type ChatFilesDeps, type IncomingFile } from "./service.js";
import type { MessageEvent } from "../websocket.js";

export interface ChatFilesAppUser {
  userId: string;
  agents: string[];
}

export interface ChatFilesRouteDeps extends ChatFilesDeps {
  resolveUser(c: Context): ChatFilesAppUser | null;
  /** The whole known thread for (bot, user), oldest first. */
  thread(bot: string, userId: string): MessageEvent[];
  botLabel?: (bot: string) => string;
  /** Read at call time so a .env edit + restart is the only switch. */
  serviceToken?: () => string | undefined;
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  // Hash both sides: equal-length digests, no length or early-exit leak.
  const a = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.equals(b);
}

/**
 * The agent a file send comes from when the caller names none: Michael for a
 * user who has him (unchanged for the owner), otherwise the user's first agent —
 * a family member's Miriam — so a send to her never 403s on "does not have michael".
 */
export function defaultBotFor(deps: Pick<ChatFilesRouteDeps, "user">, to: string): string {
  const u = to ? deps.user(to.toLowerCase()) : null;
  if (!u || u.agents.includes("michael")) return "michael";
  return u.agents[0] ?? "michael";
}

export function registerChatFilesRoutes(app: Hono<any>, deps: ChatFilesRouteDeps): void {
  const serviceToken = deps.serviceToken ?? (() => process.env.REVIEW_DESK_TOKEN);

  // ── Michael → a user's chat ───────────────────────────────────────────
  app.post("/api/chat/files", async (c) => {
    const expected = serviceToken();
    if (!expected) return c.json({ error: "Chat files service API disabled (no REVIEW_DESK_TOKEN)" }, 503);
    if (!tokenMatches(c.req.header("authorization"), expected)) return c.json({ error: "Unauthorized" }, 401);

    // Recipient first, from the query or the form — but a 403 must not cost
    // reading 100 MB of body, so a query-string recipient is checked early.
    const qTo = c.req.query("to");
    const qBot = c.req.query("bot");
    if (qTo || qBot) {
      const early = checkRecipient(deps, qTo ?? "", qBot ?? defaultBotFor(deps, qTo ?? ""));
      if (!early.ok) return c.json({ error: early.error }, early.status);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }
    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : undefined;
    };
    const to = str("to") ?? qTo ?? "";
    const bot = str("bot") ?? qBot ?? defaultBotFor(deps, to);
    const entries = form.getAll("file");
    if (entries.length > MAX_FILES) return c.json({ error: `At most ${MAX_FILES} files per message` }, 400);
    const files: IncomingFile[] = [];
    for (const e of entries) {
      if (typeof e === "string") continue;
      files.push({ name: e.name, mime: e.type, data: new Uint8Array(await e.arrayBuffer()) });
    }
    const r = await sendAgentFiles(deps, { to, bot, caption: str("caption"), files });
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json({
      ok: true,
      messageId: r.event.meta?.messageId ?? null,
      media: r.media.map((m) => ({ id: m.id, type: m.type, name: m.originalName, mime: m.mime, size: m.size, durationSec: m.durationSec })),
    });
  });

  // ── The app: catalog + context ────────────────────────────────────────
  function botsFor(c: Context, user: ChatFilesAppUser): string[] | Response {
    const bot = c.req.query("bot");
    if (!bot || bot === "all") return user.agents;
    if (!user.agents.includes(bot)) return c.json({ error: `No access to ${bot}` }, 403);
    return [bot];
  }

  app.get("/app/media", (c) => {
    const user = deps.resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const category = (c.req.query("category") || "media") as CatalogCategory;
    if (!CATEGORIES.includes(category)) return c.json({ error: "category must be media, files or links" }, 400);
    const bots = botsFor(c, user);
    if (bots instanceof Response) return bots;
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") || "40", 10) || 40, 1), 200);

    const messages: MessageEvent[] = [];
    for (const b of bots) messages.push(...deps.thread(b, user.userId));
    const all: CatalogItem[] = buildCatalog(messages, category, deps.botLabel);
    const page = pageCatalog(all, c.req.query("cursor"), limit);
    c.header("Cache-Control", "no-store");
    return c.json({ category, bot: c.req.query("bot") || "all", ...page });
  });

  app.get("/app/media/context", (c) => {
    const user = deps.resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const bot = c.req.query("bot") || "";
    const id = c.req.query("id") || "";
    if (!bot || !id) return c.json({ error: "bot and id are required" }, 400);
    if (!user.agents.includes(bot)) return c.json({ error: `No access to ${bot}` }, 403);
    const span = Math.min(Math.max(Number.parseInt(c.req.query("span") || "25", 10) || 25, 1), 100);
    const around = contextAround(deps.thread(bot, user.userId), id, span);
    if (!around) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ messages: around });
  });
}
