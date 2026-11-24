/**
 * schedule.ts — client for the Schedule (/app/schedule/*): the owner's week as a
 * live calendar behind a header icon (not a menu tab).
 *
 * The gateway composes everything (blocks, briefs, the background lane, the
 * unread count); this file fetches, and holds the tiny bit of UI state that
 * two places share — whether the calendar is open and the badge — in a
 * module store, so the header icon and the modal agree without touching the
 * app store's snapshot. Writes carry `X-AHI-Review: 1` + a JSON body.
 */
import { useSyncExternalStore } from "react";
import { getLang, locale, t, type Key } from "../i18n";

export const SCHEDULE_URL = "/app/schedule";

export interface BriefLine {
  id: string;
  at: string;
  text: string;
  who: string;
  tag: string | null;
  source: "build" | "review" | "activity" | "decision";
}

export interface WorkRow {
  build: string;
  agent: string;
  title: string;
  now: string;
  at: string;
  tag: string | null;
  tagLabel: string;
  for: "now" | "next" | null;
}

export interface DecisionRow {
  id: string;
  at: string;
  tag: string | null;
  tagLabel: string;
  decision: string;
  why: string;
  overruled: { at: string; by: string; note: string | null; delivered: boolean } | null;
}

export interface AttentionRow {
  id: string;
  at: string;
  kind: "question" | "review" | "decision";
  text: string;
  who: string;
  tag: string | null;
  urgent: boolean;
  unread: boolean;
  block: string | null;
}

export interface BlockOut {
  id: string;
  date: string;
  title: string;
  /** A one-word label for narrow week columns ("Sales", "Shul"). */
  short: string | null;
  kind: string;
  tags: string[];
  approx: boolean;
  detail: string | null;
  start: string;
  end: string;
  sacred: boolean;
  clipped: boolean;
  status: "past" | "now" | "next" | "later";
  unread: number;
}

export interface DayOut {
  date: string;
  weekday: number;
  isToday: boolean;
  segments: Array<{ id: string; startMin: number; endMin: number; continued: boolean; continues: boolean }>;
}

export interface ScheduleView {
  now: string;
  zone: string;
  title: string;
  approved: string;
  note: string | null;
  source: "file" | "seed";
  error: string | null;
  kinds: Record<string, { label: string; color: string }>;
  tagLabels: Record<string, string>;
  today: string;
  weekStart: string;
  days: DayOut[];
  blocks: Record<string, BlockOut>;
  current: { block: string; lines: BriefLine[] } | null;
  next: string | null;
  background: { work: WorkRow[]; decisions: DecisionRow[] };
  attention: AttentionRow[];
  unread: number;
  badge: string;
}

export interface Briefing {
  block: BlockOut;
  lines: BriefLine[];
  prepping: WorkRow[];
  attention: AttentionRow[];
  decisions: DecisionRow[];
  quiet: string | null;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

async function post<T>(path: string, body: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-AHI-Review": "1" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof json.error === "string" ? json.error : `HTTP ${res.status}` };
    return { ok: true, ...(json as T) };
  } catch {
    return { ok: false, error: t("calendar.cantReachGateway") };
  }
}

export async function fetchBriefing(id: string): Promise<Briefing | null> {
  try {
    const res = await fetch(`${SCHEDULE_URL}/blocks/${encodeURIComponent(id)}`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Briefing) : null;
  } catch {
    return null;
  }
}

/**
 * An open briefing stays live: fetched on open, on every write (`rev`), and
 * on the calendar's own 30-second poll while the app is in front. Pure (the
 * timer, fetch and visibility come in), so a node test drives it.
 */
export interface BriefingPollDeps {
  fetch: (id: string) => Promise<Briefing | null>;
  onData: (b: Briefing | null) => void;
  intervalMs: number;
  visible: () => boolean;
  setInterval: (f: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
}

export function startBriefingPoll(id: string, deps: BriefingPollDeps): () => void {
  let live = true;
  let seq = 0;
  const load = () => {
    const mine = ++seq;
    void deps.fetch(id).then((b) => {
      if (live && mine === seq) deps.onData(b);
    });
  };
  load();
  const h = deps.setInterval(() => deps.visible() && load(), deps.intervalMs);
  return () => {
    live = false;
    deps.clearInterval(h);
  };
}

/** The gateway records at most this many ids per read write (service.ts markRead). */
export const READ_CHUNK = 200;

/**
 * Read marks for what an open briefing shows. An id counts as sent only when
 * the gateway said yes to the write that carried it: ids go out in chunks of
 * READ_CHUNK, one after another, so an ok never covers ids the gateway did not
 * take. A failed chunk is resent on the next poll; an id whose write is still
 * in flight is not sent twice. Pure (the send comes in).
 */
export function createReadMarker(send: (ids: string[]) => Promise<boolean>): { see(ids: string[]): Promise<void> } {
  const done = new Set<string>();
  const inFlight = new Set<string>();
  return {
    async see(ids) {
      const fresh = [...new Set(ids)].filter((id) => !done.has(id) && !inFlight.has(id));
      fresh.forEach((id) => inFlight.add(id));
      for (let i = 0; i < fresh.length; i += READ_CHUNK) {
        const chunk = fresh.slice(i, i + READ_CHUNK);
        let ok = false;
        try {
          ok = await send(chunk);
        } catch {
          ok = false;
        } finally {
          chunk.forEach((id) => inFlight.delete(id));
        }
        if (ok) chunk.forEach((id) => done.add(id));
      }
    },
  };
}

// ── shared UI state: open block + badge ───────────────────────────────

interface UiState {
  open: boolean;
  /** The block whose briefing is showing; null = the whole calendar. */
  block: string | null;
  unread: number;
  /** Bumped by every write so an open calendar refetches. */
  rev: number;
}

let ui: UiState = { open: false, block: null, unread: 0, rev: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<UiState>) => {
  ui = { ...ui, ...patch };
  listeners.forEach((l) => l());
};

export function useScheduleUi(): UiState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => ui,
    () => ui,
  );
}

/** "" · "1"…"9" · "9+" — the same rule as the gateway. */
export function badgeText(n: number): string {
  return n <= 0 ? "" : n > 9 ? "9+" : String(n);
}

export const scheduleUi = {
  open(block: string | null = null) {
    set({ open: true, block });
  },
  close() {
    set({ open: false, block: null });
  },
  showBlock(block: string | null) {
    set({ block });
  },
  setUnread(n: number) {
    if (n !== ui.unread) set({ unread: Math.max(0, n) });
  },
  /** Re-read the badge (poll, foreground, after a write). */
  async refreshBadge(): Promise<void> {
    try {
      const res = await fetch(`${SCHEDULE_URL}/badge`, { cache: "no-store" });
      if (res.ok) this.setUnread(((await res.json()) as { unread: number }).unread);
    } catch {
      /* keep the last count */
    }
  },
  /** Opening / seeing items marks them read. True only when the gateway recorded it (the caller retries otherwise). */
  async markRead(ids: string[]): Promise<boolean> {
    if (!ids.length) return true;
    const r = await post<{ unread: number }>(`${SCHEDULE_URL}/read`, { ids });
    if (r.ok) set({ unread: r.unread, rev: ui.rev + 1 });
    return r.ok;
  },
  async clearAll(): Promise<{ ok: boolean; error?: string }> {
    const before = ui.unread;
    set({ unread: 0 });
    const r = await post<{ unread: number }>(`${SCHEDULE_URL}/read-all`, {});
    if (!r.ok) {
      set({ unread: before });
      return { ok: false, error: r.error };
    }
    set({ unread: r.unread, rev: ui.rev + 1 });
    return { ok: true };
  },
  async overrule(id: string, note: string | null): Promise<{ ok: boolean; error?: string; woke?: boolean }> {
    const r = await post<{ woke: boolean }>(`${SCHEDULE_URL}/decisions/${encodeURIComponent(id)}/overrule`, { note });
    if (!r.ok) return { ok: false, error: r.error };
    set({ rev: ui.rev + 1 });
    void this.refreshBadge();
    return { ok: true, woke: r.woke };
  },
};

// ── formatting ────────────────────────────────────────────────────────

/** "2 PM" · "2:30 PM" in English; the language's own clock (24-hour "14:00" in Hebrew) elsewhere. */
export function clock(iso: string, zone: string): string {
  const s = new Intl.DateTimeFormat(locale(), { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return getLang() === "en" ? s.replace(":00", "") : s;
}

/** An hour-grid label: "2 PM" in English, "14:00" in Hebrew. */
export function hourLabel(h: number): string {
  if (getLang() === "en") return `${h % 12 || 12} ${h < 12 || h === 24 ? "AM" : "PM"}`;
  return `${String(h % 24).padStart(2, "0")}:00`;
}

/** The narrow rail's hour: "2p" in English, "14" in Hebrew. */
export function hourShort(h: number): string {
  if (getLang() === "en") return `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
  return String(h % 24);
}

/** "just now" · "12 min ago" · "3 h ago" · "2 days ago". Numbers stay raw (no grouping), as before. */
export function ago(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 1) return t("common.justNow");
  if (mins < 60) return t("calendar.minAgo", { n: String(mins) });
  const h = Math.round(mins / 60);
  if (h < 36) return t("calendar.hAgo", { n: String(h) });
  return t("calendar.daysAgo", { n: String(Math.round(h / 24)) });
}

/** "in 25 min" · "in 2 h 5 min". */
export function until(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  if (mins < 60) return t("calendar.inMin", { n: String(Math.max(1, mins)) });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? t("calendar.inHMin", { h: String(h), m: String(m) }) : t("calendar.inH", { h: String(h) });
}

/** Weekday names as catalog keys (Sunday first; the seventh day is Shabbat). Translate at render: t(WEEKDAY[i]). */
export const WEEKDAY: Key[] = ["calendar.wd.sun", "calendar.wd.mon", "calendar.wd.tue", "calendar.wd.wed", "calendar.wd.thu", "calendar.wd.fri", "calendar.wd.sat"];
export const WEEKDAY_LONG: Key[] = ["calendar.wdl.sun", "calendar.wdl.mon", "calendar.wdl.tue", "calendar.wdl.wed", "calendar.wdl.thu", "calendar.wdl.fri", "calendar.wdl.sat"];

/** "Nov 24" in English, "24 בנוב׳" in Hebrew. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
