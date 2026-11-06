/** Shared formatting for media cards and the media panel. */
import type { SyntheticEvent } from "react";

export function mediaUrl(id: string): string {
  return `/ui/media/${encodeURIComponent(id)}`;
}

/** Attachment-disposition URL: the server answers with the ORIGINAL name. */
export function downloadUrl(id: string): string {
  return `${mediaUrl(id)}?dl=1`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec)) return "";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** The address a chat tile or gallery tile shows first: the server's small thumbnail when there is one. */
export function thumbSrc(m: { id: string; thumbnail?: boolean }): string {
  return m.thumbnail ? `${mediaUrl(m.id)}/thumb` : mediaUrl(m.id);
}

/**
 * onLoad for a thumbnail: when the tile shows it at more than twice its real pixels (a tall page cropped to
 * a tile came out a blurry strip), swap once to the full image so the preview stays sharp.
 * Ordinary photos stay on the small thumbnail.
 */
export function sharpenOnLoad(e: SyntheticEvent<HTMLImageElement>, id: string): void {
  const img = e.currentTarget;
  const full = new URL(mediaUrl(id), location.href).href;
  if (!img.naturalWidth || img.src === full) return;
  const scale = Math.max(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight) * (window.devicePixelRatio || 1);
  if (scale > 2) img.src = full;
}
