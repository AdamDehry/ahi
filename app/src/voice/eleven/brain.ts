import { SpokenTextFeed } from "../../voice-tts-stream.js";
import { beginWorkingTurn, describeWork, turnsInFlight, type WorkingTurn } from "../turn-liveness.js";
import {
  BARGE_NOTE,
  MERGE_NOTE,
  QUEUED_NOTE,
  TurnBook,
  bargeNote,
  formatRoute,
  joinPieces,
  type RunningTurn,
} from "../turn-taking.js";
import { backchannel, classifyWhileWorking, queuesWhileWorking, statusLine } from "../work-gate.js";
import { lexicalAck } from "../ack-gate.js";
import { ELEVEN_HOLD_LINE } from "./config.js";
import { alreadySaidNote, NothingNewFilter, stripNothingNew } from "../already-said.js";
import type { TranscriptMessage } from "./upstream.js";

/* ============================================================
   eleven/brain.ts — one ElevenLabs call's brain: their ears and mouth, our
   turn.

   ElevenLabs (Speech Engine) does the audio: the mic, recognition, turn
   detection, barge-in, the voice. What reaches us is a transcript event per
   finished user turn; what we send back is text, streamed, which they speak.
   Everything between is the native call's own logic, reused, not forked:

     silent acks    ack-gate's decideAck (injected) → an empty response: the
                    agent says nothing
     turn-taking    TurnBook routes a new utterance against the turn running:
                    merge / barge / talk supersede, real work goes to…
     work gate      status → statusLine, stop → supersede, talk → the talk
                    lane (below), anything else → queued with a backchannel
                    ("Mm-hm.", rotated)
     talk lane      a question or conversation heard while real work runs is
                    answered AT ONCE by a companion turn (injected
                    `companion`): no tools, the call so far as its context,
                    the work going on beside it. It owns the voice while it
                    speaks; the work's words wait and follow with a seam
                    ("Also," / "And,"). ELEVEN_TALK_LANE=off → talk queues.
     the turn       ONE invoke per turn through the same voice-invoke options
                    (injected `invoke`): same brain, memory, tools and session
                    scope as a native call
     front voice    the Haiku line (injected `frontLine`) is said first when
                    the answer has not started by the deadline
     spoken/work    SpokenTextFeed: spoken runs go to ElevenLabs, `» ` work
                    lines go to the app as `voice-work` — never into the voice
     liveness       beginWorkingTurn: the status answer's numbers, and the
                    spoken check-in after long silent work

   THE SPEAKING SLOT. ElevenLabs drops anything we send under an event id
   older than its newest transcript. So the running turn never owns an event:
   it speaks into whatever event is current. "How's it going?" mid-build gets
   its status line on the new event and the build's answer follows on that
   same event when it lands. An event is finished (is_final) when the turn it
   is waiting on ends, or at once when nothing is running and its answer was
   a fixed line, or silence.

   NO RESPONSE STAYS OPEN (eleven-call-stability, 10/22). The engine retries
   a response that is quiet 15 s and fails the call on the third window
   ("LLM Cascade Error: TimeoutError"); no keepalive gets a response past
   ~45 s. So an event is ended (is_final) when work starts after something
   was said, and at the latest `maxOpenMs` (10 s) after its last real text;
   whatever the turn says later is owed. Owed speech rides the next event —
   his words, the engine's own re-engage (it comes once, ~1 s after spoken
   audio, never after an empty answer), or, when neither is coming, a "..."
   the app sends on request (`nudge`). An event a newer one overtook gets its
   final at once, and a re-sent old id gets an empty final: the engine keeps
   waiting on an unanswered event, overtaken or not, and retries it.

   No audio, no sockets, no timers beyond the turn's own: the wire and the
   model are injected, so the whole thing runs under test with fakes.
   ============================================================ */

export interface ElevenBrainDeps {
  voiceStreamId: string;
  bot: string;
  /** One Michael turn. Streams text through onChunk; a tool call through onToolUse. */
  invoke(args: {
    message: string;
    signal: AbortSignal;
    onChunk: (text: string) => void;
    onToolUse: () => void;
  }): Promise<{ response: string; cost?: number; inputTokens?: number; outputTokens?: number }>;
  /** The front voice's line for what he said, or null. Never throws. (Superseded by frontGate when both are given.) */
  frontLine?: (heard: string, signal: AbortSignal) => Promise<{ line: string | null; reason?: string; ms: number }>;
  /**
   * Fast OR slow (front-gate.ts): `full` = the fast voice's reply IS the
   * answer and the main turn is cancelled; `ack` = a holding line, the main
   * turn answers; `silent` = no line. Never throws.
   */
  frontGate?: (
    heard: string,
    recentCall: { role: "user" | "agent"; text: string }[],
    signal: AbortSignal,
  ) => Promise<{ kind: "full" | "ack" | "silent"; line: string | null; reason: string; ms: number }>;
  /**
   * The talk lane's turn: same brain and voice rules, NO tools, never the
   * call's session (two turns resuming one session at once would fork it).
   * Absent = no talk lane. A tool call (onToolUse) means it needed hands.
   */
  companion?(args: {
    message: string;
    signal: AbortSignal;
    onChunk: (text: string) => void;
    onToolUse: () => void;
  }): Promise<{ response: string; cost?: number; inputTokens?: number; outputTokens?: number }>;
  /** The talk lane is on (default true when `companion` is given). ELEVEN_TALK_LANE=off → false. */
  talkLane?: boolean;
  /** A front line that was actually said (the do-not-repeat list). */
  frontLineSaid?: (line: string) => void;
  /** Is this utterance only an acknowledgement? Never throws. */
  isAck?: (heard: string, lastAgentLine: string | null, signal: AbortSignal) => Promise<{ silent: boolean; reason: string; ms: number }>;
  /** Text toward ElevenLabs for an event. */
  respond(eventId: number, content: string, isFinal: boolean): void;
  /** A control event toward the caller's app (work lines, beats). */
  toApp(msg: Record<string, unknown>): void;
  /** One content-free log line. */
  log(line: string): void;
  frontDeadlineMs: number;
  holdMs: number;
  /** Quick lines end their response so they are spoken at once (default true). */
  quickFinal?: boolean;
  /** A held answer sentence goes out in flush form after this much quiet (default 1.2 s: streaming jitter is shorter, tool work longer). */
  flushMs?: number;
  /** An empty non-final chunk after this much quiet while a turn works; 0/absent = never. */
  keepaliveMs?: number;
  /** An open event is ended this long after its last real text (default 10 s). */
  maxOpenMs?: number;
  /** An open event is ended this long after its transcript, however much text flows (default 30 s). */
  maxResponseMs?: number;
  /**
   * Ask the app to open an event (it sends "..."): owed speech and nothing
   * open. `false` withdraws an ask an event already answered. Absent = wait for him.
   */
  nudge?: (on?: boolean) => void;
  /**
   * A grown line is a revision only while the turn answering the shorter
   * version runs and nothing of it was said (default true). False: every
   * grown line is a revision (ELEVEN_REVISION_STRICT=off, the earlier rule).
   */
  revisionStrict?: boolean;
  /**
   * An owed answer paid on his new words is that turn's "already said": the
   * turn is told so, may stay silent, and gets no holding line (already-said.ts).
   * Default true; ELEVEN_ALREADY_SAID=off restores the earlier behaviour.
   */
  alreadySaid?: boolean;
  /** A turn-telemetry row (turn-logger), when wired. */
  logTurn?(row: Record<string, unknown>): void;
  now?: () => number;
  /** Timer seam (tests). */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Is this error a concurrency-cap refusal? */
  isCapError?: (err: unknown) => boolean;
}

interface EventSlot {
  id: number;
  receivedAt: number;
  final: boolean;
  /** Text sent under this id (what the engine was asked to say). */
  said: string;
  firstChunkAt: number;
  /** When real text last went out under this id (0 = none yet). */
  lastTextAt: number;
  /** Cancels the open-limit timer. */
  cancelOpen: () => void;
  /** What opened it, for the owed-speech timing line: his words, or a re-engage (after our nudge or not). */
  cause: string;
  /** The talk lane said the last words sent under it: a cut here is into the companion, not the work. */
  companionLast?: boolean;
  /** An earlier answer paid on this event ahead of the turn for his words: what he just heard. */
  paidOwed?: string;
}

interface Running {
  controller: AbortController;
  rt: RunningTurn;
  live: WorkingTurn;
  /** The heard text this turn answers (for logs and the record). */
  heard: string;
  /** His line this turn answers (the newest piece when pieces were joined). */
  line: string;
  /**
   * His whole line as the engine held it when `line` was cut from it. They
   * differ when his line grew after an answer: the turn answers only the
   * added words, and a second growth is measured against the whole line.
   */
  whole: string;
  startedAt: number;
  /** Spoken text of this turn, as sent (filler included). */
  spoken: string;
  /** The answer's own first spoken piece has gone out. */
  answered: boolean;
  frontPlayed: string | null;
  cancelTimers: Array<() => void>;
  /** Talk-lane exchanges this turn was told about (cleared from the list when it finishes). */
  toldTalk: number;
}

/** The talk lane's turn: answers him while the work turn runs on. */
interface Companion {
  controller: AbortController;
  /** His words it answers (a second remark merged in joins them). */
  heard: string;
  startedAt: number;
  /** Its spoken text as sent. */
  spoken: string;
  /** When its first spoken piece went out (0 = none yet). */
  firstAt: number;
  /** It found the remark needs hands: handed back to the work as an addition. */
  handedBack: boolean;
  /** Its deadlines (first words, whole answer): cancelled when it ends. */
  cancelTimers: Array<() => void>;
}

/** What the server's own call card is built from. */
export interface ElevenCallRecord {
  startedAt: number;
  durationSec: number;
  turns: number;
  transcript: { role: "user" | "agent"; text: string }[];
}

const MAX_RECORD_TURNS = 200;
const MAX_RECORD_TEXT = 4000;
const ERROR_LINE = "Error processing voice turn. Try again.";
/** The talk lane's line when a remark needs tools: it is then handed to the work. */
export const NEEDS_HANDS_LINE = "That one needs hands, I'll take it after this.";
/** What the companion writes, alone, when it cannot answer without tools. */
export const NEEDS_HANDS_MARK = "[[needs-hands]]";
const NEEDS_HANDS_RE = /\[\[\s*needs[\s-]*hands\s*\]\]/i;
/** The word that joins the work's held answer onto the companion's: rotated, never a knob. */
export const SEAM_WORDS = ["Also,", "And,"] as const;
/**
 * The companion's deadlines: its first words, then its whole answer. Past
 * either it is given up and the remark goes to the work as before the lane
 * existed — a hung companion would otherwise hold the work's words, its
 * check-ins and a landed answer for as long as the spawn ceiling allows.
 * They match the event's own limits (open 10 s after the last text, 30 s in
 * all): past those nothing it says rides his question's response anyway.
 */
export const COMPANION_FIRST_WORDS_MS = 10_000;
export const COMPANION_MAX_MS = 30_000;
/** The call so far, as the companion is told it. */
const COMPANION_CONTEXT_LINES = 12;
const CAP_LINE = "I'm handling another message right now. One sec.";

const realSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export class ElevenCallBrain {
  readonly startedAt: number;
  private event: EventSlot | null = null;
  private running: Running | null = null;
  private readonly book: TurnBook;
  private queued: string[] = [];
  /** The backchannel said last on this call: the next one is never the same. */
  private lastBackchannel: string | null = null;
  private record: { role: "user" | "agent"; text: string }[] = [];
  /** The last completed agent turn: its record index, what was sent for it, and its front line. */
  private lastAgent: { idx: number; spoken: string; front: string | null } | null = null;
  /**
   * Turns the fast voice answered in full since the main brain last finished
   * one: the main brain never saw them (its turn was cancelled), so the next
   * turn it runs is told what was said.
   */
  private fastSince: { heard: string; said: string }[] = [];
  private userTurns = 0;
  private closed = false;
  /** The app reported an interruption (the SDK's own barge-in event) at this time. */
  private interruptedAt = 0;
  /**
   * HIS lines in the newest history seen, not counting the engine's "..."
   * re-engage lines — an event that adds none of his is not a new turn. The
   * "..." lines come and go from the history the engine sends; counting them
   * made his next fresh line read as a "revision" of the one before
   * (his previous line overwritten in the card, the fresh turn sent with the
   * merge note, the earlier answer said again).
   */
  private realLinesSeen = 0;
  /** Record index of his newest FRESH line (not a revision): what a superseded turn's words go before. */
  private newestFresh = -1;
  /** His last line as last seen, to tell a revision from a repeat. */
  private lastUserContent = "";
  /** Nudges asked for since the last event arrived, and when the last one was. */
  private nudges = 0;
  private nudgedAt = 0;
  /** The newest event id seen; older ones are retries of overtaken turns. */
  private maxEventId = -1;
  /** Speech with no open event to go on: said first on the next one. */
  private owed = "";
  /** When the owed speech began waiting, and when the turn it belongs to finished (0 = still running). */
  private owedAt = 0;
  private owedDoneAt = 0;
  /** His line waiting on the ack classifier (and the whole line it was cut from): nothing has answered it yet. */
  private ackPending: { heard: string; whole: string } | null = null;
  /** The newest answer sentence, not sent yet (see holdAnswer). */
  private held: { text: string; cancel: () => void } | null = null;
  /** When anything (text or keepalive) last went to ElevenLabs. */
  private lastSentAt = 0;
  /** The talk lane's turn, while it runs (one at a time). */
  private companion: Companion | null = null;
  /** The work turn's words held while the companion has the voice. */
  private workHeld: string[] = [];
  /** The work turn ended while the companion spoke: the rest of its ending waits for the companion. */
  private landed: ((quiet: boolean) => void) | null = null;
  /** Seam words said so far (the rotation). */
  private seams = 0;
  /** Talk-lane exchanges no work turn has been told about yet. */
  private talkSince: { heard: string; said: string }[] = [];
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly d: ElevenBrainDeps) {
    this.now = d.now ?? Date.now;
    this.schedule = d.schedule ?? realSchedule;
    this.startedAt = this.now();
    this.book = new TurnBook(this.now);
  }

  get busy(): boolean {
    return this.running !== null;
  }

  get turns(): number {
    return this.userTurns;
  }

  /** The app's client SDK saw him cut in (its `interruption` event). */
  noteInterruption(): void {
    this.interruptedAt = this.now();
    // Talking over a warm-up or hold line is not cutting off the answer: the
    // work it was buying time for goes on.
    const filler = this.fillerOnly();
    // Talking over the talk lane is cutting off the companion, never the work beside it.
    const overTalk = !!this.companion || !!this.event?.companionLast;
    if (this.running && !filler && !overTalk) this.book.barge();
    this.d.log(
      `[eleven] ${this.d.voiceStreamId} cut-in (client)${filler ? " over a warm-up line — the work goes on" : overTalk ? " over the talk lane — the work goes on" : ""}`,
    );
  }

  /** The running turn has said only filler (a front or hold line), none of its answer. Strict rule only. */
  private fillerOnly(): boolean {
    const run = this.running;
    return this.d.revisionStrict !== false && !!run && !!run.spoken.trim() && !run.answered;
  }

  /* ── Transcript events ──────────────────────────────────────────────── */

  onTranscript(history: TranscriptMessage[], eventId: number): void {
    if (this.closed) return;
    // A retry of the event we are already answering (the engine abandoned its
    // wait and resent it): the answer in progress goes on under the same id.
    if (this.event && eventId === this.event.id && !this.event.final) {
      this.d.log(`[eleven] ${this.d.voiceStreamId} duplicate event ${eventId} ignored (+${this.now() - this.event.receivedAt}ms, ${this.event.said.length}ch already sent)`);
      return;
    }
    // Event ids only go up. An older one coming back (a retry of a turn long
    // since overtaken) must not become the current event: everything sent
    // under it is discarded by ElevenLabs — that silenced half a reply.
    // It still gets its final: the engine waits on every event it sent until
    // that event is finished, and retries it every 15 s until then (measured).
    if (eventId >= 0 && eventId <= this.maxEventId) {
      this.d.respond(eventId, "", true);
      this.d.log(`[eleven] ${this.d.voiceStreamId} stale event ${eventId} closed (newest ${this.maxEventId})`);
      return;
    }
    if (eventId >= 0) this.maxEventId = eventId;
    const prev = this.event;
    const at = this.now();
    // Overtaken: finish it now, or the engine retries it (calls 1 and 2).
    if (prev && !prev.final) {
      prev.final = true;
      prev.cancelOpen();
      this.d.respond(prev.id, "", true);
    }
    prev?.cancelOpen();
    const nudged = this.nudges > 0;
    // An event is here: a nudge the app is still holding back would only open
    // an empty one after it (sent 13 s late, an empty turn).
    if (nudged) this.d.nudge?.(false);
    this.event = { id: eventId, receivedAt: at, final: false, said: "", firstChunkAt: 0, lastTextAt: 0, cancelOpen: () => {}, cause: "" };
    this.armOpen(this.event);
    this.nudges = 0;

    const split = splitHistory(history);
    const { agentBefore } = split;
    // His own lines: the engine's "..." re-engage lines are not him.
    const his = history.filter((m) => m.role === "user" && !isReengage(m.content.trim()));
    const realLines = his.length;
    // A line his words merged into after a "..." can keep the dots in front.
    const lastReal = realLines ? his[realLines - 1].content.trim().replace(/^[.\u2026\s]+/, "") : "";
    // The engine re-engaging after turn_timeout appends a user line of just
    // "...". That is not him: it is our cue to say what is owed.
    const reengage = !!split.heard && isReengage(split.heard);
    // A new line of his. (An event that adds none — the engine re-prompting on
    // its own turn timeout — is not something he said: never replay his last turn.)
    // Consecutive user turns merge into ONE line: his words after an
    // unanswered "..." REPLACE it (stability build). Counting
    // only his real lines makes that a new line too — one rule for both: call
    // 3 was read as a revision, call 2's "Are you still working?" got silence.
    const fresh = !reengage && realLines > this.realLinesSeen;
    // ElevenLabs revises his last line in place when he keeps talking
    // ("Wait," → "Wait, stop. What time is it?"): same count, new words.
    // Punctuation or casing settling on the same words is not a revision.
    const grew = !fresh && !reengage && realLines === this.realLinesSeen && !!lastReal && norm(lastReal) !== norm(this.lastUserContent);
    this.realLinesSeen = Math.max(this.realLinesSeen, realLines);
    const previous = this.lastUserContent;
    if (fresh || grew) this.lastUserContent = lastReal;
    this.event.cause = fresh || grew ? "his words" : reengage ? (nudged ? "a re-engage, ours or the engine's" : "the engine's re-engage") : "no new words";
    // ElevenLabs merges his consecutive turns into ONE line, so a NEW sentence
    // after a pause looks exactly like a revision (every fresh sentence
    // restarted the turn, 3-6 s and one wasted invoke each). A grown line is a
    // revision only while the turn for the shorter line runs and nothing of
    // it has been said ("Wait," → "Wait, stop. What time is it?"); once he
    // heard something for it, or it finished, the added words are a new line.
    const strict = this.d.revisionStrict !== false;
    const unanswered = grew && strict ? this.stillRevisable(previous) : null;
    if (grew && (!strict || unanswered)) {
      this.revise(previous, lastReal, eventId, unanswered);
      return;
    }
    // His line grew while the turn answering it is still being said — the
    // engine kept his line open, so this is the rest of the same thought (the
    // one call: the fragment and the add-on got two answers). One
    // answer: that turn stops here and one turn answers the whole line, told
    // what he already heard. Real work is not thrown away: the work gate takes it.
    // A bare "okay" while it speaks is an ack, a status question gets its
    // status and a stop stops: those keep their own doors below.
    const open = grew && strict ? this.answeringNow(previous) : null;
    const addOn = open ? addedWords(previous, lastReal) : "";
    if (open && addOn && !lexicalAck(addOn, open.spoken).ack && queuesWhileWorking(classifyWhileWorking(addOn))) {
      this.reviseWhileSaid(lastReal, eventId, open);
      return;
    }
    const added = grew ? addedWords(previous, lastReal) : "";
    if (grew) {
      this.d.log(
        `[eleven] ${this.d.voiceStreamId} event ${eventId} his line grew after the shorter one was answered — ` +
          `${added ? `${added.split(/\s+/).length} new word(s), a fresh line` : "no new words"}`,
      );
    }
    const heard = fresh ? lastReal : added;
    const cut = this.detectCut(prev, agentBefore);
    if (cut) {
      if (!this.fillerOnly() && !this.companion && !prev?.companionLast) this.book.barge();
      if (this.lastAgent && !this.running) this.trimLastAgent(cut.heard);
    }

    if (!heard) {
      // His line filed again after a "..." (a nudge landing while it was still
      // being finalized) is not a new request: the running turn keeps working.
      if (!reengage && this.running && lastReal && norm(lastReal) === norm(this.running.heard)) {
        this.d.log(`[eleven] ${this.d.voiceStreamId} event ${eventId} repeats the running turn's words — kept working`);
        this.finish("repeat");
        return;
      }
      // Nothing new from him (the engine re-engaging after its turn_timeout):
      // the moment to say what is owed. Otherwise quiet, unless work runs on.
      if (this.owed || this.running) {
        this.d.log(`[eleven] ${this.d.voiceStreamId} event ${eventId} ${reengage ? "re-engage" : "no new words"}${this.owed ? `, ${this.owed.length}ch owed` : ""}${this.running ? ", work running" : ""}`);
      }
      this.finish("empty-transcript");
      return;
    }
    // The same words as the turn already running are not a new request: a
    // "..." landing while his line was still being finalized makes the engine
    // file his line again AFTER it (real call). Restarting the
    // turn on that only throws away the work so far.
    if (this.running && norm(heard) === norm(this.running.heard)) {
      this.d.log(`[eleven] ${this.d.voiceStreamId} event ${eventId} repeats the running turn's words — kept working`);
      this.finish("repeat");
      return;
    }
    this.newestFresh = this.pushRecord("user", heard);
    this.userTurns++;
    // An earlier answer still owed, and nothing running that this line could
    // replace: it is said now, on his event, ahead of whatever answers him.
    if (this.owed && !this.running && !cut) {
      if (this.d.alreadySaid !== false) this.event.paidOwed = this.owed;
      this.payOwed(this.event);
    }
    this.d.log(`[eleven] ${this.d.voiceStreamId} event ${eventId} heard ${heard.split(/\s+/).length} word(s)${cut ? " (cut in)" : ""}${this.running ? " while busy" : ""}`);

    // A line grown from one he already heard an answer to: the words of the
    // earlier one are only the agent's context, never in this record line.
    const lastAgentLine = (grew ? null : agentBefore) ?? this.lastAgentLine();
    if (this.d.isAck && lastAgentLine) {
      const controller = new AbortController();
      this.ackPending = { heard, whole: this.lastUserContent };
      void this.d.isAck(heard, lastAgentLine, controller.signal).then(
        (v) => this.afterAck(eventId, heard, cut, v, grew),
        () => this.afterAck(eventId, heard, cut, { silent: false, reason: "ack-failed", ms: 0 }, grew),
      );
      return;
    }
    this.route(heard, cut, grew);
  }

  /**
   * Is a grown line still a revision of `previous`? Only while nothing has
   * answered the shorter line: its ack check is still out, or the turn
   * answering it runs and has said nothing (no front line, hold line or answer).
   * Returns the unanswered piece: his words that check or turn holds, and the
   * whole line they were cut from — compared with `previous`, not the piece,
   * so a line grown twice is still one (revision-merge review).
   */
  private stillRevisable(previous: string): { line: string; whole: string } | null {
    const p = norm(previous);
    if (this.ackPending !== null && norm(this.ackPending.whole) === p) return { line: this.ackPending.heard, whole: this.ackPending.whole };
    const run = this.running;
    return run && norm(run.whole) === p && !run.spoken.trim() ? { line: run.line, whole: run.whole } : null;
  }

  /** The turn answering `previous` still runs, has said something, and is not real work (no tool started). */
  private answeringNow(previous: string): Running | null {
    const run = this.running;
    if (!run || run.rt.toolStarted || run.rt.aborted || norm(run.whole) !== norm(previous)) return null;
    return run.spoken.trim() ? run : null;
  }

  /**
   * His line grew while `run`'s answer to the shorter line was being said.
   * The record's line becomes the whole one; the turn is replaced by one for
   * the whole line, which hears what of the answer he heard (the unsaid rest
   * is dropped by the supersede, and filed only as far as he heard it).
   */
  private reviseWhileSaid(whole: string, eventId: number, run: Running): void {
    const line = grownPiece({ line: run.line, whole: run.whole }, whole);
    for (let i = this.record.length - 1; i >= 0; i--) {
      if (this.record[i].role !== "user") continue;
      if (this.record[i].text === run.line.slice(0, MAX_RECORD_TEXT)) this.record[i].text = line.slice(0, MAX_RECORD_TEXT);
      break;
    }
    // He heard what went out: not the sentence still held back, not what is owed.
    const heardOf = withoutUnsaid(withoutUnsaid(run.spoken, this.held?.text ?? ""), this.owed);
    const answerHeard = run.answered ? withoutUnsaid(heardOf, run.frontPlayed ?? "", true).trim() : "";
    const note = answerHeard ? revisedAfterAnswerNote(answerHeard) : MERGE_NOTE;
    const base = run.heard !== run.line && run.heard.endsWith(run.line) ? run.heard.slice(0, run.heard.length - run.line.length) : "";
    this.newestFresh = -1;
    this.d.log(
      `[eleven] ${this.d.voiceStreamId} event ${eventId} his line grew while its answer was being said (${line.split(/\s+/).length} word(s)) — one answer: replacing the turn${answerHeard ? ", told what he heard" : ""}`,
    );
    this.startTurn(`${base}${line}`, note, run.rt.pieces, line, whole);
  }

  /**
   * His last line grew. The turn answering the shorter version is replaced by
   * one answering the whole line, as the native call merges a paused thought.
   * `piece` (strict rule): the unanswered piece stillRevisable found. When
   * that piece is only the added words of an earlier growth, the revised line
   * is that piece grown, never the words he already heard answered.
   * No piece (ELEVEN_REVISION_STRICT=off): the earlier rule, where a line could
   * also be revised after its answer was out, and the note says what he heard.
   */
  private revise(previous: string, whole: string, eventId: number, piece: { line: string; whole: string } | null): void {
    this.ackPending = null;
    const line = piece ? grownPiece(piece, whole) : whole;
    const was = piece ? piece.line : previous;
    for (let i = this.record.length - 1; i >= 0; i--) {
      if (this.record[i].role !== "user") continue;
      if (this.record[i].text === was.slice(0, MAX_RECORD_TEXT)) this.record[i].text = line.slice(0, MAX_RECORD_TEXT);
      break;
    }
    if (piece) {
      // Nothing of the shorter line's answer was said: the turn answering it
      // (if one runs) is replaced by one for the whole line, pieces joined
      // into it kept. Owed speech is an EARLIER answer's: it stays owed.
      const run = this.running;
      if (!run || norm(run.whole) !== norm(previous)) {
        // The shorter line never got a turn of its own (its ack check was
        // out): the whole line is routed as his line, and whatever runs
        // (other work) is left to the usual rules, never replaced blind.
        this.d.log(`[eleven] ${this.d.voiceStreamId} event ${eventId} revised his last line before anything answered it (${line.split(/\s+/).length} word(s))`);
        this.route(line, null);
        return;
      }
      const base = run.heard !== run.line && run.heard.endsWith(run.line) ? run.heard.slice(0, run.heard.length - run.line.length) : "";
      this.newestFresh = -1;
      this.d.log(
        `[eleven] ${this.d.voiceStreamId} event ${eventId} revised his last line (${line.split(/\s+/).length} word(s)) — replacing the turn`,
      );
      this.startTurn(`${base}${line}`, MERGE_NOTE, run.rt.pieces, line, whole);
      return;
    }
    // He kept talking after the shorter line was answered. Whatever of that
    // answer he has not heard yet is stale: it is dropped here, never paid out
    // ahead of the new answer. (the "two paragraphs" the owner heard: the
    // first turn's answer waited as owed speech, was said first on the
    // revision's event, and then the new turn answered the same thing.)
    // A revised line is not a fresh one: the replaced turn's words stay after it.
    this.newestFresh = -1;
    let note = MERGE_NOTE;
    const dropped = this.owed;
    this.owed = "";
    const last = this.lastAgent;
    if (!this.running && last) {
      const heardOf = withoutUnsaid(last.spoken, dropped);
      const answerHeard = withoutUnsaid(heardOf, last.front ?? "", true).trim();
      const line = this.record[last.idx];
      if (line && line.role === "agent") line.text = heardOf.trim().slice(0, MAX_RECORD_TEXT);
      note = answerHeard ? revisedAfterAnswerNote(answerHeard) : REVISED_UNHEARD_NOTE;
      this.lastAgent = null;
    }
    this.d.log(
      `[eleven] ${this.d.voiceStreamId} event ${eventId} revised his last line (${whole.split(/\s+/).length} word(s))` +
        `${this.running ? " — replacing the turn" : ""}${dropped.trim() ? ` — ${dropped.length}ch of the earlier answer dropped unsaid` : ""}`,
    );
    this.startTurn(whole, note, 1);
  }

  private afterAck(eventId: number, heard: string, cut: { heard: string } | null, v: { silent: boolean; reason: string; ms: number }, grew = false): void {
    if (this.ackPending?.heard === heard) this.ackPending = null;
    if (this.closed || this.event?.id !== eventId) return; // he spoke again meanwhile
    if (v.silent) {
      this.d.log(`[eleven] ${this.d.voiceStreamId} SILENT ack (${v.reason}) ${v.ms}ms`);
      this.d.toApp({ type: "voice-ack", voiceStreamId: this.d.voiceStreamId, bot: this.d.bot });
      // An ack over running work does not touch it: the work speaks on into this event.
      if (!this.running) this.finish("silent-ack");
      return;
    }
    this.route(heard, cut, grew);
  }

  /** A cut: the previous event was still speaking, and he heard less than was sent. */
  private detectCut(prev: EventSlot | null, heardAgent: string | null): { heard: string } | null {
    const recentClient = this.interruptedAt && this.now() - this.interruptedAt < 10_000;
    if (!prev || !prev.said.trim()) return recentClient ? { heard: heardAgent ?? "" } : null;
    const sent = norm(prev.said);
    const got = norm(heardAgent ?? "");
    // Evidence of a cut is a PARTLY heard line. An agent line missing from the
    // history altogether is ambiguous (not spoken yet, or not reported), and
    // reading it as "he cut in" superseded real work on "how's it going?" —
    // the client's own interruption event covers a cut before any audio.
    const short = got.length > 0 && got.length < sent.length * 0.9 && sent.startsWith(got.slice(0, Math.max(0, got.length - 2)));
    if (short || recentClient) return { heard: heardAgent ?? "" };
    return null;
  }

  /* ── Routing: the native call's turn-taking and work gate ───────────── */

  /** `heard` is a piece of his line as last seen (lastUserContent): the turns started here carry that whole line. */
  private route(heard: string, cut: { heard: string } | null, grew = false): void {
    const vsid = this.d.voiceStreamId;
    let said = heard;
    let note = cut ? bargeNote(cut.heard || null) : "";
    let pieces = 1;

    if (this.running) {
      const route = this.book.route(true);
      this.d.log(formatRoute(vsid, route, " (eleven)"));
      // A new sentence after he heard something for the running turn — a
      // front line, a hold line, part of the answer when it grew his line —
      // is not the rest of a paused thought: that turn is kept, not
      // restarted. Three doors, one rule: the engine grows his line; or (our
      // line sitting between) files a new one the merge window would join;
      // or he talks over the warm-up line and the engine calls it a cut
      // (7-s-old turns thrown away on "Also, what's the date
      // today?", both ways). Only a cut into the ANSWER is a barge. "Stop"
      // still stops it, "how's it going?" gets its status; anything else is
      // answered right after it.
      const heardFiller = this.fillerOnly();
      // (Real work is the work gate's below: it already keeps the work, and says so.)
      if (route.kind !== "gate" && grew && !cut && this.d.revisionStrict !== false) {
        this.keepWorking(heard, "grown onto");
        return;
      }
      // A new line while the running turn has said only its warm-up or hold
      // line: the same moment, so ONE answer covers both (Michael's live test,
      // two answers, the first to the fragment, the second to the
      // add-on). A status question still gets its status, a stop still stops.
      if (route.kind !== "gate" && heardFiller && (route.kind === "merge" || route.kind === "talk")) {
        const run = this.running;
        if (!queuesWhileWorking(classifyWhileWorking(heard))) {
          this.keepWorking(heard, "after a line he heard from");
          return;
        }
        this.d.log(`[eleven] ${vsid} a new line while only a warm-up was said — one answer for both`);
        this.startTurn(joinPieces(run.rt.transcript, heard), MERGE_NOTE, run.rt.pieces + 1, heard, this.lastUserContent);
        return;
      }
      if (route.kind === "merge") {
        said = joinPieces(route.prior.transcript, heard);
        pieces = route.prior.pieces + 1;
        note = MERGE_NOTE;
      } else if (route.kind === "talk" && route.spokenLines > 0 && !note) {
        note = BARGE_NOTE;
      }
      if (route.kind !== "gate") {
        this.startTurn(said, note, pieces, heard, this.lastUserContent);
        return;
      }
      // Real work is running: a remark does not abort it. Only a stop does.
      const verdict = classifyWhileWorking(heard);
      this.d.log(`[gate] ${vsid} ${verdict} while working (eleven)`);
      if (verdict !== "stop") this.d.toApp({ type: "voice-gate", voiceStreamId: vsid, bot: this.d.bot, verdict, text: heard });
      if (verdict === "status") {
        const beat = describeWork(vsid) ?? { sinceMs: 0, tools: 0, lastWork: null };
        this.say(statusLine(beat), "line");
        return;
      }
      // A question or conversation: answered now, beside the work (the talk lane).
      if (verdict === "talk" && this.talkLaneOn()) {
        this.startCompanion(heard);
        return;
      }
      if (queuesWhileWorking(verdict)) {
        this.queueRemark(heard);
        return;
      }
      // stop: supersede.
      this.startTurn(said, note, pieces, heard, this.lastUserContent);
      return;
    }
    this.startTurn(said, note, pieces, heard, this.lastUserContent);
  }

  /** The running turn keeps going; his new line is answered after it (or stops it, or gets the status). */
  private keepWorking(heard: string, how: string): void {
    const vsid = this.d.voiceStreamId;
    const verdict = classifyWhileWorking(heard);
    this.d.log(`[gate] ${vsid} ${verdict} ${how} the running turn — ${verdict === "stop" ? "stopping it" : verdict === "status" ? "status" : "kept working, answered after it"} (eleven)`);
    if (verdict === "stop") {
      this.startTurn(heard, BARGE_NOTE, 1, heard, this.lastUserContent);
      return;
    }
    if (verdict === "status") {
      const beat = describeWork(vsid) ?? { sinceMs: 0, tools: 0, lastWork: null };
      this.say(statusLine(beat), "line");
      return;
    }
    this.queueRemark(heard);
  }

  private talkLaneOn(): boolean {
    return !!this.d.companion && this.d.talkLane !== false;
  }

  /* ── The talk lane ──────────────────────────────────────────────────── */

  /**
   * His question or conversation while real work runs: a companion turn
   * answers it now. A second one while a companion runs is merged into it —
   * one companion answers both, told what he already heard of the first.
   */
  private startCompanion(heard: string): void {
    const vsid = this.d.voiceStreamId;
    const run = this.running;
    let said = heard;
    let note = "";
    const prev = this.companion;
    if (prev) {
      said = joinPieces(prev.heard, heard);
      const heardOf = prev.spoken.trim();
      note = heardOf ? revisedAfterAnswerNote(heardOf) : MERGE_NOTE;
      prev.controller.abort("merged");
      this.companion = null;
      // What he heard of it is filed before his new words.
      if (heardOf) this.pushRecordBeforeNewest("agent", heardOf);
      this.d.log(`[talk] ${vsid} a second remark merged into the running companion${heardOf ? ` (${heardOf.length}ch already said)` : ""}`);
    }
    // The work's words not yet said — owed from an event that ended, or the
    // sentence still held back — are the work's: they wait with the rest of
    // its words and follow the companion (live run: owed work words
    // were paid out ahead of the companion's answer, 4.3 s into his question).
    if (this.owed && run) {
      this.workHeld.push(this.owed);
      this.d.log(`[talk] ${vsid} ${this.owed.length}ch of the work's owed words wait for the companion`);
      this.owed = "";
      this.owedAt = 0;
      this.owedDoneAt = 0;
    }
    if (this.held) {
      const h = this.held;
      this.held = null;
      h.cancel();
      this.workHeld.push(h.text);
    }
    const controller = new AbortController();
    const c: Companion = { controller, heard: said, startedAt: this.now(), spoken: "", firstAt: 0, handedBack: false, cancelTimers: [] };
    this.companion = c;
    const alive = (): boolean => this.companion === c && !controller.signal.aborted && !this.closed;
    // No answer from the lane (it failed, said nothing, or ran past a
    // deadline): the remark goes where it went before the lane existed, with a
    // backchannel — unless he already heard part of an answer.
    const giveUp = (why: string, detail: string): void => {
      if (!alive()) return;
      const unanswered = !c.spoken.trim();
      this.d.log(`[talk] ${vsid} companion ${why}: ${detail}${unanswered ? " — queued for the work" : " — cut short"}`);
      controller.abort(why);
      if (unanswered) {
        this.queued.push(c.heard);
        const sound = backchannel(this.lastBackchannel);
        this.lastBackchannel = sound;
        this.say(sound, "backchannel");
      }
      this.endCompanion(c, why);
    };
    c.cancelTimers.push(
      this.schedule(() => {
        if (!c.spoken.trim()) giveUp("deadline", `no first words in ${COMPANION_FIRST_WORDS_MS}ms`);
      }, COMPANION_FIRST_WORDS_MS),
      this.schedule(() => giveUp("deadline", `not done in ${COMPANION_MAX_MS}ms`), COMPANION_MAX_MS),
    );
    const handBack = (why: string): void => {
      if (!alive() || c.handedBack) return;
      c.handedBack = true;
      controller.abort("needs-hands");
      this.d.log(`[talk] ${vsid} companion needs hands (${why}) — handed to the work as an addition`);
      this.queued.push(c.heard);
      c.spoken += `${NEEDS_HANDS_LINE} `;
      this.say(NEEDS_HANDS_LINE, "companion");
      this.endCompanion(c, "needs-hands");
    };
    const feed = new SpokenTextFeed(
      (piece, why) => {
        // The feed's "all work, nothing said" line is the work turn's, never the companion's.
        if (!alive() || why === "fallback") return;
        if (!c.firstAt) {
          c.firstAt = this.now();
          this.d.log(`[talk] ${vsid} companion first words at ${c.firstAt - c.startedAt}ms`);
        }
        c.spoken += piece;
        this.say(piece, "companion");
      },
      (kind, text) => {
        if (!alive() || kind !== "work") return;
        this.d.toApp({ type: "voice-work", voiceStreamId: vsid, bot: this.d.bot, text, voiceCall: vsid });
      },
    );
    const lines = this.record.slice(-COMPANION_CONTEXT_LINES - 1, -1);
    const message = companionMessage({
      heard: said,
      note,
      work: run ? { heard: run.heard, sinceMs: this.now() - run.startedAt, lastWork: describeWork(vsid)?.lastWork ?? null } : null,
      call: lines,
    });
    this.d.log(`[talk] ${vsid} companion started${run ? ` beside work ${this.now() - run.startedAt}ms in` : ""} (${said.split(/\s+/).length} word(s))`);
    // Its raw text, checked for the needs-hands mark before the feed sees any of it.
    let raw = "";
    let fed = 0;
    this.d
      .companion!({
        message,
        signal: controller.signal,
        onChunk: (text) => {
          if (!alive() || !text) return;
          raw += text;
          if (NEEDS_HANDS_RE.test(raw)) {
            handBack("said so");
            return;
          }
          // A reply that opens like the mark waits until it is known not to be one.
          if (/^\s*\[\[/.test(raw) && !raw.includes("]]")) return;
          feed.push(raw.slice(fed));
          fed = raw.length;
        },
        onToolUse: () => handBack("tool call"),
      })
      .then(
        (result) => {
          if (!alive()) return;
          if (NEEDS_HANDS_RE.test(raw || result.response || "")) {
            handBack("said so");
            return;
          }
          if (!raw && result.response) feed.push(result.response);
          else if (fed < raw.length) feed.push(raw.slice(fed));
          feed.finish();
          if (!alive()) return;
          if (!c.spoken.trim()) {
            giveUp("empty", "it answered with nothing");
            return;
          }
          this.d.log(
            `[talk] ${vsid} companion done in ${this.now() - c.startedAt}ms first=${c.firstAt ? `${c.firstAt - c.startedAt}ms` : "none"} spoken_chars=${c.spoken.length}` +
              `${result.cost != null ? ` cost=$${result.cost.toFixed(4)}` : ""}`,
          );
          this.endCompanion(c, "done");
        },
        (err: unknown) => giveUp("failed", (err as Error)?.message ?? String(err)),
      );
  }

  /**
   * The companion is done (or stopped): its words go into the record, the
   * work's held words follow with a seam, and a work turn that ended while it
   * spoke finishes now. `quiet`: a new turn is about to start — nothing is
   * run from the queue and the event is left to it.
   */
  private endCompanion(c: Companion, why: string, quiet = false): void {
    if (this.companion !== c) return;
    this.companion = null;
    for (const cancel of c.cancelTimers) cancel();
    if (!c.controller.signal.aborted) c.controller.abort(why);
    const vsid = this.d.voiceStreamId;
    const said = c.spoken.trim();
    if (said) {
      this.pushRecord("agent", said);
      if (!c.handedBack) {
        this.talkSince.push({ heard: c.heard, said });
        if (this.talkSince.length > 6) this.talkSince.shift();
      }
    }
    // The work's words, held while the companion spoke, follow it with a seam.
    const held = this.workHeld.splice(0);
    if (held.length) {
      const seam = said ? SEAM_WORDS[this.seams++ % SEAM_WORDS.length] : "";
      const first = seam ? `${seam} ${lowerFirst(held[0].trimStart())}` : held[0];
      const pieces = [first, ...held.slice(1)];
      this.d.log(`[talk] ${vsid} work's ${held.join("").length}ch held for the companion said after it${seam ? ` (seam "${seam}")` : ""}`);
      if (this.running && !quiet) {
        // The work is in its tools (the lane only runs during real work): its
        // held words go out in full now and this response ends, as at any tool
        // start — a response is never left open through the work. What the
        // work says later is owed, as after any tool start.
        for (const p of pieces.slice(0, -1)) this.say(p, "answer");
        this.say(pieces[pieces.length - 1], "answer-before-work");
        this.endForWork();
      } else for (const p of pieces) this.say(p, "answer");
    }
    const landed = this.landed;
    this.landed = null;
    if (landed) {
      landed(quiet);
      return;
    }
    if (quiet) return;
    if (!this.running) {
      this.runQueued();
      this.finish(`companion-${why}`);
      return;
    }
    // Work runs on with nothing to say yet: the companion's words end their
    // response so they are spoken (the work's later words are owed, as after any tool start).
    const ev = this.event;
    if (!held.length && ev && !ev.final && ev.said.trim()) this.endEvent(ev, "companion");
  }

  /** His remark waits for the running turn; he hears a listener's sound, never a sentence. */
  private queueRemark(heard: string): void {
    this.queued.push(heard);
    const sound = backchannel(this.lastBackchannel);
    this.lastBackchannel = sound;
    this.say(sound, "backchannel");
  }

  /* ── The turn ───────────────────────────────────────────────────────── */

  private startTurn(said: string, note: string, pieces: number, line = said, whole = line): void {
    // An earlier answer he heard on this very event, just before this turn
    // (already-said.ts): told to the turn as said, and nothing is said over it.
    const paid = this.event && !this.event.final ? this.event.paidOwed ?? "" : "";
    if (this.event) this.event.paidOwed = undefined;
    this.supersede();
    // A new turn of his own replaces the talk lane's answer too.
    if (this.companion) this.endCompanion(this.companion, "superseded", true);
    const vsid = this.d.voiceStreamId;
    const startedAt = this.now();
    const controller = new AbortController();
    const rt = this.book.begin(said, startedAt, pieces);
    const run: Running = {
      controller,
      rt,
      live: beginWorkingTurn({
        voiceStreamId: vsid,
        bot: this.d.bot,
        send: (msg) => this.d.toApp(msg),
        say: (text) => {
          // No check-in while the talk lane has the voice: he is mid-conversation.
          if (this.running === run && !this.companion) this.say(text, "checkin");
        },
        now: this.now,
      }),
      heard: said,
      line,
      whole,
      startedAt,
      spoken: "",
      answered: false,
      frontPlayed: null,
      cancelTimers: [],
      toldTalk: this.talkSince.length,
    };
    this.running = run;
    const alive = (): boolean => this.running === run && !controller.signal.aborted && !this.closed;

    const feed = new SpokenTextFeed(
      (piece, why) => {
        if (!alive()) return;
        run.answered = true;
        run.spoken += piece;
        // The talk lane has the voice: the work's words wait for it.
        if (this.companion) {
          this.workHeld.push(piece);
          return;
        }
        // The sentence before a tool call is followed by silence: it must flush.
        if (why === "tool") {
          this.releaseHeld("plain");
          this.say(piece, "answer-before-work");
        } else this.holdAnswer(piece);
      },
      (kind, text) => {
        if (!alive()) return;
        if (kind === "work") {
          run.live.note("work", text);
          this.d.toApp({ type: "voice-work", voiceStreamId: vsid, bot: this.d.bot, text, voiceCall: vsid });
          return;
        }
        rt.spokenLines++;
        run.live.note("text");
      },
    );

    // The front voice: a line for what he said, said only if the answer has
    // not started by the deadline (counted from the transcript's arrival).
    const eventAt = this.event?.receivedAt ?? startedAt;
    const offerAck = (line: string, ms: number): void => {
      const offer = (): void => {
        if (!alive()) return;
        if (!this.event || this.event.final) {
          this.d.log(`[front-voice] ${vsid} skipped (slot-closed) line=${ms}ms (eleven)`);
          return;
        }
        if (run.answered) {
          this.d.log(`[front-voice] ${vsid} skipped (answer-first) line=${ms}ms (eleven)`);
          return;
        }
        run.frontPlayed = line;
        run.spoken += `${line} `;
        this.say(line, "front");
        this.d.frontLineSaid?.(line);
        this.d.log(`[front-voice] ${vsid} played at ${this.now() - eventAt}ms line=${ms}ms (eleven)`);
      };
      const wait = eventAt + this.d.frontDeadlineMs - this.now();
      if (wait > 0) run.cancelTimers.push(this.schedule(offer, wait));
      else offer();
    };
    if (paid) {
      // He is hearing an answer right now: a holding line after it is the
      // "that's a fair thing to untangle" the owner heard. Nothing.
      this.d.log(`[front-gate] ${vsid} skipped: an answer was just said (${paid.length}ch)`);
    } else if (this.d.frontGate) {
      // The call so far, without the line being answered (the gate gets that on its own).
      const recentCall = this.record.slice(-7, -1);
      void this.d.frontGate(said, recentCall, controller.signal).then((g) => {
        if (!alive()) return;
        this.d.log(`[front-gate] ${vsid} ${g.kind} reason=${g.reason} ${g.ms}ms`);
        if (g.kind === "full" && g.line) {
          if (run.answered) {
            this.d.log(`[front-gate] ${vsid} full reply dropped: the main answer started first`);
            return;
          }
          this.answerFast(run, g.line, g.ms);
          return;
        }
        if (g.kind === "ack" && g.line) offerAck(g.line, g.ms);
      });
    } else if (this.d.frontLine) {
      void this.d.frontLine(said, controller.signal).then((r) => {
        if (!alive()) return;
        if (!r.line) {
          this.d.log(`[front-voice] ${vsid} skipped (${r.reason ?? "no-line"}) line=${r.ms}ms (eleven)`);
          return;
        }
        offerAck(r.line, r.ms);
      });
    }
    // The engine abandons and retries a turn that says nothing for too long:
    // the shortest neutral line keeps it, when neither voice has spoken.
    if (this.d.holdMs > 0) {
      run.cancelTimers.push(
        this.schedule(() => {
          if (!alive() || run.spoken || (this.event && this.event.said)) return;
          run.spoken += `${ELEVEN_HOLD_LINE} `;
          this.say(ELEVEN_HOLD_LINE, "hold");
          this.d.log(`[eleven] ${vsid} hold line at ${this.now() - eventAt}ms`);
        }, this.d.holdMs),
      );
    }

    // ElevenLabs abandons and retries a response that goes quiet for its
    // cascade timeout — between chunks too, not only before the first
    // (a resend exactly 15 s after the last chunk). Long silent work sends an
    // empty, non-final chunk now and then: nothing to say, still answering.
    if (this.d.keepaliveMs && this.d.keepaliveMs > 0) {
      const every = this.d.keepaliveMs;
      let cancel = (): void => {};
      const beat = (): void => {
        if (!alive()) return;
        const ev = this.event;
        if (ev && !ev.final && this.now() - this.lastSentAt >= every) {
          this.lastSentAt = this.now();
          this.d.respond(ev.id, "", false);
        }
        cancel = this.schedule(beat, every);
      };
      cancel = this.schedule(beat, every);
      run.cancelTimers.push(() => cancel());
    }

    // What the fast voice settled on its own since the main brain last finished a turn.
    const fastNote = this.fastSince.length
      ? `(Earlier on this call your fast voice answered these itself, without you: ${this.fastSince
          .map((f) => `he said "${f.heard.slice(0, 200)}", you said "${f.said.slice(0, 200)}"`)
          .join("; ")}.)\n\n`
      : "";
    const message = `${paid ? alreadySaidNote(paid) : ""}${fastNote}${talkNote(this.talkSince)}${note ? `${said}\n\n${note}` : said}`;
    // Told it may stay silent: a reply that is only the marker is never spoken.
    const marker = paid ? new NothingNewFilter((text) => feed.push(text)) : null;
    const push = (text: string): void => (marker ? marker.write(text) : feed.push(text));
    let streamed = 0;
    this.d
      .invoke({
        message,
        signal: controller.signal,
        onChunk: (text) => {
          if (!alive() || !text) return;
          streamed += text.length;
          push(text);
        },
        onToolUse: () => {
          if (!alive()) return;
          rt.toolStarted = true;
          run.live.note("tool");
          // Work is something new: whatever was held as a possible marker goes on.
          marker?.finish();
          feed.boundary();
          // Work starts: whatever sentence is still held is followed by silence.
          this.releaseHeld("flush");
          // …and so is the response: end it now, so what was said is spoken
          // and the engine is never left waiting through the work. (Not while
          // the talk lane is speaking on it: the companion ends it when done.)
          if (!this.companion) this.endForWork();
        },
      })
      .then(
        (result) => {
          if (!alive()) return;
          if (streamed === 0 && result.response) push(result.response);
          if (marker?.finish()) this.d.log(`[eleven-turn] ${vsid} nothing new to add — the answer he just heard stands`);
          feed.finish();
          this.endTurn(run, stripNothingNew(result.response), null, result);
        },
        (err: unknown) => {
          if (!alive()) return;
          const cap = this.d.isCapError?.(err) ?? false;
          this.d.log(`[eleven] ${vsid} turn failed: ${cap ? "cap" : (err as Error)?.message ?? String(err)}`);
          if (this.companion) this.workHeld.push(`${cap ? CAP_LINE : ERROR_LINE} `);
          else this.say(cap ? CAP_LINE : ERROR_LINE, "line");
          this.endTurn(run, "", cap ? "cap" : "error", null);
        },
      );
  }

  /**
   * The fast voice's reply is the whole answer (front gate: full). It is said
   * now, the main turn is cancelled — nothing more is spoken or printed for
   * it — and the record keeps the reply as the agent's turn.
   */
  private answerFast(run: Running, line: string, ms: number): void {
    const vsid = this.d.voiceStreamId;
    run.controller.abort("front-full");
    this.held = null;
    this.clearRun(run);
    run.frontPlayed = line;
    run.spoken = `${line} `;
    this.say(line, "front");
    const idx = this.pushRecord("agent", line);
    this.lastAgent = idx >= 0 ? { idx, spoken: run.spoken, front: null } : null;
    this.fastSince.push({ heard: run.heard, said: line });
    if (this.fastSince.length > 6) this.fastSince.shift();
    this.d.log(`[eleven-turn] ${vsid} answered by the fast voice in ${this.now() - run.startedAt}ms (gate ${ms}ms) — main turn cancelled`);
    this.d.logTurn?.({
      turn_id: vsid,
      ts: new Date(this.now()).toISOString(),
      final_text: run.heard,
      tts_provider: "elevenlabs-agent",
      front_voice_line: line,
      front_gate: "full",
      cost_usd_final: 0,
    });
    this.runQueued();
    this.finish("front-full");
  }

  private endTurn(run: Running, response: string, failed: string | null, result: { cost?: number; inputTokens?: number; outputTokens?: number } | null): void {
    // The last sentence goes out as it is: the final marker flushes it.
    this.releaseHeld("plain");
    this.clearRun(run);
    // The work landed while the talk lane speaks: its words and its line in
    // the record come after the companion's (the record stays in the order he heard it).
    if (this.companion) {
      this.d.log(`[talk] ${this.d.voiceStreamId} work landed while the companion speaks — its answer waits for the companion's last sentence`);
      this.landed = (quiet) => this.afterTurn(run, response, failed, result, quiet);
      return;
    }
    this.afterTurn(run, response, failed, result, false);
  }

  private afterTurn(
    run: Running,
    response: string,
    failed: string | null,
    result: { cost?: number; inputTokens?: number; outputTokens?: number } | null,
    quiet: boolean,
  ): void {
    const vsid = this.d.voiceStreamId;
    // The answer is complete and nothing is open to say it on: ask for an
    // event now, not on the spacing clock of the nudges asked mid-turn.
    if (this.owed) {
      this.owedDoneAt = this.now();
      this.d.log(`[eleven] ${vsid} turn finished with ${this.owed.length}ch owed, waiting ${this.owedDoneAt - this.owedAt}ms so far`);
      this.requestNudge(true);
    }
    if (!failed) {
      // The record keeps work lines marked, as a native call's does.
      const text = response.replace(/^(\s*)» ?/gm, "$1(on screen) ").trim() || run.frontPlayed || "";
      const idx = this.pushRecord("agent", text);
      this.lastAgent = idx >= 0 ? { idx, spoken: run.spoken, front: run.frontPlayed } : null;
      this.fastSince = [];
      // The talk-lane exchanges this turn was told about are in its session now.
      this.talkSince.splice(0, run.toldTalk);
    }
    const ev = this.event;
    const firstMs = ev?.firstChunkAt ? ev.firstChunkAt - ev.receivedAt : null;
    this.d.log(
      `[eleven-turn] ${vsid} done in ${this.now() - run.startedAt}ms first_chunk=${firstMs ?? "none"}ms` +
        ` front=${run.frontPlayed ? "played" : "no"} spoken_chars=${run.spoken.length}${failed ? ` failed=${failed}` : ""}`,
    );
    this.d.logTurn?.({
      turn_id: vsid,
      ts: new Date(this.now()).toISOString(),
      final_text: run.heard,
      tts_provider: "elevenlabs-agent",
      first_audio_ms: firstMs ?? undefined,
      front_voice_line: run.frontPlayed,
      latency_final_to_audio_ms: firstMs ?? undefined,
      cost_usd_final: result?.cost ?? 0,
      input_tokens_final: result?.inputTokens ?? 0,
      output_tokens: result?.outputTokens ?? 0,
    });
    if (quiet) return;
    // A queued remark starts first, so this event stays open for its answer.
    this.runQueued();
    this.finish(failed ? `turn-${failed}` : "turn-done");
  }

  private runQueued(): void {
    // The talk lane finishes first; the queue runs when it is done.
    if (this.running || this.companion || this.closed || !this.queued.length) return;
    const held = this.queued.splice(0);
    this.startTurn(held.join(" "), QUEUED_NOTE, 1);
  }

  /** Stop the running turn (it is being replaced). Its words already said stay said. */
  private supersede(): void {
    const run = this.running;
    if (!run) return;
    run.controller.abort("superseded");
    // Unsent: the sentence held back, and anything held while the talk lane spoke.
    const unsent = `${this.workHeld.splice(0).join("")}${this.held?.text ?? ""}`;
    this.held = null;
    // He moved on: what the replaced turn still owed is not said. (Owed
    // speech while it has said nothing is an earlier answer's: it stays.)
    const unsaid = run.spoken.trim() || this.d.revisionStrict === false ? this.owed : "";
    if (unsaid) this.owed = "";
    this.clearRun(run);
    // What he heard of it is the record; nothing more of it will be said.
    const heardOf = withoutUnsaid(withoutUnsaid(run.spoken, unsent), unsaid).trim();
    // Filed where it was said: before the line of his that replaced it.
    if (heardOf) this.pushRecordBeforeNewest("agent", heardOf);
    this.d.log(`[eleven] ${this.d.voiceStreamId} superseded a turn after ${this.now() - run.startedAt}ms`);
  }

  private clearRun(run: Running): void {
    for (const c of run.cancelTimers.splice(0)) c();
    run.live.end();
    // The app's WORKING strip ends with the work, not a beat-lifetime later
    // (the ElevenLabs call has no phase that says the turn is over).
    this.d.toApp({ type: "voice-working", voiceStreamId: this.d.voiceStreamId, bot: this.d.bot, ended: true });
    this.book.end(run.rt);
    if (this.running === run) this.running = null;
  }

  /* ── The wire ───────────────────────────────────────────────────────── */

  /** Say one piece on the current event. */
  private say(text: string, why: "answer" | "answer-before-work" | "front" | "line" | "checkin" | "hold" | "backchannel" | "companion"): void {
    if (why !== "answer") this.releaseHeld("plain");
    if (this.closed || !text.trim()) return;
    // Pieces are sentences; the trailing space keeps the next from welding on.
    const plain = /\s$/.test(text) ? text : `${text} `;
    // ElevenLabs speaks a sentence only once more text follows it or the
    // response ends (measured: an ellipsis, a newline, a zero-width
    // space and padding to 125 characters all stayed silent until the answer
    // arrived, up to 33 s later). So a short line that must be heard NOW ends
    // its response; whatever the turn says next is owed to the next event
    // (his next words, or the engine re-engaging after turn_timeout).
    // (A backchannel is a sound, not a line: said at once, kept out of the record.)
    const quick = why === "front" || why === "hold" || why === "line" || why === "checkin" || why === "backchannel";
    const piece = quick || why === "answer" || why === "companion" ? plain : flushable(text);
    if (why === "line" || why === "checkin") {
      this.pushRecord("agent", text.trim());
      this.d.toApp({ type: "voice-line", voiceStreamId: this.d.voiceStreamId, bot: this.d.bot, text: text.trim() });
    }
    const ev = this.event;
    if (!ev || ev.final) {
      // No open response: said on the next one, first.
      if (!this.owed) {
        this.owedAt = this.now();
        this.owedDoneAt = 0;
      }
      this.owed += piece;
      this.d.log(`[eleven-say] ${this.d.voiceStreamId} owed ${why} ${piece.length}ch (no open event)`);
      this.requestNudge();
      return;
    }
    this.payOwed(ev);
    this.send(ev, piece, why);
    if (quick && this.d.quickFinal !== false) {
      ev.final = true;
      ev.cancelOpen();
      this.d.respond(ev.id, "", true);
    }
  }

  /** Owed speech goes out first on an open event. */
  private payOwed(ev: EventSlot): void {
    if (!this.owed) return;
    const owed = this.owed;
    this.owed = "";
    this.send(ev, owed, "owed");
    // The dead air he sat through: from the first owed piece (and from the
    // turn's end, when it had ended) to the event that finally carried it.
    const at = this.now();
    this.d.log(
      `[eleven] ${this.d.voiceStreamId} owed ${owed.length}ch paid on e${ev.id} after ${at - this.owedAt}ms` +
        `${this.owedDoneAt ? ` (${at - this.owedDoneAt}ms after the turn finished)` : " (turn still running)"} — ${ev.cause || "event"}`,
    );
    this.owedAt = 0;
    this.owedDoneAt = 0;
  }

  private send(ev: EventSlot, piece: string, why: string): void {
    if (!ev.firstChunkAt) ev.firstChunkAt = this.now();
    if (piece.trim()) {
      ev.lastTextAt = this.now();
      ev.companionLast = why === "companion";
    }
    ev.said += piece;
    this.lastSentAt = this.now();
    this.d.respond(ev.id, piece, false);
    // Content-free timing: which kind of line went out on which event, when.
    this.d.log(`[eleven-say] ${this.d.voiceStreamId} e${ev.id} +${this.now() - ev.receivedAt}ms ${why} ${piece.length}ch${why === "companion" ? " companion" : ""}`);
  }

  /**
   * The open limit: an event is ended `maxOpenMs` after its last real text
   * (or its arrival), and `maxResponseMs` after its arrival whatever flows.
   * What the turn says after that is owed.
   */
  private armOpen(ev: EventSlot): void {
    const maxOpen = this.d.maxOpenMs ?? 10_000;
    const maxResponse = this.d.maxResponseMs ?? 30_000;
    const check = (): void => {
      if (ev.final || this.closed || this.event !== ev) return;
      const at = this.now();
      const due = Math.min((ev.lastTextAt || ev.receivedAt) + maxOpen, ev.receivedAt + maxResponse);
      if (at >= due) {
        this.endEvent(ev, at - ev.receivedAt >= maxResponse ? "response-limit" : "open-limit");
        return;
      }
      ev.cancelOpen = this.schedule(check, due - at);
    };
    ev.cancelOpen = this.schedule(check, maxOpen);
  }

  /** End an open event early; the running turn's remaining speech is owed. */
  private endEvent(ev: EventSlot, why: string): void {
    if (ev.final) return;
    // A held sentence is said first, on this event, in flush form.
    if (this.held && this.event === ev) {
      const h = this.held;
      this.held = null;
      h.cancel();
      this.payOwed(ev);
      this.send(ev, flushable(h.text), "answer-before-work");
    }
    ev.final = true;
    ev.cancelOpen();
    this.d.respond(ev.id, "", true);
    this.d.log(`[eleven] ${this.d.voiceStreamId} event ${ev.id} ended at +${this.now() - ev.receivedAt}ms (${why}${ev.said ? `, ${ev.said.length}ch said` : ", nothing said"})${this.running ? ", work running" : ""}`);
  }

  /** Work started: if this event has said something, it ends now so that is spoken. */
  private endForWork(): void {
    const ev = this.event;
    if (!ev || ev.final || !ev.said.trim()) return;
    this.endEvent(ev, "work");
  }

  /**
   * Owed speech with nothing open: ask the app for an event, at most every
   * 4 s, 3 times per quiet stretch. Urgent (the turn just finished with its
   * answer owed): no 4-s wait and one past the cap — unless a nudge went out
   * under 1.5 s ago, whose "..." is likely already on its way.
   */
  private requestNudge(urgent = false): void {
    if (!this.d.nudge || this.closed || !this.owed) return;
    if (this.event && !this.event.final) return;
    const at = this.now();
    const since = at - this.nudgedAt;
    if (urgent && this.nudges > 0 && since < 1_500) return;
    if (this.nudges >= (urgent ? 4 : 3) || (!urgent && this.nudges > 0 && since < 4_000)) return;
    this.nudges++;
    this.nudgedAt = at;
    this.d.log(`[eleven] ${this.d.voiceStreamId} nudge ${this.nudges} (${this.owed.length}ch owed)`);
    this.d.nudge();
    // No event within 5 s (the app was busy speaking, or missed it): ask again.
    this.schedule(() => {
      if (!this.closed && this.owed && (!this.event || this.event.final) && this.nudgedAt === at) this.requestNudge();
    }, 5_000);
  }

  /**
   * The newest answer sentence waits briefly: the next one sends it as it is;
   * a tool call or a quiet stretch (flushMs) sends it in flush form, because
   * silence follows and ElevenLabs would otherwise hold it.
   */
  private holdAnswer(piece: string): void {
    this.releaseHeld("plain");
    const cancel = this.schedule(() => {
      if (this.held?.cancel === cancel) this.releaseHeld("flush");
    }, this.d.flushMs ?? 1_200);
    this.held = { text: piece, cancel };
  }

  private releaseHeld(how: "plain" | "flush"): void {
    const h = this.held;
    if (!h) return;
    this.held = null;
    h.cancel();
    this.say(h.text, how === "plain" ? "answer" : "answer-before-work");
  }

  /**
   * End the current event's response — unless a turn is running, which then
   * finishes it when it ends. Silence is an empty final: the engine says nothing.
   */
  private finish(why: string): void {
    const ev = this.event;
    if (!ev || ev.final) return;
    // Owed speech rides this event whether or not work is still running.
    this.payOwed(ev);
    if (this.running || this.companion) return;
    ev.final = true;
    ev.cancelOpen();
    this.d.respond(ev.id, "", true);
    if (!ev.said) this.d.log(`[eleven] ${this.d.voiceStreamId} event ${ev.id} answered with silence (${why})`);
  }

  /* ── The record ─────────────────────────────────────────────────────── */

  private pushRecord(role: "user" | "agent", text: string): number {
    const t = text.trim();
    if (!t || this.record.length >= MAX_RECORD_TURNS) return -1;
    this.record.push({ role, text: t.slice(0, MAX_RECORD_TEXT) });
    return this.record.length - 1;
  }

  /** Insert before his newest line when that line is the last entry (it was filed first). */
  private pushRecordBeforeNewest(role: "user" | "agent", text: string): void {
    // Only his fresh line, filed a moment ago: a revised line was said
    // before (in part) the words of the turn it replaces.
    if (this.newestFresh !== this.record.length - 1 || this.record.length >= MAX_RECORD_TURNS) {
      this.pushRecord(role, text);
      return;
    }
    this.record.splice(this.record.length - 1, 0, { role, text: text.trim().slice(0, MAX_RECORD_TEXT) });
    this.newestFresh++;
  }

  /** He cut the last finished answer: the record keeps what he heard. */
  private trimLastAgent(heard: string): void {
    const last = this.lastAgent;
    if (!last) return;
    const line = this.record[last.idx];
    if (line && line.role === "agent") line.text = heard.trim().slice(0, MAX_RECORD_TEXT);
    this.lastAgent = null;
  }

  private lastAgentLine(): string | null {
    for (let i = this.record.length - 1; i >= 0; i--) if (this.record[i].role === "agent" && this.record[i].text) return this.record[i].text;
    return null;
  }

  /** The call is over: stop everything; return the card's record (null for a call with no turns). */
  close(): ElevenCallRecord | null {
    if (this.closed) return null;
    const run = this.running;
    if (run) {
      run.controller.abort("call_ended");
      this.held = null;
      this.clearRun(run);
      if (run.spoken.trim()) this.pushRecord("agent", run.spoken.trim());
    }
    const c = this.companion;
    if (c) {
      this.companion = null;
      for (const cancel of c.cancelTimers) cancel();
      c.controller.abort("call_ended");
      if (c.spoken.trim()) this.pushRecord("agent", c.spoken.trim());
    }
    this.landed = null;
    this.workHeld = [];
    this.queued = [];
    this.event?.cancelOpen();
    this.closed = true;
    if (this.userTurns < 1) return null;
    return {
      startedAt: this.startedAt,
      durationSec: Math.max(0, Math.round((this.now() - this.startedAt) / 1000)),
      turns: this.userTurns,
      transcript: this.record.filter((l) => l.text).slice(0, MAX_RECORD_TURNS),
    };
  }

  /** Test/diagnostic view. */
  get inFlight(): number {
    return turnsInFlight(this.d.voiceStreamId);
  }
}

/**
 * A line ElevenLabs will speak now rather than hold for the next one: its
 * sentence end becomes an ellipsis plus a space — their documented "buffer
 * words" form ("Let me think about that... "). "Checking now." → "Checking
 * now... "; a question keeps its mark ("…for that?... ").
 */
/** A user line that is only dots: ElevenLabs re-engaging, not him speaking. */
export function isReengage(text: string): boolean {
  return /^[.\u2026\s]+$/.test(text);
}

export function flushable(text: string): string {
  const t = text.trim();
  if (!t) return "";
  if (/\.\.\.$|…$/.test(t)) return `${t} `;
  if (/\.$/.test(t)) return `${t.replace(/\.+$/, "")}... `;
  return `${t}... `;
}

/**
 * His latest turn, and what the engine's history says the agent said between
 * his previous turn and this one (null when it said nothing there) — shorter
 * than what we sent means he cut it off.
 */
export function splitHistory(history: TranscriptMessage[]): { heard: string; agentBefore: string | null } {
  let last = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      last = i;
      break;
    }
  }
  if (last < 0) return { heard: "", agentBefore: null };
  let prev = -1;
  for (let i = last - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      prev = i;
      break;
    }
  }
  const agent = history
    .slice(prev + 1, last)
    .filter((m) => m.role === "agent")
    .map((m) => m.content.trim())
    .filter(Boolean);
  return { heard: history[last].content.trim(), agentBefore: agent.length ? agent.join(" ") : null };
}

/**
 * The words his line gained over `previous`: everything after the words the
 * two share at the start (compared without punctuation or case). When the
 * engine also re-heard earlier words, the changed ones come along — a word
 * said twice beats a word lost. "" when nothing was added.
 */
export function addedWords(previous: string, whole: string): string {
  const words = whole.trim().split(/\s+/).filter(Boolean);
  const was = previous.trim().split(/\s+/).map(norm).filter(Boolean);
  let k = 0;
  while (k < words.length && k < was.length && norm(words[k]) === was[k]) k++;
  const rest = words.slice(k);
  return rest.some((w) => norm(w)) ? rest.join(" ") : "";
}

/**
 * An unanswered piece of his line, grown: the piece's own words plus what
 * the line gained since. A piece that is the whole line grows into `whole`.
 */
export function grownPiece(piece: { line: string; whole: string }, whole: string): string {
  const all = piece.whole.trim().split(/\s+/).filter(Boolean);
  const own = piece.line.trim().split(/\s+/).filter(Boolean).length;
  if (own >= all.length) return whole;
  return addedWords(all.slice(0, all.length - own).join(" "), whole) || piece.line;
}

/** He kept talking after your answer to the first part was queued but before it was said. */
export const REVISED_UNHEARD_NOTE =
  "(He kept talking before your answer to the first part was said aloud, so he never heard it. This is his whole message. Answer it once, as one.)";

/** He kept talking after hearing part of your answer to the shorter line. */
export function revisedAfterAnswerNote(heard: string): string {
  const tail = heard.split(/\s+/).slice(-40).join(" ");
  return `(He kept talking after you had answered the first part; he heard you say: "${tail}". This is his whole message. Answer only what is still open; do not repeat what he already heard.)`;
}

/**
 * `spoken` without its unsaid tail: the words of `unsaid`, when `spoken` ends
 * with them (or, with `head`, starts with them), compared without punctuation
 * — owed pieces may have been rewritten into their flush form ("now..."). When
 * they do not line up, `spoken` is returned whole (better kept than guessed).
 */
export function withoutUnsaid(spoken: string, unsaid: string, head = false): string {
  const words = spoken.split(/\s+/).filter(Boolean);
  const drop = unsaid.split(/\s+/).map(norm).filter(Boolean);
  if (!drop.length) return spoken.trim();
  if (drop.length > words.length) return spoken.trim();
  const part = head ? words.slice(0, drop.length) : words.slice(words.length - drop.length);
  if (part.map(norm).join(" ") !== drop.join(" ")) return spoken.trim();
  return (head ? words.slice(drop.length) : words.slice(0, words.length - drop.length)).join(" ");
}

/** A sentence's first letter lowered after a seam word ("Also, launched…"), unless it is "I" or an acronym. */
export function lowerFirst(text: string): string {
  const m = /^(\S)(\S?)/.exec(text);
  if (!m) return text;
  if (/^I\b/.test(text) || m[2] === m[2].toUpperCase() && /[A-Z]/.test(m[2])) return text;
  return m[1].toLowerCase() + text.slice(1);
}

/** What the work turn is told about talk-lane exchanges it never saw. */
export function talkNote(since: { heard: string; said: string }[]): string {
  if (!since.length) return "";
  const pairs = since.map((t) => `he said "${t.heard.slice(0, 200)}", you said "${t.said.slice(0, 300)}"`).join("; ");
  return `(While you were working, your talk lane answered these on the call without you: ${pairs}. He heard those answers; do not repeat them.)\n\n`;
}

/**
 * The companion's message: what the work is doing, the call so far, and his
 * words. The rules (no tools, the needs-hands mark) ride its system hint.
 */
export function companionMessage(o: {
  heard: string;
  note: string;
  work: { heard: string; sinceMs: number; lastWork: string | null } | null;
  call: { role: "user" | "agent"; text: string }[];
}): string {
  const parts: string[] = [];
  if (o.work) {
    const secs = Math.max(1, Math.round(o.work.sinceMs / 1000));
    parts.push(
      `(Your work lane is busy right now, ${secs} s in, on what he asked: "${o.work.heard.slice(0, 300)}"` +
        `${o.work.lastWork ? `; its latest step: ${o.work.lastWork.slice(0, 160)}` : ""}. It carries on without you and will report itself; do not do it, report on it or promise when it lands.)`,
    );
  }
  if (o.call.length) {
    parts.push(`(The call so far, oldest first:\n${o.call.map((l) => `${l.role === "user" ? "Him" : "You"}: ${l.text.slice(0, 400)}`).join("\n")})`);
  }
  parts.push(o.note ? `${o.heard}\n\n${o.note}` : o.heard);
  return parts.join("\n\n");
}
