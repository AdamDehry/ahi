/**
 * Calendar — the FINAL page (world.js renderCalendar) one for one, on the real schedule service.
 *
 * Opened by the top-bar calendar (and "Open calendar"), it lies over the current page like Settings,
 * so a call or a recording underneath survives. Week strip, Day / Week, ‹ This week ›, the day as a
 * time grid or the week as columns, and the side: NOW (Open briefing), Needs you (Clear all, read
 * marks on the server), Behind the scenes (what the team is doing, Michael's decisions with Overrule).
 * A block opens its briefing in place. Everything comes from /app/schedule; nothing is sample data.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { clock, dayLabel, scheduleUi, useScheduleUi, WEEKDAY, WEEKDAY_LONG, type AttentionRow, type BlockOut, type ScheduleView } from "../lib/schedule";
import { AttentionList, BriefingView, Decisions, WorkList, useNow, useView } from "../components/schedule/ScheduleModal";
import { Icon } from "./icons";
import "./calendar-final.css";

const HOUR = 66;
const range = (b: BlockOut, zone: string) => `${b.approx ? "~" : ""}${clock(b.start, zone)} – ${clock(b.end, zone)}`;
const kindColor = (v: ScheduleView, kind: string) => v.kinds[kind]?.color ?? "#7a776f";
const longDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });

export default function CalendarPage({ phone = false }: { phone?: boolean }) {
  const { block, rev, unread } = useScheduleUi();
  const tick = useNow();
  const [mode, setMode] = useState<"day" | "week">(phone ? "day" : "day");
  const [week, setWeek] = useState(0);
  const [day, setDay] = useState<string | null>(null);
  const [showDecisions, setShowDecisions] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const [clearErr, setClearErr] = useState<string | null>(null);
  const { view, error, reload } = useView(week, rev);
  const skew = useMemo(() => (view ? Date.parse(view.now) - (view as ScheduleView & { _fetchedAt?: number })._fetchedAt! : 0), [view]);
  const now = tick + (Number.isFinite(skew) ? skew : 0);
  const back = useCallback(() => scheduleUi.showBlock(null), []);
  const openBlock = useCallback((id: string) => scheduleUi.showBlock(id), []);

  useEffect(() => {
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
    document.querySelector(".rd-cal")?.scrollTo({ top: 0 });
  }, [block]);

  const shown = useMemo(() => (view ? view.days.find((d) => d.date === day) ?? view.days.find((d) => d.isToday) ?? view.days[0] : null), [view, day]);
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
      setClearErr(`Didn’t clear: ${r.error}`);
    }
  };

  const current = view?.current ? view.blocks[view.current.block] : null;
  const next = view?.next ? view.blocks[view.next] : null;

  const head = (
    <header className="rd-page-head rd-cal-head">
      <div>
        <div className="rd-eyebrow">YOUR TIME, WITH ROOM TO BREATHE</div>
        <h1 className="rd-title">{shown ? longDate(shown.date) : "Your calendar"}</h1>
        <p className="rd-sub">A considered rhythm for work, life, and the space between.</p>
      </div>
      <div className="rd-cal-actions">
        <div className="calendar-step">
          <button type="button" className="world-button" aria-label="Previous week" onClick={() => (setWeek((w) => w - 1), setDay(null))}>
            ‹
          </button>
          <button type="button" className="world-button" onClick={() => (setWeek(0), setDay(null))} disabled={week === 0}>
            This week
          </button>
          <button type="button" className="world-button" aria-label="Next week" onClick={() => (setWeek((w) => w + 1), setDay(null))}>
            ›
          </button>
        </div>
        <div className="segmented sc-seg" role="tablist" aria-label="Calendar view">
          {(["day", "week"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
              {m === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
        <button type="button" className="rd-chat-control" aria-label="Close the schedule" onClick={() => scheduleUi.close()}>
          <Icon name="x" />
        </button>
      </div>
    </header>
  );

  if (!view)
    return (
      <div className="rd-page rd-cal" data-page="calendar">
        {head}
        <p className="rd-quiet">
          {error ? `The calendar didn’t load (${error}).` : "Opening your week…"}{" "}
          {error && (
            <button type="button" className="world-button" onClick={reload}>
              Try again
            </button>
          )}
        </p>
      </div>
    );

  return (
    <div className="rd-page rd-cal" data-page="calendar">
      {head}
      {view.error && <p className="rd-quiet rd-cal-note">{view.error}</p>}
      <div className="week-strip" role="tablist" aria-label="Day">
        {view.days.map((d) => (
          <button key={d.date} type="button" role="tab" aria-selected={shown?.date === d.date} className={shown?.date === d.date ? "selected" : ""} onClick={() => (setDay(d.date), setMode("day"), back())}>
            <span>{WEEKDAY[d.weekday]}</span>
            <strong>{Number(d.date.slice(8))}</strong>
            {d.isToday && <i />}
          </button>
        ))}
      </div>
      <div className="calendar-layout">
        <section className={`calendar-canvas${mode === "week" && !block ? " week-mode" : ""}`} aria-label={block ? "Briefing" : mode === "week" ? "Week schedule" : "Day schedule"}>
          {block ? (
            <>
              <button type="button" className="world-button rd-cal-back" onClick={back} aria-label="Back to the calendar">
                <Icon name="arrow-left" /> Back to the calendar
              </button>
              <BriefingView id={block} zone={view.zone} kinds={view.kinds} now={now} rev={rev} />
            </>
          ) : mode === "day" && shown ? (
            shown.segments.length ? (
              (() => {
                const segs = shown.segments;
                const startH = Math.max(0, Math.floor(Math.min(...segs.map((s) => s.startMin)) / 60));
                const endH = Math.min(24, Math.ceil(Math.max(...segs.map((s) => s.endMin)) / 60));
                const hours = Array.from({ length: Math.max(1, endH - startH) }, (_, i) => startH + i);
                return (
                  <div className="time-grid" style={{ height: hours.length * HOUR }}>
                    {hours.map((h) => (
                      <div key={h} className="hour-row">
                        <time>{`${h % 12 || 12} ${h < 12 || h === 24 ? "AM" : "PM"}`}</time>
                        <span />
                      </div>
                    ))}
                    <div className="calendar-events">
                      {segs.map((s) => {
                        const b = view.blocks[s.id];
                        if (!b) return null;
                        const top = ((s.startMin - startH * 60) / 60) * HOUR;
                        const height = Math.max(((s.endMin - s.startMin) / 60) * HOUR - 3, 15);
                        return (
                          <button
                            key={`${shown.date}-${s.id}`}
                            type="button"
                            className={`calendar-event${b.sacred ? " protected" : ""}${b.status === "now" ? " now" : ""}${height < 60 ? " short" : ""}${height < 28 ? " tiny" : ""}`}
                            style={{ top, height, ["--ev" as string]: kindColor(view, b.kind) }}
                            onClick={() => openBlock(b.id)}
                            aria-label={`${b.title}, ${range(b, view.zone)}${b.status === "now" ? ", now" : ""}${b.unread ? `, ${b.unread} new` : ""}`}
                          >
                            <strong>{b.title}</strong>
                            <span>
                              {range(b, view.zone)}
                              {b.sacred ? " · Protected" : b.status === "now" ? " · Now" : ""}
                            </span>
                            {b.detail && height >= 110 && <small>{b.detail}</small>}
                            {b.unread > 0 && <em className="rd-cal-badge">{b.unread > 9 ? "9+" : b.unread}</em>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="shabbat-block">
                <Icon name="calendar" />
                <h2>An open day.</h2>
                <p>Nothing on the calendar {dayLabel(shown.date).toLowerCase()}. Keep it that way.</p>
              </div>
            )
          ) : (
            <div className="week-calendar">
              {view.days.map((d) => (
                <div key={d.date} className={`week-column${d.isToday ? " today" : ""}`}>
                  <button type="button" className="week-column-label" onClick={() => (setDay(d.date), setMode("day"))}>
                    {WEEKDAY[d.weekday]} {Number(d.date.slice(8))}
                  </button>
                  {d.segments.map((s) => {
                    const b = view.blocks[s.id];
                    if (!b) return null;
                    return (
                      <button
                        key={`${d.date}-${s.id}`}
                        type="button"
                        className={`week-event${b.sacred ? " protected" : ""}${b.status === "now" ? " now" : ""}`}
                        style={{ ["--ev" as string]: kindColor(view, b.kind) }}
                        onClick={() => openBlock(b.id)}
                        aria-label={`${WEEKDAY_LONG[d.weekday]} ${b.title}, ${range(b, view.zone)}`}
                      >
                        <span>{s.continued ? "…" : clock(b.start, view.zone)}</span>
                        <strong>{b.short ?? b.title}</strong>
                      </button>
                    );
                  })}
                  {!d.segments.length && <div className="open-time">An open day.</div>}
                </div>
              ))}
            </div>
          )}
        </section>
        <aside className="calendar-side">
          <div className="world-card">
            <span className="rd-eyebrow">{current ? "NOW" : "NEXT"}</span>
            <h2>{current ? current.title : "Nothing scheduled right now."}</h2>
            <p>{current ? `${range(current, view.zone)}. ${current.detail ?? "Your team handles the details."}` : next ? `Next: ${next.title} at ${clock(next.start, view.zone)}.` : "The rest of the week is open."}</p>
            {(current ?? next) && (
              <button type="button" className="world-button" onClick={() => openBlock((current ?? next)!.id)}>
                Open briefing
              </button>
            )}
          </div>
          <div className="calendar-side-needs">
          <div className="world-section-title">
            <h2>Needs you</h2>
            <button type="button" className="world-button sc-clear" onClick={() => void clearAll()} disabled={unread === 0}>
              {unread === 0 ? "All seen" : "Clear all"}
            </button>
          </div>
          {attention.length ? <AttentionList rows={attention} now={now} onOpen={openItem} /> : <p className="muted-line">You’re caught up. Items remain in Your work.</p>}
          {clearErr && <p className="muted-line">{clearErr}</p>}
          </div>
          <div className="calendar-side-behind">
          <div className="world-section-title">
            <h2>Behind the scenes</h2>
          </div>
          {view.background.work.length ? <WorkList rows={view.background.work} now={now} /> : <p className="muted-line">No agent work running right now.</p>}
          {view.background.decisions.length > 0 && (
            <>
              <button type="button" className="world-button rd-cal-decisions" aria-expanded={showDecisions} onClick={() => setShowDecisions(!showDecisions)}>
                Michael’s decisions {showDecisions ? "↑" : "↗"}
              </button>
              {showDecisions && <Decisions rows={view.background.decisions} now={now} />}
            </>
          )}
          </div>
        </aside>
      </div>
      <p className="preview-footnote">
        {view.title} · approved {view.approved} · All times {view.zone.replace("America/New_York", "Eastern").replace(/_/g, " ")}
        {view.note ? ` · ${view.note}` : ""}
      </p>
    </div>
  );
}
