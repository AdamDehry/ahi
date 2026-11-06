import sharp from "sharp";
import { resolveMedia, mediaRef, type MediaRef } from "../media-store.js";
import type { ScreenFrame } from "./screen-frame.js";

/* ============================================================
   call-drop.ts — drop an image, a link or a note into a live call
   (part six, 10/13 2:35 / 2:38 PM).

   From the call screen the owner can paste, drag or attach an image, or type /
   paste text (long links especially), without hanging up. A drop:
     - is saved to the chat thread like anything he sends in chat;
     - shows in the call transcript;
     - is held for a moment and PAIRED with what he says next: if he starts
       talking within the pairing window ("I just dropped you this link"),
       the drop rides that utterance as ONE turn; if he says nothing, it
       becomes its own turn when the window closes.
   The main model gets images inline (the screen-frame path: one stream-json
   message, scrubbed from the CLI transcript after the turn — the saved copy
   in chat is the one that is kept), and links/notes as text, which it opens
   like any chat link.
   ============================================================ */

export type CallDrop =
  | { kind: "text"; text: string }
  | { kind: "image"; media: MediaRef; frame: ScreenFrame; name: string };

/** How long a drop waits for him to start talking before it is its own turn. */
export function dropPairMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CALL_DROP_PAIR_MS);
  return Number.isFinite(n) && n >= 0 ? n : 4000;
}

/** Longest a drop may wait on speech that started but has not committed. */
export const DROP_MAX_WAIT_MS = 20_000;

/** DROP_MAX_WAIT_MS, overridable (CALL_DROP_MAX_WAIT_MS) like the pairing window. */
export function dropMaxWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CALL_DROP_MAX_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : DROP_MAX_WAIT_MS;
}

/** Longest a typed/pasted drop may be. A long link or a pasted paragraph fits. */
export const MAX_DROP_TEXT = 8000;

/* ── What may pile up before one turn (S3) ─────────────────────────
   Each drop was capped, but the batch was not: drops sent faster than the
   pairing window kept rearming it, nothing dispatched, and the eventual turn
   carried everything — memory and the model payload grew with every drop.
   Now a batch has a count, an image count, an image-byte and a text budget,
   and DROP_MAX_WAIT_MS is a hard age: rearming never pushes past it. A drop
   that would break a bound is refused to the app, not silently dropped. */
export const MAX_PENDING_DROPS = 6;
export const MAX_PENDING_DROP_IMAGES = 3;
/** Sum of the resized frames' bytes (each is ~1568 px JPEG, normally well under 1 MB). */
export const MAX_PENDING_DROP_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PENDING_DROP_TEXT = 16_000;
/** Images being read/resized at once, per call. */
export const MAX_CONCURRENT_DROP_LOADS = 2;

/** Why `incoming` cannot join the batch `pending`, in words for the app — or null. */
export function dropBatchRefusal(pending: CallDrop[], incoming: CallDrop[]): string | null {
  const all = [...pending, ...incoming];
  const images = all.filter((d): d is Extract<CallDrop, { kind: "image" }> => d.kind === "image");
  if (all.length > MAX_PENDING_DROPS) return `That's more than ${MAX_PENDING_DROPS} things at once. Give me a second with these first.`;
  if (images.length > MAX_PENDING_DROP_IMAGES) return `I can take ${MAX_PENDING_DROP_IMAGES} images at a time. Give me a second with these first.`;
  if (images.reduce((n, d) => n + d.frame.data.length, 0) > MAX_PENDING_DROP_IMAGE_BYTES) return "Those images are too large together. Send fewer at once.";
  if (all.reduce((n, d) => n + (d.kind === "text" ? d.text.length : 0), 0) > MAX_PENDING_DROP_TEXT) return "That's too much text at once. Send it in a moment.";
  return null;
}

/**
 * The next pairing-window delay: the usual `ms`, but never past the batch's
 * hard age — so a stream of drops cannot postpone the turn forever.
 */
export function dropWindowDelay(since: number, now: number, ms: number, maxWaitMs = dropMaxWaitMs()): number {
  return Math.max(0, Math.min(ms, since + maxWaitMs - now));
}

/** Model input edge: past 1568 the model downsizes anyway. */
const MODEL_EDGE = 1568;

/**
 * Load an uploaded image (the app uploads it save-only first) and make the
 * model's copy: auto-rotated, at most 1568 px on the long edge, JPEG. The
 * original stays as uploaded, in the user's files and the chat thread.
 */
export async function loadDropImage(userId: string, mediaId: string, userName = "the owner"): Promise<CallDrop | null> {
  const record = resolveMedia(userId, mediaId);
  if (!record || record.type !== "image") return null;
  const { data, info } = await sharp(record.path)
    .rotate()
    .resize({ width: MODEL_EDGE, height: MODEL_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  const media = mediaRef(record);
  return {
    kind: "image",
    media,
    name: media.originalName,
    frame: {
      mime: "image/jpeg",
      data,
      width: info.width,
      height: info.height,
      capturedAt: Date.now(),
      label: `${userName} dropped this image into the call: "${media.originalName}", also saved in the chat at ${record.path}`,
    },
  };
}

const LINK = /^https?:\/\/\S+$/i;

/** A short description for the call record and the front voice. */
export function dropSummary(drops: CallDrop[]): string {
  return drops
    .map((d) => (d.kind === "image" ? `[image: ${d.name}]` : LINK.test(d.text.trim()) ? `[link: ${d.text.trim()}]` : `[note: ${d.text.trim()}]`))
    .join(" ");
}

/**
 * The text half of a drop turn. Images travel as image blocks beside it;
 * links and notes are spelled out here.
 */
export function dropMessage(said: string, drops: CallDrop[], userName = "the owner"): string {
  const lines = drops.map((d) => {
    if (d.kind === "image") return `- an image, "${d.name}" (shown above)`;
    const t = d.text.trim();
    return LINK.test(t) ? `- a link: ${t}` : `- a note: «${t}»`;
  });
  const hasLink = drops.some((d) => d.kind === "text" && /https?:\/\//i.test(d.text));
  const head =
    `[During this call ${userName} dropped this in from the call screen (it is also saved in the chat):\n` +
    lines.join("\n") +
    "\n" +
    (hasLink ? "Open the link the way you would in chat if it matters to the answer. " : "") +
    "Answer out loud as usual.]";
  const words = said.trim()
    ? said.trim()
    : `(${userName === "the owner" ? "He" : "They"} didn't say anything with it. Say briefly what it is and what stands out, then stop.)`;
  return `${head}\n\n${words}`;
}
