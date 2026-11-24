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
import { locale, tn, useT, type Key } from "../i18n";

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

function attentionAction(a: AttentionRow): { label: Key; go: () => void } {
  if (a.kind === "review") return { label: "home.today.reviewAction", go: () => actions.openReview() };
  if (a.kind === "question") {
    const bot = BOT_LABELS[a.who] ? a.who : "michael";
    return { label: "home.today.answerInThread", go: () => actions.answerInThread(bot, a.text) };
  }
  return { label: "home.today.seeIt", go: () => scheduleUi.open(a.block) };
}

function dayTitle(view: ScheduleView): string {
  return new Intl.DateTimeFormat(locale(), { weekday: "long", month: "long", day: "numeric", timeZone: view.zone }).format(new Date(view.now)).toUpperCase();
}

export default function Today() {
  const t = useT();
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
  const restLabel = todayRest.length || !restDate ? t("home.today.restOfDay") : t("home.today.nextUp", { day: dayLabel(restDate) });
  const note = view?.background.decisions[0] ?? null;

  return (
    <div className="rd-page rd-page-scroll rd-today" data-page="today">
      <div className="rd-page-top">
        <header className="rd-page-head">
          <div>
            <div className="rd-eyebrow">{view ? dayTitle(view) : t("shell.page.today.eyebrow")}</div>
            <h1 className="rd-title">{t("shell.page.today.title")}</h1>
            <p className="rd-sub">{t("shell.page.today.sub")}</p>
          </div>
          <div className="rd-page-actions">
            <button type="button" className="rd-btn" onClick={() => scheduleUi.open()}>
              {t("home.today.openCalendar")}
            </button>
          </div>
        </header>
      </div>
      {failed && !view && (
        <div className="rd-inline-error" role="alert">
          {t("home.today.couldntLoad")} <button type="button" onClick={again}>{t("common.tryAgain")}</button>
        </div>
      )}
      {view?.error && <div className="rd-inline-note">{t("home.today.weekFileProblem", { error: view.error })}</div>}
      {view && (
        <div className="rd-today-grid">
          <div className="rd-today-main">
            <article className="rd-card rd-focus">
              <div className="rd-card-top">
                <span className="rd-eyebrow">{t("home.today.focusNow")}</span>
                {current && <span className="rd-pill">{t("home.today.until", { time: clock(current.end, view.zone) })}</span>}
              </div>
              {current ? (
                <>
                  <h2><bdi dir="auto">{current.title}</bdi>.</h2>
                  {current.detail && <p dir="auto">{current.detail}</p>}
                  {view.current?.lines.slice(0, 2).map((l) => (
                    <p key={l.id} className="rd-focus-line" dir="auto">{l.text}</p>
                  ))}
                  <div className="rd-focus-foot">
                    <button type="button" className="rd-btn rd-btn-accent" onClick={() => scheduleUi.open(current.id)}>
                      {t("home.today.openBriefing")} <Icon name="arrow-right" />
                    </button>
                    <span className="rd-quiet">{t("home.today.keepingMoving", { name: BOT_LABELS.michael })}</span>
                  </div>
                </>
              ) : (
                <>
                  <h2>{t("home.today.nothingScheduled")}</h2>
                  <p>{view.next ? t("home.today.nextAt", { title: view.blocks[view.next]?.title ?? "", time: clock(view.blocks[view.next]!.start, view.zone) }) : t("home.today.restOpen")}</p>
                </>
              )}
            </article>

            <section className="rd-attention">
              <div className="rd-section-head">
                <h2>{t("home.today.attentionTitle")}</h2>
                <span className="rd-pill">{tn("home.today.things", view.attention.length)}</span>
              </div>
              {view.attention.length ? (
                <ul className="rd-list-card">
                  {view.attention.slice(0, 6).map((a) => {
                    const act = attentionAction(a);
                    return (
                      <li key={a.id} className={a.urgent ? "urgent" : ""}>
                        <Icon name={a.kind === "review" ? "shield" : a.kind === "question" ? "spark" : "messages"} />
                        <span>
                          <bdi dir="auto">{a.text}</bdi>
                          <small>{BOT_LABELS[a.who] ?? a.who}</small>
                        </span>
                        <button type="button" className="rd-btn" onClick={act.go}>
                          {t(act.label)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="rd-quiet rd-empty-line">{t("shell.bell.nothingNeedsYou")}</p>
              )}
            </section>

            <section className="rd-moving-quiet">
              <div className="rd-section-head">
                <h2>{t("home.today.quietlyMoving")}</h2>
                {admin && (
                  <button type="button" onClick={() => goPage("work")}>
                    {t("shell.nav.work")} <Icon name="arrow-right" />
                  </button>
                )}
              </div>
              {view.background.work.length ? (
                <ul className="rd-list-card">
                  {view.background.work.slice(0, 5).map((w) => (
                    <li key={w.build}>
                      <AgentAvatar bot={BOT_LABELS[w.agent] ? w.agent : "michael"} size="sm" />
                      <span>
                        <bdi dir="auto">{w.title}</bdi>
                        <small dir="auto">{w.now}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rd-quiet rd-empty-line">{t("home.today.nothingBackground")}</p>
              )}
            </section>
          </div>

          <aside className="rd-today-side">
            <article className="rd-card rd-rest">
              <div className="rd-card-top">
                <h3>{restLabel}</h3>
                <button type="button" className="rd-chat-control" aria-label={t("home.today.openCalendar")} onClick={() => scheduleUi.open()}>
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
                          <bdi dir="auto">{b.title}</bdi>
                          {b.detail && <small dir="auto">{b.detail}</small>}
                          {b.sacred && <small>{t("home.today.protected")}</small>}
                        </span>
                        <Icon name="chevron-right" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rd-quiet">{t("home.today.thatsTheDay")}</p>
              )}
              <div className="rd-card-foot rd-quiet">{t("home.today.protectedStays")}</div>
            </article>
            {note && (
              <div className="rd-note">
                <div className="rd-eyebrow">{t("home.today.noteFrom", { name: (BOT_LABELS.michael ?? "Michael").toUpperCase() })}</div>
                <p dir="auto">{note.decision}</p>
                <button type="button" className="rd-link-action" onClick={() => scheduleUi.open()}>
                  {t("home.today.seeDecisions")}
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
