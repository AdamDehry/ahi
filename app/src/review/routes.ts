/**
 * routes.ts — HTTP surface of the review desk.
 *
 * Two audiences, two auth schemes, both existing patterns in this gateway:
 *
 *   /app/review/*  the owner in the PWA. The gateway's EXISTING user auth (the
 *                  same resolveUser the dashboard uses: X-AHI-Token / cookie).
 *                  Admin users only, and only their own items. Every write
 *                  also needs the `X-AHI-Review: 1` header + a JSON body: the
 *                  session cookie is SameSite=None, so without a custom header
 *                  a page on another site could POST a YELLOW approval with
 *                  The owner's cookie. A custom header forces a CORS preflight the
 *                  gateway never grants.
 *
 *   /api/review/*  Michael / foreman / cron. `Authorization: Bearer
 *                  $REVIEW_DESK_TOKEN` (same shape as GLASSES_TOKEN /
 *                  ABE_GATEWAY_TOKEN). Unset token = 503, closed. This side
 *                  can post items, mark them done, tick the schedule, open a
 *                  passkey-enrollment window and manage tracks — it can NEVER
 *                  approve, deny or hold an item. Decisions are the owner's.
 */
import { ownerUserId } from "../users.js";
import { createHash } from "crypto";
import type { Context, Hono } from "hono";
import type { ReviewDesk } from "./desk.js";

export interface ReviewUser {
  userId: string;
  name: string;
  admin: boolean;
}

export interface ReviewRouteDeps {
  resolveUser(c: Context): ReviewUser | null;
  /** Read at call time so a .env edit + restart is the only switch. */
  serviceToken?: () => string | undefined;
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.equals(b);
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function registerReviewRoutes(app: Hono<any>, desk: ReviewDesk, deps: ReviewRouteDeps): void {
  const serviceToken = deps.serviceToken ?? (() => process.env.REVIEW_DESK_TOKEN);

  // ── auth helpers ──────────────────────────────────────────────────────

  function user(c: Context): ReviewUser | Response {
    const u = deps.resolveUser(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    if (!u.admin) return c.json({ error: "Forbidden" }, 403);
    return u;
  }

  /** Writes: user auth + CSRF header + JSON. */
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

  function service(c: Context): Response | null {
    const expected = serviceToken();
    if (!expected) return c.json({ error: "Review desk service API disabled (no REVIEW_DESK_TOKEN)" }, 503);
    if (!tokenMatches(c.req.header("authorization"), expected)) return c.json({ error: "Unauthorized" }, 401);
    return null;
  }

  function actorOf(body: Record<string, unknown> | null, fallback = "michael"): string {
    const a = body?.actor;
    return typeof a === "string" && /^[a-z0-9:._-]{1,60}$/i.test(a) ? a : fallback;
  }

  // ── the owner (PWA) ────────────────────────────────────────────────────────

  app.get("/app/review", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    return c.json(desk.view(u.userId, c.req.query("mark") === "1"));
  });

  app.get("/app/review/summary", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    return c.json({ waiting: desk.waitingCount(u.userId) });
  });

  app.get("/app/review/items/:id", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    const item = desk.store.get(c.req.param("id"));
    if (!item || item.owner !== u.userId) return c.json({ error: "Not found" }, 404);
    return c.json({ item, passkeys: desk.passkeys.count(u.userId) });
  });

  app.post("/app/review/items/:id/challenge", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const r = await desk.approveChallenge(w.u.userId, c.req.param("id"));
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json({ options: r.options });
  });

  app.post("/app/review/items/:id/decide", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    // Only `decision` and the raw `webauthn` response are read. A body that
    // also says verified:true / channel:"fingerprint" gains nothing.
    const r = await desk.decide(w.u.userId, c.req.param("id"), w.body.decision, w.body.webauthn, w.u.userId);
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json({ ok: true, item: r.item });
  });

  app.get("/app/review/tracks", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    return c.json({ tracks: desk.board() });
  });

  // Builds panel (B1/B2). One composed read, so the phone makes one request
  // instead of one per build — and the web app never calls /foreman/*.

  app.get("/app/builds", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    c.header("Cache-Control", "no-store");
    return c.json(desk.buildsView(u.userId));
  });

  app.get("/app/builds/:id", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    c.header("Cache-Control", "no-store");
    const card = desk.buildDetail(u.userId, c.req.param("id"));
    if (!card) return c.json({ error: "Not found" }, 404);
    return c.json(card);
  });

  /** the owner closes (or cancels) a card himself — recorded as "owner (app)". */
  app.post("/app/builds/:id/close", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const kind = w.body.kind === "cancelled" ? "cancelled" : w.body.kind === "closed" ? "closed" : null;
    if (!kind) return c.json({ error: "kind must be closed or cancelled" }, 400);
    const r = desk.buildClose(w.u.userId, c.req.param("id"), kind);
    if (!r.ok) return c.json({ error: r.reason }, r.status);
    return c.json(r);
  });

  /** Ship update's fingerprint request: `options: null` when no passkey is registered (the ship is a tap). */
  app.post("/app/builds/:id/ship/challenge", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const r = await desk.shipChallenge(w.u.userId, c.req.param("id"));
    if (!r.ok) return c.json({ error: r.reason }, r.status);
    return c.json({ options: r.options });
  });

  /** the owner's Ship tap: records who/when + the restart choice, wakes Michael with the ship envelope. Safe to tap twice. */
  app.post("/app/builds/:id/ship", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const r = await desk.buildShip(w.u.userId, c.req.param("id"), w.body.restart, w.u.name || w.u.userId, w.body.webauthn);
    if (!r.ok) return c.json({ error: r.reason }, r.status);
    return c.json(r);
  });

  /** File a loose build under an open track — its stand-alone row retires into the track. */
  app.post("/app/builds/:id/file", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const r = desk.buildFile(w.u.userId, c.req.param("id"), w.body.track);
    if (!r.ok) return c.json({ error: r.reason }, r.status);
    return c.json(r);
  });

  // System alerts (Review → System): the owner's "got it" stops the push.

  app.post("/app/review/alerts/:class/ack", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const e = desk.ackAlert(c.req.param("class"), w.u.userId);
    if (!e) return c.json({ error: "No open alert of that class" }, 404);
    return c.json({ ok: true, alert: e });
  });

  // Passkeys (Settings → Passkeys)

  app.get("/app/review/passkeys", (c) => {
    const u = user(c);
    if (u instanceof Response) return u;
    return c.json({
      passkeys: desk.passkeys.list(u.userId),
      enroll_open_until: desk.passkeys.enrollmentOpenUntil(u.userId)?.toISOString() ?? null,
      rp_id: desk.passkeys.config.rpID,
    });
  });

  /** Fingerprint request to PROVE an existing passkey (before adding another, or removing one). */
  app.post("/app/review/passkeys/challenge", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const purpose = w.body.purpose === "remove" && typeof w.body.id === "string" ? `remove:${w.body.id}` : w.body.purpose === "enroll" ? "enroll" : null;
    if (!purpose) return c.json({ error: "purpose must be enroll or remove (+id)" }, 400);
    const r = await desk.passkeys.authOptions(w.u.userId, purpose);
    if ("ok" in r && r.ok === false) return c.json({ error: r.reason, code: r.code }, 409);
    return c.json({ options: r });
  });

  app.post("/app/review/passkeys/options", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const r = await desk.passkeys.registrationOptions(w.u.userId, w.u.name, w.body.proof ?? undefined);
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, 403);
    return c.json({ options: r.options, via: r.via });
  });

  app.post("/app/review/passkeys/register", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const label = typeof w.body.label === "string" ? w.body.label : "Passkey";
    const r = await desk.passkeys.verifyRegistration(w.u.userId, w.body.response, label);
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, 403);
    await desk.passkeyAdded(w.u.userId, r.passkey, "app", w.u.userId);
    return c.json({ ok: true, passkey: r.passkey });
  });

  app.post("/app/review/passkeys/:id/remove", async (c) => {
    const w = await userWrite(c);
    if (w instanceof Response) return w;
    const id = c.req.param("id");
    const proof = await desk.passkeys.verifyAssertion(w.u.userId, `remove:${id}`, w.body.proof);
    if (!proof.ok) return c.json({ error: proof.reason, code: proof.code }, 403);
    if (!desk.passkeys.remove(w.u.userId, id)) return c.json({ error: "Not found" }, 404);
    await desk.passkeyRemoved(w.u.userId, id, `fingerprint:${proof.evidence.credential_id}`, w.u.userId);
    return c.json({ ok: true });
  });

  // ── Michael / foreman / cron (service token) ──────────────────────────

  app.post("/api/review/items", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "JSON object body required" }, 400);
    const r = await desk.create(body, actorOf(body));
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json({ ok: true, item: r.item }, 201);
  });

  app.get("/api/review/items", (c) => {
    const denied = service(c);
    if (denied) return denied;
    const status = c.req.query("status");
    const owner = c.req.query("owner");
    const items = desk.store
      .all()
      .filter((i) => (!status || i.status === status) && (!owner || i.owner === owner))
      .map(({ brief: _brief, ...rest }) => rest); // list without bodies
    return c.json({ items });
  });

  app.get("/api/review/items/:id", (c) => {
    const denied = service(c);
    if (denied) return denied;
    const item = desk.store.get(c.req.param("id"));
    if (!item) return c.json({ error: "Not found" }, 404);
    // may_execute: the gate foreman checks before carrying out approved work.
    return c.json({ item, may_execute: desk.mayExecute(item.id) });
  });

  app.post("/api/review/items/:id/done", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = (await jsonBody(c)) ?? {};
    const r = desk.markDone(c.req.param("id"), body.note, actorOf(body));
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json({ ok: true, item: r.item });
  });

  app.post("/api/review/tick", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = (await jsonBody(c)) ?? {};
    const dry = body.dry === true;
    const at = dry && typeof body.at === "string" && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at) : undefined;
    return c.json(await desk.tick({ dry, at }));
  });

  app.post("/api/review/enroll", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = (await jsonBody(c)) ?? {};
    const owner = typeof body.user === "string" ? body.user.toLowerCase() : ownerUserId();
    const minutes = typeof body.minutes === "number" ? body.minutes : 15;
    const until = desk.openEnrollment(owner, minutes, actorOf(body));
    return c.json({ ok: true, user: owner, open_until: until.toISOString() });
  });

  app.post("/api/review/passkeys/:user/:id/remove", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = (await jsonBody(c)) ?? {};
    const owner = c.req.param("user").toLowerCase();
    const id = c.req.param("id");
    if (!desk.passkeys.remove(owner, id)) return c.json({ error: "Not found" }, 404);
    await desk.passkeyRemoved(owner, id, "service-token", actorOf(body));
    return c.json({ ok: true });
  });

  /**
   * System alerts from the gateway's neighbours (the Bina corpus scripts, via
   * review.mjs alert). `state: "resolved"` closes by class or by source,
   * silently. Never forwarded to Telegram.
   */
  app.post("/api/review/alerts", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "JSON object body required" }, 400);
    if (body.state === "resolved") return c.json({ ok: true, resolved: desk.resolveAlerts({ class: body.class, source: body.source }, actorOf(body)) });
    const r = desk.recordAlert(body, actorOf(body));
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, r.status);
    return c.json({ ok: true, alert: r.entry, started: r.started }, r.started ? 201 : 200);
  });

  app.get("/api/review/alerts", (c) => {
    const denied = service(c);
    if (denied) return denied;
    return c.json({ alerts: desk.alerts.view(new Date()) });
  });

  app.post("/api/review/alerts/:class/ack", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = (await jsonBody(c)) ?? {};
    const e = desk.ackAlert(c.req.param("class"), actorOf(body));
    if (!e) return c.json({ error: "No open alert of that class" }, 404);
    return c.json({ ok: true, alert: e });
  });

  app.get("/api/review/tracks", (c) => {
    const denied = service(c);
    if (denied) return denied;
    return c.json({ tracks: desk.board(), all: desk.tracks.all() });
  });

  app.post("/api/review/tracks", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "JSON object body required" }, 400);
    const r = desk.trackUpsert(body as Parameters<ReviewDesk["trackUpsert"]>[0], actorOf(body));
    if ("error" in r) return c.json({ error: r.error }, 400);
    return c.json({ ok: true, track: r });
  });

  app.post("/api/review/tracks/:id/close", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = (await jsonBody(c)) ?? {};
    const kind = body.kind === "cancelled" ? "cancelled" : body.kind === "closed" ? "closed" : null;
    if (!kind) return c.json({ error: "kind must be closed or cancelled" }, 400);
    // The service side can only ever RELAY the owner's word — it cannot be the owner.
    const relay = actorOf(body);
    const r = desk.trackClose(c.req.param("id"), kind, typeof body.owner_said === "string" ? body.owner_said : "", relay === "owner" ? "service" : relay);
    if ("error" in r) return c.json({ error: r.error }, 400);
    return c.json({ ok: true, track: r });
  });

  /** The foreman's finish (close-chain): close the card a build run belongs to — every row of it — relaying the owner's word. */
  app.post("/api/review/builds/:build/close", async (c) => {
    const denied = service(c);
    if (denied) return denied;
    const body = (await jsonBody(c)) ?? {};
    const kind = body.kind === "cancelled" ? "cancelled" : body.kind === "closed" || body.kind === undefined ? "closed" : null;
    if (!kind) return c.json({ error: "kind must be closed or cancelled" }, 400);
    const relay = actorOf(body);
    const owner = typeof body.owner === "string" && body.owner ? body.owner.trim().toLowerCase() : ownerUserId();
    const said = typeof body.owner_said === "string" ? body.owner_said.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const r = desk.buildCloseByRun(owner, c.req.param("build"), kind, said, relay === "owner" ? "service" : relay);
    if (!r.ok) return c.json({ error: r.reason }, r.status);
    return c.json(r);
  });
}
