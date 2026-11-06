/**
 * codex-live — a foreman Codex build, watchable live in the app.
 *
 *   GET /app/codex-live/:build?after=N   the transcript since event N + status
 *
 * The owner's existing user auth, admin only, read-only — nothing here can type
 * into a session. Push is a doorbell over the app's existing socket
 * (`codex-live` frame, admin-only, build id only); see service.ts.
 *
 * installCodexLive() never throws: if it cannot start, the gateway boots
 * without it and the app's live panel says it can't reach the transcript.
 */
import type { Context, Hono } from "hono";
import { broadcastEvent } from "../websocket.js";
import { CodexLive } from "./service.js";

export { CodexLive } from "./service.js";

export interface CodexLiveUser {
  admin?: boolean;
}

export function registerCodexLiveRoutes(app: Hono<any>, live: CodexLive, resolveUser: (c: Context) => CodexLiveUser | null): void {
  app.get("/app/codex-live/:build", (c) => {
    const u = resolveUser(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    if (!u.admin) return c.json({ error: "Forbidden" }, 403);
    c.header("Cache-Control", "no-store");
    const after = Number.parseInt(c.req.query("after") ?? "0", 10);
    const view = live.read(c.req.param("build"), Number.isFinite(after) && after > 0 ? after : 0);
    if (!view) return c.json({ error: "Not found" }, 404);
    return c.json(view);
  });
}

export function installCodexLive(app: Hono<any>, resolveUser: (c: Context) => CodexLiveUser | null): CodexLive | null {
  try {
    const live = new CodexLive({ notify: (build) => broadcastEvent({ type: "codex-live", build, adminOnly: true }) });
    registerCodexLiveRoutes(app, live, resolveUser);
    live.start();
    console.log(`[codex-live] ready — builds ${live.buildsDir}, sessions ${live.codexHome}/sessions`);
    return live;
  } catch (err) {
    console.error("[codex-live] failed to start — live Codex transcripts unavailable:", err);
    return null;
  }
}
