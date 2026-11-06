/**
 * Panel family — formatting shared by Builds (#3) and WhatsApp (#5).
 *
 * Ages use the review desk's format (`47M` · `4H` · `2D`) so the two
 * surfaces read alike, and its 3-day line (STALE_MS) for "aging".
 */

const MIN = 60_000;
const DAY = 86_400_000;

export function ageLabel(ms: number): string {
  const mins = Math.max(0, Math.round(ms / MIN));
  if (mins < 60) return `${Math.max(1, mins)}M`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h}H`;
  return `${Math.round(h / 24)}D`;
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
  const t = Math.max(0, ms);
  if (t < HOUR) return `${Math.min(59, Math.max(1, Math.round(t / MIN)))}M`;
  if (t < 48 * HOUR) return `${Math.floor(t / HOUR)}H`;
  if (t <= WEEK) return `${Math.floor(t / DAY)}D`;
  if (t < MONTH) return `${Math.floor(t / WEEK)}W`;
  const n = Math.floor(t / MONTH);
  return `${n} ${n === 1 ? "MONTH" : "MONTHS"}`;
}

/** C7: the figure itself ages — faint under 3D, warn 3–6D, oxblood + ring at 7D+. */
export function ageLevel(ms: number): "" | "aging" | "old" {
  if (ms >= 7 * DAY) return "old";
  if (ms >= 3 * DAY) return "aging";
  return "";
}

/** Split for the tally: `69` + `D`. */
export function ageParts(ms: number): { value: string; unit: string } {
  const label = ageLabel(ms);
  return { value: label.slice(0, -1), unit: label.slice(-1) };
}

/** "5:18 AM" today, "Wed 5:18 AM" this week, "Jul 30" before that — in the desk's zone. */
export function clockLabel(iso: string, tz: string, now = Date.now()): string {
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString("en-US", { timeZone: tz });
  const time = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  if (day(d) === day(new Date(now))) return time;
  if (now - d.getTime() < 6 * DAY) return `${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${time}`;
  return d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
}

export const AGENT_LABEL: Record<string, string> = { michael: "Michael", zali: "Zali", avi: "Avi", foreman: "Foreman" };
