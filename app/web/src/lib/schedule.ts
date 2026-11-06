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
    return { ok: false, error: "Can't reach the gateway." };
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

export function clock(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(iso)).replace(":00", "");
}

/** "just now" · "12 min ago" · "3 h ago" · "2 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "in 25 min" · "in 2 h 5 min". */
export function until(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  if (mins < 60) return `in ${Math.max(1, mins)} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `in ${h} h${m ? ` ${m} min` : ""}`;
}

export const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Shabbat"];
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Shabbat"];

export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
