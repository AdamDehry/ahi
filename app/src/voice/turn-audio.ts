import type { WordTimestamps } from "../voice-tts-stream.js";
import type { FastKind, LadderGate } from "./answer-ladder.js";

/* ============================================================
   turn-audio.ts — one turn's downlink: the filler, then the answer, never both
   at once. Transport-agnostic on purpose.

   ── The call core's audio-out seam ───────────────────────────────────────
   `CallAudioOut` is everything a turn sends toward the listener. Today the
   one implementation is the PWA WebSocket (index.ts); a phone leg would be a
   second one (PCM → μ-law 8 kHz frames onto a media stream). Nothing in here
   knows which it is talking to.

   ── Ordering, and why it needs no queue ──────────────────────────────────
   The listener schedules frames back to back on its own audio clock (the
   PWA's voicebus cursor; a phone media stream plays in order too). So:
     - the filler is only offered while the answer has produced NO audio;
       if the answer got there first, the filler is skipped;
     - a filler is pre-rendered PCM, sent whole, synchronously — so every
       answer frame that arrives later lands behind its last sample: the
       filler finishes cleanly, then the answer plays;
     - the turn announces itself ONCE (`start`). A second start mid-turn
       would reset the PWA's clock and lay the answer over the filler;
     - the answer's word timings are shifted by the filler's length, because
       the listener's karaoke clock started at the filler's first sample.
   Barge-in needs nothing here: the PWA cuts every scheduled source locally,
   filler included, and the server cancels the answer.

   ── The filler only fills a gap (voice-streaming-bargein, 10/18) ────
   On the 1:32 AM call a filler started 0.4 s before the answer's first
   sentence was ready and the answer waited behind all of it. Two rules now:
     - the filler is skipped once the answer's first sentence has been HANDED
       to the voice (`answerReady`), not only once its audio is back;
     - a filler is no longer sent whole. It is cut at its word breaks
       (`wordBreaks`, from the audio itself, so it needs no timings from any
       provider) and paced out a word at a time, FILLER_LEAD_S ahead of the
       listener. When the answer's first audio or words arrive, the words not
       yet sent are dropped: the filler ends at the next word break and the
       answer plays straight after it. The answer's word timings are shifted
       by what was actually sent, so the karaoke clock still lines up.
   A filler with no break inside it goes out whole, as before.

   ── The bridge (voice step 6, 10/28) ────────────────────────────────
   The gate's bridge ("Ah, the phone lag.") is the answer's first words, not
   a gap-filler, so the two rules above are turned around for it: it WAITS
   for the answer's first sentence to be handed to the voice (`whenAnswerReady`)
   — or for its own deadline — and then goes out whole, unpaced, so the
   answer's audio lands right behind its last sample on the listener's clock:
   one reply, no gap and nothing cut. It is refused only once the answer is
   audible. The line is rendered while it waits, so it is all here when it goes.
   ============================================================ */

export interface CallAudioOut {
  /** This turn's audio is starting. Sent once per turn. */
  start(sampleRate: number): void;
  /** One PCM s16le mono frame at the turn's sample rate. */
  frame(pcm: Buffer): void;
  /** Word timings, in seconds from the turn's first audio sample. */
  words(wt: WordTimestamps): void;
  /** Synthesis for this turn is finished (not playback). */
  done(): void;
  /** Informational: a filler line is about to play (for captions/telemetry). */
  filler?(text: string): void;
}

/** How far ahead of the listener a paced filler is sent (seconds of audio). */
export const FILLER_LEAD_S = 0.25;

/** Energy windows for `wordBreaks`. */
const BREAK_WINDOW_S = 0.01;
/** A break is at least this many quiet windows in a row. */
const BREAK_MIN_WINDOWS = 2;
/** Quiet = under this share of the line's loud (90th percentile) window energy. */
const BREAK_REL = 0.1;
/** ...and never above this absolute RMS (s16 units): a hiss floor is not a word. */
const BREAK_ABS_MAX = 1500;

/**
 * Byte offsets inside a PCM s16le mono line where a word ends and the next
 * begins: the middle of each quiet run between voiced audio. Leading and
 * trailing silence are not breaks (cutting there changes nothing). Sorted,
 * even, strictly inside the buffer. Empty when the line has no inner pause.
 */
export function wordBreaks(pcm: Buffer, sampleRate: number): number[] {
  const samples = Math.floor(pcm.length / 2);
  const win = Math.max(1, Math.round(sampleRate * BREAK_WINDOW_S));
  const n = Math.floor(samples / win);
  if (n < 3) return [];
  const rms: number[] = new Array(n);
  for (let w = 0; w < n; w++) {
    let acc = 0;
    for (let i = w * win; i < (w + 1) * win; i++) {
      const v = pcm.readInt16LE(i * 2);
      acc += v * v;
    }
    rms[w] = Math.sqrt(acc / win);
  }
  const loud = [...rms].sort((a, b) => a - b)[Math.floor(n * 0.9)] ?? 0;
  if (loud <= 0) return [];
  const quietAt = Math.min(loud * BREAK_REL, BREAK_ABS_MAX);
  const quiet = rms.map((r) => r < quietAt);
  const firstVoiced = quiet.indexOf(false);
  const lastVoiced = quiet.lastIndexOf(false);
  if (firstVoiced < 0) return [];
  const out: number[] = [];
  let runStart = -1;
  for (let w = firstVoiced; w <= lastVoiced; w++) {
    if (quiet[w]) {
      if (runStart < 0) runStart = w;
      continue;
    }
    if (runStart >= 0 && w - runStart >= BREAK_MIN_WINDOWS) {
      const mid = Math.floor((runStart + w) / 2) * win;
      out.push(mid * 2);
    }
    runStart = -1;
  }
  return out;
}

export interface TurnAudioOptions {
  /** Skip a filler once the answer's first sentence is ready (default on; CALL_FILLER_SKIP_READY=off). */
  skipWhenReady?: boolean;
  /** Pace the filler by word so the answer can cut it (default on; CALL_FILLER_PACE=off sends it whole). */
  pace?: boolean;
  /** Timer seam (tests): run `fn` after `ms`; returns a cancel. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** A paced filler was cut short because the answer arrived. Seconds sent of the line's total. */
  onFillerCut?: (sentSec: number, totalSec: number) => void;
}

const envOn = (raw: string | undefined): boolean => !["off", "false", "0", "no"].includes((raw ?? "").toLowerCase());

/** The filler rules' kill switches, read per turn. */
export function fillerOptions(env: NodeJS.ProcessEnv = process.env): Pick<TurnAudioOptions, "skipWhenReady" | "pace"> {
  return { skipWhenReady: envOn(env.CALL_FILLER_SKIP_READY), pace: envOn(env.CALL_FILLER_PACE) };
}

const realSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

interface PacedFiller {
  pcm: Buffer;
  breaks: number[];
  sentBytes: number;
  /** When its first bytes went out (0 = none yet: a streamed line still waiting for its first word). */
  startedAt: number;
  done: boolean;
  cancel: (() => void) | null;
  /** All of the line's audio is here (a whole render, or the stream ended). */
  complete: boolean;
  /** Sent as it comes, unpaced: the line is the answer, or pacing is off. */
  whole: boolean;
}

/** A filler line whose audio is still arriving (turn-audio.ts openFiller). */
export interface FillerSink {
  /** More of the line's PCM, at the turn's sample rate. */
  push(pcm: Buffer): void;
  /** The line was cut (the answer arrived, or a barge-in): more audio is dropped. */
  readonly halted: boolean;
  /** The line's audio is complete (or the render stopped): send what is left. */
  end(): void;
}

export class TurnAudioSequencer {
  private started = false;
  private answerFirstAt = 0;
  private answerReadyAt = 0;
  private firstAt = 0;
  private fillerSec = 0;
  /** Seconds of an earlier filler this turn (the hold, before a fast answer): the clock the answer's words shift by. */
  private fillerBaseSec = 0;
  private fillerText: string | null = null;
  private fillerCut = false;
  private paced: PacedFiller | null = null;
  private closed = false;
  /** The answer's words as sent to the listener (filler shift applied), for "what did he hear". */
  private sentWords: Array<{ word: string; start: number }> = [];
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(
    private readonly out: CallAudioOut,
    readonly sampleRate: number,
    private readonly now: () => number = Date.now,
    private readonly opts: TurnAudioOptions = {},
  ) {
    this.schedule = opts.schedule ?? realSchedule;
  }

  get answerStarted(): boolean {
    return this.answerFirstAt > 0;
  }

  /** The answer's first sentence has been handed to the voice (its audio may not be back yet). */
  get answerPending(): boolean {
    return (this.answerReadyAt > 0 && this.opts.skipWhenReady !== false) || this.answerFirstAt > 0;
  }

  /** Mark the answer's first spoken sentence as handed to the voice. Idempotent. */
  answerReady(): void {
    if (!this.answerReadyAt) this.answerReadyAt = this.now();
    this.wakeReady();
  }

  private readyWaiters: Array<() => void> = [];
  private wakeReady(): void {
    for (const fn of this.readyWaiters.splice(0)) fn();
  }

  /**
   * Resolves when the answer's first sentence is handed to the voice, or its
   * audio arrives, or the turn closes — at once if that has happened (voice
   * step 6: a bridge goes on air then, with the answer right behind it).
   */
  whenAnswerReady(): Promise<void> {
    if (this.answerReadyAt || this.answerFirstAt || this.closed) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  /** Absolute ms of the first audio of any kind this turn, 0 if none. */
  get firstAudioAt(): number {
    return this.firstAt;
  }

  /** Absolute ms of the answer's own first audio, 0 if none. */
  get answerFirstAudioAt(): number {
    return this.answerFirstAt;
  }

  /** The filler this turn: its text and the seconds of it actually sent (all of it unless cut). */
  get filler(): { text: string; seconds: number; cut?: true } | null {
    if (!this.fillerText) return null;
    return this.fillerCut ? { text: this.fillerText, seconds: this.fillerSec, cut: true } : { text: this.fillerText, seconds: this.fillerSec };
  }

  /**
   * The answer's words the listener had heard by `sec` on this turn's clock
   * (the clock the app's karaoke and its cut position use: filler included).
   */
  wordsHeardBy(sec: number): string[] {
    const out: string[] = [];
    for (const w of this.sentWords) {
      if (w.start >= sec) break;
      out.push(w.word);
    }
    return out;
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.firstAt = this.now();
    this.out.start(this.sampleRate);
  }

  /**
   * Play the filler if — and only if — the answer is neither audible nor
   * ready (its first sentence handed to the voice), and no filler has played
   * this turn. Returns whether it started; it is then paced out by word.
   */
  offerFiller(text: string, pcm: Buffer, how: { whole?: boolean; bridge?: boolean } = {}): boolean {
    if (pcm.length < 2) return false;
    const sink = this.openFiller(text, how);
    if (!sink) return false;
    sink.push(pcm);
    sink.end();
    return true;
  }

  /**
   * The same offer for a line whose audio is still being rendered
   * (voice-speed: a whole render cost 0.7–0.8 s before the first word;
   * the voice's own first bytes come in about 0.2 s). The first word goes out
   * as soon as its end is known — a word break, or the end of the stream —
   * and the line is then paced exactly as a whole one, so an answer that
   * arrives still cuts it at a word break. Null when the offer is refused.
   *
   * `whole`: the fast voice's line IS the answer (front-gate.ts "full") —
   * nothing will cut it but a barge-in, so it goes out as it comes, unpaced.
   * An answer may follow the hold line (answer-ladder.ts: "One sec." then the
   * reply is not two holding sounds): what is left of the hold goes out first,
   * whole, and the answer lands behind it on the listener's clock.
   */
  openFiller(text: string, how: { whole?: boolean; bridge?: boolean } = {}): FillerSink | null {
    if (this.closed) return null;
    // A bridge opens the answer (voice step 6): it may start while the answer is on its way, never once it is audible.
    if (how.bridge ? this.answerFirstAt > 0 || this.fillerText !== null : this.answerPending) return null;
    if (this.fillerText !== null) {
      const prev = this.paced;
      // Only an answer may follow, and only a line that is all here (a pre-rendered hold).
      if (how.whole !== true || (prev && !prev.done && !prev.complete)) return null;
      if (prev && !prev.done) {
        prev.cancel?.();
        prev.cancel = null;
        prev.whole = true;
        this.pumpFiller();
      }
      this.fillerBaseSec = this.fillerSec;
      this.fillerCut = false;
    }
    this.fillerText = text;
    const f: PacedFiller = {
      pcm: Buffer.alloc(0),
      breaks: [],
      sentBytes: 0,
      startedAt: 0,
      done: false,
      cancel: null,
      complete: false,
      whole: this.opts.pace === false || how.whole === true || how.bridge === true,
    };
    this.paced = f;
    let odd: Buffer | null = null;
    return {
      push: (pcm) => {
        if (f.done || f.complete || !pcm.length) return;
        let more = odd ? Buffer.concat([odd, pcm]) : pcm;
        odd = null;
        if (more.length % 2) {
          odd = more.subarray(more.length - 1);
          more = more.subarray(0, more.length - 1);
        }
        if (!more.length) return;
        f.pcm = f.pcm.length ? Buffer.concat([f.pcm, more]) : more;
        if (!f.whole) f.breaks = wordBreaks(f.pcm, this.sampleRate);
        this.pumpFiller();
      },
      end: () => {
        if (f.complete) return;
        f.complete = true;
        this.pumpFiller();
      },
      get halted() {
        return f.done && !f.complete;
      },
    };
  }

  private secOf(bytes: number): number {
    return Math.floor(bytes / 2) / this.sampleRate;
  }

  /**
   * Send the filler a word at a time, FILLER_LEAD_S ahead of the listener.
   * A streamed line waits for each word's end to arrive before sending it.
   */
  private pumpFiller(): void {
    const f = this.paced;
    if (!f || f.done || this.closed) return;
    f.cancel?.();
    f.cancel = null;
    const elapsed = (): number => (f.startedAt ? (this.now() - f.startedAt) / 1000 : 0);
    while (f.sentBytes < f.pcm.length && (f.whole || this.secOf(f.sentBytes) - elapsed() < FILLER_LEAD_S)) {
      const next = f.whole ? f.pcm.length : f.breaks.find((b) => b > f.sentBytes) ?? (f.complete ? f.pcm.length : -1);
      if (next < 0) break; // this word's end has not arrived yet: push() resumes
      if (!f.startedAt) {
        // The line's first bytes: only now is it audible, and announced.
        this.ensureStarted();
        this.out.filler?.(this.fillerText ?? "");
        f.startedAt = this.now();
      }
      this.out.frame(f.pcm.subarray(f.sentBytes, next));
      f.sentBytes = next;
      this.fillerSec = this.fillerBaseSec + this.secOf(f.sentBytes);
    }
    if (f.sentBytes >= f.pcm.length) {
      if (f.complete) f.done = true;
      return; // all sent so far; the rest (if any) comes with push()/end()
    }
    if (!f.whole && this.secOf(f.sentBytes) - elapsed() >= FILLER_LEAD_S) {
      const dueMs = Math.max(5, (this.secOf(f.sentBytes) - FILLER_LEAD_S - elapsed()) * 1000);
      f.cancel = this.schedule(() => this.pumpFiller(), dueMs);
    }
  }

  /** The answer is here: what of the filler is not sent yet never will be. */
  private cutFiller(): void {
    if (!this.haltFiller()) return;
    this.opts.onFillerCut?.(this.fillerSec, this.secOf(this.paced!.pcm.length));
  }

  /** Stop pacing the filler; true if any of it was still unsent. */
  private haltFiller(): boolean {
    const f = this.paced;
    if (!f || f.done) return false;
    f.done = true;
    f.cancel?.();
    f.cancel = null;
    if (!f.startedAt) {
      // A streamed line stopped before its first word went out: it never played.
      this.fillerText = null;
      return false;
    }
    this.fillerCut = true;
    return true;
  }

  /**
   * The turn was cut or superseded: no more of the filler goes out. A paced
   * filler would otherwise keep sending words after the listener cut it —
   * on the phone, and onto the next turn's clock in the app.
   */
  stopFiller(): void {
    this.haltFiller();
  }

  answerAudio(pcm: Buffer): void {
    if (this.closed) return;
    this.ensureStarted();
    if (!this.answerFirstAt) {
      this.cutFiller();
      this.answerFirstAt = this.now();
      this.wakeReady();
    }
    this.out.frame(pcm);
  }

  answerWords(wt: WordTimestamps): void {
    if (this.closed) return;
    // Timings can lead their audio: the shift must be final before any are sent.
    this.cutFiller();
    const shifted = !this.fillerSec
      ? wt
      : (() => {
          // Millisecond precision: float drift would otherwise leak into the karaoke clock.
          const shift = (xs: number[]) => xs.map((x) => Math.round((x + this.fillerSec) * 1000) / 1000);
          return { words: wt.words, start: shift(wt.start), end: shift(wt.end) };
        })();
    for (let i = 0; i < shifted.words.length; i++) this.sentWords.push({ word: shifted.words[i], start: shifted.start[i] ?? 0 });
    this.out.words(shifted);
  }

  answerDone(): void {
    if (this.closed) return;
    this.out.done();
  }

  /** Barge-in / supersede: nothing more leaves this turn. */
  close(): void {
    this.closed = true;
    this.haltFiller();
    this.wakeReady();
  }
}

export interface FrontVoiceTurnResult {
  /** The line spoken, or null. */
  played: string | null;
  /** Why no filler played, when none did. */
  skipped?: string;
  /** turn start → line text ready (ms), if it arrived. */
  lineMs?: number;
  /** turn start → filler audio sent (ms), if it played. */
  playedAtMs?: number;
  /** The line played was the whole answer (front-gate.ts "full"); the main turn was cancelled. */
  answer?: true;
  /** The line played was a bridge: the answer's first words (voice step 6). */
  bridge?: true;
  /**
   * Streamed lines: resolves when the render has ended (or was cut). A full
   * line goes out whole, so by then all of it has been sent; an ack line's
   * last words may still be pacing out on the listener's clock.
   */
  audioDone?: Promise<void>;
}

/**
 * A bridge's cue (voice step 6): the answer's first sentence is in the
 * voice's hands, or the bridge's own deadline came (`dueAt`, absolute ms), or
 * the turn ended. The bridge then goes on air — the answer right behind it.
 */
async function bridgeCue(seq: TurnAudioSequencer, dueAt: number | undefined, aborted: Promise<"aborted">, now: () => number): Promise<"go" | "aborted"> {
  const wait = dueAt === undefined ? 0 : dueAt - now();
  if (wait <= 0) return "go";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([
    seq.whenAnswerReady().then(() => "go" as const),
    new Promise<"go">((res) => (timer = setTimeout(() => res("go"), wait))),
    aborted,
  ]);
  clearTimeout(timer);
  return r;
}

/** The ladder's kind for a fast line. */
function fastKind(first: { answer?: boolean; bridge?: boolean }): FastKind {
  return first.answer ? "answer" : first.bridge ? "bridge" : "filler";
}

/** A result where the fast layer did not speak: the arbiter is told, so the hold can still cover the turn. */
function released(r: FrontVoiceTurnResult, ladder: LadderGate | undefined): FrontVoiceTurnResult {
  if (!r.played) ladder?.release(r.skipped ?? "no-line");
  return r;
}

/** runFrontVoiceTurn with a streamed render (see its `stream`). */
async function runStreamedFrontVoiceTurn(opts: Parameters<typeof runFrontVoiceTurn>[0] & { stream: NonNullable<Parameters<typeof runFrontVoiceTurn>[0]["stream"]> }): Promise<FrontVoiceTurnResult> {
  const now = opts.now ?? Date.now;
  const aborted = new Promise<"aborted">((resolve) => {
    if (opts.signal.aborted) resolve("aborted");
    else opts.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const ladder = opts.ladder;
  const first = await Promise.race([opts.line, aborted]);
  if (first === "aborted") return released({ played: null, skipped: "turn-ended" }, ladder);
  const lineMs = now() - opts.startedAt;
  if (!first.line) return released({ played: null, skipped: first.reason ?? "no-line", lineMs }, ladder);
  const kind = fastKind(first);
  // A bridge is timed by the ladder (its cue and its point): with none, it does not play (Codex, step 6).
  if (kind === "bridge" && !ladder) return released({ played: null, skipped: "bridge-needs-ladder", lineMs }, ladder);
  // A bridge opens the answer: only the answer's audio (or the ladder) refuses it (voice step 6).
  const answered = (): string | null =>
    opts.seq.answerStarted ? "answer-first" : opts.seq.answerPending && kind !== "bridge" ? "answer-ready" : ladder && !ladder.admit(kind) ? "ladder" : null;
  if (answered()) return released({ played: null, skipped: answered()!, lineMs }, ladder);

  const render = new AbortController();
  const held: Buffer[] = [];
  let sink: FillerSink | null = null;
  let firstAudio!: () => void;
  const audioArrived = new Promise<"audio">((r) => (firstAudio = () => r("audio")));
  let renderError: Error | null = null;
  let renderEnded = false;
  const rendered = opts
    .stream(
      first.line,
      (pcm) => {
        if (sink) {
          sink.push(pcm);
          // Cut (a barge-in, or the answer's audio): stop paying for the rest.
          if (sink.halted) render.abort();
        } else held.push(pcm);
        firstAudio();
      },
      render.signal,
    )
    .then(
      () => undefined,
      (err: Error) => {
        renderError = err;
      },
    )
    .finally(() => {
      renderEnded = true;
      firstAudio();
      sink?.end();
    });
  const stopRender = (r: FrontVoiceTurnResult): FrontVoiceTurnResult => {
    render.abort();
    return released(r, ladder);
  };

  // Its first audio, then (an ack) its deadline: neither before.
  if ((await Promise.race([audioArrived, aborted])) === "aborted") return stopRender({ played: null, skipped: "turn-ended", lineMs });
  if (!held.length) return stopRender({ played: null, skipped: `render:${renderError ? (renderError as Error).message : "no audio"}`.slice(0, 100), lineMs });
  if (kind === "bridge") {
    // All of it, then its cue: it goes out whole, so the answer lands right behind it (voice step 6).
    if ((await Promise.race([rendered.then(() => "done" as const), aborted])) === "aborted") return stopRender({ played: null, skipped: "turn-ended", lineMs });
    if (renderError) return stopRender({ played: null, skipped: `render:${(renderError as Error).message}`.slice(0, 100), lineMs });
    if ((await bridgeCue(opts.seq, ladder?.bridgeDueAt, aborted, now)) === "aborted") return stopRender({ played: null, skipped: "turn-ended", lineMs });
  }
  const wait = first.answer || kind === "bridge" ? 0 : opts.startedAt + opts.deadlineMs - now();
  if (wait > 0) {
    const t = await Promise.race([new Promise<"t">((r) => setTimeout(() => r("t"), wait)), aborted]);
    if (t === "aborted") return stopRender({ played: null, skipped: "turn-ended", lineMs });
  }
  if (opts.signal.aborted) return stopRender({ played: null, skipped: "turn-ended", lineMs });
  if (answered()) return stopRender({ played: null, skipped: answered()!, lineMs });
  sink = opts.seq.openFiller(first.line, { whole: first.answer === true, bridge: kind === "bridge" });
  if (!sink) return stopRender({ played: null, skipped: answered() ?? "refused", lineMs });
  ladder?.played(kind);
  for (const pcm of held.splice(0)) sink.push(pcm);
  if (renderEnded) sink.end();
  const opened = sink;
  if (first.answer) {
    // The line IS the answer only once all of it rendered: a
    // render that dies halfway must not have cancelled the real answer. If the
    // answer has started meanwhile, it stands and nothing is handed over.
    void rendered.then(() => {
      if (!renderError && !opened.halted && !opts.seq.answerPending) opts.onPlayed?.(first.line!, true);
    });
  } else opts.onPlayed?.(first.line, false, kind === "bridge");
  return {
    played: first.line,
    lineMs,
    playedAtMs: now() - opts.startedAt,
    ...(first.answer ? { answer: true as const } : {}),
    ...(kind === "bridge" ? { bridge: true as const } : {}),
    audioDone: rendered,
  };
}

/**
 * Drive one turn's front voice: get a line, render it, and offer it at the
 * deadline (or the moment it is ready, if that is later) — unless the answer
 * has started, or its first sentence is ready, by then. Never throws, never
 * delays the answer.
 */
export async function runFrontVoiceTurn(opts: {
  seq: TurnAudioSequencer;
  /**
   * Resolves with the checked line, or null. `answer`: the line is the whole
   * reply (front-gate.ts "full") — no deadline, sent unpaced, and `onPlayed`
   * cancels the main turn.
   */
  line: Promise<{ line: string | null; reason?: string; answer?: boolean; bridge?: boolean }>;
  render: (text: string) => Promise<Buffer>;
  deadlineMs: number;
  /** Stop waiting: the turn ended, was superseded, or was barged in on. */
  signal: AbortSignal;
  startedAt: number;
  now?: () => number;
  /** Called synchronously the moment the line starts playing (before any answer audio can land). `bridge`: it opens the answer (voice step 6). */
  onPlayed?: (line: string, answer: boolean, bridge?: boolean) => void;
  /**
   * Render the line as a stream instead (call-tts.ts streamFillerPcm): the
   * line is offered at its deadline or its first audio, whichever is later,
   * and its first word plays without waiting for the rest. Its own signal:
   * once the line is playing, ending the turn's wait does not cut it.
   */
  stream?: (text: string, onPcm: (pcm: Buffer) => void, signal: AbortSignal) => Promise<void>;
  /**
   * The turn's arbiter (answer-ladder.ts): asked before the line goes on air,
   * told when it does, and released when the fast layer will not speak.
   * Without it, the sequencer alone decides.
   */
  ladder?: LadderGate;
}): Promise<FrontVoiceTurnResult> {
  if (opts.stream) return runStreamedFrontVoiceTurn({ ...opts, stream: opts.stream });
  const now = opts.now ?? Date.now;
  const aborted = new Promise<"aborted">((resolve) => {
    if (opts.signal.aborted) resolve("aborted");
    else opts.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const ladder = opts.ladder;
  const first = await Promise.race([opts.line, aborted]);
  if (first === "aborted") return released({ played: null, skipped: "turn-ended" }, ladder);
  const lineMs = now() - opts.startedAt;
  if (!first.line) return released({ played: null, skipped: first.reason ?? "no-line", lineMs }, ladder);
  const kind = fastKind(first);
  // A bridge is timed by the ladder (its cue and its point): with none, it does not play (Codex, step 6).
  if (kind === "bridge" && !ladder) return released({ played: null, skipped: "bridge-needs-ladder", lineMs }, ladder);
  // A bridge opens the answer: only the answer's audio (or the ladder) refuses it (voice step 6).
  const answered = (): string | null =>
    opts.seq.answerStarted ? "answer-first" : opts.seq.answerPending && kind !== "bridge" ? "answer-ready" : ladder && !ladder.admit(kind) ? "ladder" : null;
  if (answered()) return released({ played: null, skipped: answered()!, lineMs }, ladder);

  let pcm: Buffer | "aborted";
  try {
    pcm = await Promise.race([opts.render(first.line), aborted]);
  } catch (err) {
    return released({ played: null, skipped: `render:${(err as Error).message}`.slice(0, 100), lineMs }, ladder);
  }
  if (pcm === "aborted") return released({ played: null, skipped: "turn-ended", lineMs }, ladder);

  if (kind === "bridge" && (await bridgeCue(opts.seq, ladder?.bridgeDueAt, aborted, now)) === "aborted") {
    return released({ played: null, skipped: "turn-ended", lineMs }, ladder);
  }
  const wait = first.answer || kind === "bridge" ? 0 : opts.startedAt + opts.deadlineMs - now();
  if (wait > 0) {
    const t = await Promise.race([new Promise<"t">((r) => setTimeout(() => r("t"), wait)), aborted]);
    if (t === "aborted") return released({ played: null, skipped: "turn-ended", lineMs }, ladder);
  }
  if (opts.signal.aborted) return released({ played: null, skipped: "turn-ended", lineMs }, ladder);
  if (answered() || !opts.seq.offerFiller(first.line, pcm, { whole: first.answer === true, bridge: kind === "bridge" })) {
    return released({ played: null, skipped: answered() ?? "refused", lineMs }, ladder);
  }
  ladder?.played(kind);
  opts.onPlayed?.(first.line, first.answer === true, kind === "bridge");
  return { played: first.line, lineMs, playedAtMs: now() - opts.startedAt, ...(first.answer ? { answer: true } : {}), ...(kind === "bridge" ? { bridge: true } : {}) };
}
