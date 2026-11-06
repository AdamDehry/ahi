import type { KaraokeState, KaraokeWord } from "./karaoke";

/* ============================================================
   elevenkaraoke.ts — exact word timings for a call over ElevenLabs.

   The native call gets Cartesia's word timestamps and plays the audio itself,
   so its karaoke clock IS the audio clock. On ElevenLabs the SDK plays the
   audio (a WebRTC track) and we never touch it; what we do get, per audio
   chunk, is the engine's own alignment: every character with its start time
   and duration, relative to that chunk (measured 10/22 on the side engine —
   the Agents stream carries it over WebRTC too, as data messages next to the
   track).

   Those messages arrive faster than realtime (a 2.8 s line's alignment all
   landed within 0.35 s), so arrival time is not playback time. The timeline:

     · a call clock: ms since the call started (performance.now based);
     · a chunk that follows the previous one of its response plays right after
       it — audio is contiguous within a response — so it starts where the
       previous chunk's characters end;
     · a chunk with no predecessor to follow (the first of a response, or one
       whose text came late, after a stall) starts at arrival + the measured
       network-to-speaker latency, and is then ANCHORED to the real thing: the
       next time the output goes from silent to audible, that chunk is moved
       to that instant and the latency estimate learns from it.

   Words are built from the characters (a number can be split across chunks:
   "at 8" + "1 degrees" is "81"), carry absolute times on the call clock, and
   go straight into the shared KaraokeState: the native KaraokeLine renders
   and highlights them unchanged, with the call clock as its position
   (voicebus setExternalVoiceClock). A word that has not been reached is not
   on screen, so the text never runs ahead of the voice.
   ============================================================ */

export interface ElevenAlignment {
  chars: string[];
  char_start_times_ms: number[];
  char_durations_ms: number[];
}

/** First guess at alignment-arrival → audible (~127 ms). Learned per call. */
export const DEFAULT_LATENCY_MS = 130;
const MIN_LATENCY_MS = 20;
const MAX_LATENCY_MS = 900;
/** An onset this far from the anchored chunk's guess belongs to something else. */
const ANCHOR_WINDOW_MS = 900;

interface ResponseTrack {
  /** Where the next chunk of this response would start if contiguous (call ms). */
  endMs: number;
  target: KaraokeState;
  /** The word still growing at the end of the last chunk (no space after it yet). */
  open: KaraokeWord | null;
  chars: number;
}

interface PendingAnchor {
  eventId: number;
  target: KaraokeState;
  /** Index of the first word that belongs to the anchored chunk. */
  fromWord: number;
  guessMs: number;
  arrivalMs: number;
}

export interface AnchorResult {
  eventId: number;
  /** Guess minus the real onset: positive = the guess was late. */
  errMs: number;
  latencyMs: number;
}

export class ElevenTimeline {
  latencyMs = DEFAULT_LATENCY_MS;
  private readonly tracks = new Map<number, ResponseTrack>();
  /**
   * Chunks waiting for their onset, oldest first, at most one per response.
   * One slot was not enough: two responses queued before any audio left the
   * second holding the slot, and it took the FIRST one's onset when the two
   * were within the anchor window (parity review).
   */
  private pending: PendingAnchor[] = [];
  /** Nothing can play before the end of what is already scheduled, whatever its response. */
  private lastEndMs = 0;

  /** True once this response has had any alignment. */
  has(eventId: number): boolean {
    return this.tracks.has(eventId);
  }

  /** End of everything scheduled so far, call ms. */
  get endMs(): number {
    return this.lastEndMs;
  }

  /**
   * One chunk's alignment, as it arrived (`arrivalMs` on the call clock).
   * Returns the chunk's start, call ms.
   */
  ingest(eventId: number, a: ElevenAlignment, target: KaraokeState, arrivalMs: number): number {
    const n = Math.min(a.chars?.length ?? 0, a.char_start_times_ms?.length ?? 0, a.char_durations_ms?.length ?? 0);
    let track = this.tracks.get(eventId);
    if (track && track.target !== target) {
      // The response moved to another row (a new bubble): words go there from now.
      track.target = target;
      track.open = null;
    }
    const earliest = arrivalMs + this.latencyMs;
    const follows = !!track && track.endMs >= earliest - 1;
    const start = follows ? track!.endMs : Math.max(earliest, this.lastEndMs);
    if (!track) {
      track = { endMs: start, target, open: null, chars: 0 };
      this.tracks.set(eventId, track);
    }
    if (!follows && n > 0) {
      // Silence came before this chunk: its real start is its onset. A
      // response's newer chunk replaces its older wait and queues behind the rest.
      this.pending = this.pending.filter((p) => p.eventId !== eventId);
      this.pending.push({ eventId, target, fromWord: target.words.length, guessMs: start, arrivalMs });
    }
    let end = start;
    for (let i = 0; i < n; i++) {
      const c = a.chars[i] ?? "";
      const t0 = start + (a.char_start_times_ms[i] ?? 0);
      const t1 = t0 + Math.max(0, a.char_durations_ms[i] ?? 0);
      end = Math.max(end, t1);
      if (!c.trim()) {
        track.open = null;
        continue;
      }
      if (track.open) {
        track.open.text += c;
        track.open.end = t1 / 1000;
      } else {
        track.open = { text: c, start: t0 / 1000, end: t1 / 1000 };
        target.words.push(track.open);
      }
    }
    track.chars += n;
    track.endMs = end;
    this.lastEndMs = Math.max(this.lastEndMs, end);
    return start;
  }

  /**
   * The output just went from silent to audible at `atMs`. If the oldest
   * chunk waiting for its anchor is plausibly this, move it (and the rest of
   * its response) to the real start. Returns what was corrected, or null.
   */
  onset(atMs: number): AnchorResult | null {
    // Far behind: stale guesses (their audio never came) — let them go.
    while (this.pending.length && atMs - this.pending[0].guessMs > ANCHOR_WINDOW_MS) this.pending.shift();
    const p = this.pending[0];
    if (!p) return null;
    const errMs = p.guessMs - atMs;
    if (Math.abs(errMs) > ANCHOR_WINDOW_MS) return null;
    this.pending.shift();
    const shiftSec = -errMs / 1000;
    shiftWords(p.target, p.fromWord, shiftSec);
    const track = this.tracks.get(p.eventId);
    if (track) track.endMs -= errMs;
    // What is queued behind it was placed after its end: it moves with it
    // (words in the same row moved above already), and still waits for its own onset.
    // Another row moves ONCE, from its earliest waiting word: shifting it per
    // entry moved a later response in that row twice (review round).
    const rows = new Map<KaraokeState, number>();
    for (const q of this.pending) {
      q.guessMs -= errMs;
      const t = this.tracks.get(q.eventId);
      if (t) t.endMs -= errMs;
      if (q.target !== p.target) rows.set(q.target, Math.min(rows.get(q.target) ?? Infinity, q.fromWord));
    }
    for (const [target, from] of rows) shiftWords(target, from, shiftSec);
    this.lastEndMs -= errMs;
    const seen = atMs - p.arrivalMs;
    this.latencyMs = Math.round(Math.min(MAX_LATENCY_MS, Math.max(MIN_LATENCY_MS, (this.latencyMs + seen) / 2)));
    return { eventId: p.eventId, errMs: Math.round(errMs), latencyMs: this.latencyMs };
  }

  /**
   * The voice was cut at `atMs`: nothing scheduled after it will play, so the
   * next response starts from its own arrival, not behind the cut one's tail
   * (a reply after a cut-in waited 3.6 s for audio that never came).
   */
  cut(atMs: number): void {
    this.lastEndMs = Math.min(this.lastEndMs, atMs);
    this.pending = [];
  }

  /**
   * A mid-response onset (see `realign`): the words move, and so does where
   * this row's next chunk will be placed, so later chunks stay in step.
   */
  realign(target: KaraokeState, atMs: number): { errMs: number; corrected: boolean } | null {
    const r = realign(target.words, atMs);
    if (r?.corrected) {
      for (const t of this.tracks.values()) if (t.target === target) t.endMs -= r.errMs;
      this.lastEndMs -= r.errMs;
    }
    return r;
  }

  /** These responses are done (settled or cut): no more chunks will follow them. */
  forget(eventIds: Iterable<number>): void {
    for (const id of eventIds) this.tracks.delete(id);
    this.pending = this.pending.filter((p) => this.tracks.has(p.eventId));
  }
}

function shiftWords(target: KaraokeState, from: number, sec: number): void {
  for (let i = from; i < target.words.length; i++) {
    target.words[i].start += sec;
    target.words[i].end += sec;
  }
}

/**
 * No alignment came for a response at all (a voice or engine that sends
 * none): its words are spread at a speaking pace from `startMs`. A last
 * resort, never the normal path — the caller logs it loudly.
 */
export function pacedWords(text: string, startMs: number, msPerWord = 380): KaraokeWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => ({ text: w, start: (startMs + i * msPerWord) / 1000, end: (startMs + (i + 1) * msPerWord - 40) / 1000 }));
}

/** The nearest word start to `atSec` among `words` (for sync checks), or null. */
export function nearestWordStart(words: KaraokeWord[], atSec: number): number | null {
  let best: number | null = null;
  for (const w of words) if (best === null || Math.abs(w.start - atSec) < Math.abs(best - atSec)) best = w.start;
  return best;
}

/** A mid-response onset this far from the predicted word is corrected; farther is something else (a breath, noise). */
const REALIGN_MAX_MS = 300;

/**
 * The voice became audible again at `atMs` after a pause inside a response.
 * The word whose predicted start is nearest is the one being said: the
 * difference is the highlight's error at this moment (returned, for the sync
 * log), and that word and everything after it move onto the real audio, so
 * small timing drift never accumulates across a long reply.
 */
export function realign(words: KaraokeWord[], atMs: number): { errMs: number; corrected: boolean } | null {
  const at = atMs / 1000;
  let best = -1;
  for (let i = 0; i < words.length; i++) {
    if (best < 0 || Math.abs(words[i].start - at) < Math.abs(words[best].start - at)) best = i;
  }
  if (best < 0) return null;
  const errMs = Math.round((words[best].start - at) * 1000);
  if (Math.abs(errMs) >= 1_000) return null;
  const corrected = Math.abs(errMs) <= REALIGN_MAX_MS && errMs !== 0;
  if (corrected) {
    const shift = -errMs / 1000;
    for (let i = best; i < words.length; i++) {
      words[i].start += shift;
      words[i].end += shift;
    }
  }
  return { errMs, corrected };
}
