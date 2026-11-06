/**
 * temporal-events.ts — append-only timeline of structured TIMING facts (§4.3).
 *
 * What it holds: when Michael was spoken to, when he answered, when builds
 * started/paused/finished, when the gateway restarted. What it never holds:
 * message text, prompts, credentials, retrieved memory. Labels and metadata
 * are sanitised and size-bounded on the way in.
 *
 * Storage: one JSONL file per user under `<gatewayStateRoot>/temporal/`
 * (`AHI_GATEWAY_STATE_DIR` moves it, like every other gateway store). Writes
 * are single `appendFileSync` calls — each line lands whole, and there is no
 * read-modify-rewrite, so the hook subprocess reading while the gateway writes
 * can never erase anything (the threadCache whole-file-rewrite race does not
 * apply here). Retention is rotation, not rewriting: past `maxBytes` the file
 * is renamed to `.1.jsonl` (replacing the older one), so at most two files per
 * user exist and nothing is ever edited in place.
 *
 * Fail-open everywhere: every exported function swallows its own errors and
 * counts them in `temporalEventStats`. A timeline failure never blocks a turn.
 *
 * Foreman: builds already write `foreman/builds/<id>/events.jsonl`. This module
 * READS those (never writes them) and maps them onto the same event vocabulary,
 * so Michael gets real build start/pause/finish times with no Foreman change.
 */
import { ownerUserId } from "./users.js";

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join, resolve } from "path";

import { gatewayStateRoot, safeSegment } from "./multi-user-paths.js";

export type TemporalEventType =
  | "user_message_received"
  | "assistant_response_emitted"
  | "task_dispatched"
  | "builder_started"
  | "builder_paused"
  | "builder_resumed"
  | "builder_completed"
  | "builder_failed"
  | "builder_cancelled"
  | "deploy_started"
  | "deploy_completed"
  | "review_requested"
  | "review_completed"
  | "gateway_restarted";

export const TEMPORAL_EVENT_TYPES: readonly TemporalEventType[] = [
  "user_message_received",
  "assistant_response_emitted",
  "task_dispatched",
  "builder_started",
  "builder_paused",
  "builder_resumed",
  "builder_completed",
  "builder_failed",
  "builder_cancelled",
  "deploy_started",
  "deploy_completed",
  "review_requested",
  "review_completed",
  "gateway_restarted",
];

/** Event types that count as "work happened" for the envelope's activity block. */
export const WORK_EVENT_TYPES: ReadonlySet<TemporalEventType> = new Set<TemporalEventType>([
  "task_dispatched",
  "builder_started",
  "builder_paused",
  "builder_resumed",
  "builder_completed",
  "builder_failed",
  "builder_cancelled",
  "deploy_started",
  "deploy_completed",
  "review_requested",
  "review_completed",
]);

export type TemporalEventSource = "gateway" | "codex" | "foreman" | "claude" | "user" | "system";

export type MetadataValue = string | number | boolean | null;

export interface TemporalEvent {
  id: string;
  occurredAtUtc: string;
  userId: string;
  /** Agent the event belongs to (conversation events are per agent thread). */
  agent?: string;
  sessionId?: string;
  taskId?: string;
  type: TemporalEventType;
  source: TemporalEventSource;
  label?: string;
  metadata?: Record<string, MetadataValue>;
}

export const temporalEventStats = { writeErrors: 0, readErrors: 0, lastError: "" };

const SYSTEM_USER = "_system";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const LABEL_MAX = 80;
const META_MAX_KEYS = 12;
const META_KEY_MAX = 40;
const META_VALUE_MAX = 120;

function noteError(kind: "writeErrors" | "readErrors", err: unknown): void {
  temporalEventStats[kind]++;
  temporalEventStats.lastError = (err as Error)?.message?.slice(0, 160) ?? String(err);
}

export function temporalDir(): string {
  return resolve(gatewayStateRoot(), "temporal");
}

function eventsPath(userId: string): string {
  return join(temporalDir(), `events-${safeSegment(userId, "unknown")}.jsonl`);
}

function maxBytes(): number {
  const raw = Number(process.env.AHI_TEMPORAL_EVENTS_MAX_BYTES);
  return Number.isFinite(raw) && raw > 1024 ? raw : DEFAULT_MAX_BYTES;
}

// Anything that looks like a credential, bearer token, or long opaque id is
// replaced before it can reach disk. Timing records have no reason to carry one.
const SECRETISH = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/=_]{32,})\b/g;

/** Strip control characters, redact secret-shaped runs, bound the length. */
export function sanitizeLabel(value: unknown, max = LABEL_MAX): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(SECRETISH, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function sanitizeMetadata(meta: unknown): Record<string, MetadataValue> | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const out: Record<string, MetadataValue> = {};
  let n = 0;
  for (const [rawKey, rawValue] of Object.entries(meta as Record<string, unknown>)) {
    if (n >= META_MAX_KEYS) break;
    const key = rawKey.replace(/[^A-Za-z0-9_]/g, "").slice(0, META_KEY_MAX);
    if (!key) continue;
    let value: MetadataValue;
    if (rawValue === null || typeof rawValue === "boolean") value = rawValue;
    else if (typeof rawValue === "number") value = Number.isFinite(rawValue) ? rawValue : null;
    else if (typeof rawValue === "string") value = sanitizeLabel(rawValue, META_VALUE_MAX) ?? "";
    else continue; // objects/arrays are dropped: metadata is flat by contract
    out[key] = value;
    n++;
  }
  return n ? out : undefined;
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export interface RecordEventInput {
  userId: string | null | undefined;
  type: TemporalEventType;
  source: TemporalEventSource;
  occurredAt?: Date | string;
  agent?: string;
  sessionId?: string | null;
  taskId?: string | null;
  label?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append one event. Returns the stored event, or null if the write failed
 * (counted, never thrown). Unknown users are recorded under "unknown" only if
 * a userId was given at all — a missing userId records nothing.
 */
export function recordTemporalEvent(input: RecordEventInput): TemporalEvent | null {
  try {
    if (!TEMPORAL_EVENT_TYPES.includes(input.type)) throw new Error(`unknown temporal event type ${input.type}`);
    const userId = input.userId ? safeSegment(input.userId, "unknown") : null;
    if (!userId) return null;
    const occurred =
      input.occurredAt instanceof Date
        ? input.occurredAt
        : isIsoInstant(input.occurredAt)
          ? new Date(input.occurredAt)
          : new Date();
    if (!Number.isFinite(occurred.getTime())) throw new Error("invalid occurredAt");
    const event: TemporalEvent = {
      id: randomUUID(),
      occurredAtUtc: occurred.toISOString(),
      userId,
      type: input.type,
      source: input.source,
    };
    if (input.agent) event.agent = safeSegment(input.agent, "unknown");
    const sessionId = sanitizeLabel(input.sessionId, 64);
    if (sessionId) event.sessionId = sessionId.replace(/[^A-Za-z0-9._:-]/g, "");
    const taskId = sanitizeLabel(input.taskId, 96);
    if (taskId) event.taskId = taskId.replace(/[^A-Za-z0-9._:-]/g, "");
    const label = sanitizeLabel(input.label);
    if (label) event.label = label;
    const metadata = sanitizeMetadata(input.metadata);
    if (metadata) event.metadata = metadata;

    const dir = temporalDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = eventsPath(userId);
    if (existsSync(path) && statSync(path).size > maxBytes()) {
      renameSync(path, path.replace(/\.jsonl$/, ".1.jsonl"));
    }
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  } catch (err) {
    noteError("writeErrors", err);
    return null;
  }
}

function parseLines(path: string): TemporalEvent[] {
  if (!existsSync(path)) return [];
  const out: TemporalEvent[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as TemporalEvent;
      if (ev && isIsoInstant(ev.occurredAtUtc) && TEMPORAL_EVENT_TYPES.includes(ev.type)) out.push(ev);
    } catch {
      // A torn or foreign line is skipped, not fatal (tolerant of damage).
    }
  }
  return out;
}

export interface ReadEventsOptions {
  /** Only events at or before this instant (the "now" being reasoned about). */
  until?: Date;
  since?: Date;
  agent?: string;
  types?: ReadonlySet<TemporalEventType> | readonly TemporalEventType[];
  /** Include system-wide events (gateway restarts). Default true. */
  includeSystem?: boolean;
}

/**
 * Events for one user, oldest → newest, de-duplicated by id and sorted by
 * occurrence (so out-of-order appends are harmless). Never throws.
 */
export function readTemporalEvents(userId: string, opts: ReadEventsOptions = {}): TemporalEvent[] {
  try {
    const user = safeSegment(userId, "unknown");
    const files = [eventsPath(user)];
    if (opts.includeSystem !== false && user !== SYSTEM_USER) files.push(eventsPath(SYSTEM_USER));
    const seen = new Set<string>();
    const types = opts.types ? new Set(opts.types) : null;
    const until = opts.until?.getTime();
    const since = opts.since?.getTime();
    const all: TemporalEvent[] = [];
    for (const f of files) {
      for (const path of [f.replace(/\.jsonl$/, ".1.jsonl"), f]) {
        for (const ev of parseLines(path)) {
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
          const t = Date.parse(ev.occurredAtUtc);
          if (until !== undefined && t > until) continue;
          if (since !== undefined && t < since) continue;
          if (types && !types.has(ev.type)) continue;
          if (opts.agent && ev.agent && ev.agent !== opts.agent && ev.type !== "gateway_restarted") continue;
          if (opts.agent && !ev.agent && (ev.type === "user_message_received" || ev.type === "assistant_response_emitted")) continue;
          all.push(ev);
        }
      }
    }
    return all.sort((a, b) => Date.parse(a.occurredAtUtc) - Date.parse(b.occurredAtUtc));
  } catch (err) {
    noteError("readErrors", err);
    return [];
  }
}

// ── Gateway-side conversation events (feature-flagged) ───────────────────────

/** AHI_TEMPORAL_ENVELOPE set to anything but off → the gateway writes timeline events. */
export function temporalTimelineEnabled(): boolean {
  const raw = (process.env.AHI_TEMPORAL_ENVELOPE ?? "").trim().toLowerCase();
  return Boolean(raw) && !["off", "false", "0"].includes(raw);
}

/**
 * One call per turn edge from claude-invoke. No-op when the flag is off or the
 * sender is not a known user. Timing only — the message itself never reaches
 * this function.
 */
export function recordConversationEvent(
  userId: string | null | undefined,
  agent: string,
  type: "user_message_received" | "assistant_response_emitted",
  sessionId?: string | null,
): void {
  if (!userId || !temporalTimelineEnabled()) return;
  recordGatewayStartOnce();
  recordTemporalEvent({ userId, agent, type, source: "gateway", sessionId: sessionId ?? undefined });
}

// ── Gateway restart ───────────────────────────────────────────────────────────

let restartRecorded = false;

/**
 * Record this gateway process's start once (system-wide event, readable by
 * every user's envelope — a restart is not private). Called lazily from the
 * first invoke so no boot-path edit is needed; the timestamp is the real
 * process start, not the first turn.
 */
export function recordGatewayStartOnce(now = new Date()): void {
  if (restartRecorded) return;
  restartRecorded = true;
  const startedAt = new Date(now.getTime() - Math.round(process.uptime() * 1000));
  recordTemporalEvent({
    userId: SYSTEM_USER,
    type: "gateway_restarted",
    source: "system",
    occurredAt: startedAt,
    label: "gateway process start",
    metadata: { pid: process.pid },
  });
}

// ── Foreman adapter (read-only) ───────────────────────────────────────────────

export interface BuildTiming {
  buildId: string;
  name: string;
  agent?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  createdAtUtc?: string;
  startedAtUtc?: string;
  endedAtUtc?: string;
  lastEventAtUtc?: string;
  outcome?: "completed" | "failed" | "cancelled";
  /** Builder waiting for input (awaiting/idle → next steer/keys). */
  userWaitMs: number;
  wallClockMs?: number;
  activeRuntimeMs?: number;
  /** True while a build has started and has no terminal status. */
  open: boolean;
}

export function foremanBuildsDir(): string {
  const override = process.env.AHI_FOREMAN_BUILDS_DIR;
  return override ? resolve(override) : resolve(homedir(), "AHI/AHI_OS/foreman/builds");
}

/** Users who see Foreman build activity in their envelope (operator only by default). */
export function foremanVisibleTo(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const raw = process.env.AHI_TEMPORAL_FOREMAN_USERS ?? ownerUserId();
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(userId.toLowerCase());
}

interface ForemanRawEvent {
  ts?: number;
  type?: string;
}

function epochToIso(ts: unknown): string | undefined {
  return typeof ts === "number" && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : undefined;
}

export function parseForemanBuild(dir: string, buildId: string): BuildTiming | null {
  const eventsFile = join(dir, buildId, "events.jsonl");
  if (!existsSync(eventsFile)) return null;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, buildId, "meta.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    // meta is optional; timing comes from events.
  }
  const events: ForemanRawEvent[] = [];
  for (const line of readFileSync(eventsFile, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as ForemanRawEvent;
      if (typeof ev.ts === "number" && typeof ev.type === "string") events.push(ev);
    } catch {
      // skip torn lines
    }
  }
  if (!events.length) return null;
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const created = events.find((e) => e.type === "created");
  const started = events.find((e) => e.type === "started");
  const terminal = events.find((e) => typeof e.type === "string" && e.type.startsWith("status:"));
  let outcome: BuildTiming["outcome"];
  if (terminal?.type === "status:done") outcome = "completed";
  else if (terminal?.type === "status:failed") outcome = "failed";
  else if (terminal?.type === "status:abandoned") outcome = "cancelled";

  // Waiting-for-input spans: from awaiting/idle to the next input delivery.
  let userWaitMs = 0;
  let waitStart: number | null = null;
  const endTs = terminal?.ts ?? null;
  for (const e of events) {
    if (endTs !== null && (e.ts ?? 0) > endTs) break;
    if (e.type === "awaiting" || e.type === "idle") {
      if (waitStart === null) waitStart = e.ts ?? null;
    } else if ((e.type === "steer" || e.type === "keys" || e.type?.startsWith("status:")) && waitStart !== null) {
      userWaitMs += Math.max(0, ((e.ts ?? waitStart) - waitStart) * 1000);
      waitStart = null;
    }
  }

  const startTs = started?.ts ?? created?.ts;
  const wallClockMs = startTs !== undefined && endTs !== null ? Math.max(0, (endTs - startTs) * 1000) : undefined;
  const str = (k: string) => (typeof meta[k] === "string" && meta[k] ? (meta[k] as string) : undefined);
  return {
    buildId,
    name: sanitizeLabel(str("name") ?? buildId.replace(/^\d{8}-\d{6}-/, ""), 60) ?? buildId,
    agent: str("agent"),
    runtime: str("runtime"),
    model: str("model"),
    effort: str("effort"),
    createdAtUtc: epochToIso(created?.ts),
    startedAtUtc: epochToIso(started?.ts),
    endedAtUtc: epochToIso(terminal?.ts),
    lastEventAtUtc: epochToIso(events[events.length - 1].ts),
    outcome,
    userWaitMs,
    wallClockMs,
    activeRuntimeMs: wallClockMs !== undefined ? Math.max(0, wallClockMs - userWaitMs) : undefined,
    open: Boolean(started) && !terminal,
  };
}

/**
 * The most recent `limit` Foreman builds (by id, which is a timestamp prefix).
 * Never throws; a missing builds dir yields [].
 */
export function readForemanBuilds(opts: { limit?: number; dir?: string } = {}): BuildTiming[] {
  try {
    const dir = opts.dir ?? foremanBuildsDir();
    if (!existsSync(dir)) return [];
    const ids = readdirSync(dir)
      .filter((id) => /^\d{8}-\d{6}-/.test(id))
      .sort();
    const pick = opts.limit ? ids.slice(-opts.limit) : ids;
    const out: BuildTiming[] = [];
    for (const id of pick) {
      try {
        const b = parseForemanBuild(dir, id);
        if (b) out.push(b);
      } catch {
        // one bad build never hides the rest
      }
    }
    return out;
  } catch (err) {
    noteError("readErrors", err);
    return [];
  }
}

/** Map Foreman builds onto the shared event vocabulary (for the activity block). */
export function foremanBuildEvents(builds: BuildTiming[], userId: string): TemporalEvent[] {
  const out: TemporalEvent[] = [];
  for (const b of builds) {
    const base = { userId, source: "foreman" as const, taskId: b.buildId, label: `${b.name} (${b.agent ?? "builder"})` };
    if (b.startedAtUtc) out.push({ ...base, id: `${b.buildId}:start`, occurredAtUtc: b.startedAtUtc, type: "builder_started" });
    if (b.endedAtUtc && b.outcome) {
      const type: TemporalEventType =
        b.outcome === "completed" ? "builder_completed" : b.outcome === "failed" ? "builder_failed" : "builder_cancelled";
      out.push({ ...base, id: `${b.buildId}:end`, occurredAtUtc: b.endedAtUtc, type });
    }
  }
  return out.sort((a, b) => Date.parse(a.occurredAtUtc) - Date.parse(b.occurredAtUtc));
}
