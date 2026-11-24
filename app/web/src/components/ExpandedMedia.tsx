import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MediaRef } from "../lib/types";
import { downloadUrl, mediaUrl, thumbSrc } from "../lib/mediaFormat";
import { isRtl, useT } from "../i18n";

/* ============================================================
   ExpandedMedia — design lock v4, frame 4G (expanded view).

   Tap a sent tile and it opens full-view on #121316 over the whole screen:
   ✕, the file name with "n of n", Save, a filmstrip of its
   siblings, and between them swipe (touch), the side arrows and the arrow
   keys — moving between files never means going back out to the thread.

   Open 200 / close 160. The header is LTR and the filename is
   unicode-bidi plaintext — an RTL name must not send its extension flying
   to the wrong end (the BIDI rule that applies everywhere cargo is named).
   ============================================================ */

/**
 * A viewer item: stored media, or a picture that is not (yet) media — a
 * search result — which brings its own addresses. Additive: plain MediaRefs
 * behave exactly as before.
 */
export type ExpandedItem = MediaRef & {
  /** Full-size address, used instead of /ui/media/:id. */
  src?: string;
  /** Strip thumbnail address. */
  thumbSrc?: string;
  /** Shown when `src` fails to load (a source site walling us off). */
  fallbackSrc?: string;
};

function fullUrl(m: ExpandedItem): string {
  return m.src ?? mediaUrl(m.id);
}

function thumbUrl(m: ExpandedItem): string {
  return m.thumbSrc ?? (m.src && !m.thumbnail ? m.src : thumbSrc(m));
}

/** The full-size header can also offer the file itself. */
function downloadHref(m: ExpandedItem): string {
  return m.src ?? downloadUrl(m.id);
}

/** A swipe moves one image when it is longer than 50px and more sideways than down: left → next, right → back.
 *  Physical (left-to-right) steps; the viewer mirrors them in right-to-left, where the strip runs the other way. */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  return Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : -1) : 0;
}

/** One step from the SHOWN position: an index past the end of a shrunk list counts as its last item. */
export function stepIndex(index: number, d: number, count: number): number {
  const last = count - 1;
  return Math.min(last, Math.max(0, Math.min(index, last) + d));
}

export default function ExpandedMedia({
  items,
  startIndex,
  onClose,
  onShowInChat,
  actions,
}: {
  items: ExpandedItem[];
  startIndex: number;
  onClose: () => void;
  /** The media panel's "Show in chat" for the item on screen. */
  onShowInChat?: (index: number) => void;
  /** Extra header actions for the item on screen (a search picture's ATTACH, SOURCE). */
  actions?: Array<{ label: string; onSelect: (index: number) => void }>;
}) {
  const t = useT();
  const [index, setIndex] = useState(startIndex);
  const [closing, setClosing] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const last = items.length - 1;
  // Clamped: a list that shrinks while open shows its last item instead of vanishing (Codex review).
  const at = Math.min(index, last);
  const current = items[at];
  const step = (d: number) => setIndex((i) => stepIndex(i, d, items.length));

  function close() {
    // Let the 160ms close run before the node leaves the tree.
    setClosing(true);
    window.setTimeout(onClose, 160);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      // Arrows move the way the strip reads: right-to-left, the left arrow is "next".
      const forward = isRtl() ? -1 : 1;
      if (e.key === "ArrowRight") step(forward);
      if (e.key === "ArrowLeft") step(-forward);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  if (!current) return null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  // Portalled to <body>: inside the app canvas the viewer sat under the top bar, which covered
  // its X and Save. Out here it covers the whole screen, above everything. React events still bubble up the
  // component tree through a portal, so touches stop here and never reach the phone's edge-swipe Back.
  return createPortal(
    <div
      className={`expanded-media${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={current.originalName}
      onClick={(e) => {
        stop(e); // a backdrop click must not reach the bubble or card the viewer was opened from
        close();
      }}
      onTouchStart={(e) => {
        stop(e);
        touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchMove={stop}
      onTouchEnd={(e) => {
        stop(e);
        const t0 = touch.current;
        touch.current = null;
        const t1 = e.changedTouches[0];
        if (!t0 || !t1) return;
        const d = swipeStep(t1.clientX - t0.x, t1.clientY - t0.y);
        if (d) step(isRtl() ? -d : d);
      }}
    >
      <div className="expanded-header" onClick={stop}>
        <button type="button" className="expanded-close" onClick={close} aria-label={t("common.close")}>
          ✕
        </button>
        {/* LTR: the counter must not reorder around an RTL name. */}
        <span className="expanded-title" dir="ltr">
          <span className="expanded-name" dir="auto">{current.originalName}</span>
          {items.length > 1 && (
            <span className="expanded-count" dir="auto">
              {t("media.countOf", { at: at + 1, count: items.length })}
            </span>
          )}
        </span>
        {actions?.map((a) => (
          <button key={a.label} type="button" className="expanded-download" onClick={() => a.onSelect(at)}>
            {a.label}
          </button>
        ))}
        <a className="expanded-download" href={downloadHref(current)} download={current.originalName} aria-label={t("media.saveName", { name: current.originalName })}>
          {t("common.save")}
        </a>
      </div>

      <div className="expanded-stage" onClick={stop}>
        {items.length > 1 && (
          <>
            <button type="button" className="expanded-nav prev" aria-label={t("media.previous")} disabled={at === 0} onClick={() => step(-1)}>
              <span className="flip-rtl">‹</span>
            </button>
            <button type="button" className="expanded-nav next" aria-label={t("common.next")} disabled={at === last} onClick={() => step(1)}>
              <span className="flip-rtl">›</span>
            </button>
          </>
        )}
        {current.type === "image" ? (
          <img
            key={current.id}
            src={fullUrl(current)}
            alt={current.originalName}
            onError={(e) => {
              const fb = current.fallbackSrc;
              if (fb && e.currentTarget.src !== new URL(fb, location.href).href) e.currentTarget.src = fb;
            }}
          />
        ) : current.type === "video" ? (
          <video key={current.id} src={fullUrl(current)} controls autoPlay playsInline />
        ) : current.type === "audio" ? (
          <audio key={current.id} src={fullUrl(current)} controls autoPlay />
        ) : (
          <a className="expanded-doc" href={fullUrl(current)} target="_blank" rel="noopener noreferrer">
            {t("media.openName", { name: current.originalName })}
          </a>
        )}
      </div>

      {onShowInChat && (
        <div className="expanded-foot" onClick={stop}>
          <button type="button" className="expanded-download" onClick={() => onShowInChat(at)}>
            {t("media.showInChat")}
          </button>
        </div>
      )}

      {items.length > 1 && (
        <div className="expanded-strip" onClick={stop}>
          {items.map((m, i) => (
            <button
              type="button"
              key={m.id}
              className={`expanded-strip-item${i === at ? " is-current" : ""}`}
              onClick={() => setIndex(i)}
              aria-label={t("media.countOf", { at: i + 1, count: items.length })}
            >
              {m.type === "image" || (m.type === "video" && m.thumbnail) ? (
                <img src={thumbUrl(m)} alt="" />
              ) : (
                <span className="mono-label">{m.type === "video" ? t("media.typeVideo") : m.type === "audio" ? t("media.typeAudio") : t("media.typeDoc")}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
