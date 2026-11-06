/**
 * The chat's media catalog — what the app's Media / Files / Links panel lists.
 *
 * Built from the whole known thread (the live 500-message window plus the
 * archive that messages age into), both directions, newest first, and paged
 * by an opaque cursor so the panel can scroll back through all of it.
 *
 *   media  images + video
 *   files  documents + audio FILES (voice notes are not files — excluded)
 *   links  every http(s) URL in a message's text, with its sender and date
 *
 * Pure: the caller supplies the messages, so it is tested without a store.
 */
import type { MediaRef } from "../media-store.js";
import type { MessageEvent } from "../websocket.js";

export type CatalogCategory = "media" | "files" | "links";
export const CATEGORIES: CatalogCategory[] = ["media", "files", "links"];

export interface CatalogItem {
  /** Stable, unique within the catalog; also the cursor's tiebreak. */
  key: string;
  kind: "image" | "video" | "audio" | "document" | "link";
  bot: string;
  /** The message it came from — "Show in chat" scrolls to it. */
  messageId: string | null;
  timestamp: string;
  direction: "in" | "out";
  /** Who sent it: the user's name for "in", the agent for "out". */
  sender: string;
  media?: Omit<MediaRef, "path">;
  url?: string;
  title?: string;
  /** The message text around a link, trimmed — context in the Links list. */
  snippet?: string;
}

const LINK_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/** URLs in text, in order, de-duplicated; trailing punctuation dropped. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of (text || "").matchAll(LINK_RE)) {
    const url = m[0].replace(/[.,;:!?*_]+$/, "");
    if (url.length < 10 || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function linkTitle(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function snippetAround(text: string, url: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.indexOf(url);
  if (flat.length <= 160) return flat;
  const start = Math.max(0, at - 60);
  const piece = flat.slice(start, start + 160);
  return `${start > 0 ? "…" : ""}${piece}${start + 160 < flat.length ? "…" : ""}`;
}

/** A message's media, in send order (mediaList, else the single media). */
function mediaOf(msg: MessageEvent): MediaRef[] {
  if (Array.isArray(msg.mediaList) && msg.mediaList.length) return msg.mediaList;
  return msg.media ? [msg.media] : [];
}

function categoryOf(type: string): CatalogCategory | null {
  if (type === "image" || type === "video") return "media";
  if (type === "document" || type === "audio") return "files";
  return null; // voice notes and anything unknown
}

function publicMedia(m: MediaRef): Omit<MediaRef, "path"> {
  // The server path never leaves the gateway through the catalog.
  const { path: _path, ...rest } = m;
  return rest;
}

function senderOf(msg: MessageEvent, botLabel: (bot: string) => string): string {
  if (msg.direction === "out") return botLabel(msg.bot);
  return msg.senderName && msg.senderName !== "unknown" ? msg.senderName : "You";
}

/** Every catalog item for one category, newest first. */
export function buildCatalog(
  messages: MessageEvent[],
  category: CatalogCategory,
  botLabel: (bot: string) => string = (b) => b.charAt(0).toUpperCase() + b.slice(1),
): CatalogItem[] {
  const items: CatalogItem[] = [];
  for (const msg of messages) {
    if (msg.meta?.voiceSession) continue; // a call card is not a message body
    const base = {
      bot: msg.bot,
      messageId: msg.meta?.messageId ?? null,
      timestamp: msg.timestamp,
      direction: msg.direction,
      sender: senderOf(msg, botLabel),
    };
    const anchor = msg.meta?.messageId ?? `${msg.bot}@${msg.timestamp}`;
    if (category === "links") {
      // A voice note's text is its transcript — a URL spoken aloud is not a link.
      if (msg.media?.type === "voice" && !msg.mediaList) continue;
      extractLinks(msg.text || "").forEach((url, i) => {
        const pos = String(999 - i).padStart(3, "0");
        items.push({ ...base, key: `${anchor}|${pos}|${url}`, kind: "link", url, title: linkTitle(url), snippet: snippetAround(msg.text || "", url) });
      });
      continue;
    }
    mediaOf(msg).forEach((m, i) => {
      if (categoryOf(m.type) !== category) return;
      // Newest-first sorts keys descending; the inverted position keeps one
      // message's files in the order they were sent.
      const pos = String(999 - i).padStart(3, "0");
      items.push({ ...base, key: `${anchor}|${pos}|${m.id}`, kind: m.type as CatalogItem["kind"], media: publicMedia(m) });
    });
  }
  // Newest first; ties broken by key so the order (and the cursor) is total.
  items.sort((a, b) => (a.timestamp === b.timestamp ? (a.key < b.key ? 1 : a.key > b.key ? -1 : 0) : a.timestamp < b.timestamp ? 1 : -1));
  return items;
}

export function encodeCursor(item: Pick<CatalogItem, "timestamp" | "key">): string {
  return Buffer.from(JSON.stringify([item.timestamp, item.key]), "utf-8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null): { timestamp: string; key: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { timestamp: parsed[0], key: parsed[1] };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * One page, strictly AFTER the cursor in newest-first order. Position is by
 * value, not index, so items arriving at the top while the owner scrolls never
 * shift or repeat what the next page returns.
 */
export function pageCatalog(
  items: CatalogItem[],
  cursor: string | undefined | null,
  limit: number,
): { items: CatalogItem[]; nextCursor: string | null } {
  const after = decodeCursor(cursor);
  let start = 0;
  if (after) {
    start = items.findIndex(
      (i) => i.timestamp < after.timestamp || (i.timestamp === after.timestamp && i.key < after.key),
    );
    if (start < 0) return { items: [], nextCursor: null };
  }
  const page = items.slice(start, start + limit);
  const more = start + limit < items.length;
  return { items: page, nextCursor: more && page.length ? encodeCursor(page[page.length - 1]) : null };
}

/** Messages around one message id (for "Show in chat" past the loaded window). */
export function contextAround(
  messages: MessageEvent[],
  messageId: string,
  span: number,
): MessageEvent[] | null {
  const at = messages.findIndex((m) => m.meta?.messageId === messageId);
  if (at < 0) return null;
  return messages.slice(Math.max(0, at - span), at + span + 1);
}
