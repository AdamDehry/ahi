import { useEffect, useState } from "react";
import { actions, useAppState } from "../store";
import { fetchMc, fetchFitnessEntries, fetchFitnessDay } from "../lib/api";
import type { McL3Detail } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { IconBack } from "../components/icons";

function updatedLabel(mtime?: number): string {
  if (!mtime) return "";
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `UPDATED ${time}`;
  return `UPDATED ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`.toUpperCase();
}

/** Order per the structured MC source (/app/mc/cards): fitness first,
 *  then the file-backed six. Nothing dropped (3c#5). */
const CARD_ORDER = ["Fitness", "Handoff", "Today", "Activity", "Todo", "Agents", "Architecture"];

/** L3 details are immutable per day — cache for the session. */
const dayCache = new Map<string, McL3Detail>();

function BackBar({ label, onBack, title, meta }: { label: string; onBack: () => void; title: string; meta?: string }) {
  return (
    <div className="l2-head">
      <button className="l2-back" onClick={onBack}>
        <IconBack />
        <span className="mono-label">{label}</span>
      </button>
      <h2 className="l2-title">{title}</h2>
      {meta && <span className="mono-label">{meta}</span>}
    </div>
  );
}

/** L3 — one fitness day's full routine (`spec` markdown). */
function FitnessDay({ id }: { id: string }) {
  const [detail, setDetail] = useState<McL3Detail | null>(dayCache.get(id) ?? null);

  useEffect(() => {
    if (!dayCache.has(id)) {
      fetchFitnessDay(id).then((d) => {
        if (d) {
          dayCache.set(id, d);
          setDetail(d);
        }
      });
    }
  }, [id]);

  return (
    <div className="tool-page l2-page">
      <BackBar
        label="FITNESS"
        onBack={actions.closeFitnessDay}
        title={detail?.title ?? "…"}
        meta={detail?.meta?.dayNumber ? `DAY ${detail.meta.dayNumber} · ${detail.meta.isoDate ?? ""}` : ""}
      />
      {detail ? (
        <div className="l2-content msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.spec || detail.summary || "") }} />
      ) : (
        <div className="l2-content skeleton-card" />
      )}
    </div>
  );
}

/** L2 for Fitness — the daily cards (design: list of days → L3 routine). */
function FitnessL2() {
  const { fitnessEntries } = useAppState();
  return (
    <div className="tool-page l2-page">
      <BackBar label="CARDS" onBack={actions.closeMcCard} title="Fitness" />
      {fitnessEntries === null ? (
        <div className="card-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="mc-card skeleton-card" />
          ))}
        </div>
      ) : (
        <div className="day-list">
          {fitnessEntries.map((e) => (
            <button key={e.id} className="day-row" onClick={() => actions.openFitnessDay(e.id)}>
              <span className="day-row-head">
                <span className="day-row-title">{e.title}</span>
                <span className="mono-label">
                  {e.meta?.dayNumber ? `DAY ${e.meta.dayNumber}` : ""}
                  {e.meta?.isoDate ? ` · ${e.meta.isoDate}` : ""}
                </span>
              </span>
              {e.summary && <span className="day-row-summary">{e.summary}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Mission Control (3c2#2/#3 — parity with the legacy dashboard's
 * card → full-page flow):
 *  L1 = uniform fixed-size preview cards (no per-card height variance);
 *  L2 = clicking a card opens a FULL-PAGE view of its content with a
 *       back affordance (edge-swipe pops on mobile);
 *  L3 = Fitness only: L2 lists the daily cards, L3 is the day's routine.
 */
export default function MissionControl() {
  const { mcFiles, fitnessEntries, user, mcL2, mcL3 } = useAppState();

  useEffect(() => {
    if (mcFiles === null) fetchMc().then(actions.setMcFiles);
  }, [mcFiles]);

  useEffect(() => {
    if (user?.admin && fitnessEntries === null) fetchFitnessEntries().then(actions.setFitnessEntries);
  }, [user?.admin, fitnessEntries]);

  // ── Drill-down routing ──
  if (mcL2 === "fitness" && mcL3) return <FitnessDay id={mcL3} />;
  if (mcL2 === "fitness") return <FitnessL2 />;
  if (mcL2 && mcFiles?.[mcL2]) {
    const f = mcFiles[mcL2];
    return (
      <div className="tool-page l2-page">
        <BackBar label="CARDS" onBack={actions.closeMcCard} title={f.label} meta={updatedLabel(f.mtime)} />
        <div className="l2-content msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(f.content ?? "") }} />
      </div>
    );
  }

  // ── L1 grid ──
  if (mcFiles === null) {
    return (
      <div className="tool-page">
        <div className="card-grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="mc-card skeleton-card" />
          ))}
        </div>
      </div>
    );
  }

  const files = Object.values(mcFiles).filter((f) => f.exists !== false);
  const rank = (label: string) => {
    const i = CARD_ORDER.indexOf(label);
    return i === -1 ? CARD_ORDER.length : i; // unknown cards go last, never dropped
  };
  const ordered = [...files].sort((a, b) => rank(a.label) - rank(b.label));

  const latestFitness = (fitnessEntries ?? []).slice(0, 3);
  const fitnessUpdated = latestFitness[0]?.meta?.isoDate ? `UPDATED ${latestFitness[0].meta.isoDate}` : "";

  return (
    <div className="tool-page">
      {files.length === 0 && !latestFitness.length ? (
        <div className="tool-empty mono-label">NO CARDS ON DISK</div>
      ) : (
        <div className="card-grid">
          {user?.admin && (
            <article id="mc-fitness" className="mc-card" onClick={() => actions.openMcCard("fitness")}>
              <h3 className="card-title">Fitness</h3>
              <div className="mc-body">
                {fitnessEntries === null
                  ? "Loading workouts…"
                  : latestFitness.length === 0
                    ? "No workout entries yet."
                    : latestFitness.map((e) => (
                        <div key={e.id} className="fitness-entry">
                          <div className="fitness-entry-title">
                            {e.meta?.dayNumber ? `Day ${e.meta.dayNumber} — ` : ""}
                            {e.title}
                          </div>
                        </div>
                      ))}
              </div>
              <div className="mono-label card-foot">{fitnessUpdated}</div>
            </article>
          )}

          {ordered.map((f) => {
            const pulsing = f.touchedAt && Date.now() - f.touchedAt < 4000;
            return (
              <article
                key={f.name}
                id={`mc-${f.name}`}
                className={`mc-card${pulsing ? " pulse" : ""}`}
                onClick={() => actions.openMcCard(f.name)}
              >
                <h3 className="card-title">{f.label}</h3>
                <div
                  className="mc-body"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(f.content ?? "") }}
                />
                <div className="mono-label card-foot">{updatedLabel(f.mtime)}</div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
