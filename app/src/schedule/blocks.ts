/**
 * blocks.ts — the week file turned into real instants. Pure: no clock, no
 * I/O; callers pass `now`, the dates and the Shabbat / Yom Tov windows.
 *
 *   - Each date's blocks are wall times in the week's zone, converted with
 *     wallTimeToUtc — the zone database does DST, we never add hours.
 *   - Shabbat and Yom Tov are laid OVER the week: a block inside a window is
 *     gone, a block that runs into one is cut at candle-lighting (Friday's
 *     "Shabbat prep" ends when Shabbat starts, whatever week it is), a block
 *     that straddles the end starts at nightfall. One block stands for the
 *     whole window. Weekday Yom Tov empties its day the same way.
 *   - "Today" is the owner's workday (workday.ts): until 4 AM it is still the
 *     evening before.
 */
import { addLocalDays, localParts, wallTimeToUtc } from "../local-time.js";
import { workdayAt, type LocalDate } from "../workday.js";
import { DAY_KEYS, parseHHMM, type WeekFile } from "./week.js";

export interface SacredWindow {
  start: Date;
  end: Date;
  /** "Shabbat", "Pesach & Shabbat", "Yom Kippur". */
  label: string;
}

export interface Block {
  /** Stable for a dated block: "2026-10-20@09:30"; a sacred window: "sacred@<start ISO>". */
  id: string;
  /** Local date the block starts on (YYYY-MM-DD). */
  date: string;
  title: string;
  short: string | null;
  kind: string;
  tags: string[];
  approx: boolean;
  detail: string | null;
  start: Date;
  end: Date;
  sacred: boolean;
  /** Cut short (or started late) by a Shabbat / Yom Tov window. */
  clipped: boolean;
}

export const dateKey = (d: { year: number; month: number; day: number }) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

export function parseDateKey(key: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return addLocalDays({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, 0);
}

/** The week's own blocks for one local date, before any sacred overlay. */
export function blocksForDate(week: WeekFile, date: LocalDate): Block[] {
  const defs = week.days[DAY_KEYS[date.weekday]] ?? [];
  const key = dateKey(date);
  const at = (hhmm: string) => {
    const p = parseHHMM(hhmm)!;
    return wallTimeToUtc({ year: date.year, month: date.month, day: date.day, hour: p.hour, minute: p.minute }, week.zone);
  };
  return defs.map((d, i) => ({
    id: `${key}@${d.start}`,
    date: key,
    title: d.title,
    short: d.short ?? null,
    kind: d.kind,
    tags: d.tags ?? [],
    approx: !!d.approx,
    detail: d.detail ?? null,
    start: at(d.start),
    end: at(i + 1 < defs.length ? defs[i + 1].start : week.dayEnd),
    sacred: false,
    clipped: false,
  }));
}

/** Lay the windows over the blocks: drop, cut, and add one block per window. */
export function overlaySacred(week: WeekFile, blocks: Block[], windows: SacredWindow[], zone = week.zone): Block[] {
  let out = blocks;
  for (const w of windows) {
    const ws = w.start.getTime();
    const we = w.end.getTime();
    const next: Block[] = [];
    for (const b of out) {
      const bs = b.start.getTime();
      const be = b.end.getTime();
      if (be <= ws || bs >= we) next.push(b);
      else if (bs < ws) next.push({ ...b, end: new Date(ws), clipped: true });
      else if (be > we) next.push({ ...b, start: new Date(we), clipped: true });
      // else: wholly inside — gone
    }
    out = next;
  }
  for (const w of windows) {
    out.push({
      id: `sacred@${w.start.toISOString()}`,
      date: dateKey(localParts(w.start, zone)),
      title: w.label === "Shabbat" ? week.shabbat.title : w.label,
      short: w.label === "Shabbat" ? week.shabbat.short ?? null : null,
      kind: week.shabbat.kind,
      tags: [],
      approx: false,
      detail: week.shabbat.detail ?? null,
      start: w.start,
      end: w.end,
      sacred: true,
      clipped: false,
    });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Blocks for `days` local dates from `first`, with the windows laid over. */
export function planDays(week: WeekFile, first: LocalDate, days: number, windows: SacredWindow[]): Block[] {
  const raw: Block[] = [];
  for (let i = 0; i < days; i++) raw.push(...blocksForDate(week, addLocalDays(first, i)));
  // Only windows that touch the span matter; one that started before it still cuts.
  const lo = wallTimeToUtc({ ...first, hour: 0, minute: 0 }, week.zone).getTime();
  const last = addLocalDays(first, days);
  const hi = wallTimeToUtc({ ...last, hour: 0, minute: 0 }, week.zone).getTime();
  const seen = new Set<number>();
  const touching = windows
    .filter((w) => w.end.getTime() > lo && w.start.getTime() < hi)
    .filter((w) => (seen.has(w.start.getTime()) ? false : (seen.add(w.start.getTime()), true)));
  return overlaySacred(week, raw, touching);
}

export function currentBlock(blocks: Block[], now: Date): Block | null {
  const t = now.getTime();
  return blocks.find((b) => b.start.getTime() <= t && t < b.end.getTime()) ?? null;
}

export function nextBlock(blocks: Block[], now: Date): Block | null {
  const t = now.getTime();
  return blocks.find((b) => b.start.getTime() > t) ?? null;
}

/** the owner's "today" (workday rule) and the Sunday that starts its week. */
export function todayAndWeek(now: Date, zone: string): { today: LocalDate; weekStart: LocalDate } {
  const { date } = workdayAt(now, zone);
  return { today: date, weekStart: addLocalDays(date, -date.weekday) };
}

/** A block's piece of one local day, in minutes from that day's midnight (0–1440), for laying out a column. */
export interface DaySegment {
  block: Block;
  startMin: number;
  endMin: number;
  /** The block began on an earlier day / runs past midnight. */
  continued: boolean;
  continues: boolean;
}

export function segmentsForDay(blocks: Block[], date: LocalDate, zone: string): DaySegment[] {
  const dayStart = wallTimeToUtc({ ...date, hour: 0, minute: 0 }, zone).getTime();
  const dayEnd = wallTimeToUtc({ ...addLocalDays(date, 1), hour: 0, minute: 0 }, zone).getTime();
  const wallMin = (t: number) => {
    const p = localParts(new Date(t), zone);
    return p.hour * 60 + p.minute;
  };
  return blocks
    .filter((b) => b.end.getTime() > dayStart && b.start.getTime() < dayEnd)
    .map((b) => {
      const continued = b.start.getTime() < dayStart;
      const continues = b.end.getTime() > dayEnd;
      return {
        block: b,
        startMin: continued ? 0 : wallMin(b.start.getTime()),
        endMin: continues ? 1440 : wallMin(b.end.getTime()) || 1440,
        continued,
        continues,
      };
    });
}
