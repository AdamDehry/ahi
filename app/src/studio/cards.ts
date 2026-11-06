/**
 * Studio cards: "this came up, your call", with the options
 * inline — in the chat, and in the thread behind a call.
 *
 * A card is an ordinary out-message carrying `meta.studio` (presence is the
 * discriminator, exactly like the search card and the call log). Its `text`
 * is the true plain-text twin — "Your call: which cabin? A) … B) …" — so
 * Telegram, retrieval and the agent's thread tail read something sensible.
 *
 * One job, one card, two states:
 *   working   posted the moment the job starts ("Nano Banana · making 4")
 *   decision  the SAME message, updated in place when the job lands
 *   failed    the same message, when it did not
 * A decision Avi puts up himself (`[[studio_decision: …]]`) is born decided.
 *
 * The pictures are the user's own media: each option file is copied into
 * the user's media root and registered (source "agent"), so the app's
 * existing /ui/media/:id route — per-user access check, thumbnails, video
 * range requests, download — serves them, and "attach" is just staging that
 * media id in the composer. No new file server, no new path exposure.
 */
import { copyFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import type { MessageEvent } from "../websocket.js";
import type { MediaRef } from "../media-store.js";
import { VIDEO_EXT } from "./engines.js";
import type { StudioJob } from "./jobs.js";

export const OPTION_KEYS = ["A", "B", "C", "D"] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];

export interface StudioOption {
  key: OptionKey;
  label?: string;
  media: MediaRef;
}

export interface StudioCardMeta {
  state: "working" | "decision" | "failed";
  /** The question ("Which cabin?"). */
  ask: string;
  options: StudioOption[];
  /** How many more media files the folder holds beyond the options. */
  more?: number;
  /** The folder on the server, for "open the folder" (shown, copyable). */
  folder?: string;
  jobId?: string;
  /** Plain engine name ("Nano Banana"). */
  engine?: string;
  /** How many the job is making (working state). */
  n?: number;
  guide?: string;
  step?: string;
  note?: string;
  error?: string;
  by: string;
  at: string;
  startedAt?: string;
}

export interface StudioCardUser {
  userId: string;
  name: string;
  telegramChatId: number | null;
}

/** Copies a file into the user's media and registers it. Injected (tests use a fake). */
export type StoreMedia = (userId: string, bot: string, path: string) => Promise<MediaRef>;

/** Production StoreMedia: same layout and record as chat-files' agent sends. */
export function mediaStorer(deps: {
  mediaDir: (userId: string, day: string) => string;
  ensureDir: (dir: string) => void;
  register: (input: { userId: string; bot: string; path: string; name: string; video: boolean }) => Promise<MediaRef>;
  now?: () => Date;
}): StoreMedia {
  return async (userId, bot, path) => {
    const st = await stat(path);
    if (!st.isFile()) throw new Error(`not a file: ${path}`);
    if (st.size > 200 * 1024 * 1024) throw new Error(`over 200 MB: ${basename(path)}`);
    const now = (deps.now ?? (() => new Date()))();
    const dir = join(deps.mediaDir(userId, now.toISOString().slice(0, 10)), "studio");
    deps.ensureDir(dir);
    const name = basename(path).replace(/[^\w.\-]+/g, "_").slice(-120) || "option";
    const stored = join(dir, `${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}-${name}`);
    await copyFile(path, stored);
    return deps.register({ userId, bot, path: stored, name, video: VIDEO_EXT.has(extname(path).toLowerCase()) });
  };
}

/** Turn up to four files into lettered options. Files that fail to store are skipped (logged). */
export async function buildOptions(
  userId: string,
  bot: string,
  files: Array<{ path: string; label?: string }>,
  store: StoreMedia,
  log: (l: string) => void = (l) => console.warn(`[studio] ${l}`),
): Promise<StudioOption[]> {
  const out: StudioOption[] = [];
  for (const f of files) {
    if (out.length >= OPTION_KEYS.length) break;
    try {
      const media = await store(userId, bot, f.path);
      out.push({ key: OPTION_KEYS[out.length], ...(f.label ? { label: f.label } : {}), media });
    } catch (err) {
      log(`option not stored (${(err as Error).message})`);
    }
  }
  return out;
}

/** The plain-text twin every non-app reader sees. */
export function cardText(card: StudioCardMeta, byName: string): string {
  if (card.state === "working") return `${byName} is making ${card.n ?? ""} option${card.n === 1 ? "" : "s"}${card.engine ? ` with ${card.engine}` : ""}${card.ask ? `: ${card.ask}` : ""}`.replace(/\s+/g, " ").trim();
  if (card.state === "failed") return `${byName}'s ${card.engine ?? "studio"} job didn't come back${card.error ? `: ${card.error}` : ""}.`;
  const opts = card.options.map((o) => `${o.key}) ${o.label || (o.media.type === "video" ? "clip" : "picture")}`).join("  ");
  return `Your call: ${card.ask}${opts ? `\n${opts}` : ""}${card.more ? `\n(+${card.more} more in the folder)` : ""}`;
}

export function cardEvent(opts: { bot: string; user: StudioCardUser; byName: string; card: StudioCardMeta; messageId?: string }): MessageEvent {
  return {
    type: "message",
    bot: opts.bot,
    direction: "out",
    contentType: opts.card.options.length ? "photo" : "text",
    text: cardText(opts.card, opts.byName),
    timestamp: opts.card.at,
    chatId: opts.user.telegramChatId ?? 0,
    userId: opts.user.userId,
    senderName: opts.user.name,
    source: "app",
    meta: { studio: opts.card, ...(opts.messageId ? { messageId: opts.messageId } : {}) },
  };
}

/** The working card for a job that just started. */
export function workingCard(job: StudioJob, engineLabel: string, now = new Date()): StudioCardMeta {
  return {
    state: "working",
    ask: job.ask || "",
    options: [],
    jobId: job.id,
    engine: engineLabel,
    n: job.n,
    ...(job.guide ? { guide: job.guide } : {}),
    ...(job.step ? { step: job.step } : {}),
    folder: job.outDir,
    by: job.bot,
    at: now.toISOString(),
    startedAt: job.startedAt,
  };
}

/** Find a studio card in a thread by its message id. */
export function findStudioCard(thread: MessageEvent[], messageId: string): StudioCardMeta | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].meta?.messageId === messageId) return thread[i].meta?.studio ?? null;
  }
  return null;
}

/** The newest `n` decision cards, newest (by decision time) first, each with its first answer. */
export function recentDecisions(thread: MessageEvent[], n = 3): Array<{ messageId: string; card: StudioCardMeta; answered: string | null }> {
  const all = thread
    .filter((m) => m.meta?.studio?.state === "decision" && m.meta?.messageId)
    .sort((a, b) => (a.meta!.studio!.at < b.meta!.studio!.at ? 1 : -1));
  // Which card a reply answers: a tap names its card ("Which cabin? → B…");
  // anything else answers the newest decision there was when he said it.
  const answers = (reply: MessageEvent, card: StudioCardMeta): boolean => {
    const tap = /^(.*?) → [A-D]\b/.exec(reply.text.trim());
    if (tap) return tap[1].trim() === card.ask.trim();
    const current = all.find((m) => m.meta!.studio!.at < reply.timestamp);
    return current?.meta?.studio === card;
  };
  return all.slice(0, n).map((m) => {
    const card = m.meta!.studio!;
    const reply = thread.find((x) => x.direction === "in" && x.text?.trim() && x.timestamp > card.at && answers(x, card));
    return { messageId: m.meta!.messageId!, card, answered: reply ? reply.text.trim().slice(0, 120) : null };
  });
}

/** The latest DECISION card in a thread, with its id and the first answer after it. */
export function latestDecision(thread: MessageEvent[]): { messageId: string; card: StudioCardMeta; answered: string | null } | null {
  // By when it DECIDED, not where it sits: a job's card keeps the position of
  // its start, so a slow job that lands last can sit above a faster one.
  let best = -1;
  for (let i = 0; i < thread.length; i++) {
    const card = thread[i].meta?.studio;
    if (card?.state !== "decision" || !thread[i].meta?.messageId) continue;
    if (best < 0 || card.at >= thread[best].meta!.studio!.at) best = i;
  }
  if (best < 0) return null;
  const card = thread[best].meta!.studio!;
  // The first thing he said after it decided is, most likely, the answer
  // (what he said while the job ran is not).
  const reply = thread.find((m) => m.direction === "in" && m.text?.trim() && m.timestamp > card.at);
  return { messageId: thread[best].meta!.messageId!, card, answered: reply ? reply.text.trim().slice(0, 120) : null };
}
