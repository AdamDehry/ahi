/**
 * Your work → Live sessions (slice 4): every build with a run that is live
 * right now, from the same builds view the board reads. A Codex run shows its
 * live transcript (the existing CodexLivePanel); any other runtime says what
 * it is and opens its build card. No invented progress.
 */
import { useEffect, useState } from "react";
import { actions, useAppState } from "../store";
import { BUILDS_URL, type BuildsView, type Card, type CardRun } from "../lib/builds";
import { BOT_LABELS } from "../lib/types";
import { CodexLivePanel } from "../views/CodexLive";
import { AgentAvatar } from "./AgentRail";

const LIVE_STATES = new Set(["running", "active", "live", "started", "waiting"]);

export function liveRuns(view: BuildsView | null): Array<{ card: Card; run: CardRun }> {
  if (!view) return [];
  const out: Array<{ card: Card; run: CardRun }> = [];
  const seen = new Set<string>();
  // Only what the board itself counts as live (moving, or paused on a question to you). A stuck
  // card can still carry a "running" run whose session died — that is not a live session.
  for (const key of ["moving", "needs_you"] as const) {
    for (const card of view.sections[key] ?? []) {
      if (seen.has(card.id)) continue;
      const run = [...card.runs].reverse().find((r) => LIVE_STATES.has(r.state));
      if (run) {
        seen.add(card.id);
        out.push({ card, run });
      }
    }
  }
  return out;
}

export default function LiveSessions() {
  const { buildsRev } = useAppState();
  const [view, setView] = useState<BuildsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(BUILDS_URL, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<BuildsView>) : Promise.reject(new Error(String(r.status)))))
      .then((v) => live && (setView(v), setFailed(false)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [buildsRev]);
  const rows = liveRuns(view);
  const chosen = rows.find((r) => r.card.id === open) ?? null;
  return (
    <div className="rd-live tool-page">
      {failed && !view && <div className="rd-inline-error">Couldn’t load the live sessions.</div>}
      {view && !rows.length && (
        <div className="rd-builds-head rd-live-empty">
          <div className="rd-eyebrow">LIVE SESSION · READ ONLY</div>
          <h2>
            Nothing live right now<span className="rd-title-dot">.</span>
          </h2>
          <p>When a build is running, its session shows here as it happens.</p>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="rd-list-card">
          {rows.map(({ card, run }) => (
            <li key={card.id} className={open === card.id ? "selected" : ""}>
              <AgentAvatar bot={BOT_LABELS[run.agent] ? run.agent : "michael"} size="sm" />
              <span>
                {card.title}
                <small>
                  {BOT_LABELS[run.agent] ?? run.agent} · {run.runtime === "codex" ? "Codex" : "Claude"} · {card.now?.text ?? run.state}
                </small>
              </span>
              {run.runtime === "codex" ? (
                <button type="button" className="rd-btn" onClick={() => setOpen(open === card.id ? null : card.id)}>
                  {open === card.id ? "Hide" : "Watch"}
                </button>
              ) : (
                <button type="button" className="rd-btn" onClick={() => actions.openBuilds(card.id)}>
                  Open
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {chosen && chosen.run.runtime === "codex" && view && (
        <div className="rd-live-panel">
          <CodexLivePanel build={chosen.run.build} tz={view.tz} />
        </div>
      )}
    </div>
  );
}
