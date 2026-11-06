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

type Filter = "all" | "you" | "moving" | "done";
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All builds" },
  { key: "you", label: "Needs you" },
  { key: "moving", label: "Moving" },
  { key: "done", label: "Done" },
];
const IN: Record<Filter, SectionKey[]> = {
  all: ["needs_you", "ready", "moving", "stuck", "queued", "closed_week"],
  you: ["needs_you"],
  moving: ["moving", "queued", "stuck"],
  done: ["ready", "closed_week"],
};

export function tagOf(c: Card, section: SectionKey): { word: string; tone: "gold" | "green" | "" } {
  if (section === "needs_you") {
    const w = { "your-step": "Your step", question: "Needs you", "in-review": "In review", ship: "Ready to ship", shipping: "Shipping", "rolled-back": c.ship?.phase === "failed" ? "Ship stopped" : "Rolled back" } as Record<string, string>;
    return { word: w[c.kicker] ?? "Needs you", tone: c.kicker === "in-review" ? "" : "gold" };
  }
  if (section === "ready") return { word: "Ready to close", tone: "" };
  if (section === "moving") return { word: "Building", tone: "" };
  if (section === "stuck") return { word: "Stuck", tone: "" };
  if (section === "queued") return { word: "Queued", tone: "" };
  return { word: c.closed?.how.startsWith("cancelled") ? "Stopped" : "Closed", tone: "green" };
}

function lineOf(c: Card): string {
  return c.ask ?? c.now?.text ?? (c.left || c.done || c.close_note || (c.runs.length > 1 ? `${c.runs.length} runs` : "No status yet."));
}

/** "Updated just now / 12 min ago / 3 hours ago / 27 days ago" (FINAL wording). */
export function updated(c: Pick<Card, "last_activity_at" | "opened_at">, now: number): string {
  const ms = Math.max(0, now - Date.parse(c.last_activity_at ?? c.opened_at));
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (m < 1) return "Updated just now";
  if (m < 60) return `Updated ${m} min ago`;
  if (h < 24) return `Updated ${h} hour${h === 1 ? "" : "s"} ago`;
  return `Updated ${d} day${d === 1 ? "" : "s"} ago`;
}

function rows(view: BuildsView, f: Filter): Array<{ c: Card; s: SectionKey }> {
  const seen = new Set<string>();
  const out: Array<{ c: Card; s: SectionKey }> = [];
  for (const s of IN[f]) for (const c of view.sections[s] ?? []) if (!seen.has(c.id)) (seen.add(c.id), out.push({ c, s }));
  return out;
}

export default function BuildsBoard({ phone = false }: { phone?: boolean }) {
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
          <Icon name="arrow-left" /> All builds
        </button>
        {found && (
          <div className="rd-build-head">
            <div className="rd-build-tagline">
              {tag && <span className={`rd-tag ${tag.tone}`}>{tag.word}</span>}
              <span className="rd-quiet">
                {BOT_LABELS[found.c.from ?? ""] ?? "Your team"} · {updated(found.c, now)}
              </span>
            </div>
            <h2>{found.c.title}</h2>
            <p>{lineOf(found.c)}</p>
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
        <div className="rd-eyebrow">WORK, WITH MOMENTUM</div>
        <h2>
          Builds<span className="rd-title-dot">.</span>
        </h2>
        <p>A clear view of what’s moving and what needs you.</p>
      </div>
      {feed.error && !view && (
        <div className="rd-inline-error" role="alert">
          Can’t reach the builds right now. <button type="button" onClick={feed.reload}>Try again</button>
        </div>
      )}
      {view && (
        <>
          <div className="rd-stats">
            <div className="rd-stat"><div className="rd-eyebrow">OPEN BUILDS</div><div className="rd-stat-n">{view.tally.open}</div><small>Across your team</small></div>
            <div className="rd-stat"><div className="rd-eyebrow">NEED YOUR INPUT</div><div className="rd-stat-n">{view.tally.needs_you}</div><small>The next move is yours</small></div>
            <div className="rd-stat"><div className="rd-eyebrow">COMPLETED THIS WEEK</div><div className="rd-stat-n">{view.sections.closed_week.length}</div><small>A little more progress</small></div>
          </div>
          <div className="rd-tabs" role="tablist" aria-label="Filter builds">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={`rd-tab${filter === f.key ? " active" : ""}`} onClick={() => setFilter(f.key)}>
                {f.label}
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
                        <span className="rd-build-title">{c.title}</span>
                        <span className={`rd-tag ${tag.tone}`}>{tag.word}</span>
                      </span>
                      <span className="rd-build-line">{lineOf(c)}</span>
                      <span className="rd-build-meta">
                        <AgentAvatar bot={agent} size="xs" /> {BOT_LABELS[c.from ?? ""] ?? "Your team"} · {updated(c, now)}
                      </span>
                    </span>
                    <Icon name="chevron-right" />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rd-quiet rd-empty-line">{filter === "all" ? "No builds yet. New work shows up here the moment it starts." : "Nothing here right now."}</p>
          )}
        </>
      )}
      {hold && <UndoToast id={hold.id} text={`${hold.kind === "cancelled" ? "Stopped" : "Closed"} ${hold.title}`} onUndo={undoPending} onExpire={commitPending} />}
    </div>
  );
}
