/**
 * sun.ts — sunset by the NOAA solar-position algorithm (own implementation).
 *
 * WHY: the Friday / erev-Yom-Tov day-close fires a fixed lead before
 * candle-lighting, and candle-lighting is sunset − 18 min, so it moves every
 * week (≈4:41 PM in October, ≈3:11 PM in early December). No table, no fixed
 * time: computed fresh for each date.
 *
 * Algorithm: the NOAA Global Monitoring Laboratory solar calculator
 * (gml.noaa.gov/grad/solcalc — the published spreadsheet equations, after
 * Meeus, "Astronomical Algorithms"): Julian century → mean longitude/anomaly
 * → equation of center → apparent longitude → declination + equation of
 * time → hour angle at the standard sunset zenith of 90.833° (refraction +
 * solar radius), no elevation correction. One refinement pass re-evaluates
 * the solar terms at the computed sunset moment.
 *
 * Cross-checked in test/review-sun.test.ts against @hebcal/noaa (the NOAA
 * port hebcal ships) across every Friday of a year, and against published
 * reference times for the dates the brief names.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function julianDay(utcMs: number): number {
  return utcMs / 86_400_000 + 2440587.5;
}

interface SolarTerms {
  declination: number; // degrees
  eqTime: number; // minutes
}

function solarTerms(utcMs: number): SolarTerms {
  const T = (julianDay(utcMs) - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));
  return { declination, eqTime };
}

/** Minutes after 00:00 UTC of the given UTC calendar date when the sun goes down through `zenith`. */
function sunsetMinutesUtc(dateUtcMidnightMs: number, lat: number, lon: number, approxMinutes: number, zenith = 90.833): number | null {
  const { declination, eqTime } = solarTerms(dateUtcMidnightMs + approxMinutes * 60_000);
  const cosHA =
    Math.cos(zenith * RAD) / (Math.cos(lat * RAD) * Math.cos(declination * RAD)) -
    Math.tan(lat * RAD) * Math.tan(declination * RAD);
  if (cosHA < -1 || cosHA > 1) return null; // polar day/night — not Florida's problem
  const ha = Math.acos(cosHA) * DEG;
  const solarNoon = 720 - 4 * lon - eqTime;
  return solarNoon + 4 * ha;
}

/**
 * Sunset for the LOCAL calendar date year-month-day at (lat, lon).
 * Longitude is east-positive (New York = -74.006). The answer can fall
 * after 00:00 UTC of the next day (summer evenings in the Americas); it is
 * returned as an absolute instant either way.
 */
export function sunsetFor(year: number, month: number, day: number, lat: number, lon: number): Date | null {
  return sunDownThrough(year, month, day, lat, lon, 90.833);
}

/**
 * Tzeit hakochavim — the evening moment the sun is `degrees` below the
 * horizon (8.5° = three small stars; hebcal.com's published "Havdalah").
 * Same NOAA equations as sunset, different zenith.
 */
export function tzeitFor(year: number, month: number, day: number, lat: number, lon: number, degrees = 8.5): Date | null {
  return sunDownThrough(year, month, day, lat, lon, 90 + degrees);
}

function sunDownThrough(year: number, month: number, day: number, lat: number, lon: number, zenith: number): Date | null {
  const midnight = Date.UTC(year, month - 1, day);
  // First pass at local solar noon + 6h, second pass at the first answer.
  let minutes = sunsetMinutesUtc(midnight, lat, lon, 720 - 4 * lon + 360, zenith);
  if (minutes === null) return null;
  minutes = sunsetMinutesUtc(midnight, lat, lon, minutes, zenith);
  if (minutes === null) return null;
  return new Date(midnight + Math.round(minutes * 60_000));
}
