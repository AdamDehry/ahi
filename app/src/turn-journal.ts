/**
 * turn-journal.ts — in-flight markers for chat turns ("no reply
 * is ever lost to a restart").
 *
 * When a chat turn for a tracked user starts (web app, Telegram, voice note),
 * the gateway writes one small marker file; when the reply has been persisted
 * to the thread, it removes it. A marker still on disk at boot is a turn a
 * restart killed — turn-resume.ts picks it up.
 *
 * One file per marker (atomic tmp+rename), written only by the gateway
 * process — never by an outside script (the threadCache whole-file-rewrite
 * race is exactly why). A per-file layout also means two concurrent turns
 * never rewrite each other's state.
 *
 * During shutdown nothing is cleared: on a restart systemd SIGTERMs the whole
 * cgroup, so a dying turn can "finish" with a cut-short reply a moment before
 * the gateway exits. That reply must not count as delivered.
 *
 * Config: TURN_RESUME=false disables tracking (and so resuming);
 * TURN_RESUME_USERS = comma list of user ids to track (default: the owner; "*" = all).
 */
import { ownerUserId } from "./users.js";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { resolve } from "path";
import { atomicWriteJson, gatewayStateRoot } from "./multi-user-paths.js";

/** Where the reply goes — the same surface the original turn would have used. */
export type TurnSurface =
  /** PWA /app/send — reply into the app thread. */
  | "app"
  /** PWA voice note / dashboard upload — app thread via the dashboard reply path (voice-aware, mirrors to Telegram). */
  | "app-reply"
  /** Dashboard Quick Send — app thread + Telegram copy. */
  | "ui-send"
  /** Telegram chat — Telegram + the app thread. */
  | "telegram";

export interface InflightTurn {
  /** Idempotency key: message id + started-at. */
  key: string;
  bot: string;
  userId: string;
  chatId: number;
  surface: TurnSurface;
  inputWasVoice: boolean;
  /** meta.messageId of the owner's message in the store (null if unknown). */
  messageId: string | null;
  /** The exact text the agent was given. */
  prompt: string;
  /** the owner's words as they appear in the thread (for the stale notice). */
  said: string;
  startedAt: string;
  resume: {
    /** Resume runs started (each persisted BEFORE the run). */
    attempts: number;
    /** When a boot first found this marker orphaned. */
    orphanedAt: string | null;
    /** Not before this instant (Shabbat/Yom Tov deferral, retry backoff). */
    notBefore: string | null;
    waiting: string | null;
  };
}

export type JournalOutcome = "resumed" | "stale-notice" | "gave-up" | "dropped";

export interface JournalLedgerEntry {
  key: string;
  outcome: JournalOutcome;
  at: string;
  note?: string;
}

const LEDGER_FILE = "_resumed.json";
const LEDGER_CAP = 300;

function fileFor(key: string): string {
  return `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`;
}

export class TurnJournal {
  constructor(readonly root: string) {}

  private path(key: string): string {
    return resolve(this.root, fileFor(key));
  }

  begin(t: Omit<InflightTurn, "key" | "resume">): InflightTurn {
    const key = `${t.bot}:${t.userId}:${t.messageId ?? "no-id"}:${t.startedAt}`;
    const marker: InflightTurn = { ...t, key, resume: { attempts: 0, orphanedAt: null, notBefore: null, waiting: null } };
    atomicWriteJson(this.path(key), marker);
    return marker;
  }

  clear(key: string): void {
    try {
      unlinkSync(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  get(key: string): InflightTurn | null {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as InflightTurn;
  }

  update(key: string, patch: Partial<InflightTurn["resume"]>): InflightTurn | null {
    const cur = this.get(key);
    if (!cur) return null;
    const next = { ...cur, resume: { ...cur.resume, ...patch } };
    atomicWriteJson(this.path(key), next);
    return next;
  }

  /** Every marker on disk, oldest first. Unreadable files are reported, not thrown. */
  list(onBad?: (file: string, err: Error) => void): InflightTurn[] {
    if (!existsSync(this.root)) return [];
    const out: InflightTurn[] = [];
    for (const f of readdirSync(this.root)) {
      if (!f.endsWith(".json") || f === LEDGER_FILE) continue;
      try {
        const m = JSON.parse(readFileSync(resolve(this.root, f), "utf8")) as InflightTurn;
        if (m && typeof m.key === "string" && m.resume) out.push(m);
        else onBad?.(f, new Error("not a marker"));
      } catch (err) {
        onBad?.(f, err as Error);
      }
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  // ── the ledger: a marker is acted on once, ever ──────────────────────

  ledger(): JournalLedgerEntry[] {
    const p = resolve(this.root, LEDGER_FILE);
    if (!existsSync(p)) return [];
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  settled(key: string): JournalLedgerEntry | null {
    return this.ledger().find((e) => e.key === key) ?? null;
  }

  /** Record the outcome FIRST, then remove the marker. */
  settle(key: string, outcome: JournalOutcome, at: Date, note?: string): void {
    const entries = this.ledger().filter((e) => e.key !== key);
    entries.push({ key, outcome, at: at.toISOString(), ...(note ? { note } : {}) });
    atomicWriteJson(resolve(this.root, LEDGER_FILE), entries.slice(-LEDGER_CAP));
    this.clear(key);
  }
}

// ── production singleton + the call-site helper ─────────────────────────

let shuttingDown = false;

/**
 * Gateway entry point only (index.ts), and only where something else exits
 * the process on the signal (singleton.ts does): a bare listener would stop
 * Node's default exit-on-SIGTERM. Prepended so it runs before that exit.
 */
export function installShutdownGuard(): void {
  const mark = () => {
    shuttingDown = true;
  };
  process.prependListener("SIGTERM", mark);
  process.prependListener("SIGINT", mark);
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Test seam. */
export function __setShuttingDownForTests(v: boolean): void {
  shuttingDown = v;
}

export function turnResumeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TURN_RESUME !== "false";
}

export function trackedUser(userId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!userId || userId === "unknown") return false;
  const list = (env.TURN_RESUME_USERS ?? ownerUserId()).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes("*") || list.includes(userId.toLowerCase());
}

let journal: TurnJournal | null = null;
export function turnJournal(): TurnJournal {
  if (!journal || journal.root !== resolve(gatewayStateRoot(), "inflight-turns")) {
    journal = new TurnJournal(resolve(gatewayStateRoot(), "inflight-turns"));
  }
  return journal;
}

export interface TrackedTurn {
  key: string | null;
  /** The reply (or the turn's final word — an error line, a stop) is in the thread. */
  done(): void;
}

/** The handle for a turn nobody tracks (an untracked user, or not started yet). */
export const UNTRACKED: TrackedTurn = { key: null, done: () => {} };

/**
 * Mark a chat turn in flight. Never throws and never blocks the turn: a
 * journal failure only costs the resume. Untracked users get a no-op.
 */
export function trackTurn(t: Omit<InflightTurn, "key" | "resume" | "startedAt"> & { startedAt?: string }): TrackedTurn {
  if (!turnResumeEnabled() || !trackedUser(t.userId)) return UNTRACKED;
  try {
    const marker = turnJournal().begin({ ...t, startedAt: t.startedAt ?? new Date().toISOString() });
    let finished = false;
    return {
      key: marker.key,
      done: () => {
        if (finished) return;
        if (shuttingDown) {
          console.warn(`[turn-journal] shutting down — leaving ${t.bot}/${t.userId} turn marked for resume`);
          return;
        }
        finished = true;
        try {
          turnJournal().clear(marker.key);
        } catch (err) {
          console.error(`[turn-journal] could not clear marker (a restart would resume an answered turn):`, err);
        }
      },
    };
  } catch (err) {
    console.error(`[turn-journal] could not mark turn in flight (it will not survive a restart):`, err);
    return UNTRACKED;
  }
}
