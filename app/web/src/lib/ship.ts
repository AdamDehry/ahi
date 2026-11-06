/**
 * ship.ts — the app's side of a ship: what the attention bar
 * shows on every screen, and the restart visual's state machine. Pure, so the
 * hook harness can pin it: no fetch, no clock, no React.
 *
 * Phases the server derives (src/foreman-messages/ship.ts) are read as they
 * are; what this adds is the LIVE layer — the socket closing with 1012 is
 * "our restart", the socket coming back and /health answering with a new sha
 * is "back" — because the server cannot speak while it is down.
 */
import type { ConnectionStatus } from "./ws";
import { readStoredList, writeStoredList } from "./cache";

export type ShipPhase = "candidate" | "ready" | "approved" | "shipping" | "restarting" | "shipped" | "rolled_back" | "failed";
export type RestartChoice = "wait" | "now";

export interface ShipManifest {
  v: 1;
  branch: string;
  base: string;
  head: string | null;
  touches: "server" | "app" | "both";
  steps: Array<"server" | "web">;
  env: string[];
  restart: boolean;
  summary: string;
  costs: string | null;
}

export interface ShipState {
  build: string;
  phase: ShipPhase;
  manifest: ShipManifest | null;
  summary: string | null;
  costs: string | null;
  review: string | null;
  ready_at: string | null;
  ready_by: string | null;
  approved: { by: string; at: string; restart: RestartChoice } | null;
  run: { id: string; started_at: string; pre: string | null; merged: string | null; built_at: string | null; restarting_at: string | null } | null;
  result: { outcome: "ok" | "rolled_back" | "failed"; at: string; sha: string | null; dark_s: number | null; reason: string | null } | null;
  pending: boolean;
  active: boolean;
}

// ── the attention bar ──────────────────────────────────────────────────

export type AttentionKind = "ship" | "question" | "rolled-back";

export interface AttentionItem {
  /** Stable per occurrence: a dismissal keys on it, a NEW occurrence gets a new key. */
  key: string;
  kind: AttentionKind;
  cardId: string;
  title: string;
  /** One line: what is ready. */
  line: string;
  /** The one action's word. */
  action: string;
}

interface AttentionCard {
  id: string;
  title: string;
  kicker: string;
  ask: string | null;
  /** The needs_owner record that asked: one per question, so a dismissal holds until a NEW question. */
  ask_record?: string | null;
  last_activity_at: string | null;
  opened_at: string;
  ship: ShipState | null;
}

/**
 * The bar's items from the board's Needs-you section: a ship waiting on his
 * tap, a question, a ship that rolled back. One per card; ships first.
 */
export function attentionItems(needsYou: ReadonlyArray<AttentionCard>): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const c of needsYou) {
    if (c.kicker === "ship" && c.ship) {
      out.push({ key: `ship:${c.id}:${c.ship.ready_at ?? ""}`, kind: "ship", cardId: c.id, title: c.title, line: `Ready to ship — ${c.title}`, action: "Ship" });
    } else if (c.kicker === "rolled-back" && c.ship) {
      const word = c.ship.phase === "failed" ? "Ship stopped" : "Rolled back";
      out.push({ key: `rb:${c.id}:${c.ship.result?.at ?? ""}`, kind: "rolled-back", cardId: c.id, title: c.title, line: `${word} — ${c.title}`, action: "See why" });
    } else if (c.kicker === "question" && c.ask) {
      // Keyed on the question itself, never last_activity_at: that moves on every runner event,
      // which re-keyed the item and brought a dismissed bar back.
      out.push({ key: `ask:${c.id}:${c.ask_record ?? c.ask}`, kind: "question", cardId: c.id, title: c.title, line: `Michael needs you — ${c.title}`, action: "Answer" });
    }
  }
  const rank = { ship: 0, "rolled-back": 1, question: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** Dismissed bar keys, per user, on this device — a dismissal survives a refresh. */
export const dismissedKey = (userId: string) => `ahi-attn-dismissed:${userId}`;

export function loadDismissed(userId: string | null | undefined): string[] {
  return userId ? readStoredList(dismissedKey(userId)) : [];
}

export function saveDismissed(userId: string | null | undefined, keys: string[]): void {
  if (userId) writeStoredList(dismissedKey(userId), keys, 200);
}

// ── the restart visual ─────────────────────────────────────────────────

export type LivePhase = "approved" | "shipping" | "building" | "restarting" | "reconnecting" | "back" | "rolled_back" | "failed";

export interface LiveShip {
  phase: LivePhase;
  /** Short word for the bar / button. */
  label: string;
  /** Milliseconds since the phase's anchor (the approval, the start, the dark window). */
  elapsedMs: number;
  /** The sha the gateway came back on (back only). */
  sha: string | null;
  /** True while the gateway is not answering (restart in progress). */
  dark: boolean;
}

export interface LiveInput {
  ship: ShipState | null;
  connection: ConnectionStatus;
  /** When the socket closed with 1012 (ms), null when not in a planned restart. */
  restartingAt: number | null;
  /** /health's build sha before the ship (if known) and the one seen since the socket came back. */
  shaBefore: string | null;
  shaNow: string | null;
  now: number;
}

const ms = (iso: string | null | undefined, now: number) => (iso ? Math.max(0, now - Date.parse(iso)) : 0);

/**
 * One state for the stepper, the bar and the button. Server phases win where
 * the server can speak; the socket fills the dark window:
 *
 *   approved → shipping → building → restarting (1012 seen or server said so)
 *   → reconnecting (socket closed, no result yet) → back (result ok, or socket
 *   open on a new sha) → … rolled_back / failed as the server reports.
 */
export function liveShip(i: LiveInput): LiveShip | null {
  const s = i.ship;
  if (!s) return null;
  if (s.phase === "shipped" || s.result?.outcome === "ok") {
    return { phase: "back", label: "Back", elapsedMs: ms(s.result?.at ?? null, i.now), sha: s.result?.sha ?? i.shaNow, dark: false };
  }
  if (s.phase === "rolled_back") return { phase: "rolled_back", label: "Rolled back", elapsedMs: ms(s.result?.at, i.now), sha: s.result?.sha ?? null, dark: false };
  if (s.phase === "failed") return { phase: "failed", label: "Stopped", elapsedMs: ms(s.result?.at, i.now), sha: null, dark: false };
  if (!s.active) return null;
  const socketDown = i.connection !== "open";
  const planned = i.restartingAt !== null;
  // The server said restarting, or we saw 1012: the dark window.
  if (s.phase === "restarting" || planned) {
    if (socketDown) {
      const since = i.restartingAt ?? (s.run?.restarting_at ? Date.parse(s.run.restarting_at) : i.now);
      return { phase: "restarting", label: "Restarting", elapsedMs: Math.max(0, i.now - since), sha: null, dark: true };
    }
    // Socket is back. A new sha from /health means the new build answered: back, pending the server's own word.
    if (i.shaNow && i.shaBefore && i.shaNow !== i.shaBefore) return { phase: "back", label: "Back", elapsedMs: 0, sha: i.shaNow, dark: false };
    return { phase: "reconnecting", label: "Reconnecting", elapsedMs: ms(s.run?.restarting_at ?? s.approved?.at, i.now), sha: null, dark: false };
  }
  if (s.phase === "shipping") {
    const building = !!s.run?.merged;
    return { phase: building ? "building" : "shipping", label: building ? "Building" : "Merging", elapsedMs: ms(s.run?.started_at, i.now), sha: null, dark: false };
  }
  return { phase: "approved", label: "Waking Michael", elapsedMs: ms(s.approved?.at, i.now), sha: null, dark: false };
}

/** The stepper's five stations from the live state. */
export function shipSteps(s: ShipState, live: LiveShip | null): Array<{ label: string; state: "done" | "now" | "left"; who: string | null }> {
  const p = live?.phase ?? "approved";
  const order: LivePhase[] = ["approved", "shipping", "building", "restarting", "back"];
  const idx = p === "reconnecting" ? 3 : p === "rolled_back" || p === "failed" ? -1 : order.indexOf(p);
  const st = (i: number): "done" | "now" | "left" => (idx < 0 ? "left" : i < idx ? "done" : i === idx ? "now" : "left");
  const approvedBy = s.approved ? (s.approved.by === "owner" ? "you" : s.approved.by) : null;
  const back = p === "back" ? `on ${live?.sha ?? s.result?.sha ?? "the new build"}` : null;
  const steps = [
    { label: "Approved", state: s.approved ? (idx === 0 ? "now" : "done") : "left", who: approvedBy },
    { label: "Merged onto main", state: st(1), who: s.run?.merged ? s.run.merged : null },
    { label: "Built", state: st(2), who: null },
    { label: p === "reconnecting" ? "Coming back" : "Restarting", state: st(3), who: live?.dark ? `${Math.round(live.elapsedMs / 1000)} s dark` : null },
    { label: "Back", state: p === "back" ? "done" : "left", who: back },
  ] as Array<{ label: string; state: "done" | "now" | "left"; who: string | null }>;
  if (p === "rolled_back" || p === "failed") {
    steps[1].state = s.run?.merged ? "done" : "left";
    steps[2].state = s.run?.built_at ? "done" : "left";
    steps[3].state = s.run?.restarting_at ? "done" : "left";
    steps[4] = { label: p === "rolled_back" ? `Rolled back to ${s.result?.sha ?? "the previous build"}` : "Stopped before the restart", state: "now", who: null };
  }
  return steps;
}

/** m:ss for the bar. */
export function clock(msElapsed: number): string {
  const s = Math.max(0, Math.floor(msElapsed / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── the composer during the dark window ────────────────────────────────

/**
 * Sending and voice entry are held while the gateway is restarting: the
 * reason, or null when the composer is free. Typing stays open either way —
 * a draft is kept per bot and survives the gap.
 */
export function composerLock(connection: ConnectionStatus, restartingAt: number | null, now: number, graceMs = 90_000): string | null {
  if (connection === "open") return null;
  if (restartingAt !== null && now - restartingAt < graceMs) return "Michael is restarting — your message goes the moment he is back.";
  return null;
}
