/**
 * feed-routes.ts — HTTP surface of the Feed. The owner's side only (/app/feed/*):
 * the gateway's existing user auth, admin only, and every write carries the
 * same `X-AHI-Review: 1` CSRF header + JSON body the review desk requires.
 * There is no service side: Michael's part of the deal is the brief in
 * foreman/briefs, and he starts builds with build_from_brief.sh himself.
 *
 *   GET  /app/feed                       the feed (reconciles launches first)
 *   POST /app/feed/rows/:id/challenge    fingerprint request for Start
 *   POST /app/feed/rows/:id/start        { webauthn } → launch recorded + started out of process
 *   POST /app/feed/rows/:id/ask          "ask Michael for a brief" (idea rows)
 *   POST /app/feed/rows/:id/close        { kind: closed | cancelled }
 *   POST /app/feed/rows/:id/file         { track: trk-… }
 */
import type { Context, Hono } from "hono";
import type { FeedDesk } from "./feed-desk.js";
import type { ReviewUser } from "./routes.js";

export interface FeedRouteDeps {
  resolveUser(c: Context): ReviewUser | null;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function registerFeedRoutes(app: Hono<any>, feed: FeedDesk, deps: FeedRouteDeps): void {
  function user(c: Context): ReviewUser | Response {
    const u = deps.resolveUser(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    if (!u.admin) return c.json({ error: "Forbidden" }, 403);
    return u;
  }

  async function userWrite(c: Context): Promise<{ u: ReviewUser; body: Record<string, unknown> } | Response> {
    const u = user(c);
    if (u instanceof Response) return u;
    if (c.req.header("x-ahi-review") !== "1") return c.json({ error: "missing X-AHI-Review header" }, 403);
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return c.json({ error: "JSON body required" }, 415);
    }
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "JSON object body required" }, 400);
    return { u, body };
  }

  app.get("/app/feed", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    c.header("Cache-Control", "no-store");
    return c.json(feed.view(u.userId));
  });

  app.post("/app/feed/rows/:id/challenge", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const r = await feed.startChallenge(w.u.userId, c.req.param("id"));
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json({ options: r.options });
  });

  app.post("/app/feed/rows/:id/start", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    // Only the raw authenticator response is read; nothing else in the body can claim a verification.
    const r = await feed.start(w.u.userId, c.req.param("id"), w.body.webauthn, w.u.userId);
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json({ ok: true, launch: r.launch, fresh: r.fresh }, r.fresh ? 201 : 200);
  });

  app.post("/app/feed/rows/:id/ask", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const r = await feed.askBrief(w.u.userId, c.req.param("id"), w.u.userId);
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json({ ok: true, asked_at: r.asked_at, fresh: r.fresh });
  });

  app.post("/app/feed/rows/:id/close", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const kind = w.body.kind === "cancelled" ? "cancelled" : w.body.kind === "closed" ? "closed" : null;
    if (!kind) return c.json({ error: "kind must be closed or cancelled" }, 400);
    const r = feed.close(w.u.userId, c.req.param("id"), kind);
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json(r);
  });

  app.post("/app/feed/rows/:id/file", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const r = feed.file(w.u.userId, c.req.param("id"), w.body.track);
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json(r);
  });
}
