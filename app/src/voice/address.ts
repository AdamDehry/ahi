/* ============================================================
   address.ts — "was that for me?", the two cheapest rules (slice 1).

   ALWAYS-ON-VOICE.md §3 layer 3 grows the ack judge a third verdict, ASIDE:
   an utterance that reached the recognizer on an open floor but was not said
   to Michael — the other half of a conversation in the room. The full judge
   (thread context, diarization, register) is slice 2. This file is the two
   rules that need no model and no context, in order:

     1. starts with the name                       → ADDRESSED, always
     2. contains a second speaker's reply          → ASIDE

   Rule 2, lexically: two people talking inside one utterance leaves a seam
   the recognizer cannot hide — a question answered mid-sentence ("…did you
   eat? yeah I had…"), a reply-opener after a full stop ("…tomorrow. No, I
   told him…"), or the utterance opening by addressing someone else by name
   ("a family member, can you…"). Nothing else is an aside: false silence is worse than
   a short line (same principle as the ack gate), so anything not caught by
   rule 2 is ADDRESSED.

   An aside is logged content-free (`[address] … aside (reason)`), shown
   greyed on the call screen as "(not for me)", and never reaches the ack
   gate, the turn gate, the transcript or the thread (§6: asides are not kept).
   ============================================================ */

import { normalizeWords, wakeNameAt } from "./floor.js";

export type AddressVerdict =
  | { addressed: true; reason: "name" | "default" }
  | { addressed: false; reason: "second-speaker" | "other-party" };

/** Words a second person answers with, at the start of their turn. */
const REPLY_OPENERS = new Set([
  "yeah", "yes", "yep", "yup", "no", "nope", "nah", "sure", "okay", "ok", "fine", "maybe", "probably",
  "i", "we", "he", "she", "they", "it", "that", "well", "oh", "right", "exactly", "totally", "honestly",
]);

/**
 * Names and vocatives that mean "I'm talking to someone else". Agents' names
 * are not here on purpose. Extend per household with CALL_ROOM_NAMES
 * ("family,miriam's mom"), lowercase, comma-separated.
 */
const ROOM_VOCATIVES = ["mom", "dad", "mommy", "daddy", "honey", "babe", "baby", "sweetie", "guys", "everyone", "everybody", "kids", "buddy", "bro", "dude", "sir", "ma'am"];
/** A phone being answered next to the mic: "Hello?" — the question mark is the tell. */
const PHONE_ANSWER = /^(hello|hi|hey|yes)\?\s*$/i;

export function roomNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.CALL_ROOM_NAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...ROOM_VOCATIVES, ...extra])];
}

/**
 * Rule 2: a second speaker's reply inside the utterance.
 *   (a) a sentence boundary followed by a reply-opener, with real words on
 *       both sides — a question or statement, then someone answering it;
 *   (b) it opens by addressing another person by name or vocative.
 */
export function secondSpeakerReason(text: string, names: string[] = roomNames()): "second-speaker" | "other-party" | null {
  const raw = text.trim();
  if (!raw) return null;
  const words = normalizeWords(raw);
  // (b) "a family member, …" / "Hello?" (a phone being answered next to the mic).
  if (PHONE_ANSWER.test(raw)) return "other-party";
  const first = words[0];
  if (first && names.includes(first) && words.length >= 1 && (words.length === 1 || /^[a-z' ]+[,!?]/i.test(raw) || raw.toLowerCase().startsWith(`${first} `))) {
    if (words.length === 1 || /^[^,.!?]*[,!?]/.test(raw)) return "other-party";
  }
  // (a) sentence boundary → reply opener, with at least two words before and after.
  const sentences = raw.split(/(?<=[.!?])\s+/).map((s) => normalizeWords(s)).filter((s) => s.length > 0);
  if (sentences.length < 2) return null;
  const questionFirst = /\?/.test(raw.split(/(?<=[.!?])\s+/)[0] ?? "");
  for (let i = 1; i < sentences.length; i++) {
    const before = sentences.slice(0, i).reduce((n, s) => n + s.length, 0);
    const after = sentences[i];
    // After a question, even a one-word "Yeah." is somebody answering it.
    if (before < 2 || after.length < (questionFirst ? 1 : 2)) continue;
    const opener = after[0];
    // A plain "I …" after a statement is how one person keeps talking; after a
    // QUESTION it is how a second person answers it.
    const strong = opener !== "i" && opener !== "we" && opener !== "it" && opener !== "that" && opener !== "well" && opener !== "oh";
    if (REPLY_OPENERS.has(opener) && (strong || questionFirst)) return "second-speaker";
  }
  return null;
}

/**
 * The two rules, in order. `addressedByName` short-circuits everything: a
 * sentence that starts with his name is for him however it continues.
 */
export function judgeAddress(text: string, names: string[] = roomNames(), env: NodeJS.ProcessEnv = process.env): AddressVerdict {
  if (wakeNameAt(text) >= 0) return { addressed: true, reason: "name" };
  // CALL_ASIDE=off: every open-floor line is for Michael (lines of his were marked aside).
  const v = (env.CALL_ASIDE ?? "on").toLowerCase();
  if (v === "off" || v === "false" || v === "0") return { addressed: true, reason: "default" };
  const second = secondSpeakerReason(text, names);
  if (second) return { addressed: false, reason: second };
  return { addressed: true, reason: "default" };
}

/** One `[address]` line, content-free: the verdict, the reason, the time. */
export function formatAddress(voiceStreamId: string, v: AddressVerdict | { addressed: false; reason: "standby-no-name" }, ms: number): string {
  return `[address] ${voiceStreamId} ${v.addressed ? "addressed" : "aside"} (${v.reason}) ${Math.max(0, Math.round(ms))}ms`;
}
