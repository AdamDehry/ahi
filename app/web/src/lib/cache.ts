import type { LocalMessage, UserPublic } from "./types";

// Instant-shell cache: the last-known user + tail of each thread persisted
// to localStorage so a fresh load paints real content synchronously,
// before any network round-trip. Reconciled (deduped) when the WS history
// frame arrives.

const KEY = "ahi-web-snapshot-v1";
const PER_BOT = 50;
const DEBOUNCE_MS = 500;

export interface Snapshot {
  user: UserPublic;
  threads: Record<string, LocalMessage[]>;
  activeBot?: string | null;
  /** Unsent composer text per bot — a draft survives a reload. */
  drafts?: Record<string, string>;
  /** Build questions quoted into those drafts (Answer in thread) — the link survives with the draft. */
  answerLinks?: Record<string, AnswerLink[]>;
}

/** One build question quoted into a composer: the run, the needs_operator record, and the quoted block. */
export interface AnswerLink {
  build: string;
  record: string;
  quote: string;
}

export function loadSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Snapshot;
    if (!parsed || !parsed.user || typeof parsed.threads !== "object") return null;
    // The builder was renamed: a snapshot saved before the rename still opens on, and caches, its old id.
    if (parsed.activeBot === "tzali") parsed.activeBot = "zali";
    if (parsed.threads.tzali) {
      parsed.threads.zali ??= parsed.threads.tzali;
      delete parsed.threads.tzali;
    }
    // Never resurrect pending/failed local sends from a previous session.
    for (const bot of Object.keys(parsed.threads)) {
      parsed.threads[bot] = (parsed.threads[bot] ?? []).filter((m) => !m.pending && !m.failed);
    }
    return parsed;
  } catch {
    return null;
  }
}

type PersistableState = {
  user: UserPublic | null;
  threads: Record<string, LocalMessage[]>;
  activeBot: string | null;
  drafts: Record<string, string>;
  answerLinks?: Record<string, AnswerLink[]>;
};

let timer: ReturnType<typeof setTimeout> | null = null;
let latest: PersistableState | null = null;

export function saveSnapshot(nextState: PersistableState): void {
  latest = nextState; // always keep the newest; the timer flushes it
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const state = latest;
    if (!state) return;
    try {
      if (!state.user) {
        localStorage.removeItem(KEY);
        return;
      }
      const threads: Record<string, LocalMessage[]> = {};
      for (const [bot, msgs] of Object.entries(state.threads)) {
        threads[bot] = msgs.filter((m) => !m.pending && !m.failed).slice(-PER_BOT);
      }
      const drafts: Record<string, string> = {};
      for (const [bot, text] of Object.entries(state.drafts)) {
        if (text.trim()) drafts[bot] = text;
      }
      const answerLinks: Record<string, AnswerLink[]> = {};
      for (const [bot, links] of Object.entries(state.answerLinks ?? {})) {
        if (links.length && drafts[bot]) answerLinks[bot] = links;
      }
      const snap: Snapshot = { user: state.user, threads, activeBot: state.activeBot, drafts, answerLinks };
      localStorage.setItem(KEY, JSON.stringify(snap));
    } catch {
      /* quota or private mode — cache is best-effort */
    }
  }, DEBOUNCE_MS);
}
