import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { getClips, addClip, deleteClip } from "./clipboard.js";
import { listFiles, getFilePath, saveFile, deleteFile } from "./uploads.js";
import { broadcast, broadcastEvent } from "./websocket.js";
import { saveBotSetting } from "./bot-settings.js";
import { getMessagesForUser } from "./message-store.js";
import { invokeAgent } from "./claude-invoke.js";
import { listMissionControl, readMissionControlFile, writeMissionControlFile } from "./mission-control.js";
import {
  L1_CARDS,
  listL2,
  readL3,
  writeNotes,
  type L1Type,
} from "./mc-structured.js";
import { getEntries as getCostEntries, addPersonalEntry, updatePersonalEntry, deletePersonalEntry } from "./operating-costs.js";
import type { BotInstance } from "./telegram.js";
import { lookupByToken, userCanAccessAgent, toPublic, type UserConfig } from "./users.js";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { resolve, join, extname, basename } from "path";
import { multiUserPaths, ensureDir, safeSegment } from "./multi-user-paths.js";

/**
 * Resolve the authenticated user on a dashboard/PWA request. Accepts the
 * bearer token from (in order): X-AHI-Token header, ?token= query, or
 * ahi_token cookie. Returns null if none match a registered user.
 */
function resolveUser(c: Context): UserConfig | null {
  const header = c.req.header("X-AHI-Token");
  if (header) {
    const u = lookupByToken(header);
    if (u) return u;
  }
  const q = c.req.query("token");
  if (q) {
    const u = lookupByToken(q);
    if (u) return u;
  }
  const cookie = getCookie(c, "ahi_token");
  if (cookie) {
    const u = lookupByToken(cookie);
    if (u) return u;
  }
  return null;
}

const PUBLIC_DIR = resolve(import.meta.dirname, "../public");
const PUBLIC_APP_DIR = resolve(import.meta.dirname, "../public/app");

// Hosts that serve the PWA shell (ahi-app) instead of the dashboard.
// When the gateway sees one of these in the Host header, any non-API GET
// request is served from $AHI_HOME/gateway/public/app/ — static files when they
// exist, SPA fallback to index.html otherwise. This keeps the PWA
// same-origin with /app/send and /ui/ws (no CORS, no cookie gymnastics).
const PWA_HOSTS = new Set(["app.ahigate.com"]);

// H-040 D1 — Legacy URL prereq.
//
// `ahi.ahigate.com` is the legacy dashboard host. After the unified
// PWA at `app.ahigate.com` reaches parity (D1 + D2), we redirect
// `ahi.ahigate.com/*` → `app.ahigate.com/*` so legacy bookmarks
// land on the new app. Two safeguards:
//
//   1. `ahi.ahigate.com/legacy/*` ALWAYS bypasses the redirect and
//      serves the legacy dashboard (path-strip → existing /ui*
//      handlers). the operator can verify the legacy dashboard still works
//      via the bypass before flipping the redirect on.
//
//   2. Redirect itself is gated by `AHI_REDIRECT_LEGACY=true`. Default
//      OFF (`false` / unset). the operator flips it ON manually after they
//      verifies the bypass + the new PWA. Reversible: flip back off,
//      restart, legacy dashboard is the default again.
//
// This is a path-bypass design (one host, one tunnel — no DNS or
// cloudflared changes). The alternative (legacy.ahigate.com) would
// be cleaner separation but require a new cloudflared route the operator
// runs separately. Path-bypass is simpler + reversible-by-code,
// so D1 ships path-bypass and surfaces the tradeoff for review.
const LEGACY_HOST = "ahi.ahigate.com";
const LEGACY_BYPASS_PREFIX = "/legacy";

function isLegacyHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === LEGACY_HOST;
}

function legacyRedirectEnabled(): boolean {
  return process.env.AHI_REDIRECT_LEGACY === "true";
}

// API path prefixes that stay API even on PWA hosts. Anything that DOES
// NOT start with one of these is treated as a PWA client route on
// app.ahigate.com and falls through to the static/SPA handler.
const API_PATH_PREFIXES = [
  "/app/",       // /app/send etc.
  "/ui/",        // dashboard API + WS
  "/ui",         // exact /ui — dashboard login page (not served on PWA hosts)
  "/invoke/",    // reserved for future invoke-only bots
  "/transcribe/",// reserved for future transcription endpoints
  "/voice-upload",
  "/webhook",    // Telegram webhook (webhook mode)
  "/health",     // health check
];

function isApiPath(pathname: string): boolean {
  if (pathname === "/ui" || pathname === "/health" || pathname === "/voice-upload") return true;
  for (const p of API_PATH_PREFIXES) {
    if (p.endsWith("/") && pathname.startsWith(p)) return true;
  }
  return false;
}

function isPwaHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strip port if present.
  const host = hostHeader.split(":")[0].toLowerCase();
  return PWA_HOSTS.has(host);
}

// MIME map used by both dashboard and PWA static handlers.
const PWA_MIME: Record<string, string> = {
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".woff": "font-woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json",
};

const AVAILABLE_MODELS = ["opus", "sonnet", "haiku"];
const OPENAI_VOICES = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
// Google shared name pool — used by both Gemini 2.5 Flash TTS and Chirp 3 HD
const GOOGLE_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];
const VOICE_GROUPS = [
  { label: "OpenAI", provider: "openai" as const, voices: OPENAI_VOICES },
  { label: "Google (Gemini)", provider: "gemini" as const, voices: GOOGLE_VOICES },
];
const ALL_VOICE_NAMES = new Set([...OPENAI_VOICES, ...GOOGLE_VOICES]);

import type { GatewayConfig } from "./config.js";

/**
 * Variables attached to a dashboard request context. The auth middleware
 * populates `user` on every /ui/* route after a successful token lookup;
 * downstream handlers read it via `c.get("user")`. Typing it here keeps
 * c.set/c.get from falling back to Hono's default `never` key shape.
 */
type DashEnv = { Variables: { user: UserConfig } };

export function createDashboard(instances: BotInstance[], gatewayConfig: GatewayConfig): Hono<DashEnv> {
  const dash = new Hono<DashEnv>();

  // --- Legacy host handler (ahi.ahigate.com) ──────────────────────────────
  //
  // Three behaviors per H-040 D1:
  //
  //   1. ahi.ahigate.com/legacy/PATH  →  path is stripped of the /legacy
  //      prefix and rewritten to /ui... so the legacy dashboard is
  //      reachable WITHOUT triggering the redirect, even when the flag
  //      is on. This is the "verify before flipping" affordance.
  //
  //   2. ahi.ahigate.com/(anything-else) WITH AHI_REDIRECT_LEGACY=true →
  //      302 to https://app.ahigate.com${path}. The query string is
  //      preserved.
  //
  //   3. Otherwise (flag off, default) → fall through to existing /ui*
  //      handlers. Legacy dashboard remains the default for legacy host.
  dash.use("*", async (c, next) => {
    if (!isLegacyHost(c.req.header("host"))) return next();

    const path = c.req.path;

    // Path 1: /legacy/* bypass — strip /legacy prefix and rewrite to /ui.
    // We mutate the URL the next handlers see; this is the minimum-touch
    // way to re-enter the existing /ui* router with the bypass path.
    if (path === LEGACY_BYPASS_PREFIX || path.startsWith(LEGACY_BYPASS_PREFIX + "/")) {
      const stripped = path.slice(LEGACY_BYPASS_PREFIX.length) || "/";
      // /legacy             → /ui
      // /legacy/            → /ui
      // /legacy/foo.css     → /ui/foo.css
      const newPath = stripped === "/" ? "/ui" : `/ui${stripped}`;
      const url = new URL(c.req.url);
      url.pathname = newPath;
      // Hono Context doesn't expose a public URL rewriter; pass the new
      // URL through a fresh Request and route it back through the same
      // app dispatch by re-invoking next() after replacing c.req.raw —
      // simpler path: 308 internal redirect. Browser follows once and
      // stays on ahi.ahigate.com (host preserved). The 308 makes the
      // path-rewrite visible in dev tools, which is fine for the
      // bypass affordance (operator manually visits /legacy/...).
      return c.redirect(url.toString(), 308);
    }

    // Path 2: redirect when flag is on.
    if (legacyRedirectEnabled()) {
      const url = new URL(c.req.url);
      url.host = "app.ahigate.com";
      url.protocol = "https:";
      // url.port intentionally cleared — public host has no explicit port.
      url.port = "";
      return c.redirect(url.toString(), 302);
    }

    // Path 3: flag off — preserve legacy dashboard at the legacy host.
    // Fall through to the rest of the middleware chain (PWA host
    // handler will skip because legacy host isn't in PWA_HOSTS, and
    // the /ui* handlers will serve normally).
    return next();
  });

  // --- PWA host handler (app.ahigate.com) ─────────────────────────────────
  //
  // On PWA hosts, serve the ahi-app SPA from public/app/. API routes
  // (/app/send, /ui/*, /invoke/*, /transcribe/*, /voice-upload, /health)
  // pass through to the handlers below — same origin, zero CORS.
  //
  // Non-API GETs first try an on-disk file under public/app/; if none is
  // found (e.g. /chat/michael, /voice/avi, /settings, a bookmarked deep
  // link) we fall back to public/app/index.html so the SPA router can
  // take over. Anything else (POST/PUT on unknown paths) returns 404.
  dash.use("*", async (c, next) => {
    if (!isPwaHost(c.req.header("host"))) return next();
    if (isApiPath(c.req.path)) return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();

    // Strip leading slash, normalize default root.
    const relRaw = c.req.path === "/" ? "/index.html" : c.req.path;
    const filePath = join(PUBLIC_APP_DIR, relRaw);
    const indexPath = join(PUBLIC_APP_DIR, "index.html");

    // Prevent path traversal — resolved path must remain inside PUBLIC_APP_DIR.
    const servePath = filePath.startsWith(PUBLIC_APP_DIR) && existsSync(filePath)
      ? filePath
      : indexPath;

    if (!existsSync(servePath)) {
      return c.text("PWA shell not deployed — run `npm run deploy` in ~/ahi-app/", 503);
    }

    const data = c.req.method === "HEAD" ? null : readFileSync(servePath);
    const ct = PWA_MIME[extname(servePath)] || "application/octet-stream";

    // Caching policy:
    //   - HTML shell: no-store (so fresh deploys take effect immediately).
    //   - sw.js + manifest: no-store (the SW must refresh on every load to
    //     pick up new CACHE_VERSION values).
    //   - Hashed assets under /assets/: long-lived (content-hashed by Vite).
    //   - Other static: short-lived (300s) as a safety default.
    let cacheControl = "public, max-age=300";
    if (ct.startsWith("text/html") || servePath.endsWith("sw.js") || servePath.endsWith(".webmanifest")) {
      cacheControl = "no-cache, no-store, must-revalidate";
    } else if (c.req.path.startsWith("/assets/")) {
      cacheControl = "public, max-age=31536000, immutable";
    }

    return new Response(data, {
      headers: {
        "Content-Type": ct,
        "Cache-Control": cacheControl,
      },
    });
  });

  // --- Auth middleware (only for /ui routes) ---
  //
  // Replaced the single-token DASHBOARD_TOKEN check with a users.json
  // registry lookup. Any registered token is valid; the resolved user is
  // attached to the request context (c.set("user", ...)) so downstream
  // handlers can scope by identity.
  dash.use("/ui/*", async (c: Context, next: Next) => {
    const path = c.req.path;
    if (path === "/ui/login" || path === "/ui/logout" || path === "/ui/health" || path.match(/\/ui\/.+\.(css|js|png|svg|ico|json|woff2?)$/)) {
      return next();
    }
    const user = resolveUser(c);
    if (!user) {
      if (path === "/ui" || path === "/ui/") {
        const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf-8");
        c.header("Cache-Control", "no-cache, no-store, must-revalidate");
        c.header("CDN-Cache-Control", "no-store");
        return c.html(html);
      }
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("user", user);
    return next();
  });

  // --- Login ---
  dash.post("/ui/login", async (c) => {
    const body = await c.req.json<{ token: string }>();
    const user = lookupByToken(body.token);
    if (user) {
      setCookie(c, "ahi_token", body.token, {
        path: "/",
        httpOnly: true,
        secure: true,
        maxAge: 60 * 60 * 24 * 30,
        sameSite: "None",
      });
      return c.json({ ok: true, user: toPublic(user) });
    }
    return c.json({ error: "Invalid token" }, 401);
  });

  // --- Session bootstrap ---
  //
  // Returns the authenticated user's public profile (name + allowed
  // agents) so the dashboard / PWA can filter the UI to only the
  // agents they're entitled to see. No token is echoed back.
  dash.get("/ui/session", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ user: toPublic(user) });
  });

  // --- Logout ---
  dash.post("/ui/logout", (c) => {
    setCookie(c, "ahi_token", "", {
      path: "/",
      httpOnly: true,
      secure: true,
      maxAge: 0,
      sameSite: "None",
    });
    return c.json({ ok: true });
  });

  // --- Bot health/status ---
  //
  // Scoped to the requesting user's allowed agents so each user sees
  // only the bots they're entitled to. /ui/health skips auth (it runs
  // before the auth middleware falls through) so we re-resolve the user
  // here and gate visibility accordingly; an unauthenticated caller
  // gets an empty bots list rather than a 401 to avoid breaking the
  // unauth login page's status indicators.
  dash.get("/ui/health", (c) => {
    const user = resolveUser(c);
    const allowed = user ? new Set(user.agents) : new Set<string>();
    return c.json({
      bots: instances
        .filter((i) => allowed.has(i.config.name))
        .map((i) => ({
          name: i.config.name,
          model: i.config.model,
          voice: i.config.voice,
          status: "online",
          lastMessage: i.lastMessageTime || null,
        })),
      uptime: process.uptime(),
      user: user ? toPublic(user) : null,
    });
  });

  // --- Settings ---
  //
  // Admin-only. Non-admin users shouldn't be reshaping bot models/voices;
  // we hide the tab in the UI and return 403 here as belt-and-suspenders.
  dash.get("/ui/settings", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);

    const allowed = new Set(user.agents);
    const bots: Array<{ name: string; model: string; voice: string; ttsProvider: string }> = [];
    for (const i of instances) {
      if (!allowed.has(i.config.name)) continue;
      const cfg = i.config;
      const effectiveVoice =
        cfg.ttsProvider === "gemini" ? cfg.geminiVoice :
        cfg.ttsProvider === "google" || cfg.ttsProvider === "chirp" ? cfg.googleVoice :
        cfg.voice;
      bots.push({
        name: cfg.name,
        model: cfg.model,
        voice: effectiveVoice,
        ttsProvider: cfg.ttsProvider,
      });
    }
    return c.json({
      bots,
      availableModels: AVAILABLE_MODELS,
      voiceGroups: VOICE_GROUPS,
    });
  });

  dash.post("/ui/settings", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);

    const { bot, model, voice } = await c.req.json<{ bot: string; model?: string; voice?: string }>();

    if (!userCanAccessAgent(user, bot)) {
      return c.json({ error: `No access to ${bot}` }, 403);
    }

    const instance = instances.find((i) => i.config.name === bot);
    if (!instance) return c.json({ error: `Unknown bot: ${bot}` }, 404);

    if (model) {
      if (!AVAILABLE_MODELS.includes(model)) return c.json({ error: `Invalid model: ${model}` }, 400);
      instance.config.model = model;
      saveBotSetting(bot, "model", model);
    }
    if (voice) {
      if (!ALL_VOICE_NAMES.has(voice)) return c.json({ error: `Invalid voice: ${voice}` }, 400);
      const isOpenAI = OPENAI_VOICES.includes(voice);
      const provider = isOpenAI ? "openai" : "gemini";
      instance.config.ttsProvider = provider;
      saveBotSetting(bot, "ttsProvider", provider);
      if (isOpenAI) {
        instance.config.voice = voice;
        saveBotSetting(bot, "voice", voice);
      } else {
        instance.config.geminiVoice = voice;
        saveBotSetting(bot, "geminiVoice", voice);
      }
    }

    console.log(`[settings] ${bot} updated — model: ${instance.config.model}, provider: ${instance.config.ttsProvider}, voice: ${instance.config.ttsProvider === "gemini" ? instance.config.geminiVoice : instance.config.voice}`);
    return c.json({
      ok: true,
      name: bot,
      model: instance.config.model,
      ttsProvider: instance.config.ttsProvider,
      voice: instance.config.ttsProvider === "gemini" ? instance.config.geminiVoice : instance.config.voice,
    });
  });

  // --- Mission Control ---
  //
  // Admin gets $AHI_HOME/mission-control/ directly. Non-admin gets
  // $AHI_HOME/mission-control/<userId>/, seeded on first access with their
  // template file set. File whitelist is also template-derived so a
  // non-admin user can't read admin files by guessing a filename.
  dash.get("/ui/mc", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ files: listMissionControl(user.userId, user.admin) });
  });

  dash.get("/ui/mc/:file", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const file = c.req.param("file");
    const entry = readMissionControlFile(user.userId, user.admin, file);
    if (!entry) return c.json({ error: `Unknown file: ${file}` }, 404);
    return c.json(entry);
  });

  dash.put("/ui/mc/:file", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const file = c.req.param("file");
    const { content } = await c.req.json<{ content: string }>();
    if (typeof content !== "string") return c.json({ error: "content must be a string" }, 400);
    const entry = writeMissionControlFile(user.userId, user.admin, file, content);
    if (!entry) return c.json({ error: `Unknown file: ${file}` }, 404);
    console.log(`[mc] ${user.userId}/${file} saved via dashboard (${content.length} bytes)`);
    return c.json(entry);
  });

  // --- Mission Control structured (L2/L3 read + operator notes write-back) ---
  //
  // H-040 Round 2 Task C1 (Path B sliced). Lives ALONGSIDE the legacy
  // /ui/mc whole-file API above — this is the structured surface the new
  // PWA mission-control screens consume. Admin-only for tonight; non-admin
  // users continue to use the per-user whole-file API. C2 will add
  // mark-complete / reassign / change-priority mutations behind golden-file
  // tests.
  //
  // Endpoints:
  //   GET  /app/mc/cards?level=1                 → L1 card list
  //   GET  /app/mc/cards?level=2&type=<l1>       → L2 sub-card list per L1 type
  //   GET  /app/mc/card?l1=<l1>&id=<taskId>      → L3 detail (incl. notes)
  //   POST /app/mc/notes  body { l1, id, notes } → atomic backup-then-write of
  //                                                 the <!-- operator-notes -->
  //                                                 fence inside the entry.

  const VALID_L1: L1Type[] = ["handoff", "today", "activity", "todo", "agents", "architecture"];
  function isValidL1(s: unknown): s is L1Type {
    return typeof s === "string" && (VALID_L1 as string[]).includes(s);
  }

  dash.get("/app/mc/cards", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    const level = c.req.query("level") || "1";
    if (level === "1") {
      return c.json({ cards: L1_CARDS });
    }
    if (level === "2") {
      const type = c.req.query("type");
      if (!isValidL1(type)) return c.json({ error: `Unknown type: ${type}` }, 400);
      try {
        return c.json({ cards: listL2(type), type });
      } catch (err) {
        console.error(`[mc-structured] /app/mc/cards level=2 type=${type} parse error:`, err);
        return c.json({ error: "Parse failed", detail: (err as Error).message }, 500);
      }
    }
    return c.json({ error: `Unknown level: ${level}` }, 400);
  });

  dash.get("/app/mc/card", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    const l1 = c.req.query("l1");
    const id = c.req.query("id");
    if (!isValidL1(l1)) return c.json({ error: `Unknown l1: ${l1}` }, 400);
    if (!id) return c.json({ error: "Missing id" }, 400);
    try {
      const detail = readL3(l1, id);
      if (!detail) return c.json({ error: `Entry not found: ${id}` }, 404);
      return c.json(detail);
    } catch (err) {
      console.error(`[mc-structured] /app/mc/card l1=${l1} id=${id} error:`, err);
      return c.json({ error: "Read failed", detail: (err as Error).message }, 500);
    }
  });

  dash.post("/app/mc/notes", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    let body: { l1?: unknown; id?: unknown; notes?: unknown };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    if (!isValidL1(body.l1)) return c.json({ error: `Unknown l1: ${body.l1}` }, 400);
    if (typeof body.id !== "string" || !body.id.trim()) return c.json({ error: "id must be a non-empty string" }, 400);
    if (typeof body.notes !== "string") return c.json({ error: "notes must be a string" }, 400);
    const result = writeNotes(body.l1, body.id.trim(), body.notes);
    if (!result.ok) {
      const code = result.error.startsWith("Entry not found") ? 404 : 500;
      console.error(`[mc-structured] /app/mc/notes l1=${body.l1} id=${body.id} write failed:`, result.error);
      return c.json({ error: result.error }, code);
    }
    console.log(
      `[mc-structured] notes saved l1=${body.l1} id=${body.id} (${body.notes.length} chars; backup=${result.backupPath || "none"})`,
    );
    // Re-read so the client gets the canonical post-write detail back.
    let updated = null;
    try {
      updated = readL3(body.l1, body.id.trim());
    } catch {/* swallow — write already succeeded */}
    return c.json({ ok: true, backupPath: result.backupPath, detail: updated });
  });

  // --- PWA Clipboard (per-user, source: app) ---
  //
  // H-040 Round 2 D2 (2026-04-27). Mirrors the legacy `/ui/clips*`
  // surface but uses `resolveUser(c)` directly per the auth-fix
  // lesson — every NEW endpoint under `/app/*` MUST resolve the user
  // explicitly (the `/ui/*` middleware that populates `c.get("user")`
  // doesn't fire for `/app/*` routes).
  //
  // Same persistence backend as `/ui/clips*` (clipboard.ts), so a clip
  // added via the legacy dashboard appears in the PWA right-rail
  // panel and vice versa.
  dash.get("/app/clipboard", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json(getClips(user.userId));
  });

  dash.post("/app/clipboard", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    let body: { text?: unknown } = {};
    try {
      body = await c.req.json<{ text?: unknown }>();
    } catch {
      /* body left as {} — falls through to "Empty clip" below */
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "Empty clip" }, 400);
    return c.json(addClip(user.userId, text));
  });

  dash.delete("/app/clipboard/:id", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    return c.json({ ok: deleteClip(user.userId, id) });
  });

  // --- PWA Status (per-user, source: app) ---
  //
  // Read-only summary surface for the right-rail Status card. Pulls:
  //   - bot health (online dots + last-seen) scoped to the user's
  //     allowed agents — same shape as `/ui/health` but namespaced
  //     under /app for the auth-fix-lesson reasons above.
  //   - operating-costs monthly totals — admin-only payload subset
  //     (non-admin users get an empty `costs` field).
  //   - gateway uptime + version.
  //
  // No mutations. The CRUD modal for costs is flagged for Brief 4 +
  // C2 follow-ups; this is the at-a-glance card per Avi §7.
  dash.get("/app/status", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const allowed = new Set(user.agents);
    const bots = instances
      .filter((i) => allowed.has(i.config.name))
      .map((i) => ({
        name: i.config.name,
        model: i.config.model,
        status: "online",
        lastMessage: i.lastMessageTime || null,
      }));

    let costs: { monthlyTotal: number; topCategories: Array<{ category: string; total: number }> } | null = null;
    if (user.admin) {
      try {
        const entries = getCostEntries().filter((e) => e.active);
        let monthlyTotal = 0;
        const byCategory = new Map<string, number>();
        for (const e of entries) {
          const m = e.monthly_cost_fixed ?? e.monthly_cost_estimate ?? 0;
          if (typeof m === "number" && Number.isFinite(m)) {
            monthlyTotal += m;
            const prev = byCategory.get(e.category) || 0;
            byCategory.set(e.category, prev + m);
          }
        }
        const topCategories = Array.from(byCategory.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([category, total]) => ({ category, total }));
        costs = { monthlyTotal, topCategories };
      } catch (err) {
        console.error("[dashboard] /app/status costs aggregate error:", err);
        costs = { monthlyTotal: 0, topCategories: [] };
      }
    }

    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({
      bots,
      uptime: process.uptime(),
      costs,
    });
  });

  // --- Operating Costs (admin-only) ---
  //
  // Operating costs is operator-personal data — subscriptions and recurring fees,
  // personal finance buckets. Hidden from the UI for non-admin; 403 here
  // is belt-and-suspenders.
  dash.get("/ui/costs", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    return c.json({ entries: getCostEntries() });
  });

  dash.post("/ui/costs", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    const body = await c.req.json();
    const result = addPersonalEntry(body);
    if (!result.ok) return c.json({ error: result.error }, 400);
    console.log(`[costs] added entry (${result.entry.bucket}): ${result.entry.id}`);
    return c.json(result.entry);
  });

  dash.put("/ui/costs/:id", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    const id = c.req.param("id");
    const body = await c.req.json();
    const result = updatePersonalEntry(id, body);
    if (!result.ok) {
      const code = result.error.startsWith("Entry not found") ? 404 : 400;
      return c.json({ error: result.error }, code);
    }
    console.log(`[costs] updated entry (${result.entry.bucket}): ${id}`);
    return c.json(result.entry);
  });

  dash.delete("/ui/costs/:id", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    const id = c.req.param("id");
    const result = deletePersonalEntry(id);
    if (!result.ok) {
      const code = result.error.startsWith("Entry not found") ? 404 : 400;
      return c.json({ error: result.error }, code);
    }
    console.log(`[costs] deleted entry: ${id}`);
    return c.json({ ok: true });
  });

  // --- Messages (per-bot, per-user history) ---
  //
  // Every request is scoped to the authenticated user's own threads.
  // Per-user scoping prevents one user from seeing another user's bot
  // conversations, including any restricted bots assigned to that user.
  // Agents the user isn't entitled to see return an empty list.
  dash.get("/ui/messages", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const bot = c.req.query("bot");
    const limit = parseInt(c.req.query("limit") || "100", 10);

    if (bot && bot !== "all") {
      if (!userCanAccessAgent(user, bot)) return c.json([]);
      return c.json(getMessagesForUser(bot, user.userId, limit));
    }
    // "all" view — merge across this user's allowed agents.
    const all = [] as ReturnType<typeof getMessagesForUser>;
    for (const b of user.agents) {
      all.push(...getMessagesForUser(b, user.userId, limit));
    }
    all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return c.json(all.slice(-limit));
  });

  // --- Clipboard (per-user) ---
  //
  // Each authenticated user reads/writes their own business-scoped clipboard.
  // Legacy state/clipboard files remain read fallbacks until the operator runs the
  // quiet-window migration.
  dash.get("/ui/clips", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json(getClips(user.userId));
  });

  dash.post("/ui/clips", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const { text } = await c.req.json<{ text: string }>();
    if (!text || !text.trim()) return c.json({ error: "Empty clip" }, 400);
    return c.json(addClip(user.userId, text.trim()));
  });

  dash.delete("/ui/clips/:id", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    return c.json({ ok: deleteClip(user.userId, id) });
  });

  // --- File uploads (per-user) ---
  //
  // Each authenticated user's files live under business/<user>/files/general/.
  // Legacy state/uploads files remain read fallbacks until the operator runs the
  // quiet-window migration.
  // List/download/delete all scope to the caller's userId so a user can
  // never see or touch another user's files.
  dash.get("/ui/files", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json(listFiles(user.userId));
  });

  dash.post("/ui/upload", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file provided" }, 400);
    }
    try {
      const name = await saveFile(user.userId, file.name, await file.arrayBuffer());
      return c.json({ ok: true, name });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  dash.get("/ui/files/:name", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const name = c.req.param("name");
    const path = getFilePath(user.userId, name);
    if (!path) return c.json({ error: "Not found" }, 404);
    const data = readFileSync(path);
    return new Response(data, {
      headers: { "Content-Disposition": `attachment; filename="${name}"` },
    });
  });

  dash.delete("/ui/files/:name", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const name = c.req.param("name");
    return c.json({ ok: deleteFile(user.userId, name) });
  });

  // --- Quick Send (invoke Claude, broadcast to feed) ---
  //
  // IMPORTANT: every message event emitted from this endpoint carries
  // `source: "ui-send"`. Dashboard Quick Send forges the last-known chatId
  // onto outgoing messages so the feed stays coherent — but those records
  // are test injections, NOT real user turns. The retrieval corpus-load
  // logic filters them out so they never pollute scoring.
  //
  // See H-019 Step 7 post-mortem (2026-04-19) for the incident that made
  // this explicit.
  dash.post("/ui/send", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const { bot: botName, text } = await c.req.json<{ bot: string; text: string }>();
    if (!userCanAccessAgent(user, botName)) {
      return c.json({ error: `No access to ${botName}` }, 403);
    }
    const instance = instances.find((i) => i.config.name === botName);
    if (!instance) return c.json({ error: `Unknown bot: ${botName}` }, 404);

    // Prefer the user's own Telegram chatId for outbound mirroring so a
    // Each user's Quick Send lands in their own Telegram, not the primary user's.
    const chatId = user.telegramChatId ?? instance.lastChatId ?? 0;
    const now = new Date().toISOString();

    // Broadcast the user's message to the feed, attributed to the
    // authenticated user.
    broadcast({ type: "message", bot: botName, direction: "in", contentType: "text", text, timestamp: now, chatId, userId: user.userId, senderName: user.name, source: "ui-send" });

    // Invoke Claude in the background — don't block the response
    invokeAgent({
      chatId,
      botName,
      message: text,
      sessionMap: instance.sessionMap,
      config: gatewayConfig,
      model: instance.config.model,
      onStreamEvent: (e) => broadcastEvent(e),
    }).then((result) => {
      broadcast({ type: "message", bot: botName, direction: "out", contentType: "text", text: result.response, timestamp: new Date().toISOString(), chatId, userId: user.userId, senderName: user.name, source: "ui-send" });
      // Also send to Telegram only if this user has a real chatId.
      if (user.telegramChatId) {
        instance.bot.api.sendMessage(user.telegramChatId, result.response).catch(() => {});
      }
    }).catch((err) => {
      console.error(`[dashboard] Quick send error for ${botName}:`, err);
      broadcast({ type: "message", bot: botName, direction: "out", contentType: "text", text: "Error processing message. Try again.", timestamp: new Date().toISOString(), chatId, userId: user.userId, senderName: user.name, source: "ui-send" });
    });

    return c.json({ ok: true });
  });

  // --- PWA Send (invoke Claude, broadcast to feed, source: "app") ---
  //
  // Mirrors /ui/send but tags messages with source: "app" so they are
  // INCLUDED in the retrieval corpus (unlike /ui/send which tags "ui-send"
  // and gets filtered out). Use this from the PWA (ahi-app on
  // app-dev.ahigate.com) for real user turns that should land in the
  // scoring pipeline.
  //
  // Auth: DASHBOARD_TOKEN via X-AHI-Token header OR ?token= query param.
  // (Cookie auth also accepted, but the PWA is cross-origin so cookie
  // won't usually be present.)
  dash.post("/app/send", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const { bot: botName, text } = await c.req.json<{ bot: string; text: string }>();
    if (!userCanAccessAgent(user, botName)) {
      return c.json({ error: `No access to ${botName}` }, 403);
    }
    const instance = instances.find((i) => i.config.name === botName);
    if (!instance) return c.json({ error: `Unknown bot: ${botName}` }, 404);

    const chatId = user.telegramChatId ?? instance.lastChatId ?? 0;
    const now = new Date().toISOString();

    // Broadcast the user's message to the feed with source: "app"
    broadcast({ type: "message", bot: botName, direction: "in", contentType: "text", text, timestamp: now, chatId, userId: user.userId, senderName: user.name, source: "app" });

    // Invoke Claude in the background — don't block the response
    invokeAgent({
      chatId,
      botName,
      message: text,
      sessionMap: instance.sessionMap,
      config: gatewayConfig,
      model: instance.config.model,
      onStreamEvent: (e) => broadcastEvent(e),
    }).then((result) => {
      broadcast({ type: "message", bot: botName, direction: "out", contentType: "text", text: result.response, timestamp: new Date().toISOString(), chatId, userId: user.userId, senderName: user.name, source: "app" });
    }).catch((err) => {
      console.error(`[dashboard] PWA /app/send error for ${botName}:`, err);
      broadcast({ type: "message", bot: botName, direction: "out", contentType: "text", text: "Error processing message. Try again.", timestamp: new Date().toISOString(), chatId, userId: user.userId, senderName: user.name, source: "app" });
    });

    return c.json({ ok: true });
  });

  // --- PWA Sessions endpoints (H-040 Batch 4 — Tzali, 2026-04-26) ---
  //
  // Read-only feed for the Sessions Sidebar in the PWA. The canonical
  // index lives at `$AHI_HOME/infra/sessions/index.json` (the AHI memory index,
  // 357+ entries). We surface a sanitized copy of each entry — the raw
  // index can carry filesystem paths that we don't want to leak across the
  // wire.
  //
  // Auth: standard X-AHI-Token / cookie / ?token=. No special user
  // scoping yet — every authenticated user sees the AHI memory index.
  // Per-user filtering can layer on top later (filter by user.userId
  // appearing in entry.telegram_user, etc).
  dash.get("/app/sessions/index", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const indexPath = resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "infra/sessions/index.json");
    if (!existsSync(indexPath)) {
      return c.json([], 200);
    }
    try {
      const raw = readFileSync(indexPath, "utf-8");
      const all = JSON.parse(raw) as Array<Record<string, unknown>>;
      // Strip filesystem paths from the wire response — the client only
      // needs them as opaque IDs which we re-resolve server-side via the
      // /transcript endpoint (keyed by session_id).
      // B4 carry-over (H-040 B5 wave, 2026-04-26): the wire response no
      // longer carries absolute filesystem paths. The client gets opaque
      // `session_id` plus boolean format flags only; the server resolves
      // real paths internally on the /transcript fetch. This shrinks the
      // attack surface (no path leaks, no client-supplied path trust) and
      // keeps the wire shape stable across multi-user / cross-host setups
      // where the PWA may not be co-located with the storage volume.
      const sanitized = all.map((e) => ({
        session_id: e.session_id ?? null,
        agent: e.agent ?? null,
        channel: e.channel ?? null,
        telegram_chat_id: e.telegram_chat_id ?? null,
        telegram_user: e.telegram_user ?? null,
        started_at: e.started_at ?? null,
        ended_at: e.ended_at ?? null,
        episode_name: e.episode_name ?? null,
        category: e.category ?? null,
        summary: e.summary ?? null,
        message_count: e.message_count ?? null,
        source_family: e.source_family ?? null,
        shaar: e.shaar ?? null,
        shoresh: e.shoresh ?? null,
        // Boolean availability flags so the client knows which content
        // form the read view will receive without us shipping the path.
        has_md: typeof e.transcript_path_md === "string" && (e.transcript_path_md as string).length > 0,
        has_jsonl: typeof e.transcript_path === "string" && (e.transcript_path as string).length > 0,
      }));
      c.header("Cache-Control", "no-cache, no-store, must-revalidate");
      return c.json(sanitized);
    } catch (err) {
      console.error("[dashboard] /app/sessions/index error:", err);
      return c.json({ error: "Failed to read sessions index" }, 500);
    }
  });

  // --- Single-session transcript fetch ---
  //
  // Returns the markdown-rendered transcript (preferred) and/or the
  // raw JSONL turns for a given session_id. The session must appear in
  // the index — we look it up by id, then read whichever transcript file
  // is registered for it. We never trust client-supplied paths, only
  // session_id.
  dash.get("/app/sessions/transcript", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.query("id");
    if (!id || typeof id !== "string") {
      return c.json({ error: "Missing id" }, 400);
    }

    const indexPath = resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "infra/sessions/index.json");
    if (!existsSync(indexPath)) {
      return c.json({ md: null, jsonl: null });
    }
    try {
      const raw = readFileSync(indexPath, "utf-8");
      const all = JSON.parse(raw) as Array<Record<string, unknown>>;
      const entry = all.find((e) => e.session_id === id);
      if (!entry) {
        return c.json({ error: "Unknown session id" }, 404);
      }

      let md: string | null = null;
      let jsonl: string | null = null;

      const mdPath = entry.transcript_path_md;
      if (typeof mdPath === "string" && existsSync(mdPath)) {
        try {
          md = readFileSync(mdPath, "utf-8");
        } catch (e) {
          console.warn(`[dashboard] failed to read md transcript ${mdPath}:`, e);
        }
      }

      const jsonlPath = entry.transcript_path;
      if (typeof jsonlPath === "string" && existsSync(jsonlPath)) {
        try {
          jsonl = readFileSync(jsonlPath, "utf-8");
        } catch (e) {
          console.warn(`[dashboard] failed to read jsonl transcript ${jsonlPath}:`, e);
        }
      }

      c.header("Cache-Control", "private, max-age=300");
      return c.json({ md, jsonl });
    } catch (err) {
      console.error("[dashboard] /app/sessions/transcript error:", err);
      return c.json({ error: "Failed to read transcript" }, 500);
    }
  });

  // --- PWA Files endpoints (H-040 Batch 5 — Tzali, 2026-04-26) ---
  //
  // Storage layout: ~/business/<userId>/files/<conversation_id>/<filename>
  // (resolved via multi-user-paths so we never hand-roll the path).
  // `conversation_id` is the agent key in the current PWA model — there's
  // one chat thread per agent. When B-future ships per-thread conversations
  // the client just passes a different id; the endpoints don't care.
  //
  // SCOPE NOTE: B5 is "pure file write only" — no OCR, no claude-turn
  // spawn. The upload endpoint persists the bytes and broadcasts a chat
  // event so the file appears in the conversation timeline. Downstream
  // skills processing is a separate later wave.

  /** Sanitize a user-supplied filename. Blocks path traversal, strips
   *  control chars, collapses whitespace, caps length. Returns null if
   *  the input cannot produce a safe segment (e.g. all chars stripped). */
  const sanitizeFilename = (raw: string | undefined | null): string | null => {
    if (!raw) return null;
    // Take only the basename — defangs `../../etc/passwd`, `C:\\foo\\bar`.
    const baseOnly = basename(String(raw));
    // Drop anything that isn't a safe printable char. Allow letters,
    // digits, dot, underscore, hyphen, space, parens — users attach
    // things like "Q2 Report (final).pdf" and we want that intact.
    const cleaned = baseOnly
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/[^A-Za-z0-9._\-() ]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^\.+/, "") // no dotfiles
      .trim();
    if (!cleaned) return null;
    // Cap at 200 chars total, preserving the extension.
    const MAX = 200;
    if (cleaned.length <= MAX) return cleaned;
    const ext = extname(cleaned);
    const stem = cleaned.slice(0, cleaned.length - ext.length);
    return stem.slice(0, MAX - ext.length) + ext;
  };

  /** Resolve a unique filename in `dir` by appending " (n)" before the
   *  extension if a collision exists. */
  const uniqueInDir = (dir: string, name: string): string => {
    if (!existsSync(join(dir, name))) return name;
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!existsSync(join(dir, candidate))) return candidate;
    }
    // Fallback: timestamp tail. Should be unreachable in practice.
    return `${stem}-${Date.now()}${ext}`;
  };

  /** Bytes ceiling for a single upload. Mirrors uploads.ts. */
  const FILES_MAX_BYTES = 50 * 1024 * 1024;

  // POST /app/files/upload  — multipart/form-data
  //   field "file": one or more File entries
  //   field "conversation_id": agent key (e.g. "michael")
  //   field "kind" (optional): "camera" | "gallery" | "file" — passed
  //     through to the broadcast event so the chat surface can render
  //     a sender-aware affordance later.
  dash.post("/app/files/upload", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }

    const conversationIdRaw = formData.get("conversation_id");
    const conversationId = typeof conversationIdRaw === "string"
      ? safeSegment(conversationIdRaw, "general")
      : "general";
    const kindRaw = formData.get("kind");
    const kind = typeof kindRaw === "string" ? kindRaw : null;

    const entries = formData.getAll("file");
    if (entries.length === 0) {
      return c.json({ error: "No file provided" }, 400);
    }

    // Multi-user resolver — never hand-roll the path. This is the
    // canonical hook into B3's storage layout.
    const paths = multiUserPaths(user.userId);
    const dir = paths.filesDir(conversationId);
    ensureDir(dir);

    const saved: Array<{ name: string; size: number }> = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const entry of entries) {
      if (!(entry instanceof File)) continue;
      const safeName = sanitizeFilename(entry.name);
      if (!safeName) {
        errors.push({ name: String(entry.name ?? "(blank)"), error: "Invalid filename" });
        continue;
      }
      if (entry.size > FILES_MAX_BYTES) {
        errors.push({ name: safeName, error: "File too large (max 50MB)" });
        continue;
      }
      const finalName = uniqueInDir(dir, safeName);
      const full = join(dir, finalName);
      try {
        const buf = Buffer.from(await entry.arrayBuffer());
        await writeFile(full, buf);
        saved.push({ name: finalName, size: entry.size });

        // Broadcast a chat-side metadata event so the file appears as
        // exchanged in the conversation timeline. Match the `message`
        // shape that the existing message-store path uses; clients
        // receiving on /ui/ws can render a file chip from this.
        // Use "document" contentType so the existing message bus
        // schema accepts the broadcast unchanged. The richer file
        // metadata (mime, conversationId, attachKind) is carried
        // alongside the canonical fields and ignored by consumers
        // that don't know about the B5 attach pipeline yet.
        broadcast({
          type: "message",
          bot: conversationId,
          direction: "in",
          contentType: "document",
          text: finalName,
          timestamp: new Date().toISOString(),
          chatId: user.telegramChatId ?? 0,
          userId: user.userId,
          senderName: user.name,
          source: "app",
        });

        // Also fire a B5 dedicated event so the FilesLens hook can
        // optimistically prepend without parsing the message stream.
        broadcastEvent({
          type: "files.new",
          conversation_id: conversationId,
          userId: user.userId,
          file: {
            name: finalName,
            size: entry.size,
            mime: entry.type || null,
            modified: new Date().toISOString(),
            sender: user.name.toLowerCase(),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ name: safeName, error: msg });
      }
    }

    if (saved.length === 0) {
      return c.json({ error: "No files saved", errors }, 400);
    }
    console.log(
      `[dashboard] /app/files/upload — user=${user.userId} conv=${conversationId} saved=${saved.length}`,
    );
    return c.json({ ok: true, conversation_id: conversationId, saved, errors });
  });

  // GET /app/files/list?conversation_id=...
  // Returns typed metadata for every file in the conversation's storage
  // dir, sorted descending by mtime. Pre-existing files (e.g. files
  // landed via the legacy /ui/upload path under "general") still show
  // up because we read the disk directly via the resolver.
  dash.get("/app/files/list", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const conversationId = safeSegment(c.req.query("conversation_id") ?? "general", "general");
    const paths = multiUserPaths(user.userId);
    const dir = paths.filesDir(conversationId);
    if (!existsSync(dir)) return c.json({ conversation_id: conversationId, files: [] });

    const entries: Array<{
      name: string;
      size: number;
      modified: string;
      mime: string | null;
      ext: string;
    }> = [];
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith(".")) continue;
        const full = join(dir, f);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        entries.push({
          name: f,
          size: st.size,
          modified: st.mtime.toISOString(),
          mime: null, // mime sniffing happens client-side from the extension
          ext: extname(f).slice(1).toLowerCase(),
        });
      }
    } catch (err) {
      console.error("[dashboard] /app/files/list readdir error:", err);
      return c.json({ error: "Failed to read files dir" }, 500);
    }

    entries.sort((a, b) => b.modified.localeCompare(a.modified));
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({ conversation_id: conversationId, files: entries });
  });

  // GET /app/files/get?conversation_id=...&name=...
  // Streams a single file's bytes. Used by previews (image lightbox,
  // PDF first-page render, audio player, generic open-in-app). Caller
  // must pass BOTH conversation_id and name; we never resolve a bare
  // name across conversations because that would let a malicious
  // client probe arbitrary directories.
  dash.get("/app/files/get", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const conversationId = safeSegment(c.req.query("conversation_id") ?? "", "general");
    const rawName = c.req.query("name");
    const safeName = sanitizeFilename(rawName);
    if (!safeName) return c.json({ error: "Missing or invalid name" }, 400);

    const paths = multiUserPaths(user.userId);
    const dir = paths.filesDir(conversationId);
    const full = join(dir, safeName);

    // Belt-and-suspenders containment check. `safeName` is already
    // basename-only, but verify the resolved full path stays under the
    // expected dir.
    if (!full.startsWith(dir)) return c.json({ error: "Path traversal blocked" }, 400);
    if (!existsSync(full)) return c.json({ error: "Not found" }, 404);

    let st;
    try {
      st = statSync(full);
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
    if (!st.isFile()) return c.json({ error: "Not a file" }, 400);

    const data = readFileSync(full);
    const ct = PWA_MIME[extname(safeName).toLowerCase()] || "application/octet-stream";
    const inlineDisposition = c.req.query("dl") === "1"
      ? `attachment; filename="${safeName}"`
      : `inline; filename="${safeName}"`;
    return new Response(data, {
      headers: {
        "Content-Type": ct,
        "Content-Disposition": inlineDisposition,
        "Cache-Control": "private, max-age=600",
      },
    });
  });

  // --- Serve static files ---
  dash.get("/ui", (c) => {
    const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf-8");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("CDN-Cache-Control", "no-store");
    return c.html(html);
  });

  const MIME: Record<string, string> = {
    ".css": "text/css",
    ".js": "application/javascript",
    ".html": "text/html",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  dash.get("/ui/*", (c) => {
    const rel = c.req.path.replace("/ui", "");
    const filePath = join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
      return c.notFound();
    }
    const data = readFileSync(filePath);
    const ct = MIME[extname(filePath)] || "application/octet-stream";
    return new Response(data, {
      headers: {
        "Content-Type": ct,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "CDN-Cache-Control": "no-store",
      },
    });
  });

  return dash;
}
