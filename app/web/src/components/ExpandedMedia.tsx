import { useEffect, useState } from "react";
import type { MediaRef } from "../lib/types";

/* ============================================================
   ExpandedMedia — design lock v4, frame 4G (expanded view).

   Tap a sent tile and it opens full-view on #121316 with a mono header
   "n OF n · FILENAME" and a filmstrip of its siblings, so moving between
   the files of one message never means going back out to the thread.

   Open 200 / close 160. The header is LTR and the filename is
   unicode-bidi plaintext — an RTL name must not send its extension flying
   to the wrong end (the BIDI rule that applies everywhere cargo is named).
   ============================================================ */

function mediaUrl(id: string): string {
  return `/ui/media/${encodeURIComponent(id)}`;
}

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
  if (m.thumbSrc) return m.thumbSrc;
  return m.thumbnail ? `${mediaUrl(m.id)}/thumb` : fullUrl(m);
}

/** The full-size header can also offer the file itself. */
function downloadHref(m: ExpandedItem): string {
  return m.src ?? `${mediaUrl(m.id)}?dl=1`;
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
  const [index, setIndex] = useState(startIndex);
  const [closing, setClosing] = useState(false);
  const current = items[index];

  function close() {
    // Let the 160ms close run before the node leaves the tree.
    setClosing(true);
    window.setTimeout(onClose, 160);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") setIndex((i) => Math.min(items.length - 1, i + 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  if (!current) return null;

  return (
    <div
      className={`expanded-media${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      onClick={close}
    >
      <div className="expanded-header mono-label">
        {/* LTR: the counter and separator must not reorder around an RTL name. */}
        <span dir="ltr">
          {index + 1} OF {items.length} ·{" "}
          <span className="expanded-name">{current.originalName}</span>
        </span>
        {onShowInChat && (
          <button
            type="button"
            className="expanded-download"
            onClick={(e) => {
              e.stopPropagation();
              onShowInChat(index);
            }}
          >
            SHOW IN CHAT
          </button>
        )}
        {actions?.map((a) => (
          <button
            key={a.label}
            type="button"
            className="expanded-download"
            onClick={(e) => {
              e.stopPropagation();
              a.onSelect(index);
            }}
          >
            {a.label}
          </button>
        ))}
        <a
          className="expanded-download"
          href={downloadHref(current)}
          download={current.originalName}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Download ${current.originalName}`}
        >
          SAVE
        </a>
        <button type="button" className="expanded-close" onClick={close} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="expanded-stage" onClick={(e) => e.stopPropagation()}>
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
            Open {current.originalName}
          </a>
        )}
      </div>

      {items.length > 1 && (
        <div className="expanded-strip" onClick={(e) => e.stopPropagation()}>
          {items.map((m, i) => (
            <button
              type="button"
              key={m.id}
              className={`expanded-strip-item${i === index ? " is-current" : ""}`}
              onClick={() => setIndex(i)}
              aria-label={`${i + 1} of ${items.length}`}
            >
              {m.type === "image" || (m.type === "video" && m.thumbnail) ? (
                <img src={thumbUrl(m)} alt="" />
              ) : (
                <span className="mono-label">{m.type === "video" ? "VIDEO" : m.type === "audio" ? "AUDIO" : "DOC"}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
