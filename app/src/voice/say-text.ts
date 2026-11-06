/* ============================================================
   say-text.ts — the last rewrite before any text reaches a TTS engine.

   The engines read every period as a sentence end and pause on it. The owner,
   10/14, on a voice note: "there's a Y. Orzechowitz Costco card" came out as
   "there's a Y." <pause> "Orzechowitz Costco card" — the main issue was never
   pause LENGTH, it was pauses in the wrong PLACE. The call splitter already
   keeps "Y. Orzechowitz" in one piece (speech-boundary.ts); the period inside
   the piece still made the engine stop.

   Applied once to every string sent to a TTS provider: voice notes at
   voice-out.ts's one choke point (all providers), call pieces where the
   spoken feed hands them to the call stream (voice-tts-stream.ts). Two rules,
   conservative — everything else passes through byte-identical:

     1. An initial before a name loses its period: "Y. Orzechowitz" →
        "Y Orzechowitz", "A. B. Cohen" → "A B Cohen", "J. כהן" → "J כהן".
        The decision is the splitter's own (`capitalKind`), so a call cuts
        and speaks one way: "Plan B.", "vitamin D. Get…", "Plan B. Then…",
        "…you and I. Then", a list letter ("A. The cheaper one") and a
        capital before a line break keep theirs.
     2. A numbered line ("1. Buy milk") keeps its number with a comma:
        "1, Buy milk" — not "one." <pause>. Only where the SOURCE has a line
        start: a call piece that began mid-line ("…count? " | "7. That's
        all.") passes `lineStart: false` (review round 2).

   Titles and dotted abbreviations (Dr., a.m., e.g., U.S.) are untouched: the
   engines read those correctly. Hebrew text is untouched: rule 1 needs a
   Latin capital, rule 2 a Latin letter after the number.
   ============================================================ */

import { capitalKind } from "./speech-boundary.js";

/** A single capital and its period, standing as its own token, before spaces (not a line break) and a name-like word. */
const INITIAL = /(?<=^|[\s("'“‘[])([A-Z])\.(?=[ \t]+["'“‘(]?(?:\p{Lu}|(?!\p{Script=Latin})\p{L}))/gu;
/** A one- or two-digit list number opening a line, before a Latin word. */
const LIST_LINE = /(?<=^|\n)([ \t]*\d{1,2})\.(?=[ \t]+[A-Za-z])/g;

export interface SayTextOptions {
  /** Does `text` begin at a line start in its source? False for a call piece cut mid-line. Default true. */
  lineStart?: boolean;
}

/** `text` as it should be handed to a TTS engine. Returns `text` itself when nothing applies. */
export function sayText(text: string, { lineStart = true }: SayTextOptions = {}): string {
  const out = text
    .replace(INITIAL, (match, letter: string, at: number, whole: string) =>
      capitalKind(whole, at, true) === "initial" ? letter : match,
    )
    .replace(LIST_LINE, (match, marker: string, at: number) => (at === 0 && !lineStart ? match : `${marker},`));
  return out === text ? text : out;
}

/**
 * The debug line for a rewrite: lengths and counts only, never the text
 * (it is the user's words). Silent unless SAY_TEXT_DEBUG is set.
 */
export function logSayText(where: string, before: string, after: string): void {
  if (before === after || !process.env.SAY_TEXT_DEBUG) return;
  const periods = (s: string) => (s.match(/\./g) ?? []).length;
  console.debug(
    `[say-text] ${where}: ${before.length}→${after.length} chars, ${periods(before) - periods(after)} period(s) rewritten`,
  );
}
