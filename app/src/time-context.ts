import {
  HebrewCalendar,
  HDate,
  Location,
  OmerEvent,
  Zmanim,
  flags,
  type Event,
  getSedra,
} from "@hebcal/core";
import {
  buildEtaBlock,
  etaEnabled,
  isEtaQuestion,
  readEtaRecords,
} from "./eta-calibration.js";
import {
  DEFAULT_TIMEZONE,
  addLocalDays,
  formatClock,
  formatClockZ,
  formatLocalFull,
  isValidTimeZone,
  localParts as zoneParts,
  nextLocalOccurrence,
  toLocalIso,
  wallTimeToUtc,
  zoneAbbreviation,
  zoneOffsetMinutes,
  type NextOccurrenceOptions,
} from "./local-time.js";
import { getMessagesForUser } from "./message-store.js";
import { loadTemporalContext, resolveEffectiveZone, type EffectiveZone } from "./temporal-context-store.js";
import {
  buildTemporalEnvelope,
  renderEnvelopeLines,
  safeLookupUser,
  type EnvelopeTelemetry,
  type TemporalEnvelope,
} from "./temporal-envelope.js";
import { foremanVisibleTo, readForemanBuilds, type BuildTiming } from "./temporal-events.js";
import type { UserConfig } from "./users.js";
import { CANDLE_MINS_BEFORE_SUNSET, HOLY_END_TZEIT_DEGREES, holyEndFrom, holyEndRule, holyEndSunsetMins, type HolyEndRule, type HolyEndTime } from "./zmanim-rule.js";
import type { MessageEvent } from "./websocket.js";
import { workdayFrameLine, workdayRuleApplies } from "./workday.js";

export { nextLocalOccurrence, type NextOccurrenceOptions } from "./local-time.js";
// The one end-of-Shabbat/Yom Tov rule (Rabbeinu Tam, 72 min).
export { DEFAULT_HOLY_END_SUNSET_MINS, holyEndRule, holyEndSunsetMins, type HolyEndRule } from "./zmanim-rule.js";

// When a user has no known location: New York (setup asks for the real one).
const DEFAULT_LOCATION_LABEL = "New York, NY";
const DEFAULT_PLACE = new Location(40.7128, -74.006, false, DEFAULT_TIMEZONE, DEFAULT_LOCATION_LABEL);
const BROOKLYN = new Location(40.6782, -73.9442, false, DEFAULT_TIMEZONE, "Brooklyn");
const CURRENT_TURN_GRACE_MS = 15_000;

const DAYS = [
  ["Yom Rishon", "יום ראשון"],
  ["Yom Sheni", "יום שני"],
  ["Yom Shlishi", "יום שלישי"],
  ["Yom Revi'i", "יום רביעי"],
  ["Yom Chamishi", "יום חמישי"],
  ["Yom Shishi", "יום שישי"],
  ["Shabbat Kodesh", "שבת קודש"],
] as const;

const SEFIROT = [
  { en: "Chesed", he: "חסד" },
  { en: "Gevurah", he: "גבורה" },
  { en: "Tiferet", he: "תפארת" },
  { en: "Netzach", he: "נצח" },
  { en: "Hod", he: "הוד" },
  { en: "Yesod", he: "יסוד" },
  { en: "Malchut", he: "מלכות" },
] as const;

function quiet<T>(fn: () => T): T {
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

function localParts(now: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayNames: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdayNames[get("weekday")] ?? now.getDay(),
  };
}

function localNoonDate(now: Date, timezone: string): Date {
  const p = localParts(now, timezone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
}

function formatGregorian(now: Date, timezone: string, locationLabel: string | null): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
  const place = locationLabel ? `, ${locationLabel}` : "";
  return `${date} — ${time} (${timezone}${place})`;
}

function formatHebrewDate(hd: HDate): string {
  const monthName = hd.getMonthName() === "Iyyar" ? "Iyar" : hd.getMonthName();
  const rendered = hd.renderGematriya();
  const plain = rendered
    .normalize("NFD")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/\u05F4/g, "\"")
    .replace(/\u05F3/g, "'");
  return `${plain} (${hd.getDate()} ${monthName} ${hd.getFullYear()})`;
}

function cloneLocation(base: Location, timezone: string, label: string): Location {
  return new Location(base.getLatitude(), base.getLongitude(), false, timezone, label);
}

function normalizedLocationLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function knownLocation(label: string, timezone: string): Location | null {
  const normalized = normalizedLocationLabel(label);
  if (["brooklyn", "brooklyn, ny", "brooklyn, new york"].includes(normalized)) {
    return cloneLocation(BROOKLYN, timezone, "Brooklyn");
  }
  return null;
}

function hebcalLocation(user: UserConfig | null): Location {
  if (!user) return DEFAULT_PLACE;
  const known = knownLocation(user.locationLabel, user.timezone);
  if (known) return known;
  const found = Location.lookup(user.locationLabel);
  if (found) return found;
  return cloneLocation(DEFAULT_PLACE, user.timezone, user.locationLabel);
}

function locationAssumptionLine(user: UserConfig): string | null {
  const label = (user.locationLabel ?? "").trim();
  if (!label) return null;
  return `**Location assumption:** ${user.name} is based in ${label}. Assume ${label} unless ${user.name} says, or context clearly shows, that they are somewhere else.`;
}

function eventsForDay(now: Date, location: Location): Event[] {
  return HebrewCalendar.calendar({
    start: now,
    end: now,
    location,
    candlelighting: true,
    havdalahMins: holyEndSunsetMins(),
    omer: true,
    sedrot: true,
  });
}

function parshaFor(now: Date, timezone: string): string | null {
  const hd = new HDate(localNoonDate(now, timezone));
  const sedra = getSedra(hd.getFullYear(), false);
  const found = sedra.lookup(hd);
  return found?.parsha?.join("-") ?? null;
}

function omerLine(events: Event[]): string | null {
  const omer = events.find((ev): ev is OmerEvent => ev instanceof OmerEvent);
  if (!omer) return null;
  const day = omer.omer;
  const inner = SEFIROT[(day - 1) % 7];
  const outer = SEFIROT[Math.floor((day - 1) / 7)];
  return `Day ${day} — ${inner.he} שב${outer.he} (${inner.en} of ${outer.en})`;
}

function formatEventTime(time: string | undefined): string | null {
  if (!time) return null;
  const [hourRaw, minute] = time.split(":");
  const hour = Number(hourRaw);
  if (!Number.isFinite(hour) || !minute) return null;
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${minute} ${suffix}`;
}

function candleLightingLine(events: Event[], now: Date, timezone: string): string | null {
  const local = localParts(now, timezone);
  if (local.weekday !== 5 || local.hour < 12) return null;
  const ev = events.find((event) => event.constructor.name === "CandleLightingEvent");
  const time = formatEventTime((ev as { eventTimeStr?: string } | undefined)?.eventTimeStr);
  return time ? `**Candle lighting:** ${time}` : null;
}

function shabbatOrYomTovLine(now: Date, timezone: string, location: Location): string | null {
  const local = localParts(now, timezone);
  if (local.weekday !== 6) return null;
  // The shown havdalah time is the gateway's one block-end rule (zmanim-rule.ts:
  // max(tzeit 8.5°, sunset + 72 min), rounded up) — the same instant
  // isShabbatOrYomTov / holyBlockEnd use, so what Michael says and what
  // review-desk schedules can never disagree.
  const end = holyEndOn(local, location);
  if (!end) return null;
  return `**Today is Shabbat Kodesh — no work-related actions until havdalah at ${formatClock(end.at, timezone)}**`;
}

function lastUserMessage(user: UserConfig, now: Date): MessageEvent | null {
  const cutoff = now.getTime() - CURRENT_TURN_GRACE_MS;
  const messages = quiet(() => user.agents.flatMap((agent) => getMessagesForUser(agent, user.userId, 20)));
  const prior = messages
    .filter((msg) => msg.direction === "in")
    .filter((msg) => {
      const ts = Date.parse(msg.timestamp);
      return Number.isFinite(ts) && ts < cutoff;
    })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return prior[0] ?? null;
}

function elapsedLine(user: UserConfig, now: Date): string | null {
  const msg = lastUserMessage(user, now);
  if (!msg) return null;
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(msg.timestamp));
  const minutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const text =
    days >= 1
      ? `${days} days ago`
      : hours >= 1
        ? `${hours}h ${minutes % 60}m ago`
        : `${Math.max(1, minutes)}m ago`;
  const tag =
    minutes < 30
      ? "active conversation"
      : minutes <= 6 * 60
        ? "resuming after a break"
        : "likely a new conversation";
  return `**Last user message:** ${text} (${tag})`;
}

interface MomentOptions {
  /** Zone that governs this turn (the user's effective zone). Defaults to their home zone. */
  timezone?: string;
  /** Effective zone resolution; when present, location-dependent lines respect travel. */
  effective?: EffectiveZone;
  /** Legacy "Last user message" line (replaced by the envelope's event-derived gaps). */
  includeLegacyElapsed?: boolean;
  /** Add a Yom Tov line (the legacy block only knew Shabbat). */
  includeYomTov?: boolean;
  /** Add the workday line in the 12–4 AM window (the enhanced block carries it in its Day frame instead). */
  includeWorkday?: boolean;
}

function momentLines(user: UserConfig | null, now: Date, opts: MomentOptions): string[] {
  const homeZone = user?.timezone ?? DEFAULT_TIMEZONE;
  const timezone = opts.timezone ?? homeZone;
  const awayZone = timezone !== homeZone;
  // Candle-lighting / havdalah are computed for the HOME location. When the
  // governing zone differs from home and no current location is known, those
  // times would be fabricated for wherever the user actually is — omit them.
  const locationTimesValid = !awayZone;
  const locationLabel = awayZone ? null : (user?.locationLabel ?? null);
  const location = hebcalLocation(user);
  const hd = new HDate(localNoonDate(now, timezone));
  const events = eventsForDay(now, location);
  const local = localParts(now, timezone);
  const day = DAYS[local.weekday];

  const lines = [
    "## Current Moment",
    `**Gregorian:** ${formatGregorian(now, timezone, locationLabel)}`,
  ];

  if (user) {
    if (opts.effective?.awayFromHomeSupported && opts.effective.currentLocation) {
      lines.push(
        `**Location:** home base ${user.locationLabel} (${homeZone}); currently ${opts.effective.currentLocation.label} (${opts.effective.currentLocation.source === "statement" ? "the user said so" : "consented location"}).`,
      );
    } else {
      const locationAssumption = locationAssumptionLine(user);
      if (locationAssumption) lines.push(locationAssumption);
    }
  }

  // The Jewish calendar (Hebrew date, Shabbat, parsha, omer, candle-lighting, Yom Tov) is opt-in:
  // the user's jewishCalendar choice, or AHI_JEWISH_CALENDAR=true for everyone. Plain weekday otherwise.
  const jewish = process.env.AHI_JEWISH_CALENDAR === "true" || user?.jewishCalendar === true;
  if (jewish) lines.push(`**Hebrew:** ${formatHebrewDate(hd)}`);

  if (!user) return lines;

  const sacredDay = jewish && locationTimesValid ? shabbatOrYomTovLine(now, timezone, location) : null;
  if (sacredDay) {
    lines.push(sacredDay);
  } else {
    lines.push(jewish ? `**Yom-of-week:** ${day[0]} (${day[1]})` : `**Day:** ${day[0]}`);
  }

  if (opts.includeWorkday !== false && workdayRuleApplies(user.userId)) {
    const workday = workdayFrameLine(now, timezone, user.name);
    if (workday) lines.push(`**Day frame:** ${workday}`);
  }

  const parsha = jewish ? parshaFor(now, timezone) : null;
  if (parsha) lines.push(`**Parsha:** ${parsha} (current week, read this coming Shabbat)`);

  const omer = jewish ? omerLine(events) : null;
  if (omer) lines.push(`**Omer:** ${omer}`);

  const candle = jewish && locationTimesValid ? candleLightingLine(events, now, timezone) : null;
  if (candle) lines.push(candle);

  if (jewish && opts.includeYomTov) {
    const status = shabbatOrYomTovAt(now, location, timezone);
    if (status.active && status.kind !== "shabbat" && locationTimesValid) {
      lines.push(`**Yom Tov now:** ${status.names.join(", ")} — until about ${formatClockZ(new Date(status.endsAtUtc!), timezone)}`);
    }
  }

  if (jewish && !locationTimesValid) {
    lines.push(
      `**Location-dependent times:** not shown — candle-lighting/havdalah are known for home (${user.locationLabel}), and this turn runs in ${timezone} with no confirmed current location.`,
    );
  }

  if (opts.includeLegacyElapsed !== false) {
    const last = elapsedLine(user, now);
    if (last) lines.push(last);
  }

  return lines;
}

/**
 * The original per-turn block, unchanged in output. Still the default: the
 * enhanced envelope is behind AHI_TEMPORAL_ENVELOPE and this stays available
 * as the rollback path (§10). One fix: a missing/unreadable users.json used to
 * throw out of here and take the whole hook down with it; it now degrades to
 * the user-less block.
 */
export function buildTimeContext(userId: string | null, now = new Date()): string {
  const user = safeLookupUser(userId);
  return momentLines(user, now, {}).join("\n");
}

// ── Enhanced per-turn context (feature-flagged) ───────────────────────────────

/**
 * AHI_TEMPORAL_ENVELOPE: unset/"off" → legacy block for everyone; "all" → every
 * agent; otherwise a comma list of agents ("michael"). Read per call, so the
 * hook (a new process per turn) always sees the live value.
 */
export function temporalEnvelopeEnabledFor(agent: string | null | undefined): boolean {
  const raw = (process.env.AHI_TEMPORAL_ENVELOPE ?? "").trim().toLowerCase();
  if (!raw || raw === "off" || raw === "false" || raw === "0") return false;
  if (raw === "all" || raw === "on" || raw === "true") return true;
  if (!agent) return false;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(agent.toLowerCase());
}

/** True when the gateway should write timeline events (any agent has the envelope on). */
export { temporalTimelineEnabled as temporalEventsEnabled } from "./temporal-events.js";

export interface TurnTimeContextInput {
  userId: string | null;
  agent?: string | null;
  now?: Date;
  prompt?: string | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
  deviceId?: string | null;
  /** Test seam: Foreman builds to use instead of reading the builds dir. */
  builds?: BuildTiming[];
}

export interface TurnTimeContext {
  text: string;
  mode: "legacy" | "enhanced";
  envelope?: TemporalEnvelope;
  telemetry?: EnvelopeTelemetry & { etaBlock: boolean };
}

function displayName(user: UserConfig | null): string {
  return user?.name ?? "the user";
}

function agentDisplayName(agent: string | null | undefined): string {
  if (!agent) return "the assistant";
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

/**
 * The block the hook injects. Legacy unless the envelope flag covers this
 * agent; never throws (any failure falls back to the legacy block, and that
 * to the user-less block).
 */
export function buildTurnTimeContext(input: TurnTimeContextInput): TurnTimeContext {
  const now = input.now ?? new Date();
  if (!temporalEnvelopeEnabledFor(input.agent)) {
    return { text: buildTimeContext(input.userId, now), mode: "legacy" };
  }
  try {
    const user = safeLookupUser(input.userId);
    const builds =
      input.builds ?? (user && foremanVisibleTo(user.userId) ? readForemanBuilds({ limit: 40 }) : []);
    const result = buildTemporalEnvelope({
      userId: input.userId,
      agent: input.agent,
      now,
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath,
      deviceId: input.deviceId,
      builds,
    });
    const lines = momentLines(result.user, now, {
      timezone: result.envelope.user.timezone,
      effective: result.effective,
      includeLegacyElapsed: false,
      includeYomTov: true,
      includeWorkday: false,
    });
    lines.push(
      ...renderEnvelopeLines(result, {
        userName: displayName(result.user),
        agentName: agentDisplayName(input.agent),
        now,
      }),
    );
    let etaBlock = false;
    if (etaEnabled() && isEtaQuestion(input.prompt)) {
      const allBuilds = user && foremanVisibleTo(user.userId) ? (input.builds ?? readForemanBuilds()) : [];
      lines.push(
        "",
        buildEtaBlock({
          prompt: input.prompt ?? "",
          now,
          timeZone: result.envelope.user.timezone,
          userName: displayName(result.user),
          builds: allBuilds,
          records: readEtaRecords(),
        }),
      );
      etaBlock = true;
    }
    return { text: lines.join("\n"), mode: "enhanced", envelope: result.envelope, telemetry: { ...result.telemetry, etaBlock } };
  } catch {
    return { text: buildTimeContext(input.userId, now), mode: "legacy" };
  }
}

// ── Stable API for other gateway modules (review-desk) ────────────────────────

export interface UserNow {
  instant: Date;
  utc: string;
  timeZone: string;
  /** "2026-10-07T17:58:00-04:00" */
  localIso: string;
  /** "2026-10-07" */
  localDate: string;
  /** "5:58 PM EDT" */
  localTime: string;
  offsetMinutes: number;
  abbreviation: string;
  /** Where the zone came from; "fallback" means the user is unknown (labelled default). */
  source: EffectiveZone["source"];
}

/** The zone that governs a user right now (home unless a stated/confirmed/override zone applies). */
export function userEffectiveZone(userId: string | null | undefined, now = new Date()): EffectiveZone {
  const user = safeLookupUser(userId ?? null);
  if (!user) {
    return {
      zone: DEFAULT_TIMEZONE,
      source: "fallback",
      confidence: "low",
      homeZone: DEFAULT_TIMEZONE,
      contextVersion: 0,
      stale: false,
      uncertain: true,
      awayFromHomeSupported: false,
      notes: ["unknown user — labelled default zone"],
    };
  }
  const eff = resolveEffectiveZone(loadTemporalContext(user.userId, { zone: user.timezone, label: user.locationLabel }), { now });
  return isValidTimeZone(eff.zone) ? eff : { ...eff, zone: DEFAULT_TIMEZONE, source: "fallback", uncertain: true };
}

/** The user's HOME zone — what scheduled jobs (digests, end-of-day close) should be pinned to. */
export function userHomeZone(userId: string | null | undefined): string {
  const user = safeLookupUser(userId ?? null);
  return user && isValidTimeZone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE;
}

export function nowInUserZone(userId: string | null | undefined, now = new Date()): UserNow {
  const eff = userEffectiveZone(userId, now);
  const zone = eff.zone;
  const p = zoneParts(now, zone);
  return {
    instant: now,
    utc: now.toISOString(),
    timeZone: zone,
    localIso: toLocalIso(now, zone),
    localDate: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
    localTime: formatClockZ(now, zone),
    offsetMinutes: zoneOffsetMinutes(now, zone),
    abbreviation: zoneAbbreviation(now, zone),
    source: eff.source,
  };
}

/**
 * Render an instant for a user in their effective zone.
 *   "full"  → "Wed, Oct 7, 2026, 5:58 PM EDT (UTC−04:00, America/New_York) = 2026-10-07T21:58Z"
 *   "clock" → "5:58 PM EDT"
 *   "iso"   → "2026-10-07T17:58:00-04:00"
 */
export function formatLocal(date: Date, userId: string | null | undefined, style: "full" | "clock" | "iso" = "full"): string {
  const zone = userEffectiveZone(userId, date).zone;
  if (style === "clock") return formatClockZ(date, zone);
  if (style === "iso") return toLocalIso(date, zone);
  return formatLocalFull(date, zone);
}

export interface SacredTimeStatus {
  active: boolean;
  kind: "shabbat" | "yom-tov" | "shabbat+yom-tov" | null;
  names: string[];
  /** Start/end of the CURRENT (or, when inactive, the next 8 days') sacred period, if any. */
  startsAtUtc?: string;
  endsAtUtc?: string;
  /** Location the times were computed for. */
  basis: string;
}

function holyDay(d: { year: number; month: number; day: number; weekday: number }, location: Location): { holy: boolean; shabbat: boolean; names: string[] } {
  const date = new Date(Date.UTC(d.year, d.month - 1, d.day, 12));
  const names = quiet(() =>
    HebrewCalendar.calendar({ start: date, end: date, location, il: false, candlelighting: false, noMinorFast: true, noModern: true, noRoshChodesh: true, noSpecialShabbat: true }),
  )
    .filter((ev) => (ev.getFlags() & flags.CHAG) !== 0)
    .map((ev) => ev.getDesc());
  return { holy: d.weekday === 6 || names.length > 0, shabbat: d.weekday === 6, names };
}

function sunsetOn(d: { year: number; month: number; day: number }, location: Location): Date | null {
  try {
    const s = new Zmanim(location, new Date(Date.UTC(d.year, d.month - 1, d.day, 12)), false).sunset();
    return Number.isFinite(s.getTime()) ? s : null;
  } catch {
    return null;
  }
}

/** The end of a holy day `d` under the one rule; null when sunset can't be computed. */
function holyEndOn(d: { year: number; month: number; day: number }, location: Location): HolyEndTime | null {
  const sunset = sunsetOn(d, location);
  if (!sunset) return null;
  let tzeit: Date | null = null;
  try {
    tzeit = new Zmanim(location, new Date(Date.UTC(d.year, d.month - 1, d.day, 12)), false).tzeit(HOLY_END_TZEIT_DEGREES);
  } catch {
    tzeit = null;
  }
  return holyEndFrom(sunset, tzeit);
}

/**
 * Is `instant` inside Shabbat or (diaspora) Yom Tov at `location`? A holy day
 * runs from candle-lighting (sunset − 18 min) on the evening before to the
 * block end under the one rule (zmanim-rule.ts: max(tzeit 8.5°, sunset + 72
 * min), rounded up). Consecutive holy days chain (Shabbat into Yom Tov, two-day chag).
 */
function shabbatOrYomTovAt(instant: Date, location: Location, timezone: string): SacredTimeStatus {
  const basis = location.getName() ?? "configured location";
  const t = instant.getTime();
  const today = zoneParts(instant, timezone);
  const window = (offset: number) => {
    const day = addLocalDays(today, offset);
    const info = holyDay(day, location);
    if (!info.holy) return null;
    const eve = sunsetOn(addLocalDays(today, offset - 1), location);
    const end = holyEndOn(day, location);
    if (!eve || !end) return null;
    return { ...info, start: eve.getTime() - CANDLE_MINS_BEFORE_SUNSET * 60_000, end: end.at.getTime() };
  };
  const windows = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8].map(window).filter((w): w is NonNullable<typeof w> => w !== null);
  // Merge adjacent/overlapping windows into periods.
  const periods: { start: number; end: number; shabbat: boolean; names: string[] }[] = [];
  for (const w of windows) {
    const last = periods[periods.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      last.shabbat ||= w.shabbat;
      last.names.push(...w.names);
    } else {
      periods.push({ start: w.start, end: w.end, shabbat: w.shabbat, names: [...w.names] });
    }
  }
  const kindOf = (p: { shabbat: boolean; names: string[] }): SacredTimeStatus["kind"] =>
    p.shabbat && p.names.length ? "shabbat+yom-tov" : p.shabbat ? "shabbat" : "yom-tov";
  const current = periods.find((p) => t >= p.start && t < p.end);
  if (current) {
    return {
      active: true,
      kind: kindOf(current),
      names: current.shabbat ? ["Shabbat", ...current.names] : current.names,
      startsAtUtc: new Date(current.start).toISOString(),
      endsAtUtc: new Date(current.end).toISOString(),
      basis,
    };
  }
  const next = periods.find((p) => p.start > t);
  return {
    active: false,
    kind: null,
    names: [],
    startsAtUtc: next ? new Date(next.start).toISOString() : undefined,
    endsAtUtc: next ? new Date(next.end).toISOString() : undefined,
    basis,
  };
}

/**
 * Shabbat / Yom Tov status for a user at an instant, computed at the user's
 * HOME location (the only location the gateway knows; see `basis`).
 */
export function shabbatOrYomTovStatus(date: Date, userId: string | null | undefined): SacredTimeStatus {
  const user = safeLookupUser(userId ?? null);
  const zone = user && isValidTimeZone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE;
  return shabbatOrYomTovAt(date, hebcalLocation(user), zone);
}

export function isShabbatOrYomTov(date: Date, userId: string | null | undefined): boolean {
  return shabbatOrYomTovStatus(date, userId).active;
}

export interface HolyBlockEnd {
  /** End of the whole contiguous Shabbat/Yom Tov block, under the one rule. */
  at: Date;
  atUtc: string;
  /** The rule applied — max(tzeit 8.5°, sunset + 72 min) unless overridden. */
  rule: HolyEndRule;
  /** Which side of the max decided this end ("sunset+offset" so far). */
  decidedBy: HolyEndTime["decidedBy"];
  /** True only when tzeit could not be computed, so only sunset + offset was checked. */
  approximate: boolean;
  /** When the block began (candle-lighting, sunset − 18 min, on the first erev). */
  startedAtUtc: string;
  /** "Shabbat", "Shmini Atzeret", "Simchat Torah", … across the whole block. */
  names: string[];
  /** Location the times were computed for. */
  basis: string;
}

/**
 * The end of the CURRENT contiguous Shabbat/Yom Tov block containing `date`,
 * or null when `date` is not inside one. Consecutive holy days are one block:
 * Yom Tov running into Shabbat, Shabbat into Yom Tov, or a two-day diaspora
 * chag all return a single end time. Computed at the user's home location
 * (New York when unknown).
 *
 * The block runs from candle-lighting (sunset − 18 min) on the first erev to
 * the end of its last day under the one rule (zmanim-rule.ts — the owner's
 * Rabbeinu Tam ruling: max(tzeit 8.5°, sunset + 72 min), rounded up). This is
 * the same instant `isShabbatOrYomTov` turns false at and the havdalah time
 * Michael shows, so the three can never disagree.
 */
export function holyBlockEnd(date: Date, userId: string | null | undefined): HolyBlockEnd | null {
  const user = safeLookupUser(userId ?? null);
  const zone = user && isValidTimeZone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE;
  const location = hebcalLocation(user);
  const t = date.getTime();
  const today = zoneParts(date, zone);
  // Scan from a few days back so a block that began earlier is found whole.
  const days = Array.from({ length: 14 }, (_, i) => addLocalDays(today, i - 4)).map((d) => ({ d, info: holyDay(d, location) }));
  for (let i = 0; i < days.length; i++) {
    if (!days[i].info.holy || (i > 0 && days[i - 1].info.holy)) continue; // only block starts
    let j = i;
    while (j + 1 < days.length && days[j + 1].info.holy) j++;
    const eve = sunsetOn(addLocalDays(days[i].d, -1), location);
    const end = holyEndOn(days[j].d, location);
    if (!eve || !end) continue;
    const start = eve.getTime() - CANDLE_MINS_BEFORE_SUNSET * 60_000;
    if (t >= start && t < end.at.getTime()) {
      const block = days.slice(i, j + 1);
      const names = [...new Set(block.flatMap((b) => (b.info.shabbat ? ["Shabbat", ...b.info.names] : b.info.names)))];
      return {
        at: end.at,
        atUtc: end.at.toISOString(),
        rule: holyEndRule(),
        decidedBy: end.decidedBy,
        approximate: end.tzeitUnavailable,
        startedAtUtc: new Date(start).toISOString(),
        names,
        basis: location.getName() ?? "configured location",
      };
    }
    i = j;
  }
  return null;
}

/**
 * Next local HH:MM on the given weekdays in the user's HOME zone (scheduled
 * jobs keep their declared zone; travel never silently reschedules them).
 * Pass `timeZone` explicitly to pin a different zone.
 */
export function nextUserOccurrence(
  userId: string | null | undefined,
  opts: Omit<NextOccurrenceOptions, "timeZone"> & { timeZone?: string },
): Date {
  return nextLocalOccurrence({ ...opts, timeZone: opts.timeZone ?? userHomeZone(userId) });
}

/** Re-exported so callers that only need zone math import one module. */
export { wallTimeToUtc };
