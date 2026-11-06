/**
 * schedule.ts — when the digest and the day-close are due.
 *
 *   Digest     Mon/Wed/Fri 11:00 America/New_York
 *   Day-close  Sun–Thu 21:00 America/New_York
 *              Friday, and any weekday erev Yom Tov: DYNAMIC — candle-lighting
 *              (NOAA sunset − 18 min, at home) minus 2 hours, recomputed
 *              for each date.
 *   Motzei     at nightfall ending each Shabbat / Yom Tov block (a 2–3 day chag
 *              is one block, one message): what ran over Shabbat + what needs
 *              a yes. It is the first message after every window.
 *   Never      inside Shabbat / Yom Tov (candle-lighting → nightfall). A slot
 *              that lands there is recorded as skipped and folds into the next
 *              message that goes out — the motzei.
 *
 * Mechanism: cron fires the gateway's tick EVERY MINUTE (cron on this box
 * cannot hold a per-crontab timezone — `man 5 crontab`, LIMITATIONS); the
 * tick turns the instant into the owner's wall clock HERE, by the named zone, so
 * DST never moves a slot. Every minute because the early close is a moving
 * minute (4:40 PM one week, 3:17 PM another): a 5-minute cron would land up
 * to 4 minutes off it. A no-op tick is one local HTTP call and no log line.
 * Dynamic slots drop their seconds (floor to REVIEW_TICK_MINUTES = 1), so the
 * close is never LATER than 2h before candle-lighting.
 */
import { isoDate, localParts, parseHHMM, zonedInstant } from "./clock.js";
import { erevFor, HOME_PLACE, windowEndingOn, type Erev, type SacredPlace, type SacredWindow } from "./sacred-time.js";
import type { ScheduleLedger } from "./store.js";

export interface ScheduleConfig {
  tz: string;
  place: SacredPlace;
  digest: { hour: number; minute: number; days: number[] };
  close: { hour: number; minute: number; days: number[] };
  /** Friday / erev-Yom-Tov close = candle-lighting − this. 0 disables the early close. */
  erevLeadMinutes: number;
  /** Cron cadence in minutes (1). Dynamic slots floor to this grid so a tick hits them exactly. */
  gridMinutes: number;
  /** A slot still goes out if the tick that sees it is at most this late. */
  graceMinutes: number;
}

export type SlotKind = "digest" | "close" | "motzei";

export interface Slot {
  kind: SlotKind;
  /** "digest:2026-10-07" — idempotency key in the schedule ledger. */
  key: string;
  date: string;
  at: Date;
  /** Set on an early (Friday / erev Yom Tov) close. */
  erev: Erev | null;
  /** Set on a motzei slot: the Shabbat / Yom Tov block that just ended. */
  window?: SacredWindow;
}

function parseDays(s: string | undefined, fallback: number[]): number[] {
  if (!s) return fallback;
  const days = s
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return days.length ? days : fallback;
}

/**
 * REVIEW_DIGEST_TIME (11:00) · REVIEW_DIGEST_DAYS (1,3,5)
 * REVIEW_CLOSE_TIME (21:00) · REVIEW_CLOSE_DAYS (0,1,2,3,4)
 * REVIEW_EREV_LEAD_MINUTES (120) · REVIEW_TICK_MINUTES (1) · REVIEW_GRACE_MINUTES (90)
 * Zmanim (home): REVIEW_CANDLE_MINUTES (18) · REVIEW_TZEIT_DEGREES (8.5)
 *   · REVIEW_NIGHTFALL_FLOOR_MINUTES (72, Rabbeinu Tam) — nightfall = max(tzeit, sunset + floor).
 * Days: 0 = Sunday … 6 = Saturday. Saturday is never scheduled regardless.
 */
export function scheduleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ScheduleConfig {
  const digest = parseHHMM(env.REVIEW_DIGEST_TIME || "11:00");
  const close = parseHHMM(env.REVIEW_CLOSE_TIME || "21:00");
  const lead = Number(env.REVIEW_EREV_LEAD_MINUTES ?? 120);
  const grid = Number(env.REVIEW_TICK_MINUTES ?? 1);
  const grace = Number(env.REVIEW_GRACE_MINUTES ?? 90);
  const num = (v: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  const place: SacredPlace = {
    ...HOME_PLACE,
    candleMinutes: num(env.REVIEW_CANDLE_MINUTES, HOME_PLACE.candleMinutes, 0, 60),
    tzeitDegrees: num(env.REVIEW_TZEIT_DEGREES, HOME_PLACE.tzeitDegrees, 3, 20),
    nightfallFloorMinutes: num(env.REVIEW_NIGHTFALL_FLOOR_MINUTES, HOME_PLACE.nightfallFloorMinutes, 0, 120),
  };
  return {
    tz: HOME_PLACE.tz,
    place,
    digest: { ...digest, days: parseDays(env.REVIEW_DIGEST_DAYS, [1, 3, 5]) },
    close: { ...close, days: parseDays(env.REVIEW_CLOSE_DAYS, [0, 1, 2, 3, 4]) },
    erevLeadMinutes: Number.isFinite(lead) && lead >= 0 ? lead : 120,
    gridMinutes: Number.isInteger(grid) && grid >= 1 && grid <= 60 ? grid : 1,
    graceMinutes: Number.isFinite(grace) && grace >= 5 ? grace : 90,
  };
}

export const DEFAULT_SCHEDULE: ScheduleConfig = scheduleConfigFromEnv({});

function floorToGrid(d: Date, gridMinutes: number): Date {
  const g = gridMinutes * 60_000;
  return new Date(Math.floor(d.getTime() / g) * g);
}

/** Motzei rounds UP: never a second before nightfall. */
function ceilToGrid(d: Date, gridMinutes: number): Date {
  const g = gridMinutes * 60_000;
  return new Date(Math.ceil(d.getTime() / g) * g);
}

/** The early close for a date, if it is an erev and the early close is on. */
export function erevCloseFor(cfg: ScheduleConfig, y: number, m: number, d: number): { at: Date; erev: Erev } | null {
  if (cfg.erevLeadMinutes <= 0) return null;
  const erev = erevFor(y, m, d, cfg.place);
  if (!erev) return null;
  return { at: floorToGrid(new Date(erev.candle.getTime() - cfg.erevLeadMinutes * 60_000), cfg.gridMinutes), erev };
}

/** Every slot on local date y-m-d, in time order. */
export function slotsForDate(cfg: ScheduleConfig, y: number, m: number, d: number): Slot[] {
  const weekday = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  const date = isoDate(y, m, d);
  const out: Slot[] = [];
  if (weekday !== 6 && cfg.digest.days.includes(weekday)) {
    out.push({ kind: "digest", key: `digest:${date}`, date, at: zonedInstant(cfg.tz, y, m, d, cfg.digest.hour, cfg.digest.minute), erev: null });
  }
  if (weekday !== 6) {
    const early = erevCloseFor(cfg, y, m, d);
    if (early) {
      out.push({ kind: "close", key: `close:${date}`, date, at: early.at, erev: early.erev });
    } else if (cfg.close.days.includes(weekday) || (weekday === 5 && cfg.erevLeadMinutes > 0)) {
      // A Friday that is itself Yom Tov still owns a (skipped) slot, so its
      // close is visibly folded into Sunday's rather than silently absent.
      out.push({ kind: "close", key: `close:${date}`, date, at: zonedInstant(cfg.tz, y, m, d, cfg.close.hour, cfg.close.minute), erev: null });
    }
  }
  // Motzei: at nightfall closing each Shabbat / Yom Tov
  // block — one per block, any weekday including Saturday night.
  const w = windowEndingOn(y, m, d, cfg.place);
  if (w) out.push({ kind: "motzei", key: `motzei:${date}`, date, at: ceilToGrid(w.end, cfg.gridMinutes), erev: null, window: w });
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Slots whose time has come (within grace) and that the ledger hasn't settled. */
export function dueSlots(cfg: ScheduleConfig, now: Date, ledger: ScheduleLedger): Slot[] {
  const settled = new Set([...Object.keys(ledger.delivered), ...ledger.skipped.map((s) => s.slot)]);
  const p = localParts(now, cfg.tz);
  const due: Slot[] = [];
  for (const back of [1, 0]) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day - back, 12));
    for (const slot of slotsForDate(cfg, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) {
      const t = slot.at.getTime();
      if (t <= now.getTime() && now.getTime() < t + cfg.graceMinutes * 60_000 && !settled.has(slot.key)) due.push(slot);
    }
  }
  return due;
}

/** The next `limit` slots strictly after `from` (for "tomorrow looks like" and the app footer). */
export function upcomingSlots(cfg: ScheduleConfig, from: Date, days = 8, limit = 4): Slot[] {
  const p = localParts(from, cfg.tz);
  const out: Slot[] = [];
  for (let i = 0; i <= days && out.length < limit; i++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + i, 12));
    for (const slot of slotsForDate(cfg, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) {
      if (slot.at.getTime() > from.getTime()) out.push(slot);
    }
  }
  return out.slice(0, limit);
}
