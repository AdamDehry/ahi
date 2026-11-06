/* ============================================================
   staging.ts — staged attachment cargo (design lock v4, deck pp.1–5).

   THE MODEL CHANGE. Before this, attaching a file uploaded it immediately
   and fired its own agent turn: three files meant three messages and three
   turns, and a typed caption arrived separately as a fourth. The lock is
   explicit that words + cargo travel as ONE message. So attaching now only
   STAGES: the bytes go up right away (so the upload happens while the user
   is still typing, and the tile can show its reading state), but no message
   is broadcast and no agent turn runs until send.

   Staging reuses POST /ui/upload WITHOUT a `bot` field — that path already
   saves the file and registers it as media without broadcasting or invoking
   anything, and hands back the MediaRef we quote at send time. No new
   endpoint, and no second way to register media.

   Order is send order: this array IS the order, and drag-reorder mutates it.
   ============================================================ */

export type StagedKind = "image" | "doc";

/**
 * `reading` covers upload + server-side registration. The lock's reading
 * state (petrol border + wash, breathing) runs for exactly this window and
 * settles to a hairline when ready. Brass never appears here — brass waits
 * for send.
 */
export type StagedState = "reading" | "ready" | "failed";

export interface StagedItem {
  /** Client-side identity; stable across reorder. */
  localId: string;
  name: string;
  mime: string;
  size: number;
  kind: StagedKind;
  state: StagedState;
  /** Object URL for image tiles. Revoked on removal. */
  previewUrl?: string;
  /** Server media id, quoted to /app/send once ready. */
  mediaId?: string;
  error?: string;
}

/** Cap 10 per message — the lock's number, enforced inline, never a toast. */
export const ATTACHMENT_CAP = 10;

/** Above this count the row compresses to an overlap stack (4 shown + N). */
export const OVERLAP_AT = 5;

export function isImageMime(mime: string, name: string): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp|svg)$/i.test(name);
}

/** "1.4 MB" — mono metadata under a doc card. Always LTR (BIDI rule). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short mime for the doc card's second line: "application/pdf" → "PDF". */
export function shortMime(mime: string, name: string): string {
  const ext = name.includes(".") ? name.split(".").pop() : "";
  if (ext) return ext.toUpperCase();
  const tail = mime.split("/").pop() ?? mime;
  return tail.toUpperCase();
}

let seq = 0;
function nextLocalId(): string {
  seq += 1;
  return `stage-${Date.now().toString(36)}-${seq}`;
}

export function makeStagedItem(file: File): StagedItem {
  const kind: StagedKind = isImageMime(file.type, file.name) ? "image" : "doc";
  return {
    localId: nextLocalId(),
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    kind,
    state: "reading",
    previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
  };
}

/**
 * Upload one staged file. Resolves to the server media id, or an error.
 *
 * Deliberately hits /ui/upload with no `bot`: that is the save-only branch,
 * so nothing is broadcast and no turn runs.
 */
export async function uploadStaged(
  file: File,
): Promise<{ ok: true; mediaId: string } | { ok: false; error: string }> {
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/ui/upload", { method: "POST", body: form });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: err.error || `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { media?: { id?: string } };
    const id = body.media?.id;
    if (!id) return { ok: false, error: "no media id returned" };
    return { ok: true, mediaId: id };
  } catch {
    return { ok: false, error: "network" };
  }
}

/** Release an item's object URL. Safe to call twice. */
export function releaseStaged(item: StagedItem): void {
  if (item.previewUrl) {
    try {
      URL.revokeObjectURL(item.previewUrl);
    } catch {
      /* already revoked */
    }
  }
}

/** Move an item within the cargo. Order is send order. */
export function reorder(items: StagedItem[], from: number, to: number): StagedItem[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Ids to quote at send, in send order. Only ready items can travel. */
export function readyMediaIds(items: StagedItem[]): string[] {
  return items.filter((i) => i.state === "ready" && i.mediaId).map((i) => i.mediaId as string);
}
