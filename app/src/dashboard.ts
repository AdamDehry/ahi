import { APP_HOST, APP_URL } from "./app-url.js";
import { AI_ROOT } from "./ai-root.js";
import { workingFolderLine } from "./working-folders.js";
import { appPrincipalChatId } from "./session-map.js";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { InputFile } from "grammy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getClips, addClip, deleteClip } from "./clipboard.js";
import { listFiles, getFilePath, saveFile, deleteFile, listCategories, createCategory, renameCategory, deleteCategory, moveFile } from "./uploads.js";
import { broadcast, broadcastEvent, type MessageEvent } from "./websocket.js";
import { trackTurn } from "./turn-journal.js";
import { saveBotSetting } from "./bot-settings.js";
import { AVAILABLE_CLAUDE_MODELS, isAvailableClaudeModel, normalizeClaudeModel } from "./claude-models.js";
import { CARTESIA_VOICE_IDS } from "./config.js";
import type { BotConfig } from "./config.js";
import { getMessagesForUser } from "./message-store.js";
import { invokeAgent } from "./claude-invoke.js";
import { isManualTurnCancel, runDashboardTurn, steerDashboardTurn, stopDashboardTurn } from "./dashboard-turns.js";
import { transcribable, transcribeAudio } from "./voice-in.js";
import { synthesizeSpeech, synthesizeVoiceNotes } from "./voice-out.js";
import { formatForVoice } from "./voice-format.js";
import { isDiskFullError, notifyDegraded, systemDiskKb } from "./degraded-notifier.js";
import { listMissionControl, readMissionControlFile, writeMissionControlFile } from "./mission-control.js";
import {
  L1_CARDS,
  listL2,
  readL3,
  writeNotes,
  type L1Type,
} from "./mc-structured.js";
import { getEntries as getCostEntries, addPersonalEntry, updatePersonalEntry, deletePersonalEntry, listCostCategories, createCostCategory, renameCostCategory, deleteCostCategory } from "./operating-costs.js";
import type { BotInstance } from "./telegram.js";
import { lookupByToken, userCanAccessAgent, toPublic, type UserConfig } from "./users.js";
import { takeSentinelFiles } from "./chat-files/sentinel.js";
import { addBill, deleteBill, readBills, saveBillSettings, setBillsChangeListener, updateBill } from "./bills.js";
import { vapidPublicKey, pushConfigured, addSubscription, removeSubscription, getPushSettings, savePushSettings, TONES } from "./push.js";
import { SOURCES, MEMBER_SOURCES } from "./push-sources.js";
import { tryReviewChatReply } from "./review/index.js";
import { registerUpdateRoutes } from "./updates.js";
import { recordAppAnswers } from "./foreman-messages/index.js";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { resolve, join, extname, basename } from "path";
import { ahiSessionsRoot, multiUserPaths, ensureDir, safeSegment } from "./multi-user-paths.js";
import {
  isAllowedUploadMime,
  mediaDownloadName,
  mediaRef,
  mediaThumbPath,
  registerMedia,
  resolveMedia,
  saveTelegramMediaFile,
  typeFromUpload,
  contentDisposition,
  type MediaRef,
} from "./media-store.js";
import { voiceShareResponse } from "./media-share.js";

const execFileAsync = promisify(execFile);

/**
 * Resolve the authenticated user on a dashboard/PWA request. Accepts the
 * bearer token from (in order): X-AHI-Token header, ?token= query, or
 * ahi_token cookie. Returns null if none match a registered user.
 * Exported for the review desk (src/review/) — same auth, no new scheme.
 */
export function resolveUser(c: Context): UserConfig | null {
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

/**
 * Attachments per message (design lock v4). The composer enforces this in
 * the shelf — dims the plus, notes the cap inline, declines the 11th on
 * drop — but the client is not the authority: a hand-rolled POST must not be
 * able to hang fifty files on one turn. Mirrors ATTACHMENT_CAP in
 * web/src/lib/staging.ts; the two must move together.
 */
const ATTACHMENT_CAP = 10;

const PUBLIC_DIR = resolve(import.meta.dirname, "../public");
// Cutover: the built dashboard SPA (web/dist, `npm run build:web`) is THE
// app on the app hosts. It replaced the old phone PWA at public/app — an
// installed old PWA picks up the new /sw.js on its next update check and
// upgrades itself to the new app.
const WEB_DIST_DIR = resolve(import.meta.dirname, "../web/dist");
const DISK_SNAPSHOT_PATH = resolve(AI_ROOT, "state/disk_snapshot.json");
const DISK_CACHE_MS = 30_000;

type DiskPayload = {
  free_gb: number;
  total_gb: number;
  free_pct: number;
  used_pct: number;
  delta_24h_gb: number | null;
  snapshot_age_hours: number | null;
  status: "ok" | "warn" | "urgent" | "emergency";
};

let diskCache: { at: number; payload: DiskPayload } | null = null;

// Hosts that serve the dashboard SPA (web/dist) at the root: this install's own address (AHI_APP_URL) and
// the local machine. Any non-API GET on these hosts is served from web/dist: static files when they exist,
// SPA fallback to index.html otherwise. Same-origin with /app/send and /ui/ws.
const PWA_HOSTS = new Set([APP_HOST, "localhost", "127.0.0.1"]);

// An optional older host (AHI_LEGACY_HOST) that redirects to the app when AHI_REDIRECT_LEGACY=true;
// <legacy host>/legacy/* always bypasses the redirect and serves the legacy dashboard. Off by default.
const LEGACY_HOST = (process.env.AHI_LEGACY_HOST || "").toLowerCase();
const LEGACY_BYPASS_PREFIX = "/legacy";

function isLegacyHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return !!LEGACY_HOST && host === LEGACY_HOST;
}

function legacyRedirectEnabled(): boolean {
  return process.env.AHI_REDIRECT_LEGACY === "true";
}

// API path prefixes that stay API even on PWA hosts. Anything that DOES
// NOT start with one of these is treated as a PWA client route on
// the app host and falls through to the static/SPA handler.
const API_PATH_PREFIXES = [
  "/app/",       // /app/send etc.
  "/ui/",        // dashboard API + WS
  "/ui",         // exact /ui — dashboard login page (not served on PWA hosts)
  "/api/",       // shared gateway API (disk gauge, future live status)
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

function readPublicFileResponse(
  relativePath: string,
  cacheControl = "no-cache, no-store, must-revalidate",
): Response | null {
  const fullPath = join(PUBLIC_DIR, relativePath);
  if (!fullPath.startsWith(PUBLIC_DIR) || !existsSync(fullPath)) return null;
  const data = readFileSync(fullPath);
  const ct = PWA_MIME[extname(fullPath)] || "application/octet-stream";
  return new Response(data, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": cacheControl,
      "CDN-Cache-Control": "no-store",
    },
  });
}

function readWebDistFileResponse(
  relativePath: string,
  cacheControl = "no-cache, no-store, must-revalidate",
): Response | null {
  const fullPath = join(WEB_DIST_DIR, relativePath);
  if (!fullPath.startsWith(WEB_DIST_DIR) || !existsSync(fullPath)) return null;
  const data = readFileSync(fullPath);
  const ct = PWA_MIME[extname(fullPath)] || "application/octet-stream";
  return new Response(data, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": cacheControl,
      "CDN-Cache-Control": "no-store",
    },
  });
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

function statusForFreePct(freePct: number): DiskPayload["status"] {
  if (freePct < 5) return "emergency";
  if (freePct < 10) return "urgent";
  if (freePct < 20) return "warn";
  return "ok";
}

async function getDiskPayload(): Promise<DiskPayload> {
  const now = Date.now();
  if (diskCache && now - diskCache.at < DISK_CACHE_MS) {
    return diskCache.payload;
  }

  const { totalKb, freeKb } = systemDiskKb();
  if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb) || totalKb <= 0) {
    throw new Error(`disk size was not readable: total=${totalKb} free=${freeKb}`);
  }

  const totalGb = Math.floor(totalKb / 1048576);
  const freeGb = Math.floor(freeKb / 1048576);
  const freePct = Math.floor((freeKb / totalKb) * 100);
  const usedPct = Math.max(0, Math.min(100, 100 - freePct));

  let delta24hGb: number | null = null;
  let snapshotAgeHours: number | null = null;
  try {
    const raw = readFileSync(DISK_SNAPSHOT_PATH, "utf-8");
    const snapshot = JSON.parse(raw) as { ts?: unknown; free_gb?: unknown };
    const prevFreeGb = Number(snapshot.free_gb);
    const prevTs = Number(snapshot.ts);
    if (Number.isFinite(prevFreeGb)) {
      delta24hGb = freeGb - prevFreeGb;
    }
    if (Number.isFinite(prevTs) && prevTs > 0) {
      snapshotAgeHours = Math.max(0, Math.floor((Date.now() / 1000 - prevTs) / 3600));
    }
  } catch {
    // Snapshot is best-effort context; current df state remains authoritative.
  }

  const payload: DiskPayload = {
    free_gb: freeGb,
    total_gb: totalGb,
    free_pct: freePct,
    used_pct: usedPct,
    delta_24h_gb: delta24hGb,
    snapshot_age_hours: snapshotAgeHours,
    status: statusForFreePct(freePct),
  };

  diskCache = { at: now, payload };
  return payload;
}

const AVAILABLE_MODELS = AVAILABLE_CLAUDE_MODELS;
const OPENAI_VOICES = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
// Google shared name pool — used by both Gemini 2.5 Flash TTS and Chirp 3 HD
const GOOGLE_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];
// ElevenLabs v3 saved voices (Step 6 — michael-only experiment; the `bots`
// filter below keeps the group out of other agents' pickers and the POST
// handler enforces the same). Names must match the owner's saved voices — the
// TTS layer resolves them via GET /v1/voices (env MICHAEL_ELEVEN_VOICE_ID
// pins the exact id while the name is unchanged).
const ELEVEN_VOICES = ["Daniel"];
// Cartesia Sonic voices — michael-only for now, same scoping as the
// ElevenLabs experiment. Names come from the CARTESIA_VOICE_IDS catalog in
// config.ts so the picker and the id sent to Cartesia share one source.
// English only: Hebrew is a separate localized voice_id (later ticket).
const CARTESIA_VOICES = Object.keys(CARTESIA_VOICE_IDS);
const VOICE_GROUPS = [
  { label: "OpenAI", provider: "openai" as const, voices: OPENAI_VOICES },
  { label: "Google (Gemini)", provider: "gemini" as const, voices: GOOGLE_VOICES },
  { label: "ElevenLabs (v3)", provider: "elevenlabs" as const, voices: ELEVEN_VOICES, bots: ["michael"] },
  { label: "Cartesia (Sonic 3.5)", provider: "cartesia" as const, voices: CARTESIA_VOICES, bots: ["michael"] },
];
const ALL_VOICE_NAMES = new Set([...OPENAI_VOICES, ...GOOGLE_VOICES, ...ELEVEN_VOICES, ...CARTESIA_VOICES]);

/**
 * The voice actually serving for a bot, derived from its live BotConfig.
 * Single helper so the settings GET, the settings PATCH response and the UI
 * can never report a different voice than the one the TTS layer will use.
 */
function effectiveVoiceFor(cfg: BotConfig): string {
  switch (cfg.ttsProvider) {
    case "cartesia": return cfg.cartesia.voiceName;
    case "elevenlabs": return cfg.eleven.voiceName;
    case "gemini": return cfg.geminiVoice;
    case "google":
    case "chirp": return cfg.googleVoice;
    default: return cfg.voice;
  }
}

// Found on PATH unless pinned: installs on Mac and Windows have no /usr/bin, and ffmpeg is not bundled.
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_BIN || "ffprobe";
const DASHBOARD_VOICE_MAX_BYTES = 25 * 1024 * 1024;
const DASHBOARD_ALWAYS_VOICE_BOTS = new Set(["miriam"]);
const DASHBOARD_IDENTITY_TAGGED_BOTS = new Set(["miriam"]);

class VoiceTranscodeError extends Error {
  constructor(message = "Couldn't process that recording — try again") {
    super(message);
    this.name = "VoiceTranscodeError";
  }
}

function audioExtFromMime(mime: string): string {
  const normalized = mime.split(";")[0].trim().toLowerCase();
  const byMime: Record<string, string> = {
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/aac": "aac",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/oga": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
  };
  return byMime[normalized] || "audio";
}

function dashboardContainsCode(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || (/`[^`]+`/.test(text) && text.split("`").length > 4);
}

function dashboardShouldVoiceRespond(botName: string, response: string, inputWasVoice: boolean): boolean {
  if (botName === "tzali") return inputWasVoice && !dashboardContainsCode(response);
  if (DASHBOARD_ALWAYS_VOICE_BOTS.has(botName)) return true;
  return inputWasVoice;
}

function estimateVoiceDurationSec(text: string): number {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 2.6));
}

function splitTranscriptForVoiceMedia(text: string, count: number): string[] {
  if (count <= 1) return [text];
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return Array.from({ length: count }, () => text);
  const per = Math.ceil(words.length / count);
  return Array.from({ length: count }, (_, i) => words.slice(i * per, (i + 1) * per).join(" ") || text);
}

/**
 * The chat an app turn runs in. A user's own Telegram chat when she has one —
 * unchanged, so existing conversations keep their keys. Without one, her own
 * stable app chat (B6): never chat 0, which every app-only user used
 * to share, and never the agent's last chat, which could resume ANOTHER
 * person's session with the agent (an admin used to fall back to it).
 */
export function appChatId(user: Pick<UserConfig, "telegramChatId" | "userId">): number {
  return user.telegramChatId ?? appPrincipalChatId(user.userId);
}

export function tagDashboardMessageForBot(message: string, botName: string, user: Pick<UserConfig, "userId">): string {
  // A working location pinned in the app for this conversation rides every app turn (working-folders.ts).
  const where = workingFolderLine(user.userId, botName);
  const body = where ? `${message}\n\n${where}` : message;
  if (!DASHBOARD_IDENTITY_TAGGED_BOTS.has(botName)) return body;
  // Lowercase id, exactly as Telegram tags it ("[from: family]") — the soul keys on that form.
  return `[from: ${user.userId || "unknown"}]\n${body}`;
}

async function probeAudioDurationSec(filePath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const duration = Number(String(stdout).trim());
    return Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined;
  } catch {
    return undefined;
  }
}

async function transcodeBrowserVoiceToOgg(input: Buffer, mime: string): Promise<{ audioBuffer: Buffer; durationSec?: number; mime: string; ext: string }> {
  const normalized = mime.split(";")[0].trim().toLowerCase();
  const tmpRoot = await mkdtemp(join(tmpdir(), "ahi-pwa-voice-"));
  const inputPath = join(tmpRoot, `input.${audioExtFromMime(normalized)}`);
  const outputPath = join(tmpRoot, "voice.ogg");
  try {
    await writeFile(inputPath, input);
    try {
      await execFileAsync(FFMPEG_BIN, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-vn",
        "-acodec",
        "libopus",
        "-b:a",
        "32k",
        "-ar",
        "48000",
        "-ac",
        "1",
        outputPath,
      ]);
    } catch (err) {
      // No ffmpeg on this computer: keep the browser's own recording when the transcriber can read it.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && transcribable(normalized)) {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
        return { audioBuffer: input, mime: normalized, ext: audioExtFromMime(normalized) };
      }
      const first8 = input.subarray(0, 8).toString("hex").toUpperCase().replace(/(..)/g, "$1 ").trim();
      console.error(
        `[dashboard] voice transcode failed raw.length=${input.length} originalMime=${mime || "unknown"} first8=${first8 || "empty"} inputPath=${inputPath} tmpRoot=${tmpRoot}:`,
        (err as Error).message,
      );
      throw new VoiceTranscodeError();
    }
    const audioBuffer = readFileSync(outputPath);
    const durationSec = await probeAudioDurationSec(outputPath);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    return { audioBuffer, durationSec, mime: "audio/ogg", ext: "ogg" };
  } catch (err) {
    if (err instanceof VoiceTranscodeError) throw err;
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function registerDashboardOutboundVoice(opts: {
  userId: string;
  botName: string;
  audioBuffer: Buffer;
  transcript: string;
  durationText?: string;
  part?: number;
  total?: number;
}): Promise<{ media: MediaRef; durationSec: number } | null> {
  try {
    const suffix = opts.total && opts.total > 1 ? `-part-${opts.part || 1}-of-${opts.total}` : "";
    const filename = `${opts.botName}-reply-${Date.now()}${suffix}.ogg`;
    const filePath = await saveTelegramMediaFile(opts.userId, filename, opts.audioBuffer);
    const durationSec = (await probeAudioDurationSec(filePath)) || estimateVoiceDurationSec(opts.durationText || opts.transcript);
    const record = await registerMedia({
      userId: opts.userId,
      bot: opts.botName,
      source: "ui-upload",
      type: "voice",
      filePath,
      originalName: filename,
      mime: "audio/ogg",
      durationSec,
      transcript: opts.transcript,
    });
    return { media: mediaRef(record), durationSec };
  } catch (err) {
    console.warn(`[dashboard:${opts.botName}] outbound voice media registration failed: ${(err as Error).message}`);
    return null;
  }
}

export async function broadcastDashboardAgentReply(opts: {
  instance: BotInstance;
  botName: string;
  response: string;
  inputWasVoice: boolean;
  user: UserConfig;
  chatId: number;
  source: "app" | "ui-send";
  /** Also send the reply to the user's Telegram chat (default true). */
  mirrorTelegram?: boolean;
}): Promise<void> {
  const cfg = opts.instance.config;
  // Files the agent made (`[[send_file:]]`) land in this user's app chat;
  // the marker lines never reach the thread.
  const shown = takeSentinelFiles(opts.response || "", { userId: opts.user.userId, admin: opts.user.admin, bot: opts.botName });
  if (!shown.trim() && opts.response?.trim()) return;
  const telegramChatId = opts.mirrorTelegram === false ? null : opts.user.telegramChatId;
  // (below: `telegramChatId`, never opts.user.telegramChatId directly)
  const base = {
    bot: opts.botName,
    direction: "out" as const,
    timestamp: new Date().toISOString(),
    chatId: opts.chatId,
    userId: opts.user.userId,
    senderName: opts.user.name,
    source: opts.source,
  };
  const response = shown || "(No text came back from the agent this turn. Try rephrasing.)";
  const useVoice = dashboardShouldVoiceRespond(opts.botName, response, opts.inputWasVoice);
  if (!useVoice) {
    broadcast({ type: "message", ...base, contentType: "text", text: response });
    if (telegramChatId) {
      opts.instance.bot.api.sendMessage(telegramChatId, response).catch(() => {});
    }
    return;
  }

  try {
    const { speakable, textSummary } = formatForVoice(response);
    const voiceItems: Array<{ media: MediaRef; durationSec: number }> = [];
    // One note however long the reply; parts only past Telegram's upload cap.
    const chunks = await synthesizeVoiceNotes({
      text: speakable,
      voice: cfg.voice,
      provider: cfg.ttsProvider,
      googleVoice: cfg.googleVoice,
      geminiVoice: cfg.geminiVoice,
      styleInstructions: cfg.styleInstructions,
      agentName: opts.botName,
      eleven: cfg.eleven,
      cartesia: cfg.cartesia,
    });
    const spokenParts = splitTranscriptForVoiceMedia(speakable, chunks.length);
    for (let i = 0; i < chunks.length; i += 1) {
      const registered = await registerDashboardOutboundVoice({
        userId: opts.user.userId,
        botName: opts.botName,
        audioBuffer: chunks[i].audioBuffer,
        transcript: response,
        durationText: spokenParts[i] || speakable,
        part: i + 1,
        total: chunks.length,
      });
      if (registered) voiceItems.push(registered);
      if (telegramChatId) {
        opts.instance.bot.api.sendVoice(telegramChatId, new InputFile(chunks[i].audioBuffer, "response.ogg")).catch(() => {});
      }
    }

    if (voiceItems.length > 0) {
      for (const item of voiceItems) {
        broadcast({
          type: "message",
          ...base,
          contentType: "voice",
          text: item.media.transcript || response,
          meta: { voiceDuration: item.durationSec },
          media: item.media,
        });
      }
      if (textSummary && textSummary.length > 1024) {
        void sendTelegramOnlyTextFollowup(opts.instance, telegramChatId, textSummary, opts.botName);
      }
      return;
    }
  } catch (err) {
    console.error(`[dashboard:${opts.botName}] TTS failed, falling back to text:`, err);
  }

  broadcast({ type: "message", ...base, contentType: "text", text: response });
  if (telegramChatId) {
    opts.instance.bot.api.sendMessage(telegramChatId, response).catch(() => {});
  }
}

function splitTelegramText(text: string, maxLen = 4000): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > maxLen) {
    const candidates = [
      rest.lastIndexOf("\n\n", maxLen),
      rest.lastIndexOf("\n", maxLen),
      rest.lastIndexOf(" ", maxLen),
    ];
    const cut = candidates.find((index) => index > Math.floor(maxLen * 0.55)) ?? maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendTelegramOnlyTextFollowup(
  instance: BotInstance,
  telegramChatId: number | null | undefined,
  text: string,
  botName: string,
): Promise<void> {
  if (!telegramChatId || !text.trim()) return;
  try {
    for (const chunk of splitTelegramText(text)) {
      await instance.bot.api.sendMessage(telegramChatId, chunk);
    }
  } catch (err) {
    console.warn(`[dashboard:${botName}] Telegram text follow-up failed: ${(err as Error).message}`);
  }
}

function scopedStreamEvent(event: Record<string, unknown>, user: UserConfig): Record<string, unknown> {
  return { ...event, userId: user.userId, senderName: user.name };
}

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

  // --- /legacy bypass (ANY host) — the cutover rollback affordance ────────
  //
  // /legacy/PATH is stripped of the prefix and 308-rewritten to /ui...,
  // so the OLD dashboard stays reachable on both app hosts the whole time
  // the new SPA is the root app. Host is preserved by the redirect; the
  // /ui* handlers below serve the legacy shell + assets as they always
  // have. (Pre-cutover this lived inside the legacy-host handler only.)
  dash.use("*", async (c, next) => {
    const path = c.req.path;
    if (path !== LEGACY_BYPASS_PREFIX && !path.startsWith(LEGACY_BYPASS_PREFIX + "/")) return next();
    const stripped = path.slice(LEGACY_BYPASS_PREFIX.length) || "/";
    // /legacy → /ui · /legacy/ → /ui · /legacy/foo.css → /ui/foo.css
    const url = new URL(c.req.url);
    url.pathname = stripped === "/" ? "/ui" : `/ui${stripped}`;
    return c.redirect(url.toString(), 308);
  });

  // --- Legacy host handler (AHI_LEGACY_HOST) ──────────────────────────────
  //
  // Post-cutover the legacy host serves the NEW SPA at root (it is in
  // PWA_HOSTS below); its old root shell is retired. What remains here is
  // the H-040 D1 canonicalization: with AHI_REDIRECT_LEGACY=true,
  // <legacy host>/* 302s to the app address (query preserved)
  // so legacy bookmarks land on the canonical host. Default OFF — both
  // hosts then serve the same new app.
  dash.use("*", async (c, next) => {
    if (!isLegacyHost(c.req.header("host"))) return next();
    if (legacyRedirectEnabled()) {
      const url = new URL(c.req.url);
      url.host = new URL(APP_URL).host;
      url.protocol = "https:";
      // url.port intentionally cleared — public host has no explicit port.
      url.port = "";
      return c.redirect(url.toString(), 302);
    }
    return next();
  });

  // Root-scoped app/PWA assets. On app hosts these come from web/dist —
  // including sw.js (so previously installed PWAs, old dashboard and old
  // ahi-app alike, self-upgrade to the new app on their next SW update
  // check) and manifest.json mapped to the new manifest.webmanifest (CP2
  // pattern, retargeted). The public/ fallback keeps LEGACY PWA installs
  // on unknown hosts working; those icon files carry the new AHI mark
  // now (gen-icons.mjs mirrors them), byte-identical with web/dist.
  for (const asset of ["manifest.json", "sw.js", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
    dash.get(`/${asset}`, (c) => {
      if (isPwaHost(c.req.header("host"))) {
        const pwaAsset = asset === "manifest.json" ? "manifest.webmanifest" : asset;
        const response = readWebDistFileResponse(pwaAsset);
        if (response) return response;
      }
      const response = readPublicFileResponse(asset);
      if (!response) return c.notFound();
      return response;
    });
  }

  // --- App host handler ───────────────
  //
  // Serves the built dashboard SPA from web/dist (cutover). API routes
  // (/app/send, /ui/*, /invoke/*, /transcribe/*, /voice-upload, /health)
  // pass through to the handlers below — same origin, zero CORS.
  //
  // Non-API GETs first try an on-disk file under web/dist/; if none is
  // found (a client route or bookmarked deep link) we fall back to
  // web/dist/index.html so the SPA takes over. Anything else (POST/PUT on
  // unknown paths) returns 404.
  dash.use("*", async (c, next) => {
    if (!isPwaHost(c.req.header("host"))) return next();
    if (isApiPath(c.req.path)) return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();

    // Strip leading slash, normalize default root.
    const relRaw = c.req.path === "/" ? "/index.html" : c.req.path;
    const filePath = join(WEB_DIST_DIR, relRaw);
    const indexPath = join(WEB_DIST_DIR, "index.html");

    // Prevent path traversal — resolved path must remain inside WEB_DIST_DIR.
    const servePath = filePath.startsWith(WEB_DIST_DIR) && existsSync(filePath)
      ? filePath
      : indexPath;

    if (!existsSync(servePath)) {
      return c.text("Dashboard SPA not built — run `npm run build:web` in the gateway root.", 503);
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
    // Static-asset skip: TOP-LEVEL /ui/<asset>.<ext> only (style.css,
    // app.js, icon.svg). The old `.+` also matched nested paths like
    // /ui/files/general%2Fshot.png, leaving c.get("user") unset — every
    // image-extension file download 401'd (pre-existing bug, hit by the
    // 3d thumbnails; the legacy dashboard has it too).
    if (path === "/ui/login" || path === "/ui/logout" || path === "/ui/health" || path.match(/^\/ui\/[^/]+\.(css|js|png|svg|ico|json|woff2?)$/)) {
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
  // Scoped to the requesting user's allowed agents so a family member / another user see
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

  // --- Disk fuel gauge ---
  //
  // Backed by the live system-disk size (systemDiskKb) plus the cron-maintained 24h snapshot. The
  // result is cached for 30s so a dashboard refresh storm cannot hammer the
  // OS command path.
  dash.get("/api/disk", async (c) => {
    try {
      c.header("Cache-Control", "no-cache, no-store, must-revalidate");
      return c.json(await getDiskPayload());
    } catch (err) {
      console.error("[dashboard] /api/disk failed:", err);
      return c.json({ error: "disk_unavailable" }, 500);
    }
  });

  // --- Updates (owner): a newer AHI release, and its skills shelf ---
  registerUpdateRoutes(dash, resolveUser, {
    appDir: resolve(import.meta.dirname, ".."),
    skillsRoot: resolve(AI_ROOT, "skills"),
    claudeSkillsDir: resolve(homedir(), ".claude/skills"),
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
      const effectiveVoice = effectiveVoiceFor(cfg);
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
      const nextModel = normalizeClaudeModel(model);
      if (!isAvailableClaudeModel(nextModel)) return c.json({ error: `Invalid model: ${model}` }, 400);
      instance.config.model = nextModel;
      saveBotSetting(bot, "model", nextModel);
    }
    if (voice) {
      if (!ALL_VOICE_NAMES.has(voice)) return c.json({ error: `Invalid voice: ${voice}` }, 400);
      const isOpenAI = OPENAI_VOICES.includes(voice);
      const isEleven = ELEVEN_VOICES.includes(voice);
      const isCartesia = CARTESIA_VOICES.includes(voice);
      if (isEleven && bot !== "michael") {
        // Step 6 guardrail: the ElevenLabs experiment is michael-only.
        return c.json({ error: `ElevenLabs voices are michael-only for now` }, 400);
      }
      if (isCartesia && bot !== "michael") {
        // Same scoping as the ElevenLabs experiment.
        return c.json({ error: `Cartesia voices are michael-only for now` }, 400);
      }
      const provider = isCartesia ? "cartesia" : isEleven ? "elevenlabs" : isOpenAI ? "openai" : "gemini";
      instance.config.ttsProvider = provider;
      saveBotSetting(bot, "ttsProvider", provider);
      if (isCartesia) {
        // Persist the NAME; the id is derived from the catalog so the label
        // in the UI and the id sent to Cartesia can never disagree.
        instance.config.cartesia.voiceName = voice;
        instance.config.cartesia.voiceId = CARTESIA_VOICE_IDS[voice];
        saveBotSetting(bot, "cartesiaVoiceName", voice);
      } else if (isEleven) {
        // If the picked name differs from the env-configured one, drop the
        // pinned voice_id so the name lookup (with its non-premade
        // preference) resolves the new voice instead of the stale pin.
        if (voice !== instance.config.eleven.voiceName) {
          instance.config.eleven.voiceId = undefined;
        }
        instance.config.eleven.voiceName = voice;
        saveBotSetting(bot, "elevenVoiceName", voice);
      } else if (isOpenAI) {
        instance.config.voice = voice;
        saveBotSetting(bot, "voice", voice);
      } else {
        instance.config.geminiVoice = voice;
        saveBotSetting(bot, "geminiVoice", voice);
      }
    }

    const effectiveVoiceOut = effectiveVoiceFor(instance.config);
    console.log(`[settings] ${bot} updated — model: ${instance.config.model}, provider: ${instance.config.ttsProvider}, voice: ${effectiveVoiceOut}`);
    return c.json({
      ok: true,
      name: bot,
      model: instance.config.model,
      ttsProvider: instance.config.ttsProvider,
      voice: effectiveVoiceOut,
    });
  });

  // --- Mission Control ---
  //
  // Admin gets ~/ai/mission-control/ directly. Non-admin gets
  // ~/ai/mission-control/<userId>/, seeded on first access with their
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

  // --- Mission Control structured (L2/L3 read + the owner's Notes write-back) ---
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
  //                                                 the <!-- owner-notes -->
  //                                                 fence inside the entry.

  const VALID_L1: L1Type[] = ["handoff", "today", "activity", "todo", "agents", "architecture", "fitness"];
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
  // H-040 Round 2 D2. Mirrors the legacy `/ui/clips*`
  // surface but uses `resolveUser(c)` directly per the owner's auth-fix
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

  // --- Bills: every user's OWN private list (bills.ts) ---
  //
  // The userId is ALWAYS the authenticated caller's; nothing in the URL or
  // body can name another user, and there is no admin override. The owner's
  // bills are his file, a family member's are hers.
  setBillsChangeListener((userId, file) => broadcastEvent({ type: "bills-update", userId, bills: file.bills, settings: file.settings }));

  dash.get("/app/bills", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const file = readBills(user.userId);
    c.header("Cache-Control", "no-store");
    return c.json({ bills: file.bills, settings: file.settings });
  });

  dash.post("/app/bills", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const r = await addBill(user.userId, body, "user");
    return r.ok ? c.json({ ok: true, bill: r.bill }) : c.json({ error: r.error }, r.status);
  });

  dash.put("/app/bills/settings", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const r = await saveBillSettings(user.userId, body);
    return r.ok ? c.json({ ok: true, settings: r.file.settings }) : c.json({ error: r.error }, r.status);
  });

  dash.put("/app/bills/:id", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const r = await updateBill(user.userId, c.req.param("id"), body, "user");
    return r.ok ? c.json({ ok: true, bill: r.bill }) : c.json({ error: r.error }, r.status);
  });

  dash.delete("/app/bills/:id", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const r = await deleteBill(user.userId, c.req.param("id"));
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  });

  // --- Operating Costs (admin-only) ---
  //
  // Operating costs is the owner-personal data — subscriptions, the business costs,
  // personal finance buckets. Hidden from the UI for non-admin; 403 here
  // is belt-and-suspenders.
  // ── Step 3d (additive): dynamic cost categories ────────────────────
  dash.get("/ui/cost-categories", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    return c.json({ categories: listCostCategories() });
  });

  dash.post("/ui/cost-categories", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
    const result = createCostCategory(body.label ?? "");
    return result.ok ? c.json(result) : c.json({ error: result.error }, 400);
  });

  dash.put("/ui/cost-categories/:key", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
    const result = renameCostCategory(c.req.param("key"), body.label ?? "");
    return result.ok ? c.json(result) : c.json({ error: result.error }, 400);
  });

  dash.delete("/ui/cost-categories/:key", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);
    const result = deleteCostCategory(c.req.param("key"));
    return result.ok ? c.json(result) : c.json({ error: result.error }, 400);
  });

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
  // The owner no longer sees a family member's Miriam/a learning agent conversations, and
  // vice-versa. another user's a private agent thread stays private to another user only.
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
  // Legacy state/clipboard files remain read fallbacks until the owner runs the
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
  // Legacy state/uploads files remain read fallbacks until the owner runs the
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
    if (!isAllowedUploadMime(file.type, file.name)) {
      return c.json({ error: "Unsupported file type. Upload images, PDFs, documents, audio (mp3, m4a, ogg, wav) or video (mp4, mov, webm)." }, 400);
    }
    try {
      // Step 3d: optional target category; absent → "general" (pre-3d behavior).
      const categoryRaw = formData.get("category");
      const category = typeof categoryRaw === "string" && categoryRaw.trim() ? categoryRaw : undefined;
      const name = await saveFile(user.userId, file.name, await file.arrayBuffer(), category);
      const fullPath = getFilePath(user.userId, name);
      if (!fullPath) return c.json({ error: "Saved file could not be resolved" }, 500);
      const botNameRaw = formData.get("bot");
      const botName = typeof botNameRaw === "string" ? botNameRaw : "";
      const textRaw = formData.get("text");
      const text = typeof textRaw === "string" ? textRaw.trim() : "";
      const mediaType = typeFromUpload(file.type, file.name);
      const record = await registerMedia({
        userId: user.userId,
        bot: botName || undefined,
        source: "ui-upload",
        type: mediaType,
        filePath: fullPath,
        originalName: file.name,
        mime: file.type || undefined,
      });
      const media = mediaRef(record);

      // Legacy Files tab upload: no bot means "save only", same behavior as before.
      if (!botName) {
        return c.json({ ok: true, name, media });
      }

      if (!userCanAccessAgent(user, botName)) {
        return c.json({ error: `No access to ${botName}` }, 403);
      }
      const instance = instances.find((i) => i.config.name === botName);
      if (!instance) return c.json({ error: `Unknown bot: ${botName}` }, 404);

      const chatId = appChatId(user);
      const now = new Date().toISOString();
      const displayText = text || (mediaType === "image" ? "[image]" : `[${file.name}]`);
      const inEvent: MessageEvent = {
        type: "message",
        bot: botName,
        direction: "in",
        contentType: mediaType === "image" ? "photo" : "document",
        text: displayText,
        timestamp: now,
        chatId,
        userId: user.userId,
        senderName: user.name,
        source: "ui-send",
        media,
      };
      broadcast(inEvent);

      const agentMessage = mediaType === "image"
        ? `[The user uploaded an image: "${file.name}" (${media.mime}). Read and analyze the image at ${record.path} then respond.]\n\n${text || ""}`.trim()
        : `[The user uploaded a document: "${file.name}" (${media.mime}). Read the file at ${record.path} then respond.]\n\n${text || ""}`.trim();

      const turn = trackTurn({ bot: botName, userId: user.userId, chatId, surface: "ui-send", inputWasVoice: false, messageId: inEvent.meta?.messageId ?? null, prompt: agentMessage, said: displayText, startedAt: now });
      invokeAgent({
        chatId,
        botName,
        message: tagDashboardMessageForBot(agentMessage, botName, user),
        sessionMap: instance.sessionMap,
        config: gatewayConfig,
        model: instance.config.model,
        onStreamEvent: (e) => broadcastEvent(scopedStreamEvent(e, user)),
        thread: { userId: user.userId, excludeMessageId: inEvent.meta?.messageId ?? null },
      }).then((result) => {
        const shown = takeSentinelFiles(result.response, { userId: user.userId, admin: user.admin, bot: botName });
        if (shown) broadcast({ type: "message", bot: botName, direction: "out", contentType: "text", text: shown, timestamp: new Date().toISOString(), chatId, userId: user.userId, senderName: user.name, source: "ui-send" });
        turn.done();
        if (user.telegramChatId && shown) {
          instance.bot.api.sendMessage(user.telegramChatId, shown).catch(() => {});
        }
      }).catch((err) => {
        console.error(`[dashboard] Upload send error for ${botName}:`, err);
        broadcast({ type: "message", bot: botName, direction: "out", contentType: "text", text: "Error processing upload. Try again.", timestamp: new Date().toISOString(), chatId, userId: user.userId, senderName: user.name, source: "ui-send" });
        turn.done();
      });

      return c.json({ ok: true, name, media });
    } catch (err: any) {
      if (isDiskFullError(err)) {
        await notifyDegraded("file-save-enospc", `/ui/upload ${file.name} couldn't write`);
        return c.json({ error: "Disk full; couldn't save upload. Resend after cleanup." }, 507);
      }
      console.error("[dashboard] /ui/upload error:", err);
      return c.json({ error: "Upload failed. Try again." }, 400);
    }
  });

  // ── Step 3d (additive): file categories + move ─────────────────────
  // Distinct path prefixes (/ui/file-categories, /ui/files-move) so the
  // existing /ui/files/:name param routes can never shadow them.
  dash.get("/ui/file-categories", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ categories: listCategories(user.userId) });
  });

  dash.post("/ui/file-categories", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
    const result = createCategory(user.userId, body.name ?? "");
    return result.ok ? c.json(result) : c.json({ error: result.error }, 400);
  });

  dash.put("/ui/file-categories/:name", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
    const result = renameCategory(user.userId, c.req.param("name"), body.name ?? "");
    return result.ok ? c.json(result) : c.json({ error: result.error }, 400);
  });

  dash.delete("/ui/file-categories/:name", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const result = deleteCategory(user.userId, c.req.param("name"));
    return result.ok ? c.json(result) : c.json({ error: result.error }, 400);
  });

  dash.post("/ui/files-move", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ name?: string; category?: string }>().catch(() => ({} as { name?: string; category?: string }));
    if (!body.name) return c.json({ error: "name required" }, 400);
    const result = moveFile(user.userId, body.name, body.category ?? "");
    return result.ok ? c.json(result) : c.json({ error: result.error }, 400);
  });

  dash.post("/ui/voice-send", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const formData = await c.req.formData();
    const file = formData.get("audio") || formData.get("file");
    const botNameRaw = formData.get("bot");
    const botName = typeof botNameRaw === "string" ? botNameRaw : "";
    if (!botName) return c.json({ error: "Missing bot" }, 400);
    if (!userCanAccessAgent(user, botName)) return c.json({ error: `No access to ${botName}` }, 403);
    const instance = instances.find((i) => i.config.name === botName);
    if (!instance) return c.json({ error: `Unknown bot: ${botName}` }, 404);
    if (!file || !(file instanceof File)) return c.json({ error: "No audio provided" }, 400);

    const raw = Buffer.from(await file.arrayBuffer());
    if (raw.length <= 0) return c.json({ error: "Empty audio" }, 400);
    if (raw.length > DASHBOARD_VOICE_MAX_BYTES) return c.json({ error: "Voice note too large" }, 413);

    const originalMime = file.type || "application/octet-stream";
    if (originalMime && originalMime !== "application/octet-stream" && !originalMime.toLowerCase().startsWith("audio/")) {
      return c.json({ error: "Unsupported audio type" }, 400);
    }

    try {
      const now = new Date().toISOString();
      const clientDurationRaw = formData.get("durationSec");
      const clientDuration = typeof clientDurationRaw === "string" ? Number(clientDurationRaw) : undefined;
      const clientMessageIdRaw = formData.get("clientMessageId");
      const clientMessageId = typeof clientMessageIdRaw === "string" && clientMessageIdRaw.trim()
        ? clientMessageIdRaw.trim().slice(0, 120)
        : undefined;
      const { audioBuffer, durationSec: probedDuration, mime: audioMime, ext } = await transcodeBrowserVoiceToOgg(raw, originalMime);
      const durationSec = Math.max(1, Math.round(probedDuration || (Number.isFinite(clientDuration) ? Number(clientDuration) : 0) || 1));
      const filename = `pwa-voice-${Date.now()}.${ext}`;
      const filePath = await saveTelegramMediaFile(user.userId, filename, audioBuffer);
      const transcription = await transcribeAudio(audioBuffer, audioMime);
      const transcript = transcription.text.trim();
      const record = await registerMedia({
        userId: user.userId,
        bot: botName,
        source: "ui-upload",
        type: "voice",
        filePath,
        originalName: filename,
        mime: audioMime,
        durationSec,
        transcript,
      });
      const media = mediaRef(record);
      const chatId = appChatId(user);
      // Only a real Telegram chat may become the forwarding target.
      if (user.telegramChatId != null) instance.lastChatId = chatId;
      instance.lastMessageTime = now;

      const inEvent: MessageEvent = {
        type: "message",
        bot: botName,
        direction: "in",
        contentType: "voice",
        text: transcript || "[voice note]",
        timestamp: now,
        chatId,
        userId: user.userId,
        senderName: user.name,
        source: "app",
        // Echo the client's optimistic id so the dashboard reconciles its
        // pending local voice bubble with this canonical media (P4).
        meta: clientMessageId ? { voiceDuration: durationSec, clientMessageId } : { voiceDuration: durationSec },
        media,
      };
      broadcast(inEvent);

      if (!transcript) {
        return c.json({ ok: true, media, transcript, warning: "No transcript detected" });
      }

      const voicePrompt = tagDashboardMessageForBot(transcript, botName, user);
      const turn = trackTurn({ bot: botName, userId: user.userId, chatId, surface: "app-reply", inputWasVoice: true, messageId: inEvent.meta?.messageId ?? null, prompt: voicePrompt, said: transcript, startedAt: now });
      runDashboardTurn(user.userId, botName, (abortSignal) => invokeAgent({
        chatId,
        botName,
        message: voicePrompt,
        sessionMap: instance.sessionMap,
        config: gatewayConfig,
        model: instance.config.model,
        abortSignal,
        onStreamEvent: (e) => broadcastEvent(scopedStreamEvent(e, user)),
        thread: { userId: user.userId, excludeMessageId: inEvent.meta?.messageId ?? null },
      })).then((result) => broadcastDashboardAgentReply({
        instance,
        botName,
        response: result.response,
        inputWasVoice: true,
        user,
        chatId,
        source: "app",
      })).then(() => turn.done()).catch((err) => {
        turn.done();
        if (isManualTurnCancel(err)) return;
        console.error(`[dashboard] Voice send error for ${botName}:`, err);
        broadcast({
          type: "message",
          bot: botName,
          direction: "out",
          contentType: "text",
          text: "Error processing voice note. Try again.",
          timestamp: new Date().toISOString(),
          chatId,
          userId: user.userId,
          senderName: user.name,
          source: "app",
        });
      });

      return c.json({ ok: true, media, transcript, durationSec });
    } catch (err: any) {
      if (isDiskFullError(err)) {
        await notifyDegraded("voice-save-enospc", `/ui/voice-send couldn't write`);
        return c.json({ error: "Disk full; couldn't save voice note. Resend after cleanup." }, 507);
      }
      if (err instanceof VoiceTranscodeError) {
        return c.json({ error: err.message }, 422);
      }
      console.error("[dashboard] /ui/voice-send error:", err);
      return c.json({ error: "Voice send failed. Try again." }, 400);
    }
  });

  function extractLinks(text: string): string[] {
    const urls = new Set<string>();
    const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text || "")) !== null) {
      urls.add(match[0].replace(/[.,;:!?]+$/, ""));
    }
    return [...urls];
  }

  dash.get("/ui/media", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const bot = c.req.query("bot");
    const category = c.req.query("category") || "images";
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "100", 10) || 100, 1), 500);

    const bots = bot && bot !== "all" ? [bot] : user.agents;
    const items: Array<Record<string, unknown>> = [];
    for (const b of bots) {
      if (!userCanAccessAgent(user, b)) continue;
      for (const msg of getMessagesForUser(b, user.userId, 500)) {
        if (category === "links") {
          for (const url of extractLinks(msg.text || "")) {
            items.push({
              id: `${msg.timestamp}:${url}`,
              type: "link",
              bot: b,
              url,
              title: url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
              text: msg.text,
              timestamp: msg.timestamp,
              senderName: msg.senderName,
              direction: msg.direction,
            });
          }
          continue;
        }
        if (!msg.media) continue;
        if (category === "images" && msg.media.type !== "image") continue;
        if (category === "documents" && msg.media.type !== "document") continue;
        items.push({
          id: msg.media.id,
          type: msg.media.type,
          bot: b,
          media: msg.media,
          text: msg.text,
          timestamp: msg.timestamp,
          senderName: msg.senderName,
          direction: msg.direction,
        });
      }
    }
    items.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({ items: items.slice(0, limit), category, bot: bot || "all" });
  });

  dash.get("/ui/media/:id/thumb", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const record = resolveMedia(user.userId, c.req.param("id"));
    if (!record) return c.json({ error: "Not found" }, 404);
    const thumbPath = mediaThumbPath(record);
    if (!thumbPath) return c.json({ error: "Thumb not found" }, 404);
    const data = readFileSync(thumbPath);
    return new Response(data, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=86400",
      },
    });
  });

  // Share / Save in the PWA: the note as AAC .m4a, so iPhone recipients can
  // play it. Converted once per note and cached; OGG stays the in-app format.
  dash.get("/ui/media/:id/m4a", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return voiceShareResponse(user.userId, c.req.param("id"));
  });

  dash.get("/ui/media/:id", (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const record = resolveMedia(user.userId, c.req.param("id"));
    if (!record) return c.json({ error: "Not found" }, 404);
    if (!existsSync(record.path)) return c.json({ error: "Not found" }, 404);
    const data = (() => {
      try {
        return readFileSync(record.path);
      } catch {
        return null;
      }
    })();
    if (!data) return c.json({ error: "Not found" }, 404);
    const total = data.length;
    const name = mediaDownloadName(record);
    const disposition: "attachment" | "inline" = c.req.query("dl") === "1" ? "attachment" : "inline";
    const headers = {
      "Content-Type": record.mime || "application/octet-stream",
      // Original name + extension, UTF-8 safe (RFC 5987): an mp3 lands in
      // Android's Downloads as the file it was, usable by the sound picker.
      "Content-Disposition": contentDisposition(disposition, name),
      "Cache-Control": "private, max-age=86400",
      "Accept-Ranges": "bytes",
    };
    const range = c.req.header("Range") || c.req.header("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${total}` },
        });
      }
      const [, startRaw, endRaw] = match;
      let start = startRaw ? Number(startRaw) : 0;
      let end = endRaw ? Number(endRaw) : total - 1;
      if (!startRaw && endRaw) {
        const suffixLength = Number(endRaw);
        start = Math.max(0, total - suffixLength);
        end = total - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${total}` },
        });
      }
      end = Math.min(end, total - 1);
      const chunk = data.subarray(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(chunk.length),
        },
      });
    }
    return new Response(data, {
      headers: {
        ...headers,
        "Content-Length": String(total),
      },
    });
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
  // See H-019 Step 7 post-mortem for the incident that made
  // this explicit.
  dash.post("/ui/send", async (c) => {
    const user = c.get("user") as UserConfig | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const { bot: botName, text, clientMessageId } = await c.req.json<{ bot: string; text: string; clientMessageId?: string }>();
    if (!userCanAccessAgent(user, botName)) {
      return c.json({ error: `No access to ${botName}` }, 403);
    }
    const instance = instances.find((i) => i.config.name === botName);
    if (!instance) return c.json({ error: `Unknown bot: ${botName}` }, 404);

    // Prefer the user's own Telegram chatId for outbound mirroring so a
    // a family member or another user Quick Send lands in HER Telegram, not the owner's.
    const chatId = appChatId(user);
    const now = new Date().toISOString();

    // Broadcast the user's message to the feed, attributed to the
    // authenticated user.
    const clientMeta = typeof clientMessageId === "string" && clientMessageId.trim()
      ? { clientMessageId: clientMessageId.trim().slice(0, 120) }
      : undefined;
    const inEvent: MessageEvent = { type: "message", bot: botName, direction: "in", contentType: "text", text, timestamp: now, chatId, userId: user.userId, senderName: user.name, source: "ui-send", meta: clientMeta };
    broadcast(inEvent);
    const turn = trackTurn({ bot: botName, userId: user.userId, chatId, surface: "ui-send", inputWasVoice: false, messageId: inEvent.meta?.messageId ?? null, prompt: text, said: text, startedAt: now });

    // Invoke Claude in the background — don't block the response
    invokeAgent({
      chatId,
      botName,
      message: tagDashboardMessageForBot(text, botName, user),
      sessionMap: instance.sessionMap,
      config: gatewayConfig,
      model: instance.config.model,
      onStreamEvent: (e) => broadcastEvent(scopedStreamEvent(e, user)),
      thread: { userId: user.userId, excludeMessageId: inEvent.meta?.messageId ?? null },
    }).then((result) => {
      const shown = takeSentinelFiles(result.response, { userId: user.userId, admin: user.admin, bot: botName });
      if (shown) broadcast({ type: "message", bot: botName, direction: "out", contentType: "text", text: shown, timestamp: new Date().toISOString(), chatId, userId: user.userId, senderName: user.name, source: "ui-send" });
      turn.done();
      // Also send to Telegram only if this user has a real chatId.
      if (user.telegramChatId && shown) {
        instance.bot.api.sendMessage(user.telegramChatId, shown).catch(() => {});
      }
    }).catch((err) => {
      console.error(`[dashboard] Quick send error for ${botName}:`, err);
      broadcast({ type: "message", bot: botName, direction: "out", contentType: "text", text: "Error processing message. Try again.", timestamp: new Date().toISOString(), chatId, userId: user.userId, senderName: user.name, source: "ui-send" });
      turn.done();
    });

    return c.json({ ok: true });
  });

  // --- PWA Send (invoke Claude, broadcast to feed, source: "app") ---
  //
  // Mirrors /ui/send but tags messages with source: "app" so they are
  // INCLUDED in the retrieval corpus (unlike /ui/send which tags "ui-send"
  // and gets filtered out). Use this from the PWA (ahi-app on
  // a preview host) for real user turns that should land in the
  // scoring pipeline.
  //
  // Auth: DASHBOARD_TOKEN via X-AHI-Token header OR ?token= query param.
  // (Cookie auth also accepted, but the PWA is cross-origin so cookie
  // won't usually be present.)
  dash.post("/app/send", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const { bot: botName, text, clientMessageId, attachments, answers } = await c.req.json<{
      bot: string;
      text: string;
      clientMessageId?: string;
      /**
       * Build questions this message answers (Answer in thread on a Builds card
       * / Feed row, quote kept, words added): {build, record, added} each, see
       * foreman-messages/answer.ts. The message goes to Michael exactly as
       * without it; the card's question clears too.
       */
      answers?: unknown;
      /**
       * Staged media ids, in send order (design lock v4). The composer
       * uploads files as it goes via the save-only branch of /ui/upload,
       * which registers media WITHOUT broadcasting or invoking anything —
       * then quotes the ids here so the words and the cargo become one
       * message and one turn.
       */
      attachments?: string[];
    }>();
    if (!userCanAccessAgent(user, botName)) {
      return c.json({ error: `No access to ${botName}` }, 403);
    }
    const instance = instances.find((i) => i.config.name === botName);
    if (!instance) return c.json({ error: `Unknown bot: ${botName}` }, 404);

    const chatId = appChatId(user);
    const now = new Date().toISOString();

    // Resolve staged cargo. Ownership is enforced by resolveMedia being
    // scoped to the authenticated user, so one user cannot quote another's
    // media id. Unknown or foreign ids are dropped rather than failing the
    // send — the words still have to get through.
    const cargo = Array.isArray(attachments)
      ? attachments
          .slice(0, ATTACHMENT_CAP)
          .map((id) => (typeof id === "string" ? resolveMedia(user.userId, id) : null))
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .map((r) => mediaRef(r))
      : [];
    if (Array.isArray(attachments) && cargo.length !== attachments.length) {
      console.warn(
        `[dashboard] /app/send dropped ${attachments.length - cargo.length} unresolved attachment id(s) for ${user.userId}`,
      );
    }

    // Broadcast the user's message to the feed with source: "app".
    // ONE message carries the caption AND the cargo — never a separate
    // message per file, and never a caption that arrives on its own.
    const clientMeta = typeof clientMessageId === "string" && clientMessageId.trim()
      ? { clientMessageId: clientMessageId.trim().slice(0, 120) }
      : undefined;
    const firstImage = cargo.find((m) => m.type === "image");
    const inEvent: MessageEvent = {
      type: "message",
      bot: botName,
      direction: "in",
      contentType: cargo.length ? (firstImage ? "photo" : "document") : "text",
      text,
      timestamp: now,
      chatId,
      userId: user.userId,
      senderName: user.name,
      source: "app",
      meta: clientMeta,
      // `media` stays the first item so every existing single-media path
      // keeps working; `mediaList` is what the sent grid lays out.
      ...(cargo.length ? { media: cargo[0], mediaList: cargo } : {}),
    };
    broadcast(inEvent);

    // His answer to a build's question is in Michael's thread now — clear the
    // card too (build_answered.sh, the record Michael runs by hand). Background:
    // a failure is logged and the card keeps asking; the send never waits on it.
    if (answers !== undefined) void recordAppAnswers(user, botName, answers, text);

    // Review desk: a bare "yes 1, 2, no 3, hold 4" answering Michael's
    // digest is decided by the desk (YELLOW only, deterministic) and never
    // becomes an agent turn. Anything else falls through untouched.
    if (!cargo.length && tryReviewChatReply(user, botName, text)) return c.json({ ok: true, review: true });

    // ONE turn for the whole message. The cargo is described to the agent in
    // send order, with real paths, so it can read the files it was actually
    // sent — previously each file spawned its own turn and the caption a
    // further one, which is what the lock exists to stop.
    const cargoPreamble = cargo.length
      ? `[The user attached ${cargo.length} file${cargo.length === 1 ? "" : "s"}, in order:\n` +
        cargo
          .map((m, i) => `  ${i + 1}. ${m.type} "${m.originalName}" (${m.mime}) at ${m.path}`)
          .join("\n") +
        `\nRead them, then respond.]\n\n`
      : "";

    // With no cargo this is the untouched `text` the endpoint always sent —
    // not a trimmed copy of it. A cargo-less send stays byte-identical on
    // the wire and identical in the agent's input.
    const appPrompt = cargo.length ? `${cargoPreamble}${text}`.trim() : text;
    // Marked in flight from acceptance, so a message queued behind another
    // turn in this lane also survives a restart.
    const turn = trackTurn({ bot: botName, userId: user.userId, chatId, surface: "app", inputWasVoice: false, messageId: inEvent.meta?.messageId ?? null, prompt: appPrompt, said: text, startedAt: now });

    // Invoke Claude in the background — don't block the response
    runDashboardTurn(user.userId, botName, (abortSignal) => invokeAgent({
      chatId,
      botName,
      message: tagDashboardMessageForBot(appPrompt, botName, user),
      sessionMap: instance.sessionMap,
      config: gatewayConfig,
      model: instance.config.model,
      abortSignal,
      onStreamEvent: (e) => broadcastEvent(scopedStreamEvent(e, user)),
      thread: { userId: user.userId, excludeMessageId: inEvent.meta?.messageId ?? null },
    })).then((result) =>
      // Same reply path as an app voice note: files the agent made land in
      // the chat, and an always-voice agent (Miriam) answers in a voice note
      // here too, as she does on Telegram. App-only: nothing mirrors to Telegram.
      broadcastDashboardAgentReply({
        instance,
        botName,
        response: result.response,
        inputWasVoice: false,
        user,
        chatId,
        source: "app",
        mirrorTelegram: false,
      }),
    ).then(() => {
      turn.done();
    }).catch((err) => {
      turn.done();
      if (isManualTurnCancel(err)) return;
      console.error(`[dashboard] PWA /app/send error for ${botName}:`, err);
      broadcast({ type: "message", bot: botName, direction: "out", contentType: "text", text: "Error processing message. Try again.", timestamp: new Date().toISOString(), chatId, userId: user.userId, senderName: user.name, source: "app" });
    });

    return c.json({ ok: true });
  });

  // User-owned kill switch for the current app turn. The AbortSignal reaches
  // the Claude process tree; claude-invoke treats it as terminal and never
  // enters the fresh-session retry path.
  dash.post("/app/stop", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ bot?: string }>().catch((): { bot?: string } => ({}));
    const botName = body.bot;
    if (!botName || !userCanAccessAgent(user, botName)) {
      return c.json({ error: "Unknown agent" }, 400);
    }
    return c.json({ ok: true, stopped: stopDashboardTurn(user.userId, botName) });
  });

  dash.post("/app/steer", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ bot?: string }>().catch((): { bot?: string } => ({}));
    const botName = body.bot;
    if (!botName || !userCanAccessAgent(user, botName)) {
      return c.json({ error: "Unknown agent" }, 400);
    }
    return c.json({ ok: true, steered: steerDashboardTurn(user.userId, botName) });
  });

  // --- Morning-brief injection (Step 7 — Tzali) ---
  //
  // POST /app/brief — deliver a PRE-AUTHORED agent message to BOTH surfaces:
  // the app (persisted to the message store + WS broadcast, as a playable
  // voice note in the agent's configured voice with the written body as the
  // message text) AND Telegram (voice note + text). Unlike /app/send this
  // does NOT invoke Claude — the caller (the daily-learning job) already
  // authored the content; this endpoint is pure delivery.
  //
  // Contract: { bot, userId?, key, spoken, body }
  //   - key:    idempotency key, e.g. "morning-brief-2026-07-13". One
  //             delivery per key ever; a re-POST retries ONLY surfaces that
  //             previously failed, so a re-run never double-sends.
  //   - spoken: short spoken lead — this is what gets TTS'd (style-card
  //             audio tags welcome).
  //   - body:   the written substance — app message text and Telegram text.
  //   Fail-soft: TTS failure degrades to text on both surfaces; one surface
  //   failing never blocks the other. Response reports per-surface results.
  dash.post("/app/brief", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const { bot: botName, userId, key, spoken, body } = await c.req.json<{
      bot: string; userId?: string; key: string; spoken: string; body: string;
    }>();

    if (userId && userId !== user.userId) {
      return c.json({ error: "userId does not match authenticated user" }, 403);
    }
    if (!userCanAccessAgent(user, botName)) {
      return c.json({ error: `No access to ${botName}` }, 403);
    }
    const instance = instances.find((i) => i.config.name === botName);
    if (!instance) return c.json({ error: `Unknown bot: ${botName}` }, 404);
    if (typeof key !== "string" || !/^[a-zA-Z0-9._-]{1,120}$/.test(key)) {
      return c.json({ error: "key must be a short [a-zA-Z0-9._-] identifier" }, 400);
    }
    const bodyText = typeof body === "string" ? body.trim() : "";
    const spokenText = typeof spoken === "string" ? spoken.trim() : "";
    if (!bodyText) return c.json({ error: "body is required" }, 400);

    // Idempotency ledger: one file per key under ~/ai/state/brief-delivery.
    const ledgerDir = resolve(AI_ROOT, "state/brief-delivery");
    const ledgerPath = resolve(ledgerDir, `${safeSegment(user.userId, "user")}-${key}.json`);
    let ledger: { app: boolean; telegram: boolean; voice: boolean } = { app: false, telegram: false, voice: false };
    if (existsSync(ledgerPath)) {
      try {
        ledger = { ...ledger, ...JSON.parse(readFileSync(ledgerPath, "utf8")).surfaces };
      } catch { /* corrupt ledger — treat as undelivered */ }
    }
    if (ledger.app && ledger.telegram) {
      return c.json({ ok: true, alreadyDelivered: true, delivered: ledger });
    }

    const cfg = instance.config;
    const chatId = appChatId(user);
    const base = {
      bot: botName,
      direction: "out" as const,
      timestamp: new Date().toISOString(),
      chatId,
      userId: user.userId,
      senderName: user.name,
      source: "app" as const,
      meta: { turnId: `brief-${key}` },
    };

    // TTS the spoken lead (fail-soft: null → text-only delivery).
    let audio: { audioBuffer: Buffer } | null = null;
    if (spokenText) {
      try {
        audio = await synthesizeSpeech({
          text: spokenText,
          voice: cfg.voice,
          provider: cfg.ttsProvider,
          googleVoice: cfg.googleVoice,
          geminiVoice: cfg.geminiVoice,
          styleInstructions: cfg.styleInstructions,
          agentName: botName,
          eleven: cfg.eleven,
          cartesia: cfg.cartesia,
        });
      } catch (err) {
        console.error(`[dashboard:${botName}] /app/brief TTS failed (degrading to text):`, err);
      }
    }

    // Surface 1 — the app: persisted + WS, voice note when we have audio.
    if (!ledger.app) {
      try {
        if (audio) {
          const registered = await registerDashboardOutboundVoice({
            userId: user.userId,
            botName,
            audioBuffer: audio.audioBuffer,
            transcript: bodyText,
            durationText: spokenText,
          });
          if (registered) {
            broadcast({
              type: "message", ...base, contentType: "voice",
              text: bodyText,
              meta: { ...base.meta, voiceDuration: registered.durationSec },
              media: registered.media,
            });
            ledger.app = true;
            ledger.voice = true;
          }
        }
        if (!ledger.app) {
          broadcast({ type: "message", ...base, contentType: "text", text: bodyText });
          ledger.app = true;
        }
      } catch (err) {
        console.error(`[dashboard:${botName}] /app/brief app-surface delivery FAILED:`, err);
      }
    }

    // Surface 2 — Telegram: voice note (if audio) + body text, chunked.
    if (!ledger.telegram) {
      if (!user.telegramChatId) {
        // No Telegram for this user — mark the surface terminal so the key
        // can close out (otherwise retries re-run + re-TTS forever).
        console.warn(`[dashboard:${botName}] /app/brief: user ${user.userId} has no telegramChatId — Telegram surface marked n/a`);
        ledger.telegram = true;
      } else {
        try {
          if (audio) {
            await instance.bot.api.sendVoice(user.telegramChatId, new InputFile(audio.audioBuffer, "morning-brief.ogg"));
          }
          for (const chunk of splitTelegramText(bodyText)) {
            await instance.bot.api.sendMessage(user.telegramChatId, chunk);
          }
          ledger.telegram = true;
        } catch (err) {
          console.error(`[dashboard:${botName}] /app/brief Telegram delivery FAILED:`, err);
        }
      }
    }

    try {
      ensureDir(ledgerDir);
      await writeFile(ledgerPath, JSON.stringify({
        key, bot: botName, userId: user.userId, surfaces: ledger,
        updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch (err) {
      console.error(`[dashboard:${botName}] /app/brief ledger write failed:`, err);
    }

    const ok = ledger.app || ledger.telegram;
    if (!ok) console.error(`[dashboard:${botName}] /app/brief: BOTH surfaces failed for key ${key}`);
    return c.json({ ok, alreadyDelivered: false, delivered: ledger }, ok ? 200 : 502);
  });

  // --- Web Push (Step 8 — Tzali) ---
  //
  // The PWA's notification stack: the client fetches the VAPID public key,
  // subscribes via its service worker, and registers the subscription
  // here. Notification SETTINGS (per-agent on/off, sound, vibration,
  // quiet hours) live server-side with the subscriptions and are enforced
  // at SEND time (src/push.ts) — a muted agent or quiet hours means no
  // push leaves the gateway at all.

  dash.get("/app/push/vapid-public-key", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const key = vapidPublicKey();
    if (!key) return c.json({ error: "Push not configured on the gateway" }, 503);
    return c.json({ key });
  });

  dash.post("/app/push/subscribe", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!pushConfigured()) return c.json({ error: "Push not configured on the gateway" }, 503);
    const { subscription } = await c.req.json<{ subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>();
    if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return c.json({ error: "subscription with endpoint + keys required" }, 400);
    }
    await addSubscription(
      user.userId,
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
      c.req.header("user-agent"),
    );
    return c.json({ ok: true });
  });

  dash.post("/app/push/unsubscribe", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const { endpoint } = await c.req.json<{ endpoint?: string }>();
    if (!endpoint) return c.json({ error: "endpoint required" }, 400);
    await removeSubscription(user.userId, endpoint);
    return c.json({ ok: true });
  });

  dash.get("/app/push/settings", (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const sources = user.admin ? SOURCES : SOURCES.filter((x) => MEMBER_SOURCES.has(x.id));
    return c.json({ settings: getPushSettings(user.userId), configured: pushConfigured(), sources, tones: TONES });
  });

  dash.put("/app/push/settings", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const patch = await c.req.json<unknown>().catch(() => null);
    if (!patch || typeof patch !== "object") return c.json({ error: "settings object required" }, 400);
    const settings = await savePushSettings(user.userId, patch);
    return c.json({ ok: true, settings });
  });

  // --- PWA Sessions endpoints (H-040 Batch 4 — Tzali) ---
  //
  // Read-only feed for the Sessions Sidebar in the PWA. The canonical
  // index lives at `~/ai/infra/sessions/index.json` (the AHI memory index,
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
    // The whole fleet's memory, the owner's Michael transcripts included: admins only.
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);

    const indexPath = resolve(ahiSessionsRoot(), "index.json");
    if (!existsSync(indexPath)) {
      return c.json([], 200);
    }
    try {
      const raw = readFileSync(indexPath, "utf-8");
      const all = JSON.parse(raw) as Array<Record<string, unknown>>;
      // Strip filesystem paths from the wire response — the client only
      // needs them as opaque IDs which we re-resolve server-side via the
      // /transcript endpoint (keyed by session_id).
      // B4 carry-over (H-040 B5 wave): the wire response no
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
    // The whole fleet's memory, the owner's Michael transcripts included: admins only.
    if (!user.admin) return c.json({ error: "Forbidden" }, 403);

    const id = c.req.query("id");
    if (!id || typeof id !== "string") {
      return c.json({ error: "Missing id" }, 400);
    }

    const indexPath = resolve(ahiSessionsRoot(), "index.json");
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

  // --- PWA Files endpoints (H-040 Batch 5 — Tzali) ---
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
    // digits, dot, underscore, hyphen, space, parens — the owner attaches
    // things like "the business Q2 (final).pdf" and we want that intact.
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
    try {
      ensureDir(dir);
    } catch (err) {
      if (isDiskFullError(err)) {
        await notifyDegraded("file-save-enospc", `${dir} couldn't write`);
        return c.json({ error: "Disk full; couldn't save upload. Resend after cleanup." }, 507);
      }
      throw err;
    }

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
        if (isDiskFullError(err)) {
          await notifyDegraded("file-save-enospc", `${full} couldn't write`);
        }
        errors.push({ name: safeName, error: msg });
      }
    }

    if (saved.length === 0) {
      const status = errors.some((e) => isDiskFullError(e.error)) ? 507 : 400;
      return c.json({ error: status === 507 ? "Disk full; no files saved" : "No files saved", errors }, status);
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
