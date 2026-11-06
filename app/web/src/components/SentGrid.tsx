import { memo, useState } from "react";
import type { MediaRef } from "../lib/types";
import { IconFiles } from "./icons";
import ExpandedMedia from "./ExpandedMedia";
import AudioFile from "./AudioFile";
import VideoFile from "./VideoFile";

/* ============================================================
   SentGrid — design lock v4, frame 4E (sent grid) + 4F (sent mixed).

   Cargo that has been SENT. Layout is decided by count, not by a generic
   flow, because the lock specifies each case:

     1     natural aspect, capped at 296
     2     equal pair
     3     wide over two
     4     2×2
     5–10  2×2 with the 4th tile scrimmed + a mono +N

   3px inset, 2px gutters, tile radius 11 outer / 3 inner, tiles never
   below 44px.

   4F (mixed): images collage first, then full-width doc rows, then the
   caption last in body type — so the words never arrive detached from the
   cargo they were sent with.
   ============================================================ */

function mediaUrl(id: string): string {
  return `/ui/media/${encodeURIComponent(id)}`;
}

function imageSrc(m: MediaRef): string {
  return m.thumbnail ? `${mediaUrl(m.id)}/thumb` : mediaUrl(m.id);
}

/** Grid shape token for CSS. 5–10 all share the 2×2 + overflow treatment. */
function layoutFor(count: number): string {
  if (count <= 1) return "one";
  if (count === 2) return "two";
  if (count === 3) return "three";
  if (count === 4) return "four";
  return "many";
}

const SentGrid = memo(function SentGrid({ items }: { items: MediaRef[] }) {
  // 4G: tapping a tile opens the full view over the whole message's cargo,
  // so the filmstrip can move between siblings without returning to the thread.
  const [expandedAt, setExpandedAt] = useState<number | null>(null);

  if (!items.length) return null;

  const images = items.filter((m) => m.type === "image");
  const docs = items.filter((m) => m.type !== "image");

  // 5–10: four tiles are shown and the 4th carries the overflow count.
  const shown = images.length > 4 ? images.slice(0, 4) : images;
  const overflow = images.length - shown.length;

  return (
    <div className="sent-cargo">
      {shown.length > 0 && (
        <div className={`sent-grid sent-grid--${layoutFor(images.length)}`}>
          {shown.map((m, i) => {
            const isOverflowTile = overflow > 0 && i === shown.length - 1;
            return (
              <button
                type="button"
                key={m.id}
                className={`sent-tile${isOverflowTile ? " is-overflow" : ""}`}
                onClick={() => setExpandedAt(images.indexOf(m))}
                aria-label={m.originalName}
              >
                <img src={imageSrc(m)} alt={m.originalName} loading="lazy" />
                {isOverflowTile && <span className="sent-overflow mono-label">+{overflow}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* 4F: docs are full-width rows under the collage, never squeezed into
          the image grid — a document is not a picture of itself. */}
      {docs.map((m) =>
        m.type === "audio" ? (
          <AudioFile key={m.id} media={m} />
        ) : m.type === "video" ? (
          <VideoFile key={m.id} media={m} />
        ) : (
        <a
          key={m.id}
          className="sent-doc-row"
          href={mediaUrl(m.id)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="sent-doc-glyph">
            <IconFiles />
          </span>
          {/* BIDI: filename plaintext so extensions never jump; size LTR. */}
          <span className="sent-doc-name">{m.originalName}</span>
          <span className="sent-doc-size mono-label">{formatSize(m.size)}</span>
        </a>
        ),
      )}
      {expandedAt !== null && (
        <ExpandedMedia items={images} startIndex={expandedAt} onClose={() => setExpandedAt(null)} />
      )}
    </div>
  );
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default SentGrid;
