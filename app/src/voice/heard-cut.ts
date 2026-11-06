/* ============================================================
   heard-cut.ts — what he actually heard of a reply he cut off
   (voice-streaming-bargein, 10/18).

   A call's reply is synthesized seconds ahead of playback, and the gateway
   finishes a turn when synthesis ends, not when he has heard it. So a
   barge-in usually lands on a turn the server already thinks is over: its
   whole text sits in the call record, the model's thread holds all of it, and
   the next turn knows nothing of the cut.

   The app now says how far it had played when it cut the voice (`heardSec`,
   on the turn's own clock, filler included — the clock the word timings were
   sent on). Per call, this keeps the last spoken turn and turns that number
   into words:
     - the record keeps only what he heard, then " —"; nothing heard drops
       the line (a blank line is skipped by the record and by "what Michael
       said last");
     - his next turn, within CALL_CUT_NOTE_MS, tells the model how far he got
       (turn-taking.ts `bargeNote`).
   Pure; index.ts owns one per call and does the recording.
   ============================================================ */

/** A spoken turn's words, as sent to the listener (turn-audio.ts `wordsHeardBy`). */
export interface HeardSource {
  wordsHeardBy(sec: number): string[];
}

export type CutAction =
  /** The reply is in the record: keep only this of it ("" = drop it). */
  | { kind: "trim"; at: number; text: string }
  /** The reply never reached the record (cut mid-generation): record this. */
  | { kind: "record"; text: string }
  /** Nothing to change in the record. */
  | { kind: "none" };

export class CallCuts {
  private last: { src: HeardSource; recordAt: number; heard: string | null } | null = null;
  private lastCut: { at: number; heard: string } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * A new spoken turn began; it is the one a barge-in would cut. Null: audio
   * with no word timings (a fixed line) — a cut on it says nothing about any
   * reply, so none is touched.
   */
  spoken(src: HeardSource | null): void {
    this.last = src ? { src, recordAt: -1, heard: null } : null;
  }

  /** May this turn's full reply go into the record? False once a cut already decided what he heard. */
  mayRecordFull(src: HeardSource | null): boolean {
    return !(this.last && this.last.src === src && this.last.heard !== null);
  }

  /** The turn's reply went into the record at `at`. */
  recorded(src: HeardSource | null, at: number): void {
    if (this.last && this.last.src === src) this.last.recordAt = at;
  }

  /** Once the record keeps the cut text, where it sits. */
  recordedCut(at: number): void {
    if (this.last) this.last.recordAt = at;
  }

  /**
   * A barge-in cut the last spoken turn at `heardSec` on its clock. Returns
   * what the record should do, and the words he heard (null: no turn to cut,
   * or it was already cut).
   */
  cut(heardSec: number): { heard: string | null; action: CutAction } {
    const last = this.last;
    if (!last || last.heard !== null) return { heard: null, action: { kind: "none" } };
    const heard = last.src.wordsHeardBy(heardSec).join(" ").replace(/\s+/g, " ").trim();
    last.heard = heard;
    this.lastCut = { at: this.now(), heard };
    const kept = heard ? `${heard} —` : "";
    if (last.recordAt >= 0) return { heard, action: { kind: "trim", at: last.recordAt, text: kept } };
    return { heard, action: kept ? { kind: "record", text: kept } : { kind: "none" } };
  }

  /**
   * The words heard at the last cut, for his next turn's note — once, and only
   * within `windowMs` of the cut. Null when there is nothing to tell.
   */
  takeHeard(windowMs: number): string | null {
    const c = this.lastCut;
    this.lastCut = null;
    if (!c || this.now() - c.at > windowMs) return null;
    return c.heard;
  }

  /** Drop a pending note without using it (a merge, real work). */
  dropNote(): void {
    this.lastCut = null;
  }
}
