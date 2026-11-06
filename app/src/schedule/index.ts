/**
 * Schedule — the owner's week as a live calendar. Production wiring
 * and the HTTP surface. Admin only (it is the owner's week); every write carries
 * the review desk's `X-AHI-Review: 1` CSRF header and a JSON body.
 *
 *   GET  /app/schedule?week=0                 the calendar (week offset −8…8) + current block + background lane + attention
 *   GET  /app/schedule/badge                  { unread, badge }   ("9+" past nine)
 *   GET  /app/schedule/blocks/:id             one block's briefing
 *   POST /app/schedule/read      { ids }      mark items read (opening / seeing them)
 *   POST /app/schedule/read-all  {}           clear all
 *   POST /app/schedule/decisions/:id/overrule { note? }  → recorded + Michael woken
 *
 * Michael's side is files, not HTTP: week.json / tags.json to edit, and
 * scripts/schedule.mjs decide to log a call he made on his own.
 * installSchedule never throws — a bad file must not take the gateway down.
 */
import type { Context, Hono } from "hono";
import { ForemanTimeline } from "../foreman-messages/timeline.js";
import { defaultForemanBuildsDir } from "../review/ledger.js";
import { ReadState } from "./read-state.js";
import { ScheduleService } from "./service.js";
import { defaultActivityPath, defaultSources, type RawReview } from "./sources.js";
import { scheduleDir, seedDir } from "./week.js";
import { join } from "path";

export interface ScheduleUser {
  userId: string;
  admin: boolean;
}

export interface ScheduleDeps {
  resolveUser(c: Context): ScheduleUser | null;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function registerScheduleRoutes(app: Hono<any>, svc: ScheduleService, deps: ScheduleDeps): void {
  function user(c: Context): ScheduleUser | Response {
    const u = deps.resolveUser(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    if (!u.admin) return c.json({ error: "Forbidden" }, 403);
    return u;
  }

  async function write(c: Context): Promise<{ u: ScheduleUser; body: Record<string, unknown> } | Response> {
    const u = user(c);
    if (u instanceof Response) return u;
    if (c.req.header("x-ahi-review") !== "1") return c.json({ error: "missing X-AHI-Review header" }, 403);
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "JSON body required" }, 415);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "JSON object body required" }, 400);
    return { u, body };
  }

  const fail = (c: Context, err: unknown) => {
    console.error("[schedule] request failed:", err);
    return c.json({ error: "The schedule could not be read." }, 500);
  };

  app.get("/app/schedule", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    c.header("Cache-Control", "no-store");
    try {
      return c.json(svc.view(u.userId, Number(c.req.query("week") ?? 0)));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/app/schedule/badge", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    c.header("Cache-Control", "no-store");
    try {
      return c.json(svc.badge(u.userId));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/app/schedule/blocks/:id", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    c.header("Cache-Control", "no-store");
    try {
      const b = svc.briefing(u.userId, c.req.param("id"));
      return b ? c.json(b) : c.json({ error: "no such block" }, 404);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/app/schedule/read", async (c) => {
    const w = await write(c);
    if (w instanceof Response) return w;
    const ids = Array.isArray(w.body.ids) ? w.body.ids.filter((x): x is string => typeof x === "string") : null;
    if (!ids) return c.json({ error: "ids must be a list" }, 400);
    try {
      return c.json(svc.markRead(w.u.userId, ids));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/app/schedule/read-all", async (c) => {
    const w = await write(c);
    if (w instanceof Response) return w;
    try {
      return c.json(svc.markAllRead(w.u.userId));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/app/schedule/decisions/:id/overrule", async (c) => {
    const w = await write(c);
    if (w instanceof Response) return w;
    const note = typeof w.body.note === "string" && w.body.note.trim() ? w.body.note.trim().slice(0, 300) : null;
    try {
      const r = await svc.overrule(w.u.userId, c.req.param("id"), note);
      if (!r.ok) return c.json({ error: r.reason }, r.status);
      return c.json(r);
    } catch (err) {
      return fail(c, err);
    }
  });
}

export interface InstallScheduleOptions {
  /** Review cards for the owner (the review desk's store). */
  reviewItems?: ((owner: string) => RawReview[]) | null;
  wake?: ((owner: string, text: string) => Promise<void>) | null;
}

export function installSchedule(app: Hono<any>, resolveUser: (c: Context) => ScheduleUser | null, opts: InstallScheduleOptions = {}): ScheduleService | null {
  try {
    const live = scheduleDir();
    let timelines: ForemanTimeline | null = null;
    try {
      timelines = new ForemanTimeline();
    } catch (err) {
      console.error("[schedule] status timelines unavailable — builds show without their lines:", err);
    }
    const sources = defaultSources({
      buildsDir: defaultForemanBuildsDir(),
      timelines,
      reviewItems: opts.reviewItems ?? null,
      activityPath: defaultActivityPath(),
      decisionsPath: join(live, "decisions.jsonl"),
    });
    const svc = new ScheduleService({
      sources,
      readState: new ReadState(),
      dirs: { live, seed: seedDir() },
      wake: opts.wake ?? null,
    });
    registerScheduleRoutes(app, svc, { resolveUser });
    // An overrule whose wake failed is retried until it lands (decisions.jsonl carries the delivered line).
    setInterval(() => {
      svc.retryOverruleWakes().catch((err) => console.error("[schedule] overrule retry sweep failed:", err));
    }, 5 * 60_000).unref();
    console.log(`[schedule] up — week ${live}/week.json (seed ${seedDir()})`);
    return svc;
  } catch (err) {
    console.error("[schedule] FAILED to start — gateway continues without it:", err);
    return null;
  }
}
