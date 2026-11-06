/* ============================================================
   turn-taking.ts — what a new utterance does to the turn already running
   (voice-turn-taking, 10/18; REPORT.md in that build).

   Before always-on, any real utterance heard while Michael was on a turn
   superseded it. That quietly absorbed the composer's splits: the owner paused a
   second mid-thought, the first half committed, the second half cut the
   half-started reply, and the model answered with both halves in its thread.
   Slice 1's work gate (work-gate.ts) put "a remark does not abort work" in
   front of that supersede for EVERY turn in flight — so Michael composing a
   conversational reply counted as work, the rest of the owner's sentence got
   "Want me to stop what I'm doing for that?", and a barge-in whose words
   committed before the aborted turn settled was held behind the same line.

   Now a new utterance on a busy call is routed here first, in order:

     barge     a barge-in was just confirmed (or the running turn was already
               aborted by one): straight to supersede — never the work gate.
               CALL_BARGE_STRICT=off restores slice-1 behaviour.
     merge     it arrived within CALL_CONTINUATION_MS (8 s) of the running
               turn's commit and that turn has not started a tool: it is the
               rest of the same thought. Supersede, one turn, both pieces.
               CALL_CONTINUATION=off disables.
     talk      the running turn is NOT real work: supersede, as before
               always-on.
     gate      real work: the work gate's verdicts (status / addition / stop /
               ask) apply, exactly as slice 1.

   REAL WORK (Michael's ruling, 10/18): a tool call has started, OR the turn
   is CALL_WORK_GATE_AFTER_MS (15 s) old AND no reply sentence has been
   spoken yet. A conversational reply still talking at 15 s is not work: an
   utterance over it supersedes. CALL_WORK_GATE=work (default) | always
   (slice 1: every turn in flight is work) | off (pre-always-on: never).

   Pure over an injectable clock; index.ts owns one TurnBook per call and
   feeds it the running turn's tool starts and spoken lines.
   ============================================================ */

export type WorkGateMode = "work" | "always" | "off";

export interface TurnTakingConfig {
  continuation: boolean;
  continuationMs: number;
  workGate: WorkGateMode;
  workAfterMs: number;
  bargeStrict: boolean;
  bargeWindowMs: number;
}

const flagOn = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "no") return false;
  if (v === "on" || v === "true" || v === "1" || v === "yes") return true;
  return fallback;
};

const ms = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Read per decision, so a flag flipped in the environment needs no code change. */
export function turnTakingConfig(env: NodeJS.ProcessEnv = process.env): TurnTakingConfig {
  const gate = (env.CALL_WORK_GATE ?? "work").toLowerCase();
  return {
    continuation: flagOn(env.CALL_CONTINUATION, true),
    continuationMs: ms(env.CALL_CONTINUATION_MS, 8_000),
    workGate: gate === "always" || gate === "off" ? gate : gate === "false" || gate === "0" ? "off" : "work",
    workAfterMs: ms(env.CALL_WORK_GATE_AFTER_MS, 15_000),
    bargeStrict: flagOn(env.CALL_BARGE_STRICT, true),
    bargeWindowMs: ms(env.CALL_BARGE_WINDOW_MS, 4_000),
  };
}

/** The turn running on a call, as turn-taking sees it. */
export interface RunningTurn {
  /** What he said for this turn (merged pieces joined). */
  transcript: string;
  /** How many STT commits this turn is made of (1 unless merged). */
  pieces: number;
  /** When the utterance committed (ms epoch). */
  committedAt: number;
  /** A tool call started in this turn. */
  toolStarted: boolean;
  /** Reply sentences spoken (or shown on the degraded path) — not the filler, not a check-in. */
  spokenLines: number;
  /** A barge-in aborted it; it only waits for its process to exit. */
  aborted: boolean;
}

export type Route =
  | { kind: "idle" }
  | { kind: "barge"; sinceBargeMs: number }
  | { kind: "merge"; gapMs: number; prior: RunningTurn }
  | { kind: "talk"; ageMs: number; spokenLines: number }
  | { kind: "gate"; ageMs: number; tool: boolean };

/** Michael's ruling: a tool started, or 15 s in with nothing said yet. */
export function isRealWork(turn: RunningTurn, now: number, cfg: TurnTakingConfig): boolean {
  if (cfg.workGate === "always") return true;
  if (cfg.workGate === "off") return false;
  if (turn.toolStarted) return true;
  return now - turn.committedAt >= cfg.workAfterMs && turn.spokenLines === 0;
}

/**
 * Route one committed, addressed, non-ack utterance on a call.
 *   busy      a turn is in flight (turn-liveness's count)
 *   turn      the running turn's record, or null if none is known
 *   bargedAt  the last confirmed barge-in on this call (ms epoch), 0 if none
 */
export function routeUtterance(
  o: { busy: boolean; turn: RunningTurn | null; bargedAt: number; now: number },
  cfg: TurnTakingConfig = turnTakingConfig(),
): Route {
  const { busy, turn, bargedAt, now } = o;
  if (!busy) return { kind: "idle" };
  if (cfg.bargeStrict) {
    const since = bargedAt ? now - bargedAt : Infinity;
    // Only a barge-in against THIS turn counts: once the turn that answers
    // the barge-in is running, his next split piece merges like any other.
    const againstThisTurn = !turn || turn.committedAt <= bargedAt;
    if (againstThisTurn && since <= cfg.bargeWindowMs) return { kind: "barge", sinceBargeMs: since };
    if (turn?.aborted) return { kind: "barge", sinceBargeMs: Number.isFinite(since) ? since : -1 };
  }
  if (!turn) {
    // Busy with no record (a turn started outside the book): keep slice 1's
    // protection unless the gate is off altogether.
    return cfg.workGate === "off" ? { kind: "talk", ageMs: 0, spokenLines: 0 } : { kind: "gate", ageMs: 0, tool: false };
  }
  const age = now - turn.committedAt;
  if (cfg.continuation && !turn.toolStarted && age <= cfg.continuationMs) return { kind: "merge", gapMs: age, prior: turn };
  if (isRealWork(turn, now, cfg)) return { kind: "gate", ageMs: age, tool: turn.toolStarted };
  return { kind: "talk", ageMs: age, spokenLines: turn.spokenLines };
}

/** Pieces of one thought, joined the way they were spoken. */
export function joinPieces(a: string, b: string): string {
  return `${a.trim()} ${b.trim()}`.replace(/\s+/g, " ").trim();
}

/* ── What the model is told ─────────────────────────────────────────────── */

/** A merged turn: the whole thought, which may repeat a part already in the thread. */
export const MERGE_NOTE =
  "(He paused mid-thought and kept going. This is his whole message, including any part of it you already saw just above and had not answered. Answer it as one.)";
/** A turn that cut into Michael's reply. */
export const BARGE_NOTE = "(He cut in while you were answering. Answer this. Don't go back to the earlier answer unless he asks.)";
/** How many of the heard words the cut-in note quotes back to the model. */
export const HEARD_TAIL_WORDS = 12;

/**
 * The cut-in note when the app said how far he got (voice-streaming-bargein):
 * the model's thread holds the WHOLE answer it wrote, but he heard only part
 * of it. `heard` null = unknown (an older app): the plain note.
 */
export function bargeNote(heard: string | null | undefined): string {
  if (heard == null) return BARGE_NOTE;
  const words = heard.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return "(He cut in before he heard any of your answer. Answer this. Don't go back to the earlier answer unless he asks.)";
  }
  const tail = words.slice(-HEARD_TAIL_WORDS).join(" ");
  const lead = words.length > HEARD_TAIL_WORDS ? "…" : "";
  return `(He cut in while you were answering. He heard you up to "${lead}${tail}" and none of the rest. Answer this. Don't go back to the earlier answer unless he asks.)`;
}

/** How long after a cut his next turn still carries the cut-in note. */
export const cutNoteMs = (env: NodeJS.ProcessEnv = process.env): number => ms(env.CALL_CUT_NOTE_MS, 10_000);

/** A remark held behind real work and delivered when it finished. */
export const QUEUED_NOTE = "(He said this on the call while you were busy; it was held until you finished.)";

/* ── The per-call book ──────────────────────────────────────────────────── */

/** One call's running turn and last barge-in. index.ts holds one per call. */
export class TurnBook {
  private turn: RunningTurn | null = null;
  private bargedAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The running turn's record (tests and logs). */
  get current(): RunningTurn | null {
    return this.turn;
  }

  /** Route an utterance against what is running now. */
  route(busy: boolean, cfg: TurnTakingConfig = turnTakingConfig()): Route {
    return routeUtterance({ busy, turn: this.turn, bargedAt: this.bargedAt, now: this.now() }, cfg);
  }

  /** A turn was dispatched (it supersedes whatever ran). Returns its record. */
  begin(transcript: string, committedAt: number = this.now(), pieces = 1): RunningTurn {
    const t: RunningTurn = { transcript, pieces, committedAt, toolStarted: false, spokenLines: 0, aborted: false };
    this.turn = t;
    return t;
  }

  /** A turn is over; forget it only if it is still the current one. */
  end(t: RunningTurn): void {
    if (this.turn === t) this.turn = null;
  }

  /** A confirmed barge-in: the running turn is aborted, the window opens. */
  barge(): void {
    this.bargedAt = this.now();
    if (this.turn) this.turn.aborted = true;
  }

  /* ── One holding sound per thought (voice step 5, answer-ladder.ts) ──── */
  private heldAt: number | null = null;

  /** A holding sound ("One sec." or a WORK line) played on this thought, and no answer has come yet. */
  held(): void {
    this.heldAt = this.now();
  }

  /** He was answered (the main answer's first sound, a FULL, a finished turn): the next turn is a new thought. */
  answered(): void {
    this.heldAt = null;
  }

  /**
   * Is the turn starting now a further piece of a thought that already had
   * its holding sound — the earlier piece superseded, merged or barged before
   * any answer, within `windowMs`? It is then this thought's piece too: the
   * window runs on from now.
   */
  thoughtHeld(windowMs: number): boolean {
    if (this.heldAt === null) return false;
    if (this.now() - this.heldAt > windowMs) {
      this.heldAt = null;
      return false;
    }
    this.heldAt = this.now();
    return true;
  }
}

/** One content-free `[turn]` line per routing decision that changes behaviour. */
export function formatRoute(voiceStreamId: string, r: Route, extra = ""): string {
  switch (r.kind) {
    case "merge":
      return `[turn] ${voiceStreamId} merge gap=${Math.round(r.gapMs)}ms pieces=${r.prior.pieces + 1}${extra}`;
    case "barge":
      return `[turn] ${voiceStreamId} barge-supersede since=${r.sinceBargeMs < 0 ? "aborted" : `${Math.round(r.sinceBargeMs)}ms`}${extra}`;
    case "talk":
      return `[turn] ${voiceStreamId} talk-supersede age=${Math.round(r.ageMs)}ms spoken=${r.spokenLines}${extra}`;
    case "gate":
      return `[turn] ${voiceStreamId} work age=${Math.round(r.ageMs)}ms tool=${r.tool ? "yes" : "no"}${extra}`;
    default:
      return `[turn] ${voiceStreamId} idle${extra}`;
  }
}
