/**
 * alerts.ts — the system-alerts feed ("No Telegram copies").
 *
 * Gateway health (degraded-notifier) and the Bina corpus scripts (passage
 * ingest, freshness watchdog, session publisher) used to write straight to
 * Telegram, hourly, in key=value lines nobody read — and failed for five days
 * with nobody acting. Now every such alert lands HERE, in one feed shown in
 * Review → System:
 *
 *   - Repeats collapse: one entry per alert class, with a count and the time
 *     it was last seen — never a new item each hour.
 *   - "Resolved" / "back online" is silent: the entry closes, nothing is sent.
 *   - A push to the owner only when the alert is HARD, has persisted ≥ 6 hours and
 *     nobody acknowledged it — and at most one push per class per day, in
 *     plain English.
 *   - Michael is woken on a hard alert (once when it starts, then at most once
 *     a day while it persists), so the agent sees it even if the owner never opens
 *     the feed.
 *
 * State: <review root>/alerts.json, cached and rewritten whole — like every
 * gateway state file, ONLY the gateway process writes it. Outside scripts post
 * through /api/review/alerts (review.mjs alert).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { atomicWriteJson } from "../multi-user-paths.js";
import { fmtTime, fmtWeekday, localIsoDate } from "./clock.js";

export type AlertSeverity = "hard" | "soft";

export interface AlertEntry {
  /** Stable class key ("passage-ingest-extract-exit-1", "gateway-pre-flight-low-disk"). Repeats collapse on it. */
  class: string;
  /** Who reports it ("gateway", "passage-ingest", "passage-freshness", "session-publisher"). */
  source: string;
  severity: AlertSeverity;
  /** One plain-English line ("Memory search hasn't updated"). */
  title: string;
  /** The latest raw detail, one line, capped. Never pushed. */
  detail: string;
  /** Start of THIS episode (resets after a resolve). */
  first_seen: string;
  last_seen: string;
  /** Occurrences in this episode. */
  count: number;
  acked_at: string | null;
  acked_by: string | null;
  /** Local date (schedule zone) of the last push — one per class per day. */
  pushed_day: string | null;
  pushed_at: string | null;
  /** Local date of the last Michael wake for this episode. */
  woke_day: string | null;
  woke_at: string | null;
  resolved_at: string | null;
}

export interface AlertInput {
  class?: unknown;
  source?: unknown;
  severity?: unknown;
  title?: unknown;
  detail?: unknown;
}

/** Hard alerts push only after persisting this long, unacknowledged. */
export const PUSH_AFTER_MS = 6 * 60 * 60_000;

const CLASS_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function line(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function validateAlert(input: AlertInput): { ok: true; value: { class: string; source: string; severity: AlertSeverity; title: string; detail: string } } | { ok: false; reason: string } {
  const cls = typeof input.class === "string" ? input.class.trim().toLowerCase() : "";
  if (!CLASS_RE.test(cls)) return { ok: false, reason: "class must be a short slug (a-z, 0-9, . _ -)" };
  const source = typeof input.source === "string" && input.source ? input.source.trim().toLowerCase() : "gateway";
  if (!SOURCE_RE.test(source)) return { ok: false, reason: "source must be a short slug" };
  const severity = input.severity === "soft" ? "soft" : input.severity === "hard" || input.severity === undefined ? "hard" : null;
  if (!severity) return { ok: false, reason: "severity must be hard or soft" };
  const title = line(input.title, 140) || cls;
  return { ok: true, value: { class: cls, source, severity, title, detail: line(input.detail, 400) } };
}

export class AlertFeed {
  private entries: AlertEntry[];

  constructor(private readonly root: string) {
    this.entries = this.read();
  }

  private get path(): string {
    return join(this.root, "alerts.json");
  }

  private read(): AlertEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(raw?.alerts) ? raw.alerts : [];
    } catch (err) {
      console.error("[review] alerts.json unreadable — starting an empty feed:", err);
      return [];
    }
  }

  private flush(): void {
    atomicWriteJson(this.path, { version: 1, alerts: this.entries });
  }

  all(): AlertEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get(cls: string): AlertEntry | null {
    const e = this.entries.find((x) => x.class === cls);
    return e ? { ...e } : null;
  }

  /** Open entries first (newest activity first), then the recently resolved. */
  view(now: Date, resolvedWithinMs = 24 * 60 * 60_000): AlertEntry[] {
    const open = this.entries.filter((e) => !e.resolved_at).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
    const closed = this.entries
      .filter((e) => e.resolved_at && now.getTime() - Date.parse(e.resolved_at) <= resolvedWithinMs)
      .sort((a, b) => b.resolved_at!.localeCompare(a.resolved_at!));
    return [...open, ...closed].map((e) => ({ ...e }));
  }

  openCount(): number {
    return this.entries.filter((e) => !e.resolved_at && !e.acked_at).length;
  }

  /**
   * One occurrence. Same class while open = count + last seen, nothing new.
   * Same class after a resolve = a new episode (count 1, ack cleared).
   * Returns whether this started an episode.
   */
  record(v: { class: string; source: string; severity: AlertSeverity; title: string; detail: string }, now: Date): { entry: AlertEntry; started: boolean } {
    const at = now.toISOString();
    const idx = this.entries.findIndex((e) => e.class === v.class);
    const prev = idx === -1 ? null : this.entries[idx];
    let entry: AlertEntry;
    let started = false;
    if (prev && !prev.resolved_at) {
      entry = {
        ...prev,
        source: v.source,
        // A soft alert that turns hard is hard from now on; hard never softens mid-episode.
        severity: prev.severity === "hard" ? "hard" : v.severity,
        title: v.title,
        detail: v.detail || prev.detail,
        last_seen: at,
        count: prev.count + 1,
      };
    } else {
      started = true;
      entry = {
        class: v.class,
        source: v.source,
        severity: v.severity,
        title: v.title,
        detail: v.detail,
        first_seen: at,
        last_seen: at,
        count: 1,
        acked_at: null,
        acked_by: null,
        pushed_day: null,
        pushed_at: null,
        woke_day: null,
        woke_at: null,
        resolved_at: null,
      };
    }
    if (idx === -1) this.entries.push(entry);
    else this.entries[idx] = entry;
    this.prune(now);
    this.flush();
    return { entry: { ...entry }, started };
  }

  /** Silent: closes the episode(s). By class, or every open alert from a source. */
  resolve(by: { class?: string; source?: string }, now: Date): string[] {
    const closed: string[] = [];
    for (const e of this.entries) {
      if (e.resolved_at) continue;
      if ((by.class && e.class === by.class) || (!by.class && by.source && e.source === by.source)) {
        e.resolved_at = now.toISOString();
        closed.push(e.class);
      }
    }
    if (closed.length) this.flush();
    return closed;
  }

  ack(cls: string, by: string, now: Date): AlertEntry | null {
    const e = this.entries.find((x) => x.class === cls && !x.resolved_at);
    if (!e) return null;
    if (!e.acked_at) {
      e.acked_at = now.toISOString();
      e.acked_by = by;
      this.flush();
    }
    return { ...e };
  }

  mark(cls: string, patch: Partial<Pick<AlertEntry, "pushed_day" | "pushed_at" | "woke_day" | "woke_at">>): void {
    const e = this.entries.find((x) => x.class === cls);
    if (!e) return;
    Object.assign(e, patch);
    this.flush();
  }

  /** Keep the file bounded: resolved entries older than 30 days go. */
  private prune(now: Date): void {
    const cutoff = now.getTime() - 30 * 86_400_000;
    this.entries = this.entries.filter((e) => !e.resolved_at || Date.parse(e.resolved_at) >= cutoff);
  }
}

/**
 * What the feed owes right now for one entry. Pure — the desk applies it.
 *   push: hard, open, unacknowledged, persisted ≥ 6 h, not pushed today.
 *   wake: hard, open, unacknowledged, Michael not woken today for it.
 */
export function alertDue(e: AlertEntry, now: Date, tz: string): { push: boolean; wake: boolean } {
  if (e.severity !== "hard" || e.resolved_at || e.acked_at) return { push: false, wake: false };
  const today = localIsoDate(now, tz);
  return {
    push: now.getTime() - Date.parse(e.first_seen) >= PUSH_AFTER_MS && e.pushed_day !== today,
    wake: e.woke_day !== today,
  };
}

/** "since Thursday" / "since 4:10 AM" (same local day). */
export function sincePhrase(e: AlertEntry, now: Date, tz: string): string {
  const first = new Date(e.first_seen);
  if (localIsoDate(first, tz) === localIsoDate(now, tz)) return `since ${fmtTime(first, tz)}`;
  if (now.getTime() - first.getTime() < 6 * 86_400_000) return `since ${fmtWeekday(first, tz)}`;
  return `for ${Math.round((now.getTime() - first.getTime()) / 86_400_000)} days`;
}

/** The one plain-English push line: "Memory search hasn't updated since Thursday — Michael is on it." */
export function alertPushBody(e: AlertEntry, now: Date, tz: string): string {
  const title = e.title.replace(/[.\s]+$/, "");
  return `${title} ${sincePhrase(e, now, tz)} — Michael is on it.`;
}

/** The words Michael is woken with (his own turn, never the owner's chat). */
export function alertWakeText(e: AlertEntry, now: Date, tz: string): string {
  return [
    `SYSTEM ALERT (hard) — ${e.title}. Source: ${e.source} · class ${e.class} · ${e.count}× ${sincePhrase(e, now, tz)}, last seen ${fmtTime(new Date(e.last_seen), tz)}.`,
    e.detail ? `Latest detail: ${e.detail}` : null,
    `Look into it and fix or report. Acknowledge with review.mjs alert-ack ${e.class} once someone is on it — that stops the push to the owner (he is pushed only after 6 h unacknowledged).`,
  ]
    .filter(Boolean)
    .join("\n");
}
