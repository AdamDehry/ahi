import { useEffect, useRef, type ReactNode } from "react";
import { Tally, type TallyCell } from "./Bits";
import { useT } from "../../i18n";

/** 52px buttons in the thumb zone (= .rv-actionbar / .rv-btn), with an optional note under them. */
export function ActionBar({ children, note, error }: { children: ReactNode; note?: ReactNode; error?: string | null }) {
  return (
    <div className="rv-actionbar">
      <div className="rv-col">
        {error && (
          <div className="rv-error" role="alert">
            {error}
          </div>
        )}
        <div className="rv-buttons">{children}</div>
        {note && <div className="pf-bar-note">{note}</div>}
      </div>
    </div>
  );
}

/**
 * "Closed Desk runners · Undo". The close is SENT when the toast expires —
 * Undo just never sends it, so there is no reopen endpoint (BUILD-NOTES §2.3).
 */
export function UndoToast({ id, text, onUndo, onExpire, ms = 6000 }: { id?: string | number; text: string; onUndo: () => void; onExpire: () => void; ms?: number }) {
  const t = useT();
  const expire = useRef(onExpire);
  expire.current = onExpire;
  // Each action gets its full window: keyed on the action's id, not its text (two can read alike).
  const key = id ?? text;
  useEffect(() => {
    const timer = setTimeout(() => expire.current(), ms);
    return () => clearTimeout(timer);
  }, [ms, key]);
  return (
    <div className="pf-toast" role="status">
      <span className="pf-toast-text" dir="auto">{text}</span>
      <button type="button" className="pf-toast-undo" onClick={onUndo}>
        {t("ops.undo")}
      </button>
    </div>
  );
}

/** C19: the last good board stays, dimmed, under this — never a blank screen. */
export function StaleBanner({ lastGoodAt, onRetry, what }: { lastGoodAt: string; onRetry: () => void; what?: string }) {
  const t = useT();
  return (
    <div className="pf-banner" role="status">
      <span>
        <b>{what ?? t("ops.cantReachGateway")}</b> {t("ops.staleShowing", { when: lastGoodAt })}
      </span>
      <button type="button" className="retry" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </div>
  );
}

/** A Fraunces sentence with one brass italic word. */
export function EmptyState({ title, em, body }: { title: string; em: string; body?: ReactNode }) {
  return (
    <div className="pf-empty">
      <h2>
        {title} <em>{em}</em>
      </h2>
      {body && <p>{body}</p>}
    </div>
  );
}

/** Skeleton rows in the real layout: tally, a head, two rows, a head, a row. */
export function SkeletonRows({ n = 3 }: { n?: number }) {
  const t = useT();
  const row = (i: number) => (
    <div className="pf-skel-row" key={i}>
      <div className="pf-skel-split">
        <div className="pf-skel" style={{ width: "34%", height: 14 }} />
        <div className="pf-skel" style={{ width: "12%", height: 12 }} />
      </div>
      <div className="pf-skel" style={{ width: "70%", height: 18 }} />
      <div className="pf-skel" style={{ width: "92%", height: 12 }} />
      <div className="pf-skel" style={{ width: "40%", height: 10 }} />
    </div>
  );
  return (
    <div className="pf-skeleton" aria-busy="true" aria-label={t("ops.loading")}>
      <div className="pf-tally">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <div className="pf-skel" style={{ width: "44%", height: 28 }} />
            <div className="pf-skel" style={{ width: "60%", height: 10 }} />
          </div>
        ))}
      </div>
      <div className="pf-head">
        <div className="pf-skel" style={{ width: "30%", height: 10 }} />
      </div>
      {Array.from({ length: Math.min(n, 2) }, (_, i) => row(i))}
      {n > 2 && (
        <>
          <div className="pf-head">
            <div className="pf-skel" style={{ width: "42%", height: 10 }} />
          </div>
          {Array.from({ length: n - 2 }, (_, i) => row(i + 2))}
        </>
      )}
    </div>
  );
}

/**
 * The daily line as a card (DESIGN §6): the same tally, up to three needs-you
 * names, and the to-close count. Tapping it opens Builds.
 */
export function DigestCard({
  cells,
  needsYou,
  more,
  toClose,
  onOpen,
}: {
  cells: TallyCell[];
  needsYou: string[];
  /** Needs-you items beyond the names shown (default: the names past three). */
  more?: number;
  toClose: { count: number; oldest: string | null } | null;
  onOpen: () => void;
}) {
  const t = useT();
  const shown = needsYou.slice(0, 3);
  const extra = more ?? Math.max(0, needsYou.length - 3);
  return (
    <button type="button" className="pf-digest" onClick={onOpen}>
      <span className="pf-digest-top">
        <span className="mono-label">{t("ops.digest.builds")}</span>
        <span className="mono-label go">{t("ops.digest.open")}</span>
      </span>
      <Tally cells={cells} />
      {shown.length > 0 && (
        <span className="pf-digest-you">
          {shown.map((n) => (
            <span key={n} dir="auto">{n}</span>
          ))}
          {extra > 0 && <span>{t("ops.digest.more", { n: extra })}</span>}
        </span>
      )}
      {toClose && toClose.count > 0 && (
        <span className="pf-digest-close">
          {t("ops.digest.toClose", { n: toClose.count })}
          {toClose.oldest ? t("ops.digest.oldest", { age: toClose.oldest }) : ""}
        </span>
      )}
    </button>
  );
}
