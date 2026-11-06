import { useEffect, useMemo, useRef, useState } from "react";
import { actions, useAppState } from "../store";
import { Age, EmptyState, SkeletonRows, StaleBanner, UndoToast } from "../components/panel";
import { AGENT_LABEL, clockLabel } from "../components/panel/format";
import { usePanelFeed } from "../lib/usePanelFeed";
import { askForBrief, closeRow, FEED_URL, fileRow, startWithFingerprint, type FeedRow, type FeedView } from "../lib/feed";

/**
 * Feed ("It can't depend on my memory") — one list, newest-
 * relevant first, three kinds of rows that read differently but sit together:
 *
 *   NEEDS YOU   a question · a review item · your own step        → Answer / Open in Review
 *   PARKED      a hold · built and not closed · queued · a brief   → Start / Close / Watch / Answer
 *   IDEA        an unticked vault card                             → Ask Michael for a brief
 *
 * Every row: what it is, where it stands, ONE action. Start is a fingerprint
 * (like a RED approve) and launches the brief with no question asked. The
 * slot strip on top is the ledger's count, not a guess: when all five are
 * busy every Start is shaded with the reason, and the first slot that frees
 * lights them again on the next read.
 */

const DESK_TZ = "America/New_York";
const ms = (iso: string | null | undefined, now: number) => (iso ? Math.max(0, now - Date.parse(iso)) : 0);

// ── pending close (6 s behind an Undo toast, like Builds) ─────────────

type Pending = { id: string; what: string; kind: "closed" | "cancelled" };

// ── words ─────────────────────────────────────────────────────────────

const KIND_LABEL: Record<FeedRow["kind"], string> = { needs_you: "Needs you", parked: "Started & parked", idea: "Ideas" };

function kickerWord(r: FeedRow): string {
  switch (r.status) {
    case "question":
      return "Question";
    case "review":
      return "In Review";
    case "your-step":
      return "Your step";
    case "hold":
      return "Parked";
    case "built":
      return "Built · not closed";
    case "stuck":
      return "Stuck";
    case "queued":
      return "Queued";
    case "brief":
      return "Brief ready";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "failed":
      return "Didn't start";
    case "idea":
      return r.note ? `Idea · ${r.note}` : "Idea";
    case "gone":
      return "Gone from its source";
    default:
      return r.status;
  }
}

function agoWord(iso: string, now: number): string {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 36 * 60) return `${Math.round(m / 60)} h ago`;
  return clockLabel(iso, DESK_TZ);
}

// ── slot strip ────────────────────────────────────────────────────────

function SlotStrip({ view, now }: { view: FeedView; now: number }) {
  const { running, cap, free, builds } = view.slots;
  return (
    <>
      <section className={`fd-strip${free === 0 ? " full" : ""}`} aria-label="Build slots">
        <div>
          <strong>
            {running}
            <span> / {cap}</span>
          </strong>
          <p>Build slots in use</p>
        </div>
        <div className="fd-slots" aria-hidden="true">
          {Array.from({ length: cap }, (_, i) => (
            <i key={i} className={i < running ? "on" : ""} />
          ))}
        </div>
        <span className="fd-grow" />
        <span className={`rd-tag ${free === 0 ? "gold" : "green"}`}>{free === 0 ? `All ${cap === 5 ? "five" : cap} busy` : `${free} available`}</span>
      </section>
      {free === 0 && <p className="fd-banner">All {cap} agents are busy. Start will be available when a slot opens.</p>}
      {view.restricted && <p className="fd-banner warn">{view.restricted} — new builds wait for nightfall.</p>}
      {builds.length > 0 && (
        <div className="fd-running">
          {builds.map((b) => (
            <button key={b.id} type="button" className="fd-run-chip" onClick={() => b.card && actions.openBuilds(b.card)} disabled={!b.card} title={`${AGENT_LABEL[b.agent] ?? b.agent} · since ${clockLabel(b.since, view.tz)}`}>
              <Layers />
              {b.name}
              <Age ms={ms(b.since, now)} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const Layers = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </svg>
);

const TAG_TONE = (r: FeedRow): string =>
  r.status === "running" ? "green" : r.status === "question" || r.status === "brief" || r.status === "your-step" ? "gold" : r.status === "review" ? "red" : "";

// ── one row ───────────────────────────────────────────────────────────

function RowAction({
  row,
  busy,
  onStart,
  onClose,
  onFile,
  onAsk,
}: {
  row: FeedRow;
  busy: boolean;
  onStart: () => void;
  onClose: () => void;
  onFile: (track: string) => void;
  onAsk: () => void;
}) {
  const a = row.action;
  switch (a.kind) {
    case "start": {
      const s = row.start!;
      return (
        <div className="fd-act">
          <button type="button" className={`fd-btn primary${s.ok ? "" : " shaded"}`} disabled={!s.ok || busy} onClick={onStart}>
            {busy ? "Starting…" : row.status === "failed" ? "Start again" : "Start"}
          </button>
          {s.why && !busy && <span className="fd-why">{s.why}</span>}
          {s.ok && !busy && s.brief && (
            <span className="fd-why faint">
              {AGENT_LABEL[s.brief.agent] ?? s.brief.agent} · {s.brief.runtime} · {s.brief.model}
            </span>
          )}
        </div>
      );
    }
    case "brief-needed":
      return (
        <div className="fd-act">
          <span className="fd-label">Brief needed</span>
          <span className="fd-why faint">Michael writes it; Start appears here</span>
        </div>
      );
    case "close":
      return (
        <div className="fd-act">
          <button type="button" className="fd-btn" disabled={busy} onClick={onClose}>
            Close
          </button>
          {a.file_under.length > 0 && (
            <select className="fd-file" value="" disabled={busy} onChange={(e) => e.target.value && onFile(e.target.value)} aria-label="File under a track">
              <option value="">File under…</option>
              {a.file_under.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          )}
        </div>
      );
    case "open-review":
      return (
        <div className="fd-act">
          <button type="button" className="fd-btn you" onClick={() => actions.openReview(a.item)}>
            Open in Review
          </button>
        </div>
      );
    case "answer":
      return (
        <div className="fd-act">
          <button type="button" className={`fd-btn${row.kind === "needs_you" ? " you" : ""}`} onClick={() => actions.answerInThread("michael", `${row.what}\n${row.where}`, { build: a.question_build, record: a.question_record })}>
            Answer
          </button>
        </div>
      );
    case "watch":
      return (
        <div className="fd-act">
          <button type="button" className="fd-btn" onClick={() => actions.openBuilds(`bld-${a.build}`)}>
            Watch
          </button>
          {row.pre_approved && <span className="fd-why faint">runs to a preview — you hear about it when one exists</span>}
        </div>
      );
    case "ask-brief":
      return (
        <div className="fd-act">
          <button type="button" className="fd-btn ghost" disabled={!!a.asked_at || busy} onClick={onAsk}>
            {a.asked_at ? `Asked Michael ${agoWord(a.asked_at, Date.now())}` : "Ask Michael for a brief"}
          </button>
        </div>
      );
    default:
      return null;
  }
}

function Row({ row, n, now, busy, error, onStart, onClose, onFile, onAsk }: { row: FeedRow; n: number; now: number; busy: boolean; error: string | null; onStart: () => void; onClose: () => void; onFile: (t: string) => void; onAsk: () => void }) {
  const needs = row.kind === "needs_you";
  return (
    <article className={`${needs ? "fd-decision" : "fd-frow"} ${row.kind} ${row.status}${row.pre_approved ? " pre" : ""}`}>
      {needs && <span className="fd-num">{String(n).padStart(2, "0")}</span>}
      <div className="fd-grow">
        <div className="fd-meta">
          <span className={`rd-tag ${TAG_TONE(row)}`}>{kickerWord(row)}</span>
          <span>
            {row.from ? `${AGENT_LABEL[row.from] ?? row.from} · ` : ""}
            {agoWord(row.at, now)}
          </span>
        </div>
        <h3>
          {row.what}
          {row.pre_approved && row.status !== "running" && <span className="fd-pre">→ preview</span>}
        </h3>
        <p>{row.where}</p>
        {row.note && row.kind !== "idea" && <small>{row.note}</small>}
        {error && (
          <p className="fd-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="fd-actions">
        <RowAction row={row} busy={busy} onStart={onStart} onClose={onClose} onFile={onFile} onAsk={onAsk} />
      </div>
    </article>
  );
}

// ── the list ──────────────────────────────────────────────────────────

export function FeedList() {
  const { buildsRev } = useAppState();
  const [rev, setRev] = useState(0);
  const feed = usePanelFeed<FeedView>(FEED_URL, buildsRev + rev);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  const now = Date.now();

  const mark = (id: string, on: boolean) =>
    setBusy((b) => {
      const n = new Set(b);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const fail = (id: string, msg: string | null) =>
    setErrors((e) => {
      const n = new Map(e);
      if (msg) n.set(id, msg);
      else n.delete(id);
      return n;
    });
  const refresh = () => setRev((r) => r + 1);

  const start = async (row: FeedRow) => {
    mark(row.id, true);
    fail(row.id, null);
    const r = await startWithFingerprint(row.id);
    mark(row.id, false);
    if (!r.ok) fail(row.id, r.code === "cancelled" ? r.error : `Didn't start — ${r.error}`);
    refresh();
  };
  const ask = async (row: FeedRow) => {
    mark(row.id, true);
    const r = await askForBrief(row.id);
    mark(row.id, false);
    if (!r.ok) fail(row.id, `Didn't reach Michael — ${r.error}`);
    refresh();
  };
  const file = async (row: FeedRow, track: string) => {
    mark(row.id, true);
    const r = await fileRow(row.id, track);
    mark(row.id, false);
    if (!r.ok) fail(row.id, `Didn't file — ${r.error}`);
    refresh();
  };
  const sendClose = async (p: Pending) => {
    const r = await closeRow(p.id, p.kind);
    if (!r.ok && r.error !== "already closed") fail(p.id, `Didn't close — ${r.error}`);
    refresh();
  };
  const requestClose = (row: FeedRow) => {
    if (pendingRef.current && pendingRef.current.id !== row.id) void sendClose(pendingRef.current);
    fail(row.id, null);
    setPending({ id: row.id, what: row.what, kind: "closed" });
  };
  const commitPending = () => {
    const p = pendingRef.current;
    setPending(null);
    if (p) void sendClose(p);
  };
  // Navigating away with a close still in its toast: the toast leaves, so it commits.
  useEffect(() => () => commitPending(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => (feed.data && pending ? { ...feed.data, rows: feed.data.rows.filter((r) => r.id !== pending.id) } : feed.data), [feed.data, pending]);

  if (!view) {
    return (
      <div className="tool-page rv-page pf-page fd-page rd-feed">
        <div className="rv-col">
          <FeedHead />
          {feed.error ? <StaleBanner lastGoodAt="nothing yet" what="Can't reach the gateway." onRetry={feed.reload} /> : <SkeletonRows n={4} />}
        </div>
      </div>
    );
  }

  const stale = !!feed.error && feed.lastGoodAt !== null;
  const asOf = feed.lastGoodAt ? clockLabel(new Date(feed.lastGoodAt).toISOString(), view.tz) : "";
  const kinds: FeedRow["kind"][] = ["needs_you", "parked", "idea"];
  const rowEl = (r: FeedRow, i: number) => (
    <Row key={r.id} row={r} n={i + 1} now={now} busy={busy.has(r.id)} error={errors.get(r.id) ?? null} onStart={() => void start(r)} onClose={() => requestClose(r)} onFile={(t) => void file(r, t)} onAsk={() => void ask(r)} />
  );
  const list = (
    <>
      <SlotStrip view={view} now={now} />
      {view.rows.length === 0 && <EmptyState title="Nothing needs" em="you." body={<>New work will find its place here.</>} />}
      {kinds.map((k) => {
        const rows = view.rows.filter((r) => r.kind === k);
        if (rows.length === 0) return null;
        const count = view.counts[k === "needs_you" ? "needs_you" : k === "parked" ? "parked" : "ideas"];
        return (
          <section key={k} className={`fd-section ${k}`}>
            <div className="fd-section-head">
              <h2>{KIND_LABEL[k]}</h2>
              {k !== "needs_you" && <span className="rd-tag">{count} {k === "idea" ? (count === 1 ? "idea" : "ideas") : count === 1 ? "track" : "tracks"}</span>}
            </div>
            <div className={k === "needs_you" ? "fd-decisions" : "fd-list"}>{rows.map(rowEl)}</div>
          </section>
        );
      })}
      {view.briefs_invalid.length > 0 && (
        <p className="pf-quiet pf-quiet-end">
          {view.briefs_invalid.length} brief{view.briefs_invalid.length === 1 ? "" : "s"} in the folder without a machine header — no Start until Michael adds one.
        </p>
      )}
    </>
  );

  return (
    <div className="tool-page rv-page pf-page fd-page rd-feed">
      <div className="rv-col">
        <FeedHead />
        {stale && <StaleBanner lastGoodAt={asOf} onRetry={feed.reload} />}
        {!stale && view.partial.length > 0 && <StaleBanner what="Part of the feed couldn't be read." lastGoodAt={`${asOf}, without the ${view.partial.map(sourceWord).join(" and the ")}`} onRetry={feed.reload} />}
        {stale ? <div className="stale-feed">{list}</div> : list}
      </div>
      {pending && <UndoToast id={pending.id} text={`Closed ${pending.what}`} onUndo={() => setPending(null)} onExpire={commitPending} />}
    </div>
  );
}

function FeedHead() {
  return (
    <div className="rd-builds-head">
      <div className="rd-eyebrow">MAKE ROOM FOR WHAT’S NEXT</div>
      <h2>
        The feed<span className="rd-title-dot">.</span>
      </h2>
      <p>Good ideas, moving forward.</p>
    </div>
  );
}

const sourceWord = (s: string) => ({ ledger: "build ledger", timeline: "status records", tracks: "track registry", ideas: "idea vault", briefs: "briefs folder" })[s] ?? s;

export default function Feed() {
  return <FeedList />;
}
