/* ============================================================
   karaoke.ts — the word-walk for a reply being spoken aloud.

   ── THE HARD CONTRACT (BUILD-NOTES, Avi, partner-to-partner) ─────────────
   The highlighter MUST walk words in LOGICAL (spoken) order, never DOM or
   visual order.

   This is a renderer-architecture decision, not a CSS tweak. On a Hebrew line
   the fill has to run right-to-left; on a code-switched line it has to jump
   between segments exactly as the voice says them. Build the walk on visual
   order first and Hebrew is not a tweak later — it is a rewrite.

   So the walk here is defined over an ORDERED TOKEN ARRAY, indexed by
   utterance position, and the tokens come from Cartesia's `word_timestamps`,
   which are emitted in the order the voice speaks them. Logical order is
   therefore structural: index N is the Nth word SPOKEN, whatever direction it
   is eventually painted in. Rendering gives each token its own span and lets
   the browser do bidi layout (`unicode-bidi: plaintext` on the container) —
   the browser owns where a word appears, this module owns when it lights up,
   and neither needs to know about the other.

   Voice is English-only today. None of the above is currently observable.
   That is exactly why it is written now: the renderer has to be correct
   before there is Hebrew to reveal that it is not.

   ── Why a timeline rather than "highlight on chunk arrival" ──────────────
   Audio is generated faster than realtime, so synthesis events run ahead of
   playback. Lighting words as their timestamps ARRIVE would race ahead of the
   voice. Every word carries start/end in seconds relative to the utterance,
   and the caller supplies the true playback position from the audio clock.
   ============================================================ */


/**
 * Clean agent prose for committed transcript display. Timing tokens stay raw.
 *
 * ── THE RULE THIS BROKE, AND WHY IT IS NARROW NOW (R4-6) ─────────────────
 * The saved transcript must be the words that were SAID. Every rule here
 * removes something that is written but not spoken — markdown scaffolding,
 * SSML delivery tags, bullet glyphs. None of them may remove a WORD.
 *
 * Two used to.
 *
 * `<[^>]+>` was meant for SSML like `<emotion value="calm"/>`, but it matches
 * any span between a less-than and a greater-than, so "if x < 5 and y > 3"
 * lost five words to a tag that was never there. It now requires something
 * that actually looks like a tag: a name right after the bracket.
 *
 * Worse, "comma", "period" and "full stop" were rewritten into punctuation.
 * That is a dictation convention, and this text is not dictation — the agent
 * writes real punctuation, and on the user's side these are ordinary English
 * words. "The period was long" came out as "The. was long". It is gone.
 * If spoken-punctuation ever needs handling it belongs in STT, on the one
 * path where someone might actually be dictating.
 */
export function sanitizeForTranscript(text: string): string {
  return String(text ?? "")
    // A tag, not any pair of angle brackets: `<b>`, `</b>`, `<speed ratio="1.2"/>`.
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*?)?\/?>/g, " ")
    .replace(/```[a-zA-Z0-9_-]*\n?/g, " ")
    .replace(/```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[•]/g, "")
    .replace(/[–—]/g, ", ")
    .replace(/(^|\s)-(?=\s|$)/g, " ")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .trim();
}

const normalizeDisplay = (text: string): string =>
  sanitizeForTranscript(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function isDisplayReemission(currentMessage: string, chunk: string): boolean {
  if (!chunk.trim()) return false;
  const current = currentMessage.trim();
  const incoming = chunk.trim();
  if (!current) return false;
  if (incoming === current) return true;
  const a = normalizeDisplay(current);
  const b = normalizeDisplay(incoming);
  return !!a && !!b && a === b;
}

export interface KaraokeWord {
  /** Display form — carries real punctuation where we could match it. */
  text: string;
  /** Seconds from the start of this reply's audio. */
  start: number;
  end: number;
}

export interface KaraokeState {
  /** Tokens in SPOKEN order. Index = utterance position. See the header. */
  words: KaraokeWord[];
  /**
   * Display text streamed from the agent, and how far into it we have
   * matched. Used only to recover punctuation — never to order the walk.
   */
  displayText: string;
  consumed: number;
  /** Consecutive failures to match a spoken word against the display text. */
  missStreak: number;
  /** Where the current assistant message begins in `displayText`. */
  messageStart: number;
  /** Final spoken prose for committed display and saved call records. */
  committedText: string;
}

export function createKaraokeState(): KaraokeState {
  return { words: [], displayText: "", consumed: 0, missStreak: 0, messageStart: 0, committedText: "" };
}

/**
 * Agent text arrived (a `stream-chunk`). Display only — no timing implied.
 *
 * ── Why this drops re-emissions ──────────────────────────────────────────
 * The agent stream sends live text deltas AND a terminal copy of each
 * completed assistant message, and the gateway broadcasts BOTH to the client
 * (the re-emission guard downstream only protects the speech path). The chat
 * bubble never noticed because it REPLACES its text on `stream-end`. Karaoke
 * ACCUMULATES, so the duplicate landed in the display text, sat in
 * `pendingTail` unmatched by any word timing, and lit to full opacity when the
 * turn settled — every reply rendered twice.
 *
 * A turn using a tool is several assistant messages, so the comparison is
 * against this MESSAGE's text, not the whole turn's — see `isStreamReemission`
 * in src/voice-tts-stream.ts, which is the same rule on the speech side. The
 * two are deliberately separate: this is the display path, that is the audio
 * path, and they live in different packages.
 *
 * Returns whether the chunk was actually appended.
 */
export function appendDisplayText(state: KaraokeState, chunk: string): boolean {
  const currentMessage = state.displayText.slice(state.messageStart);
  if (isDisplayReemission(currentMessage, chunk)) {
    // A re-emission IS the end of a message: the next one starts after it.
    state.messageStart = state.displayText.length;
    return false;
  }
  state.displayText += chunk;
  return true;
}

export function commitDisplayText(state: KaraokeState, interrupted = false): string {
  const source = interrupted
    ? state.words.slice(0, spokenCount(state, Number.MAX_SAFE_INTEGER)).map((w) => w.text).join(" ")
    : state.displayText;
  const committed = sanitizeForTranscript(source);
  state.committedText = committed;
  state.displayText = committed;
  state.consumed = committed.length;
  state.missStreak = 0;
  state.messageStart = committed.length;
  return committed;
}

const normalize = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** How far ahead of the matched cursor to look for a display token. */
const MATCH_WINDOW = 60;
/** Consume a display token anyway after this many consecutive misses. */
const MISS_TOLERANCE = 2;

/**
 * Ingest a batch of Cartesia word timestamps, in spoken order.
 *
 * Each spoken word is matched against the next unconsumed token of the
 * streamed display text, so what the reader sees keeps the agent's real
 * punctuation and capitalisation while the timing comes from the synthesiser.
 * TTS normalisation makes this lossy on purpose — "2026" is spoken as three
 * words, "Dr." as one — so a match that fails twice running consumes a
 * display token regardless, which keeps the rendered line from sliding
 * permanently behind the voice.
 */
export function ingestWordTimings(
  state: KaraokeState,
  batch: { words: string[]; start: number[]; end: number[] },
): void {
  for (let i = 0; i < batch.words.length; i++) {
    const spoken = batch.words[i];
    const window = state.displayText.slice(state.consumed, state.consumed + MATCH_WINDOW);
    const next = window.match(/\S+/);

    let text = spoken;
    if (next) {
      const candidate = next[0];
      const a = normalize(candidate);
      const b = normalize(spoken);
      const matches = a.length > 0 && (a.includes(b) || b.includes(a));

      if (matches || state.missStreak + 1 >= MISS_TOLERANCE) {
        const at = state.consumed + window.indexOf(candidate);
        state.consumed = at + candidate.length;
        text = candidate;
        state.missStreak = 0;
      } else {
        state.missStreak += 1;
      }
    }

    state.words.push({
      text,
      start: batch.start[i] ?? 0,
      end: batch.end[i] ?? batch.start[i] ?? 0,
    });
  }
}

/**
 * Text streamed but not yet matched to a spoken word.
 *
 * Rendered as UNREAD — the same dim as any other unspoken word, never its own
 * shade. A third brightness reads as a "darkness wave" travelling down the
 * reply, which is the bug the sim deleted the read-ahead recede to fix.
 */
export function pendingTail(state: KaraokeState): string {
  return state.displayText.slice(state.consumed);
}

/**
 * How many words have been spoken at playback position `t` (seconds).
 *
 * Returns a COUNT, so the caller lights `words[0..n)` — spoken words stay
 * spoken. There is no un-highlighting: the fill only ever advances, which is
 * what makes a stall look like a pause rather than a rewind.
 */
export function spokenCount(state: KaraokeState, t: number, leadSec = 0): number {
  let n = 0;
  const position = t + leadSec;
  // Timestamps are monotonic in spoken order, so the first word that has not
  // started yet ends the spoken run. A tiny UI-only lead keeps the highlight
  // perceptually aligned with audio without changing transcript truth.
  for (const w of state.words) {
    if (position < w.start) break;
    n++;
  }
  return n;
}

/**
 * The words spoken around playback position `t`: from `backSec` before it to
 * `aheadSec` past it. What could be coming back through his mic right now.
 *
 * Echo is only ever of what has just been SAID. Testing his words against the
 * whole reply — including everything synthesized seconds ahead and not yet
 * played — made barge-in harder the longer the reply got: once the full text
 * existed, an interjection on the same topic shared enough vocabulary to read
 * as echo, and the reply played on over him.
 */
export function recentSpokenText(state: KaraokeState, t: number, backSec: number, aheadSec = 0.5): string {
  const out: string[] = [];
  for (const w of state.words) {
    if (w.start > t + aheadSec) break;
    if (w.end >= t - backSec) out.push(w.text);
  }
  return out.join(" ");
}

/* ── Text follows voice (voice-streaming-bargein) ──────────────
   On a call, a reply's words appear as they are SPOKEN, not when they were
   written. He reads faster than Michael talks, and the whole answer on screen
   ahead of the voice defeated listening. Two switches give back the old
   read-ahead (all of it shown, unread words dimmed): the gateway's
   CALL_TEXT_FOLLOWS_VOICE=off, sent on `voice-started`, or on one device
   `localStorage.setItem("ahi.voiceTextFollows", "off")`.                   */
let serverTextFollows = true;

/** What the gateway said on `voice-started` (absent = on). */
export function setServerTextFollowsVoice(on: boolean): void {
  serverTextFollows = on;
}

export function textFollowsVoice(): boolean {
  if (!serverTextFollows) return false;
  try {
    return globalThis.localStorage?.getItem("ahi.voiceTextFollows") !== "off";
  } catch {
    return true;
  }
}

/** Index of the word being spoken right now, or -1 between words. */
export function activeIndex(state: KaraokeState, t: number, leadSec = 0): number {
  const n = spokenCount(state, t, leadSec);
  if (n === 0) return -1;
  const i = n - 1;
  return t < state.words[i].end ? i : -1;
}

/** Has the whole utterance been spoken past its last word? */
export function isFullySpoken(state: KaraokeState, t: number): boolean {
  const last = state.words[state.words.length - 1];
  return !!last && t >= last.end;
}

/**
 * Freeze an interrupted turn.
 *
 * Spoken words hold at full brightness; the unspoken remainder collapses
 * (frame 3K) — it was never said, so leaving it on screen would misrepresent
 * what the agent actually told the user. The caller adds the trailing em-dash
 * and the faint mono INTERRUPTED tag. Never a red badge: being interrupted is
 * a fact about the conversation, not an error.
 */
export function truncateAtInterrupt(state: KaraokeState, t: number): void {
  state.words = state.words.slice(0, spokenCount(state, t));
  commitDisplayText(state, true);
}
