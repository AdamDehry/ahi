/**
 * Panel family — formatting shared by Builds (#3) and WhatsApp (#5).
 *
 * Ages use the review desk's format (`47M` · `4H` · `2D`) so the two
 * surfaces read alike, and its 3-day line (STALE_MS) for "aging".
 */

import { locale, t, tn, type Key } from "../../i18n";

const MIN = 60_000;
const DAY = 86_400_000;

/** A figure and its unit key, translated by the caller (`ops.age` joins them). */
function age(value: number, unit: "m" | "h" | "d" | "w"): string {
  return t("ops.age", { value: String(value), unit: t(`ops.unit.${unit}` as Key) });
}

function ageSplit(ms: number): { value: number; unit: "m" | "h" | "d" } {
  const mins = Math.max(0, Math.round(ms / MIN));
  if (mins < 60) return { value: Math.max(1, mins), unit: "m" };
  const h = Math.round(mins / 60);
  if (h < 36) return { value: h, unit: "h" };
  return { value: Math.round(h / 24), unit: "d" };
}

export function ageLabel(ms: number): string {
  const a = ageSplit(ms);
  return age(a.value, a.unit);
}

const HOUR = 60 * MIN;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

/**
 * WhatsApp's "ago": `47M` · `7H` under 48 h · `2D`…`7D` · then
 * weeks `1W`… · past 30 days the word — `1 MONTH`, never a bare `M`, which
 * reads as minutes. Same case as ageLabel; whole units only, so 47h59m is
 * still `47H`.
 */
export function waAgeLabel(ms: number): string {
  const span = Math.max(0, ms);
  if (span < HOUR) return age(Math.min(59, Math.max(1, Math.round(span / MIN))), "m");
  if (span < 48 * HOUR) return age(Math.floor(span / HOUR), "h");
  if (span <= WEEK) return age(Math.floor(span / DAY), "d");
  if (span < MONTH) return age(Math.floor(span / WEEK), "w");
  const n = Math.floor(span / MONTH);
  return tn("ops.months", n);
}

/** C7: the figure itself ages — faint under 3D, warn 3–6D, oxblood + ring at 7D+. */
export function ageLevel(ms: number): "" | "aging" | "old" {
  if (ms >= 7 * DAY) return "old";
  if (ms >= 3 * DAY) return "aging";
  return "";
}

/** Split for the tally: `69` + `D`. */
export function ageParts(ms: number): { value: string; unit: string } {
  const a = ageSplit(ms);
  return { value: String(a.value), unit: t(`ops.unit.${a.unit}` as Key) };
}

/** "5:18 AM" today, "Wed 5:18 AM" this week, "Jul 30" before that — in the desk's zone. */
export function clockLabel(iso: string, tz: string, now = Date.now()): string {
  const d = new Date(iso);
  const lc = locale();
  const day = (x: Date) => x.toLocaleDateString("en-US", { timeZone: tz });
  const time = d.toLocaleTimeString(lc, { timeZone: tz, hour: "numeric", minute: "2-digit" });
  if (day(d) === day(new Date(now))) return time;
  if (now - d.getTime() < 6 * DAY) return `${d.toLocaleDateString(lc, { timeZone: tz, weekday: "short" })} ${time}`;
  return d.toLocaleDateString(lc, { timeZone: tz, month: "short", day: "numeric" });
}

export const AGENT_LABEL: Record<string, string> = { michael: "Michael", zali: "Zali", avi: "Avi", foreman: "Foreman" };
