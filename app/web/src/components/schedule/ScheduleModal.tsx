import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconBack, IconClose } from "../icons";
import {
  ago,
  clock,
  dayLabel,
  fetchBriefing,
  scheduleUi,
  SCHEDULE_URL,
  startBriefingPoll,
  createReadMarker,
  until,
  useScheduleUi,
  WEEKDAY,
  WEEKDAY_LONG,
  type AttentionRow,
  type BlockOut,
  type Briefing,
  type BriefLine,
  type DayOut,
  type DecisionRow,
  type ScheduleView,
  type WorkRow,
} from "../../lib/schedule";

/**
 * The Schedule: his approved week as a live calendar.
 *
 *   header icon → this window. Desktop: a centred modal. Phone: full screen,
 *   inside the safe areas, X top-right in thumb reach. Today is the default
 *   on a phone; the week is the default on a desk.
 *
 *   CALENDAR   the current block lit, its live briefs (newest first, one line,
 *              time ago); what needs him (unread marked, Clear all); the day
 *              or the week as time blocks; the background lane — what each
 *              agent is doing for this block and the next, and Michael's own
 *              calls with Overrule.
 *   BRIEFING   tap a block → that block's briefing. Opening it marks its
 *              items read. Back / tap outside → the calendar. X closes.
 */

const MOBILE_Q = "(max-width: 767px)";
const REFRESH_MS = 30_000;

function useIsPhone(): boolean {
  const [m, setM] = useState(() => window.matchMedia(MOBILE_Q).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_Q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export function useNow(ms = REFRESH_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function useView(week: number, rev: number): { view: ScheduleView | null; error: string | null; reload: () => void } {
  const [view, setView] = useState<ScheduleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    fetch(`${SCHEDULE_URL}?week=${week}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Signed out." : `HTTP ${r.status}`);
        return (await r.json()) as ScheduleView;
      })
      .then((v) => {
        if (mine !== seq.current) return;
        setView({ ...v, _fetchedAt: Date.now() } as ScheduleView);
        setError(null);
        scheduleUi.setUnread(v.unread);
      })
      .catch((e: unknown) => mine === seq.current && setError(e instanceof Error ? e.message : "Can't reach the gateway."));
  }, [week]);
  useEffect(reload, [reload, rev]);
  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === "visible" && reload(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [reload]);
  return { view, error, reload };
}

const kindColor = (v: { kinds: ScheduleView["kinds"] }, kind: string) => v.kinds[kind]?.color ?? "#7a776f";
const range = (b: BlockOut, zone: string) => `${b.approx ? "~" : ""}${clock(b.start, zone)} – ${clock(b.end, zone)}`;
const STATUS_WORD: Record<BlockOut["status"], string> = { now: "Now", next: "Next", past: "Done", later: "Later" };

// ── small pieces ──────────────────────────────────────────────────────

function Lines({ lines, now, empty }: { lines: BriefLine[]; now: number; empty?: string }) {
  if (!lines.length) return empty ? <p className="sc-quiet">{empty}</p> : null;
  return (
    <ul className="sc-lines">
      {lines.map((l) => (
        <li key={l.id} className="sc-line">
          <span className="sc-line-text">{l.text}</span>
          <span className="sc-line-meta">
            {l.who} · {ago(l.at, now)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AttentionList({ rows, now, onOpen }: { rows: AttentionRow[]; now: number; onOpen: (r: AttentionRow) => void }) {
  return (
    <ul className="sc-attn">
      {rows.map((a) => (
        <li key={a.id}>
          <button className={`sc-attn-row${a.unread ? " unread" : ""}${a.urgent ? " urgent" : ""}`} onClick={() => onOpen(a)}>
            <span className="sc-dot" aria-label={a.unread ? "new" : "seen"} />
            <span className="sc-attn-text">{a.text}</span>
            <span className="sc-line-meta">{ago(a.at, now)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function WorkList({ rows, now }: { rows: WorkRow[]; now: number }) {
  return (
    <ul className="sc-work">
      {rows.map((w) => (
        <li key={w.build} className={`sc-work-row${w.for ? ` for-${w.for}` : ""}`}>
          <div className="sc-work-top">
            <span className="sc-work-agent">{w.agent}</span>
            <span className="sc-chip">{w.for === "now" ? "This block" : w.for === "next" ? "Next block" : w.tagLabel}</span>
            <span className="sc-line-meta">{ago(w.at, now)}</span>
          </div>
          <div className="sc-work-title">{w.title}</div>
          <div className="sc-work-now">{w.now}</div>
        </li>
      ))}
    </ul>
  );
}

export function Decisions({ rows, now }: { rows: DecisionRow[]; now: number }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const send = async (id: string) => {
    setBusy(true);
    const r = await scheduleUi.overrule(id, note.trim() || null);
    setBusy(false);
    setMsg((m) => ({ ...m, [id]: r.ok ? (r.woke ? "Overruled. Michael has it." : "Overruled. Michael hasn't got it yet; it retries on its own.") : `Didn't go through: ${r.error}` }));
    if (r.ok) {
      setAsking(null);
      setNote("");
    }
  };
  return (
    <ul className="sc-decisions">
      {rows.map((d) => (
        <li key={d.id} className={`sc-decision${d.overruled ? " overruled" : ""}`}>
          <div className="sc-work-top">
            <span className="sc-chip">{d.tagLabel}</span>
            <span className="sc-line-meta">{ago(d.at, now)}</span>
          </div>
          <div className="sc-decision-text">{d.decision}</div>
          {d.why && <div className="sc-work-now">Why: {d.why}</div>}
          {d.overruled ? (
            <>
              <div className="sc-overruled">Overruled{d.overruled.note ? `: ${d.overruled.note}` : ""}</div>
              {!d.overruled.delivered && (
                <div className="sc-undelivered">
                  <span className="sc-quiet">Michael hasn't got this yet. It retries on its own.</span>
                  <button className="sc-btn-ghost" onClick={() => void send(d.id)} disabled={busy}>
                    {busy ? "Sending…" : "Retry now"}
                  </button>
                </div>
              )}
            </>
          ) : asking === d.id ? (
            <div className="sc-overrule-form">
              <input className="sc-input" placeholder="What should happen instead? (optional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
              <div className="sc-row-actions">
                <button className="sc-btn-ghost" onClick={() => setAsking(null)} disabled={busy}>
                  Keep it
                </button>
                <button className="sc-btn-warn" onClick={() => void send(d.id)} disabled={busy}>
                  {busy ? "Sending…" : "Overrule"}
                </button>
              </div>
            </div>
          ) : (
            <button className="sc-btn-ghost sc-overrule" onClick={() => (setAsking(d.id), setNote(""))}>
              Overrule
            </button>
          )}
          {msg[d.id] && <div className="sc-quiet">{msg[d.id]}</div>}
        </li>
      ))}
    </ul>
  );
}

// ── the now card ──────────────────────────────────────────────────────

function NowCard({ view, now, onOpen, onLane }: { view: ScheduleView; now: number; onOpen: (id: string) => void; onLane: () => void }) {
  const cur = view.current ? view.blocks[view.current.block] : null;
  const next = view.next ? view.blocks[view.next] : null;
  const working = view.background.work.length;
  if (!cur) {
    return (
      <section className="sc-now idle">
        <div className="sc-kicker">Now</div>
        <div className="sc-now-title">Nothing scheduled</div>
        {next && (
          <button className="sc-now-next" onClick={() => onOpen(next.id)}>
            Next: {next.title} · {WEEKDAY[new Date(`${next.date}T12:00:00Z`).getUTCDay()]} {clock(next.start, view.zone)}
          </button>
        )}
        {working > 0 && (
          <button className="sc-link" onClick={onLane}>
            {working} running in the background
          </button>
        )}
      </section>
    );
  }
  const total = Date.parse(cur.end) - Date.parse(cur.start);
  const pct = Math.max(0, Math.min(100, ((now - Date.parse(cur.start)) / total) * 100));
  return (
    <section className="sc-now" style={{ ["--sc-kind" as string]: kindColor(view, cur.kind) }}>
      <button className="sc-now-head" onClick={() => onOpen(cur.id)}>
        <div className="sc-kicker">
          Now · {range(cur, view.zone)} · ends {until(cur.end, now)}
        </div>
        <div className="sc-now-title">{cur.title}</div>
        <div className="sc-progress" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
      </button>
      {cur.sacred ? <p className="sc-quiet">{cur.detail}</p> : <Lines lines={view.current!.lines} now={now} empty={cur.tags.length ? "Nothing has come in for this block yet." : undefined} />}
      <div className="sc-now-foot">
        {next && (
          <button className="sc-now-next" onClick={() => onOpen(next.id)}>
            Next: {next.title} at {clock(next.start, view.zone)}
          </button>
        )}
        {working > 0 && (
          <button className="sc-link" onClick={onLane}>
            {working} running in the background
          </button>
        )}
      </div>
    </section>
  );
}

// ── today (agenda with a time rail) ───────────────────────────────────

const PX_PER_MIN_DAY = 0.85;
const MIN_ROW = 52;

function DayAgenda({ view, day, now, onOpen }: { view: ScheduleView; day: DayOut; now: number; onOpen: (id: string) => void }) {
  if (!day.segments.length) return <p className="sc-quiet">Nothing on the calendar this day.</p>;
  return (
    <ol className="sc-agenda">
      {day.segments.map((s) => {
        const b = view.blocks[s.id];
        if (!b) return null;
        const h = Math.max(MIN_ROW, Math.round((s.endMin - s.startMin) * PX_PER_MIN_DAY));
        const isNow = b.status === "now";
        const nowPct = isNow ? Math.max(0, Math.min(100, ((now - Date.parse(b.start)) / (Date.parse(b.end) - Date.parse(b.start))) * 100)) : 0;
        return (
          <li key={`${day.date}-${s.id}`} className="sc-agenda-row">
            <span className="sc-agenda-time">{s.continued ? "" : `${b.approx ? "~" : ""}${clock(b.start, view.zone)}`}</span>
            <button
              className={`sc-block ${b.status}${b.sacred ? " sacred" : ""}`}
              style={{ minHeight: h, ["--sc-kind" as string]: kindColor(view, b.kind) }}
              onClick={() => onOpen(b.id)}
              aria-label={`${b.title}, ${range(b, view.zone)}${isNow ? ", now" : ""}${b.unread ? `, ${b.unread} new` : ""}`}
            >
              <span className="sc-block-title">{b.title}</span>
              <span className="sc-block-meta">
                {range(b, view.zone)}
                {isNow && <em> · now</em>}
                {b.clipped && !b.sacred && " · cut short for Shabbat"}
              </span>
              {b.unread > 0 && <span className="sc-block-badge">{b.unread > 9 ? "9+" : b.unread}</span>}
              {isNow && <span className="sc-nowline" style={{ top: `${nowPct}%` }} aria-hidden="true" />}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ── week (true time grid) ─────────────────────────────────────────────

const GRID_FROM = 6 * 60 + 30;
const GRID_TO = 23 * 60;
const PX_PER_MIN_WEEK = 0.95;

function WeekGrid({ view, now, onOpen, onDay }: { view: ScheduleView; now: number; onOpen: (id: string) => void; onDay: (date: string) => void }) {
  const hours: number[] = [];
  for (let h = 7; h <= 22; h++) hours.push(h);
  const y = (min: number) => (Math.max(GRID_FROM, Math.min(GRID_TO, min)) - GRID_FROM) * PX_PER_MIN_WEEK;
  const height = y(GRID_TO);
  const nowParts = new Intl.DateTimeFormat("en-US", { timeZone: view.zone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(now));
  const nowMin = Number(nowParts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(nowParts.find((p) => p.type === "minute")?.value ?? 0);
  return (
    <div className="sc-week">
      <div className="sc-week-head">
        <span />
        {view.days.map((d) => (
          <button key={d.date} className={`sc-week-day${d.isToday ? " today" : ""}`} onClick={() => onDay(d.date)}>
            <span>{WEEKDAY[d.weekday]}</span>
            <span className="sc-week-date">{dayLabel(d.date).split(" ")[1]}</span>
          </button>
        ))}
      </div>
      <div className="sc-week-body" style={{ height }}>
        <div className="sc-week-rail">
          {hours.map((h) => (
            <span key={h} style={{ top: y(h * 60) }}>
              {h % 12 || 12}
              {h < 12 ? "a" : "p"}
            </span>
          ))}
        </div>
        {view.days.map((d) => (
          <div key={d.date} className={`sc-week-col${d.isToday ? " today" : ""}`}>
            {hours.map((h) => (
              <span key={h} className="sc-hourline" style={{ top: y(h * 60) }} />
            ))}
            {d.segments.map((s) => {
              const b = view.blocks[s.id];
              if (!b || s.endMin <= GRID_FROM || s.startMin >= GRID_TO) return null;
              const top = y(s.startMin);
              const h = Math.max(14, y(s.endMin) - top - 2);
              return (
                <button
                  key={s.id}
                  className={`sc-wblock ${b.status}${b.sacred ? " sacred" : ""}${h < 30 ? " tiny" : ""}`}
                  style={{ top, height: h, ["--sc-kind" as string]: kindColor(view, b.kind) }}
                  onClick={() => onOpen(b.id)}
                  title={`${b.title} · ${range(b, view.zone)}`}
                  aria-label={`${WEEKDAY_LONG[d.weekday]} ${b.title}, ${range(b, view.zone)}`}
                >
                  <span className="sc-wblock-title">
                    <span className="sc-long">{b.title}</span>
                    <span className="sc-short">{b.short ?? b.title}</span>
                  </span>
                  {b.unread > 0 && <span className="sc-wdot" />}
                </button>
              );
            })}
            {d.isToday && nowMin > GRID_FROM && nowMin < GRID_TO && <span className="sc-week-now" style={{ top: y(nowMin) }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── the briefing ──────────────────────────────────────────────────────

export function BriefingView({ id, zone, kinds, now, rev }: { id: string; zone: string; kinds: ScheduleView["kinds"]; now: number; rev: number }) {
  const [b, setB] = useState<Briefing | null>(null);
  const [missing, setMissing] = useState(false);
  // Read marks for what this briefing shows: recorded only once the gateway says yes (a failed write is
  // resent on the next poll), never double-sent while in flight. An item that arrives while open is marked on sight.
  const marker = useRef(createReadMarker((ids) => scheduleUi.markRead(ids)));
  useEffect(() => {
    marker.current = createReadMarker((ids) => scheduleUi.markRead(ids));
    setB(null);
    setMissing(false);
  }, [id]);
  useEffect(
    () =>
      startBriefingPoll(id, {
        fetch: fetchBriefing,
        onData: (r) => {
          if (!r) return setMissing(true);
          setMissing(false);
          setB(r);
          // Seeing a block's briefing = seeing its items: mark the unread ones read.
          void marker.current.see(r.attention.filter((a) => a.unread).map((a) => a.id));
        },
        intervalMs: REFRESH_MS,
        visible: () => document.visibilityState === "visible",
        setInterval: (f, ms) => window.setInterval(f, ms),
        clearInterval: (h) => window.clearInterval(h as number),
      }),
    [id, rev],
  );
  if (missing) return <p className="sc-quiet sc-pad">That block isn't on the calendar any more.</p>;
  if (!b) return <div className="sc-skeleton sc-pad" />;
  const blk = b.block;
  return (
    <div className="sc-briefing" style={{ ["--sc-kind" as string]: kinds[blk.kind]?.color ?? "#7a776f" }}>
      <header className="sc-brief-head">
        <div className="sc-kicker">
          {STATUS_WORD[blk.status]} · {WEEKDAY_LONG[new Date(`${blk.date}T12:00:00Z`).getUTCDay()]} {dayLabel(blk.date)}
        </div>
        <h2 className="sc-brief-title">{blk.title}</h2>
        <div className="sc-brief-time">
          {range(blk, zone)}
          {blk.status === "now" && ` · ends ${until(blk.end, now)}`}
          {blk.status === "next" && ` · starts ${until(blk.start, now)}`}
        </div>
      </header>
      {b.attention.length > 0 && (
        <section className="sc-section">
          <h3 className="sc-h3">Needs you</h3>
          <ul className="sc-attn">
            {b.attention.map((a) => (
              <li key={a.id} className={`sc-attn-row static${a.urgent ? " urgent" : ""}`}>
                <span className="sc-dot seen" />
                <span className="sc-attn-text">{a.text}</span>
                <span className="sc-line-meta">{ago(a.at, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {b.lines.length > 0 && (
        <section className="sc-section">
          <h3 className="sc-h3">{blk.status === "now" ? "Live" : "What happened"}</h3>
          <Lines lines={b.lines} now={now} />
        </section>
      )}
      {b.prepping.length > 0 && (
        <section className="sc-section">
          <h3 className="sc-h3">{blk.status === "now" ? "Working on it" : "Being prepped"}</h3>
          <WorkList rows={b.prepping} now={now} />
        </section>
      )}
      {b.decisions.length > 0 && (
        <section className="sc-section">
          <h3 className="sc-h3">Michael's calls</h3>
          <Decisions rows={b.decisions} now={now} />
        </section>
      )}
      {b.quiet && <p className="sc-quiet">{b.quiet}</p>}
    </div>
  );
}

// ── the window ────────────────────────────────────────────────────────

export function ScheduleWindow() {
  const { block, rev, unread } = useScheduleUi();
  const phone = useIsPhone();
  const tick = useNow();
  const [mode, setMode] = useState<"day" | "week">(() => (window.matchMedia(MOBILE_Q).matches ? "day" : "week"));
  const [week, setWeek] = useState(0);
  const [day, setDay] = useState<string | null>(null);
  const { view, error, reload } = useView(week, rev);
  // The gateway's clock, not the phone's: a skewed phone must not say "ends in 18 h".
  const skew = useMemo(() => (view ? Date.parse(view.now) - (view as ScheduleView & { _fetchedAt?: number })._fetchedAt! : 0), [view]);
  const now = tick + (Number.isFinite(skew) ? skew : 0);
  const [clearErr, setClearErr] = useState<string | null>(null);
  // Read on this screen, ahead of the refetch — the list and the badge change in the same tick.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const bodyRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const back = useCallback(() => scheduleUi.showBlock(null), []);
  const openBlock = useCallback((id: string) => scheduleUi.showBlock(id), []);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (block) back();
      else scheduleUi.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [block, back]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [block]);

  const shownDay = useMemo(() => {
    if (!view) return null;
    return view.days.find((d) => d.date === day) ?? view.days.find((d) => d.isToday) ?? view.days[0];
  }, [view, day]);

  const attention = useMemo(() => (view ? view.attention.map((a) => (a.unread && seen.has(a.id) ? { ...a, unread: false } : a)) : []), [view, seen]);
  const openItem = (a: AttentionRow) => {
    if (a.unread) {
      setSeen((s) => new Set(s).add(a.id));
      void scheduleUi.markRead([a.id]);
    }
    if (a.block) openBlock(a.block);
  };
  const clearAll = async () => {
    setClearErr(null);
    const before = seen;
    setSeen(new Set([...seen, ...attention.map((a) => a.id)]));
    const r = await scheduleUi.clearAll();
    if (!r.ok) {
      setSeen(before);
      setClearErr(`Didn't clear: ${r.error}`);
    }
  };

  const inBriefing = !!block && !!view;
  const title = inBriefing ? "Calendar" : view?.title ?? "Schedule";

  return (
    <div className={`sc-scrim${phone ? " phone" : ""}`} onClick={(e) => e.target === e.currentTarget && (block ? back() : scheduleUi.close())}>
      <div className="sc-window" role="dialog" aria-modal="true" aria-label="Schedule">
        <header className="sc-head">
          {inBriefing ? (
            <button className="sc-headbtn sc-back" onClick={back} aria-label="Back to the calendar">
              <IconBack />
              <span>{title}</span>
            </button>
          ) : (
            <div className="sc-head-title">
              <span className="sc-title">{title}</span>
              {view && <span className="sc-sub">{mode === "day" && shownDay ? `${WEEKDAY_LONG[shownDay.weekday]}, ${dayLabel(shownDay.date)}` : `Week of ${dayLabel(view.weekStart)}`}</span>}
            </div>
          )}
          {!inBriefing && (
            <div className="sc-seg" role="tablist" aria-label="View">
              <button role="tab" aria-selected={mode === "day"} className={mode === "day" ? "on" : ""} onClick={() => setMode("day")}>
                Today
              </button>
              <button role="tab" aria-selected={mode === "week"} className={mode === "week" ? "on" : ""} onClick={() => setMode("week")}>
                Week
              </button>
            </div>
          )}
          <button ref={closeRef} className="sc-headbtn sc-x" onClick={() => scheduleUi.close()} aria-label="Close the schedule">
            <IconClose />
          </button>
        </header>

        <div className="sc-body" ref={bodyRef}>
          {!view ? (
            error ? (
              <div className="sc-pad">
                <p className="sc-quiet">{error}</p>
                <button className="sc-btn-ghost" onClick={reload}>
                  Try again
                </button>
              </div>
            ) : (
              <div className="sc-skeleton sc-pad" />
            )
          ) : inBriefing ? (
            <BriefingView id={block!} zone={view.zone} kinds={view.kinds} now={now} rev={rev} />
          ) : (
            <div className={`sc-layout ${mode}`}>
              {error && <p className="sc-stale">Showing the last good copy — {error}</p>}
              {view.error && <p className="sc-stale">The week file has a problem, so the last good copy is showing: {view.error}</p>}
              <div className="sc-main">
                <NowCard view={view} now={now} onOpen={openBlock} onLane={() => laneRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />

                {attention.length > 0 && (
                  <section className="sc-section sc-needs">
                    <div className="sc-section-head">
                      <h3 className="sc-h3">
                        Needs you{unread > 0 && <span className="sc-count">{unread > 9 ? "9+" : unread} new</span>}
                      </h3>
                      <button className="sc-btn-ghost sc-clear" onClick={() => void clearAll()} disabled={unread === 0}>
                        Clear all
                      </button>
                    </div>
                    <AttentionList rows={attention} now={now} onOpen={openItem} />
                    {clearErr && <p className="sc-quiet">{clearErr}</p>}
                  </section>
                )}

                {mode === "day" && shownDay ? (
                  <section className="sc-section">
                    <div className="sc-daypick" role="tablist" aria-label="Day">
                      {view.days.map((d) => (
                        <button key={d.date} role="tab" aria-selected={d.date === shownDay.date} className={`${d.date === shownDay.date ? "on" : ""}${d.isToday ? " today" : ""}`} onClick={() => setDay(d.date)}>
                          <span>{WEEKDAY[d.weekday] === "Shabbat" ? "Shab" : WEEKDAY[d.weekday]}</span>
                          <span className="sc-daypick-n">{dayLabel(d.date).split(" ")[1]}</span>
                        </button>
                      ))}
                    </div>
                    <DayAgenda view={view} day={shownDay} now={now} onOpen={openBlock} />
                  </section>
                ) : (
                  <section className="sc-section">
                    <div className="sc-weeknav">
                      <button className="sc-btn-ghost" onClick={() => setWeek((w) => w - 1)} aria-label="Previous week">
                        ‹
                      </button>
                      <button className="sc-btn-ghost" onClick={() => setWeek(0)} disabled={week === 0}>
                        This week
                      </button>
                      <button className="sc-btn-ghost" onClick={() => setWeek((w) => w + 1)} aria-label="Next week">
                        ›
                      </button>
                    </div>
                    <WeekGrid view={view} now={now} onOpen={openBlock} onDay={(d) => (setDay(d), setMode("day"))} />
                  </section>
                )}
              </div>

              <aside className="sc-lane" ref={laneRef}>
                <section className="sc-section">
                  <h3 className="sc-h3">In the background</h3>
                  {view.background.work.length ? <WorkList rows={view.background.work} now={now} /> : <p className="sc-quiet">No agent work running right now.</p>}
                </section>
                {view.background.decisions.length > 0 && (
                  <section className="sc-section">
                    <h3 className="sc-h3">Michael's own calls</h3>
                    <Decisions rows={view.background.decisions} now={now} />
                  </section>
                )}
                {view.note && <p className="sc-quiet sc-note">{view.note}</p>}
              </aside>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mount once at the app root: renders the window while it is open. */
export default function ScheduleHost() {
  // The redesign shows the calendar as a page inside the canvas (redesign/CalendarPage, FINAL);
  // the modal window stays exported for reuse but is no longer mounted here.
  return null;
}
