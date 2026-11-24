/**
 * Your work → Builds in the FINAL layout (one-for-one with the design).
 * Same live builds feed, same close-with-Undo store and the same build card logic as before
 * (views/Builds.tsx); only the presentation follows the design: "Work, with momentum" heading,
 * three stat cards, All builds / Needs you / Moving / Done, one list of build rows with a status
 * tag and owner, and a full-width build page with "All builds" to go back.
 */
import { useEffect, useMemo, useState } from "react";
import { actions, useAppState } from "../store";
import { BUILDS_URL, needsYouBadge, type BuildsView, type Card, type SectionKey } from "../lib/builds";
import { usePanelFeed } from "../lib/usePanelFeed";
import { BOT_LABELS } from "../lib/types";
import { UndoToast } from "../components/panel";
import { BuildDetail, commitPending, undoPending, usePending, withoutPending } from "../views/Builds";
import { Icon } from "./icons";
import { AgentAvatar } from "./AgentRail";
import { t, tn, useT, type Key } from "../i18n";

type Filter = "all" | "you" | "moving" | "done";
const FILTERS: Array<{ key: Filter; label: Key }> = [
  { key: "all", label: "builds.board.all" },
  { key: "you", label: "builds.section.needsYou" },
  { key: "moving", label: "builds.section.moving" },
  { key: "done", label: "builds.board.done" },
];
const IN: Record<Filter, SectionKey[]> = {
  all: ["needs_you", "ready", "moving", "stuck", "queued", "closed_week"],
  you: ["needs_you"],
  moving: ["moving", "queued", "stuck"],
  done: ["ready", "closed_week"],
};

export function tagOf(c: Card, section: SectionKey): { word: string; tone: "gold" | "green" | "" } {
  if (section === "needs_you") {
    const w = { "your-step": "builds.kicker.yourStep", question: "builds.section.needsYou", "in-review": "builds.board.inReview", ship: "builds.kicker.readyToShip", shipping: "builds.shipping", "rolled-back": c.ship?.phase === "failed" ? "builds.kicker.shipStopped" : "builds.kicker.rolledBack" } as Record<string, Key>;
    return { word: t(Object.prototype.hasOwnProperty.call(w, c.kicker) ? w[c.kicker] : "builds.section.needsYou"), tone: c.kicker === "in-review" ? "" : "gold" };
  }
  if (section === "ready") return { word: t("builds.section.ready"), tone: "" };
  if (section === "moving") return { word: t("builds.chip.building"), tone: "" };
  if (section === "stuck") return { word: t("builds.section.stuck"), tone: "" };
  if (section === "queued") return { word: t("builds.section.queued"), tone: "" };
  return { word: c.closed?.how.startsWith("cancelled") ? t("builds.word.stopped") : t("builds.word.closed"), tone: "green" };
}

function lineOf(c: Card): string {
  return c.ask ?? c.now?.text ?? (c.left || c.done || c.close_note || (c.runs.length > 1 ? t("builds.runs", { n: c.runs.length }) : t("builds.board.noStatus")));
}

/** "Updated just now / 12 min ago / 3 hours ago / 27 days ago" (FINAL wording). */
export function updated(c: Pick<Card, "last_activity_at" | "opened_at">, now: number): string {
  const ms = Math.max(0, now - Date.parse(c.last_activity_at ?? c.opened_at));
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (m < 1) return t("builds.board.updatedJustNow");
  if (m < 60) return t("builds.board.updatedMin", { n: m });
  if (h < 24) return tn("builds.board.updatedHours", h);
  return tn("builds.board.updatedDays", d);
}

function rows(view: BuildsView, f: Filter): Array<{ c: Card; s: SectionKey }> {
  const seen = new Set<string>();
  const out: Array<{ c: Card; s: SectionKey }> = [];
  for (const s of IN[f]) for (const c of view.sections[s] ?? []) if (!seen.has(c.id)) (seen.add(c.id), out.push({ c, s }));
  return out;
}

export default function BuildsBoard({ phone = false }: { phone?: boolean }) {
  const t = useT();
  const { buildsRev, buildsItem } = useAppState();
  const feed = usePanelFeed<BuildsView>(BUILDS_URL, buildsRev);
  const { pending: hold } = usePending();
  const [filter, setFilter] = useState<Filter>("all");
  const now = Date.now();
  useEffect(() => {
    if (feed.data) actions.setBuildsNeedYou(needsYouBadge(feed.data));
  }, [feed.data]);
  useEffect(() => () => commitPending(), []);
  const view = useMemo(() => (feed.data ? withoutPending(feed.data, hold?.id ?? null) : null), [feed.data, hold?.id]);

  // On a phone the build page is pushed over the board (App.tsx MobileApp).
  if (buildsItem && !phone) {
    const found = view ? (Object.entries(view.sections) as Array<[SectionKey, Card[]]>).flatMap(([s, cs]) => cs.map((c) => ({ c, s }))).find((x) => x.c.id === buildsItem) : undefined;
    const tag = found ? tagOf(found.c, found.s) : null;
    return (
      <div className="rd-build-page">
        <button type="button" className="rd-back-link" onClick={actions.closeBuildItem}>
          <Icon name="arrow-left" /> {t("builds.board.all")}
        </button>
        {found && (
          <div className="rd-build-head">
            <div className="rd-build-tagline">
              {tag && <span className={`rd-tag ${tag.tone}`}>{tag.word}</span>}
              <span className="rd-quiet">
                {BOT_LABELS[found.c.from ?? ""] ?? t("builds.board.yourTeam")} · {updated(found.c, now)}
              </span>
            </div>
            <h2 dir="auto">{found.c.title}</h2>
            <p dir="auto">{lineOf(found.c)}</p>
          </div>
        )}
        <BuildDetail id={buildsItem} inlineBar split />
      </div>
    );
  }

  const list = view ? rows(view, filter) : [];
  return (
    <div className="rd-builds">
      <div className="rd-builds-head">
        <div className="rd-eyebrow">{t("builds.board.eyebrow")}</div>
        <h2>
          {t("builds.board.title")}<span className="rd-title-dot">.</span>
        </h2>
        <p>{t("builds.board.subtitle")}</p>
      </div>
      {feed.error && !view && (
        <div className="rd-inline-error" role="alert">
          {t("builds.board.cantReach")} <button type="button" onClick={feed.reload}>{t("common.tryAgain")}</button>
        </div>
      )}
      {view && (
        <>
          <div className="rd-stats">
            <div className="rd-stat"><div className="rd-eyebrow">{t("builds.board.openBuilds")}</div><div className="rd-stat-n">{view.tally.open}</div><small>{t("builds.board.acrossTeam")}</small></div>
            <div className="rd-stat"><div className="rd-eyebrow">{t("builds.board.needInput")}</div><div className="rd-stat-n">{view.tally.needs_you}</div><small>{t("builds.board.nextMove")}</small></div>
            <div className="rd-stat"><div className="rd-eyebrow">{t("builds.board.completedWeek")}</div><div className="rd-stat-n">{view.sections.closed_week.length}</div><small>{t("builds.board.progress")}</small></div>
          </div>
          <div className="rd-tabs" role="tablist" aria-label={t("builds.board.filter")}>
            {FILTERS.map((f) => (
              <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={`rd-tab${filter === f.key ? " active" : ""}`} onClick={() => setFilter(f.key)}>
                {t(f.label)}
              </button>
            ))}
          </div>
          {list.length ? (
            <div className="rd-build-list">
              {list.map(({ c, s }) => {
                const tag = tagOf(c, s);
                const agent = c.from && c.from !== "foreman" ? c.from : "michael";
                return (
                  <button key={c.id} type="button" className="rd-build-row" onClick={() => actions.openBuilds(c.id)}>
                    <span className={`rd-build-mark${s === "moving" ? " moving" : s === "closed_week" ? " done" : ""}`}>
                      <Icon name={s === "closed_week" ? "check" : "layers"} />
                    </span>
                    <span className="rd-build-main">
                      <span className="rd-build-top">
                        <span className="rd-build-title" dir="auto">{c.title}</span>
                        <span className={`rd-tag ${tag.tone}`}>{tag.word}</span>
                      </span>
                      <span className="rd-build-line" dir="auto">{lineOf(c)}</span>
                      <span className="rd-build-meta">
                        <AgentAvatar bot={agent} size="xs" /> {BOT_LABELS[c.from ?? ""] ?? t("builds.board.yourTeam")} · {updated(c, now)}
                      </span>
                    </span>
                    <Icon name="chevron-right" />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rd-quiet rd-empty-line">{filter === "all" ? t("builds.board.noBuilds") : t("builds.board.nothingHere")}</p>
          )}
        </>
      )}
      {hold && <UndoToast id={hold.id} text={hold.kind === "cancelled" ? t("builds.toast.stopped", { title: hold.title }) : t("builds.toast.closed", { title: hold.title })} onUndo={undoPending} onExpire={commitPending} />}
    </div>
  );
}
