/**
 * week.ts — the owner's approved week as data.
 *
 * The truth is a JSON file Michael edits without a build:
 *
 *   $SCHEDULE_DIR/week.json   (default ~/AHI/AHI_OS/mission-control/schedule)
 *   config/schedule/week.json (the seed this repo ships — used until the first exists)
 *
 * Every read goes through `loadJson`, which re-reads when the file's mtime
 * changes — an edit shows on the next request, no restart. A file that does
 * not parse or validate is NOT served half-read: the last good copy (or the
 * seed) is served and the error rides the payload so the app can say so.
 *
 * Times are wall-clock "HH:MM" in the file's zone (America/New_York). A
 * block ends where the next one starts; the last ends at `dayEnd`.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export interface BlockDef {
  /** "HH:MM", 24-hour, local. */
  start: string;
  title: string;
  /** One word for narrow week columns on a phone ("Sales", "Shul"); the title when absent. */
  short?: string;
  /** Colour/legend key into `kinds`. */
  kind: string;
  /** Work tags this block owns (sales · business · fun-build · os · learning). */
  tags?: string[];
  /** Shown as "~6:15" — the time moves (shul follows the sun). */
  approx?: boolean;
  detail?: string;
}

export interface WeekFile {
  version: 1;
  title: string;
  approved: string;
  zone: string;
  note?: string;
  /** "HH:MM" — when the last block of each day ends. */
  dayEnd: string;
  kinds: Record<string, { label: string; color: string }>;
  days: Record<DayKey, BlockDef[]>;
  /** The block laid over every Shabbat / Yom Tov window (candle-lighting → nightfall). */
  shabbat: { title: string; short?: string; detail?: string; kind: string };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(s: string): { hour: number; minute: number } | null {
  const m = HHMM.exec(s);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

const minutesOf = (s: string) => {
  const p = parseHHMM(s);
  return p ? p.hour * 60 + p.minute : NaN;
};

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const isStr = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown) => v === undefined || isStr(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Every field the calendar consumes is checked for its type here — a value
 * the app would render (title, short, detail, note, labels, colours) that is
 * not a string must never replace the last good copy. Returns the problems;
 * empty = good.
 */
export function validateWeek(raw: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(raw)) return ["not a JSON object"];
  const w = raw;
  if (w.version !== 1) errs.push("version must be 1");
  if (!isStr(w.title) || !w.title.trim()) errs.push("title must be text");
  if (!isStr(w.approved)) errs.push("approved must be text");
  if (!optStr(w.note)) errs.push("note must be text");
  if (!isStr(w.zone) || !w.zone) errs.push("zone missing");
  else {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: w.zone });
    } catch {
      errs.push(`zone ${w.zone} is not a time zone`);
    }
  }
  if (!isStr(w.dayEnd) || !parseHHMM(w.dayEnd)) errs.push("dayEnd must be HH:MM");
  const kinds = isObj(w.kinds) ? w.kinds : null;
  if (!kinds || !Object.keys(kinds).length) errs.push("kinds missing");
  else
    for (const [k, v] of Object.entries(kinds)) {
      if (!isObj(v) || !isStr(v.label) || !isStr(v.color)) errs.push(`kinds.${k} needs label and color text`);
      else if (!COLOR.test(v.color)) errs.push(`kinds.${k}.color must be a #hex colour`);
    }
  const kindOk = (k: unknown) => isStr(k) && !!k && (!kinds || k in kinds);
  if (!isObj(w.shabbat)) errs.push("shabbat missing");
  else {
    const sh = w.shabbat;
    if (!isStr(sh.title) || !sh.title.trim()) errs.push("shabbat.title must be text");
    if (!optStr(sh.short)) errs.push("shabbat.short must be text");
    if (!optStr(sh.detail)) errs.push("shabbat.detail must be text");
    if (!kindOk(sh.kind)) errs.push("shabbat.kind must name one of kinds");
  }
  if (!isObj(w.days)) return [...errs, "days missing"];
  const dayEnd = isStr(w.dayEnd) ? minutesOf(w.dayEnd) : NaN;
  for (const key of DAY_KEYS) {
    const list = w.days[key];
    if (!Array.isArray(list)) {
      errs.push(`days.${key} must be a list`);
      continue;
    }
    let prev = -1;
    list.forEach((b: unknown, i) => {
      const at = `days.${key}[${i}]`;
      if (!isObj(b)) return errs.push(`${at} is not an object`);
      const m = isStr(b.start) ? minutesOf(b.start) : NaN;
      if (!Number.isFinite(m)) errs.push(`${at}.start must be HH:MM`);
      else if (m <= prev) errs.push(`${at}.start must be later than the block before it`);
      else prev = m;
      if (!isStr(b.title) || !b.title.trim()) errs.push(`${at}.title must be text`);
      if (!optStr(b.short)) errs.push(`${at}.short must be text`);
      if (!optStr(b.detail)) errs.push(`${at}.detail must be text`);
      if (!kindOk(b.kind)) errs.push(`${at}.kind must name one of kinds`);
      if (b.approx !== undefined && typeof b.approx !== "boolean") errs.push(`${at}.approx must be true or false`);
      if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.some((t) => !isStr(t)))) errs.push(`${at}.tags must be a list of words`);
    });
    if (list.length && prev >= dayEnd) errs.push(`days.${key}: the last block starts at or after dayEnd`);
  }
  return errs;
}

// ── where the files live ──────────────────────────────────────────────

/** The editable folder (Michael's): week.json, tags.json, decisions.jsonl. */
export function scheduleDir(): string {
  const o = process.env.SCHEDULE_DIR;
  return o ? resolve(o) : resolve(homedir(), "AHI/AHI_OS/mission-control/schedule");
}

/** The seed folder this repo ships (src/schedule → ../../config/schedule, same from dist/schedule). */
export function seedDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../config/schedule");
}

// ── mtime-cached JSON reads ───────────────────────────────────────────

export interface Loaded<T> {
  value: T;
  /** "file" = the editable folder · "seed" = the repo copy (nothing edited yet). */
  source: "file" | "seed";
  path: string;
  /** Set when the editable file exists but could not be used — the seed/last good copy is being served. */
  error: string | null;
}

const cache = new Map<string, { mtimeMs: number; value: unknown; error: string | null }>();

function readValidated<T>(path: string, validate: (v: unknown) => string[]): { value: T | null; error: string | null } {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { value: null, error: "missing" };
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return { value: hit.value as T | null, error: hit.error };
  let value: T | null = null;
  let error: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const errs = validate(parsed);
    if (errs.length) error = errs.slice(0, 5).join("; ");
    else value = parsed as T;
  } catch (err) {
    error = `does not parse: ${(err as Error).message}`;
  }
  // A bad edit keeps the last good value for this path, never a half-read one.
  if (!value && hit?.value) value = hit.value as T;
  cache.set(path, { mtimeMs, value, error });
  return { value, error };
}

export function loadJson<T>(name: string, validate: (v: unknown) => string[], dirs = { live: scheduleDir(), seed: seedDir() }): Loaded<T> {
  const live = join(dirs.live, name);
  const seed = join(dirs.seed, name);
  let liveError: string | null = null;
  if (existsSync(live)) {
    const r = readValidated<T>(live, validate);
    if (r.value) return { value: r.value, source: "file", path: live, error: r.error };
    liveError = r.error;
  }
  const s = readValidated<T>(seed, validate);
  if (!s.value) throw new Error(`schedule ${name}: no usable file (${liveError ?? "missing"}; seed ${s.error})`);
  return { value: s.value, source: "seed", path: seed, error: liveError };
}

export function loadWeek(dirs?: { live: string; seed: string }): Loaded<WeekFile> {
  return loadJson<WeekFile>("week.json", validateWeek, dirs);
}
