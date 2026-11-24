import type { ReactNode } from "react";
import { IconCheck } from "../icons";
import { StatusChip, type Tone } from "./Bits";
import { AGENT_LABEL } from "./format";
import { useT, type Key } from "../../i18n";

export function DetailHead({ chip, metaLine, title, purpose }: { chip: { tone: Tone; word: string }; metaLine: string; title: string; purpose?: string | null }) {
  return (
    <>
      <div className="pf-dhead">
        <StatusChip tone={chip.tone} word={chip.word} />
        <span className="mono-label">{metaLine}</span>
      </div>
      <h1 className="pf-dtitle" dir="auto">{title}</h1>
      {purpose && <p className="pf-dsub" dir="auto">{purpose}</p>}
    </>
  );
}

/** "Avi asks · 5:24 AM", the question at 16.5px, then the context needed to answer. */
export function AskCard({ from, at, question, context }: { from: string | null; at: string | null; question: string; context?: ReactNode }) {
  const t = useT();
  const who = from ? t("ops.asks", { name: AGENT_LABEL[from] ?? from }) : t("ops.asked");
  return (
    <div className="pf-card you">
      <span className="mono-label pf-card-you-label">
        {who}
        {at ? ` · ${at}` : ""}
      </span>
      <div className="q" dir="auto">{question}</div>
      {context && <div className="body" dir="auto">{context}</div>}
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

const KIND_WORD: Record<TimelineEvent["kind"], Key | "Michael"> = {
  progress: "ops.kind.progress",
  needs_operator: "ops.kind.needsOperator",
  closed: "ops.kind.closed",
  failed: "ops.kind.failed",
  note: "Michael",
  ship: "ops.kind.ship",
};

const NODE_CLASS: Record<TimelineEvent["kind"], string> = { progress: "progress", needs_operator: "needs", closed: "closed", failed: "failed", note: "michael", ship: "ship" };

/** Newest first, grouped by run ("Run 1 · Zali · Wed 4:38 AM"). */
export function Timeline({ runs }: { runs: Array<{ key: string; label: string; events: TimelineEvent[]; empty?: string }> }) {
  const t = useT();
  const kindWord = (k: TimelineEvent["kind"]) => {
    const w = KIND_WORD[k];
    return w === "Michael" ? w : t(w);
  };
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
                  <span className="k">{kindWord(e.kind)}</span>
                  <span className="mono-label t">{e.time}</span>
                </div>
                {e.marker ? (
                  <div className="pf-ev-fin">{t("ops.buildClosedMarker")}</div>
                ) : (
                  <>
                    {e.question && <div className="pf-ev-q" dir="auto">{e.question}</div>}
                    {e.finished && <div className="pf-ev-fin" dir="auto">{e.finished}</div>}
                    {e.now && (
                      <div className="pf-ev-now">
                        <b>{t("ops.now")}</b>
                        <span dir="auto">{e.now}</span>
                      </div>
                    )}
                  </>
                )}
                {e.checks && (
                  <div className="pf-ev-checks">
                    {t("ops.checksPassed", { passed: e.checks.passed, total: e.checks.total })}
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
