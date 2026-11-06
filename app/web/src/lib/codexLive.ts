/**
 * codexLive.ts — client for a Codex build's live transcript
 * (GET /app/codex-live/:build?after=N; gateway: src/codex-live/).
 *
 * The socket's `codex-live` frame is a doorbell ("build X moved"); this
 * module fans it out to whichever panel shows that build, and the panel
 * fetches the delta over HTTP. HTTP is the truth, so a missed frame costs at
 * most one poll.
 */

export type LiveEvent =
  | { seq: number; at: string; kind: "say"; text: string; final: boolean }
  | { seq: number; at: string; kind: "user"; text: string; brief: boolean }
  | { seq: number; at: string; kind: "cmd"; verb: "read" | "search" | "list" | "run"; text: string; exit: number | null; ms: number | null }
  | { seq: number; at: string; kind: "edit"; files: Array<{ path: string; op: string; plus: number; minus: number }> }
  | { seq: number; at: string; kind: "web"; text: string }
  | { seq: number; at: string; kind: "turn"; phase: "start" | "end" | "aborted"; ms: number | null };

export type LiveStatus = "starting" | "running" | "waiting" | "done" | "failed" | "stopped" | "stalled" | "not-codex" | "no-session";

export interface LiveView {
  build: string;
  status: LiveStatus;
  now: { text: string; since: string } | null;
  startedAt: string | null;
  endedAt: string | null;
  serverNow: string;
  lastActivityAt: string | null;
  session: { id: string; model: string | null; effort: string | null; cli: string | null } | null;
  events: LiveEvent[];
  cursor: number;
  omitted: number;
  reset: boolean;
}

export const liveUrl = (build: string, after = 0) => `/app/codex-live/${encodeURIComponent(build)}${after > 0 ? `?after=${after}` : ""}`;

/** Still moving: keep polling. */
export const isLive = (s: LiveStatus) => s === "starting" || s === "running" || s === "waiting";

/** Most events a panel keeps; older ones fall off the top (a reload shows the recent window anyway). */
export const KEEP = 800;

export interface LiveState {
  view: LiveView | null;
  events: LiveEvent[];
  omitted: number;
}

export const EMPTY: LiveState = { view: null, events: [], omitted: 0 };

/** Fold one answer in. A reset (or a first answer) replaces; a delta appends what is new. */
export function merge(prev: LiveState, next: LiveView): LiveState {
  if (next.reset || !prev.view || next.cursor < (prev.view?.cursor ?? 0)) {
    return { view: next, events: next.events.slice(-KEEP), omitted: next.omitted + Math.max(0, next.events.length - KEEP) };
  }
  const last = prev.events.at(-1)?.seq ?? 0;
  const fresh = next.events.filter((e) => e.seq > last);
  const all = fresh.length ? [...prev.events, ...fresh] : prev.events;
  const cut = Math.max(0, all.length - KEEP);
  return { view: next, events: cut ? all.slice(cut) : all, omitted: prev.omitted + cut };
}

export async function fetchLive(build: string, after: number): Promise<LiveView> {
  const res = await fetch(liveUrl(build, after), { cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 401 ? "Signed out." : res.status === 404 ? "That build is gone." : `HTTP ${res.status}`);
  return (await res.json()) as LiveView;
}

// ── doorbell ────────────────────────────────────────────────────────────

const bells = new Map<string, Set<() => void>>();

export function onCodexLive(build: string, fn: () => void): () => void {
  if (!bells.has(build)) bells.set(build, new Set());
  bells.get(build)!.add(fn);
  return () => {
    bells.get(build)?.delete(fn);
    if (!bells.get(build)?.size) bells.delete(build);
  };
}

/** Called by the socket handler for a `codex-live` frame. */
export function codexLiveNudge(build: unknown): void {
  if (typeof build !== "string") return;
  for (const fn of bells.get(build) ?? []) fn();
}

// ── words ───────────────────────────────────────────────────────────────

export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export const STATUS_WORD: Record<LiveStatus, string> = {
  starting: "Starting",
  running: "Working",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  stalled: "Went quiet",
  "not-codex": "Not a Codex build",
  "no-session": "No session found",
};
