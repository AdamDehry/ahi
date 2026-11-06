import type { ReactNode } from "react";
import { AGENT_LABEL, ageLabel, ageLevel, ageParts } from "./format";

/** The tone vocabulary (C8), the same in both panels. */
export type Tone = "you" | "move" | "built" | "stuck" | "queued" | "closed" | "review";

/** Mono `47M` / `4H` / `2D` — the figure itself ages (C7). */
export function Age({ ms, label = ageLabel }: { ms: number; label?: (ms: number) => string }) {
  return <span className={`pf-age ${ageLevel(ms)}`}>{label(ms)}</span>;
}

/** Only where position doesn't already say the status: detail heads, mixed lists, desktop (C5). */
export function StatusChip({ tone, word }: { tone: Tone; word: string }) {
  return <span className={`pf-chip ${tone}`}>{word}</span>;
}

export interface TallyCell {
  value: string | number;
  unit?: string;
  label: string;
  tone?: "you" | "old" | "zero" | "";
}

/** Three figures, no card (C6). The digest card uses the same cells. */
export function Tally({ cells }: { cells: TallyCell[] }) {
  return (
    <div className="pf-tally">
      {cells.map((c) => (
        <div key={c.label}>
          <span className={`pf-fig ${c.tone ?? ""}`}>
            {c.value}
            {c.unit && <small>{c.unit}</small>}
          </span>
          <span className="mono-label">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Open · Need you · Oldest — zero goes ghost, Need you > 0 goes warn, Oldest ages. */
export function boardCells(open: number, needYou: number, oldestMs: number | null): TallyCell[] {
  const oldest = oldestMs === null ? null : ageParts(oldestMs);
  const level = oldestMs === null ? "" : ageLevel(oldestMs);
  return [
    { value: open, label: "Open", tone: open ? "" : "zero" },
    { value: needYou, label: "Need you", tone: needYou ? "you" : "zero" },
    oldest
      ? { value: oldest.value, unit: oldest.unit, label: "Oldest", tone: level === "old" ? "old" : "" }
      : { value: "—", label: "Oldest", tone: "zero" },
  ];
}

export function SectionHead({ label, count, hint, tone }: { label: string; count?: number; hint?: string; tone?: "you" }) {
  return (
    <div className={`pf-head ${tone ?? ""}`}>
      <span className="mono-label">
        {label}
        {count !== undefined ? ` · ${count}` : ""}
      </span>
      {hint && <span className="mono-label hint">{hint}</span>}
    </div>
  );
}

/** The kicker: what KIND of thing, then `·` and who it's from with their dot. */
export function Kicker({ word, from }: { word: string; from?: string | null }) {
  return (
    <span className="pf-kicker">
      <span>{word}</span>
      {from && (
        <>
          <span className="sep">·</span>
          <span className={`agent ${from}`}>{AGENT_LABEL[from] ?? from}</span>
        </>
      )}
    </span>
  );
}

export interface RowLine {
  label: string;
  text: string;
}

/**
 * The list card (C4/C5): no chip, no buttons — the whole card is the button.
 * A 3px left rule in the section's tone; Needs-you rows also tint their ground.
 */
export function ListRow({
  tone,
  kicker,
  from,
  ageMs,
  ageFormat,
  title,
  ask,
  lines,
  selected,
  onOpen,
}: {
  tone: "you" | "move" | "built" | "stuck";
  kicker: string;
  from?: string | null;
  ageMs: number;
  /** WhatsApp passes waAgeLabel; Builds keeps the desk's format. */
  ageFormat?: (ms: number) => string;
  title: string;
  ask?: string | null;
  lines?: RowLine[];
  selected?: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className={`pf-row ${tone}${selected ? " sel" : ""}`} onClick={onOpen}>
      <span className="pf-row-top">
        <Kicker word={kicker} from={from} />
        <Age ms={ageMs} label={ageFormat} />
      </span>
      <span className="pf-row-title">{title}</span>
      {ask ? (
        <span className="pf-ask">{ask}</span>
      ) : (
        lines?.map((l) => (
          <span className="pf-line" key={l.label}>
            <span className="mono-label">{l.label}</span>
            <span className="clamp">{l.text}</span>
          </span>
        ))
      )}
    </button>
  );
}

export function CompactList({ children }: { children: ReactNode }) {
  return <div className="pf-list">{children}</div>;
}

/**
 * A compact row: dot (or the queue number), name, a 12px sub-line, and on the
 * right an age or the Close pill. With Close, the age moves to the front of the
 * sub-line so the pill has room.
 */
export function CompactItem({
  dot,
  order,
  name,
  sub,
  right,
  ageMs,
  ageFormat = ageLabel,
  onClose,
  closeLabel = "Close",
  onOpen,
  closed,
  wrap,
  selected,
  error,
}: {
  dot?: "move" | "built" | "stuck" | "closed" | "quiet" | "";
  order?: number | null;
  name: string;
  sub: string;
  right?: ReactNode;
  ageMs?: number;
  ageFormat?: (ms: number) => string;
  onClose?: () => void;
  /** The pill's word — "Close" on Builds, "Taught" on WhatsApp's Teach the customer agent rows. */
  closeLabel?: string;
  onOpen?: () => void;
  closed?: boolean;
  wrap?: boolean;
  selected?: boolean;
  error?: string | null;
}) {
  const subLine = onClose && ageMs !== undefined ? `${ageFormat(ageMs)} · ${sub}` : sub;
  return (
    <div className={`pf-li${closed ? " closed" : ""}${wrap ? " wrap" : ""}${selected ? " sel" : ""}`}>
      {order !== undefined ? <span className="pf-li-ord">{order ?? "—"}</span> : <span className={`pf-li-dot ${dot ?? ""}`} />}
      <button type="button" className="pf-li-body" onClick={onOpen} disabled={!onOpen}>
        <span className="pf-li-name">{name}</span>
        <span className="pf-li-sub">{subLine}</span>
        {error && (
          <span className="pf-li-error" role="alert">
            {error}
          </span>
        )}
      </button>
      {onClose ? (
        <button type="button" className="pf-li-close" onClick={onClose}>
          {closeLabel}
        </button>
      ) : (
        right ?? (ageMs !== undefined ? <Age ms={ageMs} label={ageFormat} /> : null)
      )}
    </div>
  );
}

export function MoreRow({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button type="button" className="pf-more" onClick={onClick} disabled={!onClick}>
      <span className="mono-label">{label}</span>
    </button>
  );
}
