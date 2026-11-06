/**
 * eta-calibration.ts — agent-driven ETAs and their calibration (§5).
 *
 * The default question behind "how long will this take?" is: how much real
 * wall-clock time will the owner and Michael need, with Michael steering the
 * selected builder (Codex / Claude Code / Foreman) through the normal
 * workflow. Human-engineer time is answered only when explicitly asked.
 *
 * Two data sources, both timing-only:
 *   1. ETA records (this module's own append-only JSONL): a predicted range
 *      opened before work, closed with measured durations after.
 *   2. Foreman builds (read-only, via temporal-events.ts): actual wall-clock
 *      and waiting time of every completed build — real calibration data that
 *      exists today, before a single ETA record has been written.
 *
 * Records hold no message content, no prompts, no secrets: every field is a
 * number, an ISO instant, or a sanitised slug (§11, success criterion 9).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";

import { DURATION, formatClockZ, formatDuration, localDayDiff, localParts } from "./local-time.js";
import { sanitizeLabel, temporalDir, type BuildTiming } from "./temporal-events.js";

const { MINUTE_MS, HOUR_MS } = DURATION;

export type ScopeSize = "tiny" | "small" | "medium" | "large";
export type EtaOutcome = "completed" | "blocked" | "failed" | "cancelled";

export interface EtaRecord {
  id: string;
  createdAtUtc: string;
  completedAtUtc?: string;
  taskCategory: string;
  scopeSize: ScopeSize;
  builder: string;
  model?: string;
  effort?: string;
  predictedLowMs: number;
  predictedHighMs: number;
  activeRuntimeMs?: number;
  wallClockMs?: number;
  userWaitMs?: number;
  externalWaitMs?: number;
  outcome?: EtaOutcome;
  blockerCodes?: string[];
}

/** The exact key set a record may carry — enforced on write and asserted in tests. */
export const ETA_RECORD_KEYS: readonly (keyof EtaRecord)[] = [
  "id",
  "createdAtUtc",
  "completedAtUtc",
  "taskCategory",
  "scopeSize",
  "builder",
  "model",
  "effort",
  "predictedLowMs",
  "predictedHighMs",
  "activeRuntimeMs",
  "wallClockMs",
  "userWaitMs",
  "externalWaitMs",
  "outcome",
  "blockerCodes",
];

const SCOPES: readonly ScopeSize[] = ["tiny", "small", "medium", "large"];
const OUTCOMES: readonly EtaOutcome[] = ["completed", "blocked", "failed", "cancelled"];

/** Comparable closed records needed before calibration may adjust a heuristic. */
export const MIN_CALIBRATION_SAMPLES = 5;

export const etaStats = { writeErrors: 0, readErrors: 0, lastError: "" };

export function etaEnabled(): boolean {
  return (process.env.AHI_ETA_CALIBRATION ?? "off").trim().toLowerCase() === "on";
}

function etaPath(): string {
  return join(temporalDir(), "eta.jsonl");
}

function slug(value: unknown, fallback: string, max = 48): string {
  const s = (sanitizeLabel(value, max * 2) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return s || fallback;
}

function ms(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** Parse "20m", "1h30m", "90s", "2h", or a bare number of minutes. */
export function parseDuration(text: string): number {
  const t = text.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * MINUTE_MS);
  let total = 0;
  let matched = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "d" ? n * 24 * HOUR_MS : m[2] === "h" ? n * HOUR_MS : m[2] === "m" ? n * MINUTE_MS : n * 1000;
  }
  if (!matched) throw new Error(`unparseable duration: ${JSON.stringify(text)}`);
  return Math.round(total);
}

/** Whitelist + sanitise. Anything not in ETA_RECORD_KEYS is dropped. */
export function sanitizeEtaRecord(raw: Partial<EtaRecord>): EtaRecord {
  const low = ms(raw.predictedLowMs);
  const high = ms(raw.predictedHighMs);
  if (low === undefined || high === undefined || high < low) throw new Error("predictedLowMs/HighMs must be ms with low ≤ high");
  const rec: EtaRecord = {
    id: slug(raw.id, randomUUID(), 64),
    createdAtUtc: Number.isFinite(Date.parse(raw.createdAtUtc ?? "")) ? new Date(raw.createdAtUtc!).toISOString() : new Date().toISOString(),
    taskCategory: slug(raw.taskCategory, "general"),
    scopeSize: SCOPES.includes(raw.scopeSize as ScopeSize) ? (raw.scopeSize as ScopeSize) : "small",
    builder: slug(raw.builder, "unknown", 32),
    predictedLowMs: low,
    predictedHighMs: high,
  };
  if (raw.model) rec.model = slug(raw.model, "unknown", 48);
  if (raw.effort) rec.effort = slug(raw.effort, "unknown", 16);
  if (raw.completedAtUtc && Number.isFinite(Date.parse(raw.completedAtUtc))) rec.completedAtUtc = new Date(raw.completedAtUtc).toISOString();
  for (const k of ["activeRuntimeMs", "wallClockMs", "userWaitMs", "externalWaitMs"] as const) {
    const v = ms(raw[k]);
    if (v !== undefined) rec[k] = v;
  }
  if (raw.outcome && OUTCOMES.includes(raw.outcome)) rec.outcome = raw.outcome;
  if (Array.isArray(raw.blockerCodes) && raw.blockerCodes.length) {
    rec.blockerCodes = raw.blockerCodes.slice(0, 8).map((c) => slug(c, "unknown", 32));
  }
  return rec;
}

function append(line: Record<string, unknown>): void {
  mkdirSync(temporalDir(), { recursive: true, mode: 0o700 });
  appendFileSync(etaPath(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** Open a prediction before work starts. Returns the stored record. */
export function openEtaRecord(input: Omit<Partial<EtaRecord>, "id"> & { id?: string }): EtaRecord {
  const rec = sanitizeEtaRecord({ ...input, id: input.id ?? randomUUID() });
  try {
    append({ op: "open", ...rec });
  } catch (err) {
    etaStats.writeErrors++;
    etaStats.lastError = (err as Error).message;
    throw err;
  }
  return rec;
}

/**
 * Close a record with measured timing. Wall clock defaults to
 * completedAt − createdAt when not supplied.
 */
export function closeEtaRecord(
  id: string,
  result: {
    outcome: EtaOutcome;
    completedAt?: Date;
    activeRuntimeMs?: number;
    wallClockMs?: number;
    userWaitMs?: number;
    externalWaitMs?: number;
    blockerCodes?: string[];
  },
): EtaRecord {
  const existing = readEtaRecords().find((r) => r.id === slug(id, "", 64));
  if (!existing) throw new Error(`no open ETA record ${id}`);
  const completedAtUtc = (result.completedAt ?? new Date()).toISOString();
  const wall = result.wallClockMs ?? Date.parse(completedAtUtc) - Date.parse(existing.createdAtUtc);
  const merged = sanitizeEtaRecord({
    ...existing,
    completedAtUtc,
    outcome: result.outcome,
    wallClockMs: wall,
    activeRuntimeMs: result.activeRuntimeMs ?? existing.activeRuntimeMs,
    userWaitMs: result.userWaitMs ?? existing.userWaitMs,
    externalWaitMs: result.externalWaitMs ?? existing.externalWaitMs,
    blockerCodes: result.blockerCodes ?? existing.blockerCodes,
  });
  append({ op: "close", ...merged });
  return merged;
}

/** All records, folded (latest line per id wins). Never throws. */
export function readEtaRecords(): EtaRecord[] {
  try {
    const path = etaPath();
    if (!existsSync(path)) return [];
    const byId = new Map<string, EtaRecord>();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const { op: _op, ...rest } = JSON.parse(line) as Record<string, unknown>;
        const rec = sanitizeEtaRecord(rest as Partial<EtaRecord>);
        byId.set(rec.id, rec);
      } catch {
        // skip damaged lines
      }
    }
    return [...byId.values()];
  } catch (err) {
    etaStats.readErrors++;
    etaStats.lastError = (err as Error).message;
    return [];
  }
}

// ── Statistics ────────────────────────────────────────────────────────────────

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface DurationStats {
  key: string;
  n: number;
  medianMs: number;
  p25Ms: number;
  p75Ms: number;
}

function stats(key: string, values: number[]): DurationStats {
  const s = [...values].sort((a, b) => a - b);
  return { key, n: s.length, medianMs: quantile(s, 0.5), p25Ms: quantile(s, 0.25), p75Ms: quantile(s, 0.75) };
}

/**
 * Actual wall-clock of completed Foreman builds, grouped by runtime/model/effort.
 * Builds over 24h are excluded (left open overnight, not representative).
 */
export function foremanCalibration(builds: BuildTiming[], minN = MIN_CALIBRATION_SAMPLES): DurationStats[] {
  const groups = new Map<string, number[]>();
  for (const b of builds) {
    if (b.outcome !== "completed" || b.wallClockMs === undefined) continue;
    if (b.wallClockMs <= 0 || b.wallClockMs > 24 * HOUR_MS) continue;
    const key = [b.runtime ?? "?", b.model ?? "?", b.effort ?? "?"].join(" ");
    const list = groups.get(key) ?? [];
    list.push(b.wallClockMs);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([k, v]) => stats(k, v))
    .filter((s) => s.n >= minN)
    .sort((a, b) => b.n - a.n);
}

/** actual / predicted-midpoint ratios for closed, comparable ETA records. */
export function predictionRatios(records: EtaRecord[], filter: Partial<Pick<EtaRecord, "taskCategory" | "builder" | "scopeSize">> = {}): number[] {
  return records
    .filter((r) => r.outcome === "completed" && r.wallClockMs !== undefined)
    .filter((r) => (filter.taskCategory ? r.taskCategory === filter.taskCategory : true))
    .filter((r) => (filter.builder ? r.builder === filter.builder : true))
    .filter((r) => (filter.scopeSize ? r.scopeSize === filter.scopeSize : true))
    .map((r) => r.wallClockMs! / ((r.predictedLowMs + r.predictedHighMs) / 2 || 1));
}

// ── Estimator ─────────────────────────────────────────────────────────────────

/** Transparent heuristic ranges for ACTIVE agent time (Michael steering a builder). */
export const HEURISTIC_ACTIVE_MS: Record<ScopeSize, [number, number]> = {
  tiny: [5 * MINUTE_MS, 15 * MINUTE_MS],
  small: [15 * MINUTE_MS, 45 * MINUTE_MS],
  medium: [45 * MINUTE_MS, 2 * HOUR_MS],
  large: [2 * HOUR_MS, 6 * HOUR_MS],
};

export interface EstimateInput {
  scopeSize: ScopeSize;
  taskCategory?: string;
  builder?: string;
  model?: string;
  effort?: string;
  /** Gateway/service restart + verification. */
  needsRestart?: boolean;
  /** Schema migration with rehearsal. */
  needsMigration?: boolean;
  /** the owner must review/test live before it counts as done. */
  needsUserReview?: boolean;
  /** Depends on an external provider/credential. */
  externalDependency?: boolean;
  /** "human" only when the user explicitly asked for human-engineer time. */
  mode?: "agentic" | "human";
}

export interface Estimate {
  mode: "agentic" | "human";
  /** Primary wall-clock range. */
  lowMs: number;
  highMs: number;
  activeAgentMs: [number, number];
  /** the owner's own review/testing time — stated separately, never folded silently. */
  userReview?: "required" | undefined;
  /** External waits: unknown duration, called out rather than guessed. */
  externalWait?: "unknown" | undefined;
  basis: "heuristic" | "calibrated";
  samples: number;
  assumptions: string[];
}

export function estimate(input: EstimateInput, records: EtaRecord[] = []): Estimate {
  const mode = input.mode ?? "agentic";
  let [low, high] = HEURISTIC_ACTIVE_MS[input.scopeSize];
  const assumptions: string[] = [];
  if (mode === "human") {
    // Requested explicitly: a human engineer doing it by hand, roughly 4–8× agent active time.
    low *= 4;
    high *= 8;
    assumptions.push("human-engineer estimate, as asked — not how this team actually builds");
  } else {
    assumptions.push(`agent-driven: Michael steering ${input.builder ?? "the selected builder"}${input.model ? ` (${input.model}${input.effort ? `, ${input.effort}` : ""})` : ""}`);
  }
  let basis: Estimate["basis"] = "heuristic";
  let samples = 0;
  if (mode === "agentic") {
    const ratios = predictionRatios(records, { taskCategory: input.taskCategory, builder: input.builder });
    samples = ratios.length;
    if (ratios.length >= MIN_CALIBRATION_SAMPLES) {
      const r = Math.min(4, Math.max(0.25, quantile([...ratios].sort((a, b) => a - b), 0.5)));
      low *= r;
      high *= r;
      basis = "calibrated";
      assumptions.push(`calibrated on ${ratios.length} comparable completed records (median actual/predicted ${r.toFixed(2)}×)`);
    } else {
      assumptions.push(`heuristic range — only ${ratios.length} comparable records, not enough to calibrate`);
    }
  }
  const active: [number, number] = [Math.round(low), Math.round(high)];
  if (input.needsRestart) {
    low += 5 * MINUTE_MS;
    high += 15 * MINUTE_MS;
    assumptions.push("includes one controlled restart + verification");
  }
  if (input.needsMigration) {
    low += 20 * MINUTE_MS;
    high += 60 * MINUTE_MS;
    assumptions.push("includes migration rehearsal and an approval gate");
  }
  return {
    mode,
    lowMs: Math.round(low),
    highMs: Math.round(high),
    activeAgentMs: active,
    userReview: input.needsUserReview ? "required" : undefined,
    externalWait: input.externalDependency ? "unknown" : undefined,
    basis,
    samples,
    assumptions,
  };
}

/**
 * ETA update rule (§5.4): a moved ETA must name its cause. Returns the
 * sentence to say; throws if the cause is missing, so a silent move cannot be
 * produced through this API.
 */
export function describeEtaRevision(prev: { lowMs: number; highMs: number }, next: { lowMs: number; highMs: number }, cause: string): string {
  const why = sanitizeLabel(cause, 160);
  if (!why) throw new Error("an ETA revision must state its concrete cause");
  return `ETA moved from ${formatRange(prev.lowMs, prev.highMs)} to ${formatRange(next.lowMs, next.highMs)} — ${why}.`;
}

export function formatRange(lowMs: number, highMs: number): string {
  return lowMs === highMs ? formatDuration(lowMs) : `${formatDuration(lowMs)}–${formatDuration(highMs)}`;
}

/**
 * Local completion window for a duration range starting at `now`:
 * "about 20m–40m → done around 2:20–2:40 PM EDT (this afternoon)".
 * The day-part comes from the computed finish time, so a 2 PM task is never
 * "tonight" unless the arithmetic actually lands there (§3.6).
 */
export function completionWindow(now: Date, lowMs: number, highMs: number, timeZone: string): string {
  const a = new Date(now.getTime() + lowMs);
  const b = new Date(now.getTime() + highMs);
  const when = (d: Date) => {
    const diff = localDayDiff(now, d, timeZone);
    const h = localParts(d, timeZone).hour;
    const part = h < 5 ? "overnight" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "tonight";
    if (diff === 0) return part === "tonight" || part === "overnight" ? part : `this ${part}`;
    if (diff === 1) return part === "tonight" ? "tomorrow night" : part === "overnight" ? "overnight" : `tomorrow ${part}`;
    return `in ${diff} days`;
  };
  const wa = when(a);
  const wb = when(b);
  const span = `${formatClockZ(a, timeZone)}–${formatClockZ(b, timeZone)}`;
  return `about ${formatRange(lowMs, highMs)} → done around ${span} (${wa === wb ? wa : `${wa} to ${wb}`})`;
}

// ── Prompt block ──────────────────────────────────────────────────────────────

const ETA_QUESTION = /\b(how long|how much (more )?time|eta\b|etas\b|time estimate|estimate[sd]? (how long|the time|duration)|when (will|would|can|could|should) (it|this|that|you|we|he|they)\b[^?.]{0,60}\b(done|ready|finish(ed)?|land|ship(ped)?|complete[d]?)|how many (hours|minutes|days)|by when)\b/i;
const HUMAN_ASK = /\b(human|engineer|developer|dev team|contractor|by hand|manually|without (ai|agents|michael|codex|claude))\b/i;

export function isEtaQuestion(prompt: string | null | undefined): boolean {
  return Boolean(prompt && ETA_QUESTION.test(prompt));
}

export function etaModeFor(prompt: string | null | undefined): "agentic" | "human" {
  return prompt && HUMAN_ASK.test(prompt) ? "human" : "agentic";
}

/**
 * The block injected on turns that ask for a duration. Compact; only present
 * when the prompt asks, so ordinary turns pay nothing for it.
 */
export function buildEtaBlock(opts: {
  prompt: string;
  now: Date;
  timeZone: string;
  userName: string;
  builds?: BuildTiming[];
  records?: EtaRecord[];
}): string {
  const mode = etaModeFor(opts.prompt);
  const { now, timeZone } = opts;
  const lines = ["## ETA basis (this turn asks for a duration)"];
  if (mode === "human") {
    lines.push(
      `${opts.userName} explicitly asked for HUMAN-engineer time: give that, labelled as human time, and contrast it with the agent-driven wall-clock this team actually runs on.`,
    );
  } else {
    lines.push(
      `Default meaning: real wall-clock for ${opts.userName} + Michael steering the selected builder (Codex, Claude Code, Foreman) through the normal workflow — NOT human-engineer time.`,
    );
  }
  lines.push(
    "Give ONE primary wall-clock range plus its local finish window. Split active agent time / " +
      `${opts.userName}'s review / external waits only when they matter. Name the builder/model/effort, gates and restarts you assumed. ` +
      "No 'tonight' / 'later' when a duration is known; no exact finish time when the range is uncertain; 'dispatched' is not 'done'; step N of N is not near-done unless the last step's length is known; stale monitoring is not progress. If a prior ETA changes, say the new range AND the concrete cause.",
  );
  const marks = [20 * MINUTE_MS, 40 * MINUTE_MS, HOUR_MS, 2 * HOUR_MS, 4 * HOUR_MS]
    .map((d) => {
      const t = new Date(now.getTime() + d);
      return `+${formatDuration(d)} → ${formatClockZ(t, timeZone)}${localDayDiff(now, t, timeZone) > 0 ? " (tomorrow)" : ""}`;
    })
    .join(" · ");
  lines.push(`Finish-time math from now: ${marks}`);
  const h = HEURISTIC_ACTIVE_MS;
  lines.push(
    `Heuristic active agent time: tiny ${formatRange(...h.tiny)} · small ${formatRange(...h.small)} · medium ${formatRange(...h.medium)} · large ${formatRange(...h.large)}; +5–15m per restart+verify; ${opts.userName}'s review and external waits are separate and stated, not hidden.`,
  );
  const cal = opts.builds ? foremanCalibration(opts.builds).slice(0, 4) : [];
  if (cal.length) {
    lines.push(
      "Measured Foreman builds (completed, actual wall-clock start→done): " +
        cal.map((s) => `${s.key}: median ${formatDuration(s.medianMs)} (p25–p75 ${formatRange(s.p25Ms, s.p75Ms)}, n=${s.n})`).join(" · "),
    );
  } else {
    lines.push("No measured build history available — say the range is heuristic.");
  }
  const records = opts.records ?? [];
  const closed = records.filter((r) => r.outcome === "completed" && r.wallClockMs !== undefined);
  if (closed.length >= MIN_CALIBRATION_SAMPLES) {
    const ratios = predictionRatios(records).sort((a, b) => a - b);
    lines.push(`Past ETA accuracy: ${closed.length} closed predictions, median actual/predicted ${quantile(ratios, 0.5).toFixed(2)}×.`);
  } else {
    lines.push(`Past ETA accuracy: ${closed.length} closed predictions — too few to claim calibration.`);
  }
  return lines.join("\n");
}
