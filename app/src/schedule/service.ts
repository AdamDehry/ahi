/**
 * service.ts — the calendar desk: loads the week + tags, plans the blocks,
 * gathers the feeds, and keeps the owner's read marks. Clock, folders and feeds
 * are injected so tests and the preview drive it without the gateway.
 */
import { join } from "path";
import { addLocalDays, localDayDiff, wallTimeToUtc } from "../local-time.js";
import type { LocalDate } from "../workday.js";
import { dateKey, parseDateKey, planDays, todayAndWeek, type Block, type SacredWindow } from "./blocks.js";
import { composeBriefing, composeView, gather, type Briefing, type ComposeInput, type ScheduleView } from "./compose.js";
import { appendOverrule, appendOverruleDelivered, isDecisionId, readDecisions, type Decision } from "./decisions.js";
import { badgeText, ReadState } from "./read-state.js";
import { sacredWindows } from "./sacred.js";
import type { ScheduleSources } from "./sources.js";
import { loadJson, loadWeek, scheduleDir, seedDir } from "./week.js";
import { validateTags, type TagRules } from "./tags.js";

/** How many weeks either side of this week the calendar browses (and a briefing may be asked for). */
export const BROWSE_WEEKS = 8;

export interface ScheduleServiceOptions {
  sources: ScheduleSources;
  readState: ReadState;
  dirs?: { live: string; seed: string };
  now?: () => Date;
  windows?: (first: LocalDate, days: number) => SacredWindow[];
  /** Tell Michael (his own quiet turn) — used by Overrule. */
  wake?: ((owner: string, text: string) => Promise<void>) | null;
}

export class ScheduleService {
  private readonly dirs: { live: string; seed: string };
  private readonly clock: () => Date;
  private readonly windows: (first: LocalDate, days: number) => SacredWindow[];

  constructor(private readonly opts: ScheduleServiceOptions) {
    this.dirs = opts.dirs ?? { live: scheduleDir(), seed: seedDir() };
    this.clock = opts.now ?? (() => new Date());
    this.windows = opts.windows ?? sacredWindows;
  }

  get decisionsPath(): string {
    return join(this.dirs.live, "decisions.jsonl");
  }

  private plan(from: LocalDate, to: LocalDate, zone: string, week: ReturnType<typeof loadWeek>["value"]): Block[] {
    const days = localDayDiff(wallTimeToUtc({ ...from, hour: 12, minute: 0 }, zone), wallTimeToUtc({ ...to, hour: 12, minute: 0 }, zone), zone) + 1;
    return planDays(week, from, days, this.windows(from, days));
  }

  private input(user: string, focus: LocalDate | null, weekOffset = 0): ComposeInput {
    const now = this.clock();
    const w = loadWeek(this.dirs);
    const t = loadJson<TagRules>("tags.json", validateTags, this.dirs);
    const zone = w.value.zone;
    const { today, weekStart: thisWeek } = todayAndWeek(now, zone);
    const weekStart = addLocalDays(thisWeek, weekOffset * 7);
    // Span: the shown week, today ± a week (current / next block), and the focus date.
    const anchors = [addLocalDays(weekStart, 0), addLocalDays(weekStart, 6), addLocalDays(today, -1), addLocalDays(today, 8)];
    if (focus) anchors.push(addLocalDays(focus, -1), addLocalDays(focus, 1));
    const key = (d: LocalDate) => d.year * 10000 + d.month * 100 + d.day;
    const from = anchors.reduce((a, b) => (key(b) < key(a) ? b : a));
    const to = anchors.reduce((a, b) => (key(b) > key(a) ? b : a));
    const blocks = this.plan(from, to, zone, w.value);
    const errors = [w.error && `week.json: ${w.error}`, t.error && `tags.json: ${t.error}`].filter((e): e is string => !!e && !e.endsWith(": missing"));
    return {
      now,
      week: w.value,
      rules: t.value,
      blocks,
      weekStart,
      today,
      gathered: gather(this.opts.sources, t.value, user, now),
      read: this.opts.readState.read(user),
      source: w.source,
      error: errors.length ? errors.join(" · ") : null,
    };
  }

  view(user: string, weekOffset = 0): ScheduleView {
    return composeView(this.input(user, null, Math.max(-BROWSE_WEEKS, Math.min(BROWSE_WEEKS, Math.trunc(weekOffset) || 0))));
  }

  briefing(user: string, blockId: string): Briefing | null {
    const m = /^(\d{4}-\d{2}-\d{2})@\d{2}:\d{2}$/.exec(blockId) ?? /^sacred@(\d{4}-\d{2}-\d{2})T/.exec(blockId);
    const focus = m ? parseDateKey(m[1]) : null;
    if (!focus || dateKey(focus) !== m![1]) return null;
    // Only the weeks the calendar can show (± BROWSE_WEEKS around this week) — checked BEFORE
    // any planning, so a far date (9999-12-31) is a fast 404, not a planner walking the years.
    const zone = loadWeek(this.dirs).value.zone;
    const { weekStart } = todayAndWeek(this.clock(), zone);
    const lo = addLocalDays(weekStart, -7 * BROWSE_WEEKS - 1);
    const hi = addLocalDays(weekStart, 7 * BROWSE_WEEKS + 7);
    const key = (d: LocalDate) => d.year * 10000 + d.month * 100 + d.day;
    if (key(focus) < key(lo) || key(focus) > key(hi)) return null;
    return composeBriefing(this.input(user, focus), blockId);
  }

  /** The badge alone (cheap enough for a poll). */
  badge(user: string): { unread: number; badge: string } {
    const v = this.view(user);
    return { unread: v.unread, badge: v.badge };
  }

  /**
   * Ids that need him right now, and whether that list is COMPLETE (every source
   * read). Read marks of live ids are never pruned; when the list is incomplete
   * (a source is down) nothing is pruned at all — an outage must not make a
   * still-waiting item look gone and come back unread.
   */
  private live(user: string): { ids: Set<string>; complete: boolean } {
    const input = this.input(user, null);
    return { ids: new Set(composeView(input).attention.map((a) => a.id)), complete: input.gathered.complete };
  }

  /** The live set to prune against, or undefined (= no pruning) when it is incomplete. */
  private pruneSet(user: string): Set<string> | undefined {
    const l = this.live(user);
    return l.complete ? l.ids : undefined;
  }

  markRead(user: string, ids: string[]): { marked: number; unread: number; badge: string } {
    const marked = this.opts.readState.mark(user, ids.slice(0, 200), this.clock(), this.pruneSet(user));
    return { marked, ...this.badge(user) };
  }

  /** Clear all: every item that needs him right now is marked read (and, being live, kept). */
  markAllRead(user: string): { marked: number; unread: number; badge: string } {
    const l = this.live(user);
    const marked = this.opts.readState.mark(user, [...l.ids], this.clock(), l.complete ? l.ids : undefined);
    return { marked, ...this.badge(user) };
  }

  /** Overrule ids whose wake is in flight — one attempt at a time per overrule. */
  private readonly waking = new Set<string>();

  async overrule(user: string, id: string, note: string | null): Promise<{ ok: true; decision: Decision; already: boolean; woke: boolean } | { ok: false; status: 400 | 404; reason: string }> {
    if (!isDecisionId(id)) return { ok: false, status: 400, reason: "bad decision id" };
    const r = appendOverrule(this.decisionsPath, id, user, note, this.clock());
    if (!r.ok) return { ok: false, status: 404, reason: r.reason };
    this.opts.readState.mark(user, [`dec:${id}`], this.clock(), this.pruneSet(user));
    // A fresh overrule, or one whose wake never landed, is (re)delivered; a delivered one is left alone.
    const woke = r.decision.overruled?.delivered ? false : await this.deliverOverrule(user, r.decision);
    const decision = woke && r.decision.overruled ? { ...r.decision, overruled: { ...r.decision.overruled, delivered: true } } : r.decision;
    return { ok: true, decision, already: r.already, woke };
  }

  /** Wake Michael with one overrule; record delivery only when the wake landed. */
  private async deliverOverrule(user: string, d: Decision): Promise<boolean> {
    if (!this.opts.wake || !d.overruled || this.waking.has(d.id)) return false;
    this.waking.add(d.id);
    const note = d.overruled.note;
    const text =
      `the owner overruled a call you made on your own (Schedule): "${d.decision}"` +
      (d.why ? ` (your reason: ${d.why})` : "") +
      (note ? `. His note: ${note}` : "") +
      ". Undo or re-plan it, and tell him in one line what changed.";
    try {
      await this.opts.wake(user, text);
      appendOverruleDelivered(this.decisionsPath, d.id, this.clock());
      return true;
    } catch (err) {
      console.error("[schedule] overrule wake failed — recorded, will retry:", err);
      return false;
    } finally {
      this.waking.delete(d.id);
    }
  }

  /** The retry sweep: every overrule from the last week whose wake never landed gets another try. */
  async retryOverruleWakes(): Promise<number> {
    const cutoff = this.clock().getTime() - 7 * 86_400_000;
    let delivered = 0;
    for (const d of readDecisions(this.decisionsPath)) {
      if (!d.overruled || d.overruled.delivered || Date.parse(d.overruled.at) < cutoff) continue;
      if (await this.deliverOverrule(d.overruled.by, d)) delivered++;
    }
    return delivered;
  }

  /** For the badge's "9+" in logs/tests. */
  static badgeText = badgeText;
}
