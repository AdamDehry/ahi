/**
 * Today (slice 4, FINAL) on the existing schedule service (/app/schedule):
 * your focus right now (the current block and its briefing), a moment of
 * your attention (questions, review items, decisions), the rest of your day,
 * a note from the lead agent (the latest decision) and what is quietly
 * moving. Opening the calendar, a block's briefing, decisions and overrule
 * all use the existing calendar window (scheduleUi) — one implementation.
 */
import { useEffect, useState } from "react";
import { actions, useAppState } from "../store";
import { SCHEDULE_URL, clock, dayLabel, scheduleUi, useScheduleUi, type AttentionRow, type ScheduleView } from "../lib/schedule";
import { BOT_LABELS } from "../lib/types";
import { Icon } from "./icons";
import { AgentAvatar } from "./AgentRail";
import { goPage } from "./Shell";

function useSchedule() {
  const [view, setView] = useState<ScheduleView | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const { rev } = useScheduleUi();
  const { buildsRev, reviewRev } = useAppState();
  useEffect(() => {
    let live = true;
    fetch(SCHEDULE_URL, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ScheduleView>) : Promise.reject(new Error(String(r.status)))))
      .then((v) => live && (setView(v), setFailed(false)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [rev, buildsRev, reviewRev, retry]);
  return { view, failed, again: () => setRetry((n) => n + 1) };
}

function attentionAction(a: AttentionRow): { label: string; go: () => void } {
  if (a.kind === "review") return { label: "Review", go: () => actions.openReview() };
  if (a.kind === "question") {
    const bot = BOT_LABELS[a.who] ? a.who : "michael";
    return { label: "Answer in thread", go: () => actions.answerInThread(bot, a.text) };
  }
  return { label: "See it", go: () => scheduleUi.open(a.block) };
}

function dayTitle(view: ScheduleView): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: view.zone }).format(new Date(view.now)).toUpperCase();
}

export default function Today() {
  const s = useAppState();
  const admin = !!s.user?.admin;
  const { view, failed, again } = useSchedule();
  const blocks = view ? Object.values(view.blocks).filter((b) => b.date === view.today).sort((a, b) => a.start.localeCompare(b.start)) : [];
  const current = view?.current ? view.blocks[view.current.block] : null;
  // The schedule's day runs past midnight; when today's remaining blocks are done, show the next day's.
  const upcoming = view ? Object.values(view.blocks).filter((b) => b.status === "next" || b.status === "later").sort((a, b) => a.start.localeCompare(b.start)) : [];
  const todayRest = blocks.filter((b) => b.status === "next" || b.status === "later");
  const restDate = todayRest.length ? view?.today ?? null : upcoming[0]?.date ?? null;
  const rest = todayRest.length ? todayRest : upcoming.filter((b) => b.date === restDate);
  const restLabel = todayRest.length || !restDate ? "The rest of your day" : `Next up · ${dayLabel(restDate)}`;
  const note = view?.background.decisions[0] ?? null;

  return (
    <div className="rd-page rd-page-scroll rd-today" data-page="today">
      <div className="rd-page-top">
        <header className="rd-page-head">
          <div>
            <div className="rd-eyebrow">{view ? dayTitle(view) : "TODAY"}</div>
            <h1 className="rd-title">A little clarity for your day.</h1>
            <p className="rd-sub">Your time, your next decisions, and the work moving around you.</p>
          </div>
          <div className="rd-page-actions">
            <button type="button" className="rd-btn" onClick={() => scheduleUi.open()}>
              Open calendar
            </button>
          </div>
        </header>
      </div>
      {failed && !view && (
        <div className="rd-inline-error" role="alert">
          Couldn’t load your day. <button type="button" onClick={again}>Try again</button>
        </div>
      )}
      {view?.error && <div className="rd-inline-note">Your week file has a problem, so the last good copy is showing: {view.error}</div>}
      {view && (
        <div className="rd-today-grid">
          <div className="rd-today-main">
            <article className="rd-card rd-focus">
              <div className="rd-card-top">
                <span className="rd-eyebrow">YOUR FOCUS, RIGHT NOW</span>
                {current && <span className="rd-pill">UNTIL {clock(current.end, view.zone)}</span>}
              </div>
              {current ? (
                <>
                  <h2>{current.title}.</h2>
                  {current.detail && <p>{current.detail}</p>}
                  {view.current?.lines.slice(0, 2).map((l) => (
                    <p key={l.id} className="rd-focus-line">{l.text}</p>
                  ))}
                  <div className="rd-focus-foot">
                    <button type="button" className="rd-btn rd-btn-accent" onClick={() => scheduleUi.open(current.id)}>
                      Open your briefing <Icon name="arrow-right" />
                    </button>
                    <span className="rd-quiet">{BOT_LABELS.michael} is keeping the rest moving.</span>
                  </div>
                </>
              ) : (
                <>
                  <h2>Nothing scheduled right now.</h2>
                  <p>{view.next ? `Next: ${view.blocks[view.next]?.title} at ${clock(view.blocks[view.next]!.start, view.zone)}.` : "The rest of the day is open."}</p>
                </>
              )}
            </article>

            <section className="rd-attention">
              <div className="rd-section-head">
                <h2>A moment of your attention</h2>
                <span className="rd-pill">{view.attention.length} {view.attention.length === 1 ? "thing" : "things"}</span>
              </div>
              {view.attention.length ? (
                <ul className="rd-list-card">
                  {view.attention.slice(0, 6).map((a) => {
                    const act = attentionAction(a);
                    return (
                      <li key={a.id} className={a.urgent ? "urgent" : ""}>
                        <Icon name={a.kind === "review" ? "shield" : a.kind === "question" ? "spark" : "messages"} />
                        <span>
                          {a.text}
                          <small>{BOT_LABELS[a.who] ?? a.who}</small>
                        </span>
                        <button type="button" className="rd-btn" onClick={act.go}>
                          {act.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="rd-quiet rd-empty-line">Nothing needs you right now.</p>
              )}
            </section>

            <section className="rd-moving-quiet">
              <div className="rd-section-head">
                <h2>Quietly moving for you</h2>
                {admin && (
                  <button type="button" onClick={() => goPage("work")}>
                    Your work <Icon name="arrow-right" />
                  </button>
                )}
              </div>
              {view.background.work.length ? (
                <ul className="rd-list-card">
                  {view.background.work.slice(0, 5).map((w) => (
                    <li key={w.build}>
                      <AgentAvatar bot={BOT_LABELS[w.agent] ? w.agent : "michael"} size="sm" />
                      <span>
                        {w.title}
                        <small>{w.now}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rd-quiet rd-empty-line">Nothing running in the background.</p>
              )}
            </section>
          </div>

          <aside className="rd-today-side">
            <article className="rd-card rd-rest">
              <div className="rd-card-top">
                <h3>{restLabel}</h3>
                <button type="button" className="rd-chat-control" aria-label="Open calendar" onClick={() => scheduleUi.open()}>
                  <Icon name="calendar" />
                </button>
              </div>
              {rest.length ? (
                <ul>
                  {rest.map((b) => (
                    <li key={b.id}>
                      <button type="button" onClick={() => scheduleUi.open(b.id)}>
                        <span className="rd-time">
                          {clock(b.start, view.zone).replace(/\s*(AM|PM)$/i, "").replace(/^(\d{1,2})$/, "$1:00")}
                          <small>{/(AM|PM)$/i.exec(clock(b.start, view.zone))?.[1] ?? ""}</small>
                        </span>
                        <span className="rd-block">
                          {b.title}
                          {b.detail && <small>{b.detail}</small>}
                          {b.sacred && <small>Protected</small>}
                        </span>
                        <Icon name="chevron-right" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rd-quiet">That’s the day.</p>
              )}
              <div className="rd-card-foot rd-quiet">Protected time stays protected.</div>
            </article>
            {note && (
              <div className="rd-note">
                <div className="rd-eyebrow">A NOTE FROM {(BOT_LABELS.michael ?? "Michael").toUpperCase()}</div>
                <p>{note.decision}</p>
                <button type="button" className="rd-link-action" onClick={() => scheduleUi.open()}>
                  See my decisions ↗
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
