/**
 * compose.ts — the digest and day-close text. Deterministic, no LLM.
 *
 * Shape follows the owner's ask: what got done, what needs an okay, what's open,
 * and (at day's end) what tomorrow looks like. One line per thing. YELLOW
 * items carry numbers so he can answer "yes 1, 2, no 3, hold 4" in the
 * thread; RED items never get a number — they are approved by fingerprint in
 * the app, and a RED item is named in exactly ONE day-close (its reminder),
 * after which it holds quietly.
 */
import { APP_URL } from "../app-url.js";
import { fmtDay, fmtTime, fmtWeekday, startOfLocalDay } from "./clock.js";
import type { BuildSummary } from "./ledger.js";
import { notableDay, restrictionAt } from "./sacred-time.js";
import { slotsForDate, upcomingSlots, type ScheduleConfig, type Slot } from "./schedule.js";
import type { Numbering } from "./store.js";
import type { TrackRow } from "./tracks.js";
import { buildsDigestLines, type BuildsView } from "./builds.js";
import type { ReviewItem } from "./types.js";
import { addLocalDays } from "../local-time.js";
import { workdayAt } from "../workday.js";

export interface ComposeInput {
  now: Date;
  cfg: ScheduleConfig;
  slot: Slot;
  items: ReviewItem[];
  builds: BuildSummary[];
  /** Start of the window this message reports on. */
  since: Date;
  /** Skipped slots this message folds in. */
  folded: Array<{ slot: string; reason: string }>;
  /** Numbers already handed out (the close extends them; the digest resets). */
  numbering: Numbering | null;
  /** OPEN TRACKS board — the older day-close form, kept for callers without the Builds view. */
  tracks?: TrackRow[];
  /** The Builds panel's view — when present the day-close carries its two-line block instead (B8). */
  buildsView?: BuildsView;
  /** Public app origin for the block's link. */
  appUrl?: string;
  /** The owner's own recent messages — the close lifts what he said is for tomorrow. */
  said?: Array<{ text: string; timestamp: string }>;
  /** The WhatsApp dashboard's line, composed by the WhatsApp module (W10 — the day-close carries it, no second digest). */
  whatsapp?: string[];
}

export interface Composed {
  text: string;
  numbering: Numbering;
  /** RED items whose one reminder this message carries. */
  remindedIds: string[];
}

const BUILD_FINISHED = new Set(["done", "shipped"]);
const BUILD_TROUBLE = new Set(["failed", "abandoned", "stalled"]);

/**
 * One entry per build NAME — its latest run. A failed run that was redone
 * and finished is a finish, not a failure; three runs of one job are one line.
 */
function latestByName(builds: BuildSummary[]): Array<BuildSummary & { runs: number }> {
  const byName = new Map<string, BuildSummary & { runs: number }>();
  for (const b of builds) {
    const prev = byName.get(b.name);
    if (!prev) byName.set(b.name, { ...b, runs: 1 });
    else if (b.created >= prev.created) byName.set(b.name, { ...b, runs: prev.runs + 1 });
    else prev.runs += 1;
  }
  return [...byName.values()].sort((a, b) => (a.stateAt?.getTime() ?? 0) - (b.stateAt?.getTime() ?? 0));
}

const inWindow = (b: BuildSummary, since: Date, now: Date) => !!b.stateAt && b.stateAt >= since && b.stateAt <= now;

function within(iso: string | null | undefined, since: Date, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= since.getTime() && t <= now.getTime();
}

function line(item: ReviewItem): string {
  const cost = item.cost_risk ? ` · ${item.cost_risk}` : "";
  return `${item.title} — ${item.desk}${cost}`;
}

function agentLabel(agent: string): string {
  return agent ? ` (${agent.charAt(0).toUpperCase()}${agent.slice(1)})` : "";
}

function sinceLabel(input: ComposeInput): string {
  const { since, now, cfg } = input;
  if (since.getTime() >= startOfLocalDay(now, cfg.tz).getTime()) return "today";
  return `since ${fmtWeekday(since, cfg.tz)} ${fmtTime(since, cfg.tz)}`;
}

function foldNote(input: ComposeInput): string | null {
  if (!input.folded.length) return null;
  const parts = input.folded.map((f) => {
    const [kind, date] = f.slot.split(":");
    const d = new Date(`${date}T12:00:00Z`);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(d);
    return `${day}'s ${kind === "digest" ? "digest" : "close"} (${f.reason})`;
  });
  return `_Folds in ${parts.join(", ")}._`;
}

function finishedLines(input: ComposeInput): string[] {
  const { items, builds, since, now } = input;
  const out: string[] = [];
  for (const b of latestByName(builds)) {
    if (BUILD_FINISHED.has(b.state) && inWindow(b, since, now)) out.push(`- ${b.name}${agentLabel(b.agent)}${b.runs > 1 ? ` · ${b.runs} runs` : ""}`);
  }
  for (const it of items) {
    if (it.status === "done" && within(it.done_at ?? it.created, since, now)) {
      out.push(`- ${it.title}${it.lane === "GREEN" ? "" : ` — ${it.lane === "RED" ? "RED, " : ""}approved and done`}`);
    }
  }
  return out;
}

/**
 * An abandoned build is a closed duplicate, not trouble, when a sibling build
 * (same name minus its last word, e.g. due-at-signing-on vs
 * due-at-signing-rulings) finished. "Abandoned" alone reads as a failure.
 */
function supersededBySibling(b: BuildSummary, builds: BuildSummary[]): boolean {
  if (b.state !== "abandoned") return false;
  const cut = b.name.lastIndexOf("-");
  const stem = cut > 0 ? b.name.slice(0, cut) : b.name;
  return builds.some((o) => o.name !== b.name && BUILD_FINISHED.has(o.state) && (o.name === stem || o.name.startsWith(`${stem}-`)));
}

function changedLines(input: ComposeInput): string[] {
  const { items, builds, since, now } = input;
  const out: string[] = [];
  for (const b of latestByName(builds)) {
    if (BUILD_TROUBLE.has(b.state) && inWindow(b, since, now) && !supersededBySibling(b, builds)) out.push(`- ${b.name} ${b.state}`);
  }
  for (const it of items) {
    if (!within(it.decided_at, since, now) || !it.decided_how || it.decided_how.startsWith("auto-hold")) continue;
    if (it.status === "approved") out.push(`- You approved: ${it.title}${it.lane === "RED" ? " (fingerprint)" : ""}`);
    else if (it.status === "denied") out.push(`- You said no: ${it.title}`);
    else if (it.status === "held") out.push(`- On hold: ${it.title}`);
  }
  return out;
}

/** Hand out numbers: keep the ones already issued, append new waiting YELLOW items. */
function numberWaiting(
  input: ComposeInput,
  reset: boolean,
  source: string,
  lanes: ReviewItem["lane"][] = ["YELLOW"],
): { numbering: Numbering; rows: Array<{ n: number; item: ReviewItem }> } {
  const waiting = input.items
    .filter((i) => lanes.includes(i.lane) && i.status === "waiting")
    .sort((a, b) => a.created.localeCompare(b.created));
  const map: Record<string, string> = reset || !input.numbering ? {} : { ...input.numbering.map };
  const byItem = new Map(Object.entries(map).map(([n, id]) => [id, Number(n)]));
  let next = Math.max(0, ...Object.keys(map).map(Number)) + 1;
  const rows: Array<{ n: number; item: ReviewItem }> = [];
  for (const item of waiting) {
    let n = byItem.get(item.id);
    if (n === undefined) {
      n = next++;
      map[String(n)] = item.id;
    }
    rows.push({ n, item });
  }
  rows.sort((a, b) => a.n - b.n);
  return {
    numbering: { source: reset || !input.numbering ? source : input.numbering.source, at: input.now.toISOString(), map },
    rows,
  };
}

function carriedTag(item: ReviewItem, input: ComposeInput): string {
  return Date.parse(item.created) < input.since.getTime() ? ` _(since ${fmtWeekday(new Date(item.created), input.cfg.tz)})_` : "";
}

/**
 * The open-tracks board. Real tracks (the build order) get a full row: state,
 * done, left. Builds nobody has filed under a track are grouped by state —
 * every one still named, none dropped — so twenty loose builds read as four
 * lines instead of twenty. Rows leave only when the owner closes or cancels them.
 */
export function tracksSection(rows: TrackRow[]): string[] {
  const tracks = rows.filter((r) => r.source !== "build");
  const loose = rows.filter((r) => r.source === "build");
  if (!rows.length) return ["**Open tracks** — none open."];
  const counts = [`${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`];
  if (loose.length) counts.push(`${loose.length} loose ${loose.length === 1 ? "build" : "builds"}`);
  const out = [`**Open tracks** — ${counts.join(" · ")} · nothing leaves until you close it`];
  for (const r of tracks) {
    const parts: string[] = [r.status];
    if (r.done) parts.push(`done: ${r.done}`);
    if (r.left) parts.push(`left: ${r.left}`);
    if (r.note) parts.push(r.note);
    out.push(`- ${r.title} — ${parts.join(" · ")}`);
  }
  const group = (status: string[]) => loose.filter((r) => status.includes(r.status));
  const names = (rs: TrackRow[], withAge = false) =>
    rs.map((r) => (withAge && r.note ? `${r.title} (${r.note.replace(/^no activity for /, "").replace(/ days$/, "d")})` : r.title)).join(", ");
  const running = group(["running"]);
  const stale = group(["stale"]);
  const built = group(["built"]);
  const troubled = loose.filter((r) => !["running", "stale", "built"].includes(r.status));
  if (running.length) out.push(`- Building now: ${names(running)}`);
  if (built.length) out.push(`- Built, not filed or closed (${built.length}): ${names(built)}`);
  if (troubled.length) out.push(`- Failed or stopped: ${troubled.map((r) => `${r.title} (${r.status})`).join(", ")}`);
  if (stale.length) out.push(`- Stale, never closed: ${names(stale, true)}`);
  return out;
}

export function composeDigest(input: ComposeInput): Composed {
  const { now, cfg } = input;
  const out: string[] = [`**Digest · ${fmtDay(now, cfg.tz)}**`, ""];

  const finished = finishedLines(input);
  out.push(`**Finished** ${sinceLabel(input)}`);
  out.push(...(finished.length ? finished : ["- Nothing new finished."]));
  out.push("");

  const changed = changedLines(input);
  if (changed.length) {
    out.push("**Changed**", ...changed, "");
  }

  const { numbering, rows } = numberWaiting(input, true, input.slot.key);
  if (rows.length) {
    out.push(`**Waiting for a yes** — reply like "yes 1, 2, no 3, hold 4"`);
    for (const { n, item } of rows) out.push(`${n}. ${line(item)}${carriedTag(item, input)}`);
  } else {
    out.push("**Waiting for a yes** — nothing.");
  }
  const red = input.items.filter((i) => i.lane === "RED" && i.status === "waiting").length;
  if (red) out.push(`RED: ${red} ${red === 1 ? "item needs" : "items need"} your fingerprint — open Review.`);
  const held = input.items.filter((i) => i.status === "held").length;
  if (held) out.push(`On hold: ${held} — in Review whenever you want them.`);

  const fold = foldNote(input);
  if (fold) out.push("", fold);
  return { text: out.join("\n").trim(), numbering, remindedIds: [] };
}

const NEXT_UP_MAX = 3;
const SAID_MAX = 3;
const SAID_CHARS = 140;
const TOMORROW_WORD = /\b(tomorrow|tmrw)\b/i;
/**
 * A question is not a plan: "what's the weather
 * tomorrow?" never lands in the close. Only wh-words lead a question here —
 * "Do the GV60 numbers tomorrow" is a command and stays.
 */
const QUESTION_START = /^(what|when|where|why|how)\b/i;
const isQuestion = (text: string) => text.endsWith("?") || QUESTION_START.test(text);

/** The next queued tracks, in build order — from the Builds view, else the older board. */
export function nextUpTitles(input: Pick<ComposeInput, "buildsView" | "tracks">): string[] {
  if (input.buildsView) return input.buildsView.sections.queued.map((c) => c.title);
  return (input.tracks ?? [])
    .filter((r) => r.status === "queued")
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
    .map((r) => r.title);
}

/**
 * What the owner said is for tomorrow: the sentence around "tomorrow" in each
 * of his messages from THIS workday (workday.ts). A "tomorrow" said between
 * midnight and 4 AM meant the day that is now ending, so it is not carried.
 * A message that is a question is skipped whole.
 */
export function saidForTomorrow(said: ComposeInput["said"], now: Date, tz: string): Array<{ text: string; at: Date }> {
  const from = workdayAt(now, tz).startsAt.getTime();
  const seen = new Set<string>();
  const out: Array<{ text: string; at: Date }> = [];
  const msgs = [...(said ?? [])]
    .map((m) => ({ text: m.text, at: new Date(m.timestamp) }))
    .filter((m) => typeof m.text === "string" && m.at.getTime() >= from && m.at.getTime() <= now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const m of msgs) {
    const flat = m.text.replace(/\s+/g, " ").trim();
    if (isQuestion(flat)) continue;
    const sentence = flat.split(/(?<=[.!?])\s+/).find((x) => TOMORROW_WORD.test(x));
    if (!sentence) continue;
    const text = sentence.length > SAID_CHARS ? `${sentence.slice(0, SAID_CHARS - 1).trimEnd()}…` : sentence;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, at: m.at });
  }
  return out;
}

/** The close's "what's next" lines — each one omitted when there is nothing to say. */
function tomorrowAgendaLines(input: ComposeInput, restricted: boolean): string[] {
  const out: string[] = [];
  const next = restricted ? [] : nextUpTitles(input);
  if (next.length) {
    const more = next.length > NEXT_UP_MAX ? ` (+${next.length - NEXT_UP_MAX} more)` : "";
    out.push(`- Next up: ${next.slice(0, NEXT_UP_MAX).join(" · ")}${more}`);
  }
  const said = saidForTomorrow(input.said, input.now, input.cfg.tz);
  for (const s of said.slice(0, SAID_MAX)) out.push(`- You said: "${s.text}" (${fmtTime(s.at, input.cfg.tz)})`);
  if (said.length > SAID_MAX) out.push(`- +${said.length - SAID_MAX} more mentions of tomorrow in today's thread`);
  return out;
}

function nextOpenSlot(cfg: ScheduleConfig, from: Date): Slot | null {
  for (const slot of upcomingSlots(cfg, from, 10, 12)) {
    if (!restrictionAt(slot.at, cfg.place).restricted) return slot;
  }
  return null;
}

function slotPhrase(slot: Slot, cfg: ScheduleConfig): string {
  if (slot.kind === "digest") return `digest ${fmtTime(slot.at, cfg.tz)}`;
  if (slot.kind === "motzei") return `motzei ${slot.window?.label ?? "Shabbat"} ${fmtTime(slot.at, cfg.tz)}`;
  if (slot.erev) return `${slot.erev.entering === "Shabbat" ? "Shabbat" : "erev " + slot.erev.entering} close ${fmtTime(slot.at, cfg.tz)} · candles ${fmtTime(slot.erev.candle, cfg.tz)}`;
  return `day close ${fmtTime(slot.at, cfg.tz)}`;
}

export function composeClose(input: ComposeInput): Composed {
  const { now, cfg, slot } = input;
  const erev = slot.erev;
  // Dated by the workday: a close that lands after midnight (a late catch-up)
  // still closes the evening before.
  const wd = workdayAt(now, cfg.tz).date;
  const dayLabel = fmtDay(new Date(Date.UTC(wd.year, wd.month - 1, wd.day, 12)), "UTC");
  const header = erev
    ? `**${erev.entering === "Shabbat" ? "Shabbat close" : `Close · erev ${erev.entering}`} · ${dayLabel}** — candles ${fmtTime(erev.candle, cfg.tz)}`
    : `**Day close · ${dayLabel}**`;
  const out: string[] = [header, ""];

  const done = [...finishedLines(input), ...changedLines(input).filter((l) => l.startsWith("- You approved"))];
  const label = sinceLabel(input);
  out.push(`**Done ${label}**`);
  out.push(...(done.length ? done : ["- Quiet day — nothing closed out."]));
  out.push("");

  const { numbering, rows } = numberWaiting(input, false, input.slot.key);
  const approvedQueued = input.items.filter((i) => i.status === "approved");
  const building = input.builds.filter((b) => b.state === "running" && now.getTime() - b.created.getTime() < 3 * 86_400_000);
  const held = input.items.filter((i) => i.status === "held");
  // After a motzei message the Sunday close must not repeat what it showed:
  // those keep their numbers and collapse to one line.
  const motzeiShown = input.numbering?.source.startsWith("motzei:") ? new Set(Object.values(input.numbering.map)) : null;
  const fresh = motzeiShown ? rows.filter((r) => !motzeiShown.has(r.item.id)) : rows;
  const repeated = rows.length - fresh.length;
  out.push("**Still open**");
  if (fresh.length) {
    for (const { n, item } of fresh) out.push(`${n}. ${line(item)}`);
    out.push(`_Answer here like "yes ${fresh[0].n}" — or in Review._`);
  }
  if (repeated) out.push(`- ${repeated} still waiting from the motzei message — same numbers, answer anytime`);
  if (held.length) out.push(`- On hold: ${held.length}`);
  if (approvedQueued.length) out.push(`- Approved, waiting to run: ${approvedQueued.map((i) => i.title).join("; ")}`);
  const board = !!input.tracks || !!input.buildsView;
  if (!board && building.length) out.push(`- Building: ${building.map((b) => b.name).join(", ")}`);
  if (!rows.length && !held.length && !approvedQueued.length && !(building.length && !board)) out.push("- Nothing waiting on you.");
  out.push("");

  // The panel lines sit together: Builds, then WhatsApp (DESIGN §6, W10).
  const wa = input.whatsapp ?? [];
  if (input.buildsView) out.push(...buildsDigestLines(input.buildsView, `${(input.appUrl ?? APP_URL).replace(/\/$/, "")}/#builds`), ...wa, "");
  else if (input.tracks) out.push(...tracksSection(input.tracks), ...wa, "");
  else if (wa.length) out.push(...wa, "");

  // RED: the ONE reminder. Only items that have never been reminded.
  const reminders = input.items.filter((i) => i.lane === "RED" && i.status === "waiting" && !i.reminded_at);
  if (reminders.length) {
    out.push("**Needs your fingerprint** — this is the only reminder; after tonight it holds in Review.");
    for (const r of reminders) out.push(`- RED · ${line(r)}`);
    out.push("");
  }

  const t = addLocalDays(wd, 1);
  const tomorrow = new Date(Date.UTC(t.year, t.month - 1, t.day, 12));
  const ty = tomorrow.getUTCFullYear();
  const tm = tomorrow.getUTCMonth() + 1;
  const td = tomorrow.getUTCDate();
  const yellowWaiting = rows.length;
  const redHolding = held.filter((i) => i.lane === "RED").length + reminders.length;

  if (erev) {
    const next = nextOpenSlot(cfg, erev.candle);
    const to = next ? (next.kind === "motzei" ? `motzei ${next.window?.label ?? erev.entering}` : fmtWeekday(next.at, cfg.tz)) : "after the chag";
    const when = next ? `${fmtWeekday(next.at, cfg.tz)} ${fmtTime(next.at, cfg.tz)}` : "it ends";
    out.push(`**Carries to ${to}** — nothing pings until ${when}`);
    const carry: string[] = [];
    if (yellowWaiting) carry.push(`${yellowWaiting} waiting for a yes`);
    if (redHolding) carry.push(`${redHolding} RED holding`);
    if (approvedQueued.length) carry.push(`${approvedQueued.length} approved, queued`);
    if (input.buildsView?.tally.open) carry.push(`${input.buildsView.tally.open} open on the board`);
    else if (input.tracks?.length) carry.push(`${input.tracks.length} open on the board`);
    else if (building.length) carry.push(`${building.length} ${building.length === 1 ? "build" : "builds"} in flight`);
    out.push(`- ${carry.length ? carry.join(" · ") : "Nothing carries."}`);
    out.push("", erev.entering === "Shabbat" ? "שבת שלום." : "חג שמח.");
  } else {
    const label = fmtDay(tomorrow, "UTC");
    const tomorrowSlots = slotsForDate(cfg, ty, tm, td).filter((s) => !restrictionAt(s.at, cfg.place).restricted);
    const restrictedAllDay = restrictionAt(new Date(Date.UTC(ty, tm - 1, td, 16)), cfg.place);
    out.push(`**Tomorrow · ${label}**`);
    if (restrictedAllDay.restricted) {
      const motzei = tomorrowSlots.find((x) => x.kind === "motzei");
      out.push(`- ${restrictedAllDay.reason} — quiet${motzei ? ` until ${slotPhrase(motzei, cfg)}` : ", nothing scheduled"}.`);
    } else {
      const note = notableDay(cfg.place, ty, tm, td);
      if (note) out.push(`- ${note}`);
      const phrase = tomorrowSlots.map((x) => slotPhrase(x, cfg)).join(" · ");
      out.push(`- ${phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : "Nothing scheduled"}`);
    }
    out.push(...tomorrowAgendaLines(input, restrictedAllDay.restricted));
    const onYou: string[] = [];
    if (yellowWaiting) onYou.push(`${yellowWaiting} for a yes`);
    if (redHolding) onYou.push(`${redHolding} RED holding`);
    out.push(`- Waiting on you: ${onYou.length ? onYou.join(" · ") : "nothing"}`);
    const motion: string[] = [];
    if (building.length) motion.push(`${building.length} ${building.length === 1 ? "build" : "builds"}`);
    if (approvedQueued.length) motion.push(`${approvedQueued.length} approved, queued to run`);
    if (motion.length) out.push(`- In motion: ${motion.join(" · ")}`);
  }

  const fold = foldNote(input);
  if (fold) out.push("", fold);
  return { text: out.join("\n").trim(), numbering, remindedIds: reminders.map((r) => r.id) };
}

/**
 * Motzei: the first message after every Shabbat / Yom Tov
 * block, at nightfall. Two sections: what ran over Shabbat (GREEN, grouped by
 * desk) and what needs a yes (YELLOW and RED, numbered — RED still means the
 * brief + fingerprint in Review; a chat "yes" on a RED number is refused).
 * RED items shown here have had their one reminder.
 */
export function composeMotzei(input: ComposeInput): Composed {
  const { now, cfg, slot, items } = input;
  const w = slot.window;
  const label = w?.label ?? "Shabbat";
  const start = w?.start ?? input.since;
  const out: string[] = [`**Motzei ${label} · ${fmtDay(now, cfg.tz)}**${label === "Shabbat" ? " — שבוע טוב" : ""}`, ""];

  out.push(`**Done over ${label}**`);
  const green = items
    .filter((i) => i.lane === "GREEN" && within(i.created, start, now))
    .sort((a, b) => a.created.localeCompare(b.created));
  const byDesk = new Map<string, ReviewItem[]>();
  for (const g of green) byDesk.set(g.desk, [...(byDesk.get(g.desk) ?? []), g]);
  let firstGroup = true;
  for (const [desk, list] of byDesk) {
    // A blank line between groups, or markdown folds the label into the list above.
    if (!firstGroup) out.push("");
    firstGroup = false;
    out.push(`_${desk}_`);
    for (const g of list) out.push(`- ${g.title}${g.cost_risk ? ` · ${g.cost_risk}` : ""}`);
  }
  const builds = latestByName(input.builds).filter((b) => BUILD_FINISHED.has(b.state) && inWindow(b, start, now));
  if (builds.length) {
    if (!firstGroup) out.push("");
    out.push("_Builds_");
    for (const b of builds) out.push(`- ${b.name}${agentLabel(b.agent)}`);
  }
  if (!green.length && !builds.length) out.push("- Nothing ran.");
  out.push("");

  const { numbering, rows } = numberWaiting(input, true, slot.key, ["YELLOW", "RED"]);
  const anyRed = rows.some((r) => r.item.lane === "RED");
  if (rows.length) {
    out.push(`**Needs your yes** — reply like "yes 1, 2, no 3"${anyRed ? "; RED = brief + fingerprint in Review" : ""}`);
    for (const { n, item } of rows) {
      out.push(`${n}. ${item.lane === "RED" ? "RED · " : ""}${line(item)}${item.lane === "RED" ? " — fingerprint in Review" : ""}`);
    }
  } else {
    out.push("**Needs your yes** — nothing. Clean slate.");
  }
  const held = items.filter((i) => i.status === "held").length;
  if (held) out.push(`On hold: ${held} — in Review whenever you want them.`);

  const fold = foldNote(input);
  if (fold) out.push("", fold);
  const reminded = rows.filter((r) => r.item.lane === "RED" && !r.item.reminded_at).map((r) => r.item.id);
  return { text: out.join("\n").trim(), numbering, remindedIds: reminded };
}
