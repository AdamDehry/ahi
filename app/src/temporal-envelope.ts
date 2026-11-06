/**
 * temporal-envelope.ts — the per-turn temporal envelope (§4.2) and the compact
 * instruction block that makes it govern (§4.5).
 *
 * Built fresh every turn by the UserPromptSubmit hook from event timestamps —
 * never from model memory. Sources, in order of authority:
 *   - the gateway's temporal timeline (temporal-events.ts): when this agent was
 *     spoken to and when it answered, per user+agent;
 *   - the message store (fallback for turns before the timeline existed);
 *   - the Claude transcript's first record (when this session began);
 *   - Foreman build events (read-only) for work timing, operator only;
 *   - the per-user temporal context record for which zone governs.
 *
 * Everything degrades: any source may be missing and the envelope still
 * renders, saying "unknown" rather than inventing a relationship.
 */

import { closeSync, openSync, readSync } from "fs";

import {
  DEFAULT_TIMEZONE,
  formatClockZ,
  formatDayName,
  formatDuration,
  formatLocalFull,
  formatOffset,
  isValidTimeZone,
  addLocalDays,
  localDayDiff,
  localParts,
  relativeDayLabel,
  wallTimeToUtc,
  zoneOffsetMinutes,
  toLocalIso,
} from "./local-time.js";
import { getMessagesForUser } from "./message-store.js";
import {
  loadTemporalContext,
  resolveEffectiveZone,
  type EffectiveZone,
  type HomeDefault,
} from "./temporal-context-store.js";
import {
  WORK_EVENT_TYPES,
  foremanBuildEvents,
  foremanVisibleTo,
  readForemanBuilds,
  readTemporalEvents,
  temporalEventStats,
  type BuildTiming,
  type TemporalEvent,
} from "./temporal-events.js";
import { lookupByUserId, type UserConfig } from "./users.js";
import { workdayFrameLine, workdayRuleApplies } from "./workday.js";

const MINUTE = 60_000;

export type Continuity = "active" | "brief_pause" | "resumed" | "new_context";

export interface TemporalEnvelope {
  version: 1;
  generatedAtUtc: string;
  user: {
    userId: string;
    timezone: string;
    localNow: string;
    utcOffsetMinutes: number;
    locationLabel?: string;
    homeTimezone: string;
    timezoneSource: EffectiveZone["source"];
    contextVersion: number;
    observationAgeMs?: number;
    currentLocation?: { label: string; source: string } | "unknown";
    uncertain: boolean;
  };
  conversation: {
    agent?: string;
    sessionId?: string;
    sessionStartedAtUtc?: string;
    lastUserMessageAtUtc?: string;
    lastAssistantMessageAtUtc?: string;
    currentUserMessageAtUtc: string;
    responseGapMs?: number;
    userMessageGapMs?: number;
    assistantSilenceMs?: number;
    sessionAgeMs?: number;
    continuity: Continuity;
    crossedLocalMidnight: boolean;
  };
  activity: {
    lastWorkEventAtUtc?: string;
    lastWorkEventLabel?: string;
    lastCompletedWorkAtUtc?: string;
    lastCompletedWorkLabel?: string;
    activeJobStartedAtUtc?: string;
    activeJobElapsedMs?: number;
    activeJobLabel?: string;
    activeJobLastSignalAtUtc?: string;
    workGapMs?: number;
  };
}

export interface EnvelopeTelemetry {
  zone: string;
  offsetMinutes: number;
  zoneSource: string;
  continuity: Continuity;
  sources: string[];
  eventReadErrors: number;
}

export interface EnvelopeInput {
  userId: string | null;
  agent?: string | null;
  now?: Date;
  sessionId?: string | null;
  transcriptPath?: string | null;
  deviceId?: string | null;
  /** Inject for tests; otherwise read from Foreman's builds dir (operator only). */
  builds?: BuildTiming[];
}

export interface EnvelopeResult {
  envelope: TemporalEnvelope;
  user: UserConfig | null;
  effective: EffectiveZone;
  telemetry: EnvelopeTelemetry;
}

/** Silence module-level console noise: the hook's STDOUT is its JSON channel. */
export function quiet<T>(fn: () => T): T {
  const log = console.log;
  const warn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** users.json lookup that can never throw (a missing registry must not kill the turn). */
export function safeLookupUser(userId: string | null | undefined): UserConfig | null {
  if (!userId) return null;
  try {
    return quiet(() => lookupByUserId(userId));
  } catch {
    return null;
  }
}

export interface ContinuityThresholds {
  activeMs: number;
  briefPauseMs: number;
  resumedMs: number;
}

/** Configurable via AHI_TEMPORAL_THRESHOLDS_MIN="5,30,360" (minutes). */
export function continuityThresholds(): ContinuityThresholds {
  const raw = (process.env.AHI_TEMPORAL_THRESHOLDS_MIN ?? "").split(",").map((s) => Number(s.trim()));
  const ok = raw.length === 3 && raw.every((n) => Number.isFinite(n) && n > 0) && raw[0] < raw[1] && raw[1] < raw[2];
  const [a, b, c] = ok ? raw : [5, 30, 360];
  return { activeMs: a * MINUTE, briefPauseMs: b * MINUTE, resumedMs: c * MINUTE };
}

/**
 * Classify a gap. Under the active threshold an exchange stays active even
 * across midnight (the date change is flagged separately); past it, crossing a
 * local calendar day is a new temporal context, as is anything over the
 * resumed threshold.
 */
export function classifyGap(gapMs: number | undefined, crossedMidnight: boolean, t = continuityThresholds()): Continuity {
  if (gapMs === undefined) return "new_context";
  if (gapMs < t.activeMs) return "active";
  if (crossedMidnight) return "new_context";
  if (gapMs < t.briefPauseMs) return "brief_pause";
  if (gapMs <= t.resumedMs) return "resumed";
  return "new_context";
}

function readSessionStart(transcriptPath: string | null | undefined): string | undefined {
  if (!transcriptPath || !transcriptPath.endsWith(".jsonl") || !transcriptPath.includes("/.claude/")) return undefined;
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    let earliest: number | undefined;
    for (const line of buf.subarray(0, n).toString("utf-8").split("\n").slice(0, 40)) {
      const m = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
      if (!m) continue;
      const t = Date.parse(m[1]);
      if (Number.isFinite(t) && (earliest === undefined || t < earliest)) earliest = t;
    }
    return earliest !== undefined ? new Date(earliest).toISOString() : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

interface Stamp {
  t: number;
  src: "timeline" | "messages";
}

function mergeStamps(list: Stamp[]): Stamp[] {
  const sorted = [...list].sort((a, b) => a.t - b.t);
  const out: Stamp[] = [];
  for (const s of sorted) {
    // The same message seen by both sources within a few seconds is one message.
    const last = out[out.length - 1];
    if (last && Math.abs(s.t - last.t) < 5_000) {
      if (s.src === "timeline") out[out.length - 1] = s;
      continue;
    }
    out.push(s);
  }
  return out;
}

const CURRENT_TIMELINE_WINDOW_MS = 120_000;
const CURRENT_QUEUED_WINDOW_MS = 30 * MINUTE;
const OPEN_JOB_MAX_AGE_MS = 12 * 60 * MINUTE;

export function buildTemporalEnvelope(input: EnvelopeInput): EnvelopeResult {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const sources: string[] = [];
  const user = safeLookupUser(input.userId);
  const userId = user?.userId ?? input.userId ?? "unknown";
  const agent = input.agent ?? undefined;
  const readErrorsBefore = temporalEventStats.readErrors;

  // ── Zone ──
  const home: HomeDefault = { zone: user?.timezone, label: user?.locationLabel };
  let effective: EffectiveZone;
  if (user) {
    effective = resolveEffectiveZone(loadTemporalContext(user.userId, home), {
      now,
      deviceId: input.deviceId,
      sessionId: input.sessionId,
    });
  } else {
    const zone = DEFAULT_TIMEZONE;
    effective = {
      zone,
      source: "fallback",
      confidence: "low",
      homeZone: zone,
      contextVersion: 0,
      stale: false,
      uncertain: true,
      awayFromHomeSupported: false,
      notes: [
        input.userId
          ? `user "${input.userId}" not found in the registry — showing ${zone} as a labelled default, not their known zone`
          : `no user bound to this turn — showing ${zone} as a labelled default`,
      ],
    };
  }
  if (!isValidTimeZone(effective.zone)) {
    effective = { ...effective, zone: DEFAULT_TIMEZONE, source: "fallback", uncertain: true, notes: [...effective.notes, "configured zone invalid — labelled default used"] };
  }
  const zone = effective.zone;

  // ── Conversation ──
  const timeline = user ? readTemporalEvents(user.userId, { until: new Date(nowMs + 5_000), agent }) : [];
  if (timeline.length) sources.push("timeline");
  const inStamps: Stamp[] = [];
  const outStamps: Stamp[] = [];
  for (const ev of timeline) {
    const t = Date.parse(ev.occurredAtUtc);
    if (ev.type === "user_message_received") inStamps.push({ t, src: "timeline" });
    if (ev.type === "assistant_response_emitted") outStamps.push({ t, src: "timeline" });
  }
  if (user && agent) {
    try {
      const msgs = quiet(() => getMessagesForUser(agent, user.userId, 60));
      if (msgs.length) sources.push("messages");
      for (const m of msgs) {
        const t = Date.parse(m.timestamp);
        if (!Number.isFinite(t) || t > nowMs + 5_000) continue;
        (m.direction === "in" ? inStamps : outStamps).push({ t, src: "messages" });
      }
    } catch {
      // message store unreadable — timeline alone
    }
  }
  const ins = mergeStamps(inStamps);
  const outs = mergeStamps(outStamps).filter((s) => s.t <= nowMs);
  const lastOut = outs[outs.length - 1];

  // The current message: a timeline stamp written moments ago by the gateway
  // for this very turn; else the newest inbound Michael has not answered yet
  // (a queued message can wait behind a long turn); else the hook's own clock.
  let current: number = nowMs;
  const latestIn = ins.filter((s) => s.t <= nowMs + 5_000).pop();
  if (latestIn && latestIn.src === "timeline" && nowMs - latestIn.t <= CURRENT_TIMELINE_WINDOW_MS) {
    current = Math.min(latestIn.t, nowMs);
  } else if (latestIn && (!lastOut || latestIn.t > lastOut.t) && nowMs - latestIn.t <= CURRENT_QUEUED_WINDOW_MS) {
    current = Math.min(latestIn.t, nowMs);
  }
  const priorIn = ins.filter((s) => s.t < current - 5_000).pop();
  const priorOut = outs.filter((s) => s.t <= current).pop();

  const responseGapMs = priorOut ? current - priorOut.t : undefined;
  const userMessageGapMs = priorIn ? current - priorIn.t : undefined;
  const lastExchange = Math.max(priorOut?.t ?? -Infinity, priorIn?.t ?? -Infinity);
  const gapForClass = Number.isFinite(lastExchange) ? current - lastExchange : undefined;
  const crossed = Number.isFinite(lastExchange) ? localDayDiff(new Date(lastExchange), new Date(current), zone) > 0 : false;
  const continuity = classifyGap(gapForClass, crossed);

  let sessionStartedAtUtc = readSessionStart(input.transcriptPath);
  if (sessionStartedAtUtc) sources.push("transcript");
  if (!sessionStartedAtUtc && input.sessionId) {
    const first = timeline.find((e) => e.sessionId === input.sessionId);
    if (first) sessionStartedAtUtc = first.occurredAtUtc;
  }

  // ── Activity ──
  const work: TemporalEvent[] = user ? readTemporalEvents(user.userId, { until: now, types: WORK_EVENT_TYPES }) : [];
  let builds: BuildTiming[] = [];
  if (user && foremanVisibleTo(user.userId)) {
    builds = input.builds ?? readForemanBuilds({ limit: 40 });
    if (builds.length) sources.push("foreman");
    work.push(...foremanBuildEvents(builds, user.userId).filter((e) => Date.parse(e.occurredAtUtc) <= nowMs));
  }
  work.sort((a, b) => Date.parse(a.occurredAtUtc) - Date.parse(b.occurredAtUtc));
  const lastWork = work[work.length - 1];
  const completed = [...work].reverse().find((e) => e.type === "builder_completed" || e.type === "deploy_completed" || e.type === "review_completed");
  const openBuild = [...builds]
    .reverse()
    .find((b) => b.open && b.startedAtUtc && Date.parse(b.startedAtUtc) <= nowMs && nowMs - Date.parse(b.lastEventAtUtc ?? b.startedAtUtc) <= OPEN_JOB_MAX_AGE_MS);
  let activeJob: { start: string; label: string; lastSignal?: string } | undefined = openBuild
    ? { start: openBuild.startedAtUtc!, label: `${openBuild.name} (${openBuild.agent ?? "builder"})`, lastSignal: openBuild.lastEventAtUtc }
    : undefined;
  if (!activeJob) {
    const ended = new Set(work.filter((e) => e.taskId && /completed|failed|cancelled/.test(e.type)).map((e) => e.taskId));
    const started = [...work].reverse().find((e) => e.type === "builder_started" && e.taskId && !ended.has(e.taskId) && nowMs - Date.parse(e.occurredAtUtc) <= OPEN_JOB_MAX_AGE_MS);
    if (started) activeJob = { start: started.occurredAtUtc, label: started.label ?? started.taskId ?? "job" };
  }

  const envelope: TemporalEnvelope = {
    version: 1,
    generatedAtUtc: now.toISOString(),
    user: {
      userId,
      timezone: zone,
      localNow: toLocalIso(now, zone),
      utcOffsetMinutes: zoneOffsetMinutes(now, zone),
      locationLabel: effective.homeLabel ?? user?.locationLabel,
      homeTimezone: effective.homeZone,
      timezoneSource: effective.source,
      contextVersion: effective.contextVersion,
      observationAgeMs: effective.observationAgeMs,
      currentLocation: effective.currentLocation ?? "unknown",
      uncertain: effective.uncertain,
    },
    conversation: {
      agent,
      sessionId: input.sessionId ?? undefined,
      sessionStartedAtUtc,
      lastUserMessageAtUtc: priorIn ? new Date(priorIn.t).toISOString() : undefined,
      lastAssistantMessageAtUtc: priorOut ? new Date(priorOut.t).toISOString() : undefined,
      currentUserMessageAtUtc: new Date(current).toISOString(),
      responseGapMs,
      userMessageGapMs,
      assistantSilenceMs: lastOut ? nowMs - lastOut.t : undefined,
      sessionAgeMs: sessionStartedAtUtc ? nowMs - Date.parse(sessionStartedAtUtc) : undefined,
      continuity,
      crossedLocalMidnight: crossed,
    },
    activity: {
      lastWorkEventAtUtc: lastWork?.occurredAtUtc,
      lastWorkEventLabel: lastWork ? `${lastWork.type.replace(/_/g, " ")}${lastWork.label ? ` — ${lastWork.label}` : ""}` : undefined,
      lastCompletedWorkAtUtc: completed?.occurredAtUtc,
      lastCompletedWorkLabel: completed?.label,
      activeJobStartedAtUtc: activeJob?.start,
      activeJobElapsedMs: activeJob ? nowMs - Date.parse(activeJob.start) : undefined,
      activeJobLabel: activeJob?.label,
      activeJobLastSignalAtUtc: activeJob?.lastSignal,
      workGapMs: lastWork ? nowMs - Date.parse(lastWork.occurredAtUtc) : undefined,
    },
  };
  return {
    envelope,
    user,
    effective,
    telemetry: {
      zone,
      offsetMinutes: envelope.user.utcOffsetMinutes,
      zoneSource: effective.source,
      continuity,
      sources,
      eventReadErrors: temporalEventStats.readErrors - readErrorsBefore,
    },
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const CONTINUITY_TEXT: Record<Continuity, string> = {
  active: "active exchange",
  brief_pause: "brief pause",
  resumed: "RESUMED after a break — not one continuous exchange",
  new_context: "NEW temporal context (long gap or a new local day) — re-orient before continuing",
};

function at(iso: string | undefined, now: Date, zone: string): string {
  if (!iso) return "unknown";
  return relativeDayLabel(new Date(iso), now, zone);
}

/**
 * Today / yesterday / tomorrow, and where "tonight" begins, in the effective
 * zone. With `workdayFor` (a user the workday rule covers, by display name),
 * the 12–4 AM carryover window gets the workday frame instead (workday.ts).
 */
export function dayFrameLine(now: Date, zone: string, workdayFor?: string | null): string {
  const workday = workdayFor ? workdayFrameLine(now, zone, workdayFor) : null;
  if (workday) return workday;
  const p = localParts(now, zone);
  const noonOf = (d: { year: number; month: number; day: number }) => wallTimeToUtc({ ...d, hour: 12, minute: 0 }, zone);
  const today = formatDayName(now, zone);
  const yesterday = formatDayName(noonOf(addLocalDays(p, -1)), zone);
  const tomorrow = formatDayName(noonOf(addLocalDays(p, 1)), zone);
  const h = p.hour;
  const part = h < 5 ? "after midnight now (still \"tonight\" for the evening before; \"this morning\" starts at dawn)" : `${h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night"} now`;
  return `today = ${today} · yesterday = ${yesterday} · tomorrow = ${tomorrow} · it is ${part}`;
}

function zoneLine(eff: EffectiveZone): string {
  const parts: string[] = [];
  const src: Record<EffectiveZone["source"], string> = {
    override: "manual override",
    statement: "user's own statement",
    device: "confirmed device timezone",
    home: "home default",
    fallback: "LABELLED FALLBACK (zone not established)",
  };
  parts.push(`${src[eff.source]}${eff.homeLabel && eff.source === "home" ? ` (${eff.homeLabel})` : ""} · context v${eff.contextVersion}`);
  if (eff.zone !== eff.homeZone) parts.push(`home is ${eff.homeZone}${eff.homeLabel ? ` (${eff.homeLabel})` : ""}`);
  if (eff.observationAgeMs !== undefined) parts.push(`observed ${formatDuration(eff.observationAgeMs)} ago`);
  if (eff.currentLocation) parts.push(`current location (${eff.currentLocation.source}): ${eff.currentLocation.label}`);
  else if (eff.zone !== eff.homeZone) parts.push("current location unknown");
  for (const n of eff.notes) parts.push(n);
  return parts.join(" · ");
}

export function renderConversationLine(env: TemporalEnvelope, userName: string, agentName: string, now: Date): string {
  const z = env.user.timezone;
  const c = env.conversation;
  const bits: string[] = [];
  bits.push(`${userName}'s current message: ${formatClockZ(new Date(c.currentUserMessageAtUtc), z)}`);
  bits.push(
    c.responseGapMs !== undefined
      ? `${agentName}'s last reply was ${formatDuration(c.responseGapMs)} before it (${at(c.lastAssistantMessageAtUtc, now, z)})`
      : `no earlier ${agentName} reply on record (gap unknown — do not assume continuity)`,
  );
  if (c.userMessageGapMs !== undefined) bits.push(`${userName}'s previous message was ${at(c.lastUserMessageAtUtc, now, z)} (${formatDuration(c.userMessageGapMs)} before this one)`);
  bits.push(`→ ${CONTINUITY_TEXT[c.continuity]}`);
  if (c.crossedLocalMidnight) bits.push("the local date changed since the last exchange");
  if (c.sessionStartedAtUtc) {
    bits.push(`this session started ${at(c.sessionStartedAtUtc, now, z)} (${formatDuration(c.sessionAgeMs ?? 0)} ago) — an open session is not continuous activity`);
  }
  return bits.join(" · ");
}

export function renderActivityLine(env: TemporalEnvelope, now: Date): string | null {
  const z = env.user.timezone;
  const a = env.activity;
  const bits: string[] = [];
  if (a.activeJobStartedAtUtc) {
    const sig = a.activeJobLastSignalAtUtc ? ` · last builder signal ${formatDuration(now.getTime() - Date.parse(a.activeJobLastSignalAtUtc))} ago` : "";
    bits.push(`open job: ${a.activeJobLabel} started ${at(a.activeJobStartedAtUtc, now, z)}, ${formatDuration(a.activeJobElapsedMs ?? 0)} elapsed${sig} (open ≠ progressing)`);
  }
  if (a.lastWorkEventAtUtc) bits.push(`last work event: ${a.lastWorkEventLabel}, ${at(a.lastWorkEventAtUtc, now, z)} (${formatDuration(a.workGapMs ?? 0)} ago)`);
  if (a.lastCompletedWorkAtUtc && a.lastCompletedWorkAtUtc !== a.lastWorkEventAtUtc) {
    bits.push(`last completed: ${a.lastCompletedWorkLabel ?? "work"}, ${at(a.lastCompletedWorkAtUtc, now, z)}`);
  }
  return bits.length ? bits.join(" · ") : null;
}

/**
 * The standing rules (§4.5). Compact on purpose — they ride every turn.
 * Rule 1 names the failure this build was opened for: the host clock is UTC.
 */
export function temporalRules(userName: string, zone: string): string {
  return [
    `### Time rules (authoritative — override anything else about time)`,
    `1. Unqualified dates/times mean ${userName}'s zone (${zone}). This server, its shell (\`date\`, \`date -u\`), logs, file mtimes, git and the runtime's own "today's date" are UTC — ALWAYS convert to ${userName}'s zone before speaking, in 12-hour AM/PM ("1:52 PM", never "17:52" or "13:52"). Never show UTC or 24-hour time to ${userName} unless he asks for it; labeling a raw UTC stamp "UTC" is NOT a conversion. Never answer "what time is it" from a tool clock; use **Now** above.`,
    `2. This block outranks memory: relative words inside retrieved sessions ("tonight", "earlier", "tomorrow") belong to THAT session's time, not now.`,
    `3. An open thread is not continuous activity. Use the gaps above; say "you're back after 5 hours" when it matters, with the exact duration.`,
    `4. When work happened ≠ when the discussion started. Morning work stays "this morning" even if the thread runs into the evening.`,
    `5. Resolve "this morning / tonight / yesterday" from the day frame above and the event's own timestamp. If a timestamp is unknown, say the timing is unknown — never invent one.`,
    `6. Scheduling: give a duration and a local finish window ("20–40 min, around 2:20–2:40 PM"), not "tonight"/"later", whenever a duration is knowable. "How long" means agent-driven wall-clock by default.`,
  ].join("\n");
}

/** Minified, undefined-free JSON of the envelope — the machine-readable copy. */
export function envelopeJson(env: TemporalEnvelope): string {
  return JSON.stringify(env, (_k, v) => (v === undefined ? undefined : v));
}

export interface RenderOptions {
  userName: string;
  agentName: string;
  now: Date;
  /**
   * Also inject the machine-readable JSON copy. Off by default — it repeats the
   * lines above (~300 tokens a turn); adapters read it from the API instead.
   * AHI_TEMPORAL_ENVELOPE_JSON=on turns it on.
   */
  includeJson?: boolean;
}

/** The lines the enhanced block adds below the Gregorian/Hebrew lines. */
export function renderEnvelopeLines(result: EnvelopeResult, opts: RenderOptions): string[] {
  const { envelope: env, effective } = result;
  const { now } = opts;
  const z = env.user.timezone;
  const lines: string[] = [];
  lines.push(`**Now (authoritative):** ${formatLocalFull(now, z)}`);
  lines.push(`**Day frame:** ${dayFrameLine(now, z, workdayRuleApplies(env.user.userId) ? opts.userName : null)}`);
  lines.push(`**Timezone source:** ${zoneLine(effective)}`);
  lines.push(`**Conversation:** ${renderConversationLine(env, opts.userName, opts.agentName, now)}`);
  const activity = renderActivityLine(env, now);
  if (activity) lines.push(`**Work timing:** ${activity}`);
  lines.push(temporalRules(opts.userName, z));
  const json = opts.includeJson ?? (process.env.AHI_TEMPORAL_ENVELOPE_JSON ?? "").trim().toLowerCase() === "on";
  if (json) lines.push(`<temporal-envelope>${envelopeJson(env)}</temporal-envelope>`);
  return lines;
}
