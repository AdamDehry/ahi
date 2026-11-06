/* ============================================================
   turn-composer.ts — ported from the voice-mode simulator (round-2 item 1).

   THE BUG. A silence window is the only thing deciding "the user is done
   talking". The owner pauses mid-thought, the window expires, and the fragment
   commits as its own message — which then fires (and interrupts) a reply. His
   opening turned into five messages and three interruptions:

     "Hey Michael, so it's been a week since we last visited." / "The voice
      mode." / "And..." / "This is the test after we finally fixed the bugs." /
     "Let's see how it works."

   A longer window alone does not fix it — it just moves the cliff. Two gates
   sit between an utterance ending and a turn firing:

     1. HOLD. A closed fragment waits before committing. Speech starting again
        inside the hold cancels the commit and the fragments concatenate.
     2. COMPLETENESS. How long to hold depends on whether the text so far reads
        as a finished thought. A full sentence waits only long enough to catch
        a fast follow-on; a dangling fragment ("And...", "The voice mode.")
        gets a real second chance to be continued.

   The completeness pass is deliberately a heuristic, not a model call: it runs
   on every fragment inside the response loop, so it has to be free and
   instant. Anything that costs a round trip would put back the latency this is
   spending to remove.

   A hard `maxHoldMs` ceiling guarantees a turn always commits eventually —
   text that never looks finished must not be able to wedge the call.
   ============================================================ */

/**
 * Words that cannot end a finished thought. If the utterance stops here, the
 * speaker is mid-sentence — STT's helpfully-added full stop is punctuation,
 * not intent.
 */
const DANGLING = new Set([
  // connectives
  "and", "but", "so", "or", "nor", "because", "cause", "since", "while", "whilst",
  "although", "though", "if", "unless", "until", "till", "whether", "that", "which",
  "who", "whom", "whose", "when", "where", "as", "than", "then", "plus", "also",
  "however", "therefore", "meanwhile", "whereas",
  // prepositions
  "to", "of", "for", "with", "without", "about", "from", "in", "on", "at", "by",
  "into", "onto", "over", "under", "above", "below", "between", "among", "through",
  "during", "against", "toward", "towards", "upon", "within", "across", "after",
  "before", "behind", "beyond", "per", "via",
  // determiners / possessives — nothing follows them yet
  "the", "a", "an", "my", "your", "our", "their", "his", "her", "its", "this",
  "these", "those", "some", "any", "every", "each", "no", "both", "either", "neither",
  // auxiliaries and copulas
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
  "have", "has", "had", "will", "would", "can", "could", "should", "shall", "may",
  "might", "must", "im", "ive", "id", "youre", "weve", "its", "thats", "theres",
  // fillers / trailing-off markers
  "um", "uh", "er", "erm", "ah", "hmm", "like", "basically", "actually", "literally",
  "kinda", "sorta", "just", "really", "very", "quite", "maybe",
]);

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Metadata carried alongside a fragment and merged across a whole thought. */
export interface TurnMeta {
  /** Slowest transcription in the thought. */
  sttMs?: number;
  /** Total spoken length of the thought. */
  audioSec?: number;
  /** How many STT fragments were coalesced. Stamped at commit. */
  fragments?: number;
  /** Provider says this is a model-level completed turn, not a local timer guess. */
  nativeTurnEnd?: boolean;
  [key: string]: unknown;
}

/**
 * Does this read as a finished thought?
 *
 * Note the order: the dangling-word and length checks run BEFORE the
 * terminal-punctuation check, because batch STT punctuates every fragment it
 * closes. "The voice mode." and "And..." both arrive with a full stop and
 * neither is a finished thought — trusting punctuation alone is exactly how
 * the opening got chopped into five.
 *
 * @param minWords below this word count, treat as a fragment regardless
 */
export function readsComplete(text: string, minWords = 4): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;

  // Trailing-off punctuation is an explicit "I'm not done".
  if (/[,;:\-–—]$/.test(t)) return false;
  if (/(\.\.\.|…)$/.test(t)) return false;

  const words = t.split(/\s+/).filter(Boolean);
  const last = norm(words[words.length - 1]);
  if (!last || DANGLING.has(last)) return false;

  // A short question is a finished thought (voice step 4): "You still there?",
  // "Can you hear me?" waited the long hold (1.5–2.2 s) for being under
  // `minWords` — the slowest first sounds of a test call.
  // CALL_SHORT_QUESTION_HOLD=off restores the old reading.
  if (words.length >= 3 && /\?["')\]]?$/.test(t) && shortQuestionsComplete()) return true;

  if (words.length < minWords) return false;

  // Survived the semantic gates — now it has to actually look terminated.
  return /[.!?]["')\]]?$/.test(t);
}


function shortQuestionsComplete(): boolean {
  const v = (process.env.CALL_SHORT_QUESTION_HOLD ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

export function adaptiveIncompleteHoldMs(text: string, baseMs = 900): number {
  const t = String(text ?? "").trim();
  if (!t) return baseMs;
  const words = t.split(/\s+/).filter(Boolean);
  const last = norm(words[words.length - 1] ?? "");
  let wait = baseMs;
  if (words.length < 4) wait += 450;
  if (words.length < 7) wait += 250;
  if (DANGLING.has(last)) wait += 500;
  if (/[,;:\-–—]$/.test(t) || /(\.\.\.|…)$/.test(t)) wait += 550;
  return Math.min(2200, wait);
}

/** Join fragments the way they were spoken: one thought, single-spaced. */
export function joinFragments(fragments: string[]): string {
  return fragments
    .map((f) => String(f ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TurnComposerOptions {
  /** Hold after text that reads finished. */
  holdMs?: number;
  /** Hold after a dangling fragment. */
  incompleteHoldMs?: number;
  /** Ceiling from the FIRST fragment; the turn always commits by this point. */
  maxHoldMs?: number;
  /** Below this word count, treat text as a fragment. */
  minWordsComplete?: number;
  /**
   * After an utterance closes, how long a commit waits for its transcript
   * (voice step 5). 0 = never waits. Default CALL_COMPOSER_AWAIT_MS, 1200.
   */
  awaitMs?: number;
}

/**
 * CALL_COMPOSER_AWAIT_MS: how long the composer waits for an utterance that
 * has closed but whose transcript is still on its way, before committing what
 * it already holds. 0 = off (step 4: the earlier piece committed alone 350 ms
 * after the later one ended, and the later one merged in as a second turn —
 * a "One sec." per piece on a phone call).
 */
export function composerAwaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CALL_COMPOSER_AWAIT_MS;
  if (raw === undefined || raw.trim() === "") return 1_200;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1_200;
}

export class TurnComposer {
  private readonly holdMs: number;
  private readonly incompleteHoldMs: number;
  private readonly maxHoldMs: number;
  private readonly minWordsComplete: number;

  private fragments: string[] = [];
  private meta: TurnMeta | null = null;
  private firstAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private speaking = false;
  private readonly awaitMs: number;
  /** Utterances closed whose transcript has not arrived yet, and when the last one closed. */
  private inFlight = 0;
  private lastEndAt = 0;

  /** A committed, whole utterance. */
  onTurn: (text: string, meta: TurnMeta) => void = () => {};
  /** What is buffered right now, for the live preview. */
  onPending: (text: string) => void = () => {};

  constructor({
    holdMs = 350,
    incompleteHoldMs = 1500,
    maxHoldMs = 7000,
    minWordsComplete = 6,
    awaitMs = composerAwaitMs(),
  }: TurnComposerOptions = {}) {
    this.awaitMs = awaitMs;
    this.holdMs = holdMs;
    this.incompleteHoldMs = incompleteHoldMs;
    this.maxHoldMs = maxHoldMs;
    this.minWordsComplete = minWordsComplete;
  }

  get pendingText(): string {
    return joinFragments(this.fragments);
  }

  /** True while a thought is buffered but not yet committed. */
  get pending(): boolean {
    return this.fragments.length > 0;
  }

  /** He is talking now (between the recognizer's speech start and end). */
  get talking(): boolean {
    return this.speaking;
  }

  /** Mic onset. The user is talking — nothing may commit until they stop. */
  speechStart(): void {
    this.speaking = true;
    this.clearTimer();
  }

  /**
   * The STT closed an utterance. This is NOT the same moment as `fragment()`:
   * transcription takes a round trip, so a fragment routinely lands while the
   * speaker is already part-way through the next sentence. Scheduling the
   * commit from `fragment()` alone therefore fired turns mid-speech whenever a
   * pause was longer than the silence window — the exact case the composer
   * exists to catch. Speech state gates the commit; transcripts only fill the
   * buffer.
   */
  speechEnd(nowMs: number = Date.now()): void {
    this.speaking = false;
    // Its transcript is on the way: what is buffered waits for it (bounded), so one thought commits once.
    if (this.awaitMs > 0) {
      this.inFlight++;
      this.lastEndAt = nowMs;
    }
    if (this.fragments.length) this.schedule(nowMs);
  }

  /** One closed STT utterance. */
  fragment(text: string, meta: TurnMeta = {}, nowMs: number = Date.now()): void {
    const t = String(text ?? "").trim();
    if (this.inFlight > 0) this.inFlight--;
    if (!t) return;
    if (!this.fragments.length) this.firstAt = nowMs;
    this.fragments.push(t);
    this.meta = mergeMeta(this.meta, meta);
    this.onPending(this.pendingText);
    this.schedule(nowMs);
  }

  /** (Re)arm the hold for whatever is buffered right now. */
  schedule(nowMs: number = Date.now()): void {
    this.clearTimer();
    const ceiling = Math.max(0, this.firstAt + this.maxHoldMs - nowMs);
    let wait: number;
    if (this.speaking) {
      // The user is mid-sentence: nothing may commit under them. Only the
      // ceiling applies — armed rather than skipped, so a speechEnd that never
      // arrives (provider quirk, error path) cannot wedge the call.
      wait = ceiling;
    } else {
      const complete =
        readsComplete(this.pendingText, this.minWordsComplete) ||
        (this.meta?.nativeTurnEnd === true && readsComplete(this.pendingText, 4));
      const incompleteWait = Math.max(
        this.incompleteHoldMs,
        adaptiveIncompleteHoldMs(this.pendingText),
      );
      // The ceiling wins: a thought that never reads finished still has to
      // reach the agent. Clamped at 0 so an overdue buffer commits next tick.
      wait = Math.min(complete ? this.holdMs : incompleteWait, ceiling);
      // An utterance that closed after these is still being transcribed: wait for it, up to awaitMs after
      // it closed — past the ceiling too, or a correction at the end ("…actually, don't send it") is
      // left behind while what came before it is sent (Codex, step 5).
      if (this.inFlight > 0) {
        const left = this.lastEndAt + this.awaitMs - nowMs;
        if (left > 0) wait = Math.max(wait, left);
        else this.inFlight = 0;
      }
    }
    this.timer = setTimeout(() => this.commit(), wait);
    this.timer.unref?.();
  }

  /** Fire the accumulated thought as ONE turn. */
  commit(): void {
    this.clearTimer();
    const text = this.pendingText;
    const meta: TurnMeta = { ...(this.meta ?? {}), fragments: this.fragments.length };
    this.fragments = [];
    this.meta = null;
    this.firstAt = 0;
    if (text) this.onTurn(text, meta);
  }

  /** Drop anything buffered (call ended, mute, barge). */
  reset(): void {
    this.clearTimer();
    this.fragments = [];
    this.meta = null;
    this.firstAt = 0;
    this.speaking = false;
    this.inFlight = 0;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function mergeMeta(prev: TurnMeta | null, next: TurnMeta): TurnMeta {
  if (!prev) return { ...next };
  return {
    ...prev,
    ...next,
    // slowest transcription in the thought, and its total spoken length
    sttMs: Math.max(prev.sttMs ?? 0, next.sttMs ?? 0),
    audioSec: Number(((prev.audioSec ?? 0) + (next.audioSec ?? 0)).toFixed(2)),
  };
}
