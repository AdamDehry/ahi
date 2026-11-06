/**
 * push.ts — Web Push for the PWA (Step 8).
 *
 * WHY: the only reason the owner knew a message arrived was Telegram's
 * notification. For the app to stand on its own ("kill Telegram" track),
 * the installed PWA must notify on new agent messages even when closed —
 * Web Push (service worker + Push API + VAPID). iOS supports this for
 * installed-to-home-screen PWAs (16.4+).
 *
 * Design:
 * - VAPID keys live in the gateway .env (VAPID_PUBLIC_KEY /
 *   VAPID_PRIVATE_KEY / VAPID_SUBJECT). Missing keys = push disabled,
 *   loudly logged once, everything else keeps working.
 * - Per-user file store at ~/ai/state/push/<userId>.json holding the
 *   user's device subscriptions AND their notification settings
 *   (per-agent on/off, sound, vibration, quiet hours). Settings are
 *   enforced SERVER-SIDE at send time — a muted agent or quiet hours
 *   means no push is sent at all (no silent-push strikes on iOS).
 * - OS notification settings are respected by construction: we emit
 *   plain notifications (no priority/interruption overrides); the
 *   in-app sound/vibration toggles only ever REDUCE what the OS would
 *   do (silent flag / empty vibration pattern).
 * - Dead subscriptions (404/410 from the push service) are pruned on
 *   send.
 */
import webpush from "web-push";
import { existsSync, readFileSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { resolve } from "path";
import type { MessageEvent } from "./websocket.js";
import { gatewayStateRoot } from "./multi-user-paths.js";
import { defaultSources, mergeSources, sourceAllows, type SourcePrefs } from "./push-sources.js";

// Each <userId>.json is rewritten whole (subscriptions + settings), and dead
// subscriptions are pruned on send — so a second gateway sharing this would
// drop devices production had just registered. Moves with the state root.
const PUSH_STATE_DIR = resolve(gatewayStateRoot(), "push");

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  ua?: string;
  createdAt: string;
}

export interface PushSettings {
  enabled: boolean; // device delivery (push) on/off
  inApp: boolean; // the in-app notification inbox (the bell)
  perAgent: Record<string, boolean>; // absent key = enabled
  sources: SourcePrefs; // per app, per activity (push-sources.ts)
  sound: boolean;
  tone: string; // the in-app cue (TONES); device alerts keep the device's own sound
  vibration: boolean;
  quietHours: { enabled: boolean; start: string; end: string; tz: string };
  urgent: boolean; // time-sensitive alerts may come through quiet hours
}

/** The in-app notification cues the app can play (web/src/lib/tones.ts renders each). */
export const TONES = ["Chime", "Glass", "Pulse", "Bell"] as const;

interface UserPushState {
  subscriptions: PushSubscriptionRecord[];
  settings: PushSettings;
}

export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  enabled: true,
  inApp: true,
  perAgent: {},
  sources: defaultSources(),
  sound: true,
  tone: "Chime",
  vibration: true,
  quietHours: { enabled: false, start: "22:00", end: "07:00", tz: "America/New_York" },
  urgent: false,
};

// ---------- VAPID configuration ----------

let vapidConfigured = false;
let warnedUnconfigured = false;

function ensureVapid(): boolean {
  if (vapidConfigured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:owner@example.com";
  if (!pub || !priv) {
    if (!warnedUnconfigured) {
      console.warn("[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push disabled (generate with: npx web-push generate-vapid-keys)");
      warnedUnconfigured = true;
    }
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  vapidConfigured = true;
  return true;
}

export function pushConfigured(): boolean {
  return ensureVapid();
}

export function vapidPublicKey(): string | null {
  return ensureVapid() ? process.env.VAPID_PUBLIC_KEY ?? null : null;
}

// ---------- per-user state ----------

function stateFile(userId: string): string {
  const safe = userId.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return resolve(PUSH_STATE_DIR, `${safe}.json`);
}

function loadState(userId: string): UserPushState {
  const path = stateFile(userId);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      return {
        subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
        settings: { ...DEFAULT_PUSH_SETTINGS, ...raw.settings, sources: mergeSources(raw.settings?.sources, null), quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, ...raw.settings?.quietHours } },
      };
    } catch (err) {
      console.error(`[push] corrupt state for ${userId} — starting fresh:`, err);
    }
  }
  return { subscriptions: [], settings: { ...DEFAULT_PUSH_SETTINGS } };
}

async function saveState(userId: string, state: UserPushState): Promise<void> {
  await mkdir(PUSH_STATE_DIR, { recursive: true });
  await writeFile(stateFile(userId), JSON.stringify(state, null, 2));
}

export async function addSubscription(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, ua?: string): Promise<void> {
  const state = loadState(userId);
  state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
  state.subscriptions.push({ endpoint: sub.endpoint, keys: sub.keys, ua, createdAt: new Date().toISOString() });
  await saveState(userId, state);
  console.log(`[push] subscription added for ${userId} (${state.subscriptions.length} device(s))`);
}

export async function removeSubscription(userId: string, endpoint: string): Promise<void> {
  const state = loadState(userId);
  const before = state.subscriptions.length;
  state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
  if (state.subscriptions.length !== before) {
    await saveState(userId, state);
    console.log(`[push] subscription removed for ${userId} (${state.subscriptions.length} left)`);
  }
}

export function getPushSettings(userId: string): PushSettings & { deviceCount: number } {
  const state = loadState(userId);
  return { ...state.settings, deviceCount: state.subscriptions.length };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const validTz = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** A settings patch from the app, validated field by field: unknown keys and wrong types are dropped. */
export function cleanSettingsPatch(raw: unknown, current: PushSettings): PushSettings {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const next: PushSettings = { ...current, perAgent: { ...current.perAgent }, quietHours: { ...current.quietHours } };
  for (const k of ["enabled", "inApp", "sound", "vibration", "urgent"] as const) if (typeof p[k] === "boolean") next[k] = p[k] as boolean;
  if (typeof p.tone === "string" && (TONES as readonly string[]).includes(p.tone)) next.tone = p.tone;
  if (p.perAgent && typeof p.perAgent === "object" && !Array.isArray(p.perAgent))
    for (const [bot, v] of Object.entries(p.perAgent as Record<string, unknown>)) if (/^[a-z0-9_-]{1,40}$/.test(bot) && typeof v === "boolean") next.perAgent[bot] = v;
  const q = p.quietHours && typeof p.quietHours === "object" ? (p.quietHours as Record<string, unknown>) : null;
  if (q) {
    if (typeof q.enabled === "boolean") next.quietHours.enabled = q.enabled;
    const start = typeof q.start === "string" && HHMM.test(q.start) ? q.start : next.quietHours.start;
    const end = typeof q.end === "string" && HHMM.test(q.end) ? q.end : next.quietHours.end;
    if (start !== end) Object.assign(next.quietHours, { start, end });
    if (validTz(q.tz)) next.quietHours.tz = q.tz;
  }
  next.sources = mergeSources(current.sources, p.sources);
  return next;
}

export async function savePushSettings(userId: string, patch: unknown): Promise<PushSettings> {
  const state = loadState(userId);
  state.settings = cleanSettingsPatch(patch, state.settings);
  await saveState(userId, state);
  return state.settings;
}

// ---------- quiet hours ----------

/** Current HH:MM in the given IANA timezone (falls back to server time). */
function nowHHMM(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  }
}

/** True when now falls inside the quiet window. Handles overnight ranges (22:00→07:00). */
export function inQuietHours(settings: PushSettings, nowStr?: string): boolean {
  const q = settings.quietHours;
  if (!q.enabled) return false;
  const now = nowStr ?? nowHHMM(q.tz);
  if (q.start <= q.end) return now >= q.start && now < q.end;
  return now >= q.start || now < q.end; // overnight wrap
}

// ---------- sending ----------

/**
 * Why a push may not go out (null = it may): device delivery off, the agent muted, the app or activity switched
 * off, or quiet hours (a time-sensitive alert passes when the user allowed that).
 */
export function pushVerdict(
  s: PushSettings,
  p: { agent?: string; source?: string; event?: string; timeSensitive?: boolean },
  nowStr?: string,
): "disabled" | "muted" | "source-off" | "quiet-hours" | null {
  if (!s.enabled) return "disabled";
  if (p.agent && s.perAgent[p.agent] === false) return "muted";
  if (p.source && !sourceAllows(s.sources, p.source, p.event ?? "")) return "source-off";
  if (inQuietHours(s, nowStr) && !(p.timeSensitive && s.urgent)) return "quiet-hours";
  return null;
}

export function previewText(event: MessageEvent): string {
  const text = (event.text || "").replace(/\s+/g, " ").trim();
  if (event.contentType === "voice") {
    return text ? `🎙️ ${text.slice(0, 120)}` : "🎙️ Voice note";
  }
  if (event.contentType === "photo") return text ? `📷 ${text.slice(0, 120)}` : "📷 Photo";
  if (event.contentType === "document") {
    if (text) return `📎 ${text.slice(0, 120)}`;
    // A file with no caption says which file — "Message-from-Michael.mp3".
    const files = event.mediaList?.length ? event.mediaList : event.media ? [event.media] : [];
    if (!files.length) return "📎 Document";
    const more = files.length > 1 ? ` +${files.length - 1}` : "";
    return `📎 ${files[0].originalName.slice(0, 100)}${more}`;
  }
  return text.slice(0, 140) || "New message";
}

function titleFor(bot: string): string {
  return bot.charAt(0).toUpperCase() + bot.slice(1);
}

/** Send one payload to every device of a user; prune the dead ones. */
async function deliverToDevices(userId: string, state: UserPushState, payload: string): Promise<number> {
  const dead: string[] = [];
  let sent = 0;
  await Promise.all(
    state.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
          { TTL: 3600, urgency: "high" },
        );
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          dead.push(sub.endpoint);
        } else {
          console.error(`[push] send failed for ${userId} (${status ?? "?"}):`, (err as Error).message);
        }
      }
    }),
  );
  if (dead.length) {
    state.subscriptions = state.subscriptions.filter((sub) => !dead.includes(sub.endpoint));
    await saveState(userId, state);
    console.log(`[push] pruned ${dead.length} dead subscription(s) for ${userId}`);
  }
  return sent;
}

/** Where a tap on a message's notification lands: a review card announcement opens the card, everything else the app. */
export function messagePushUrl(event: Pick<MessageEvent, "meta">): string {
  const item = event.meta?.review?.item;
  return item ? `/?review=${encodeURIComponent(item)}` : "/";
}

/**
 * Push a notification for a newly delivered out-message. Fire-and-forget
 * from the WS delivery path — never throws. The service worker suppresses
 * the banner when the app is focused; settings are enforced here so a
 * muted agent / quiet hours never even reaches the device.
 */
export function sendPushForMessage(event: MessageEvent): void {
  void (async () => {
    try {
      if (event.direction !== "out") return;
      if (!event.userId || event.userId === "unknown") return;
      // A search the user ran themselves is already on their screen.
      if (event.meta?.search && event.meta.search.by === event.userId) return;
      // A studio job's "making 4" card is not news; its decision (the same
      // message, updated) is the push, and it replaces this tag anyway.
      if (event.meta?.studio?.state === "working") return;
      if (!ensureVapid()) return;

      const state = loadState(event.userId);
      if (state.subscriptions.length === 0) return;
      const s = state.settings;
      if (pushVerdict(s, { agent: event.bot, source: "messages", event: "reply" })) return;

      const payload = JSON.stringify({
        title: titleFor(event.bot),
        body: previewText(event),
        bot: event.bot,
        url: messagePushUrl(event),
        tag: event.meta?.messageId || `${event.bot}-${event.timestamp}`,
        silent: !s.sound,
        vibrate: s.vibration ? [100, 50, 100] : [],
        timestamp: Date.parse(event.timestamp) || Date.now(),
      });

      await deliverToDevices(event.userId, state, payload);
    } catch (err) {
      console.error("[push] sendPushForMessage crashed (non-fatal):", err);
    }
  })();
}

export type DirectPushOutcome = "sent" | "unconfigured" | "no-devices" | "disabled" | "muted" | "source-off" | "quiet-hours" | "failed";

/**
 * A push that is not a thread message (review desk: a RED item waiting for
 * a fingerprint, a passkey added). Same rules as message pushes — the user's
 * on/off, the agent mute when `agent` is given, quiet hours — and the
 * outcome is returned so the caller can record why nothing went out.
 */
export async function sendPushToUser(
  userId: string,
  push: { title: string; body: string; url?: string; tag?: string; agent?: string; source?: string; event?: string; timeSensitive?: boolean },
): Promise<DirectPushOutcome> {
  try {
    if (!ensureVapid()) return "unconfigured";
    const state = loadState(userId);
    if (state.subscriptions.length === 0) return "no-devices";
    const s = state.settings;
    const blocked = pushVerdict(s, push);
    if (blocked) return blocked;
    const payload = JSON.stringify({
      title: push.title,
      body: push.body.slice(0, 180),
      bot: push.agent ?? null,
      url: push.url || "/",
      tag: push.tag,
      silent: !s.sound,
      vibrate: s.vibration ? [100, 50, 100] : [],
      timestamp: Date.now(),
    });
    return (await deliverToDevices(userId, state, payload)) > 0 ? "sent" : "failed";
  } catch (err) {
    console.error("[push] sendPushToUser crashed (non-fatal):", err);
    return "failed";
  }
}
