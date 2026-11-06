import { useState } from "react";
import {
  ATTACHMENT_CAP,
  OVERLAP_AT,
  formatSize,
  shortMime,
  type StagedItem,
} from "../lib/staging";

/* ============================================================
   AttachmentShelf — design lock v4, deck pp.1–5.

   A SHELF, not a card: it lives inside the composer footer ABOVE the pill,
   separated by a 1px petrol α.18 top rule, with a mono count in petrol.

   THE ONE RULE EVERYTHING ELSE BENDS AROUND: height is a CONSTANT 84px
   (60 tile + 12 pad + label) and never animates, at any count. One file or
   ten, expanded or stacked — the composer does not move. That is why 5+
   items compress into an overlap stack rather than wrapping to a second row,
   and why expanding scrolls horizontally IN PLACE instead of opening a
   sheet or a drawer.

   Colour is state, never decoration: petrol = held, brass = said. So a tile
   being read wears petrol, and nothing in this shelf is ever brass — brass
   belongs to the send commit.
   ============================================================ */

function DocGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M4 1.5h5l3 3v10a0 0 0 0 1 0 0H4a0 0 0 0 1 0 0V1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M9 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

function RemoveButton({ onRemove, hidden }: { onRemove: () => void; hidden: boolean }) {
  // 20px circle on a 24px target, overlapping the corner. Hidden during a
  // drag so it can never be hit while reordering.
  return (
    <button
      type="button"
      className={`shelf-remove${hidden ? " is-hidden" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      aria-label="Remove attachment"
      tabIndex={hidden ? -1 : 0}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle cx="10" cy="10" r="10" />
        <path d="M6.8 6.8l6.4 6.4M13.2 6.8l-6.4 6.4" fill="none" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

function Tile({
  item,
  index,
  dragging,
  onRemove,
  onDragStart,
  onDragEnter,
  onDragEnd,
}: {
  item: StagedItem;
  index: number;
  dragging: number | null;
  onRemove: () => void;
  onDragStart: (i: number) => void;
  onDragEnter: (i: number) => void;
  onDragEnd: () => void;
}) {
  const isHeld = dragging === index;
  const anyDrag = dragging !== null;
  return (
    <div
      className={
        `shelf-tile shelf-tile--${item.kind} is-${item.state}` +
        `${isHeld ? " is-held" : ""}${anyDrag && !isHeld ? " is-vacated" : ""}`
      }
      draggable
      onDragStart={() => onDragStart(index)}
      onDragEnter={() => onDragEnter(index)}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      title={item.error ? `${item.name} — ${item.error}` : item.name}
    >
      {item.kind === "image" && item.previewUrl ? (
        <img className="shelf-thumb" src={item.previewUrl} alt="" draggable={false} />
      ) : (
        // Docs get a typed card, never a thumbnail-of-nothing.
        <div className="shelf-doc">
          <span className="shelf-doc-glyph">
            <DocGlyph />
          </span>
          {/* unicode-bidi: plaintext so an RTL filename keeps its extension
              in place; mime and size stay LTR. */}
          <span className="shelf-doc-name mono-label">{item.name}</span>
          <span className="shelf-doc-meta mono-label">
            {shortMime(item.mime, item.name)}·{formatSize(item.size)}
          </span>
        </div>
      )}
      <RemoveButton onRemove={onRemove} hidden={anyDrag} />
    </div>
  );
}

export default function AttachmentShelf({
  items,
  onRemove,
  onReorder,
}: {
  items: StagedItem[];
  onRemove: (localId: string) => void;
  onReorder: (from: number, to: number) => void;
}) {
  // 5+ compresses to an overlap stack; tapping expands it into a horizontal
  // scroller in THIS shelf. Never a second row, never a sheet.
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);

  if (!items.length) return null;

  const atCap = items.length >= ATTACHMENT_CAP;
  // Files that failed to upload cannot travel. They are called out here in
  // the warn grammar rather than vanishing at send — cargo is never dropped
  // without the user being told.
  const failed = items.filter((i) => i.state === "failed").length;
  const reading = items.filter((i) => i.state === "reading").length;
  const stacked = items.length >= OVERLAP_AT && !expanded;
  const shown = stacked ? items.slice(0, 4) : items;
  const tail = items.length - shown.length;

  function handleDragEnter(i: number) {
    if (dragging === null || dragging === i) return;
    onReorder(dragging, i);
    setDragging(i);
  }

  return (
    <div className="attach-shelf" data-count={items.length}>
      <div className="shelf-count-row">
        <span className="shelf-count mono-label">
          {items.length} {items.length === 1 ? "FILE" : "FILES"}
        </span>
        {/* Cap note is INLINE and in warn — never a toast, never a dialog. */}
        {atCap && <span className="shelf-cap-note mono-label">MAX {ATTACHMENT_CAP} PER MESSAGE</span>}
        {reading > 0 && <span className="shelf-reading-note mono-label">READING {reading}…</span>}
        {failed > 0 && (
          <span className="shelf-cap-note mono-label">
            {failed} FAILED · WON'T SEND — REMOVE
          </span>
        )}
      </div>

      <div className={`shelf-row${stacked ? " is-stacked" : ""}${expanded ? " is-expanded" : ""}`}>
        {shown.map((item, i) => (
          <Tile
            key={item.localId}
            item={item}
            index={i}
            dragging={dragging}
            onRemove={() => onRemove(item.localId)}
            onDragStart={setDragging}
            onDragEnter={handleDragEnter}
            onDragEnd={() => setDragging(null)}
          />
        ))}
        {stacked && tail > 0 && (
          <button
            type="button"
            className="shelf-more mono-label"
            onClick={() => setExpanded(true)}
            aria-label={`Show all ${items.length} attachments`}
          >
            +{tail}
          </button>
        )}
      </div>
    </div>
  );
}
