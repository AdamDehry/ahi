import { AI_ROOT } from "./ai-root.js";
import { ownerUserId } from "./users.js";
// ── Glasses endpoint — "Michael on the lens" (Even Realities G2) ────────────
//
// POST /api/glasses/ask
//   Auth:   Authorization: Bearer <GLASSES_TOKEN>   (server env; endpoint is
//           disabled with 503 until the env var is set)
//   Body:   { audioPcmBase64 }  — PCM s16le, 16 kHz, mono (glasses mic), OR
//           { text }            — typed question (companion-screen test box)
//   Reply:  { ok, transcript, reply, costUsd?, durationMs? }
//
// Pipeline: STT (transcribeShort — Google speech:recognize REST, LINEAR16
// 16 kHz, the exact format the G2 mic emits) → invokeAgent(michael, the owner's
// session) with a HUD system hint capping the reply at 1–2 sentences →
// persist BEFORE delivery (lost-outbound lesson) → JSON back to the lens.
//
// Persistence is two-layered, both BEFORE the HTTP response goes out:
//   1. broadcast() → message-store: the turn lands in the owner's Michael thread
//      (PWA feed mirrors it live, retrieval corpus includes it).
//   2. logs/glasses-YYYY-MM-DD.jsonl: an ops trail with stage markers, so a
//      crash between invoke and delivery still leaves the full turn on disk.
//
// This surface is hard-bound to the owner: the bearer token IS the identity.
// No other user resolution happens here by design.
//
// CORS: the app runs in the Even companion app's WebView and calls us with
// fetch(), so the browser sends Origin + preflight. GLASSES_ALLOWED_ORIGINS
// (comma-separated, exact origins) scopes Access-Control-Allow-Origin — the
// matched origin is reflected, never `*`, and no credentials are used
// (bearer header only). Browser requests from unlisted origins are refused
// outright. Requests without an Origin header (curl, native) skip CORS and
// hit the bearer gate directly.
//   Dev/simulator origin:  http://localhost:5173
//   Packed-app origin:     confirm on hardware day one — Flutter WebViews
//   may send `Origin: null` for packaged pages; if so, add the literal
//   string `null` to GLASSES_ALLOWED_ORIGINS after verifying on-device.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Hono, Context } from "hono";
import type { BotInstance } from "./telegram.js";
import type { GatewayConfig } from "./config.js";
import { transcribeShort } from "./stt.js";
import { invokeAgent } from "./claude-invoke.js";
import { withBotSlot, ConcurrencyCapError } from "./concurrency.js";
import { broadcast } from "./websocket.js";
import { lookupByUserId } from "./users.js";

const GLASSES_USER_ID = ownerUserId();
const GLASSES_BOT = "michael";

// PCM s16le @ 16 kHz mono. Google's sync speech:recognize caps at ~60 s.
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const MIN_PCM_BYTES = 3_200; // ~100 ms — anything less is a misfire
const MAX_PCM_BYTES = PCM_BYTES_PER_SECOND * 60;
const MAX_TEXT_CHARS = 2_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // base64 of 60 s ≈ 2.56 MB + JSON overhead

const HUD_HINT = [
  "[Surface context — Even G2 glasses HUD]",
  "This turn arrives from the owner's smart glasses. Your reply renders as plain",
  "monochrome text on a tiny lens display (~9 short lines visible at once).",
  "Answer in 1–2 short sentences. No markdown, no lists, no code blocks, no",
  "preamble. English only — the lens firmware font has no Hebrew glyphs and",
  "silently drops them. If the matter genuinely needs depth, give the",
  "one-line answer and add that you'll expand on Telegram.",
].join(" ");

const LOG_DIR = resolve(AI_ROOT, "builds/gateway/logs");

interface GlassesTurnRecord {
  ts: string;
  turn_id: string;
  stage: "asked" | "replied" | "error";
  source: "audio" | "text";
  transcript?: string;
  reply?: string;
  audio_bytes?: number;
  stt_ms?: number;
  invoke_ms?: number;
  cost_usd?: number;
  error?: string;
}

function logGlassesTurn(record: GlassesTurnRecord): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const path = resolve(LOG_DIR, `glasses-${record.ts.slice(0, 10)}.jsonl`);
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    // Never let the ops trail take the turn down — but say so loudly.
    console.error("[glasses] failed to write turn log:", (err as Error).message);
  }
}

function allowedOrigins(): Set<string> {
  return new Set(
    (process.env.GLASSES_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Reflect the request origin when allowed. Returns false for a browser
 *  request from an unlisted origin (caller should refuse). */
function applyCors(c: Context): boolean {
  const origin = c.req.header("Origin");
  if (!origin) return true; // curl / native — no CORS involved
  const allowed = allowedOrigins();
  // `*` in the list = reflect-any. Safe here: this surface is bearer-only,
  // The owner-only, sends no cookies/credentials — the token IS the identity, so
  // CORS is defense-in-depth, not the gate. Reflect-any also covers the
  // sideloaded WebView's `Origin: null` and dev servers on shifting LAN IPs.
  if (!allowed.has(origin) && !allowed.has("*")) return false;
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  return true;
}

function tokenMatches(header: string | undefined): boolean {
  const expected = process.env.GLASSES_TOKEN;
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.equals(b);
}

export function registerGlassesRoutes(
  app: Hono,
  instances: BotInstance[],
  config: GatewayConfig,
): void {
  app.options("/api/glasses/ask", (c) => {
    if (!applyCors(c)) return c.body(null, 403);
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    c.header("Access-Control-Max-Age", "86400");
    return c.body(null, 204);
  });

  app.post("/api/glasses/ask", async (c) => {
    if (!applyCors(c)) {
      return c.json({ ok: false, error: "Origin not allowed" }, 403);
    }

    if (!process.env.GLASSES_TOKEN) {
      return c.json({ ok: false, error: "Glasses endpoint disabled (no GLASSES_TOKEN)" }, 503);
    }
    if (!tokenMatches(c.req.header("Authorization"))) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }

    const contentLength = Number(c.req.header("Content-Length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return c.json({ ok: false, error: "Body too large" }, 413);
    }

    let body: { audioPcmBase64?: string; text?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const hasAudio = typeof body.audioPcmBase64 === "string" && body.audioPcmBase64.length > 0;
    const hasText = typeof body.text === "string" && body.text.trim().length > 0;
    if (hasAudio === hasText) {
      return c.json({ ok: false, error: "Provide exactly one of audioPcmBase64 or text" }, 400);
    }

    const instance = instances.find((i) => i.config.name === GLASSES_BOT);
    if (!instance) {
      return c.json({ ok: false, error: `Bot not configured: ${GLASSES_BOT}` }, 503);
    }

    const turnId = `glasses-${Date.now()}`;
    const source: "audio" | "text" = hasAudio ? "audio" : "text";

    // ── 1. Transcript ────────────────────────────────────────────────────
    let transcript: string;
    let audioBytes = 0;
    let sttMs = 0;
    if (hasAudio) {
      let pcm: Buffer;
      try {
        pcm = Buffer.from(body.audioPcmBase64!, "base64");
      } catch {
        return c.json({ ok: false, error: "audioPcmBase64 is not valid base64" }, 400);
      }
      audioBytes = pcm.byteLength;
      if (audioBytes < MIN_PCM_BYTES) {
        return c.json({ ok: false, error: "Audio too short" }, 422);
      }
      if (audioBytes > MAX_PCM_BYTES) {
        return c.json({ ok: false, error: "Audio exceeds 60s cap" }, 413);
      }
      const sttStart = Date.now();
      try {
        transcript = await transcribeShort(pcm);
      } catch (err) {
        console.error("[glasses] STT failed:", (err as Error).message);
        logGlassesTurn({
          ts: new Date().toISOString(), turn_id: turnId, stage: "error", source,
          audio_bytes: audioBytes, error: `stt: ${(err as Error).message.slice(0, 200)}`,
        });
        return c.json({ ok: false, error: "Transcription failed" }, 502);
      }
      sttMs = Date.now() - sttStart;
    } else {
      transcript = body.text!.trim().slice(0, MAX_TEXT_CHARS);
    }

    if (!transcript.trim()) {
      logGlassesTurn({
        ts: new Date().toISOString(), turn_id: turnId, stage: "error", source,
        audio_bytes: audioBytes, stt_ms: sttMs, error: "empty_transcript",
      });
      return c.json({ ok: false, error: "Could not hear a question in the audio" }, 422);
    }

    // ── 2. Persist the inbound turn BEFORE invoking ──────────────────────
    const user = lookupByUserId(GLASSES_USER_ID);
    const chatId = user?.telegramChatId ?? instance.lastChatId ?? 0;
    const senderName = user?.name ?? "the owner";
    logGlassesTurn({
      ts: new Date().toISOString(), turn_id: turnId, stage: "asked", source,
      transcript, audio_bytes: audioBytes, stt_ms: sttMs,
    });
    broadcast({
      type: "message", bot: GLASSES_BOT, direction: "in",
      contentType: source === "audio" ? "voice" : "text",
      text: transcript, timestamp: new Date().toISOString(),
      chatId, userId: GLASSES_USER_ID, senderName, source: "glasses",
    });

    // ── 3. Michael ───────────────────────────────────────────────────────
    const invokeStart = Date.now();
    let result: Awaited<ReturnType<typeof invokeAgent>>;
    try {
      result = await withBotSlot(GLASSES_BOT, () =>
        invokeAgent({
          chatId,
          botName: GLASSES_BOT,
          message: transcript,
          sessionMap: instance.sessionMap,
          config,
          model: instance.config.model,
          telegramUser: GLASSES_USER_ID,
          extraSystemHint: HUD_HINT,
        }),
      );
    } catch (err) {
      const busy = err instanceof ConcurrencyCapError;
      console.error("[glasses] invoke failed:", (err as Error).message);
      logGlassesTurn({
        ts: new Date().toISOString(), turn_id: turnId, stage: "error", source,
        transcript, invoke_ms: Date.now() - invokeStart,
        error: busy ? "concurrency_cap" : `invoke: ${(err as Error).message.slice(0, 200)}`,
      });
      return c.json(
        { ok: false, error: busy ? "Michael is mid-task — try again in a moment" : "Michael is unreachable" },
        busy ? 429 : 502,
      );
    }
    const invokeMs = Date.now() - invokeStart;

    // ── 4. Persist the reply BEFORE delivery ─────────────────────────────
    logGlassesTurn({
      ts: new Date().toISOString(), turn_id: turnId, stage: "replied", source,
      transcript, reply: result.response, audio_bytes: audioBytes,
      stt_ms: sttMs, invoke_ms: invokeMs, cost_usd: result.cost,
    });
    broadcast({
      type: "message", bot: GLASSES_BOT, direction: "out", contentType: "text",
      text: result.response, timestamp: new Date().toISOString(),
      chatId, userId: GLASSES_USER_ID, senderName, source: "glasses",
    });
    console.log(`[glasses] ${turnId} ok — stt ${sttMs}ms, invoke ${invokeMs}ms, $${result.cost ?? 0}`);

    return c.json({
      ok: true,
      transcript,
      reply: result.response,
      costUsd: result.cost,
      durationMs: invokeMs,
    });
  });
}
