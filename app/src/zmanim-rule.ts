/**
 * zmanim-rule.ts — the ONE end-of-Shabbat / Yom Tov rule for the gateway.
 *
 * The configured zman is Rabbeinu Tam — 72 minutes after
 * sunset. Applied everywhere as
 *
 *     block end = max(tzeit at 8.5° solar depression, sunset + 72 min)
 *
 * rounded UP to the whole minute (an end time is never shown early). It drives
 * the havdalah time in Michael's per-turn context, `isShabbatOrYomTov`,
 * `shabbatOrYomTovStatus`, and `holyBlockEnd`; review-desk reads the same
 * value from here. Candle-lighting is unchanged (sunset − 18 min).
 *
 * AHI_HOLY_END_SUNSET_MINS overrides the 72 (whole minutes, 1–180). Unset in
 * production.
 */

export const DEFAULT_HOLY_END_SUNSET_MINS = 72;
export const HOLY_END_TZEIT_DEGREES = 8.5;
export const CANDLE_MINS_BEFORE_SUNSET = 18;

/** Minutes after sunset that end Shabbat / Yom Tov (Rabbeinu Tam, default 72). */
export function holyEndSunsetMins(): number {
  const raw = Number(process.env.AHI_HOLY_END_SUNSET_MINS);
  return Number.isInteger(raw) && raw >= 1 && raw <= 180 ? raw : DEFAULT_HOLY_END_SUNSET_MINS;
}

export interface HolyEndRule {
  sunsetOffsetMins: number;
  tzeitDegrees: number;
  /** Human label, e.g. "max(tzeit 8.5°, sunset + 72 min) — Rabbeinu Tam". */
  label: string;
}

export function holyEndRule(): HolyEndRule {
  const mins = holyEndSunsetMins();
  return {
    sunsetOffsetMins: mins,
    tzeitDegrees: HOLY_END_TZEIT_DEGREES,
    label: `max(tzeit ${HOLY_END_TZEIT_DEGREES}°, sunset + ${mins} min)${mins === 72 ? " — Rabbeinu Tam" : ""}`,
  };
}

/** Round an instant up to the next whole minute (unchanged if already on one). */
export function ceilToMinute(t: number): number {
  return Math.ceil(t / 60_000) * 60_000;
}

export interface HolyEndTime {
  at: Date;
  /** Which side of the max decided it. */
  decidedBy: "sunset+offset" | "tzeit";
  /** True when tzeit could not be computed, so only the sunset side was checked. */
  tzeitUnavailable: boolean;
}

/** Apply the rule to one day's sunset and (optional) tzeit. */
export function holyEndFrom(sunset: Date, tzeit: Date | null): HolyEndTime {
  const bySunset = sunset.getTime() + holyEndSunsetMins() * 60_000;
  const byTzeit = tzeit && Number.isFinite(tzeit.getTime()) ? tzeit.getTime() : null;
  const raw = byTzeit !== null && byTzeit > bySunset ? byTzeit : bySunset;
  return {
    at: new Date(ceilToMinute(raw)),
    decidedBy: byTzeit !== null && byTzeit > bySunset ? "tzeit" : "sunset+offset",
    tzeitUnavailable: byTzeit === null,
  };
}
