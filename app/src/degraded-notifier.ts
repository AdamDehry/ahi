import { AI_ROOT } from "./ai-root.js";
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, parse as parsePath, resolve } from "path";
import { gatewayStateRoot } from "./multi-user-paths.js";

const THROTTLE_MS = 5 * 60 * 1000;
/**
 * Self-healing conditions: the gateway already fixed it (the bloated session
 * is cleared automatically). Gateway log + /health only — no alert, no state,
 * no notification of any kind.
 */
export const SELF_HEALING_REASONS = new Set(["michael-context-bloat"]);

// Per-instance state, rewritten whole on every transition — moves with the
// state root so an isolated instance can't clear or invent production's
// degraded flags.
const STATE_PATH = resolve(gatewayStateRoot(), "gateway_degraded.json");
// NOT moved, deliberately: this one describes the MACHINE's disk, is produced
// by an outside writer (the disk-alert cron / dashboard snapshot), and is only
// ever read here. Pointing an isolated instance at an empty state root would
// just blind its own health endpoint for no gain.
const DISK_SNAPSHOT_PATH = resolve(AI_ROOT, "state/disk_snapshot.json");

export interface DegradedEntry {
  reason: string;
  since: number;
  detail?: string;
  last_notified?: number;
}

interface DegradedStore {
  degraded: boolean;
  reason?: string;
  since?: number;
  detail?: string;
  last_notified?: number;
  states?: Record<string, DegradedEntry>;
}

export class GatewayDegradedError extends Error {
  readonly reason: string;
  readonly userMessage: string;

  constructor(reason: string, userMessage: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "GatewayDegradedError";
    this.reason = reason;
    this.userMessage = userMessage;
  }
}

const states = new Map<string, DegradedEntry>();
const lastNotified = new Map<string, number>();

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function loadState(): void {
  if (!existsSync(STATE_PATH)) return;
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as DegradedStore;
    if (parsed.states && typeof parsed.states === "object") {
      for (const [reason, entry] of Object.entries(parsed.states)) {
        if (!entry || typeof entry.since !== "number") continue;
        if (SELF_HEALING_REASONS.has(entry.reason || reason)) continue; // older builds kept these forever
        const normalized = { ...entry, reason: entry.reason || reason };
        states.set(normalized.reason, normalized);
        if (typeof normalized.last_notified === "number") {
          lastNotified.set(normalized.reason, normalized.last_notified * 1000);
        }
      }
    } else if (parsed.degraded && parsed.reason && typeof parsed.since === "number" && !SELF_HEALING_REASONS.has(parsed.reason)) {
      const entry: DegradedEntry = {
        reason: parsed.reason,
        since: parsed.since,
        detail: parsed.detail,
        last_notified: parsed.last_notified,
      };
      states.set(entry.reason, entry);
      if (typeof entry.last_notified === "number") {
        lastNotified.set(entry.reason, entry.last_notified * 1000);
      }
    }
  } catch (err) {
    console.warn("[degraded-notifier] Could not read degraded state:", err);
  }
}

loadState();

function storeForDisk(): DegradedStore {
  const active = Array.from(states.values());
  const primary = active[0];
  return {
    degraded: active.length > 0,
    reason: primary?.reason,
    since: primary?.since,
    detail: primary?.detail,
    last_notified: primary?.last_notified,
    states: Object.fromEntries(active.map((entry) => [entry.reason, entry])),
  };
}

function persistState(): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(storeForDisk(), null, 2)}\n`, "utf-8");
    renameSync(tmp, STATE_PATH);
  } catch (err) {
    console.error("[degraded-notifier] Could not write degraded state:", err);
  }
}

// ── where alerts go ("No Telegram copies") ────────────────
//
// Not Telegram — that transport is gone from this module. A degraded state is
// recorded here (and in /health) and handed to the review desk's System feed,
// which collapses repeats, wakes Michael on a hard alert and pushes the owner only
// after 6 h unacknowledged (src/review/alerts.ts). Recovery is silent.

export interface AlertSink {
  record(alert: { class: string; source: string; severity: "hard" | "soft"; title: string; detail?: string }): void;
  resolve(cls: string): void;
}

type SinkOp = { kind: "record"; alert: Parameters<AlertSink["record"]>[0] } | { kind: "resolve"; cls: string };

let sink: AlertSink | null = null;
const pending: SinkOp[] = [];
const PENDING_MAX = 50;

function deliver(op: SinkOp): void {
  if (!sink) {
    if (pending.length >= PENDING_MAX) pending.shift();
    pending.push(op);
    return;
  }
  try {
    if (op.kind === "record") sink.record(op.alert);
    else sink.resolve(op.cls);
  } catch (err) {
    console.error("[degraded-notifier] alert sink failed (state is still recorded):", err);
  }
}

/** Production: the review desk, once it is up. Ops raised before that are replayed now. */
export function setAlertSink(next: AlertSink | null): void {
  sink = next;
  if (!sink) return;
  for (const op of pending.splice(0)) deliver(op);
}

export interface SelfHealedEvent {
  reason: string;
  count: number;
  last: number;
  detail?: string;
}

const selfHealed = new Map<string, SelfHealedEvent>();

export function getSelfHealedEvents(): SelfHealedEvent[] {
  return Array.from(selfHealed.values()).sort((a, b) => b.last - a.last);
}

const ALERT_TITLES: Record<string, string> = {
  "claude-spawn-enospc": "The server's disk is full, so Michael can't start new turns",
  "pre-flight-low-disk": "The server is low on disk space",
  "file-save-enospc": "The disk is full, so files can't be saved",
  "voice-save-enospc": "The disk is full, so voice notes can't be saved",
};

export function alertTitleFor(reason: string): string {
  return ALERT_TITLES[reason] ?? `The gateway reports a problem (${reason})`;
}

function shouldNotify(reason: string): boolean {
  const last = lastNotified.get(reason) ?? 0;
  return Date.now() - last >= THROTTLE_MS;
}

export async function notifyDegraded(reason: string, detail?: string): Promise<void> {
  if (SELF_HEALING_REASONS.has(reason)) {
    const prev = selfHealed.get(reason);
    selfHealed.set(reason, { reason, count: (prev?.count ?? 0) + 1, last: nowUnix(), detail: detail?.slice(0, 400) });
    console.warn(`[degraded-notifier] self-healed ${reason} — logged only${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    return;
  }
  const existing = states.get(reason);
  const entry: DegradedEntry = {
    reason,
    since: existing?.since ?? nowUnix(),
    detail,
    last_notified: existing?.last_notified,
  };
  states.set(reason, entry);
  console.warn(`[degraded-notifier] degraded ${reason}${detail ? `: ${detail.slice(0, 300)}` : ""}`);

  // The feed collapses repeats itself; the throttle just keeps a hot loop from
  // rewriting its file every few milliseconds.
  if (shouldNotify(reason)) {
    const notifiedAt = nowUnix();
    entry.last_notified = notifiedAt;
    lastNotified.set(reason, notifiedAt * 1000);
    deliver({ kind: "record", alert: { class: `gateway-${reason}`, source: "gateway", severity: "hard", title: alertTitleFor(reason), detail: detail?.slice(0, 400) } });
  }
  persistState();
}

/** Silent: the state clears and the feed entry closes. No "back online" message anywhere. */
export async function notifyRecovered(reason: string): Promise<void> {
  if (!states.has(reason)) return;
  states.delete(reason);
  lastNotified.delete(reason);
  persistState();
  console.log(`[degraded-notifier] recovered ${reason}`);
  deliver({ kind: "resolve", cls: `gateway-${reason}` });
}

export function isDegraded(reason?: string): boolean {
  return reason ? states.has(reason) : states.size > 0;
}

export function getDegradedStates(): DegradedEntry[] {
  return Array.from(states.values()).sort((a, b) => a.since - b.since);
}

export function isDiskFullError(value: unknown): boolean {
  if (!value) return false;
  const text = value instanceof Error
    ? `${value.name} ${value.message} ${(value as NodeJS.ErrnoException).code ?? ""}`
    : String(value);
  return /ENOSPC|no space|disk full|no space left/i.test(text);
}

export interface FreshDiskSnapshot {
  freeGb: number;
  ageHours: number;
}

export function readFreshDiskSnapshot(maxAgeHours: number): FreshDiskSnapshot | null {
  try {
    if (!existsSync(DISK_SNAPSHOT_PATH)) return null;
    const raw = JSON.parse(readFileSync(DISK_SNAPSHOT_PATH, "utf-8")) as {
      free_gb?: number;
      freeGb?: number;
      ts?: number;
      taken_at?: string;
      timestamp?: string;
    };
    const freeRaw = raw.free_gb ?? raw.freeGb;
    if (typeof freeRaw !== "number" || !Number.isFinite(freeRaw)) return null;
    let takenMs: number | null = null;
    if (typeof raw.ts === "number" && Number.isFinite(raw.ts)) {
      takenMs = raw.ts * 1000;
    } else if (raw.taken_at || raw.timestamp) {
      const parsed = Date.parse(raw.taken_at ?? raw.timestamp ?? "");
      if (Number.isFinite(parsed)) takenMs = parsed;
    }
    if (takenMs === null) return null;
    const ageHours = (Date.now() - takenMs) / 3_600_000;
    if (ageHours < 0 || ageHours > maxAgeHours) return null;
    return { freeGb: freeRaw, ageHours };
  } catch {
    return null;
  }
}

/**
 * Size and space available to this user (what `df -k /` reports as Available) on the system disk, in KB, read
 * through Node so it works the same on Mac, Windows and Linux (Windows has no df). Linux/Mac: "/";
 * Windows: the drive the server runs from.
 */
export function systemDiskKb(): { totalKb: number; freeKb: number } {
  const st = statfsSync(process.platform === "win32" ? parsePath(process.cwd()).root : "/");
  return { totalKb: (st.blocks * st.bsize) / 1024, freeKb: (st.bavail * st.bsize) / 1024 };
}

export function getLiveDiskFreeGb(): number | null {
  try {
    const { freeKb } = systemDiskKb();
    return Number.isFinite(freeKb) ? Math.round((freeKb / 1024 / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}
