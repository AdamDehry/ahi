/**
 * compose.ts — the calendar payload and a block's briefing, from the plan
 * (blocks.ts) and the raw feeds (sources.ts). Pure apart from what the
 * injected sources read.
 *
 * Three things ride on top of the grid:
 *   LINES      everything that happened, one plain line each, tagged to a
 *              block kind (sales · business · fun-build · os · learning).
 *              The CURRENT block shows its newest few; any block's briefing
 *              shows its own.
 *   WORK       what each agent is doing right now (running builds), marked
 *              for the current or the next block when the tags line up.
 *              Untagged work is never dropped — it sits in the background
 *              lane as "Other".
 *   ATTENTION  what needs the owner: an open build question, a review card waiting
 *              for his yes, a call Michael made on his own that he can still
 *              overrule. Each carries `unread` (read-state.ts); the badge is
 *              the count of unread ones, nothing else.
 */
import { localParts } from "../local-time.js";
import { addLocalDays } from "../local-time.js";
import type { LocalDate } from "../workday.js";
import { currentBlock, dateKey, nextBlock, segmentsForDay, type Block } from "./blocks.js";
import type { Decision } from "./decisions.js";
import { badgeText } from "./read-state.js";
import type { RawBuild, RawRecord, ScheduleSources } from "./sources.js";
import { tagFor, tagLabel, type TagRules } from "./tags.js";
import type { WeekFile } from "./week.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far back lines are gathered. */
export const LINES_LOOKBACK_MS = 8 * DAY;
/** A "running" build silent this long is not shown as live work. */
export const WORK_QUIET_MS = 36 * HOUR;
/** A decision stays in the badge's reach this long (it stays listed for a week). */
export const DECISION_ATTENTION_MS = 48 * HOUR;
export const CURRENT_LINES = 5;
export const BRIEFING_LINES = 12;

export type LineSource = "build" | "review" | "activity" | "decision";

export interface BriefLine {
  id: string;
  at: string;
  text: string;
  who: string;
  tag: string | null;
  source: LineSource;
}

export interface WorkRow {
  build: string;
  agent: string;
  title: string;
  now: string;
  at: string;
  tag: string | null;
  tagLabel: string;
  /** This work feeds the current block / the next one. */
  for: "now" | "next" | null;
}

export interface DecisionRow {
  id: string;
  at: string;
  tag: string | null;
  tagLabel: string;
  decision: string;
  why: string;
  overruled: { at: string; by: string; note: string | null; delivered: boolean } | null;
}

export type AttentionKind = "question" | "review" | "decision";

export interface AttentionRow {
  id: string;
  at: string;
  kind: AttentionKind;
  text: string;
  who: string;
  tag: string | null;
  urgent: boolean;
  unread: boolean;
  /** The block this item opens (its tag's current/next block), or null. */
  block: string | null;
}

export type BlockStatus = "past" | "now" | "next" | "later";

export interface BlockOut {
  id: string;
  date: string;
  title: string;
  short: string | null;
  kind: string;
  tags: string[];
  approx: boolean;
  detail: string | null;
  start: string;
  end: string;
  sacred: boolean;
  clipped: boolean;
  status: BlockStatus;
  /** Unread attention items that open this block. */
  unread: number;
}

export interface DayOut {
  date: string;
  weekday: number;
  isToday: boolean;
  segments: Array<{ id: string; startMin: number; endMin: number; continued: boolean; continues: boolean }>;
}

export interface ScheduleView {
  now: string;
  zone: string;
  title: string;
  approved: string;
  note: string | null;
  source: "file" | "seed";
  error: string | null;
  kinds: WeekFile["kinds"];
  tagLabels: Record<string, string>;
  today: string;
  weekStart: string;
  days: DayOut[];
  blocks: Record<string, BlockOut>;
  current: { block: string; lines: BriefLine[] } | null;
  next: string | null;
  background: { work: WorkRow[]; decisions: DecisionRow[] };
  attention: AttentionRow[];
  unread: number;
  badge: string;
}

export interface Briefing {
  block: BlockOut;
  lines: BriefLine[];
  prepping: WorkRow[];
  attention: AttentionRow[];
  decisions: DecisionRow[];
  /** A plain sentence when there is nothing agent-side for this block. */
  quiet: string | null;
}

// ── gathering ─────────────────────────────────────────────────────────

const human = (name: string) => name.replace(/[-_]+/g, " ").trim();
const AGENT_NAME: Record<string, string> = { michael: "Michael", zali: "Zali", avi: "Avi", miriam: "Miriam" };
export const agentName = (a: string) => AGENT_NAME[a.toLowerCase()] ?? (a ? a[0].toUpperCase() + a.slice(1) : "An agent");

interface Gathered {
  /** False when any source failed to read this time — the lists may be missing live items. */
  complete: boolean;
  lines: BriefLine[];
  work: Array<Omit<WorkRow, "for">>;
  attention: Array<Omit<AttentionRow, "unread" | "block">>;
  decisions: DecisionRow[];
}

function lineFor(rec: RawRecord, title: string): string {
  switch (rec.kind) {
    case "needs_operator":
      return `${title} asked you: ${rec.question ?? rec.now}`;
    case "closed":
      return `${title} finished: ${rec.finished}`;
    case "failed":
      return `${title} stopped: ${rec.now}`;
    default:
      return `${title}: ${rec.finished}`;
  }
}

export function gather(sources: ScheduleSources, rules: TagRules, owner: string, now: Date): Gathered {
  const since = new Date(now.getTime() - LINES_LOOKBACK_MS);
  let complete = true;
  const safe = <T,>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch (err) {
      complete = false;
      console.error("[schedule] source failed:", err);
      return fallback;
    }
  };
  const lines: BriefLine[] = [];
  const work: Gathered["work"] = [];
  const attention: Gathered["attention"] = [];

  for (const b of safe(() => sources.builds(since), [] as RawBuild[])) {
    const recs = safe(() => sources.records(b.id), [] as RawRecord[]);
    const latest = recs[recs.length - 1] ?? null;
    const title = human(latest?.title || b.name);
    const tag = tagFor(b.name, rules, b.briefTag);
    const who = agentName(b.agent);
    for (const r of recs) {
      if (r.at < since) continue;
      lines.push({ id: `rec:${b.id}:${r.id}`, at: r.at.toISOString(), text: lineFor(r, title), who, tag, source: "build" });
    }
    const running = b.state === "running";
    const lastAt = b.lastEventAt ?? latest?.at ?? b.created;
    if (running && now.getTime() - lastAt.getTime() <= WORK_QUIET_MS) {
      work.push({ build: b.id, agent: who, title, now: latest?.now ?? "Starting", at: (latest?.at ?? b.created).toISOString(), tag, tagLabel: tagLabel(tag, rules) });
    }
    if (running && latest?.kind === "needs_operator") {
      attention.push({ id: `q:${b.id}:${latest.id}`, at: latest.at.toISOString(), kind: "question", text: `${title} asks: ${latest.question ?? latest.now}`, who, tag, urgent: true });
    }
  }

  for (const it of safe(() => sources.review(owner), [])) {
    const tag = tagFor(`${it.title} ${it.ref ?? ""}`, rules);
    if (it.status === "waiting") {
      lines.push({ id: `rv:${it.id}:waiting`, at: it.created, text: `Waiting for your yes: ${it.title}`, who: "Review", tag, source: "review" });
      attention.push({ id: `rv:${it.id}`, at: it.created, kind: "review", text: `Waiting for your yes: ${it.title}`, who: "Review", tag, urgent: it.lane === "RED" });
    }
    if (it.decided_at && it.status !== "waiting" && Date.parse(it.decided_at) >= since.getTime()) {
      const verb = it.status === "denied" ? "said no to" : it.status === "held" ? "held" : "approved";
      lines.push({ id: `rv:${it.id}:decided`, at: it.decided_at, text: `You ${verb}: ${it.title}`, who: "Review", tag, source: "review" });
    }
    if (it.done_at && Date.parse(it.done_at) >= since.getTime()) {
      lines.push({ id: `rv:${it.id}:done`, at: it.done_at, text: `Done: ${it.title}`, who: "Review", tag, source: "review" });
    }
  }

  for (const a of safe(() => sources.activity(since), [])) {
    const m = /^(Michael|Zali|Avi|Miriam)\b[:\s]*(.*)$/.exec(a.title);
    lines.push({ id: `act:${a.at.toISOString()}:${a.title.slice(0, 40)}`, at: a.at.toISOString(), text: a.title, who: m ? m[1] : "Michael", tag: tagFor(a.title, rules), source: "activity" });
  }

  const decisions: DecisionRow[] = [];
  for (const d of safe(() => sources.decisions(), [] as Decision[])) {
    const t = Date.parse(d.at);
    if (!Number.isFinite(t) || t < now.getTime() - 7 * DAY) continue;
    decisions.push({ id: d.id, at: d.at, tag: d.tag, tagLabel: tagLabel(d.tag, rules), decision: d.decision, why: d.why, overruled: d.overruled });
    lines.push({ id: `dec:${d.id}`, at: d.at, text: `Michael decided: ${d.decision}`, who: "Michael", tag: d.tag, source: "decision" });
    if (!d.overruled && now.getTime() - t <= DECISION_ATTENTION_MS) {
      attention.push({ id: `dec:${d.id}`, at: d.at, kind: "decision", text: `Michael decided: ${d.decision}`, who: "Michael", tag: d.tag, urgent: false });
    }
  }

  const newest = (a: { at: string }, b: { at: string }) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  return { complete, lines: lines.sort(newest), work: work.sort(newest), attention: attention.sort(newest), decisions };
}

// ── composing ─────────────────────────────────────────────────────────

function statusOf(b: Block, cur: Block | null, nxt: Block | null, now: Date): BlockStatus {
  if (cur && b.id === cur.id) return "now";
  if (nxt && b.id === nxt.id) return "next";
  return b.end.getTime() <= now.getTime() ? "past" : "later";
}

/** The block an item with `tag` belongs to: the current block if it owns the tag, else the next block today-or-later that does. */
export function blockForTag(blocks: Block[], tag: string | null, now: Date): Block | null {
  if (!tag) return null;
  const t = now.getTime();
  return blocks.find((b) => b.tags.includes(tag) && b.end.getTime() > t) ?? null;
}

export interface ComposeInput {
  now: Date;
  week: WeekFile;
  rules: TagRules;
  /** Planned blocks covering at least the shown week and the next block after now. */
  blocks: Block[];
  weekStart: LocalDate;
  today: LocalDate;
  gathered: Gathered;
  read: Map<string, string>;
  source: "file" | "seed";
  error: string | null;
}

export function attentionRows(input: Pick<ComposeInput, "blocks" | "now" | "read">, gathered: Gathered): AttentionRow[] {
  return gathered.attention.map((a) => ({ ...a, unread: !input.read.has(a.id), block: blockForTag(input.blocks, a.tag, input.now)?.id ?? null }));
}

function blockOut(b: Block, cur: Block | null, nxt: Block | null, now: Date, attention: AttentionRow[]): BlockOut {
  return {
    id: b.id,
    date: b.date,
    title: b.title,
    short: b.short,
    kind: b.kind,
    tags: b.tags,
    approx: b.approx,
    detail: b.detail,
    start: b.start.toISOString(),
    end: b.end.toISOString(),
    sacred: b.sacred,
    clipped: b.clipped,
    status: statusOf(b, cur, nxt, now),
    unread: attention.filter((a) => a.unread && a.block === b.id).length,
  };
}

const workFor = (w: Gathered["work"][number], cur: Block | null, nxt: Block | null): WorkRow => ({
  ...w,
  for: w.tag && cur?.tags.includes(w.tag) ? "now" : w.tag && nxt?.tags.includes(w.tag) ? "next" : null,
});

export function composeView(input: ComposeInput): ScheduleView {
  const { now, week, blocks } = input;
  const cur = currentBlock(blocks, now);
  const nxt = nextBlock(blocks, now);
  const attention = attentionRows(input, input.gathered);
  const days: DayOut[] = [];
  const outBlocks: Record<string, BlockOut> = {};
  const todayKey = dateKey(input.today);
  for (let i = 0; i < 7; i++) {
    const d = addLocalDays(input.weekStart, i);
    const segs = segmentsForDay(blocks, d, week.zone);
    for (const s of segs) outBlocks[s.block.id] ??= blockOut(s.block, cur, nxt, now, attention);
    days.push({ date: dateKey(d), weekday: d.weekday, isToday: dateKey(d) === todayKey, segments: segs.map((s) => ({ id: s.block.id, startMin: s.startMin, endMin: s.endMin, continued: s.continued, continues: s.continues })) });
  }
  // Current/next may sit outside the shown week (browsing another week): still describe them.
  if (cur) outBlocks[cur.id] ??= blockOut(cur, cur, nxt, now, attention);
  if (nxt) outBlocks[nxt.id] ??= blockOut(nxt, cur, nxt, now, attention);

  const unread = attention.filter((a) => a.unread).length;
  // Work tagged for the current block, then the next, then the rest — nothing dropped.
  const rank = (w: WorkRow) => (w.for === "now" ? 0 : w.for === "next" ? 1 : 2);
  const work = input.gathered.work.map((w) => workFor(w, cur, nxt)).sort((a, b) => rank(a) - rank(b));
  return {
    now: now.toISOString(),
    zone: week.zone,
    title: week.title,
    approved: week.approved,
    note: week.note ?? null,
    source: input.source,
    error: input.error,
    kinds: week.kinds,
    tagLabels: input.rules.tags,
    today: todayKey,
    weekStart: dateKey(input.weekStart),
    days,
    blocks: outBlocks,
    current: cur ? { block: cur.id, lines: linesForBlock(cur, input.gathered.lines, now).slice(0, CURRENT_LINES) } : null,
    next: nxt?.id ?? null,
    background: { work, decisions: input.gathered.decisions },
    attention,
    unread,
    badge: badgeText(unread),
  };
}

/**
 * A block's lines, newest first: what happened inside it (to now, for the
 * current block), topped up with the newest earlier lines of the same kind
 * from the 24 hours before it — a block that just began still says where
 * its work stands. A block with no tags has no agent lines.
 */
export function linesForBlock(b: Block, lines: BriefLine[], now: Date): BriefLine[] {
  if (!b.tags.length) return [];
  const hi = Math.min(b.end.getTime(), now.getTime());
  const lo = b.start.getTime() - DAY;
  return lines.filter((l) => {
    if (!l.tag || !b.tags.includes(l.tag)) return false;
    const t = Date.parse(l.at);
    return t <= hi && t >= lo;
  });
}

export function composeBriefing(input: ComposeInput, id: string): Briefing | null {
  const { now, blocks } = input;
  const b = blocks.find((x) => x.id === id);
  if (!b) return null;
  const cur = currentBlock(blocks, now);
  const nxt = nextBlock(blocks, now);
  const attention = attentionRows(input, input.gathered).filter((a) => a.block === b.id || (a.tag !== null && b.tags.includes(a.tag) && b.end.getTime() > now.getTime()));
  const out = blockOut(b, cur, nxt, now, attention);
  const lines = out.status === "later" ? [] : linesForBlock(b, input.gathered.lines, now).slice(0, BRIEFING_LINES);
  const prepping = out.status === "past" ? [] : input.gathered.work.filter((w) => w.tag && b.tags.includes(w.tag)).map((w) => workFor(w, cur, nxt));
  const decisions = input.gathered.decisions.filter((d) => d.tag && b.tags.includes(d.tag));
  let quiet: string | null = null;
  if (b.sacred) quiet = b.detail ?? "No calls, no work.";
  else if (!b.tags.length) quiet = "Your time. No agent work is tied to this block.";
  else if (!lines.length && !prepping.length && !attention.length && !decisions.length)
    quiet = out.status === "later" ? "Nothing being prepped for this block yet." : "Nothing has come in for this block yet.";
  return { block: out, lines, prepping, attention, decisions, quiet };
}

/** For logs/tests: "Tue 9:30 AM" in the zone. */
export function shortWhen(d: Date, zone: string): string {
  const p = localParts(d, zone);
  const h = p.hour % 12 || 12;
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.weekday]} ${h}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "AM" : "PM"}`;
}
