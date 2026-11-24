import { useEffect, useMemo, useRef, useState } from "react";
import { actions, useAppState } from "../store";
import { Age, EmptyState, SkeletonRows, StaleBanner, UndoToast } from "../components/panel";
import { AGENT_LABEL, clockLabel } from "../components/panel/format";
import { usePanelFeed } from "../lib/usePanelFeed";
import { t, tn, useT, type Key } from "../i18n";
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

const KIND_LABEL: Record<FeedRow["kind"], Key> = { needs_you: "builds.section.needsYou", parked: "builds.feed.kind.parked", idea: "builds.feed.kind.ideas" };

function kickerWord(r: FeedRow): string {
  switch (r.status) {
    case "question":
      return t("builds.kicker.question");
    case "review":
      return t("builds.feed.inReview");
    case "your-step":
      return t("builds.kicker.yourStep");
    case "hold":
      return t("builds.feed.parked");
    case "built":
      return t("builds.feed.builtNotClosed");
    case "stuck":
      return t("builds.section.stuck");
    case "queued":
      return t("builds.section.queued");
    case "brief":
      return t("builds.feed.briefReady");
    case "starting":
      return t("builds.feed.starting");
    case "running":
      return t("builds.feed.running");
    case "failed":
      return t("builds.feed.didntStart");
    case "idea":
      return r.note ? t("builds.feed.ideaNote", { note: r.note }) : t("builds.feed.idea");
    case "gone":
      return t("builds.feed.gone");
    default:
      return r.status;
  }
}

function agoWord(iso: string, now: number): string {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (m < 2) return t("common.justNow");
  if (m < 60) return t("builds.feed.minAgo", { n: m });
  if (m < 36 * 60) return t("builds.feed.hAgo", { n: Math.round(m / 60) });
  return clockLabel(iso, DESK_TZ);
}

// ── slot strip ────────────────────────────────────────────────────────

function SlotStrip({ view, now }: { view: FeedView; now: number }) {
  const t = useT();
  const { running, cap, free, builds } = view.slots;
  return (
    <>
      <section className={`fd-strip${free === 0 ? " full" : ""}`} aria-label={t("builds.feed.slots")}>
        <div>
          <strong>
            {running}
            <span> / {cap}</span>
          </strong>
          <p>{t("builds.feed.slotsInUse")}</p>
        </div>
        <div className="fd-slots" aria-hidden="true">
          {Array.from({ length: cap }, (_, i) => (
            <i key={i} className={i < running ? "on" : ""} />
          ))}
        </div>
        <span className="fd-grow" />
        <span className={`rd-tag ${free === 0 ? "gold" : "green"}`}>{free === 0 ? (cap === 5 ? t("builds.feed.allFiveBusy") : t("builds.feed.allBusy", { n: cap })) : t("builds.feed.available", { n: free })}</span>
      </section>
      {free === 0 && <p className="fd-banner">{t("builds.feed.agentsBusy", { n: cap })}</p>}
      {view.restricted && <p className="fd-banner warn">{t("builds.feed.restricted", { reason: view.restricted })}</p>}
      {builds.length > 0 && (
        <div className="fd-running">
          {builds.map((b) => (
            <button key={b.id} type="button" className="fd-run-chip" onClick={() => b.card && actions.openBuilds(b.card)} disabled={!b.card} title={t("builds.feed.since", { agent: AGENT_LABEL[b.agent] ?? b.agent, time: clockLabel(b.since, view.tz) })}>
              <Layers />
              <bdi>{b.name}</bdi>
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
  const t = useT();
  const a = row.action;
  switch (a.kind) {
    case "start": {
      const s = row.start!;
      return (
        <div className="fd-act">
          <button type="button" className={`fd-btn primary${s.ok ? "" : " shaded"}`} disabled={!s.ok || busy} onClick={onStart}>
            {busy ? t("builds.feed.startingEllipsis") : row.status === "failed" ? t("builds.feed.startAgain") : t("builds.feed.start")}
          </button>
          {s.why && !busy && <span className="fd-why" dir="auto">{s.why}</span>}
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
          <span className="fd-label">{t("builds.feed.briefNeeded")}</span>
          <span className="fd-why faint">{t("builds.feed.michaelWrites")}</span>
        </div>
      );
    case "close":
      return (
        <div className="fd-act">
          <button type="button" className="fd-btn" disabled={busy} onClick={onClose}>
            {t("common.close")}
          </button>
          {a.file_under.length > 0 && (
            <select className="fd-file" value="" disabled={busy} onChange={(e) => e.target.value && onFile(e.target.value)} aria-label={t("builds.feed.fileUnderTrack")}>
              <option value="">{t("builds.fileUnderEllipsis")}</option>
              {a.file_under.map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {tr.title}
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
            {t("builds.openInReview")}
          </button>
        </div>
      );
    case "answer":
      return (
        <div className="fd-act">
          <button type="button" className={`fd-btn${row.kind === "needs_you" ? " you" : ""}`} onClick={() => actions.answerInThread("michael", `${row.what}\n${row.where}`, { build: a.question_build, record: a.question_record })}>
            {t("builds.attn.answer")}
          </button>
        </div>
      );
    case "watch":
      return (
        <div className="fd-act">
          <button type="button" className="fd-btn" onClick={() => actions.openBuilds(`bld-${a.build}`)}>
            {t("builds.feed.watch")}
          </button>
          {row.pre_approved && <span className="fd-why faint">{t("builds.feed.runsToPreview")}</span>}
        </div>
      );
    case "ask-brief":
      return (
        <div className="fd-act">
          <button type="button" className="fd-btn ghost" disabled={!!a.asked_at || busy} onClick={onAsk}>
            {a.asked_at ? t("builds.feed.askedMichael", { ago: agoWord(a.asked_at, Date.now()) }) : t("builds.feed.askBrief")}
          </button>
        </div>
      );
    default:
      return null;
  }
}

function Row({ row, n, now, busy, error, onStart, onClose, onFile, onAsk }: { row: FeedRow; n: number; now: number; busy: boolean; error: string | null; onStart: () => void; onClose: () => void; onFile: (t: string) => void; onAsk: () => void }) {
  const t = useT();
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
          <span dir="auto">{row.what}</span>
          {row.pre_approved && row.status !== "running" && <span className="fd-pre">{t("builds.feed.preview")}</span>}
        </h3>
        <p dir="auto">{row.where}</p>
        {row.note && row.kind !== "idea" && <small dir="auto">{row.note}</small>}
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
  const t = useT();
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
    if (!r.ok) fail(row.id, r.code === "cancelled" ? r.error : t("builds.feed.didntStartErr", { error: r.error }));
    refresh();
  };
  const ask = async (row: FeedRow) => {
    mark(row.id, true);
    const r = await askForBrief(row.id);
    mark(row.id, false);
    if (!r.ok) fail(row.id, t("builds.feed.didntReach", { error: r.error }));
    refresh();
  };
  const file = async (row: FeedRow, track: string) => {
    mark(row.id, true);
    const r = await fileRow(row.id, track);
    mark(row.id, false);
    if (!r.ok) fail(row.id, t("builds.feed.didntFile", { error: r.error }));
    refresh();
  };
  const sendClose = async (p: Pending) => {
    const r = await closeRow(p.id, p.kind);
    if (!r.ok && r.error !== "already closed") fail(p.id, t("builds.didntClose", { error: r.error }));
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
          {feed.error ? <StaleBanner lastGoodAt={t("builds.nothingYet")} what={t("ops.cantReachGateway")} onRetry={feed.reload} /> : <SkeletonRows n={4} />}
        </div>
      </div>
    );
  }

  const stale = !!feed.error && feed.lastGoodAt !== null;
  const asOf = feed.lastGoodAt ? clockLabel(new Date(feed.lastGoodAt).toISOString(), view.tz) : "";
  const kinds: FeedRow["kind"][] = ["needs_you", "parked", "idea"];
  const rowEl = (r: FeedRow, i: number) => (
    <Row key={r.id} row={r} n={i + 1} now={now} busy={busy.has(r.id)} error={errors.get(r.id) ?? null} onStart={() => void start(r)} onClose={() => requestClose(r)} onFile={(tr) => void file(r, tr)} onAsk={() => void ask(r)} />
  );
  const list = (
    <>
      <SlotStrip view={view} now={now} />
      {view.rows.length === 0 && <EmptyState title={t("builds.feed.empty.title")} em={t("builds.feed.empty.em")} body={<>{t("builds.feed.empty.body")}</>} />}
      {kinds.map((k) => {
        const rows = view.rows.filter((r) => r.kind === k);
        if (rows.length === 0) return null;
        const count = view.counts[k === "needs_you" ? "needs_you" : k === "parked" ? "parked" : "ideas"];
        return (
          <section key={k} className={`fd-section ${k}`}>
            <div className="fd-section-head">
              <h2>{t(KIND_LABEL[k])}</h2>
              {k !== "needs_you" && <span className="rd-tag">{k === "idea" ? tn("builds.feed.ideas", count) : tn("builds.feed.tracks", count)}</span>}
            </div>
            <div className={k === "needs_you" ? "fd-decisions" : "fd-list"}>{rows.map(rowEl)}</div>
          </section>
        );
      })}
      {view.briefs_invalid.length > 0 && (
        <p className="pf-quiet pf-quiet-end">
          {tn("builds.feed.briefsInvalid", view.briefs_invalid.length)}
        </p>
      )}
    </>
  );

  return (
    <div className="tool-page rv-page pf-page fd-page rd-feed">
      <div className="rv-col">
        <FeedHead />
        {stale && <StaleBanner lastGoodAt={asOf} onRetry={feed.reload} />}
        {!stale && view.partial.length > 0 && <StaleBanner what={t("builds.feed.partial")} lastGoodAt={t("builds.withoutSources", { time: asOf, sources: view.partial.map(sourceWord).join(t("builds.sourcesJoin")) })} onRetry={feed.reload} />}
        {stale ? <div className="stale-feed">{list}</div> : list}
      </div>
      {pending && <UndoToast id={pending.id} text={t("builds.toast.closed", { title: pending.what })} onUndo={() => setPending(null)} onExpire={commitPending} />}
    </div>
  );
}

function FeedHead() {
  const t = useT();
  return (
    <div className="rd-builds-head">
      <div className="rd-eyebrow">{t("builds.feed.eyebrow")}</div>
      <h2>
        {t("builds.feed.title")}<span className="rd-title-dot">.</span>
      </h2>
      <p>{t("builds.feed.subtitle")}</p>
    </div>
  );
}

const SOURCE_WORD: Record<string, Key> = { ledger: "builds.source.ledger", timeline: "builds.source.timeline", tracks: "builds.source.tracks", ideas: "builds.source.ideas", briefs: "builds.source.briefs" };
const sourceWord = (s: string) => (Object.prototype.hasOwnProperty.call(SOURCE_WORD, s) ? t(SOURCE_WORD[s]) : s);

export default function Feed() {
  return <FeedList />;
}
