/**
 * builds.ts — the Builds panel's one read ("visually see them …
 * so that they all close out so we don't just keep building up more and more
 * builds that never get closed").
 *
 * PURE. It takes what the gateway already holds — the track registry, the
 * foreman ledger runs, the status timelines and the review items — and
 * derives one board, sorted by whose move it is (design C2):
 *
 *   needs_you → ready → moving → stuck → queued → closed_week
 *
 * The unit is the TRACK, not the build run (C1): runs of one job collapse
 * into one card, and runs that never launched, were superseded, or failed
 * and were redone are history (`counted: false`) — they never make a card
 * stuck. "Done" is not "closed" (C3): a finished build sits in `ready` until
 * The owner closes it. No clock, no I/O: the desk reads, this decides, and the
 * tests pin it against real ledger fixtures.
 */
import { FALLBACK } from "../foreman-messages/render.js";
import type { StatusRecord } from "../foreman-messages/record.js";
import type { TimelineEntry } from "../foreman-messages/timeline.js";
import { shipState, type ShipState } from "../foreman-messages/ship.js";
import { runGroupKey, type BuildSummary } from "./ledger.js";
import { isOpen, type Track, type TrackStep } from "./tracks.js";
import { canonicalAgentId } from "../agent-rename.js";
import type { ReviewItem } from "./types.js";

export type SectionKey = "needs_you" | "ready" | "moving" | "stuck" | "queued" | "closed_week";
export const SECTION_ORDER: readonly SectionKey[] = ["needs_you", "ready", "moving", "stuck", "queued", "closed_week"];

export type Kicker = "your-step" | "question" | "in-review" | "ship" | "shipping" | "rolled-back" | "now" | "started" | "built" | "stuck" | "queued" | "closed";
export type Agent = "michael" | "zali" | "avi" | "foreman";

export interface CardRun {
  build: string;
  agent: string;
  started: string;
  state: string;
  /** Why the run ended the way it did: a timeline cause, or the ledger's reading of it. */
  cause: string | null;
  /** false: never launched, superseded, or failed and then redone — history, never "stuck". */
  counted: boolean;
  /** "codex" runs open a live transcript in the app (src/codex-live). Absent = claude / unknown. */
  runtime?: string;
}

export interface Card {
  id: string;
  title: string;
  order: number | null;
  kicker: Kicker;
  from: Agent | null;
  opened_at: string;
  last_activity_at: string | null;
  ask: string | null;
  /** The run whose newest record is that question — an answer sent from the app clears it there (build_answered.sh). */
  ask_build: string | null;
  /** The id of that needs_operator record — an answer clears THIS question only, never a newer one. */
  ask_record: string | null;
  review_item: { id: string; lane: "GREEN" | "YELLOW" | "RED"; title: string } | null;
  done: string;
  left: string;
  steps: TrackStep[] | null;
  now: { text: string; at: string } | null;
  checks: { passed: number; total: number } | null;
  close_note: string | null;
  runs: CardRun[];
  closed: { at: string; how: string } | null;
  /** Every registry row this card stands for — Close closes all of them. */
  track_ids: string[];
  /** The ship lane of the card's lead run (ship.ts), or null when nothing was ever readied. */
  ship: ShipState | null;
}

export interface BuildsView {
  now: string;
  tz: string;
  tally: { open: number; needs_you: number; oldest: { days: number; ms: number; id: string; title: string } | null };
  sections: Record<SectionKey, Card[]>;
  /** Sources that failed this read — the panel shows a banner, never a blank. */
  partial: string[];
}

export interface TimelineItem {
  kind: "progress" | "needs_operator" | "closed" | "failed" | "note" | "ship";
  at: string;
  finished: string | null;
  now: string | null;
  question: string | null;
  checks: { passed: number; total: number } | null;
  cause: string | null;
}

/** One ship stage as a timeline line: "Approved by you · restart waits for a call", "Shipped · back on abc1234 after 6 s dark". */
export function shipLine(e: Extract<TimelineEntry, { type: "ship" }>): string {
  switch (e.stage) {
    case "candidate":
      return "Built — a ship manifest is attached, waiting on Michael's review.";
    case "ready":
      return `Reviewed by ${e.by === "michael" ? "Michael" : e.by ?? "Michael"} — ready to ship.`;
    case "approved":
      return `Approved by ${e.by === "owner" ? "you" : e.by ?? "you"} — restart ${e.restart === "now" ? "right away" : "waits for a live call to end"}.`;
    case "started":
      return `Ship started — rollback point ${e.sha ?? "recorded"}.`;
    case "merged":
      return `Merged onto main at ${e.sha ?? "the new tip"}.`;
    case "built":
      return "Server and app built.";
    case "restarting":
      return "Gateway restarting.";
    case "result": {
      const dark = e.dark_s !== null && e.dark_s !== undefined ? ` after ${e.dark_s} s dark` : "";
      const why = e.reason ? ` — ${e.reason.replace(/[.!?…]$/, "")}` : "";
      if (e.outcome === "ok") return `Shipped — back on ${e.sha ?? "the new build"}${dark}.`;
      if (e.outcome === "rolled_back") return `Rolled back to ${e.sha ?? "the previous build"}${dark}${why}.`;
      return `Ship stopped${why}.`;
    }
  }
}

export interface BuildDetail extends Card {
  section: SectionKey;
  /** Newest run first; entries newest first. */
  timeline: Array<{ run: string; agent: string; started: string; state: string; cause: string | null; counted: boolean; entries: TimelineItem[] }>;
}

export interface BuildsInput {
  now: Date;
  tz: string;
  /** The whole registry, closed rows included (closed_week reads them). */
  tracks: Track[];
  runs: BuildSummary[];
  /** build id → its timeline entries in write order. Builds without one are simply absent. */
  timelines: ReadonlyMap<string, TimelineEntry[]>;
  reviewItems: ReadonlyArray<Pick<ReviewItem, "id" | "lane" | "status" | "track"> & { title?: string }>;
  partial?: string[];
}

const DAY = 86_400_000;
const QUIET_MS = 3 * DAY; // the review desk's STALE_MS — "old" means the same thing on both surfaces
const WEEK = 7 * DAY;
const FINISHED = new Set(["done", "shipped"]);
const TROUBLE = new Set(["failed", "abandoned", "stalled"]);
const AGENTS = new Set<Agent>(["michael", "zali", "avi", "foreman"]);

// ── runs → groups ───────────────────────────────────────────────────────

/**
 * Which runs are one job. Same name group (redo suffixes stripped), an
 * explicit `superseded … resumed as <id>`, or a "-resume" run started within
 * two hours of a run whose name it extends ("stream-orphan-resume" belongs to
 * "stream-orphan-fix").
 */
export function groupRuns(runs: BuildSummary[]): Map<string, string> {
  const parent = new Map<string, string>(runs.map((r) => [r.id, r.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra);
  };
  const byKey = new Map<string, string>();
  for (const r of runs) {
    const key = runGroupKey(r.name);
    const first = byKey.get(key);
    if (first) union(first, r.id);
    else byKey.set(key, r.id);
  }
  for (const r of runs) if (r.superseded?.by) union(r.id, r.superseded.by);
  for (const r of runs) {
    const key = runGroupKey(r.name);
    if (key === r.name.toLowerCase()) continue; // not a redo-named run
    const near = runs.find(
      (o) => o.id !== r.id && runGroupKey(o.name).startsWith(`${key}-`) && o.created <= r.created && r.created.getTime() - o.created.getTime() <= 2 * 3600_000,
    );
    if (near) union(near.id, r.id);
  }
  const out = new Map<string, string>();
  for (const r of runs) out.set(r.id, find(r.id));
  return out;
}

/** Why a run does not count, or null when it does (BUILD-NOTES §2.4 rule 1). */
export function uncountedReason(run: BuildSummary, group: BuildSummary[]): string | null {
  const later = group.filter((o) => o.id !== run.id && o.created > run.created);
  if (run.state === "failed" && /never launched/i.test(run.stateDetail ?? "")) return "never-launched";
  if (run.superseded) return "superseded";
  if (TROUBLE.has(run.state) && later.some((o) => FINISHED.has(o.state))) return "redone";
  // A run that never logged a start (no events at all) and was followed by
  // another run never ran: the foreman tried again.
  if (run.state === "running" && !run.startedAt && !run.lastEventAt && later.length) return "never-launched";
  return null;
}

function runCause(run: BuildSummary, records: StatusRecord[], uncounted: string | null): string | null {
  if (uncounted) return uncounted;
  const failed = [...records].reverse().find((r) => r.kind === "failed");
  if (failed?.cause) return failed.cause;
  const d = run.stateDetail ?? "";
  if (/corrective close/i.test(d)) return "corrected";
  if (TROUBLE.has(run.state)) {
    if (/tmux session gone|session died|heartbeat/i.test(d)) return "died";
    if (/dark/i.test(d)) return "dark";
    if (run.state === "abandoned") return "abandoned";
    return "error";
  }
  return null;
}

// ── timeline helpers ───────────────────────────────────────────────────

type DatedRecord = StatusRecord & { at: string; bad: Set<string> };

function recordsOf(entries: TimelineEntry[] | undefined): DatedRecord[] {
  const out: DatedRecord[] = [];
  for (const e of entries ?? []) {
    if (e.type !== "record" || !e.record) continue;
    out.push({ ...e.record, at: e.record.at ?? e.ts, bad: new Set(Object.keys(e.textErrors ?? {})) });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const clean = (r: DatedRecord, field: "finished" | "now" | "question" | "title"): string | null => {
  const v = r[field];
  return typeof v === "string" && v && !r.bad.has(field) ? v : null;
};

export function timelineItems(entries: TimelineEntry[] | undefined): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const e of entries ?? []) {
    if (e.type === "michael-reply") {
      if (e.text?.trim()) out.push({ kind: "note", at: e.ts, finished: e.text.trim(), now: null, question: null, checks: null, cause: null });
      continue;
    }
    if (e.type === "ship") {
      out.push({ kind: "ship", at: e.ts, finished: shipLine(e), now: null, question: null, checks: null, cause: e.stage === "result" ? e.outcome ?? null : e.stage });
      continue;
    }
    if (e.type !== "record" || !e.record) continue;
    const r: DatedRecord = { ...e.record, at: e.record.at ?? e.ts, bad: new Set(Object.keys(e.textErrors ?? {})) };
    out.push({
      kind: r.kind,
      at: r.at,
      finished: clean(r, "finished") ?? (r.finished ? FALLBACK.finished : null),
      now: clean(r, "now") ?? (r.kind === "failed" && r.now ? FALLBACK.failed : null),
      question: r.kind === "needs_operator" ? (clean(r, "question") ?? FALLBACK.question) : null,
      checks: r.checks,
      cause: r.cause,
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A record title that is just the build's slug reads like one — humanize it; real prose stays as written. */
function titleOf(t: string | null): string | null {
  if (!t) return null;
  return /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(t) ? humanize(t) : t;
}

/** "torah-convert-fix" → "Torah convert fix". Acronyms belong in a track title. */
export function humanize(name: string): string {
  const s = name.replace(/^\d{8}-\d{6}-/, "").replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Untitled build";
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const maxIso = (...xs: Array<string | null | undefined>) =>
  xs.filter((x): x is string => !!x).reduce<string | null>((m, x) => (!m || Date.parse(x) > Date.parse(m) ? x : m), null);

// ── the board ──────────────────────────────────────────────────────────

interface Draft {
  card: Card;
  track: Track | null;
  runs: BuildSummary[];
  open: boolean;
}

export function deriveBuildsView(input: BuildsInput): BuildsView {
  const drafts = draftCards(input);
  const now = input.now.getTime();
  const sections: Record<SectionKey, Card[]> = { needs_you: [], ready: [], moving: [], stuck: [], queued: [], closed_week: [] };
  for (const d of drafts) {
    const s = sectionOf(d, input);
    if (s) sections[s].push(d.card);
  }
  const age = (c: Card) => now - Date.parse(c.opened_at);
  const quiet = (c: Card) => now - Date.parse(c.last_activity_at ?? c.opened_at);
  sections.needs_you.sort((a, b) => age(b) - age(a));
  sections.ready.sort((a, b) => age(a) - age(b));
  sections.moving.sort((a, b) => age(b) - age(a));
  sections.stuck.sort((a, b) => quiet(b) - quiet(a));
  sections.queued.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || age(b) - age(a));
  sections.closed_week.sort((a, b) => Date.parse(b.closed!.at) - Date.parse(a.closed!.at));

  const open = SECTION_ORDER.filter((s) => s !== "closed_week").flatMap((s) => sections[s]);
  const oldest = open.reduce<Card | null>((m, c) => (!m || age(c) > age(m) ? c : m), null);
  return {
    now: input.now.toISOString(),
    tz: input.tz,
    tally: {
      open: open.length,
      needs_you: sections.needs_you.length,
      oldest: oldest ? { days: Math.floor(age(oldest) / DAY), ms: Math.max(0, age(oldest)), id: oldest.id, title: oldest.title } : null,
    },
    sections,
    partial: [...(input.partial ?? [])],
  };
}

/** One card with its section and full timeline, or null. Any of the card's row ids finds it. */
export function deriveBuildDetail(input: BuildsInput, id: string): BuildDetail | null {
  const view = deriveBuildsView(input);
  for (const s of SECTION_ORDER) {
    const card = view.sections[s].find((c) => c.id === id || c.track_ids.includes(id));
    if (!card) continue;
    const timeline = [...card.runs]
      .sort((a, b) => Date.parse(b.started) - Date.parse(a.started))
      .map((r) => ({ run: r.build, agent: r.agent, started: r.started, state: r.state, cause: r.cause, counted: r.counted, entries: timelineItems(input.timelines.get(r.build)) }));
    return { ...card, section: s, timeline };
  }
  return null;
}

/**
 * A run the ledger still calls "running" whose newest status record says it
 * closed (or failed) HAS ended — the executor's own word is the later fact.
 */
export function effectiveRun(run: BuildSummary, entries: TimelineEntry[] | undefined): BuildSummary {
  if (run.state !== "running") return run;
  const last = recordsOf(entries).at(-1);
  if (last?.kind === "closed") return { ...run, state: "done", stateAt: new Date(last.at) };
  if (last?.kind === "failed") return { ...run, state: "failed", stateAt: new Date(last.at) };
  return run;
}

function draftCards(raw: BuildsInput): Draft[] {
  const input: BuildsInput = { ...raw, runs: raw.runs.map((r) => effectiveRun(r, raw.timelines.get(r.id))) };
  const now = input.now.getTime();
  const runsById = new Map(input.runs.map((r) => [r.id, r]));
  const groupOf = groupRuns(input.runs);
  const groups = new Map<string, BuildSummary[]>();
  for (const r of input.runs) {
    const g = groupOf.get(r.id)!;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(r);
  }
  for (const g of groups.values()) g.sort((a, b) => a.created.getTime() - b.created.getTime());
  const groupRunsOf = (buildId: string): BuildSummary[] => {
    const g = groupOf.get(buildId);
    return g ? groups.get(g)! : runsById.has(buildId) ? [runsById.get(buildId)!] : [];
  };
  const recentlyClosed = (t: Track) => !!t.closed_at && now - Date.parse(t.closed_at) <= WEEK && !(t.closed_how ?? "").startsWith("filed under");

  const drafts: Draft[] = [];
  const claimedGroups = new Set<string>();

  // Real tracks (build order + API) — each one card, carrying every run of
  // every job filed under it.
  for (const t of input.tracks) {
    if (t.source === "build") continue;
    const open = isOpen(t);
    if (!open && !recentlyClosed(t)) continue;
    const runs = uniq(t.builds.flatMap(groupRunsOf));
    for (const r of runs) claimedGroups.add(groupOf.get(r.id) ?? r.id);
    const rowIds = new Set(runs.map((r) => `bld-${r.id}`));
    const members = [t.id, ...input.tracks.filter((x) => x.source === "build" && isOpen(x) && rowIds.has(x.id)).map((x) => x.id)];
    drafts.push({ card: baseCard(t.id, t, runs, members, input), track: t, runs, open });
  }

  // Loose builds — one card per job, keyed by its oldest open row.
  const loose = new Map<string, Track[]>();
  for (const t of input.tracks) {
    if (t.source !== "build") continue;
    const build = t.builds[0] ?? t.id.slice(4);
    const g = groupOf.get(build) ?? build;
    if (claimedGroups.has(g)) continue;
    if (!loose.has(g)) loose.set(g, []);
    loose.get(g)!.push(t);
  }
  for (const [g, rows] of loose) {
    const openRows = rows.filter(isOpen);
    const all = groups.get(g) ?? rows.map((t) => runsById.get(t.builds[0] ?? "")).filter((r): r is BuildSummary => !!r);
    if (openRows.length) {
      // After an earlier close, a new run starts a new card: older runs are the closed card's history.
      const lastClose = rows.filter((t) => !isOpen(t) && t.closed_at).reduce((m, t) => Math.max(m, Date.parse(t.closed_at!)), 0);
      const runs = all.filter((r) => r.created.getTime() > lastClose || openRows.some((t) => t.builds.includes(r.id)));
      const id = openRows.map((t) => t.id).sort()[0];
      drafts.push({ card: baseCard(id, null, runs, openRows.map((t) => t.id), input), track: null, runs, open: true });
    } else {
      const closed = rows.filter(recentlyClosed);
      if (!closed.length) continue;
      const newest = closed.reduce((m, t) => (Date.parse(t.closed_at!) > Date.parse(m.closed_at!) ? t : m));
      const card = baseCard(closed.map((t) => t.id).sort()[0], null, all, closed.map((t) => t.id), input);
      card.closed = { at: newest.closed_at!, how: newest.closed_how ?? newest.state };
      card.kicker = "closed";
      drafts.push({ card, track: null, runs: all, open: false });
    }
  }
  return drafts;
}

function uniq(runs: BuildSummary[]): BuildSummary[] {
  const seen = new Set<string>();
  return runs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).sort((a, b) => a.created.getTime() - b.created.getTime());
}

function baseCard(id: string, track: Track | null, runs: BuildSummary[], trackIds: string[], input: BuildsInput): Card {
  const cardRuns: CardRun[] = runs.map((r) => {
    const why = uncountedReason(r, runs);
    return {
      build: r.id,
      agent: r.agent,
      started: (r.startedAt ?? r.created).toISOString(),
      state: r.state,
      cause: runCause(r, recordsOf(input.timelines.get(r.id)), why),
      counted: why === null,
      ...(r.runtime ? { runtime: r.runtime } : {}),
    };
  });
  const counted = runs.filter((_, i) => cardRuns[i].counted);
  const records = runs.flatMap((r) => recordsOf(input.timelines.get(r.id)).map((rec) => ({ rec, run: r })));
  records.sort((a, b) => Date.parse(a.rec.at) - Date.parse(b.rec.at));
  const newest = <T>(pick: (x: { rec: DatedRecord; run: BuildSummary }) => T | null): T | null => {
    for (let i = records.length - 1; i >= 0; i--) {
      const v = pick(records[i]);
      if (v !== null) return v;
    }
    return null;
  };

  // An open question: a run whose NEWEST record is needs_operator. Anything later from that run answers it.
  let ask: string | null = null;
  let askBuild: string | null = null;
  let askRecord: string | null = null;
  let askAt = 0;
  for (const r of runs) {
    const recs = recordsOf(input.timelines.get(r.id));
    const last = recs[recs.length - 1];
    if (last?.kind === "needs_operator" && Date.parse(last.at) >= askAt) {
      ask = clean(last, "question") ?? FALLBACK.question;
      askBuild = r.id;
      askRecord = last.id;
      askAt = Date.parse(last.at);
    }
  }

  const lastCounted = counted[counted.length - 1] ?? null;
  const closedRec = lastCounted ? [...recordsOf(input.timelines.get(lastCounted.id))].reverse().find((r) => r.kind === "closed") ?? null : null;
  const lead = lastCounted ?? runs[runs.length - 1] ?? null;
  const agent = lead?.agent ? (canonicalAgentId(lead.agent.toLowerCase()) as Agent) : undefined;
  // Age runs from the first run that counts: a launch that never happened doesn't make the job older.
  const firstRun = (counted[0] ?? runs[0])?.created ?? null;
  const opened = track && track.source !== "build" ? [new Date(track.created), ...(firstRun ? [firstRun] : [])].reduce((m, d) => (d < m ? d : m)) : firstRun ?? new Date(track?.created ?? input.now);
  const review = input.reviewItems
    .filter((i) => i.status === "waiting" && i.track && trackIds.includes(i.track))
    .sort((a, b) => (a.lane === "RED" ? 0 : 1) - (b.lane === "RED" ? 0 : 1))[0];
  // The ship lane: the newest run that was ever readied (or forwarded a manifest).
  let ship: ShipState | null = null;
  for (let i = runs.length - 1; i >= 0 && !ship; i--) ship = shipState(runs[i].id, input.timelines.get(runs[i].id) ?? []);

  return {
    id,
    title: newest((x) => titleOf(clean(x.rec, "title"))) ?? (track && track.source !== "build" ? track.title : humanize(runGroupKey(runs[0]?.name ?? track?.title ?? id.replace(/^bld-/, "")))),
    order: track?.order ?? null,
    kicker: "queued",
    from: agent && AGENTS.has(agent) ? agent : null,
    opened_at: opened.toISOString(),
    last_activity_at: maxIso(
      ...runs.map((r) => iso(r.lastEventAt ?? r.created)),
      records.length ? records[records.length - 1].rec.at : null,
      track && track.source !== "build" ? track.updated : null,
    ),
    ask,
    ask_build: askBuild,
    ask_record: askRecord,
    review_item: review ? { id: review.id, lane: review.lane, title: review.title ?? "" } : null,
    done: track?.source !== "build" ? track?.done ?? "" : "",
    left: track?.source !== "build" ? track?.left ?? "" : "",
    steps: track?.steps?.length ? track.steps.map((s) => ({ ...s })) : null,
    now: newest((x) => (x.rec.kind === "progress" && clean(x.rec, "now") ? { text: clean(x.rec, "now")!, at: x.rec.at } : null)),
    checks: closedRec?.checks ?? newest((x) => x.rec.checks),
    close_note: closedRec ? clean(closedRec, "finished") ?? FALLBACK.finished : null,
    runs: cardRuns,
    closed: track && !isOpen(track) && track.closed_at ? { at: track.closed_at, how: track.closed_how ?? track.state } : null,
    track_ids: [...new Set(trackIds)],
    ship,
  };
}

/** Ship is the owner's move: readied, and if it waits on a review card, that card approved. */
function shipPending(c: Card, input: BuildsInput): boolean {
  if (!c.ship?.pending) return false;
  if (!c.ship.review) return true;
  const item = input.reviewItems.find((i) => i.id === c.ship!.review);
  return !item || item.status === "approved" || item.status === "done";
}

/** BUILD-NOTES §2.4 rule 2 — first match wins. Sets the kicker as it goes. */
function sectionOf(d: Draft, input: BuildsInput): SectionKey | null {
  const c = d.card;
  if (!d.open) {
    if (!c.closed) return null;
    c.kicker = "closed";
    return input.now.getTime() - Date.parse(c.closed.at) <= WEEK ? "closed_week" : null;
  }
  if (c.ask) {
    c.kicker = "question";
    return "needs_you";
  }
  if (shipPending(c, input)) {
    c.kicker = "ship";
    return "needs_you";
  }
  if (c.ship?.phase === "rolled_back" || c.ship?.phase === "failed") {
    c.kicker = "rolled-back";
    return "needs_you";
  }
  if (c.ship?.active) {
    c.kicker = "shipping";
    return "moving";
  }
  if (d.track?.waiting_on === "owner") {
    c.kicker = "your-step";
    return "needs_you";
  }
  if (c.review_item) {
    c.kicker = "in-review";
    return "needs_you";
  }
  const counted = d.runs.filter((r) => c.runs.find((x) => x.build === r.id)?.counted);
  const running = counted.filter((r) => r.state === "running");
  if (running.length) {
    const quiet = input.now.getTime() - Date.parse(c.last_activity_at ?? c.opened_at);
    if (quiet >= QUIET_MS) {
      c.kicker = "stuck";
      return "stuck";
    }
    c.kicker = c.now ? "now" : "started";
    return "moving";
  }
  const last = counted[counted.length - 1];
  if (last && TROUBLE.has(last.state)) {
    c.kicker = "stuck";
    return "stuck";
  }
  if (counted.length && counted.every((r) => FINISHED.has(r.state))) {
    c.kicker = "built";
    return "ready";
  }
  if (!counted.length && d.track?.state === "running") {
    c.kicker = "started";
    return "moving";
  }
  c.kicker = "queued";
  return "queued";
}

// ── the daily line (B8) ────────────────────────────────────────────────

const NEEDS_PHRASE: Partial<Record<Kicker, (c: Card) => string>> = {
  "your-step": () => "your step",
  question: (c) => (c.from && c.from !== "foreman" ? `one question from ${c.from.charAt(0).toUpperCase()}${c.from.slice(1)}` : "one question for you"),
  "in-review": (c) => (c.review_item?.lane === "RED" ? "your fingerprint in Review" : "one tap in Review"),
  ship: () => "ready to ship — one tap",
  "rolled-back": () => "its ship rolled back",
};

/**
 * The day-close's Builds block, from the SAME view the panel renders — so
 * the number in chat is the number in the panel (DESIGN §6). Text form:
 * one line of figures with the link, then at most three needs-you names.
 */
export function buildsDigestLines(view: BuildsView, link: string): string[] {
  const { open, needs_you, oldest } = view.tally;
  if (!open) return ["**Builds** — nothing open."];
  const figs = [`${open} open`, `${needs_you} need${needs_you === 1 ? "s" : ""} you`];
  if (view.sections.ready.length) figs.push(`${view.sections.ready.length} to close`);
  if (oldest) figs.push(`oldest ${oldest.days ? `${oldest.days}d` : "today"}`);
  const out = [`**Builds** — ${figs.join(" · ")} → ${link}`];
  const names = view.sections.needs_you.slice(0, 3).map((c) => `- ${c.title} — ${NEEDS_PHRASE[c.kicker]?.(c) ?? "waiting on you"}`);
  out.push(...names);
  if (view.sections.needs_you.length > 3) out.push(`- +${view.sections.needs_you.length - 3} more`);
  return out;
}
