/* ============================================================
   speech-boundary.ts — where a call's answer may be cut into spoken pieces.

   Each piece of a call answer is synthesized on its own, so every cut is an
   audible seam: the voice ends the piece as if the thought were finished,
   then starts the next one fresh. The owner heard it as Michael pausing at the
   wrong points ("…for Tzali's feed. So," <pause> "and then…"). The old rule
   cut at any period-plus-space — "Dr. ", "option 1. ", "Wait... " — and,
   failing that, at whatever space sat nearest 120 characters, which could be
   right after "So," or "and" (call-pauses diagnosis, 10/14).

   The rules here, in order of preference:
     1. SENTENCE. A real sentence end: . ! ? (with any closing quote or
        bracket) and the whitespace after it. Not after a title ("Dr. "),
        dotted abbreviations ("p.m. ", "e.g. "), an ellipsis ("Wait... "),
        an initial before its name ("J. Smith"), or a list number that OPENS
        its clause ("1. Buy milk"). A number or capital that CLOSES its
        clause ends the sentence: "I'll call at 7." / "Plan B." (10/14,
        call-boundary-list-number — see `capitalKind`).
     2. CLAUSE. A sentence still going past CLAUSE_ESCAPE_CHARS may be cut at
        a comma, semicolon, colon, dash or ellipsis — never one that leaves
        the piece ending on a dangling word ("So,", "and", "to", "the", "Dr.")
        and never a piece shorter than MIN_CLAUSE_CHARS.
     3. CAP. Only past HARD_CAP_CHARS with no clause in sight: the last space
        that does not leave a dangling word, so a stalled stream can never
        hold the voice forever.
   There is deliberately NO timer: a wait in the agent's text never flushes a
   partial sentence — that would reproduce exactly the defect (diagnosis #2).
   ============================================================ */

/** A sentence longer than this may be cut at a safe clause. The old arbitrary-space escape sat here. */
export const CLAUSE_ESCAPE_CHARS = 120;
/** A clause cut never makes a piece shorter than this. */
export const MIN_CLAUSE_CHARS = 40;
/** Past this, with no sentence or clause end, the last safe space is used. */
export const HARD_CAP_CHARS = 300;

/**
 * Words a spoken piece must never end on: its thought obviously continues.
 * Only words that cannot close a clause — "I think so", "I told her", "come
 * in" and "not yet" all end sentences, so so/her/in/yet are not here.
 */
const DANGLING = new Set(
  (
    "and or but nor plus because although unless whereas whether if than as " +
    "of to at for with from into onto toward towards upon via per between against during including " +
    "the a an my your our their every whose whom i"
  ).split(" "),
);

/**
 * Lead-in words that dangle when a CLAUSE cut would leave them last, before
 * their comma or dash: "…now So," / "…and then, well," — the thought they
 * open has not started yet.
 */
const LEAD_INS = new Set(
  "so well okay ok oh um uh now then also yes yeah right look see listen anyway actually basically honestly first next like".split(" "),
);

/** Lead-ins that can also be a whole reply: dangling only before clause punctuation. */
const STANDALONE = new Set("okay ok yes yeah right".split(" "));

/** Titles that are followed by a name: "Dr." alone is a name still to come. */
const TITLE = /^(?:mr|mrs|ms|mx|dr|prof|st|mt|gen|col|capt|lt|sgt|rev|hon|gov|sen|rep|vs|approx|dept|fig|vol)\.$/i;
/** "a.m.", "e.g.", "U.S." */
const DOTTED = /^(?:[A-Za-z]\.){2,}$/;
/** A single capital and its period: an initial ("J."), a list letter ("A."), or a word ("Plan B."). */
const CAPITAL = /^[A-Z]\.$/;
/** A list marker or small count before a period: "1.", "(2.", "#3.". */
const LIST_NUMBER = /^[(#]?\d{1,2}\.$/;

/**
 * Words that open a sentence and are never a surname. After "Plan B." one of
 * them means a new sentence; any other capitalized word means a name ("a Y.
 * Orzechowitz card"). Plausible surnames (Will, May, Young, Price…) are left out.
 */
const SENTENCE_OPENERS = new Set(
  (
    "i i'm i'll i've i'd we we're we'll we've you you're you'll he he's she she's it it's they they're there there's " +
    "this that that's these those then the a an and but so or if when while once after before since because though " +
    "what which who how why where now next also our my your his her its their let let's please yes no not okay ok " +
    "today tomorrow yesterday tonight here first second third finally however otherwise still just both all each " +
    "every some most nothing everything is are was were do does did can could should would"
  ).split(" "),
);

/**
 * Nouns that take a letter: "plan B.", "Plan B.", "vitamin D.", "type A.".
 * After one of them, in any case, the capital is the letter itself, never an
 * initial, whatever follows — "Take vitamin D. Get some sun." and "Plan B.
 * Danny agreed." are two sentences (review rounds 2–3). "David S. Cohen" is a
 * name: David is not on the list. A surname on the list before an initial
 * ("Block J. Smith") is not a sentence anyone writes — accepted (round 3).
 * Never an ordinary prose word that precedes a name: point, part, stage,
 * phase, level, team, key are out ("At that point J. Smith left", "for the
 * most part Y. Orzechowitz") — a cut inside a name is THE defect; a missed
 * cut after "team B." only merges two sentences (round 4).
 */
const LETTER_NOUNS = new Set(
  (
    "plan option vitamin grade type exhibit appendix model series group class section schedule form " +
    "tier route wing building block unit version column row tab button hepatitis"
  ).split(" "),
);

/** A word that can only be a name's start here: a capital in any script, or a letter of a caseless script (Hebrew). */
const NAME_START = /^(?:\p{Lu}|(?!\p{Script=Latin})\p{L})/u;

/**
 * Does the token starting at `at` open its clause — start of text, a new
 * line, right after a boundary (". ", ", ", ": ", "— "), or behind an opening
 * "(" / "#"?
 */
function opensClause(text: string, at: number): boolean {
  const before = text.slice(0, at);
  if (/[(#[]$/.test(before)) return true;
  const bare = before.replace(/["'“‘]+$/, "");
  if (!bare.trim() || /\n[ \t]*$/.test(bare)) return true;
  return /[.!?…,;:—–-]["'”’)\]]*$/.test(bare.trimEnd());
}

/**
 * What a single capital before its period is ("Y. ", "B. "):
 *   - "initial" — part of a name: the period is not spoken and is no sentence end.
 *   - "list"    — a list letter opening its clause ("A. The cheaper one"): no
 *                 sentence end; the period stays (a bare "A," reads as the article).
 *   - "end"     — the word that ends a sentence ("Plan B.", "vitamin D.").
 *   - "wait"    — a stream that has not shown the next whole word yet.
 *
 * In order:
 *   1. A line break after the period ends the sentence: a name does not break
 *      across lines ("plan B.\nCall me", "J.\nSmith"). So does a letter-noun
 *      before a closing capital (rule 4) — decided at once, no wait.
 *   2. No whole next word: "wait" — unless `complete` (the text is final),
 *      where a word that runs to its end is whole, and nothing at all is
 *      "list" opening a clause, "end" closing one.
 *   3. Opening its clause: "initial" before another initial or a name-like
 *      word that is not a sentence opener ("J. Cohen", "A. B. Cohen"), else
 *      "list". Never "end" — the position alone decides the cut, as for a
 *      list number.
 *   4. After a letter-noun, any case ("plan B.", "Plan B.", "vitamin D."): "end" — checked right after rule 1.
 *   5. Closing its clause, before:
 *        another initial ("David A. B. Cohen")            → "initial"
 *        a sentence opener ("Plan B. Then")               → "end"
 *        any other name-like word, Hebrew included        → "initial"
 *          — except "I", the pronoun ("…you and I. Cohen") → "end"
 *        lowercase, a digit, anything else ("B. is out")   → "end"
 */
export type CapitalKind = "initial" | "list" | "end" | "wait";

export function capitalKind(text: string, letterAt: number, complete = false): CapitalKind {
  const opening = opensClause(text, letterAt);
  const rest = text.slice(letterAt + 2).replace(/^["'”’)\]]+/, "");
  const m = /^(\s+)(\S+)/.exec(rest);
  if (/^[ \t]*\n/.test(rest)) return "end";
  // After a letter-noun the next word cannot change the answer: no wait.
  const before = /(\S+)\s*$/.exec(text.slice(0, letterAt))?.[1] ?? "";
  if (!opening && LETTER_NOUNS.has(before.toLowerCase())) return "end";
  if (!m) {
    if (!complete) return "wait";
    return opening ? "list" : "end";
  }
  if (!complete && m[0].length === rest.length) return "wait";
  const word = m[2].replace(/^["'“‘([]+/, "");
  const bare = word.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z']+$/, "");
  const nameLike = NAME_START.test(word) && !SENTENCE_OPENERS.has(bare);
  if (opening) return CAPITAL.test(word) || nameLike ? "initial" : "list";
  if (CAPITAL.test(word)) return "initial";
  if (nameLike) return text[letterAt] === "I" ? "end" : "initial";
  return "end";
}

const CLOSERS = `"'”’)\\]`;
/** Terminal punctuation run, closers, then whitespace (not consumed). */
const SENTENCE_END = new RegExp(`[.!?…]+[${CLOSERS}]*(?=\\s)`, "g");
/** Clause punctuation: , ; : … ... and a dash standing between words. */
const CLAUSE_END = new RegExp(`(?:[,;:…]|\\.{2,}|(?<=\\s)-{1,2}|[–—])[${CLOSERS}]*(?=\\s)`, "g");

/**
 * The last word-bearing token of `text`, leading quotes/brackets removed. A
 * spaced dash ("the —") is skipped, so the word before it is what is judged.
 */
function lastToken(text: string): string {
  const m = /(\S*[\p{L}\p{N}]\S*)[^\p{L}\p{N}]*$/u.exec(text);
  return m ? m[1].replace(/^[("'“‘[]+/, "") : "";
}

/** "and then", "but now": a connective and a lead-in, the thought not yet begun. */
const CONNECTIVE_LEAD_IN = /\b(?:and|but) (?:then|so|now|also|yet)\W*$/i;

/** Is the terminator ending at `end` (exclusive, before the whitespace) a real sentence end? */
function isSentenceEnd(text: string, start: number, end: number): boolean {
  const punct = text.slice(start, end).replace(new RegExp(`[${CLOSERS}]+$`), "");
  if (/[!?]/.test(punct)) return true;
  // An ellipsis is a pause inside a thought, not its end.
  if (punct.includes("…") || punct.length > 1) return false;
  const token = lastToken(text.slice(0, start + 1));
  if (TITLE.test(token) || DOTTED.test(token)) return false;
  const tokenAt = start + 1 - token.length;
  if (CAPITAL.test(token)) return capitalKind(text, tokenAt) === "end";
  // "1. Buy milk" is a list marker; "I'll call at 7." ends its sentence.
  if (LIST_NUMBER.test(token)) return !opensClause(text, tokenAt);
  return true;
}

/** Every real sentence end in `text`, as cut positions (after the one whitespace char that follows). */
export function sentenceEnds(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(SENTENCE_END)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (isSentenceEnd(text, start, end)) out.push(end + 1);
  }
  return out;
}

/** `text` split after every real sentence end; the parts re-join to `text`. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const cut of sentenceEnds(text)) {
    out.push(text.slice(from, cut));
    from = cut;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/**
 * Does `text` end on a word whose thought obviously continues ("and", "to
 * the", "Dr.")? With `clause`, the piece ends at clause punctuation, and a
 * lead-in before it ("So,") dangles too.
 */
export function endsOnDanglingWord(text: string, clause = false): boolean {
  const token = lastToken(text);
  if (!token) return false;
  if (TITLE.test(token)) return true;
  const word = token.replace(new RegExp(`[.,;:!?…\\-–—${CLOSERS}]+$`), "").toLowerCase();
  if (DANGLING.has(word) || CONNECTIVE_LEAD_IN.test(text.trimEnd())) return true;
  if (!LEAD_INS.has(word)) return false;
  // A lead-in dangles before clause punctuation ("…now So,"), or when it
  // opens its clause ("So" / "Okay, so") — not when it closes one ("I think so").
  if (clause) return true;
  // "Okay." / "Right?" / "Yes" are whole replies on their own.
  if (STANDALONE.has(word) || /[.!?]["'”’)\]]*$/.test(token)) return false;
  const before = text.trimEnd().slice(0, -token.length).trimEnd();
  return !before || /[,;:—–-]$/.test(before) || /[.!?]["'”’)\]]*$/.test(before);
}

/**
 * Is this the unfinished front of a sentence — something that must not be
 * spoken alone, even at a message boundary? It ends on clause punctuation
 * ("Okay," / "first:" / "and —") or on a dangling word.
 */
export function isIncompleteFragment(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  if (/(?:[,;:…]|\.{2,}|\s-{1,2}|[–—])["'”’)\]]*$/.test(t)) return true;
  return endsOnDanglingWord(t);
}

function lastSafeClause(text: string): number {
  let best = 0;
  for (const m of text.matchAll(CLAUSE_END)) {
    const end = (m.index ?? 0) + m[0].length;
    const cut = end + 1;
    if (cut < MIN_CLAUSE_CHARS) continue;
    if (endsOnDanglingWord(text.slice(0, end), true)) continue;
    best = cut;
  }
  return best;
}

function lastSafeSpace(text: string, cap: number): number {
  let i = text.lastIndexOf(" ", cap);
  const fallback = i;
  while (i >= MIN_CLAUSE_CHARS) {
    if (!endsOnDanglingWord(text.slice(0, i))) return i + 1;
    i = text.lastIndexOf(" ", i - 1);
  }
  return fallback > 0 ? fallback + 1 : 0;
}

export type BoundaryKind = "punct" | "clause" | "cap";

/**
 * Where a streaming buffer may be cut right now, or null to keep waiting.
 * `cut` is the length of the piece to speak; the rest stays buffered.
 */
export function speechCut(text: string): { cut: number; why: BoundaryKind } | null {
  const ends = sentenceEnds(text);
  if (ends.length) return { cut: ends[ends.length - 1], why: "punct" };
  if (text.length > CLAUSE_ESCAPE_CHARS) {
    const clause = lastSafeClause(text);
    if (clause > 0) return { cut: clause, why: "clause" };
  }
  if (text.length > HARD_CAP_CHARS) {
    const space = lastSafeSpace(text, HARD_CAP_CHARS);
    if (space > 0) return { cut: space, why: "cap" };
  }
  return null;
}
