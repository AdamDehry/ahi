import type { GateClaim } from "./front-gate.js";

/* ============================================================
   answer-ladder.ts — one arbiter per turn decides what he hears first
   (voice step 4, the owner's ruling after his 10/27 test call).

   The ladder, top rung first:
     1. answer  the fast layer can really answer (front-gate.ts FULL): it
                speaks at once and that IS the reply. Nothing after it — the
                main turn is cancelled by the caller.
     2. filler  the main answer is 10 s+ away (front-gate.ts WORK): ONE line
                built from what he said ("The Buick renders. Digging in.").
     3. hold    nothing above has claimed the turn: "One sec." at 1.4 s after
                his speech ended (hold-line.ts), for the quick lookup.
   Never two holding sounds on one turn, never a filler AND "One sec.", never a
   double answer: once a filler or the hold has played, the other is refused;
   the main answer, when it starts, ends every rung below it.

   ── Why a claim, not a race ──────────────────────────────────────────────
   On his test call the gate took 0.8–2.8 s (p50 ≈ 1.9 s) to finish its line,
   later than the 1.4 s hold — a bare timer would have said "One sec." over
   most of the gate's lines. So the hold ASKS first: the gate's tag is its
   first streamed word (~0.5 s), and a gate that has written FULL or WORK
   "claims" the turn. A claim holds the hold off until `claimMs` (3 s) after
   his speech ended; a line that is not on air by then loses the turn to the
   hold (and a late WORK line is then refused — one holding sound — while a
   late FULL answer still plays: an answer after "One sec." is not a second
   holding sound). QUICK, a rejected line or a silent gate releases the claim;
   the hold then fires at its point, or at once if that point has passed.
   A gate that has been asked and has not written its first word yet is
   "thinking": the hold waits for that word up to `askMs` (2 s) after his
   speech ended — the hold asks, and silence is not yet an answer (Codex).

   ── The clock ────────────────────────────────────────────────────────────
   Measured from his END OF SPEECH (the anchor), not from the final
   transcript: speech-end → final alone was 0.8–2.8 s on the test call, so a
   hold "1.4 s after the final" was really 2.2–4.2 s after he stopped. The
   hold never fires before the turn exists, and not before `graceMs` after it
   started — the head start the gate's draft (gate-draft.ts) needs to claim
   a turn whose final came late.

   The arbiter owns the decision; the turn's sequencer (turn-audio.ts) still
   enforces the audio order (one filler, the answer cuts it).

   ── Voice step 5 (the owner's step-4 test calls, 10/27) ───────────────────────
   "One sec." still beat the instant answer, and on the phone it was said at
   every mid-thought pause. Three rules:
     · ONE HOLDING SOUND PER THOUGHT. A turn that continues a thought whose
       earlier piece already played "One sec." or a WORK line (the piece was
       superseded or barged before any answer) plays neither (`thoughtHeld`;
       index.ts keeps the thought on the call's TurnBook). A queued turn —
       held behind work and run later — plays no hold either.
     · NEVER OVER HIM. When the hold comes due while he is talking again, it
       waits (`talking`); his new words usually supersede the turn first.
     · A GATE IN FLIGHT IS ASKED. The ask window also runs `askFloorMs` from
       when the gate (or its draft) was asked, not only from his speech end:
       a late final no longer leaves the gate 250 ms to speak.

   ── Voice step 6 (the owner's phone call, 10/28) ──────────────────────────────
   "One sec." still opened 9 of his 12 turns, and he barely heard a real
   filler. Most turns were QUICK (the answer a few seconds away), and QUICK
   had no line, so "One sec." was all there was. A new rung, between the
   filler and the hold:
     · BRIDGE. The gate's QUICK now carries a short line that reacts to what
       he said ("Ah, the phone lag."). It is the reply's first words, so it
       waits for the answer: it goes on air when the answer's first sentence
       is handed to the voice — the answer then plays straight behind it, one
       reply — or at `bridgeWaitMs` after his speech ended, whichever comes
       first, so he is never left in silence for long. Its claim keeps "One
       sec." off until it has had that long (plus `BRIDGE_SLACK_MS` to render).
       It is this turn's one holding sound: a bridge, a WORK line and "One
       sec." never stack. CALL_BRIDGE=off; CALL_BRIDGE_WAIT_MS.
   ============================================================ */

/** The sequencer state the arbiter reads (a TurnAudioSequencer). */
export interface LadderSeq {
  readonly answerStarted: boolean;
  readonly answerPending: boolean;
  readonly filler: { text: string } | null;
}

export type Rung = "answer" | "filler" | "bridge" | "hold";

/** What the fast layer may put on air: its instant answer, a WORK line, or a bridge (voice step 6). */
export type FastKind = "answer" | "filler" | "bridge";

/** What the fast layer's turn driver asks of the arbiter (turn-audio.ts runFrontVoiceTurn). */
export interface LadderGate {
  /** May this line go on air right now? */
  admit(kind: FastKind): boolean;
  /** It went on air. */
  played(kind: FastKind): void;
  /** When a bridge stops waiting for the answer and plays anyway (absolute ms; voice step 6). */
  readonly bridgeDueAt?: number;
  /** The fast layer will not speak after all (no line, refused, render failed). */
  release(why: string): void;
}

export interface AnswerLadderOptions {
  seq: LadderSeq;
  /** His speech ended (ms); the final transcript's time when unknown. */
  anchorAt: number;
  /** When the turn started (the final transcript, ms). The hold never fires before `startedAt + graceMs`. */
  startedAt: number;
  /** The hold point after the anchor; 0 = no hold this turn. */
  holdMs: number;
  /** How long after the anchor a claim keeps the hold off. */
  claimMs: number;
  /**
   * How long after the anchor the hold waits for a fast layer that is still
   * thinking — asked, no first word yet (`asking()`). The hold ASKS before it
   * speaks: no answer to the question is not a "no" until this point (Codex,
   * step 4). 0 = the hold does not wait.
   */
  askMs?: number;
  graceMs?: number;
  /**
   * The ask window's floor after the gate (or its draft) was asked: a gate
   * in flight gets at least this long for its first word, however late the
   * final came (voice step 5). 0 = no floor.
   */
  askFloorMs?: number;
  /**
   * How long after his speech ended a bridge waits for the answer before it
   * plays alone (voice step 6). 0 = it plays the moment it is ready.
   */
  bridgeWaitMs?: number;
  /** Is he talking right now? A hold that comes due then waits until he stops (voice step 5). */
  talking?: () => boolean;
  /**
   * An earlier piece of this thought already played a holding sound (voice
   * step 5): no hold and no WORK line this turn — the answer, or a FULL, only.
   */
  thoughtHeld?: boolean;
  /** Play the hold line now: its text if it went on air, else null. */
  playHold: () => string | null;
  /** The turn ended (answered, superseded, barged): the arbiter stops. */
  signal: AbortSignal;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  /** One line per decision, for the gateway log. */
  log?: (line: string) => void;
}

/**
 * Default: the hold's claim window. Step 4: 3 s (the owner: "if it can answer
 * within ~3 s, it cancels the One sec."). Step 6: 4.5 s — on later calls
 * a claimed line was on air 3.4 s after he stopped (median), so at 3 s
 * "One sec." beat 13 of the gate's real lines; at 4.5 s, 4 (replayed).
 * CALL_CLAIM_MS=3000 is step 5.
 */
export const LADDER_CLAIM_MS_DEFAULT = 4_500;
/** Default head start after the turn starts, before an overdue hold fires. */
export const LADDER_GRACE_MS_DEFAULT = 250;
/** Default wait for a thinking fast layer's first word, after his speech ended (step 5: 2 s; step 6: 2.5 s). */
export const LADDER_ASK_MS_DEFAULT = 2_500;
/**
 * Default floor for a gate in flight, after it was asked. Step 5: 1.3 s (its
 * first word: p50 0.81 s, p90 1.24 s). Step 6: 2 s — replayed on
 * recorded turns with the bridge prompt, p50 0.8–1.1 s, p90 2.2 s.
 */
export const LADDER_ASK_FLOOR_MS_DEFAULT = 2_000;
/** Default wait for the answer behind a bridge, after his speech ended (voice step 6). */
export const LADDER_BRIDGE_WAIT_MS_DEFAULT = 2_500;
/** A bridge's claim outlasts its wait by this much: its render and first word. */
export const BRIDGE_SLACK_MS = 1_000;
/** While he talks, a due hold looks again this often. */
const TALKING_RECHECK_MS = 150;
/** A hold that could not play (its line not rendered yet) tries again this often, this many times. */
const HOLD_RETRY_MS = 250;
const HOLD_RETRIES = 8;

function envMs(raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** CALL_CLAIM_MS: how long a claim holds the hold off, after his speech ended. */
export function ladderClaimMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.CALL_CLAIM_MS, LADDER_CLAIM_MS_DEFAULT);
}

/** CALL_HOLD_ASK_MS: how long the hold waits for a thinking fast layer's first word. */
export function ladderAskMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.CALL_HOLD_ASK_MS, LADDER_ASK_MS_DEFAULT);
}

/** CALL_HOLD_ASK_FLOOR_MS: how long after the gate was asked the hold waits for its first word, at least. */
export function ladderAskFloorMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.CALL_HOLD_ASK_FLOOR_MS, LADDER_ASK_FLOOR_MS_DEFAULT);
}

const flagOn = (raw: string | undefined, dflt: boolean): boolean => {
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "no") return false;
  if (v === "on" || v === "true" || v === "1" || v === "yes") return true;
  return dflt;
};

/** CALL_BRIDGE_WAIT_MS: how long a bridge waits for the answer behind it, after his speech ended. */
export function ladderBridgeWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.CALL_BRIDGE_WAIT_MS, LADDER_BRIDGE_WAIT_MS_DEFAULT);
}

/** CALL_HOLD_PER_THOUGHT=off: every piece of a thought may play its own holding sound again (step 4). */
export function holdOncePerThought(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env.CALL_HOLD_PER_THOUGHT, true);
}

/** CALL_QUEUED_HOLD=on: a turn queued behind work plays "One sec." when it runs (step 4). */
export function queuedTurnHolds(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env.CALL_QUEUED_HOLD, false);
}

/** CALL_HOLD_WHILE_TALKING=on: the hold plays when due even if he is talking (step 4). */
export function holdWaitsForSilence(env: NodeJS.ProcessEnv = process.env): boolean {
  return !flagOn(env.CALL_HOLD_WHILE_TALKING, false);
}

/** CALL_HOLD_THOUGHT_MS: how long a thought's holding sound covers the pieces after it. */
export function holdThoughtMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.CALL_HOLD_THOUGHT_MS, 30_000);
}

/** CALL_HOLD_GRACE_MS: the gate's head start after a late final. */
export function ladderGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.CALL_HOLD_GRACE_MS, LADDER_GRACE_MS_DEFAULT);
}

export class AnswerLadder implements LadderGate {
  private claimed: GateClaim | null = null;
  private thinking = false;
  /** When the gate (or its draft) was asked, while it thinks. */
  private askedAt = 0;
  /** When the gate's claim came. */
  private claimedAt = 0;
  private waitedForHim = false;
  private retries = 0;
  private onAir: Rung | null = null;
  private holdPlayed = false;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly graceMs: number;

  constructor(private readonly o: AnswerLadderOptions) {
    this.now = o.now ?? Date.now;
    this.schedule =
      o.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return () => clearTimeout(t);
      });
    this.graceMs = o.graceMs ?? LADDER_GRACE_MS_DEFAULT;
    if (o.signal.aborted) this.stopped = true;
    else o.signal.addEventListener("abort", () => this.close(), { once: true });
    this.arm();
  }

  /** The first thing this turn said, by rung (the answer replaces the hold when it follows it). */
  get rung(): Rung | null {
    return this.onAir;
  }

  /** The hold line played this turn. */
  get held(): boolean {
    return this.holdPlayed;
  }

  /** The claim standing now (null: none, or released). */
  get claim(): GateClaim | null {
    return this.claimed;
  }

  /** When a bridge plays even with no answer behind it (absolute ms). */
  get bridgeDueAt(): number {
    return this.o.anchorAt + (this.o.bridgeWaitMs ?? 0);
  }

  /** A bridge is claimed and not yet on air: the answer's own stall must not jump it (index.ts). */
  get bridgePending(): boolean {
    return !this.stopped && this.claimed === "bridge" && this.onAir === null && !this.holdPlayed && this.answerOpenedWith === null;
  }

  /** The answer's first sentence was its own stall or bare beat, handed to the voice (index.ts). */
  private answerOpenedWith: "stall" | "beat" | null = null;

  /**
   * The answer opens with a holding sound of its own ("Let me check.") or a
   * bare beat ("Good question."): a bridge not yet on air would stack on it,
   * so none plays this turn (Codex, step 6). Said before the sentence is
   * handed to the voice, so a bridge waiting for that cue sees it.
   */
  answerOpened(how: "stall" | "beat"): void {
    if (this.answerOpenedWith === null) this.answerOpenedWith = how;
  }

  private log(line: string): void {
    this.o.log?.(`${line} +${this.now() - this.o.anchorAt}ms`);
  }

  /** The main answer has started, or is on its way to the voice: no rung below it may start. */
  private answerUnderway(): boolean {
    return this.o.seq.answerStarted || this.o.seq.answerPending;
  }

  /** When the hold is due now: its point; the claim's end while a line is claimed; the ask's end while the fast layer thinks. */
  private dueAt(): number {
    const live = this.claimed === "answer" || this.claimed === "filler" || this.claimed === "bridge";
    const asking = this.thinking && this.claimed === null;
    // A bridge waits for the answer up to its own point: its claim outlasts that (voice step 6).
    const claimWait = this.claimed === "bridge" ? Math.max(this.o.claimMs, (this.o.bridgeWaitMs ?? 0) + BRIDGE_SLACK_MS) : this.o.claimMs;
    const wait = live ? claimWait : asking ? (this.o.askMs ?? 0) : 0;
    let point = this.o.anchorAt + Math.max(wait, this.o.holdMs);
    // A gate in flight gets its floor from when it was asked, however stale the anchor.
    if (asking && this.askedAt) point = Math.max(point, this.askedAt + (this.o.askFloorMs ?? 0));
    // A claimed line keeps the same floor from its claim: it is being written and rendered (Codex, step 5).
    if (live && this.claimedAt) point = Math.max(point, this.claimedAt + (this.o.askFloorMs ?? 0));
    return Math.max(point, this.o.startedAt + this.graceMs);
  }

  /** No hold this turn at all: none configured, or the thought already had its holding sound. */
  private get noHold(): boolean {
    return this.o.holdMs <= 0 || this.o.thoughtHeld === true;
  }

  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.stopped || this.noHold || this.onAir || this.holdPlayed) return;
    this.cancelTimer = this.schedule(() => this.fire(), Math.max(0, this.dueAt() - this.now()));
  }

  private fire(): void {
    this.cancelTimer = null;
    if (this.stopped || this.onAir || this.holdPlayed) return;
    if (this.answerUnderway() || this.o.seq.filler) return;
    if (this.now() < this.dueAt()) return this.arm();
    // Never over him: he went on talking, and his words will most likely supersede this turn.
    if (this.o.talking?.()) {
      if (!this.waitedForHim) this.log("[ladder] hold waits — he is talking");
      this.waitedForHim = true;
      this.cancelTimer = this.schedule(() => this.fire(), TALKING_RECHECK_MS);
      return;
    }
    const text = this.o.playHold();
    if (!text) {
      // Its line not rendered yet (the first call of the day): try again shortly, a few times (Codex, step 4).
      if (this.retries++ < HOLD_RETRIES) this.cancelTimer = this.schedule(() => this.fire(), HOLD_RETRY_MS);
      return;
    }
    this.holdPlayed = true;
    this.onAir = "hold";
    this.log(`[ladder] hold "${text}"${this.claimed && this.claimed !== "pass" ? ` (the ${this.claimed} claim ran out)` : ""}`);
  }

  /** The fast layer has been asked and has not said its first word yet: the hold waits for it, up to `askMs`. */
  asking(since?: number): void {
    if (this.stopped || this.onAir || this.claimed !== null || this.thinking) return;
    this.thinking = true;
    this.askedAt = since ?? this.now();
    this.arm();
  }

  /** The gate's first word: it is about to answer, about to say a WORK line, or passes (QUICK). */
  claimTurn(claim: GateClaim): void {
    if (this.stopped || this.onAir || this.claimed === claim) return;
    this.thinking = false;
    this.claimed = claim;
    this.claimedAt = this.now();
    this.log(`[ladder] claim ${claim}`);
    this.arm();
  }

  admit(kind: FastKind): boolean {
    if (this.stopped) return false;
    // A bridge opens the answer: it may go on air once the answer is on its way, never once it is audible.
    if (kind === "bridge" ? this.o.seq.answerStarted : this.answerUnderway()) return false;
    // Nothing of this turn goes on air over him: he went on, and his words will most likely supersede it (Codex, step 5).
    if (this.o.talking?.()) return false;
    // An answer after "One sec." is the reply, not a second holding sound.
    if (kind === "answer") return this.onAir !== "answer" && this.onAir !== "filler";
    // The thought already had its holding sound (an earlier piece): no WORK line now.
    if (this.o.thoughtHeld) return false;
    // The answer opened with its own stall or beat: a bridge would be a second one (Codex, step 6).
    if (kind === "bridge" && this.answerOpenedWith !== null) return false;
    return this.onAir === null && !this.o.seq.filler;
  }

  played(kind: FastKind): void {
    this.onAir = kind;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.log(`[ladder] ${kind}${this.holdPlayed ? " after the hold" : ""}`);
  }

  release(why: string): void {
    if (this.stopped || this.onAir) return;
    const wasThinking = this.thinking;
    this.thinking = false;
    if (this.claimed === null || this.claimed === "pass") {
      this.claimed = null;
      if (wasThinking) this.arm();
      return;
    }
    this.claimed = null;
    this.log(`[ladder] released (${why})`);
    this.arm();
  }

  close(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
}

/* ── The main brain's own stall (rule 5, enforced in code) ────────────────
   Michael's main turn often opens with "Let me check the calendar." before
   its first tool call. After "One sec." or the gate's WORK line, that is a
   SECOND holding sound on one turn — exactly what the owner ruled out. So the
   answer's FIRST spoken sentence is dropped from the voice (it still shows on
   screen) when a holding sound already played this turn and the sentence is
   only a stall: it opens with one ("Let me", "Checking", "One sec" — never
   "I'll", which is a commitment), and once the stall words are gone at most
   four words remain ("the calendar for tomorrow"). A sentence that carries
   anything more ("Let me check — you have the dealer at noon") is spoken.
   CALL_SECOND_STALL=keep speaks it, as before step 4. */

const STALL_LEAD = /^(?:(?:okay|ok|alright|all right|sure|right|so|yeah|yes|got it|on it|sir)[,.!]?\s+)*/i;
const STALL_OPEN =
  /^(?:let me|lemme|i'm going to|i'm gonna|i'm (?:checking|looking|pulling|digging|on it|grabbing|searching)|give me (?:a|one) (?:sec|second|moment|minute)|one sec(?:ond)?|a sec(?:ond)?|just a (?:sec|second|moment)|hang on|hold on|bear with me|checking|looking|pulling|digging|searching|grabbing|on it)\b/i;
const STALL_VERB =
  /^(?:(?:let me|lemme|i'm going to|i'm gonna|i'm)\s+)?(?:quickly\s+|just\s+)?(?:check(?:ing)?|look(?:ing)?(?: (?:at|into|up|that up|it up))?|pull(?:ing)?(?: up| that up| it up)?|dig(?:ging)?(?: in| into)?|find(?:ing)?|see|grab(?:bing)?|search(?:ing)?|take a look(?: at)?|have a look(?: at)?|on it|give me (?:a|one) (?:sec|second|moment|minute)|one sec(?:ond)?|a sec(?:ond)?|just a (?:sec|second|moment)|hang on|hold on|bear with me)\b/i;

/**
 * Is this sentence nothing but a stall ("Let me check the calendar.")? Pure.
 * A recognised stall construction must be there (an opener AND a stall verb:
 * "I'll call you." is a commitment, not a stall — Codex, step 4), and once it
 * is gone at most four words may remain.
 */
export function isBareStall(sentence: string): boolean {
  const t = sentence.trim();
  if (!t || /[0-9?]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 10) return false;
  const body = t.replace(STALL_LEAD, "");
  if (!STALL_OPEN.test(body)) return false;
  const verb = body.match(STALL_VERB);
  if (!verb || verb.index !== 0 || !verb[0].trim()) return false;
  const rest = body.slice(verb[0].length).replace(/[^A-Za-z' ]+/g, " ").trim();
  if (/\b(not|never|no|can't|cannot|won't|don't)\b/i.test(rest)) return false;
  // Acting on a person ("…check you in", "…pull him off it") is a commitment, not a stall (Codex r2).
  if (/^(you|him|her|them|us|me)\b/i.test(rest)) return false;
  return rest === "" || rest.split(/\s+/).length <= 4;
}

/* ── After a bridge (voice step 6) ───────────────────────────────────────
   The bridge already gave his line its beat ("Ah, the phone lag."). An
   answer that opens with a bare beat of its own ("Good question.") would be
   a second one, back to back. Only that closed family is dropped (shown, not
   said): a beat that carries meaning — "Got it", "Fair enough", "Sure" — is
   the answer's, and stays. */
const BARE_BEAT =
  /^(?:(?:okay|ok|ah|oh|so|well|hm+|mm+)[,.!]?\s+)*(?:(?:a |that's a |that is a )?(?:good|great|fair|interesting|excellent|solid|smart|real) (?:question|point|catch|one)|i see)[.!…]*$/i;

/** Is this sentence only a beat ("Good question.") that a bridge already gave? Pure. */
export function isBareBeat(sentence: string): boolean {
  return BARE_BEAT.test(sentence.trim());
}

export function dropSecondStall(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CALL_SECOND_STALL ?? "drop").trim().toLowerCase() !== "keep";
}
