/**
 * workday.ts — the owner's day ends when he sleeps, not at midnight.
 *
 * A message between midnight and WORKDAY_ROLLOVER_HOUR (4 AM local) still
 * belongs to the evening before. Inside that carryover window:
 *
 *   "today" / "tonight" → the previous calendar day's workday, still going
 *   "tomorrow"          → later the SAME calendar day, after he wakes
 *   "yesterday"         → the day before the workday
 *
 * Outside the window the workday IS the calendar day and nothing changes.
 * Pure: no I/O, no clock — callers pass `now` and the zone. Shabbat / Yom Tov
 * timing is not this module's business (zmanim-rule.ts owns it).
 */
import { ownerUserId } from "./users.js";
import { addLocalDays, formatDayName, localParts, wallTimeToUtc } from "./local-time.js";

/** The one workday boundary: local hour at which a new day begins (4 AM). */
export const WORKDAY_ROLLOVER_HOUR = 4;

/** Whose per-turn time context carries the rule. The day close runs on it regardless (it is the owner's). */
export const WORKDAY_RULE_USERS: ReadonlySet<string> = new Set([ownerUserId()]);

export function workdayRuleApplies(userId: string | null | undefined): boolean {
  return !!userId && WORKDAY_RULE_USERS.has(userId.toLowerCase());
}

export type LocalDate = { year: number; month: number; day: number; weekday: number };

export interface Workday {
  /** True between midnight and the rollover hour: the calendar has turned, the day hasn't. */
  carryover: boolean;
  /** The workday's date — the previous calendar day while in carryover. */
  date: LocalDate;
  /** The calendar date at `now`. */
  calendar: LocalDate;
  /** When this workday began (rollover hour on `date`). */
  startsAt: Date;
}

export function workdayAt(now: Date, zone: string): Workday {
  const p = localParts(now, zone);
  const calendar = { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
  const carryover = p.hour < WORKDAY_ROLLOVER_HOUR;
  const date = carryover ? addLocalDays(calendar, -1) : calendar;
  return { carryover, date, calendar, startsAt: wallTimeToUtc({ ...date, hour: WORKDAY_ROLLOVER_HOUR, minute: 0 }, zone) };
}

export type RelativeDayWord = "today" | "tonight" | "tomorrow" | "yesterday";

/** The local date a relative day word means at `now`, under the workday rule. */
export function resolveRelativeDay(word: RelativeDayWord, now: Date, zone: string): LocalDate {
  const { date } = workdayAt(now, zone);
  if (word === "tomorrow") return addLocalDays(date, 1);
  if (word === "yesterday") return addLocalDays(date, -1);
  return addLocalDays(date, 0);
}

function rolloverLabel(): string {
  const h = WORKDAY_ROLLOVER_HOUR % 12 || 12;
  return `${h} ${WORKDAY_ROLLOVER_HOUR < 12 ? "AM" : "PM"}`;
}

/**
 * The Day frame for a carryover moment, or null outside the window (callers
 * then keep their ordinary frame). Spelled out so an agent cannot read
 * "tomorrow" as the day after the calendar date.
 */
export function workdayFrameLine(now: Date, zone: string, name: string): string | null {
  const wd = workdayAt(now, zone);
  if (!wd.carryover) return null;
  const noon = (d: LocalDate) => wallTimeToUtc({ ...d, hour: 12, minute: 0 }, zone);
  const workday = formatDayName(noon(wd.date), zone);
  const calendar = formatDayName(noon(wd.calendar), zone);
  const yesterday = formatDayName(noon(addLocalDays(wd.date, -1)), zone);
  const dayAfter = formatDayName(noon(addLocalDays(wd.calendar, 1)), zone);
  const weekday = workday.split(",")[0];
  return [
    `WORKDAY RULE — it is after midnight but before ${rolloverLabel()}, so it is still ${name}'s ${weekday} (his day ends when he sleeps, not at midnight)`,
    `today / tonight = ${workday} (the evening still going)`,
    `tomorrow = ${calendar} — later today on the calendar, after ${name} wakes, NOT ${dayAfter}`,
    `yesterday = ${yesterday}`,
    `the calendar date is already ${calendar}`,
  ].join(" · ");
}
