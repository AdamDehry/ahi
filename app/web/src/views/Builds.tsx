import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { actions, useAppState } from "../store";
import { IconBack, IconAnswer } from "../components/icons";
import {
  ActionBar,
  AskCard,
  CompactItem,
  CompactList,
  DetailHead,
  EmptyState,
  ListRow,
  MoreRow,
  SectionHead,
  SkeletonRows,
  StaleBanner,
  StepsRail,
  Tally,
  Timeline,
  UndoToast,
  boardCells,
  type TimelineEvent,
  type Tone,
} from "../components/panel";
import { AGENT_LABEL, ageLabel, clockLabel } from "../components/panel/format";
import { usePanelFeed } from "../lib/usePanelFeed";
import { CodexLivePanel } from "./CodexLive";
import {
  BUILDS_URL,
  buildUrl,
  closeBuild,
  fetchGatewayBuild,
  fileBuild,
  liveCodexRun,
  needsYouBadge,
  shipBuild,
  type BuildDetail as Detail,
  type BuildsView,
  type Card,
  type SectionKey,
} from "../lib/builds";
import { clock, liveShip, shipSteps, type RestartChoice, type ShipState } from "../lib/ship";
import { t, tn, useT, type Key } from "../i18n";

/**
 * Builds (design: builds-panel-design) — not a log and not a
 * dashboard: a list of things that are not finished yet, sorted by whose move
 * it is. It does its job when it empties.
 *
 *   Needs you → Ready to close → Moving → Stuck → Queued → Closed this week
 *
 * The only fast action in the list is Close (C4) — held for 6 seconds behind
 * an Undo toast and only then sent. Answering happens in Michael's thread,
 * approvals in Review (C9). Nothing runs from this screen.
 */

const DAY = 86_400_000;
/** The desk's zone — times read the same wherever the phone is. */
const DESK_TZ = "America/New_York";

// ── pending close (shared by list + detail; the toast lives in the list) ──

type Pending = { id: string; title: string; kind: "closed" | "cancelled" };
let pending: Pending | null = null;
const failed = new Map<string, string>();
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => subs.delete(f));
let snapshot: { pending: Pending | null; failed: Map<string, string> } = { pending, failed: new Map(failed) };
function publish() {
  snapshot = { pending, failed: new Map(failed) };
  notify();
}

async function send(p: Pending) {
  const r = await closeBuild(p.id, p.kind);
  // "already closed" is the outcome he asked for (a fast second tap on a card
  // whose first close already landed) — never paint it as a failure.
  if (r.ok || r.error === "already closed") failed.delete(p.id);
  else failed.set(p.id, t("builds.didntClose", { error: r.error }));
  publish();
  actions.buildsChanged();
}

/** Close → the row leaves, the toast holds the POST for 6s. A second Close sends the first now. */
export function requestClose(card: Pick<Card, "id" | "title">, kind: "closed" | "cancelled" = "closed") {
  if (pending && pending.id !== card.id) void send(pending);
  failed.delete(card.id);
  pending = { id: card.id, title: card.title, kind };
  publish();
}

export function commitPending() {
  if (!pending) return;
  const p = pending;
  pending = null;
  publish();
  void send(p);
}

export function undoPending() {
  pending = null;
  publish();
}

export function usePending() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

// ── words ─────────────────────────────────────────────────────────────

const ms = (iso: string | null | undefined, now: number) => (iso ? Math.max(0, now - Date.parse(iso)) : 0);

function kickerWord(c: Card, tz: string): string {
  switch (c.kicker) {
    case "your-step":
      return t("builds.kicker.yourStep");
    case "question":
      return t("builds.kicker.question");
    case "in-review":
      return c.review_item?.lane === "RED" ? t("builds.kicker.inReviewFingerprint") : t("builds.kicker.inReviewOneTap");
    case "ship":
      return t("builds.kicker.readyToShip");
    case "shipping":
      return t("builds.kicker.shippingWord", { word: shipWord(c.ship) });
    case "rolled-back":
      return c.ship?.phase === "failed" ? t("builds.kicker.shipStopped") : t("builds.kicker.rolledBack");
    case "now":
      return t("builds.kicker.nowAsOf", { time: clockLabel(c.now!.at, tz) });
    case "started": {
      const first = c.runs.filter((r) => r.counted).at(-1) ?? c.runs.at(-1);
      return first ? t("builds.kicker.startedAt", { time: clockLabel(first.started, tz) }) : t("builds.kicker.started");
    }
    default:
      return c.kicker;
  }
}

/** One word for where a moving ship is, from the server's phase alone (the list has no clock). */
function shipWord(ship: ShipState | null): string {
  if (!ship) return "";
  if (ship.phase === "restarting") return t("builds.shipWord.restarting");
  if (ship.phase === "shipping") return ship.run?.merged ? t("builds.shipWord.building") : t("builds.shipWord.merging");
  return t("builds.shipWord.waking");
}

const CAUSE_WORD: Record<string, Key> = { died: "builds.cause.died", dark: "builds.cause.dark", error: "builds.cause.error", abandoned: "builds.cause.abandoned" };

function runsNote(c: Card): string | null {
  return c.runs.length > 1 ? t("builds.runs", { n: c.runs.length }) : null;
}

function stuckLine(c: Card, tz: string): string {
  const last = c.runs.filter((r) => r.counted).at(-1);
  if (last && last.state !== "running") {
    const cause = last.cause ?? "error";
    const word = t(Object.prototype.hasOwnProperty.call(CAUSE_WORD, cause) ? CAUSE_WORD[cause] : "builds.cause.error");
    return t("builds.stuckNeverRedone", { word, time: clockLabel(c.last_activity_at ?? last.started, tz) });
  }
  return t("builds.quietSince", { time: clockLabel(c.last_activity_at ?? c.opened_at, tz) });
}

function closedHow(how: string): string {
  if (how === "owner (app)") return t("builds.how.you");
  if (how.startsWith("owner (ship)")) return t("builds.how.youShipping");
  const relay = /^owner \(relayed by ([^)]+)\)/.exec(how);
  if (relay) return t("builds.how.youVia", { name: AGENT_LABEL[relay[1]] ?? relay[1] });
  return how;
}

const SECTION: Record<SectionKey, { label: Key; hint?: Key }> = {
  needs_you: { label: "builds.section.needsYou" },
  ready: { label: "builds.section.ready", hint: "builds.section.readyHint" },
  moving: { label: "builds.section.moving" },
  stuck: { label: "builds.section.stuck", hint: "builds.section.stuckHint" },
  queued: { label: "builds.section.queued", hint: "builds.section.queuedHint" },
  closed_week: { label: "builds.section.closedWeek" },
};

/** What a card's row opens: a review-linked card opens in Review (C10). */
function openCard(c: Card) {
  if (c.kicker === "in-review" && c.review_item) actions.openReview(c.review_item.id);
  else actions.openBuilds(c.id);
}

// ── list ──────────────────────────────────────────────────────────────

const LIMIT: Partial<Record<SectionKey, number>> = { ready: 4, stuck: 5, queued: 5, closed_week: 2 };

function SectionBody({ s, cards, view, now, selected }: { s: SectionKey; cards: Card[]; view: BuildsView; now: number; selected: string | null }) {
  const t = useT();
  const { failed: errors } = usePending();
  const [all, setAll] = useState(false);
  const limit = LIMIT[s];
  const shown = limit && !all ? cards.slice(0, limit) : cards;
  const more = cards.length - shown.length;
  const tz = view.tz;

  if (s === "needs_you" || s === "moving") {
    return (
      <>
        {shown.map((c) => (
          <ListRow
            key={c.id}
            tone={s === "needs_you" ? "you" : "move"}
            kicker={kickerWord(c, tz)}
            from={c.from}
            ageMs={ms(c.opened_at, now)}
            title={c.title}
            ask={c.kicker === "question" ? c.ask : null}
            lines={rowLines(c)}
            selected={selected === c.id}
            onOpen={() => openCard(c)}
          />
        ))}
      </>
    );
  }
  return (
    <CompactList>
      {shown.map((c) => {
        const common = { key: c.id, name: c.title, selected: selected === c.id, onOpen: () => openCard(c), error: errors.get(c.id) ?? null };
        if (s === "ready") {
          const sub = [c.close_note ?? t("builds.noCloseNote"), c.checks ? `${c.checks.passed}/${c.checks.total}` : null, runsNote(c)].filter(Boolean).join(" · ");
          return <CompactItem {...common} dot="built" sub={sub} ageMs={ms(c.opened_at, now)} onClose={() => requestClose(c)} />;
        }
        if (s === "stuck") {
          return <CompactItem {...common} dot="stuck" sub={[stuckLine(c, tz), runsNote(c)].filter(Boolean).join(" · ")} ageMs={ms(c.last_activity_at ?? c.opened_at, now)} />;
        }
        if (s === "queued") {
          const sub = [c.order !== null ? t("builds.buildOrder", { n: String(c.order) }) : null, c.left ? t("builds.leftColon", { text: c.left }) : c.done ? t("builds.doneColon", { text: c.done }) : c.order === null ? t("builds.notStarted") : null].filter(Boolean).join(" · ");
          return <CompactItem {...common} order={c.order} sub={sub} right={<span className="mono-label">{ageLabel(ms(c.opened_at, now))}</span>} />;
        }
        return <CompactItem {...common} dot="closed" closed sub={`${c.closed?.how.startsWith("cancelled") ? t("builds.word.stopped") : c.closed?.how.startsWith("owner (ship)") ? t("builds.word.shipped") : t("builds.word.closed")} ${clockLabel(c.closed!.at, tz)} · ${closedHow(c.closed!.how)}`} />;
      })}
      {more > 0 && <MoreRow label={s === "ready" ? t("builds.moreBuiltNotClosed", { n: more }) : t("builds.more", { n: more })} onClick={() => setAll(true)} />}
    </CompactList>
  );
}

function rowLines(c: Card) {
  if (c.kicker === "in-review") return c.review_item?.title ? [{ label: t("builds.line.asks"), text: c.review_item.title }] : [];
  if (c.kicker === "ship") return c.ship?.summary ? [{ label: t("builds.line.ships"), text: c.ship.summary }] : [];
  if (c.kicker === "rolled-back") return [{ label: t("builds.line.nowOn"), text: `${c.ship?.result?.sha ?? t("builds.previousBuild")}${c.ship?.result?.reason ? ` — ${c.ship.result.reason}` : ""}` }];
  if (c.kicker === "shipping") return [{ label: t("builds.line.now"), text: `${shipWord(c.ship)}${c.ship?.approved ? ` · ${c.ship.approved.restart === "now" ? t("builds.restartRightAway") : t("builds.restartWaitsCall")}` : ""}` }];
  if (c.kicker === "your-step") {
    const step = c.steps?.find((s) => s.state === "you");
    return [step ? { label: t("builds.line.step"), text: step.label } : null, c.left ? { label: t("builds.line.left"), text: c.left } : null].filter((x): x is { label: string; text: string } => !!x);
  }
  if (c.kicker === "now" && c.now) return [{ label: t("builds.line.doing"), text: c.now.text }, ...(c.left ? [{ label: t("builds.line.left"), text: c.left }] : [])];
  if (c.kicker === "started") return [{ label: t("builds.line.now"), text: t("builds.noReportYet") }, ...(c.left ? [{ label: t("builds.line.left"), text: c.left }] : [])];
  return [];
}

/** The board minus a close that is waiting out its Undo. */
export function withoutPending(view: BuildsView, id: string | null): BuildsView {
  if (!id) return view;
  const card = Object.values(view.sections).flat().find((c) => c.id === id);
  if (!card) return view;
  const sections = Object.fromEntries(Object.entries(view.sections).map(([k, cs]) => [k, cs.filter((c) => c.id !== id)])) as BuildsView["sections"];
  const removedNeed = view.sections.needs_you.some((c) => c.id === id);
  const oldest = view.tally.oldest?.id === id ? null : view.tally.oldest;
  return { ...view, sections, tally: { open: view.tally.open - 1, needs_you: view.tally.needs_you - (removedNeed ? 1 : 0), oldest: oldest ?? recomputeOldest(sections, Date.parse(view.now)) } };
}

function recomputeOldest(sections: BuildsView["sections"], now: number): BuildsView["tally"]["oldest"] {
  const open = (Object.keys(sections) as SectionKey[]).filter((k) => k !== "closed_week").flatMap((k) => sections[k]);
  const c = open.reduce<Card | null>((m, x) => (!m || Date.parse(x.opened_at) < Date.parse(m.opened_at) ? x : m), null);
  return c ? { id: c.id, title: c.title, ms: now - Date.parse(c.opened_at), days: Math.floor((now - Date.parse(c.opened_at)) / DAY) } : null;
}

export function BuildsList({ selected = null }: { selected?: string | null }) {
  const t = useT();
  const { buildsRev } = useAppState();
  const feed = usePanelFeed<BuildsView>(BUILDS_URL, buildsRev);
  const { pending: hold } = usePending();
  const now = Date.now();

  useEffect(() => {
    if (feed.data) actions.setBuildsNeedYou(needsYouBadge(feed.data));
  }, [feed.data]);

  // Navigating away with a close still in its toast: the toast "leaves", so it commits.
  useEffect(() => () => commitPending(), []);

  const view = useMemo(() => (feed.data ? withoutPending(feed.data, hold?.id ?? null) : null), [feed.data, hold?.id]);

  // The opened card's row is brought into view — the attention bar's tap
  // lands on a board that may be scrolled anywhere.
  const listRef = useRef<HTMLDivElement>(null);
  const loaded = !!view;
  useEffect(() => {
    if (!selected || !loaded) return;
    const row = listRef.current?.querySelector<HTMLElement>(".pf-row.sel, .pf-li.sel");
    row?.scrollIntoView?.({ block: "nearest" });
  }, [selected, loaded]);

  if (!view) {
    return (
      <div className="tool-page rv-page pf-page">
        <div className="rv-col">
          {feed.error ? <StaleBanner lastGoodAt={t("builds.nothingYet")} what={t("ops.cantReachGateway")} onRetry={feed.reload} /> : <SkeletonRows n={3} />}
        </div>
      </div>
    );
  }

  const stale = !!feed.error && feed.lastGoodAt !== null;
  const asOf = feed.lastGoodAt ? clockLabel(new Date(feed.lastGoodAt).toISOString(), view.tz) : "";
  const minsAgo = feed.lastGoodAt ? Math.max(1, Math.round((now - feed.lastGoodAt) / 60_000)) : 0;
  const { tally, sections } = view;
  const open = tally.open;

  const board = (
    <>
      <Tally cells={boardCells(open, tally.needs_you, tally.oldest ? Math.max(0, now - Date.parse(view.now) + tally.oldest.ms) : null)} />
      {open === 0 && <EmptyState title={t("builds.empty.title")} em={t("builds.empty.em")} body={<>{t("builds.empty.body1")}<br />{t("builds.empty.body2")}</>} />}
      {open > 1 && sections.needs_you.length === 0 && <p className="pf-quiet">{t("builds.nothingWaiting")}</p>}
      {(["needs_you", "ready", "moving", "stuck", "queued", "closed_week"] as SectionKey[]).map((s) =>
        sections[s].length ? (
          <section key={s} className="pf-section">
            <SectionHead label={t(SECTION[s].label)} count={sections[s].length} hint={stale && s === "needs_you" ? t("builds.asOf", { time: asOf }) : SECTION[s].hint ? t(SECTION[s].hint!) : undefined} tone={s === "needs_you" ? "you" : undefined} />
            <SectionBody s={s} cards={sections[s]} view={view} now={now} selected={selected} />
          </section>
        ) : null,
      )}
      {open === 1 && sections.needs_you.length === 0 && <p className="pf-quiet pf-quiet-end">{t("builds.nothingElseOpen")}</p>}
    </>
  );

  return (
    <div className="tool-page rv-page pf-page" ref={listRef}>
      <div className="rv-col">
        {stale && <StaleBanner lastGoodAt={tn("builds.asOfAgo", minsAgo, { time: asOf })} onRetry={feed.reload} />}
        {!stale && view.partial.length > 0 && (
          <StaleBanner what={t("builds.partialBoard")} lastGoodAt={t("builds.withoutSources", { time: asOf, sources: view.partial.map(sourceWord).join(t("builds.sourcesJoin")) })} onRetry={feed.reload} />
        )}
        {stale ? <div className="stale-feed">{board}</div> : board}
      </div>
      {hold && <UndoToast id={hold.id} text={hold.kind === "cancelled" ? t("builds.toast.stopped", { title: hold.title }) : t("builds.toast.closed", { title: hold.title })} onUndo={undoPending} onExpire={commitPending} />}
    </div>
  );
}

const SOURCE_WORD: Record<string, Key> = { ledger: "builds.source.ledger", timeline: "builds.source.timeline", tracks: "builds.source.tracks" };
const sourceWord = (s: string) => (Object.prototype.hasOwnProperty.call(SOURCE_WORD, s) ? t(SOURCE_WORD[s]) : s);

// ── detail ────────────────────────────────────────────────────────────

const CHIP: Record<SectionKey, { tone: Tone; word: Key }> = {
  needs_you: { tone: "you", word: "builds.section.needsYou" },
  ready: { tone: "built", word: "builds.chip.builtReady" },
  moving: { tone: "move", word: "builds.chip.building" },
  stuck: { tone: "stuck", word: "builds.section.stuck" },
  queued: { tone: "queued", word: "builds.section.queued" },
  closed_week: { tone: "closed", word: "builds.word.closed" },
};

const UNCOUNTED: Record<string, Key> = { "never-launched": "builds.uncounted.neverLaunched", superseded: "builds.uncounted.superseded", redone: "builds.uncounted.redone" };

function timelineRuns(d: Detail, tz: string) {
  const ordered = [...d.timeline].sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
  const number = new Map(ordered.map((r, i) => [r.run, i + 1]));
  return d.timeline.map((r) => {
    const label = [t("builds.runN", { n: number.get(r.run) ?? 0 }), AGENT_LABEL[r.agent] ?? r.agent, clockLabel(r.started, tz), !r.counted && r.cause ? (Object.prototype.hasOwnProperty.call(UNCOUNTED, r.cause) ? t(UNCOUNTED[r.cause]) : r.cause) : null].filter(Boolean).join(" · ");
    const events: TimelineEvent[] = r.entries.map((e, i) => {
      // A closed record that says what the summary card already says is a marker, not a repeat.
      const marker = (d.section === "ready" || d.section === "closed_week") && e.kind === "closed" && !!d.close_note && e.finished === d.close_note;
      // Michael's notes are chat replies: plain words here, no markdown marks.
      const finished = e.kind === "note" && e.finished ? e.finished.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ") : e.finished;
      return { key: `${r.run}-${i}`, kind: e.kind, time: clockLabel(e.at, tz), finished, now: e.now, question: e.question, checks: e.checks, marker };
    });
    const empty = r.cause === "never-launched" ? t("builds.neverLaunched") : t("builds.noRunRecords");
    return { key: r.run, label, events, empty };
  });
}

function Lines({ c }: { c: Card }) {
  const t = useT();
  if (!c.done && !c.left) return null;
  return (
    <div className="pf-lines">
      {c.done && (
        <div className="pf-line">
          <span className="mono-label">{t("builds.line.done")}</span>
          <span dir="auto">{c.done}</span>
        </div>
      )}
      {c.left && (
        <div className="pf-line">
          <span className="mono-label">{t("builds.line.left")}</span>
          <span dir="auto">{c.left}</span>
        </div>
      )}
    </div>
  );
}

function FilePicker({ card, onDone }: { card: Card; onDone: () => void }) {
  const t = useT();
  const feed = usePanelFeed<BuildsView>(BUILDS_URL);
  const [err, setErr] = useState<string | null>(null);
  const tracks = feed.data ? (Object.entries(feed.data.sections) as Array<[SectionKey, Card[]]>).filter(([k]) => k !== "closed_week").flatMap(([, cs]) => cs).filter((c) => c.id.startsWith("trk-")) : [];
  return (
    <div className="pf-file">
      <SectionHead label={t("builds.fileUnder")} hint={t("builds.fileUnderHint")} />
      {err && <div className="rv-error" role="alert">{err}</div>}
      <CompactList>
        {tracks.map((tr) => (
          <CompactItem
            key={tr.id}
            order={tr.order}
            name={tr.title}
            sub={tr.left ? t("builds.leftColon", { text: tr.left }) : t("builds.openTrack")}
            onOpen={async () => {
              const r = await fileBuild(card.id, tr.id);
              if (!r.ok) return setErr(r.error);
              actions.buildsChanged();
              actions.closeBuildItem();
              onDone();
            }}
          />
        ))}
        {feed.data && !tracks.length && <div className="pf-quiet">{t("builds.noTracks")}</div>}
      </CompactList>
    </div>
  );
}

/** The chip for a card on the ship lane; null leaves the section's own word. */
function shipChip(d: Detail, live: ReturnType<typeof liveShip>): { tone: Tone; word: string } | null {
  if (d.kicker === "ship") return { tone: "you", word: t("builds.kicker.readyToShip") };
  if (d.kicker === "shipping") return { tone: "move", word: live ? t("builds.kicker.shippingWord", { word: live.label.toLowerCase() }) : t("builds.shipping") };
  if (d.kicker === "rolled-back") return { tone: "stuck", word: d.ship?.phase === "failed" ? t("builds.kicker.shipStopped") : t("builds.kicker.rolledBack") };
  if (d.ship?.phase === "shipped") return { tone: "built", word: t("builds.shippedOn", { sha: d.ship.result?.sha ?? t("builds.newBuild") }) };
  if (d.ship?.phase === "candidate" && d.section === "ready") return { tone: "built", word: t("builds.builtAwaitingReview") };
  return null;
}

const TOUCH_WORD: Record<"server" | "app" | "both", Key> = {
  server: "builds.touch.server",
  app: "builds.touch.app",
  both: "builds.touch.both",
};

/**
 * What ships, in plain words, before he taps: the paragraph, what it touches,
 * env additions by name, what the restart costs, the rollback. While it
 * ships: the stepper with the elapsed time. After: the result.
 */
function ShipCard({ ship, live, kicker }: { ship: ShipState; live: ReturnType<typeof liveShip>; kicker: Card["kicker"] }) {
  const t = useT();
  const m = ship.manifest;
  const moving = !!live && live.phase !== "back" && live.phase !== "rolled_back" && live.phase !== "failed";
  const [, tick] = useState(0);
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [moving]);
  const facts: Array<{ label: string; text: string }> = [];
  if (m) {
    facts.push({ label: t("builds.fact.touches"), text: t(TOUCH_WORD[m.touches]) });
    if (m.env.length) facts.push({ label: t("builds.fact.newSettings"), text: m.env.join(", ") });
    facts.push({ label: t("builds.fact.restart"), text: m.restart ? ship.costs ?? t("builds.fact.restartCost") : t("builds.fact.noneNeeded") });
    facts.push({ label: t("builds.fact.rollback"), text: m.restart ? t("builds.fact.rollbackAuto") : t("builds.fact.buildBefore") });
  }
  const approvedWho = ship.approved ? (ship.approved.by === "owner" ? t("builds.how.you") : ship.approved.by) : null;
  const afterDark = (n: number | null) => (n !== null ? t("builds.result.afterDark", { n }) : "");
  return (
    <div className={`pf-card ship${kicker === "ship" ? " you" : ""}`}>
      <span className="mono-label pf-card-you-label">
        {kicker === "ship" ? (ship.ready_at ? t("builds.readyReviewed") : t("builds.kicker.readyToShip")) : kicker === "shipping" ? t("builds.shipping") : kicker === "rolled-back" ? (ship.phase === "failed" ? t("builds.kicker.shipStopped") : t("builds.kicker.rolledBack")) : ship.phase === "shipped" ? t("builds.word.shipped") : t("builds.builtNotReviewed")}
      </span>
      {ship.summary && <div className="q" dir="auto">{ship.summary}</div>}
      {(ship.active || ship.result) && (
        <>
          <StepsRail steps={shipSteps(ship, live)} />
          {live && moving && (
            <div className="pf-line">
              <span className="mono-label">{t("builds.elapsed")}</span>
              <span>
                {clock(live.elapsedMs)}
                {live.dark ? t("builds.dark") : ""}
                {ship.approved ? ` · ${ship.approved.restart === "now" ? t("builds.restartRightAway") : t("builds.restartWaitsLiveCall")}` : ""}
              </span>
            </div>
          )}
          {ship.result && (
            <div className="body">
              {ship.result.outcome === "ok" && `${t("builds.result.backOn", { sha: ship.result.sha ?? t("builds.newBuild") })}${afterDark(ship.result.dark_s)}.${approvedWho ? t("builds.result.approvedBy", { who: approvedWho, time: clockLabel(ship.approved!.at, DESK_TZ) }) : ""}`}
              {ship.result.outcome === "rolled_back" && `${t("builds.result.wentBack", { sha: ship.result.sha ?? t("builds.previousBuild") })}${afterDark(ship.result.dark_s)}.${ship.result.reason ? ` ${ship.result.reason}` : ""}`}
              {ship.result.outcome === "failed" && `${t("builds.result.stopped")}${ship.result.reason ? ` ${ship.result.reason}` : ""}`}
            </div>
          )}
        </>
      )}
      {!ship.active && !ship.result && facts.length > 0 && (
        <div className="pf-lines">
          {facts.map((f) => (
            <div className="pf-line" key={f.label}>
              <span className="mono-label">{f.label}</span>
              <span dir="auto">{f.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The ship, live (FINAL): opened by Ship update after the fingerprint. Five stations —
 * Approved, Merged, Built, Restarting, Back — moving in real time from the server's ship state (the
 * socket fills the dark window). Closing it doesn't stop anything: the card and the attention bar keep
 * the same live line.
 */
function ShipModal({ title, ship, live, onClose }: { title: string; ship: ShipState; live: ReturnType<typeof liveShip>; onClose: () => void }) {
  const t = useT();
  const [, tick] = useState(0);
  const done = !live || live.phase === "back" || live.phase === "rolled_back" || live.phase === "failed";
  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [done]);
  useEffect(() => {
    const w = globalThis.window as Window | undefined;
    if (!w || typeof w.addEventListener !== "function") return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    w.addEventListener("keydown", k);
    return () => w.removeEventListener("keydown", k);
  }, [onClose]);
  const steps = shipSteps(ship, live);
  const SHORT = [t("builds.step.approved"), t("builds.step.merged"), t("builds.step.built"), t("builds.step.restarting"), t("builds.step.back")];
  const afterDark = (n: number | null) => (n !== null ? t("builds.result.afterDark", { n }) : "");
  return (
    <div className="ship-modal-layer" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ship-modal" role="dialog" aria-modal="true" aria-label={t("builds.shippingTitle", { title })}>
        <header>
          <div>
            <span className="rd-eyebrow">{live?.phase === "back" ? t("builds.eyebrow.shipped") : live?.phase === "rolled_back" ? t("builds.eyebrow.rolledBack") : live?.phase === "failed" ? t("builds.eyebrow.stopped") : t("builds.eyebrow.shipping")}</span>
            <h2 dir="auto">{title}</h2>
            <small role="status" aria-live="polite">
              {live ? `${live.label}${!done ? ` · ${clock(live.elapsedMs)}${live.dark ? t("builds.dark") : ""}` : ""}` : t("builds.live.waking")}
            </small>
          </div>
          <button type="button" className="rd-chat-control" aria-label={t("builds.closeShipGoes")} onClick={onClose}>
            ✕
          </button>
        </header>
        <ol className="ship-steps">
          {steps.map((st, i) => (
            <li key={i} className={`ship-step ${st.state}`}>
              <span className="ship-step-dot" aria-hidden="true">{st.state === "done" ? "✓" : i + 1}</span>
              <div>
                <strong>{i === 4 && (live?.phase === "rolled_back" || live?.phase === "failed") ? st.label : SHORT[i]}</strong>
                <p>{st.state === "now" ? `${t("builds.inProgress")}${live && !done ? ` · ${clock(live.elapsedMs)}` : ""}` : st.state === "done" ? (st.who ? t("builds.completeWho", { who: st.who }) : t("builds.complete")) : t("builds.waiting")}</p>
              </div>
            </li>
          ))}
        </ol>
        <footer>
          {ship.result?.outcome === "ok" && <p>{t("builds.result.backOn", { sha: ship.result.sha ?? t("builds.newBuild") })}{afterDark(ship.result.dark_s)}.</p>}
          {ship.result?.outcome === "rolled_back" && <p>{t("builds.result.wentBackModal", { sha: ship.result.sha ?? t("builds.previousBuild") })}</p>}
          {ship.result?.outcome === "failed" && <p>{t("builds.result.stopped")}{ship.result.reason ? ` ${ship.result.reason}` : ""}</p>}
          {!ship.result && <p>{t("builds.draftsWait")}</p>}
          <button type="button" className="rv-btn ink" onClick={onClose}>
            {done ? t("common.done") : t("builds.keepWorking")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Ship, with the restart choice beside it. Default waits for a live call to
 * end; "right away" drops it. A call on right now is said plainly (from
 * /health). "Not now" leaves the card; the bar's dismissal is its own.
 */
function ShipBar({ card, ship, onShipped }: { card: Detail; ship: ShipState; onShipped: (s: ShipState) => void }) {
  const t = useT();
  const [choice, setChoice] = useState<RestartChoice>("wait");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [calls, setCalls] = useState<number | null>(null);
  const restarts = ship.manifest?.restart ?? true;
  useEffect(() => {
    if (!restarts) return;
    void fetchGatewayBuild().then((b) => b && setCalls(b.calls));
  }, [restarts]);
  const tap = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await shipBuild(card.id, choice);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onShipped(r.value.state);
    if (!r.value.woke) setErr(t("builds.notWoken"));
  };
  return (
    <ActionBar
      error={err}
      note={
        restarts ? (
          <span className="ship-choice" role="radiogroup" aria-label={t("builds.fact.restart")}>
            <span className="mono-label">{t("builds.fact.restart")}</span>
            <button type="button" role="radio" aria-checked={choice === "wait"} className={`ship-opt${choice === "wait" ? " on" : ""}`} onClick={() => setChoice("wait")}>
              {t("builds.whenNoCall")}
            </button>
            <button type="button" role="radio" aria-checked={choice === "now"} className={`ship-opt${choice === "now" ? " on" : ""}`} onClick={() => setChoice("now")}>
              {t("builds.rightAway")}
            </button>
            {calls !== null && calls > 0 && <span className="ship-call">{choice === "wait" ? t("builds.callOnWait") : t("builds.callOnDrop")}</span>}
          </span>
        ) : (
          t("builds.noRestart")
        )
      }
    >
      <button className="rv-btn outline" onClick={actions.closeBuildItem}>{t("builds.notNow")}</button>
      <button className="rv-btn ink ship-btn" disabled={busy} onClick={() => void tap()}>
        {busy ? t("builds.waitingFingerprint") : t("builds.shipUpdate")}
      </button>
    </ActionBar>
  );
}

export function BuildDetail({ id, withBackBar, inlineBar, split = false }: { id: string; withBackBar?: boolean; inlineBar?: boolean; split?: boolean }) {
  const t = useT();
  const state = useAppState();
  const { buildsRev } = state;
  const feed = usePanelFeed<Detail>(buildUrl(id), buildsRev);
  const [filing, setFiling] = useState(false);
  const d = feed.data;
  const now = Date.now();

  useEffect(() => setFiling(false), [id]);
  // Ship update → fingerprint → this window with the live timeline (FINAL ship flow).
  const [shipOpen, setShipOpen] = useState(false);
  useEffect(() => setShipOpen(false), [id]);
  const movingShip = !!d?.ship?.active && d.kicker === "shipping";
  useEffect(() => {
    if (movingShip && d) actions.watchShip({ cardId: d.id, title: d.title });
  }, [movingShip, d?.id, d?.title]);

  if (!d) {
    return (
      <div className="rv-detail">
        <div className="rv-detail-scroll">
          <div className="rv-col">{feed.error ? <div className="tool-empty mono-label">{feed.error === "HTTP 404" ? t("builds.buildGone") : t("builds.cantReachGateway")}</div> : <div className="l2-content skeleton-card" />}</div>
        </div>
      </div>
    );
  }

  const tz = DESK_TZ;
  // A Codex build is watchable here, live (Claude builds keep their claude.ai session link).
  const liveRun = liveCodexRun(d);
  const meta = [d.order !== null ? t("builds.buildOrder", { n: String(d.order) }) : null, t("builds.opened", { time: clockLabel(d.opened_at, tz) }), ageLabel(ms(d.opened_at, now))].filter(Boolean).join(" · ");
  const ask = d.timeline.flatMap((r) => r.entries).find((e) => e.kind === "needs_operator");
  const back = withBackBar && (
    <div className="l2-head">
      <button className="l2-back" onClick={actions.closeBuildItem}>
        <IconBack />
        <span className="mono-label">{t("builds.backLabel")}</span>
      </button>
    </div>
  );
  const quote = (text: string, asked: { build: string | null | undefined; record: string | null | undefined } | null = null) => actions.answerInThread("michael", text, asked);

  // The ship lane: the card's own state, or the live copy App keeps while this ship is being watched.
  const ship = state.shipWatch?.cardId === d.id && state.shipLive ? state.shipLive : d.ship;
  const live = ship ? liveShip({ ship, connection: state.connection, restartingAt: state.restartingAt, shaBefore: state.gatewayShaBefore, shaNow: state.gatewayShaNow, now }) : null;

  let bar: JSX.Element | null = null;
  if (d.section === "needs_you" && d.kicker === "ship" && ship) {
    bar = (
      <ShipBar
        card={d}
        ship={ship}
        onShipped={(st) => {
          actions.watchShip({ cardId: d.id, title: d.title });
          actions.setShipLive(st);
          actions.buildsChanged();
          setShipOpen(true);
        }}
      />
    );
  } else if (d.section === "needs_you" && d.kicker === "rolled-back" && ship) {
    bar = (
      <ActionBar note={t("builds.wokenNote")}>
        <button className="rv-btn outline" onClick={actions.closeBuildItem}>{t("builds.later")}</button>
        <button className="rv-btn ink" onClick={() => quote(t(ship.phase === "failed" ? "builds.q.shipStopped" : "builds.q.shipRolledBack", { title: d.title, reason: ship.result?.reason ? `: ${ship.result.reason}` : "" }))}>
          <IconAnswer />
          {t("builds.askMichael")}
        </button>
      </ActionBar>
    );
  } else if (d.section === "needs_you" && d.kicker === "question" && d.ask) {
    bar = (
      <ActionBar note={t("builds.answerNote")}>
        <button className="rv-btn outline" onClick={actions.closeBuildItem}>{t("builds.later")}</button>
        <button className="rv-btn ink" onClick={() => quote(d.from ? t("builds.q.asks", { title: d.title, name: AGENT_LABEL[d.from] ?? d.from, ask: d.ask ?? "" }) : t("builds.q.asked", { title: d.title, ask: d.ask ?? "" }), { build: d.ask_build, record: d.ask_record })}>
          <IconAnswer />
          {t("builds.answerInThread")}
        </button>
      </ActionBar>
    );
  } else if (d.section === "needs_you" && d.review_item) {
    bar = (
      <ActionBar note={t("builds.approvalsInReview")}>
        <button className="rv-btn outline" onClick={actions.closeBuildItem}>{t("builds.later")}</button>
        <button className="rv-btn ink" onClick={() => actions.openReview(d.review_item!.id)}>{t("builds.openInReview")}</button>
      </ActionBar>
    );
  } else if (d.section === "ready" && !filing) {
    bar = (
      <ActionBar>
        {d.id.startsWith("bld-") && <button className="rv-btn outline" onClick={() => setFiling(true)}>{t("builds.fileUnderEllipsis")}</button>}
        <button className="rv-btn ink" onClick={() => (requestClose(d), actions.closeBuildItem())}>{t("builds.closeIt")}</button>
      </ActionBar>
    );
  } else if (d.section === "stuck") {
    bar = (
      <ActionBar>
        <button className="rv-btn outline" onClick={() => (requestClose(d, "cancelled"), actions.closeBuildItem())}>{t("builds.closeAsStopped")}</button>
        <button className="rv-btn ink" onClick={() => quote(t("builds.q.stuck", { title: d.title, line: stuckLine(d, tz), runs: d.runs.length > 1 ? `, ${t("builds.runs", { n: d.runs.length })}` : "" }))}>
          <IconAnswer />
          {t("builds.askMichael")}
        </button>
      </ActionBar>
    );
  }

  const body = (
    <>
          {back}
          <DetailHead chip={shipChip(d, live) ?? (d.kicker === "in-review" ? { tone: "review", word: t("builds.chip.inReview") } : { tone: CHIP[d.section].tone, word: t(CHIP[d.section].word) })} metaLine={meta} title={d.title} />

          {ship && (d.kicker === "ship" || d.kicker === "shipping" || d.kicker === "rolled-back" || ship.phase === "shipped" || ship.phase === "candidate") && (
            <ShipCard ship={ship} live={live} kicker={d.kicker} />
          )}

          {d.section === "needs_you" && d.ask && (
            <AskCard from={d.from} at={ask ? clockLabel(ask.at, tz) : null} question={d.ask} context={ask ? [ask.finished, ask.now].filter(Boolean).map((t) => (/[.!?…]$/.test(t!) ? t : `${t}.`)).join(" ") || null : null} />
          )}
          {d.section === "needs_you" && !d.ask && d.kicker === "your-step" && (
            <div className="pf-card you">
              <span className="mono-label pf-card-you-label">{t("builds.kicker.yourStep")}</span>
              <div className="q" dir="auto">{d.steps?.find((s) => s.state === "you")?.label ?? (d.left || t("builds.waitingOnYou"))}</div>
            </div>
          )}
          {d.section === "needs_you" && d.review_item && (
            <div className="pf-card you">
              <span className="mono-label pf-card-you-label">{d.review_item.lane === "RED" ? t("builds.kicker.inReviewFingerprint") : t("builds.kicker.inReviewOneTap")}</span>
              <div className="q" dir="auto">{d.review_item.title || t("builds.decisionWaits")}</div>
            </div>
          )}

          {(d.section === "ready" || d.section === "closed_week") && (
            <div className="pf-card">
              {d.checks && (
                <div className="pf-checks">
                  <span className={`pf-fig${d.checks.passed < d.checks.total ? " partial" : ""}`}>
                    {d.checks.passed}/{d.checks.total}
                  </span>
                  <span className="mono-label">{t("builds.checksMeasured")}</span>
                </div>
              )}
              <div className={`body${d.close_note ? "" : " faint"}`} dir="auto">{d.close_note ?? t("builds.noCloseNoteLong")}</div>
              {d.closed && <span className="mono-label">{d.closed.how.startsWith("cancelled") ? t("builds.word.stopped") : t("builds.word.closed")} {clockLabel(d.closed.at, tz)} · {closedHow(d.closed.how)}</span>}
            </div>
          )}

          {d.section === "stuck" && (
            <div className="pf-card">
              <span className="mono-label pf-stuck-label">{t("builds.whatWentQuiet")}</span>
              <div className="body">
                {t("builds.stuckAgo", { line: stuckLine(d, tz), age: ageLabel(ms(d.last_activity_at ?? d.opened_at, now)) })}
                {d.runs.length > 1 ? t("builds.runsCounted", { n: d.runs.length, m: d.runs.filter((r) => r.counted).length }) : ""}
              </div>
            </div>
          )}

          {filing && <FilePicker card={d} onDone={() => setFiling(false)} />}

          {liveRun && (
            <>
              <SectionHead label={t("builds.liveSession")} hint={d.runs.length > 1 ? t("builds.codexRun", { n: d.runs.findIndex((r) => r.build === liveRun.build) + 1 }) : "Codex"} />
              <CodexLivePanel build={liveRun.build} tz={tz} />
            </>
          )}

          {d.steps?.length ? (
            <>
              <SectionHead label={t("builds.whatsLeft")} />
              <StepsRail steps={d.steps.map((s) => ({ ...s, who: s.state === "now" && s.who ? t("builds.whoNow", { who: s.who }) : s.who }))} />
            </>
          ) : (
            <Lines c={d} />
          )}

          {d.section === "moving" && d.now && !d.steps?.length && (
            <div className="pf-line">
              <span className="mono-label">{t("builds.line.now")}</span>
              <span>
                <span dir="auto">{d.now.text}</span> <span className="mono-label">{t("builds.asOfDot", { time: clockLabel(d.now.at, tz) })}</span>
              </span>
            </div>
          )}
          {d.section === "queued" && d.order !== null && <p className="pf-quiet">{t("builds.numberInOrder", { n: String(d.order) })}</p>}
    </>
  );
  const timeline = (
    <>
          {d.timeline.length > 0 && (
            <>
              <SectionHead label={t("builds.timeline")} hint={t("builds.newestFirst")} />
              <Timeline runs={timelineRuns(d, tz)} />
            </>
          )}
    </>
  );

  return (
    <div className={`rv-detail pf-detail${inlineBar ? " inline-bar" : ""}`}>
      <div className="rv-detail-scroll">
        <div className="rv-col">
          {split ? (
            // Redesign build page (FINAL): the card on the left, the timeline card on the right.
            <div className="rd-bd-grid">
              <div className="rd-bd-main">{body}</div>
              <aside className="rd-bd-side">{timeline}</aside>
            </div>
          ) : (
            <>
              {body}
              {timeline}
            </>
          )}
        </div>
      </div>
      {bar}
      {shipOpen && ship && <ShipModal title={d.title} ship={ship} live={live} onClose={() => setShipOpen(false)} />}
    </div>
  );
}

/** Desktop / non-pushed entry: the list pane beside the open card (DESIGN §7). */
export default function Builds() {
  const t = useT();
  const { buildsItem } = useAppState();
  return (
    <div className="pf-split">
      <div className="pf-split-list">
        <BuildsList selected={buildsItem} />
      </div>
      <div className="pf-split-detail">
        {buildsItem ? <BuildDetail id={buildsItem} inlineBar /> : <div className="tool-empty mono-label">{t("builds.pickBuild")}</div>}
      </div>
    </div>
  );
}
