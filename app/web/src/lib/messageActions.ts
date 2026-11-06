/**
 * Message actions — Copy / Share / Save audio.
 *
 * Everything here reaches the platform through `navigator`, `fetch`,
 * `document` and `URL` only, so the tests fake those globals and need no
 * production hook. Media is fetched over the same cookie-authed route the
 * player uses; a token never rides in a URL.
 */
import type { LocalMessage, MediaRef } from "./types";
import { BOT_LABELS } from "./types";
import { showToast } from "./toast";

/** the owner's zone. Filenames read like his clock, not the server's. */
export const OWNER_TZ = "America/New_York";

export function mediaUrl(id: string): string {
  return `/ui/media/${encodeURIComponent(id)}`;
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/oga": "ogg",
  "audio/opus": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/webm": "webm",
};

/** Extension from the stored mime, else from the original name, else ogg
 *  (what the gateway writes for voice — same table as voice-media.ts). */
export function audioExt(media: Pick<MediaRef, "mime" | "originalName">): string {
  const byMime = EXT_BY_MIME[(media.mime || "").split(";")[0].trim().toLowerCase()];
  if (byMime) return byMime;
  const fromName = /\.([a-z0-9]{2,4})$/i.exec(media.originalName || "")?.[1];
  return fromName ? fromName.toLowerCase() : "ogg";
}

/** "2026-10-08 2-31 AM" in America/New_York — no colon, so it is a legal
 *  filename on every OS the owner might save to. */
export function ownerStamp(ts: string | number | Date, timeZone = OWNER_TZ): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ts));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}-${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}

/** "2026-10-08 2-31 AM Michael voice note" — the extension comes from
 *  whichever file is actually delivered. An agent's note carries the agent's
 *  name; the owner's own note says whom it went to. */
export function voiceNoteBase(msg: Pick<LocalMessage, "timestamp" | "bot" | "direction">): string {
  const label = BOT_LABELS[msg.bot] ?? msg.bot;
  const who = msg.direction === "in" ? `voice note to ${label}` : `${label} voice note`;
  return `${ownerStamp(msg.timestamp)} ${who}`;
}

export function voiceNoteFilename(msg: Pick<LocalMessage, "timestamp" | "bot" | "direction">, ext: string): string {
  return `${voiceNoteBase(msg)}.${ext}`;
}

/** The one voice note a message carries, or null. Cargo (several
 *  attachments) is the sent grid's business, not a voice note. */
export function voiceMediaOf(msg: LocalMessage): MediaRef | null {
  if (msg.mediaList && msg.mediaList.length > 1) return null;
  return msg.media?.type === "voice" ? msg.media : null;
}

/** What Copy writes: the message's own text (markdown source); for a voice
 *  note its transcript. Empty → no Copy item. */
export function copyableText(msg: LocalMessage): string {
  const text = (msg.text ?? "").trim();
  if (text) return text;
  return (voiceMediaOf(msg)?.transcript ?? "").trim();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

/** Share a text message; where Web Share is missing (desktop Linux Chrome),
 *  copy it instead. A cancelled share sheet is a choice, not an error. */
export async function shareText(text: string): Promise<void> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (isAbort(err)) return;
    }
  }
  showToast((await copyText(text)) ? "Copied" : "Couldn't copy");
}

async function fetchFile(url: string, name: string, type: string): Promise<File> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`media ${res.status}`);
  const blob = await res.blob();
  return new File([blob], name, { type: (type || blob.type || "application/octet-stream").split(";")[0] });
}

// One in-flight fetch per note, started when the menu opens so the share
// sheet still has the tap's user activation by the time the File exists.
const pending = new Map<string, Promise<File>>();

/**
 * The file Share / Save hand over: the server's AAC .m4a copy (iPhones play
 * it; OGG they often don't). If conversion fails, the original note — a
 * playable-somewhere file beats an error.
 */
export function prefetchVoiceFile(media: MediaRef, base: string): Promise<File> {
  let p = pending.get(media.id);
  if (!p) {
    p = fetchFile(`${mediaUrl(media.id)}/m4a`, `${base}.m4a`, "audio/mp4").catch(() =>
      fetchFile(mediaUrl(media.id), `${base}.${audioExt(media)}`, media.mime || "audio/ogg"),
    );
    pending.set(media.id, p);
    // Keep only the latest few; a failure is never cached.
    p.catch(() => pending.delete(media.id));
    if (pending.size > 4) pending.delete(pending.keys().next().value as string);
  }
  return p;
}

export function downloadFile(file: Blob, filename: string): void {
  const href = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the browser has taken the download.
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

export async function saveVoice(media: MediaRef, base: string): Promise<void> {
  try {
    const file = await prefetchVoiceFile(media, base);
    downloadFile(file, file.name);
    showToast("Saved");
  } catch {
    showToast("Couldn't save the audio");
  }
}

/** Share the audio FILE; where files can't be shared, download it. */
export async function shareVoice(media: MediaRef, base: string): Promise<void> {
  let file: File;
  try {
    file = await prefetchVoiceFile(media, base);
  } catch {
    showToast("Couldn't load the audio");
    return;
  }
  const data = { files: [file], title: base };
  if (typeof navigator.share === "function" && navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
      return;
    } catch (err) {
      if (isAbort(err)) return;
      // e.g. NotAllowedError when the tap's activation ran out — fall through.
    }
  }
  downloadFile(file, file.name);
  showToast("Saved");
}

// ── Files: an mp3 Michael sent, a PDF, a photo ──────────────

/** The attachments the bubble menu offers to save/share: documents, audio
 *  and video. Not a voice note (it has Save audio) and not a photo — a photo
 *  keeps the platform's own long-press menu (Download image) and the viewer. */
export function filesOf(msg: LocalMessage): MediaRef[] {
  const list = msg.mediaList && msg.mediaList.length ? msg.mediaList : msg.media ? [msg.media] : [];
  return list.filter((m) => m.type !== "voice" && m.type !== "image");
}

/**
 * Save = the browser's own download of the server's attachment response, so
 * the file keeps its ORIGINAL name and extension ("Message-from-Michael.mp3")
 * and lands in Android's Downloads as a real file — no blob rename, no
 * re-encode.
 */
export function saveFile(media: MediaRef): void {
  const a = document.createElement("a");
  a.href = `${mediaUrl(media.id)}?dl=1`;
  a.download = media.originalName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function saveFiles(list: MediaRef[]): Promise<void> {
  for (const m of list) {
    saveFile(m);
    // Chrome drops back-to-back programmatic downloads without a beat between.
    if (list.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
  showToast(list.length > 1 ? `Saving ${list.length} files` : "Saving");
}

/** Share the original file(s); where files can't be shared, save them. */
export async function shareFiles(list: MediaRef[]): Promise<void> {
  let files: File[];
  try {
    files = await Promise.all(list.map((m) => fetchFile(mediaUrl(m.id), m.originalName, m.mime)));
  } catch {
    showToast("Couldn't load the file");
    return;
  }
  const data = { files };
  if (typeof navigator.share === "function" && navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
      return;
    } catch (err) {
      if (isAbort(err)) return;
    }
  }
  await saveFiles(list);
}
