/**
 * feed.ts — the Feed ("It can't depend on my memory … a feed:
 * what needs me, what got started and parked, and the ideas, each with a
 * Start button").
 *
 * PURE. It takes what the desk already holds — the Builds board, the open
 * tracks, the review items, the foreman ledger, the HOLD files, the briefs
 * folder, the idea vault, the launch ledger — and derives ONE list of three
 * kinds of rows:
 *
 *   needs you   an open needs_operator · a review item waiting · a question in a HOLD · his own step
 *   parked      a HOLD build · an open track with no running build · a finished-but-unfiled
 *               build · a brief ready to start · a build started from here (with its link)
 *   idea        an unticked card in the vault — no Start until Michael writes a brief
 *
 * Each row: one line of what it is, one line of where it stands, exactly ONE
 * action. A row with a valid brief behind it (brief-header.ts) carries Start;
 * Start is shaded when the five slots are full, during Shabbat, while a launch
 * is in flight, or while the brief's build is still running. The slot count is
 * the ledger's (every build with no closing status — what build_start counts),
 * never a guess.
 *
 * Nothing leaves because a source stopped mentioning it: track and build rows
 * inherit tracks.ts's rule; idea and brief rows are held in the feed registry
 * (FeedRegistry) and a row that vanished without a recorded reason shows as
 * "gone" with Close as its one action — the reason then lands in the ledger.
 */
import type { BuildSummary } from "./ledger.js";
import type { BuildsView, Card, SectionKey } from "./builds.js";
import { humanize } from "./builds.js";
import { canonicalAgentId } from "../agent-rename.js";
import type { Track } from "./tracks.js";
import { isOpen } from "./tracks.js";
import type { ReviewItem } from "./types.js";
import type { BriefFile, BriefHeader } from "./brief-header.js";
import type { IdeasRead } from "./ideas.js";
import type { LaunchEntry } from "./launches.js";

export type FeedKind = "needs_you" | "parked" | "idea";
export type FeedStatus =
  | "question"
  | "review"
  | "your-step"
  | "hold"
  | "built"
  | "stuck"
  | "queued"
  | "brief"
  | "starting"
  | "running"
  | "failed"
  | "idea"
  | "gone";

export interface StartBrief {
  path: string;
  sha256: string;
  name: string;
  summary: string;
  agent: string;
  runtime: string;
  model: string;
  effort: string;
  pre_approved: boolean;
}

export interface StartInfo {
  /** Start may be tapped now. */
  ok: boolean;
  /** Why not (shown under the shaded button), or null. */
  why: string | null;
  brief: StartBrief | null;
  launch: { id: string; state: LaunchEntry["state"]; build_id: string | null; error: string | null; requested_at: string } | null;
}

export type FeedAction =
  | { kind: "start" }
  | { kind: "brief-needed" }
  | { kind: "close"; file_under: Array<{ id: string; title: string }> }
  | { kind: "open-review"; item: string }
  /** question_build / question_record: the run and needs_operator record this row shows — a sent answer clears it. Null for hold notes. */
  | { kind: "answer"; build: string | null; question_build?: string | null; question_record?: string | null }
  | { kind: "watch"; build: string }
  | { kind: "ask-brief"; asked_at: string | null };

export interface FeedRow {
  id: string;
  kind: FeedKind;
  status: FeedStatus;
  /** One line: what it is. */
  what: string;
  /** One line: where it stands. */
  where: string;
  from: string | null;
  /** Relevance instant (sort key within a kind). */
  at: string;
  action: FeedAction;
  start: StartInfo | null;
  /** The Builds card this row stands for (timeline link), when there is one. */
  card: string | null;
  /** The tracks (trk-…/bld-…) a Close would close. */
  track_ids: string[];
  pre_approved: boolean;
  note: string | null;
}

export interface FeedView {
  now: string;
  tz: string;
  slots: { running: number; cap: number; free: number; builds: Array<{ id: string; name: string; agent: string; since: string; card: string | null }> };
  rows: FeedRow[];
  counts: { needs_you: number; parked: number; ideas: number };
  /** Briefs in the folder that carry no valid header — for Michael, never a Start. */
  briefs_invalid: Array<{ path: string; errors: string[] }>;
  /** Shabbat / Yom Tov: Start waits (the reason). */
  restricted: string | null;
  partial: string[];
}

export interface HoldFile {
  build: string;
  text: string;
  mtime: string;
}

export interface FeedRegistryRow {
  id: string;
  kind: FeedKind;
  what: string;
  first_seen: string;
  last_seen: string;
  /** Recorded departure — once set the row is history. */
  left: { at: string; how: string } | null;
  /** Idea rows: "ask Michael for a brief" was sent at… (one ask per idea until a brief appears). */
  asked_at?: string | null;
}

export interface FeedInput {
  now: Date;
  tz: string;
  builds: BuildsView;
  tracks: Track[];
  runs: BuildSummary[];
  reviewItems: ReviewItem[];
  holds: HoldFile[];
  briefs: BriefFile[];
  ideas: IdeasRead;
  launches: LaunchEntry[];
  /** Registry rows for idea-/brief- ids (what the feed showed before). */
  registry: FeedRegistryRow[];
  cap: number;
  restricted: string | null;
  partial?: string[];
}

const SECTIONS: SectionKey[] = ["needs_you", "ready", "moving", "stuck", "queued"];
const QUESTION_RE = /[^.!?\n]*\?(?=\s|$)/;
const GONE_KEEP_MS = 14 * 86_400_000;

/** The sentence in a HOLD that asks the owner something, if any. */
export function holdQuestion(text: string): string | null {
  const m = QUESTION_RE.exec(text.replace(/\s+/g, " "));
  return m ? m[0].trim().slice(0, 200) : null;
}

function briefOf(b: BriefFile): StartBrief {
  const h = b.result.header as BriefHeader;
  return { path: b.path, sha256: b.sha256, name: h.name, summary: h.summary, agent: h.agent, runtime: h.runtime, model: h.model, effort: h.effort, pre_approved: h.pre_approved };
}

export function deriveFeed(input: FeedInput): FeedView {
  const now = input.now.getTime();
  const nowIso = input.now.toISOString();
  const partial = [...(input.partial ?? [])];

  // ── slots: the ledger's own count ─────────────────────────────────────
  const cardOfBuild = new Map<string, Card>();
  for (const s of SECTIONS) for (const c of input.builds.sections[s]) for (const r of c.runs) cardOfBuild.set(r.build, c);
  const running = input.runs.filter((r) => r.state === "running").sort((a, b) => a.created.getTime() - b.created.getTime());
  const slots: FeedView["slots"] = {
    running: running.length,
    cap: input.cap,
    free: Math.max(0, input.cap - running.length),
    builds: running.map((r) => ({ id: r.id, name: humanize(r.name), agent: r.agent, since: (r.startedAt ?? r.created).toISOString(), card: cardOfBuild.get(r.id)?.id ?? null })),
  };
  const runningIds = new Set(running.map((r) => r.id));
  const runningNames = new Map(running.map((r) => [r.name.toLowerCase(), r.id]));

  // ── briefs: valid ones by the row they back ───────────────────────────
  const briefsByRow = new Map<string, BriefFile>();
  const standalone: BriefFile[] = [];
  const invalid: FeedView["briefs_invalid"] = [];
  for (const b of input.briefs) {
    if (!b.result.valid) {
      invalid.push({ path: b.path, errors: b.result.errors });
      continue;
    }
    const t = b.result.header.track;
    if (t && !briefsByRow.has(t)) briefsByRow.set(t, b);
    else standalone.push(b);
  }
  const launchByRow = new Map<string, LaunchEntry>();
  const launchBySha = new Map<string, LaunchEntry>();
  for (const l of input.launches) {
    launchByRow.set(l.row, l);
    if (l.state !== "failed") launchBySha.set(l.brief_sha256, l);
  }

  const startInfo = (rowId: string, brief: BriefFile | null, rowRunning: boolean): { start: StartInfo; status: FeedStatus | null } => {
    if (!brief) return { start: { ok: false, why: "brief needed", brief: null, launch: null }, status: null };
    const sb = briefOf(brief);
    const launch = launchBySha.get(brief.sha256) ?? launchByRow.get(rowId) ?? null;
    const lp = launch ? { id: launch.id, state: launch.state, build_id: launch.build_id, error: launch.error, requested_at: launch.requested_at } : null;
    if (launch?.state === "pending") return { start: { ok: false, why: "starting…", brief: sb, launch: lp }, status: "starting" };
    if (launch?.state === "started" && launch.build_id && runningIds.has(launch.build_id)) {
      return { start: { ok: false, why: `running as ${humanize(launch.build_id)}`, brief: sb, launch: lp }, status: "running" };
    }
    const byName = runningNames.get(sb.name.toLowerCase());
    if (byName) return { start: { ok: false, why: `already running (started by hand) — ${humanize(byName)}`, brief: sb, launch: lp }, status: null };
    if (rowRunning) return { start: { ok: false, why: "a build on this row is still active — close it first", brief: sb, launch: lp }, status: null };
    if (input.restricted) return { start: { ok: false, why: `${input.restricted} — Start waits for nightfall`, brief: sb, launch: lp }, status: launch?.state === "failed" ? "failed" : null };
    if (slots.free === 0) return { start: { ok: false, why: "wait for one to finish", brief: sb, launch: lp }, status: launch?.state === "failed" ? "failed" : null };
    return { start: { ok: true, why: null, brief: sb, launch: lp }, status: launch?.state === "failed" ? "failed" : null };
  };

  const rows: FeedRow[] = [];
  const seen = new Set<string>();
  const openTracks = input.tracks.filter((t) => t.source !== "build" && isOpen(t)).map((t) => ({ id: t.id, title: t.title }));
  const holdsByBuild = new Map(input.holds.map((h) => [h.build, h]));
  const claimedBriefs = new Set<string>();

  const parkedRow = (c: Card, status: FeedStatus, where: string, brief: BriefFile | null, rowRunning: boolean, note: string | null = null): FeedRow => {
    const { start, status: st } = startInfo(c.id, brief, rowRunning);
    if (brief) claimedBriefs.add(brief.path);
    const launched = start.launch?.state === "failed";
    const s = st ?? status;
    return {
      id: c.id,
      kind: "parked",
      status: s,
      what: c.title,
      where: s === "starting" ? "Starting — the build id lands here in a minute" : s === "running" ? "Running — started from here" : launched && start.launch?.error ? `Didn't start — ${start.launch.error.slice(0, 160)}` : where,
      from: c.from,
      at: c.last_activity_at ?? c.opened_at,
      action: s === "running" && start.launch?.build_id ? { kind: "watch", build: start.launch.build_id } : brief ? { kind: "start" } : { kind: "brief-needed" },
      start,
      card: c.id,
      track_ids: c.track_ids,
      pre_approved: start.brief?.pre_approved ?? false,
      note,
    };
  };

  // ── 1. the Builds board ───────────────────────────────────────────────
  for (const s of SECTIONS) {
    for (const c of input.builds.sections[s]) {
      if (seen.has(c.id)) continue;
      const brief = c.track_ids.map((t) => briefsByRow.get(t)).find((b): b is BriefFile => !!b) ?? null;
      const runningRun = c.runs.find((r) => r.counted && runningIds.has(r.build)) ?? null;
      const hold = c.runs.map((r) => holdsByBuild.get(r.build)).find((h): h is HoldFile => !!h) ?? null;
      if (s === "needs_you") {
        seen.add(c.id);
        const review = c.review_item;
        const step = c.steps?.find((x) => x.state === "you");
        rows.push({
          id: c.id,
          kind: "needs_you",
          status: c.kicker === "question" ? "question" : c.kicker === "in-review" ? "review" : "your-step",
          what: c.title,
          where: c.kicker === "question" ? c.ask ?? "A question is waiting" : c.kicker === "in-review" ? `In Review${review?.lane === "RED" ? " · fingerprint" : " · one tap"}: ${review?.title ?? ""}`.trim() : step ? `Your step: ${step.label}` : "Your step",
          from: c.from,
          at: c.last_activity_at ?? c.opened_at,
          action: c.kicker === "in-review" && review ? { kind: "open-review", item: review.id } : { kind: "answer", build: runningRun?.build ?? c.runs.at(-1)?.build ?? null, question_build: c.kicker === "question" ? c.ask_build ?? null : null, question_record: c.kicker === "question" ? c.ask_record ?? null : null },
          start: null,
          card: c.id,
          track_ids: c.track_ids,
          pre_approved: false,
          note: null,
        });
        continue;
      }
      if (hold) {
        seen.add(c.id);
        const q = holdQuestion(hold.text);
        if (q) {
          rows.push({
            id: c.id,
            kind: "needs_you",
            status: "question",
            what: c.title,
            where: q,
            from: c.from ?? "michael",
            at: hold.mtime,
            action: { kind: "answer", build: hold.build },
            start: null,
            card: c.id,
            track_ids: c.track_ids,
            pre_approved: false,
            note: "parked by Michael — his question is in the hold note",
          });
        } else {
          rows.push({ ...parkedRow(c, "hold", `Parked: ${hold.text.replace(/\s+/g, " ").trim().slice(0, 200)}`, null, true), action: { kind: "answer", build: hold.build }, start: null, at: hold.mtime });
        }
        continue;
      }
      if (s === "ready") {
        seen.add(c.id);
        const checks = c.checks ? ` · ${c.checks.passed}/${c.checks.total}` : "";
        const row = parkedRow(c, "built", `Built, not closed — ${c.close_note ?? "no close-out note"}${checks}`, null, false);
        row.action = { kind: "close", file_under: c.id.startsWith("bld-") ? openTracks : [] };
        row.start = null;
        rows.push(row);
        continue;
      }
      if (s === "stuck") {
        seen.add(c.id);
        const last = c.runs.filter((r) => r.counted).at(-1);
        const where = last && last.state !== "running" ? `Stopped (${last.cause ?? last.state}), never redone` : `Quiet since ${c.last_activity_at ?? c.opened_at}`;
        rows.push(parkedRow(c, "stuck", where, brief, !!runningRun));
        continue;
      }
      if (s === "queued") {
        seen.add(c.id);
        const where = c.left ? `Left: ${c.left}` : c.done ? `Done: ${c.done}` : c.order !== null ? `Build order #${c.order}, not started` : "Not started";
        rows.push(parkedRow(c, "queued", where, brief, false));
        continue;
      }
      // moving: only a build started from here keeps a row (its timeline link); the rest fill the slot strip.
      // A launch whose row is a track / idea / brief row is shown THERE (that row turns into the running
      // build's row) — the loose build card must not become a second row for the same build.
      const launched = c.runs.find((r) => [...launchBySha.values()].some((l) => l.state === "started" && l.build_id === r.build));
      if (launched) {
        const l = [...launchBySha.values()].find((x) => x.build_id === launched.build);
        if (l && l.row !== c.id && !c.track_ids.includes(l.row)) continue;
        seen.add(c.id);
        rows.push({
          id: c.id,
          kind: "parked",
          status: "running",
          what: c.title,
          where: c.now ? `Doing: ${c.now.text}` : "Running — no report yet",
          from: c.from,
          at: c.last_activity_at ?? c.opened_at,
          action: { kind: "watch", build: launched.build },
          start: null,
          card: c.id,
          track_ids: c.track_ids,
          pre_approved: l?.pre_approved ?? false,
          note: null,
        });
        if (l) claimedBriefs.add(l.brief_path);
      }
    }
  }

  // ── 2. review items waiting with no track of their own ───────────────
  const inRows = new Set(rows.flatMap((r) => (r.action.kind === "open-review" ? [r.action.item] : [])));
  for (const i of input.reviewItems) {
    if (i.status !== "waiting" || inRows.has(i.id)) continue;
    rows.push({
      id: i.id,
      kind: "needs_you",
      status: "review",
      what: i.title,
      where: `In Review${i.lane === "RED" ? " · fingerprint" : " · one tap"} · ${i.desk}`,
      from: i.created_by && /^(michael|zali|avi|foreman)$/.test(canonicalAgentId(i.created_by)) ? canonicalAgentId(i.created_by) : null,
      at: i.created,
      action: { kind: "open-review", item: i.id },
      start: null,
      card: null,
      track_ids: [],
      pre_approved: false,
      note: null,
    });
  }

  // ── 3. ideas (and briefs that graduate an idea) ──────────────────────
  if (input.ideas.error) partial.push("ideas");
  const ideaIds = new Set<string>();
  for (const card of input.ideas.cards) {
    ideaIds.add(card.id);
    if (card.closed) continue;
    const brief = briefsByRow.get(card.id) ?? null;
    if (brief) {
      claimedBriefs.add(brief.path);
      const { start, status } = startInfo(card.id, brief, false);
      rows.push({
        id: card.id,
        kind: "parked",
        status: status ?? "brief",
        what: card.title,
        where: status === "starting" ? "Starting — the build id lands here in a minute" : status === "failed" && start.launch?.error ? `Didn't start — ${start.launch.error.slice(0, 160)}` : `Brief ready: ${brief.result.valid ? brief.result.header.summary : ""}`,
        from: "michael",
        at: brief.mtime,
        action: status === "running" && start.launch?.build_id ? { kind: "watch", build: start.launch.build_id } : { kind: "start" },
        start,
        card: null,
        track_ids: [],
        pre_approved: start.brief?.pre_approved ?? false,
        note: null,
      });
      continue;
    }
    const asked = input.registry.find((r) => r.id === card.id)?.asked_at ?? null;
    rows.push({
      id: card.id,
      kind: "idea",
      status: "idea",
      what: card.title,
      where: card.next ? `Next: ${card.next}` : card.status ? `Status: ${card.status}` : "No steps yet",
      from: null,
      at: `${card.date}T00:00:00.000Z`,
      action: { kind: "ask-brief", asked_at: asked },
      start: null,
      card: null,
      track_ids: [],
      pre_approved: false,
      note: card.tag,
    });
  }

  // ── 4. briefs that back no row on the board: their own parked row ────
  for (const b of [...briefsByRow.values(), ...standalone]) {
    if (claimedBriefs.has(b.path) || !b.result.valid) continue;
    const h = b.result.header;
    const id = `brief-${b.stem}`;
    const { start, status } = startInfo(id, b, false);
    claimedBriefs.add(b.path);
    rows.push({
      id,
      kind: "parked",
      status: status ?? "brief",
      what: b.title,
      where: status === "starting" ? "Starting — the build id lands here in a minute" : status === "failed" && start.launch?.error ? `Didn't start — ${start.launch.error.slice(0, 160)}` : `Brief ready: ${h.summary}`,
      from: "michael",
      at: b.mtime,
      action: status === "running" && start.launch?.build_id ? { kind: "watch", build: start.launch.build_id } : { kind: "start" },
      start,
      card: null,
      track_ids: [],
      pre_approved: h.pre_approved,
      note: h.track && !seen.has(h.track) && !ideaIds.has(h.track) ? `for ${h.track}, which is not on the board` : null,
    });
  }

  // ── 5. the registry: idea/brief rows that vanished without a reason ──
  const present = new Set(rows.map((r) => r.id));
  for (const r of input.registry) {
    if (r.left || present.has(r.id)) continue;
    if (now - Date.parse(r.last_seen) > GONE_KEEP_MS) continue;
    // Explained departures (foldRegistry records them this same pass) are not "gone".
    if (input.ideas.cards.find((c) => c.id === r.id)?.closed) continue;
    if (input.launches.some((l) => l.row === r.id && l.state === "started")) continue;
    rows.push({
      id: r.id,
      kind: r.kind,
      status: "gone",
      what: r.what,
      where: r.kind === "idea" ? "No longer in the idea vault — close it or ask Michael" : "The brief file is gone — close it or ask Michael",
      from: null,
      at: r.last_seen,
      action: { kind: "close", file_under: [] },
      start: null,
      card: null,
      track_ids: [],
      pre_approved: false,
      note: "not in its source any more; it stays until you close it",
    });
  }

  // ── order: needs you, then parked (starting / failed / built first), then ideas; newest first within ──
  const KIND_RANK: Record<FeedKind, number> = { needs_you: 0, parked: 1, idea: 2 };
  const STATUS_RANK: Partial<Record<FeedStatus, number>> = { starting: 0, failed: 0, built: 1, gone: 1, hold: 2, running: 3, brief: 4, stuck: 5, queued: 6 };
  rows.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || Date.parse(b.at) - Date.parse(a.at) || a.what.localeCompare(b.what));

  return {
    now: nowIso,
    tz: input.tz,
    slots,
    rows,
    counts: { needs_you: rows.filter((r) => r.kind === "needs_you").length, parked: rows.filter((r) => r.kind === "parked").length, ideas: rows.filter((r) => r.kind === "idea").length },
    briefs_invalid: invalid,
    restricted: input.restricted,
    partial,
  };
}

/**
 * The registry fold: what the feed shows now vs. what it showed before, for
 * the row kinds no other registry holds (ideas, briefs). Returns the updated
 * rows and the departures recorded this pass (the desk logs them).
 */
export function foldRegistry(
  previous: FeedRegistryRow[],
  view: FeedView,
  ideas: IdeasRead,
  launches: LaunchEntry[],
  now: Date,
): { rows: FeedRegistryRow[]; left: Array<{ id: string; how: string }> } {
  const nowIso = now.toISOString();
  const byId = new Map(previous.map((r) => [r.id, { ...r }]));
  const left: Array<{ id: string; how: string }> = [];
  for (const r of view.rows) {
    if (r.status === "gone") continue;
    if (!(r.id.startsWith("idea-") || r.id.startsWith("brief-"))) continue;
    const prev = byId.get(r.id);
    if (prev) {
      prev.last_seen = nowIso;
      prev.what = r.what;
      prev.kind = r.kind;
      prev.left = null;
    } else byId.set(r.id, { id: r.id, kind: r.kind, what: r.what, first_seen: nowIso, last_seen: nowIso, left: null });
  }
  const present = new Set(view.rows.filter((r) => r.status !== "gone").map((r) => r.id));
  for (const r of byId.values()) {
    if (r.left || present.has(r.id)) continue;
    // Explained departures are recorded as such; anything else stays "gone" on the feed.
    const idea = ideas.cards.find((c) => c.id === r.id);
    if (idea?.closed) {
      r.left = { at: nowIso, how: `ticked in the idea vault (${idea.status ?? "all steps done"}; file changed ${ideas.mtime ?? "?"})` };
      left.push({ id: r.id, how: r.left.how });
      continue;
    }
    const launch = launches.find((l) => l.row === r.id && l.state === "started");
    if (launch) {
      r.left = { at: launch.resolved_at ?? nowIso, how: `launched by ${launch.actor} as ${launch.build_id}` };
      left.push({ id: r.id, how: r.left.how });
    }
  }
  return { rows: [...byId.values()], left };
}
