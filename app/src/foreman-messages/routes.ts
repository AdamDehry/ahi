/**
 * routes.ts — HTTP surface of foreman messages.
 *
 *   POST /foreman/status            one status record → timeline (+ the owner's chat for chat kinds)
 *   POST /foreman/wake              {text} → Michael's quiet supervision turn (202, background)
 *   GET  /foreman/builds            builds with a timeline, newest first
 *   GET  /foreman/timeline/:build   one build's timeline — what the app panel will read
 *   POST /foreman/ship              one ship stage (ready | started | … | result) → timeline; ready → the owner's chat once
 *   GET  /foreman/ship/:build       the derived ship state (ship.sh reads it before acting)
 *
 * Auth is the gateway's existing user auth (X-AHI-Token / cookie, the same
 * token the foreman already uses for /ui/send) and admin users only, so no new
 * secret is introduced. Writes also need `X-AHI-Foreman: 1` and a JSON body:
 * the session cookie is SameSite=None, so a custom header forces a CORS
 * preflight the gateway never grants (same reasoning as the review desk).
 */
import type { Context, Hono } from "hono";
import { BUILD_ID_RE } from "./record.js";
import type { ForemanMessages } from "./service.js";

export interface ForemanRouteUser {
  userId: string;
  admin: boolean;
}

export interface ForemanRouteDeps {
  resolveUser(c: Context): ForemanRouteUser | null;
}

const MAX_BODY = 256 * 1024;

export function registerForemanRoutes(app: Hono<any>, desk: ForemanMessages, deps: ForemanRouteDeps): void {
  function admin(c: Context): ForemanRouteUser | Response {
    const u = deps.resolveUser(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    if (!u.admin) return c.json({ error: "Forbidden" }, 403);
    return u;
  }

  async function writeBody(c: Context): Promise<unknown | Response> {
    if (c.req.header("x-ahi-foreman") !== "1") return c.json({ error: "missing X-AHI-Foreman header" }, 400);
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return c.json({ error: "JSON body required" }, 415);
    }
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return c.json({ error: "body too large" }, 413);
    try {
      return JSON.parse(raw);
    } catch {
      return c.json({ error: "malformed JSON" }, 400);
    }
  }

  app.post("/foreman/status", async (c) => {
    const u = admin(c);
    if (u instanceof Response) return u;
    const body = await writeBody(c);
    if (body instanceof Response) return body;
    try {
      const out = desk.ingest(body, { userId: u.userId });
      if (!out.ok) return c.json(out, 422);
      return c.json(out);
    } catch (err) {
      console.error("[foreman-messages] ingest failed:", err);
      return c.json({ ok: false, error: "ingest failed" }, 500);
    }
  });

  app.post("/foreman/wake", async (c) => {
    const u = admin(c);
    if (u instanceof Response) return u;
    const body = await writeBody(c);
    if (body instanceof Response) return body;
    const text = (body as { text?: unknown })?.text;
    if (typeof text !== "string" || !text.trim()) return c.json({ error: "text required" }, 400);
    // Background, like /ui/send: the foreman's POST must not hang on a turn.
    void desk.wake(u.userId, text).catch((err) => console.error("[foreman-messages] wake failed:", err));
    return c.json({ ok: true, quiet: true }, 202);
  });

  app.get("/foreman/builds", (c) => {
    const u = admin(c);
    if (u instanceof Response) return u;
    return c.json({ builds: desk.timeline.builds() });
  });

  app.post("/foreman/ship", async (c) => {
    const u = admin(c);
    if (u instanceof Response) return u;
    const body = await writeBody(c);
    if (body instanceof Response) return body;
    const title = (body as { title?: unknown })?.title;
    const input = { ...(body as Record<string, unknown>) };
    delete input.title;
    try {
      const out = desk.shipIngest(input, { userId: u.userId, title: typeof title === "string" ? title : null });
      if (!out.ok) return c.json(out, 422);
      return c.json(out);
    } catch (err) {
      console.error("[foreman-messages] ship ingest failed:", err);
      return c.json({ ok: false, error: "ship ingest failed" }, 500);
    }
  });

  app.get("/foreman/ship/:build", (c) => {
    const u = admin(c);
    if (u instanceof Response) return u;
    const build = c.req.param("build");
    if (!BUILD_ID_RE.test(build)) return c.json({ error: "bad build id" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json({ build, state: desk.shipState(build) });
  });

  app.get("/foreman/timeline/:build", (c) => {
    const u = admin(c);
    if (u instanceof Response) return u;
    const build = c.req.param("build");
    if (!BUILD_ID_RE.test(build)) return c.json({ error: "bad build id" }, 400);
    return c.json({ build, entries: desk.timeline.read(build) });
  });
}
