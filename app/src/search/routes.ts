/**
 * HTTP surface of inline search. Same two audiences, same two auth schemes as
 * chat files (src/chat-files/routes.ts):
 *
 *   The user in the app (existing user auth):
 *     GET  /app/search/status       { enabled, usage, limits } — the composer
 *                                   hides search entirely when enabled=false
 *     POST /app/search              { bot, kind: web|images, q } → runs the
 *                                   search and posts the card into that chat
 *     GET  /app/search/img          ?bot=&m=<card message id>&i=<n>&v=thumb|full|icon
 *                                   — the picture proxy. Takes NO URL: it
 *                                   serves only pictures stored on the user's
 *                                   own card, so it cannot be used as an open
 *                                   proxy into the box's network.
 *     POST /app/search/attach       { bot, m, i } → saves that picture the way
 *                                   an upload is saved (save-only, no turn) and
 *                                   returns its MediaRef, which the composer
 *                                   stages like any attached file.
 *
 *   Michael (scripts/search.mjs; Bearer $REVIEW_DESK_TOKEN):
 *     POST /api/search              { to, bot?, kind, q, post? } → the results
 *                                   as JSON, and (unless post=false) the card
 *                                   in that user's chat.
 */
import { createHash } from "crypto";
import type { Context, Hono } from "hono";
import type { MessageEvent } from "../websocket.js";
import { buildCardEvent, type SearchCardMeta, type SearchService } from "./service.js";
import type { SearchKind } from "./providers.js";
import { FetchRefused, fetchPublicImage, type FetchedImage } from "./fetch-public.js";

export interface SearchUser {
  userId: string;
  name: string;
  agents: string[];
  telegramChatId: number | null;
}

export interface SearchRouteDeps {
  service: SearchService;
  resolveUser(c: Context): SearchUser | null;
  /** Registered user by id (service route). */
  user(userId: string): SearchUser | null;
  bots(): string[];
  /** Persist + deliver (production: websocket.broadcast). */
  broadcast(event: MessageEvent): void;
  /** A card stored in (bot, user)'s thread, by message id. */
  card(bot: string, userId: string, messageId: string): SearchCardMeta | null;
  /** Save picked bytes save-only and register them as media (the /ui/upload path). */
  saveImage(userId: string, name: string, bytes: Buffer, mime: string): Promise<unknown>;
  fetchImage?: (url: string) => Promise<FetchedImage>;
  serviceToken?: () => string | undefined;
  botLabel?: (bot: string) => string;
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.equals(b);
}

/** Bounded LRU of proxied pictures (thumbnails mostly: 10 per card, re-read on every scroll past). */
class ImageCache {
  private map = new Map<string, FetchedImage>();
  private bytes = 0;
  constructor(private readonly maxBytes = 48 * 1024 * 1024) {}
  get(k: string): FetchedImage | undefined {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: FetchedImage): void {
    if (v.bytes.length > this.maxBytes / 8) return;
    if (this.map.has(k)) return;
    this.map.set(k, v);
    this.bytes += v.bytes.length;
    for (const [key, old] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(key);
      this.bytes -= old.bytes.length;
    }
  }
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** "sapphire-blue-brz-ts-3.jpg" — a readable attachment name from the query. */
export function attachName(query: string, index: number, mime: string): string {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "picture";
  return `${slug}-${index + 1}.${EXT[mime] ?? "jpg"}`;
}

export function registerSearchRoutes(app: Hono<any>, deps: SearchRouteDeps): void {
  const svc = deps.service;
  const fetchImage = deps.fetchImage ?? ((u: string) => fetchPublicImage(u));
  const serviceToken = deps.serviceToken ?? (() => process.env.REVIEW_DESK_TOKEN);
  const images = new ImageCache();

  function postCard(bot: string, user: SearchUser, by: string, outcome: Parameters<typeof buildCardEvent>[0]["outcome"]): MessageEvent {
    const byName = by === user.userId ? user.name : deps.botLabel?.(by) ?? by;
    const event = buildCardEvent({ bot, user, by, byName, outcome });
    deps.broadcast(event);
    return event;
  }

  async function body(c: Context): Promise<Record<string, unknown> | null> {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  const kindOf = (v: unknown): SearchKind | null => (v === "web" || v === "images" ? v : null);

  // ── The app ───────────────────────────────────────────────────────────
  app.get("/app/search/status", (c) => {
    const user = deps.resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    c.header("Cache-Control", "no-store");
    if (!svc.enabled()) return c.json({ enabled: false });
    void svc.refreshAccount();
    return c.json({ enabled: true, usage: svc.usage(), limits: svc.limits() });
  });

  app.post("/app/search", async (c) => {
    const user = deps.resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const b = await body(c);
    const bot = typeof b?.bot === "string" ? b.bot : "";
    const kind = kindOf(b?.kind);
    if (!bot || !kind) return c.json({ error: "bot and kind (web or images) are required" }, 400);
    if (!user.agents.includes(bot)) return c.json({ error: `No access to ${bot}` }, 403);
    const outcome = await svc.search(user.userId, kind, typeof b?.q === "string" ? b.q : "", user.userId);
    if (!outcome.ok) {
      if (outcome.retryAfterSec) c.header("Retry-After", String(outcome.retryAfterSec));
      return c.json({ error: outcome.error }, outcome.status);
    }
    const event = postCard(bot, user, user.userId, outcome);
    return c.json({ ok: true, messageId: event.meta?.messageId ?? null, cached: outcome.cached, usage: outcome.usage });
  });

  /** The URL a (card, index, variant) points at, or null. */
  function pictureUrl(card: SearchCardMeta, i: number, v: string): string | null {
    if (v === "icon") return card.web?.[i]?.favicon ?? null;
    const img = card.images?.[i];
    if (!img) return null;
    return v === "full" ? img.imageUrl : img.thumbnailUrl;
  }

  async function picture(user: SearchUser, bot: string, m: string, i: number, v: string): Promise<{ img: FetchedImage; card: SearchCardMeta } | { status: 400 | 403 | 404 | 502; error: string }> {
    if (!bot || !m || !Number.isInteger(i) || i < 0 || !["thumb", "full", "icon"].includes(v)) return { status: 400, error: "bot, m, i and v are required" };
    if (!user.agents.includes(bot)) return { status: 403, error: `No access to ${bot}` };
    const card = deps.card(bot, user.userId, m);
    if (!card) return { status: 404, error: "No such search card" };
    const url = pictureUrl(card, i, v);
    if (!url) return { status: 404, error: "No such picture" };
    const hit = images.get(url);
    if (hit) return { img: hit, card };
    try {
      const img = await fetchImage(url);
      images.set(url, img);
      return { img, card };
    } catch (err) {
      const why = err instanceof FetchRefused ? err.message : (err as Error)?.name === "TimeoutError" ? "timed out" : "unreachable";
      return { status: 502, error: `Picture unavailable (${why})` };
    }
  }

  app.get("/app/search/img", async (c) => {
    const user = deps.resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const v = c.req.query("v") || "thumb";
    const got = await picture(user, c.req.query("bot") || "", c.req.query("m") || "", Number(c.req.query("i")), v);
    if ("status" in got) return c.json({ error: got.error }, got.status);
    // Pictures on a card never change: let the browser keep them.
    return new Response(new Uint8Array(got.img.bytes), {
      headers: {
        "Content-Type": got.img.mime,
        "Cache-Control": "private, max-age=604800, immutable",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.post("/app/search/attach", async (c) => {
    const user = deps.resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const b = await body(c);
    const bot = typeof b?.bot === "string" ? b.bot : "";
    const m = typeof b?.m === "string" ? b.m : "";
    const i = Number(b?.i);
    // The full picture first; the thumbnail when the source site refuses us
    // (hotlink walls are common) — a smaller picture beats none.
    let got = await picture(user, bot, m, i, "full");
    if ("status" in got && got.status === 502) got = await picture(user, bot, m, i, "thumb");
    if ("status" in got) return c.json({ error: got.error }, got.status);
    try {
      const media = await deps.saveImage(user.userId, attachName(got.card.query, i, got.img.mime), got.img.bytes, got.img.mime);
      return c.json({ ok: true, media });
    } catch (err) {
      console.error("[search] attach save failed:", err);
      return c.json({ error: "Couldn't save the picture" }, 500);
    }
  });

  // ── Michael ───────────────────────────────────────────────────────────
  app.post("/api/search", async (c) => {
    const expected = serviceToken();
    if (!expected) return c.json({ error: "Search service API disabled (no REVIEW_DESK_TOKEN)" }, 503);
    if (!tokenMatches(c.req.header("authorization"), expected)) return c.json({ error: "Unauthorized" }, 401);
    const b = await body(c);
    const to = typeof b?.to === "string" ? b.to.toLowerCase() : "";
    const kind = kindOf(b?.kind);
    if (!to || !kind) return c.json({ error: "to and kind (web or images) are required" }, 400);
    const user = deps.user(to);
    if (!user) return c.json({ error: `No such user: ${to}` }, 403);
    const bot = typeof b?.bot === "string" && b.bot ? b.bot : user.agents.includes("michael") ? "michael" : user.agents[0] ?? "michael";
    if (!deps.bots().includes(bot)) return c.json({ error: `Unknown agent: ${bot}` }, 403);
    if (!user.agents.includes(bot)) return c.json({ error: `${user.name} does not have ${bot}` }, 403);
    const outcome = await svc.search(user.userId, kind, typeof b?.q === "string" ? b.q : "", bot);
    if (!outcome.ok) {
      if (outcome.retryAfterSec) c.header("Retry-After", String(outcome.retryAfterSec));
      return c.json({ error: outcome.error }, outcome.status);
    }
    const posted = b?.post === false ? null : postCard(bot, user, bot, outcome);
    return c.json({
      ok: true,
      messageId: posted?.meta?.messageId ?? null,
      cached: outcome.cached,
      usage: outcome.usage,
      results: outcome.results,
    });
  });
}
