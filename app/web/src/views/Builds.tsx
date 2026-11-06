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
  else failed.set(p.id, `Didn't close — ${r.error}`);
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
      return "Your step";
    case "question":
      return "Question";
    case "in-review":
      return c.review_item?.lane === "RED" ? "In Review · fingerprint" : "In Review · one tap";
    case "ship":
      return "Ready to ship";
    case "shipping":
      return `Shipping · ${shipWord(c.ship)}`;
    case "rolled-back":
      return c.ship?.phase === "failed" ? "Ship stopped" : "Rolled back";
    case "now":
      return `Now · as of ${clockLabel(c.now!.at, tz)}`;
    case "started": {
      const first = c.runs.filter((r) => r.counted).at(-1) ?? c.runs.at(-1);
      return first ? `Started ${clockLabel(first.started, tz)}` : "Started";
    }
    default:
      return c.kicker;
  }
}

/** One word for where a moving ship is, from the server's phase alone (the list has no clock). */
function shipWord(ship: ShipState | null): string {
  if (!ship) return "";
  if (ship.phase === "restarting") return "restarting";
  if (ship.phase === "shipping") return ship.run?.merged ? "building" : "merging";
  return "waking Michael";
}

const CAUSE_WORD: Record<string, string> = { died: "Session died", dark: "Went dark", error: "Failed", abandoned: "Stopped" };

function runsNote(c: Card): string | null {
  return c.runs.length > 1 ? `${c.runs.length} runs` : null;
}

function stuckLine(c: Card, tz: string): string {
  const last = c.runs.filter((r) => r.counted).at(-1);
  if (last && last.state !== "running") {
    const word = CAUSE_WORD[last.cause ?? "error"] ?? "Failed";
    return `${word} ${clockLabel(c.last_activity_at ?? last.started, tz)}, never redone`;
  }
  return `Quiet since ${clockLabel(c.last_activity_at ?? c.opened_at, tz)}`;
}

function closedHow(how: string): string {
  if (how === "owner (app)") return "you";
  if (how.startsWith("owner (ship)")) return "you, by shipping it";
  const relay = /^owner \(relayed by ([^)]+)\)/.exec(how);
  if (relay) return `you, via ${AGENT_LABEL[relay[1]] ?? relay[1]}`;
  return how;
}

const SECTION: Record<SectionKey, { label: string; hint?: string }> = {
  needs_you: { label: "Needs you" },
  ready: { label: "Ready to close", hint: "only you close" },
  moving: { label: "Moving" },
  stuck: { label: "Stuck", hint: "quiet 3D+" },
  queued: { label: "Queued", hint: "in order" },
  closed_week: { label: "Closed this week" },
};

/** What a card's row opens: a review-linked card opens in Review (C10). */
function openCard(c: Card) {
  if (c.kicker === "in-review" && c.review_item) actions.openReview(c.review_item.id);
  else actions.openBuilds(c.id);
}

// ── list ──────────────────────────────────────────────────────────────

const LIMIT: Partial<Record<SectionKey, number>> = { ready: 4, stuck: 5, queued: 5, closed_week: 2 };

function SectionBody({ s, cards, view, now, selected }: { s: SectionKey; cards: Card[]; view: BuildsView; now: number; selected: string | null }) {
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
          const sub = [c.close_note ?? "no close-out note", c.checks ? `${c.checks.passed}/${c.checks.total}` : null, runsNote(c)].filter(Boolean).join(" · ");
          return <CompactItem {...common} dot="built" sub={sub} ageMs={ms(c.opened_at, now)} onClose={() => requestClose(c)} />;
        }
        if (s === "stuck") {
          return <CompactItem {...common} dot="stuck" sub={[stuckLine(c, tz), runsNote(c)].filter(Boolean).join(" · ")} ageMs={ms(c.last_activity_at ?? c.opened_at, now)} />;
        }
        if (s === "queued") {
          const sub = [c.order !== null ? `Build order #${c.order}` : null, c.left ? `Left: ${c.left}` : c.done ? `Done: ${c.done}` : c.order === null ? "Not started" : null].filter(Boolean).join(" · ");
          return <CompactItem {...common} order={c.order} sub={sub} right={<span className="mono-label">{ageLabel(ms(c.opened_at, now))}</span>} />;
        }
        return <CompactItem {...common} dot="closed" closed sub={`${c.closed?.how.startsWith("cancelled") ? "Stopped" : c.closed?.how.startsWith("owner (ship)") ? "Shipped" : "Closed"} ${clockLabel(c.closed!.at, tz)} · ${closedHow(c.closed!.how)}`} />;
      })}
      {more > 0 && <MoreRow label={s === "ready" ? `${more} more built, not closed` : `${more} more`} onClick={() => setAll(true)} />}
    </CompactList>
  );
}

function rowLines(c: Card) {
  if (c.kicker === "in-review") return c.review_item?.title ? [{ label: "Asks", text: c.review_item.title }] : [];
  if (c.kicker === "ship") return c.ship?.summary ? [{ label: "Ships", text: c.ship.summary }] : [];
  if (c.kicker === "rolled-back") return [{ label: "Now on", text: `${c.ship?.result?.sha ?? "the previous build"}${c.ship?.result?.reason ? ` — ${c.ship.result.reason}` : ""}` }];
  if (c.kicker === "shipping") return [{ label: "Now", text: `${shipWord(c.ship)}${c.ship?.approved ? ` · restart ${c.ship.approved.restart === "now" ? "right away" : "waits for a call"}` : ""}` }];
  if (c.kicker === "your-step") {
    const step = c.steps?.find((s) => s.state === "you");
    return [step ? { label: "Step", text: step.label } : null, c.left ? { label: "Left", text: c.left } : null].filter((x): x is { label: string; text: string } => !!x);
  }
  if (c.kicker === "now" && c.now) return [{ label: "Doing", text: c.now.text }, ...(c.left ? [{ label: "Left", text: c.left }] : [])];
  if (c.kicker === "started") return [{ label: "Now", text: "No report yet" }, ...(c.left ? [{ label: "Left", text: c.left }] : [])];
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
          {feed.error ? <StaleBanner lastGoodAt="nothing yet" what="Can't reach the gateway." onRetry={feed.reload} /> : <SkeletonRows n={3} />}
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
      {open === 0 && <EmptyState title="Every build" em="closed." body={<>Nothing open, nothing waiting on you.<br />New work shows up here the moment it starts.</>} />}
      {open > 1 && sections.needs_you.length === 0 && <p className="pf-quiet">Nothing waiting on you.</p>}
      {(["needs_you", "ready", "moving", "stuck", "queued", "closed_week"] as SectionKey[]).map((s) =>
        sections[s].length ? (
          <section key={s} className="pf-section">
            <SectionHead label={SECTION[s].label} count={sections[s].length} hint={stale && s === "needs_you" ? `as of ${asOf}` : SECTION[s].hint} tone={s === "needs_you" ? "you" : undefined} />
            <SectionBody s={s} cards={sections[s]} view={view} now={now} selected={selected} />
          </section>
        ) : null,
      )}
      {open === 1 && sections.needs_you.length === 0 && <p className="pf-quiet pf-quiet-end">Nothing else open. Nothing waiting on you.</p>}
    </>
  );

  return (
    <div className="tool-page rv-page pf-page" ref={listRef}>
      <div className="rv-col">
        {stale && <StaleBanner lastGoodAt={`${asOf} — ${minsAgo === 1 ? "a minute" : `${minsAgo} minutes`} ago`} onRetry={feed.reload} />}
        {!stale && view.partial.length > 0 && (
          <StaleBanner what="Part of the board couldn't be read." lastGoodAt={`${asOf}, without the ${view.partial.map(sourceWord).join(" and the ")}`} onRetry={feed.reload} />
        )}
        {stale ? <div className="stale-feed">{board}</div> : board}
      </div>
      {hold && <UndoToast id={hold.id} text={`${hold.kind === "cancelled" ? "Stopped" : "Closed"} ${hold.title}`} onUndo={undoPending} onExpire={commitPending} />}
    </div>
  );
}

const sourceWord = (s: string) => ({ ledger: "build ledger", timeline: "status records", tracks: "track registry" })[s] ?? s;

// ── detail ────────────────────────────────────────────────────────────

const CHIP: Record<SectionKey, { tone: Tone; word: string }> = {
  needs_you: { tone: "you", word: "Needs you" },
  ready: { tone: "built", word: "Built · ready to close" },
  moving: { tone: "move", word: "Building" },
  stuck: { tone: "stuck", word: "Stuck" },
  queued: { tone: "queued", word: "Queued" },
  closed_week: { tone: "closed", word: "Closed" },
};

const UNCOUNTED: Record<string, string> = { "never-launched": "never launched", superseded: "superseded", redone: "redone later" };

function timelineRuns(d: Detail, tz: string) {
  const ordered = [...d.timeline].sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
  const number = new Map(ordered.map((r, i) => [r.run, i + 1]));
  return d.timeline.map((r) => {
    const label = [`Run ${number.get(r.run)}`, AGENT_LABEL[r.agent] ?? r.agent, clockLabel(r.started, tz), !r.counted && r.cause ? UNCOUNTED[r.cause] ?? r.cause : null].filter(Boolean).join(" · ");
    const events: TimelineEvent[] = r.entries.map((e, i) => {
      // A closed record that says what the summary card already says is a marker, not a repeat.
      const marker = (d.section === "ready" || d.section === "closed_week") && e.kind === "closed" && !!d.close_note && e.finished === d.close_note;
      // Michael's notes are chat replies: plain words here, no markdown marks.
      const finished = e.kind === "note" && e.finished ? e.finished.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ") : e.finished;
      return { key: `${r.run}-${i}`, kind: e.kind, time: clockLabel(e.at, tz), finished, now: e.now, question: e.question, checks: e.checks, marker };
    });
    const empty = r.cause === "never-launched" ? "Never launched." : "No status records for this run — it predates them.";
    return { key: r.run, label, events, empty };
  });
}

function Lines({ c }: { c: Card }) {
  if (!c.done && !c.left) return null;
  return (
    <div className="pf-lines">
      {c.done && (
        <div className="pf-line">
          <span className="mono-label">Done</span>
          <span>{c.done}</span>
        </div>
      )}
      {c.left && (
        <div className="pf-line">
          <span className="mono-label">Left</span>
          <span>{c.left}</span>
        </div>
      )}
    </div>
  );
}

function FilePicker({ card, onDone }: { card: Card; onDone: () => void }) {
  const feed = usePanelFeed<BuildsView>(BUILDS_URL);
  const [err, setErr] = useState<string | null>(null);
  const tracks = feed.data ? (Object.entries(feed.data.sections) as Array<[SectionKey, Card[]]>).filter(([k]) => k !== "closed_week").flatMap(([, cs]) => cs).filter((c) => c.id.startsWith("trk-")) : [];
  return (
    <div className="pf-file">
      <SectionHead label="File under" hint="an open track" />
      {err && <div className="rv-error" role="alert">{err}</div>}
      <CompactList>
        {tracks.map((t) => (
          <CompactItem
            key={t.id}
            order={t.order}
            name={t.title}
            sub={t.left ? `Left: ${t.left}` : "Open track"}
            onOpen={async () => {
              const r = await fileBuild(card.id, t.id);
              if (!r.ok) return setErr(r.error);
              actions.buildsChanged();
              actions.closeBuildItem();
              onDone();
            }}
          />
        ))}
        {feed.data && !tracks.length && <div className="pf-quiet">No open tracks to file under yet. Michael adds them to the build order.</div>}
      </CompactList>
    </div>
  );
}

/** The chip for a card on the ship lane; null leaves the section's own word. */
function shipChip(d: Detail, live: ReturnType<typeof liveShip>): { tone: Tone; word: string } | null {
  if (d.kicker === "ship") return { tone: "you", word: "Ready to ship" };
  if (d.kicker === "shipping") return { tone: "move", word: live ? `Shipping · ${live.label.toLowerCase()}` : "Shipping" };
  if (d.kicker === "rolled-back") return { tone: "stuck", word: d.ship?.phase === "failed" ? "Ship stopped" : "Rolled back" };
  if (d.ship?.phase === "shipped") return { tone: "built", word: `Shipped · on ${d.ship.result?.sha ?? "the new build"}` };
  if (d.ship?.phase === "candidate" && d.section === "ready") return { tone: "built", word: "Built · awaiting Michael's review" };
  return null;
}

const TOUCH_WORD: Record<"server" | "app" | "both", string> = {
  server: "the server",
  app: "the app",
  both: "the server and the app",
};

/**
 * What ships, in plain words, before he taps: the paragraph, what it touches,
 * env additions by name, what the restart costs, the rollback. While it
 * ships: the stepper with the elapsed time. After: the result.
 */
function ShipCard({ ship, live, kicker }: { ship: ShipState; live: ReturnType<typeof liveShip>; kicker: Card["kicker"] }) {
  const m = ship.manifest;
  const moving = !!live && live.phase !== "back" && live.phase !== "rolled_back" && live.phase !== "failed";
  const [, tick] = useState(0);
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [moving]);
  const facts: Array<{ label: string; text: string }> = [];
  if (m) {
    facts.push({ label: "Touches", text: TOUCH_WORD[m.touches] });
    if (m.env.length) facts.push({ label: "New settings", text: m.env.join(", ") });
    facts.push({ label: "Restart", text: m.restart ? ship.costs ?? "Michael restarts; the app is dark for a few seconds." : "None needed." });
    facts.push({ label: "Rollback", text: m.restart ? "Automatic: if the gateway is not healthy after the restart, it goes back to the build before this one." : "The build before this one." });
  }
  const approvedWho = ship.approved ? (ship.approved.by === "owner" ? "you" : ship.approved.by) : null;
  return (
    <div className={`pf-card ship${kicker === "ship" ? " you" : ""}`}>
      <span className="mono-label pf-card-you-label">
        {kicker === "ship" ? `Ready to ship${ship.ready_at ? ` · reviewed by Michael` : ""}` : kicker === "shipping" ? "Shipping" : kicker === "rolled-back" ? (ship.phase === "failed" ? "Ship stopped" : "Rolled back") : ship.phase === "shipped" ? "Shipped" : "Built, not yet reviewed"}
      </span>
      {ship.summary && <div className="q">{ship.summary}</div>}
      {(ship.active || ship.result) && (
        <>
          <StepsRail steps={shipSteps(ship, live)} />
          {live && moving && (
            <div className="pf-line">
              <span className="mono-label">Elapsed</span>
              <span>
                {clock(live.elapsedMs)}
                {live.dark ? " dark" : ""}
                {ship.approved ? ` · restart ${ship.approved.restart === "now" ? "right away" : "waits for a live call"}` : ""}
              </span>
            </div>
          )}
          {ship.result && (
            <div className="body">
              {ship.result.outcome === "ok" && `Back on ${ship.result.sha ?? "the new build"}${ship.result.dark_s !== null ? ` after ${ship.result.dark_s} seconds dark` : ""}.${approvedWho ? ` Approved by ${approvedWho} ${clockLabel(ship.approved!.at, DESK_TZ)}.` : ""}`}
              {ship.result.outcome === "rolled_back" && `The new build did not answer healthy, so it went back to ${ship.result.sha ?? "the previous build"}${ship.result.dark_s !== null ? ` after ${ship.result.dark_s} seconds dark` : ""}.${ship.result.reason ? ` ${ship.result.reason}` : ""}`}
              {ship.result.outcome === "failed" && `It stopped before the restart, so nothing changed.${ship.result.reason ? ` ${ship.result.reason}` : ""}`}
            </div>
          )}
        </>
      )}
      {!ship.active && !ship.result && facts.length > 0 && (
        <div className="pf-lines">
          {facts.map((f) => (
            <div className="pf-line" key={f.label}>
              <span className="mono-label">{f.label}</span>
              <span>{f.text}</span>
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
  const [, tick] = useState(0);
  const done = !live || live.phase === "back" || live.phase === "rolled_back" || live.phase === "failed";
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [done]);
  useEffect(() => {
    const w = globalThis.window as Window | undefined;
    if (!w || typeof w.addEventListener !== "function") return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    w.addEventListener("keydown", k);
    return () => w.removeEventListener("keydown", k);
  }, [onClose]);
  const steps = shipSteps(ship, live);
  const SHORT = ["Approved", "Merged", "Built", "Restarting", "Back"];
  return (
    <div className="ship-modal-layer" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ship-modal" role="dialog" aria-modal="true" aria-label={`Shipping ${title}`}>
        <header>
          <div>
            <span className="rd-eyebrow">{live?.phase === "back" ? "SHIPPED" : live?.phase === "rolled_back" ? "ROLLED BACK" : live?.phase === "failed" ? "STOPPED" : "SHIPPING"}</span>
            <h2>{title}</h2>
            <small role="status" aria-live="polite">
              {live ? `${live.label}${!done ? ` · ${clock(live.elapsedMs)}${live.dark ? " dark" : ""}` : ""}` : "Waking Michael"}
            </small>
          </div>
          <button type="button" className="rd-chat-control" aria-label="Close — the ship keeps going" onClick={onClose}>
            ✕
          </button>
        </header>
        <ol className="ship-steps">
          {steps.map((st, i) => (
            <li key={i} className={`ship-step ${st.state}`}>
              <span className="ship-step-dot" aria-hidden="true">{st.state === "done" ? "✓" : i + 1}</span>
              <div>
                <strong>{i === 4 && (live?.phase === "rolled_back" || live?.phase === "failed") ? st.label : SHORT[i]}</strong>
                <p>{st.state === "now" ? `In progress${live && !done ? ` · ${clock(live.elapsedMs)}` : ""}` : st.state === "done" ? (st.who ? `Complete · ${st.who}` : "Complete") : "Waiting"}</p>
              </div>
            </li>
          ))}
        </ol>
        <footer>
          {ship.result?.outcome === "ok" && <p>Back on {ship.result.sha ?? "the new build"}{ship.result.dark_s !== null ? ` after ${ship.result.dark_s} seconds dark` : ""}.</p>}
          {ship.result?.outcome === "rolled_back" && <p>The new build didn’t answer healthy, so it went back to {ship.result.sha ?? "the previous build"}.</p>}
          {ship.result?.outcome === "failed" && <p>It stopped before the restart, so nothing changed.{ship.result.reason ? ` ${ship.result.reason}` : ""}</p>}
          {!ship.result && <p>Drafts and messages wait safely while Michael restarts. You can close this — the ship keeps going.</p>}
          <button type="button" className="rv-btn ink" onClick={onClose}>
            {done ? "Done" : "Keep working"}
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
    if (!r.value.woke) setErr("Recorded, but Michael could not be woken — tap Ship again in a minute.");
  };
  return (
    <ActionBar
      error={err}
      note={
        restarts ? (
          <span className="ship-choice" role="radiogroup" aria-label="Restart">
            <span className="mono-label">Restart</span>
            <button type="button" role="radio" aria-checked={choice === "wait"} className={`ship-opt${choice === "wait" ? " on" : ""}`} onClick={() => setChoice("wait")}>
              when no call is live
            </button>
            <button type="button" role="radio" aria-checked={choice === "now"} className={`ship-opt${choice === "now" ? " on" : ""}`} onClick={() => setChoice("now")}>
              right away
            </button>
            {calls !== null && calls > 0 && <span className="ship-call">A call is on right now{choice === "wait" ? " — the restart waits for it to end." : " — it will drop."}</span>}
          </span>
        ) : (
          "No restart needed for this one."
        )
      }
    >
      <button className="rv-btn outline" onClick={actions.closeBuildItem}>Not now</button>
      <button className="rv-btn ink ship-btn" disabled={busy} onClick={() => void tap()}>
        {busy ? "Waiting for your fingerprint…" : "Ship update"}
      </button>
    </ActionBar>
  );
}

export function BuildDetail({ id, withBackBar, inlineBar, split = false }: { id: string; withBackBar?: boolean; inlineBar?: boolean; split?: boolean }) {
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
          <div className="rv-col">{feed.error ? <div className="tool-empty mono-label">{feed.error === "HTTP 404" ? "THAT BUILD IS GONE" : "CAN'T REACH THE GATEWAY"}</div> : <div className="l2-content skeleton-card" />}</div>
        </div>
      </div>
    );
  }

  const tz = DESK_TZ;
  // A Codex build is watchable here, live (Claude builds keep their claude.ai session link).
  const liveRun = liveCodexRun(d);
  const meta = [d.order !== null ? `Build order #${d.order}` : null, `opened ${clockLabel(d.opened_at, tz)}`, ageLabel(ms(d.opened_at, now))].filter(Boolean).join(" · ");
  const ask = d.timeline.flatMap((r) => r.entries).find((e) => e.kind === "needs_operator");
  const back = withBackBar && (
    <div className="l2-head">
      <button className="l2-back" onClick={actions.closeBuildItem}>
        <IconBack />
        <span className="mono-label">BUILDS</span>
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
      <ActionBar note="Michael was woken with the result and the log line.">
        <button className="rv-btn outline" onClick={actions.closeBuildItem}>Later</button>
        <button className="rv-btn ink" onClick={() => quote(`${d.title} — its ship ${ship.phase === "failed" ? "stopped" : "rolled back"}${ship.result?.reason ? `: ${ship.result.reason}` : ""}. What happens next?`)}>
          <IconAnswer />
          Ask Michael
        </button>
      </ActionBar>
    );
  } else if (d.section === "needs_you" && d.kicker === "question" && d.ask) {
    bar = (
      <ActionBar note="Your answer goes to Michael's thread, quoted. Sending it clears this question.">
        <button className="rv-btn outline" onClick={actions.closeBuildItem}>Later</button>
        <button className="rv-btn ink" onClick={() => quote(`${d.title} — ${d.from ? `${AGENT_LABEL[d.from] ?? d.from} asks` : "asked"}: ${d.ask}`, { build: d.ask_build, record: d.ask_record })}>
          <IconAnswer />
          Answer in thread
        </button>
      </ActionBar>
    );
  } else if (d.section === "needs_you" && d.review_item) {
    bar = (
      <ActionBar note="Approvals stay in Review.">
        <button className="rv-btn outline" onClick={actions.closeBuildItem}>Later</button>
        <button className="rv-btn ink" onClick={() => actions.openReview(d.review_item!.id)}>Open in Review</button>
      </ActionBar>
    );
  } else if (d.section === "ready" && !filing) {
    bar = (
      <ActionBar>
        {d.id.startsWith("bld-") && <button className="rv-btn outline" onClick={() => setFiling(true)}>File under…</button>}
        <button className="rv-btn ink" onClick={() => (requestClose(d), actions.closeBuildItem())}>Close it</button>
      </ActionBar>
    );
  } else if (d.section === "stuck") {
    bar = (
      <ActionBar>
        <button className="rv-btn outline" onClick={() => (requestClose(d, "cancelled"), actions.closeBuildItem())}>Close as stopped</button>
        <button className="rv-btn ink" onClick={() => quote(`${d.title} — ${stuckLine(d, tz)}${d.runs.length > 1 ? `, ${d.runs.length} runs` : ""}. What should happen to it?`)}>
          <IconAnswer />
          Ask Michael
        </button>
      </ActionBar>
    );
  }

  const body = (
    <>
          {back}
          <DetailHead chip={shipChip(d, live) ?? (d.kicker === "in-review" ? { tone: "review", word: "In Review" } : CHIP[d.section])} metaLine={meta} title={d.title} />

          {ship && (d.kicker === "ship" || d.kicker === "shipping" || d.kicker === "rolled-back" || ship.phase === "shipped" || ship.phase === "candidate") && (
            <ShipCard ship={ship} live={live} kicker={d.kicker} />
          )}

          {d.section === "needs_you" && d.ask && (
            <AskCard from={d.from} at={ask ? clockLabel(ask.at, tz) : null} question={d.ask} context={ask ? [ask.finished, ask.now].filter(Boolean).map((t) => (/[.!?…]$/.test(t!) ? t : `${t}.`)).join(" ") || null : null} />
          )}
          {d.section === "needs_you" && !d.ask && d.kicker === "your-step" && (
            <div className="pf-card you">
              <span className="mono-label pf-card-you-label">Your step</span>
              <div className="q">{d.steps?.find((s) => s.state === "you")?.label ?? (d.left || "Waiting on you")}</div>
            </div>
          )}
          {d.section === "needs_you" && d.review_item && (
            <div className="pf-card you">
              <span className="mono-label pf-card-you-label">{d.review_item.lane === "RED" ? "In Review · fingerprint" : "In Review · one tap"}</span>
              <div className="q">{d.review_item.title || "A decision waits in Review."}</div>
            </div>
          )}

          {(d.section === "ready" || d.section === "closed_week") && (
            <div className="pf-card">
              {d.checks && (
                <div className="pf-checks">
                  <span className={`pf-fig${d.checks.passed < d.checks.total ? " partial" : ""}`}>
                    {d.checks.passed}/{d.checks.total}
                  </span>
                  <span className="mono-label">checks, as measured</span>
                </div>
              )}
              <div className={`body${d.close_note ? "" : " faint"}`}>{d.close_note ?? "No close-out note — this build closed before status records existed."}</div>
              {d.closed && <span className="mono-label">{d.closed.how.startsWith("cancelled") ? "Stopped" : "Closed"} {clockLabel(d.closed.at, tz)} · {closedHow(d.closed.how)}</span>}
            </div>
          )}

          {d.section === "stuck" && (
            <div className="pf-card">
              <span className="mono-label pf-stuck-label">What went quiet</span>
              <div className="body">
                {stuckLine(d, tz)} — {ageLabel(ms(d.last_activity_at ?? d.opened_at, now))} ago.
                {d.runs.length > 1 ? ` ${d.runs.length} runs, ${d.runs.filter((r) => r.counted).length} that counted.` : ""}
              </div>
            </div>
          )}

          {filing && <FilePicker card={d} onDone={() => setFiling(false)} />}

          {liveRun && (
            <>
              <SectionHead label="Live session" hint={d.runs.length > 1 ? `Codex · run ${d.runs.findIndex((r) => r.build === liveRun.build) + 1}` : "Codex"} />
              <CodexLivePanel build={liveRun.build} tz={tz} />
            </>
          )}

          {d.steps?.length ? (
            <>
              <SectionHead label="What's left" />
              <StepsRail steps={d.steps.map((s) => ({ ...s, who: s.state === "now" && s.who ? `${s.who} · now` : s.who }))} />
            </>
          ) : (
            <Lines c={d} />
          )}

          {d.section === "moving" && d.now && !d.steps?.length && (
            <div className="pf-line">
              <span className="mono-label">Now</span>
              <span>
                {d.now.text} <span className="mono-label">· as of {clockLabel(d.now.at, tz)}</span>
              </span>
            </div>
          )}
          {d.section === "queued" && d.order !== null && <p className="pf-quiet">Number {d.order} in the build order.</p>}
    </>
  );
  const timeline = (
    <>
          {d.timeline.length > 0 && (
            <>
              <SectionHead label="Timeline" hint="newest first" />
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
  const { buildsItem } = useAppState();
  return (
    <div className="pf-split">
      <div className="pf-split-list">
        <BuildsList selected={buildsItem} />
      </div>
      <div className="pf-split-detail">
        {buildsItem ? <BuildDetail id={buildsItem} inlineBar /> : <div className="tool-empty mono-label">PICK A BUILD</div>}
      </div>
    </div>
  );
}
