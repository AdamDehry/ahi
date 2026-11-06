/**
 * local-time.ts — timezone math for the temporal envelope, built only on
 * `Intl.DateTimeFormat` and IANA zone names. No hand-rolled offsets and no
 * dependence on the host's own timezone: this VPS runs Etc/UTC, and that is
 * exactly how Michael came to read `date -u` as the owner's clock (see REPORT.md).
 *
 * Every function takes an explicit IANA zone. Storage is always a UTC instant.
 */

export const DEFAULT_TIMEZONE = "America/New_York";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
      weekday: "short",
    });
    partsFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** True when `zone` is an IANA zone this runtime can render. */
export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (!zone || typeof zone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, in the local zone. */
  weekday: number;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/**
 * Offset of `timeZone` from UTC at `date`, in minutes (EDT = -240). Derived by
 * asking Intl what the wall clock reads and differencing — the zone database
 * does the DST work, we never encode a rule.
 */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const instant = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - instant) / MINUTE_MS);
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Short zone name as Intl renders it ("EDT", "EST", "GMT+2"). */
export function zoneAbbreviation(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/** "2026-10-07" in the local zone. */
export function localDateKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "5:58 PM" */
export function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

/** "5:58 PM EDT" */
export function formatClockZ(date: Date, timeZone: string): string {
  return `${formatClock(date, timeZone)} ${zoneAbbreviation(date, timeZone)}`;
}

/** "Wednesday, October 7" */
export function formatDayName(date: Date, timeZone: string, withYear = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
  }).format(date);
}

/** "Wed Oct 7" */
export function formatShortDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
}

/**
 * Full prompt-facing rendering: local date + time, zone abbreviation, offset,
 * IANA name, and the UTC instant — everything §4.1 requires on one line.
 * "Wed, Oct 7, 2026, 5:58 PM EDT (UTC−04:00, America/New_York) = 2026-10-07T21:58Z"
 */
export function formatLocalFull(date: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const off = formatOffset(zoneOffsetMinutes(date, timeZone));
  return `${day}, ${formatClockZ(date, timeZone)} (${off}, ${timeZone}) = ${formatUtcShort(date)}`;
}

/** "2026-10-07T21:58Z" — the UTC instant, minute precision, always dated. */
export function formatUtcShort(date: Date): string {
  return `${date.toISOString().slice(0, 16)}Z`;
}

/** ISO-8601 with the local offset ("2026-08-31T13:05:00-04:00"). */
export function toLocalIso(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const off = zoneOffsetMinutes(date, timeZone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export type Disambiguation = "earlier" | "later";

/**
 * The UTC instant at which the wall clock in `timeZone` reads the given local
 * date/time. DST-safe:
 *   - repeated hour (fall back): `earlier` (default) picks the first pass, `later` the second;
 *   - missing hour (spring forward): the time is moved forward by the gap
 *     (2:30 AM on spring-forward day → 3:30 AM EDT), matching Temporal's
 *     "compatible" behaviour.
 */
export function wallTimeToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string,
  disambiguation: Disambiguation = "earlier",
): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
  // Candidate offsets: whatever the zone uses a day either side of the target.
  const offsets = new Set<number>([
    zoneOffsetMinutes(new Date(naive - DAY_MS), timeZone),
    zoneOffsetMinutes(new Date(naive), timeZone),
    zoneOffsetMinutes(new Date(naive + DAY_MS), timeZone),
  ]);
  const matches: number[] = [];
  for (const off of offsets) {
    const candidate = naive - off * MINUTE_MS;
    const p = localParts(new Date(candidate), timeZone);
    if (
      p.year === local.year &&
      p.month === local.month &&
      p.day === local.day &&
      p.hour === local.hour &&
      p.minute === local.minute
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length) {
    matches.sort((a, b) => a - b);
    return new Date(disambiguation === "later" ? matches[matches.length - 1] : matches[0]);
  }
  // Nonexistent wall time (spring-forward gap): shift forward by the gap,
  // i.e. interpret with the offset in force BEFORE the transition.
  const before = zoneOffsetMinutes(new Date(naive - DAY_MS), timeZone);
  return new Date(naive - before * MINUTE_MS);
}

/** Local calendar date `days` after the local date of `date` (DST-safe — calendar, not 24h steps). */
export function addLocalDays(
  key: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(Date.UTC(key.year, key.month - 1, key.day + days, 12));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

/** Start of the local calendar day containing `date`, as a UTC instant. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const p = localParts(date, timeZone);
  return wallTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, timeZone);
}

/** Whole local calendar days between the dates of `a` and `b` (b − a). */
export function localDayDiff(a: Date, b: Date, timeZone: string): number {
  const pa = localParts(a, timeZone);
  const pb = localParts(b, timeZone);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / DAY_MS);
}

export interface NextOccurrenceOptions {
  /** Local wall-clock hour, 0–23. */
  hour: number;
  minute: number;
  /** Allowed local weekdays, 0 = Sunday … 6 = Saturday. Empty/omitted = every day. */
  weekdays?: readonly number[];
  timeZone: string;
  /** Search strictly after this instant. Defaults to now. */
  after?: Date;
  /** Fall-back hour handling for times that occur twice. Default `earlier`. */
  disambiguation?: Disambiguation;
}

/**
 * Next instant strictly after `after` at which the local clock in `timeZone`
 * reads HH:MM on one of `weekdays`. Steps by calendar day, not by 24h, so a
 * Mon/Wed/Fri 11:00 AM ET schedule stays at 11:00 AM local across both DST
 * transitions.
 */
export function nextLocalOccurrence(opts: NextOccurrenceOptions): Date {
  const { hour, minute, timeZone } = opts;
  if (!isValidTimeZone(timeZone)) throw new Error(`invalid IANA timezone: ${timeZone}`);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`invalid hour: ${hour}`);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error(`invalid minute: ${minute}`);
  const weekdays = opts.weekdays && opts.weekdays.length ? new Set(opts.weekdays) : null;
  if (weekdays && [...weekdays].some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error(`invalid weekdays: ${[...weekdays].join(",")}`);
  }
  const after = opts.after ?? new Date();
  const start = localParts(after, timeZone);
  for (let i = 0; i <= 8; i++) {
    const day = addLocalDays(start, i);
    if (weekdays && !weekdays.has(day.weekday)) continue;
    const candidate = wallTimeToUtc({ ...day, hour, minute }, timeZone, opts.disambiguation);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("nextLocalOccurrence: no occurrence within 8 days (unreachable for valid input)");
}

export type DayPart = "early morning" | "morning" | "afternoon" | "evening" | "night";

/** Local day-part. Night = 9 PM–5 AM, morning = 5 AM–noon, afternoon = noon–5 PM, evening = 5–9 PM. */
export function dayPart(date: Date, timeZone: string): DayPart {
  const h = localParts(date, timeZone).hour;
  if (h < 5) return "night";
  if (h < 12) return h < 7 ? "early morning" : "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

/**
 * How the owner would say when `event` happened, relative to `now`, in `timeZone`:
 * "this morning, 9:12 AM EDT", "last night, 11:40 PM EDT",
 * "yesterday afternoon, 3:05 PM EDT", "Mon Oct 5, morning, 9:00 AM EDT".
 * Anchored to the EVENT's local time, never to when the thread was last open —
 * a build done at 9 AM stays "this morning" at 4 PM (§3.4).
 */
export function relativeDayLabel(event: Date, now: Date, timeZone: string): string {
  const diff = localDayDiff(event, now, timeZone);
  const part = dayPart(event, timeZone);
  const clock = formatClockZ(event, timeZone);
  const h = localParts(event, timeZone).hour;
  if (event.getTime() > now.getTime()) {
    if (diff === 0) return `later today (${part}), ${clock}`;
    if (diff === -1) return `tomorrow ${part}, ${clock}`;
    return `${formatShortDay(event, timeZone)}, ${part}, ${clock}`;
  }
  if (diff === 0) {
    if (part === "night") return h < 5 ? `overnight (after midnight), ${clock}` : `tonight, ${clock}`;
    return `this ${part === "early morning" ? "morning (early)" : part}, ${clock}`;
  }
  if (diff === 1) {
    if (part === "night") return h < 5 ? `yesterday overnight (after midnight), ${clock}` : `last night, ${clock}`;
    return `yesterday ${part}, ${clock}`;
  }
  return `${formatShortDay(event, timeZone)}, ${part}, ${clock} (${diff} days ago)`;
}

/** "45s", "30m", "5h 2m", "1d 3h" — exact enough to reason with. */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, Math.round(ms));
  if (abs < MINUTE_MS) return `${Math.round(abs / 1000)}s`;
  const totalMin = Math.floor(abs / MINUTE_MS);
  if (totalMin < 60) return `${totalMin}m`;
  const totalH = Math.floor(totalMin / 60);
  if (totalH < 24) return totalMin % 60 ? `${totalH}h ${totalMin % 60}m` : `${totalH}h`;
  const d = Math.floor(totalH / 24);
  return totalH % 24 ? `${d}d ${totalH % 24}h` : `${d}d`;
}

export const DURATION = { MINUTE_MS, HOUR_MS, DAY_MS } as const;
