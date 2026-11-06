import { useEffect, useRef, useState } from "react";
import type { SearchCardMeta } from "../../lib/types";
import { attachPicture, pictureSrc, requestStage, usageLine } from "../../lib/search";
import { copyText } from "../../lib/messageActions";
import { showToast } from "../../lib/toast";
import ExpandedMedia, { type ExpandedItem } from "../ExpandedMedia";
import ContextMenu from "../ContextMenu";
// Its stylesheet, ./search-card.css, is imported once by the shell (main.tsx),
// like every stylesheet here: Node-run UI tests import this file and cannot load CSS.

/* ============================================================
   SearchCard — inline web / image results in the thread (10/21).

   Self-contained on purpose (10/21): one component and its own
   stylesheet, which reads ONLY design tokens through local --asc-* aliases
   with fallbacks for both the current shell's names (--text-body,
   --surface-dim, --accent-strong) and the redesign's (--ink, --raised,
   --accent). It drops into the new shell unchanged. Its only app imports are
   the viewer (ExpandedMedia), the context menu, toast and the search client.

   Pictures never load from their own sites (CSP img-src 'self'): every one
   comes through the gateway's proxy by (card, index).

   Images: a tight grid (3 across on a phone, 5 on a wide column), tap to
   open the viewer, long-press / right-click for Attach · Open source · Copy
   link. Attach saves the picture into the chat files and stages it in the
   composer like any attached file. Web: rows of favicon · domain · title ·
   snippet, links open in a new tab.
   ============================================================ */

const LONG_PRESS_MS = 500;
const MOVE_SLOP = 10;
const WEB_FIRST = 5;

function formatTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const Glyph = () => (
  <svg className="asc-glyph" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="7" cy="7" r="4.2" />
    <line x1="10.2" y1="10.2" x2="13.8" y2="13.8" />
  </svg>
);

export interface SearchCardProps {
  card: SearchCardMeta;
  /** The card's message id — how the gateway finds its pictures. */
  messageId: string;
  /** The chat it lives in. */
  bot: string;
  /** Display name of whoever ran it ("the owner", "Michael"). */
  byLabel: string;
}

export default function SearchCard({ card, messageId, bot, byLabel }: SearchCardProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number; touch: boolean } | null>(null);
  const [showAllWeb, setShowAllWeb] = useState(false);
  const images = card.images ?? [];
  const web = card.web ?? [];
  const count = card.kind === "images" ? images.length : web.length;

  async function attach(index: number) {
    const img = images[index];
    if (!img) return;
    showToast("Adding the picture…", 4000);
    const r = await attachPicture(bot, messageId, index);
    if (!r.ok) {
      showToast(r.error, 2600);
      return;
    }
    const taken = requestStage({
      bot,
      mediaId: r.media.id,
      name: r.media.originalName,
      mime: r.media.mime,
      size: r.media.size,
      previewUrl: pictureSrc(bot, messageId, index, "thumb"),
    });
    showToast(taken ? "Added to your message" : "Saved to Files");
  }

  function openSource(index: number) {
    const link = images[index]?.link;
    if (link) window.open(link, "_blank", "noopener,noreferrer");
  }

  const viewerItems: ExpandedItem[] = images.map((img, i) => ({
    id: `${messageId}:${i}`,
    type: "image",
    path: "",
    originalName: img.title ? `${img.title} — ${img.domain}` : img.domain,
    mime: "image/jpeg",
    size: 0,
    src: pictureSrc(bot, messageId, i, "full"),
    thumbSrc: pictureSrc(bot, messageId, i, "thumb"),
    fallbackSrc: pictureSrc(bot, messageId, i, "thumb"),
  }));

  const usage = usageLine(card);
  const visibleWeb = showAllWeb ? web : web.slice(0, WEB_FIRST);

  return (
    <section className="ahi-search-card" data-kind={card.kind} aria-label={`${card.kind === "images" ? "Pictures" : "Web results"} for ${card.query}`}>
      <div className="asc-head">
        <Glyph />
        <span className="asc-query" dir="auto">
          {card.query}
        </span>
        <span className="asc-kind">{card.kind === "images" ? "Pictures" : "Web"}</span>
      </div>

      {count === 0 ? (
        <p className="asc-empty">Nothing came back for this search.</p>
      ) : card.kind === "images" ? (
        <div className="asc-grid" data-count={images.length}>
          {images.map((img, i) => (
            <PictureTile
              key={i}
              src={pictureSrc(bot, messageId, i, "thumb")}
              alt={img.title || img.domain}
              domain={img.domain}
              more={images.length - 9}
              index={i}
              onOpen={() => setOpen(i)}
              onMenu={(x, y, touch) => setMenu({ x, y, index: i, touch })}
            />
          ))}
        </div>
      ) : (
        <ol className="asc-web">
          {visibleWeb.map((r, i) => (
            <li key={r.link + i}>
              <a className="asc-row" href={r.link} target="_blank" rel="noopener noreferrer">
                <span className="asc-row-meta">
                  <Favicon src={r.favicon ? pictureSrc(bot, messageId, i, "icon") : null} domain={r.domain} />
                  <span className="asc-domain">{r.domain}</span>
                  {r.date && <span className="asc-date">{r.date}</span>}
                </span>
                <span className="asc-title" dir="auto">
                  {r.title}
                </span>
                {r.snippet && (
                  <span className="asc-snippet" dir="auto">
                    {r.snippet}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ol>
      )}
      {card.kind === "web" && web.length > WEB_FIRST && (
        <button type="button" className="asc-more" onClick={() => setShowAllWeb((v) => !v)} aria-expanded={showAllWeb}>
          {showAllWeb ? "Show fewer" : `Show ${web.length - WEB_FIRST} more`}
        </button>
      )}

      <div className="asc-foot">
        <span>
          {byLabel} · {formatTime(card.at)}
        </span>
        <span title={card.cached ? "A repeat within 24 hours: answered from the cache, no search spent" : "Searches run this month"}>
          {[card.cached ? "Saved" : "", usage].filter(Boolean).join(" · ")}
        </span>
      </div>

      {open !== null && (
        <ExpandedMedia
          items={viewerItems}
          startIndex={open}
          onClose={() => setOpen(null)}
          actions={[
            { label: "ATTACH", onSelect: (i) => void attach(i) },
            { label: "SOURCE", onSelect: openSource },
          ]}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          autoFocus={!menu.touch}
          onClose={() => setMenu(null)}
          items={[
            { label: "Attach to message", onSelect: () => void attach(menu.index) },
            { label: "Open source page", onSelect: () => openSource(menu.index) },
            {
              label: "Copy picture link",
              onSelect: () => void copyText(images[menu.index]?.imageUrl ?? "").then((ok) => showToast(ok ? "Link copied" : "Couldn't copy")),
            },
          ]}
        />
      )}
    </section>
  );
}

/** One thumbnail: tap opens, long-press / right-click opens the menu. */
function PictureTile({
  src,
  alt,
  domain,
  more,
  index,
  onOpen,
  onMenu,
}: {
  src: string;
  alt: string;
  domain: string;
  /** Pictures past the ninth (hidden on a narrow card): shown as "+n" on the ninth. */
  more: number;
  index: number;
  onOpen: () => void;
  onMenu: (x: number, y: number, touch: boolean) => void;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "broken">("loading");
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const fired = useRef(false);

  useEffect(() => () => {
    if (press.current) window.clearTimeout(press.current.timer);
  }, []);

  function cancel() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  return (
    <button
      type="button"
      className={`asc-tile is-${state}`}
      data-more={index === 8 && more > 0 ? `+${more}` : undefined}
      aria-label={`Open picture ${index + 1}: ${alt}`}
      onClick={(e) => {
        if (fired.current) {
          fired.current = false;
          e.preventDefault();
          return;
        }
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
        if (fired.current) return;
        onMenu(e.clientX, e.clientY, false);
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        fired.current = false;
        const { clientX: x, clientY: y } = e;
        press.current = {
          x,
          y,
          timer: window.setTimeout(() => {
            fired.current = true;
            press.current = null;
            onMenu(x, y, true);
          }, LONG_PRESS_MS),
        };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_SLOP) cancel();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
    >
      <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} onLoad={() => setState("loaded")} onError={() => setState("broken")} />
      {state === "broken" && <span className="asc-tile-fallback">{domain}</span>}
    </button>
  );
}

/** A site's favicon through the proxy; its first letter when there is none. */
function Favicon({ src, domain }: { src: string | null; domain: string }) {
  const [broken, setBroken] = useState(!src);
  return (
    <span className="asc-favicon" aria-hidden="true">
      {broken || !src ? <span>{(domain[0] ?? "·").toUpperCase()}</span> : <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />}
    </span>
  );
}
