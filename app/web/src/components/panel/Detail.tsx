import type { ReactNode } from "react";
import { IconCheck } from "../icons";
import { StatusChip, type Tone } from "./Bits";
import { AGENT_LABEL } from "./format";

export function DetailHead({ chip, metaLine, title, purpose }: { chip: { tone: Tone; word: string }; metaLine: string; title: string; purpose?: string | null }) {
  return (
    <>
      <div className="pf-dhead">
        <StatusChip tone={chip.tone} word={chip.word} />
        <span className="mono-label">{metaLine}</span>
      </div>
      <h1 className="pf-dtitle">{title}</h1>
      {purpose && <p className="pf-dsub">{purpose}</p>}
    </>
  );
}

/** "Avi asks · 5:24 AM", the question at 16.5px, then the context needed to answer. */
export function AskCard({ from, at, question, context }: { from: string | null; at: string | null; question: string; context?: ReactNode }) {
  const who = from ? `${AGENT_LABEL[from] ?? from} asks` : "Asked";
  return (
    <div className="pf-card you">
      <span className="mono-label pf-card-you-label">
        {who}
        {at ? ` · ${at}` : ""}
      </span>
      <div className="q">{question}</div>
      {context && <div className="body">{context}</div>}
    </div>
  );
}

export interface Step {
  label: string;
  state: "done" | "now" | "you" | "left";
  who: string | null;
}

/** Stations, only from structured steps — never fake them by splitting prose. */
export function StepsRail({ steps }: { steps: Step[] }) {
  return (
    <ol className="pf-steps">
      {steps.map((s, i) => (
        <li key={`${i}-${s.label}`} className={`pf-step ${s.state === "left" ? "" : s.state}`}>
          <i />
          {s.label}
          {s.who && <span className={`mono-label who${s.state === "you" ? " you" : ""}`}>{s.who}</span>}
        </li>
      ))}
    </ol>
  );
}

export interface TimelineEvent {
  key: string;
  kind: "progress" | "needs_operator" | "closed" | "failed" | "note" | "ship";
  time: string;
  finished: string | null;
  now: string | null;
  question: string | null;
  checks: { passed: number; total: number } | null;
  /** The closed record the summary card already shows renders as a marker. */
  marker?: boolean;
}

const KIND_WORD: Record<TimelineEvent["kind"], string> = {
  progress: "Progress",
  needs_operator: "Asked you",
  closed: "Closed",
  failed: "Failed",
  note: "Michael",
  ship: "Ship",
};

const NODE_CLASS: Record<TimelineEvent["kind"], string> = { progress: "progress", needs_operator: "needs", closed: "closed", failed: "failed", note: "michael", ship: "ship" };

/** Newest first, grouped by run ("Run 1 · Zali · Wed 4:38 AM"). */
export function Timeline({ runs }: { runs: Array<{ key: string; label: string; events: TimelineEvent[]; empty?: string }> }) {
  return (
    <div className="pf-tl">
      {runs.map((run) => (
        <div key={run.key} className="pf-tl-run">
          <div className="pf-run mono-label">{run.label}</div>
          {run.events.length === 0 && run.empty && <div className="pf-tl-empty">{run.empty}</div>}
          {run.events.map((e, i) => (
            <div key={e.key} className={`pf-ev ${NODE_CLASS[e.kind]}${i === run.events.length - 1 ? " last" : ""}`}>
              <span className="pf-node">{e.kind === "closed" && <IconCheck />}</span>
              <div className="pf-ev-body">
                <div className="pf-ev-top">
                  <span className="k">{KIND_WORD[e.kind]}</span>
                  <span className="mono-label t">{e.time}</span>
                </div>
                {e.marker ? (
                  <div className="pf-ev-fin">Build closed — the summary above is its record.</div>
                ) : (
                  <>
                    {e.question && <div className="pf-ev-q">{e.question}</div>}
                    {e.finished && <div className="pf-ev-fin">{e.finished}</div>}
                    {e.now && (
                      <div className="pf-ev-now">
                        <b>NOW</b>
                        {e.now}
                      </div>
                    )}
                  </>
                )}
                {e.checks && (
                  <div className="pf-ev-checks">
                    {e.checks.passed}/{e.checks.total} checks passed
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
