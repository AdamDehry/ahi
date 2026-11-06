import type { SentAnswer } from "./answers";
import type { Bill, BillSettings, Clip, CostEntry, FileEntry, McFile, McL2Entry, McL3Detail, MessageEvent, UserPublic } from "./types";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** GET JSON, never from the HTTP cache; null on any failure. */
export async function getFresh<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

// All calls are same-origin: in dev, Vite proxies /ui + /app to the gateway
// (vite.config.ts), so the ahi_token cookie set by /ui/login flows on every
// request including the WS upgrade.

export async function login(token: string): Promise<UserPublic | null> {
  const res = await fetch("/ui/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  // A refused token is null; anything else that fails (server down, tunnel error) throws, so the
  // sign-in screen can tell "unavailable" apart from "not recognized".
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`sign-in unavailable (${res.status})`);
  const body = await res.json().catch(() => null);
  return body?.user ?? null;
}

export async function fetchSession(): Promise<UserPublic | null> {
  try {
    const res = await fetch("/ui/session");
    if (!res.ok) return null;
    const body = await res.json();
    return body.user ?? null;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  await fetch("/ui/logout", { method: "POST" }).catch(() => {});
}

/** Deepen one thread's history. The WS `history` frame only carries the
 *  last 100 messages across ALL bots — this backfills a single bot when
 *  its thread is opened. */
export async function fetchMessages(bot: string, limit = 200): Promise<MessageEvent[]> {
  try {
    const res = await fetch(`/ui/messages?bot=${encodeURIComponent(bot)}&limit=${limit}`);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

export type SendResult =
  | { ok: true }
  /** The server answered and said no (403/404/...) — retrying without a
   *  change won't help; surface tap-to-retry. */
  | { ok: false; kind: "rejected"; error: string }
  /** The request never got an answer (offline, tunnel blip) — keep the
   *  message queued and flush on reconnect. */
  | { ok: false; kind: "network" };

// ── Tool pages (contract: AUDIT.md §2.1 — all cookie-authed) ─────────

export async function fetchMc(): Promise<McFile[]> {
  const body = await getJson<{ files?: McFile[] }>("/ui/mc");
  return body?.files ?? [];
}

export async function fetchClips(): Promise<Clip[]> {
  return (await getJson<Clip[]>("/ui/clips")) ?? [];
}

export async function saveClip(text: string): Promise<boolean> {
  try {
    const res = await fetch("/ui/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteClip(id: string): Promise<void> {
  await fetch(`/ui/clips/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

export async function fetchFiles(): Promise<FileEntry[]> {
  return (await getJson<FileEntry[]>("/ui/files")) ?? [];
}

export async function uploadFile(file: File, category?: string): Promise<{ ok: boolean; error?: string }> {
  const form = new FormData();
  form.append("file", file);
  if (category) form.append("category", category);
  try {
    const res = await fetch("/ui/upload", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function deleteFile(name: string): Promise<void> {
  await fetch(`/ui/files/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {});
}

// ── Step 3d: file categories + move (gateway endpoints on this branch;
// live after the cutover deploy — the dev sidecar bridge is gone) ─────

export async function fetchFileCategories(): Promise<string[]> {
  const body = await getJson<{ categories?: string[] }>("/ui/file-categories");
  return body?.categories ?? ["general"];
}

async function jsonOp(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (parsed as { error?: string }).error || `HTTP ${res.status}` };
    return { ok: true, ...parsed };
  } catch {
    return { ok: false, error: "network" };
  }
}

export function createFileCategory(name: string) {
  return jsonOp("/ui/file-categories", "POST", { name });
}

export function renameFileCategory(from: string, to: string) {
  return jsonOp(`/ui/file-categories/${encodeURIComponent(from)}`, "PUT", { name: to });
}

export function deleteFileCategory(name: string) {
  return jsonOp(`/ui/file-categories/${encodeURIComponent(name)}`, "DELETE");
}

export function moveFileTo(name: string, category: string) {
  return jsonOp("/ui/files-move", "POST", { name, category });
}

export interface CostCategoryInfo {
  key: string;
  label: string;
  builtin: boolean;
}

export async function fetchCostCategories(): Promise<CostCategoryInfo[]> {
  const body = await getJson<{ categories?: CostCategoryInfo[] }>("/ui/cost-categories");
  return body?.categories ?? [];
}

export function createCostCategoryApi(label: string) {
  return jsonOp("/ui/cost-categories", "POST", { label });
}

export function renameCostCategoryApi(key: string, label: string) {
  return jsonOp(`/ui/cost-categories/${encodeURIComponent(key)}`, "PUT", { label });
}

export function deleteCostCategoryApi(key: string) {
  return jsonOp(`/ui/cost-categories/${encodeURIComponent(key)}`, "DELETE");
}

export async function fetchCosts(): Promise<CostEntry[]> {
  const body = await getJson<{ entries?: CostEntry[] }>("/ui/costs");
  return body?.entries ?? [];
}

export type CostPayload = Omit<CostEntry, "id">;

async function sendJson(url: string, method: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function createCost(payload: CostPayload): Promise<boolean> {
  return sendJson("/ui/costs", "POST", payload);
}

export function updateCost(id: string, payload: CostPayload): Promise<boolean> {
  return sendJson(`/ui/costs/${encodeURIComponent(id)}`, "PUT", payload);
}

export async function deleteCost(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/ui/costs/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Voice-note upload result.
 *
 * `kind` is what the outbox needs and a boolean could never carry: whether
 * the gateway REFUSED this audio (and will refuse it identically forever) or
 * simply never got it. Mirrors SendResult's vocabulary.
 */
export type VoiceUploadResult =
  | { ok: true; transcript?: string }
  | { ok: false; kind: "rejected" | "network"; status?: number; error: string };

/**
 * A status the same request could survive next time. 401 belongs here: the
 * session expired, the audio is fine, and the note must wait for a login
 * rather than be marked as refused. 507 is the gateway's disk-full reply,
 * whose own error text says "Resend after cleanup".
 */
function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

/** Send recorded AUDIO as a voice note via the DEPLOYED /ui/voice-send
 *  (the pre-rebuild app's canonical path, live today): the gateway
 *  transcodes to ogg, saves playable voice media, transcribes, then
 *  BROADCASTS the in-message (media + clientMessageId echo) and runs
 *  the agent turn with a voice reply. The note arrives over the WS.
 *
 *  Call this through lib/voice-outbox.ts, not directly — the outbox is what
 *  makes a failure survivable. The one exception is the Recorder's fail-open
 *  path, for a device where the queue cannot be written at all. */
export async function uploadVoiceNote(
  bot: string,
  blob: Blob,
  durationSec: number,
  clientMessageId: string,
): Promise<VoiceUploadResult> {
  const form = new FormData();
  form.append("audio", blob, "voice-note.webm");
  form.append("bot", bot);
  form.append("durationSec", String(durationSec));
  form.append("clientMessageId", clientMessageId);
  try {
    const res = await fetch("/ui/voice-send", { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = (body as { error?: string }).error || `HTTP ${res.status}`;
      return {
        ok: false,
        kind: isRetryableStatus(res.status) ? "network" : "rejected",
        status: res.status,
        error,
      };
    }
    return { ok: true, transcript: (body as { transcript?: string }).transcript };
  } catch {
    return { ok: false, kind: "network", error: "network" };
  }
}

/** Composer attach (Step 3d3 #3): the DEPLOYED /ui/upload with a `bot`
 *  field registers the file as media, broadcasts the media message and
 *  invokes the agent on it (image analysis for images). */
export async function attachFile(bot: string, file: File): Promise<{ ok: boolean; error?: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("bot", bot);
  try {
    const res = await fetch("/ui/upload", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: (err as { error?: string }).error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "network" };
  }
}

/** mc-structured (deployed): the Fitness card's entries. Admin-only. */
export async function fetchFitnessEntries(): Promise<McL2Entry[]> {
  const body = await getJson<{ cards?: McL2Entry[] }>("/app/mc/cards?level=2&type=fitness");
  return body?.cards ?? [];
}

/** L3: one fitness day's full routine (markdown in `spec`). */
export function fetchFitnessDay(id: string): Promise<McL3Detail | null> {
  return getJson<McL3Detail>(`/app/mc/card?l1=fitness&id=${encodeURIComponent(id)}`);
}

export interface BotSettings {
  name: string;
  model: string;
  voice: string;
}

export interface SettingsPayload {
  bots: BotSettings[];
  availableModels: string[];
  // `bots` limits a group to specific agents (e.g. ElevenLabs is
  // michael-only); absent = available to every bot.
  voiceGroups: Array<{ label: string; voices: string[]; bots?: string[] }>;
}

export async function fetchSettings(): Promise<SettingsPayload | null> {
  return getJson<SettingsPayload>("/ui/settings");
}

export async function saveBotSetting(bot: string, patch: { model?: string; voice?: string }): Promise<boolean> {
  try {
    const res = await fetch("/ui/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot, ...patch }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface UpdatesPayload {
  configured: boolean;
  current: { version: string; skillsRelease: string | null };
  latest?: { tag: string; version: string; name: string; url: string; publishedAt: string; notes: string };
  appUpdate?: boolean;
  skills?: Array<{ name: string; category: string; version: string; from: string | null }>;
  error?: string;
}

/** Owner only: this install's version against the latest AHI release, and which skills are newer. */
export async function fetchUpdates(refresh = false): Promise<UpdatesPayload | null> {
  return getFresh<UpdatesPayload>(refresh ? "/ui/updates?refresh=1" : "/ui/updates");
}

export function installSkillUpdates() {
  return jsonOp("/ui/updates/skills", "POST") as Promise<{ ok: boolean; error?: string; installed?: string[]; keptOwn?: string[] }>;
}

export interface HealthPayload {
  bots: Array<{ name: string; model: string; voice: string; status: string; lastMessage: string | null }>;
  uptime: number;
}

export async function fetchHealth(): Promise<HealthPayload | null> {
  return getJson<HealthPayload>("/ui/health");
}

/** Send a text message. /app/send (NOT /ui/send) so the turn is tagged
 *  source:"app" and included in the retrieval corpus — see AUDIT.md §2.1.
 *  `clientMessageId` is echoed back as meta.clientMessageId on the WS
 *  broadcast, reconciling the optimistic bubble precisely. */
export async function sendMessage(
  bot: string,
  text: string,
  clientMessageId: string,
  attachmentIds?: string[],
  answers?: SentAnswer[],
): Promise<SendResult> {
  try {
    const res = await fetch("/app/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `attachments` / `answers` are omitted entirely when empty, so a plain
      // text send is byte-identical to what it was before either existed.
      body: JSON.stringify({
        bot,
        text,
        clientMessageId,
        ...(attachmentIds?.length ? { attachments: attachmentIds } : {}),
        ...(answers?.length ? { answers } : {}),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, kind: "rejected", error: err.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, kind: "network" };
  }
}

export async function stopMessage(bot: string): Promise<boolean> {
  try {
    const res = await fetch("/app/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function steerMessage(bot: string): Promise<boolean> {
  try {
    const res = await fetch("/app/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ── Bills: the signed-in user's own (gateway scopes by the session) ── */

export async function fetchBills(): Promise<{ bills: Bill[]; settings: BillSettings } | null> {
  return getJson<{ bills: Bill[]; settings: BillSettings }>("/app/bills");
}

export type BillPayload = Partial<Omit<Bill, "id" | "createdAt" | "updatedAt" | "updatedBy">>;

async function billJson(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: j.error || `Failed (${res.status})` };
  } catch {
    return { ok: false, error: "Offline — try again" };
  }
}

export const createBill = (b: BillPayload) => billJson("/app/bills", "POST", b);
export const updateBill = (id: string, b: BillPayload) => billJson(`/app/bills/${encodeURIComponent(id)}`, "PUT", b);
export const deleteBill = (id: string) => billJson(`/app/bills/${encodeURIComponent(id)}`, "DELETE");
export const saveBillSettings = (s: Partial<BillSettings>) => billJson("/app/bills/settings", "PUT", s);
