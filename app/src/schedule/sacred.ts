/**
 * sacred.ts — Shabbat / Yom Tov windows for the calendar, from the review
 * desk's sacred-time module (hebcal + NOAA, home place, candle-lighting =
 * sunset − 18, nightfall = max(tzeit 8.5°, sunset + 72) — the owner's ruling).
 * One source for the whole gateway; nothing re-derived here.
 */
import { addLocalDays } from "../local-time.js";
import { HOME_PLACE, sacredTimeOn, windowEndingOn, type SacredPlace } from "../review/sacred-time.js";
import type { LocalDate } from "../workday.js";
import type { SacredWindow } from "./blocks.js";

/** Every window that ends on a date in [first − 1, first + days + 4] — enough to catch one that began before or ends after the span. */
export function sacredWindows(first: LocalDate, days: number, place: SacredPlace = HOME_PLACE): SacredWindow[] {
  const out: SacredWindow[] = [];
  if (!sacredTimeOn()) return out;
  for (let i = -1; i <= days + 4; i++) {
    const d = addLocalDays(first, i);
    try {
      const w = windowEndingOn(d.year, d.month, d.day, place);
      if (w) out.push({ start: w.start, end: w.end, label: w.label });
    } catch (err) {
      console.error("[schedule] sacred window lookup failed:", err);
    }
  }
  return out;
}
