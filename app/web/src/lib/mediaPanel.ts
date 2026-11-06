/**
 * Media / Files / Links panel — data side.
 *
 * Pages GET /app/media by cursor (newest first, both directions, the whole
 * known thread including history older than the app has loaded), and does
 * "Show in chat": make sure the message is in the local thread — deepen the
 * thread, then fetch the messages around it if it is older still — then ask
 * the thread to scroll to it.
 */
import type { MediaRef, MessageEvent } from "./types";
import { actions, getState } from "../store";

export type PanelTab = "media" | "files" | "links";

export interface PanelItem {
  key: string;
  kind: "image" | "video" | "audio" | "document" | "link";
  bot: string;
  messageId: string | null;
  timestamp: string;
  direction: "in" | "out";
  sender: string;
  media?: Omit<MediaRef, "path"> & { path?: string };
  url?: string;
  title?: string;
  snippet?: string;
}

export interface PanelPage {
  items: PanelItem[];
  nextCursor: string | null;
}

export async function fetchPanelPage(
  tab: PanelTab,
  bot: string | "all",
  cursor: string | null,
  limit = 40,
  fetchImpl: typeof fetch = fetch,
): Promise<PanelPage> {
  const qs = new URLSearchParams({ category: tab, bot, limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  const res = await fetchImpl(`/app/media?${qs}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`media ${res.status}`);
  const body = (await res.json()) as Partial<PanelPage>;
  return { items: Array.isArray(body.items) ? body.items : [], nextCursor: body.nextCursor ?? null };
}

/** A panel item as the MediaRef the existing viewer / players take. */
export function asMediaRef(item: PanelItem): MediaRef | null {
  if (!item.media) return null;
  return { path: "", ...item.media } as MediaRef;
}

function hasMessage(bot: string, messageId: string): boolean {
  return (getState().threads[bot] ?? []).some((m) => m.meta?.messageId === messageId);
}

/**
 * Bring one message into the local thread. Returns false when the server
 * doesn't have it either (deleted, or never stored with an id).
 */
export async function ensureLoaded(bot: string, messageId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (hasMessage(bot, messageId)) return true;
  // 1) the whole live window (the app normally holds the newest 200)
  try {
    const res = await fetchImpl(`/ui/messages?bot=${encodeURIComponent(bot)}&limit=500`, { credentials: "same-origin" });
    if (res.ok) {
      const list = (await res.json()) as MessageEvent[];
      if (Array.isArray(list)) actions.mergeMessages(list);
    }
  } catch {
    /* fall through to the context fetch */
  }
  if (hasMessage(bot, messageId)) return true;
  // 2) older than the live window: the messages around it, from the archive
  try {
    const qs = new URLSearchParams({ bot, id: messageId, span: "25" });
    const res = await fetchImpl(`/app/media/context?${qs}`, { credentials: "same-origin" });
    if (!res.ok) return false;
    const body = (await res.json()) as { messages?: MessageEvent[] };
    if (Array.isArray(body.messages)) actions.mergeMessages(body.messages);
  } catch {
    return false;
  }
  return hasMessage(bot, messageId);
}

/** "Show in chat". Closes the panel on a phone (it covers the thread). */
export async function showInChat(item: PanelItem, closePanel: boolean, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!item.messageId) return false;
  const ok = await ensureLoaded(item.bot, item.messageId, fetchImpl);
  if (ok) actions.revealMessage(item.bot, item.messageId, closePanel);
  return ok;
}

/** "Oct 13" this year, "Oct 13, 2025" otherwise; in the user's own clock. */
export function shortDate(ts: string, now = new Date()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}
