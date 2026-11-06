/**
 * clock.ts — wall-clock helpers for one named IANA zone (Intl only).
 *
 * WHY its own module: the review desk schedules by the owner's wall clock
 * ("Mon/Wed/Fri 11:00 AM America/New_York"), and DST must never shift a slot
 * by an hour. Everything here works on the NAMED zone through Intl, never a
 * fixed UTC offset.
 *
 * Swap seam: the parallel time-awareness build owns src/time-context.ts and
 * will export equivalent helpers. This file is the whole interface the review
 * desk uses (`localParts`, `zonedInstant`, `addLocalDays`, formatters) — point
 * these at that build's exports and nothing else in src/review/ changes.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday … 6 = Saturday
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
      weekday: "short",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of `instant` in `tz`. */
export function localParts(instant: Date, tz: string): LocalParts {
  const parts = partsFormatter(tz).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Offset of `tz` from UTC at `instant`, in minutes (EDT = -240, EST = -300). */
function offsetMinutes(instant: Date, tz: string): number {
  const p = partsFormatter(tz).formatToParts(instant);
  const get = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
}

/**
 * The instant at which the wall clock in `tz` reads year-month-day hh:mm.
 * DST-correct: the offset is taken at the target moment, not "now". A wall
 * time that does not exist (spring-forward gap) resolves to the instant just
 * after the gap; an ambiguous one (fall-back) resolves to the first pass.
 */
export function zonedInstant(tz: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - offsetMinutes(new Date(naive), tz) * 60_000;
  // Second pass settles guesses that straddled a transition.
  const off2 = offsetMinutes(new Date(guess), tz);
  guess = naive - off2 * 60_000;
  return new Date(guess);
}

/** Calendar date (y/m/d) `n` days after the local date of `instant` in `tz`. */
export function addLocalDays(instant: Date, tz: string, n: number): { year: number; month: number; day: number; weekday: number } {
  const p = localParts(instant, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n, 12));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

/** Start (00:00 local) of the local day containing `instant`. */
export function startOfLocalDay(instant: Date, tz: string): Date {
  const p = localParts(instant, tz);
  return zonedInstant(tz, p.year, p.month, p.day, 0, 0);
}

export function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function localIsoDate(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return isoDate(p.year, p.month, p.day);
}

/** "11:00 AM" */
export function fmtTime(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(instant);
}

/** "Wed Oct 7" */
export function fmtDay(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(instant);
}

/** "Wed" */
export function fmtWeekday(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(instant);
}

/** Parse "HH:MM" (24h). Throws on garbage — config errors should be loud. */
export function parseHHMM(s: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`bad time "${s}" (want HH:MM)`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`bad time "${s}"`);
  return { hour, minute };
}
