/* ============================================================
   search.ts — inline search, the app half (10/21).

   The browser never holds the search key and never loads a result's
   picture from its own site (the CSP says img-src 'self'): every search
   runs on the gateway, and every picture comes through its proxy by
   (card, index) — never by URL.

   Also the little bus that lets a search card hand a picked picture to the
   composer as staged cargo: the card doesn't own the composer, and the
   composer's cargo is its own state.
   ============================================================ */

import type { SearchCardMeta } from "./types";

export type SearchKind = "web" | "images";

export interface SearchStatus {
  enabled: boolean;
  usage?: { used: number; limit?: number };
  limits?: { perHour: number; cacheHours: number };
}

let statusAt = 0;
let statusP: Promise<SearchStatus> | null = null;

/** Is search on for this gateway? Cached for ten minutes; off on any error. */
export function searchStatus(): Promise<SearchStatus> {
  if (statusP && Date.now() - statusAt < 10 * 60_000) return statusP;
  statusAt = Date.now();
  statusP = fetch("/app/search/status")
    .then((r) => (r.ok ? (r.json() as Promise<SearchStatus>) : { enabled: false }))
    .catch(() => ({ enabled: false }));
  return statusP;
}

/** `/search q` → web, `/images q` (or `/image`, `/img`) → images; else null. */
export function parseSlash(text: string): { kind: SearchKind; q: string } | null {
  const m = /^\/(search|web|images?|img)\s+([\s\S]+)$/i.exec(text.trim());
  if (!m) return null;
  const q = m[2].replace(/\s+/g, " ").trim();
  if (!q) return null;
  return { kind: /^(search|web)$/i.test(m[1]) ? "web" : "images", q };
}

export type RunResult = { ok: true; messageId: string | null } | { ok: false; error: string };

/** Run a search; the gateway posts the card into this chat over the socket. */
export async function runSearch(bot: string, kind: SearchKind, q: string): Promise<RunResult> {
  try {
    const res = await fetch("/app/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot, kind, q }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; messageId?: string | null };
    if (!res.ok) return { ok: false, error: body.error || `Search failed (${res.status})` };
    return { ok: true, messageId: body.messageId ?? null };
  } catch {
    return { ok: false, error: "No connection — search didn't run" };
  }
}

/** A card's picture, through the gateway. v: thumb | full | icon (a web row's favicon). */
export function pictureSrc(bot: string, messageId: string, index: number, v: "thumb" | "full" | "icon"): string {
  const qs = new URLSearchParams({ bot, m: messageId, i: String(index), v });
  return `/app/search/img?${qs}`;
}

export interface AttachedPicture {
  id: string;
  originalName: string;
  mime: string;
  size: number;
}

/** Save a card's picture into the user's files (save-only) → its media. */
export async function attachPicture(bot: string, messageId: string, index: number): Promise<{ ok: true; media: AttachedPicture } | { ok: false; error: string }> {
  try {
    const res = await fetch("/app/search/attach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot, m: messageId, i: index }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; media?: AttachedPicture };
    if (!res.ok || !body.media?.id) return { ok: false, error: body.error || "Couldn't attach the picture" };
    return { ok: true, media: body.media };
  } catch {
    return { ok: false, error: "No connection" };
  }
}

/** "37 this month" / "37 of 250 this month" — the month's search count. */
export function usageLine(card: Pick<SearchCardMeta, "usage">): string {
  const u = card.usage;
  if (!u) return "";
  return u.limit ? `${u.used} of ${u.limit} this month` : `${u.used} this month`;
}

// ── Card → composer: a picked picture becomes staged cargo ──────────────

export interface StageRequest {
  bot: string;
  mediaId: string;
  name: string;
  mime: string;
  size: number;
  /** Shown on the composer tile while it waits to be sent. */
  previewUrl: string;
}

type StageListener = (req: StageRequest) => boolean;
const listeners = new Set<StageListener>();

/** The composer listens; returns an unsubscribe. A listener returns true if it took the picture. */
export function onStageRequest(fn: StageListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Hand a picture to the open composer for `bot`. False when none took it. */
export function requestStage(req: StageRequest): boolean {
  let taken = false;
  for (const fn of listeners) taken = fn(req) || taken;
  return taken;
}
