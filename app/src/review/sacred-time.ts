/**
 * sacred-time.ts — Shabbat / Yom Tov windows for the review desk's schedule.
 *
 * Rule: no scheduled pushes from candle-lighting until
 * nightfall at the end of Shabbat or Yom Tov. The Friday close, and the close
 * on any weekday erev Yom Tov, moves earlier to a lead before candle-lighting.
 *
 * WHICH days are sacred comes from @hebcal/core (already a gateway dependency
 * and the same source src/time-context.ts uses): a CandleLightingEvent opens a
 * window, a HavdalahEvent closes it. "Restricted at instant t" = the most
 * recent of those markers before t is a candle-lighting. That one rule covers
 * plain Shabbat, two-day Yom Tov, Yom Kippur, and Yom Tov running into
 * Shabbat, with no per-holiday code. Diaspora calendar (il: false).
 *
 * WHEN is ours, from one helper (sun.ts, NOAA): candle-lighting = sunset −
 * 18 min; nightfall = the LATER of tzeit (sun 8.5° below the horizon) and
 * sunset + 72 min — Rabbeinu Tam (zmanim-rule.ts). At mid latitudes the
 * 72-minute floor always governs (8.5° comes ~35–40 min after sunset). The
 * time-awareness build aligns its holyBlockEnd and displayed havdalah to the
 * same 72 rule, so the gateway tells one story. Both knobs live on
 * SacredPlace (env: REVIEW_TZEIT_DEGREES, REVIEW_NIGHTFALL_FLOOR_MINUTES).
 *
 * Swap seam: like clock.ts, a thin module. If the time-awareness build
 * exports a vetted Shabbat/Yom Tov helper, `restrictionAt`, `erevFor` and
 * `windowEndingOn` are the functions to repoint — its holyBlockEnd ALREADY
 * includes the 72-minute rule, so do not apply the floor a second time.
 */
import { HebrewCalendar, Location, flags, type Event } from "@hebcal/core";
import { isoDate, localParts, zonedInstant } from "./clock.js";
import { sunsetFor, tzeitFor } from "./sun.js";

export interface SacredPlace {
  lat: number;
  lon: number;
  tz: string;
  label: string;
  /** Candle-lighting = sunset − this (common custom: 18). */
  candleMinutes: number;
  /** Tzeit = sun this many degrees below the horizon (8.5 = three small stars). */
  tzeitDegrees: number;
  /** Nightfall is never earlier than sunset + this many minutes. */
  nightfallFloorMinutes: number;
}

/**
 * The Jewish calendar is opt-in for the whole install (AHI_JEWISH_CALENDAR=true): approval holds on
 * Shabbat and Yom Tov, the calendar's sacred windows and notable days. Off = nothing is held or drawn.
 */
export function sacredTimeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AHI_JEWISH_CALENDAR === "true";
}

/** Home for sunset times: AHI_HOME_LAT / AHI_HOME_LON / AHI_HOME_TZ / AHI_HOME_LABEL, else New York. */
export const HOME_PLACE: SacredPlace = {
  lat: Number(process.env.AHI_HOME_LAT) || 40.7128,
  lon: Number(process.env.AHI_HOME_LON) || -74.006,
  tz: process.env.AHI_HOME_TZ || "America/New_York",
  label: process.env.AHI_HOME_LABEL || "New York, NY",
  candleMinutes: 18,
  tzeitDegrees: 8.5,
  nightfallFloorMinutes: 72, // Rabbeinu Tam
};

/** Candle-lighting for a local date: our NOAA sunset − candleMinutes. */
export function candleLightingFor(y: number, m: number, d: number, place: SacredPlace = HOME_PLACE): Date | null {
  const sunset = sunsetFor(y, m, d, place.lat, place.lon);
  return sunset ? new Date(sunset.getTime() - place.candleMinutes * 60_000) : null;
}

/** Nightfall for a local date: max(tzeit at tzeitDegrees, sunset + floor). */
export function nightfallFor(y: number, m: number, d: number, place: SacredPlace = HOME_PLACE): Date | null {
  const sunset = sunsetFor(y, m, d, place.lat, place.lon);
  if (!sunset) return null;
  const floor = sunset.getTime() + place.nightfallFloorMinutes * 60_000;
  const tzeit = tzeitFor(y, m, d, place.lat, place.lon, place.tzeitDegrees);
  return new Date(Math.max(floor, tzeit ? tzeit.getTime() : 0));
}

interface Marker {
  at: number;
  kind: "candle" | "havdalah";
  date: string; // local ISO date the marker falls on
}

const eventCache = new Map<string, Event[]>();

function quietly<T>(fn: () => T): T {
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

function hebLocation(place: SacredPlace): Location {
  return new Location(place.lat, place.lon, false, place.tz, place.label);
}

/** Events for one local date (cached — the tick asks every minute). */
function eventsOn(place: SacredPlace, y: number, m: number, d: number): Event[] {
  const key = `${place.label}|${place.lat}|${place.lon}|${isoDate(y, m, d)}`;
  const hit = eventCache.get(key);
  if (hit) return hit;
  const day = new Date(y, m - 1, d);
  const evs = quietly(() =>
    HebrewCalendar.calendar({
      start: day,
      end: day,
      location: hebLocation(place),
      candlelighting: true,
      candleLightingMins: place.candleMinutes,
      havdalahMins: place.nightfallFloorMinutes, // event KINDS only — times come from sun.ts
      il: false,
    }),
  );
  if (eventCache.size > 512) eventCache.clear();
  eventCache.set(key, evs);
  return evs;
}

function shiftDate(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function markersAround(place: SacredPlace, instant: Date, back: number, fwd: number): Marker[] {
  const p = localParts(instant, place.tz);
  const out: Marker[] = [];
  for (let i = -back; i <= fwd; i++) {
    const { y, m, d } = shiftDate(p.year, p.month, p.day, i);
    for (const ev of eventsOn(place, y, m, d)) {
      const name = ev.constructor.name;
      if (name === "CandleLightingEvent") {
        const at = candleLightingFor(y, m, d, place);
        if (at) out.push({ at: at.getTime(), kind: "candle", date: isoDate(y, m, d) });
      } else if (name === "HavdalahEvent") {
        const at = nightfallFor(y, m, d, place);
        if (at) out.push({ at: at.getTime(), kind: "havdalah", date: isoDate(y, m, d) });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Yom Tov name for a local date, or null ("Yom Kippur", "Pesach VII", …). */
export function yomTovName(place: SacredPlace, y: number, m: number, d: number): string | null {
  for (const ev of eventsOn(place, y, m, d)) {
    if (ev.getFlags() & flags.CHAG && ev.constructor.name !== "CandleLightingEvent" && ev.constructor.name !== "HavdalahEvent") {
      return ev.render("en");
    }
  }
  return null;
}

export interface Restriction {
  restricted: boolean;
  /** "Shabbat", "Yom Kippur", "Pesach VII", … when restricted. */
  reason: string | null;
  /** When the window closes (nightfall marker), if known. */
  until: Date | null;
}

/** Is `instant` inside a Shabbat / Yom Tov window? */
export function restrictionAt(instant: Date, place: SacredPlace = HOME_PLACE): Restriction {
  if (!sacredTimeOn()) return { restricted: false, reason: null, until: null };
  // 5 days back covers the longest chain (2-day Yom Tov + Shabbat, opened
  // the evening before); 4 forward finds the closing marker.
  const markers = markersAround(place, instant, 5, 4);
  const t = instant.getTime();
  let last: Marker | null = null;
  for (const mk of markers) {
    if (mk.at <= t) last = mk;
    else break;
  }
  if (!last || last.kind === "havdalah") return { restricted: false, reason: null, until: null };
  const until = markers.find((mk) => mk.at > t && mk.kind === "havdalah") ?? null;
  return { restricted: true, reason: sacredDayName(place, instant, last.date), until: until ? new Date(until.at) : null };
}

/**
 * Name of the sacred day an in-window instant belongs to. The candle-lighting
 * that opened the window says which: lit THIS evening → we are in tomorrow's
 * day (evening part); lit an earlier evening → we are in today's day. That
 * keeps Yom Tov running into Shabbat honest (Fri night of Pesach II = Shabbat).
 */
function sacredDayName(place: SacredPlace, instant: Date, candleDate: string): string {
  const p = localParts(instant, place.tz);
  const today = isoDate(p.year, p.month, p.day);
  const c = today === candleDate ? shiftDate(p.year, p.month, p.day, 1) : { y: p.year, m: p.month, d: p.day };
  return yomTovName(place, c.y, c.m, c.d) ?? "Shabbat";
}

export interface Erev {
  /** What begins at candle-lighting: "Shabbat", "Yom Kippur", "Pesach VII", … */
  entering: string;
  /** Candle-lighting = our NOAA sunset − candleMinutes. */
  candle: Date;
  sunset: Date;
}

/**
 * If local date y-m-d is an erev (Friday, or a day whose evening opens a Yom
 * Tov) AND the day itself is open in the morning, return the entering day and
 * its candle-lighting. A Yom Tov that runs into Shabbat has candle-lighting
 * on the Friday too, but that Friday is itself sacred — not an erev for us.
 */
export function erevFor(y: number, m: number, d: number, place: SacredPlace = HOME_PLACE): Erev | null {
  const noon = zonedInstant(place.tz, y, m, d, 12, 0);
  if (restrictionAt(noon, place).restricted) return null;
  const weekday = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  const next = shiftDate(y, m, d, 1);
  const nextYomTov = yomTovName(place, next.y, next.m, next.d);
  const opensWindow = eventsOn(place, y, m, d).some((ev) => ev.constructor.name === "CandleLightingEvent");
  if (weekday !== 5 && !(opensWindow && nextYomTov)) return null;
  const sunset = sunsetFor(y, m, d, place.lat, place.lon);
  if (!sunset) return null;
  return {
    entering: nextYomTov ?? "Shabbat",
    candle: new Date(sunset.getTime() - place.candleMinutes * 60_000),
    sunset,
  };
}

export interface SacredWindow {
  /** Candle-lighting that opened the block. */
  start: Date;
  /** Nightfall that closes it. */
  end: Date;
  /** Every sacred day in the block, in order ("Pesach I", "Pesach II", "Shabbat"). */
  days: string[];
  /** "Shabbat", "Yom Kippur", "Pesach & Shabbat", "Shmini Atzeret & Simchat Torah". */
  label: string;
}

function baseName(day: string): string {
  return day
    .replace(/\s+\d{4}$/, "") // "Rosh Hashana 5787"
    .replace(/\s+(I|II|III|IV|V|VI|VII|VIII)$/, "") // "Pesach VII"
    .trim();
}

/**
 * The Shabbat / Yom Tov block that ENDS at nightfall on local date y-m-d, if
 * any. A two- or three-day chag is one block with one end — hebcal only marks
 * havdalah at the very end — so it yields one window, not one per day.
 */
export function windowEndingOn(y: number, m: number, d: number, place: SacredPlace = HOME_PLACE): SacredWindow | null {
  if (!eventsOn(place, y, m, d).some((ev) => ev.constructor.name === "HavdalahEvent")) return null;
  const end = nightfallFor(y, m, d, place);
  if (!end) return null;
  // Walk back to the candle-lighting that opened the block.
  const markers = markersAround(place, new Date(end.getTime() - 60_000), 6, 0).filter((mk) => mk.at < end.getTime());
  let start: Marker | null = null;
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i].kind === "havdalah") break;
    start = markers[i];
  }
  if (!start) return null;
  const days: string[] = [];
  const [sy, sm, sd] = start.date.split("-").map(Number);
  for (let i = 1; i <= 4; i++) {
    const c = shiftDate(sy, sm, sd, i);
    const weekday = new Date(Date.UTC(c.y, c.m - 1, c.d, 12)).getUTCDay();
    const name = yomTovName(place, c.y, c.m, c.d) ?? (weekday === 6 ? "Shabbat" : null);
    if (name) days.push(name);
    if (c.y === y && c.m === m && c.d === d) break;
  }
  const label = [...new Set(days.map(baseName))].join(" & ") || "Shabbat";
  return { start: new Date(start.at), end, days, label };
}

/** Hebrew-calendar label for "tomorrow looks like" (Chol HaMoed, Rosh Chodesh…), or null. */
export function notableDay(place: SacredPlace, y: number, m: number, d: number): string | null {
  if (!sacredTimeOn()) return null;
  const yt = yomTovName(place, y, m, d);
  if (yt) return yt;
  for (const ev of eventsOn(place, y, m, d)) {
    const f = ev.getFlags();
    if (f & (flags.CHOL_HAMOED | flags.ROSH_CHODESH | flags.MAJOR_FAST | flags.MINOR_HOLIDAY)) return ev.render("en");
  }
  return null;
}

