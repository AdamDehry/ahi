/**
 * HTTP surface of the live studio. Small on purpose: the cards carry their
 * pictures as ordinary media (served by /ui/media/:id), and an answer is an
 * ordinary message (chat) or call drop (call). What is left:
 *
 *   The user in the app (existing user auth):
 *     GET  /app/studio/status   ?bot=  { enabled, agents, engines, jobs }
 *     POST /app/studio/stop     { bot, jobId } — stop one of HIS running jobs
 *
 *   Agents and scripts (Bearer $REVIEW_DESK_TOKEN, like /api/search):
 *     POST /api/studio/job      { to, bot, ...job spec } → starts the job
 *     POST /api/studio/decision { to, bot, ask, options | folder } → posts a card
 */
import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Studio, StudioUser } from "./service.js";

export interface StudioRouteDeps {
  studio: Studio;
  resolveUser(c: Context): { userId: string } | null;
  /** Agents with the studio (STUDIO_AGENTS). */
  agents(): string[];
  serviceToken?: () => string | undefined;
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.equals(b);
}

async function body(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function registerStudioRoutes(app: Hono<any>, deps: StudioRouteDeps): void {
  const s = deps.studio;
  const serviceToken = deps.serviceToken ?? (() => process.env.REVIEW_DESK_TOKEN);

  app.get("/app/studio/status", (c) => {
    const user = deps.resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const bot = c.req.query("bot") || "";
    const agents = deps.agents();
    const engines = Object.values(s.jobs.engines())
      .filter((e) => e.kind !== "fixture" || process.env.STUDIO_FIXTURE_DIR)
      .map((e) => ({ name: e.name, label: e.label, available: e.unavailable() === null }));
    const jobs = bot && agents.includes(bot)
      ? s.jobs.recent(user.userId, bot, 8).map((j) => ({ id: j.id, engine: j.engine, n: j.n, ask: j.ask ?? "", status: j.status, startedAt: j.startedAt, endedAt: j.endedAt ?? null, files: j.files.length }))
      : [];
    return c.json({ enabled: true, agents, engines, jobs });
  });

  app.post("/app/studio/stop", async (c) => {
    const user = deps.resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const b = await body(c);
    const job = typeof b?.jobId === "string" ? s.jobs.get(b.jobId) : null;
    if (!job || job.userId !== user.userId) return c.json({ error: "No such job" }, 404);
    if (job.status !== "running") return c.json({ ok: true, already: job.status });
    s.jobs.cancel(job.id);
    s.note(job.userId, job.bot, `${user.userId} stopped the job "${job.ask || job.prompt.slice(0, 60)}" from its card`);
    return c.json({ ok: true });
  });

  const service = (path: string, run: (to: string, bot: string, b: Record<string, unknown>) => Promise<Response> | Response) =>
    app.post(path, async (c) => {
      const expected = serviceToken();
      if (!expected) return c.json({ error: "Studio service API disabled (no REVIEW_DESK_TOKEN)" }, 503);
      if (!tokenMatches(c.req.header("authorization"), expected)) return c.json({ error: "Unauthorized" }, 401);
      const b = await body(c);
      const to = typeof b?.to === "string" ? b.to.toLowerCase() : "";
      const bot = typeof b?.bot === "string" ? b.bot : "";
      if (!to || !bot) return c.json({ error: "to and bot are required" }, 400);
      if (!deps.agents().includes(bot)) return c.json({ error: `${bot} does not have the studio` }, 403);
      return run(to, bot, b!);
    });

  service("/api/studio/job", (to, bot, b) => {
    const { to: _t, bot: _b, ...spec } = b;
    const r = s.startJob(to, bot, spec);
    return r.ok ? Response.json({ ok: true, jobId: r.job!.id, folder: r.job!.outDir }) : Response.json({ error: r.error }, { status: 400 });
  });

  service("/api/studio/decision", async (to, bot, b) => {
    const { to: _t, bot: _b, ...spec } = b;
    const r = await s.postDecision(to, bot, spec);
    return r.ok ? Response.json({ ok: true, options: r.card!.options.length }) : Response.json({ error: r.error }, { status: 400 });
  });
}

export type { StudioUser };
