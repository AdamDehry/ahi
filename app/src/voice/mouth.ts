import type { WordTimestamps } from "../voice-tts-stream.js";
import type { CallAudioOut } from "./turn-audio.js";

/* ============================================================
   mouth.ts — one call, one mouth (voice step 3, plan design item 3).

   Before this, every producer opened its own downlink straight onto the
   transport: the turn (its fast line, hold line, answer and check-ins ride
   one TurnAudioSequencer), a fixed line (a command reply, a status line, a
   backchannel), and on the phone its own lines (the opener, passphrase
   prompts, "Still with me?", the goodbye, an error said aloud). Nothing
   arbitrated between them:
     - on the app a second `voice-tts-start` resets the client's turn audio,
       so a fixed line sent while a reply was still PLAYING cut the reply's
       tail (synthesis had finished; playback had not);
     - on the phone two downlinks interleave their 20 ms frames into one
       Twilio stream: an error line said during a turn came out shredded.

   The mouth is the one way out. A producer asks for a LANE — a CallAudioOut
   with a turn id and a priority — and the mouth puts one lane ON AIR at a
   time. A lane that starts while another is audible waits, in priority order,
   until the one on air is done AND its audio has played out (by the same
   playout clock the echo window keeps), so nothing ever talks over anything:

     door    the line's own gate: the phone's passphrase prompts, goodbye
     turn    a turn's speech (fast line or hold, answer, check-ins in it)
     line    a fixed line with no model turn (commands, status, backchannel)
     notice  proactive and droppable ("Still with me?"): dropped if it would
             have to wait longer than its maxWaitMs

   A barge-in cancels by id (`cancel`): every lane opened before it, on air
   or waiting, is dead — nothing more of it leaves. The transport does its own
   physical cut (Twilio `clear`, the app's local stop); the mouth makes sure
   no producer can put audio back on top of it.

   ── What was PLAYED, not what was sent ────────────────────────────────────
   Each lane keeps its sentence starts (from the word timings), the last
   KEEP_SEC of its audio, and what the listener has acknowledged playing:
   the phone's marks (one every ACK_EVERY_SEC of audio), the app's own report
   when it comes back. When a door breaks mid-lane and the listener cannot
   vouch for the rest (Twilio's buffer dies with its stream; an app whose
   audio was suspended says so), the mouth re-says from the start of the
   sentence that was playing — ONCE, at that one unacknowledged boundary —
   before anything held behind it. When it cannot (too old to be kept, or
   already re-said once), Michael is told on his next turn what reached the owner
   (`takeDoorNote`), so he knows what was heard instead of guessing.
   ============================================================ */

export type MouthPriority = "door" | "turn" | "line" | "notice";
const RANK: Record<MouthPriority, number> = { door: 0, turn: 1, line: 2, notice: 3 };

/** Audio kept per lane for a re-say. */
export const KEEP_SEC = 30;
/** The phone asks Twilio to acknowledge playback this often (seconds of audio). */
export const ACK_EVERY_SEC = 1;
/** After the on-air lane's estimated playout end, before the next goes on air (network + jitter). */
export const AIR_GAP_MS = 150;
/** Audio a lane may hold while it waits for the air (a door shut for minutes must not queue minutes of speech). */
export const WAIT_HOLD_SEC = 30;
/** A door break with less than this unacknowledged is no loss worth re-saying. */
export const RESAY_MIN_LOST_SEC = 0.3;

export interface LaneOpts {
  /** The turn this speech belongs to (cancel by id). */
  turnId: string;
  priority?: MouthPriority;
  /** For the log only: "answer", "opener", "status"… */
  label?: string;
  /** notice lanes: dropped if not on air within this. */
  maxWaitMs?: number;
  /** The line's text when it is known up front and comes with no word timings (a fixed line). */
  text?: string;
}

/** What the transport needs to open a raw downlink for one lane. */
export interface LaneInfo {
  laneId: number;
  label: string;
}

export interface MouthDeps {
  /** The transport's raw downlink for one lane, opened when the lane goes on air. */
  open(info: LaneInfo): CallAudioOut;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: (line: string) => void;
  /** For the log line (read when a line is written: a phone call learns its id late). */
  callId?: string | (() => string);
}

/** A re-say for the transport to send, before anything it held. */
export interface Resay {
  laneId: number;
  sampleRate: number;
  pcm: Buffer;
  fromSec: number;
  toSec: number;
  /** The lane had finished synthesis before the break: close the re-said audio too. */
  close: boolean;
}

type Op = { k: "frame"; pcm: Buffer } | { k: "words"; wt: WordTimestamps } | { k: "done" } | { k: "filler"; text: string };

const realSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

class Lane implements CallAudioOut {
  state: "idle" | "waiting" | "air" | "over" | "dead" = "idle";
  sampleRate = 0;
  readonly ops: Op[] = [];
  raw: CallAudioOut | null = null;
  startedAt = 0;
  onAirAt = 0;
  /** Playout clock: when the audio sent so far finishes playing (ms epoch). */
  endsAt = 0;
  sentBytes = 0;
  doneSent = false;
  /** The producer said done (forwarded or still queued behind the air): nothing more is coming. */
  finished = false;
  /**
   * Where the lane's clock meets the wall. Each segment maps [sec0, sec1) of
   * the lane to playback starting at wall0; a new one opens wherever playback
   * had a gap (an underrun, a door). A re-said stretch is its own segment, so
   * its words were heard twice — both times count (Codex r2).
   */
  readonly segments: Array<{ sec0: number; wall0: number; sec1: number }> = [];

  /** The stream continues from `sec`, played from `wall`. */
  openSegment(sec: number, wall: number): void {
    const last = this.segments[this.segments.length - 1];
    if (last && last.sec1 === Number.POSITIVE_INFINITY) last.sec1 = Math.max(last.sec0, sec);
    this.segments.push({ sec0: sec, wall0: wall, sec1: Number.POSITIVE_INFINITY });
  }
  /** Sentence starts, seconds on the lane's clock (0 always). */
  readonly sentences: number[] = [0];
  readonly spoken: Array<{ word: string; start: number }> = [];
  /** Words said with no timings (a fixed line, a filler): played somewhere while the lane was on air. */
  untimed = "";
  /** The kept tail of the lane's audio, and the byte offset where it begins. */
  kept: Buffer[] = [];
  keptBytes = 0;
  keptFrom = 0;
  /** Seconds of this lane the listener has acknowledged playing. */
  ackedSec = 0;
  resaid = false;
  cancelWait: (() => void) | null = null;

  /** Nothing of this lane is audible from now on (a cut, a broken door): no playout to wait for. */
  silence(now: number): void {
    this.endsAt = Math.min(this.endsAt, now);
    this.cutShort = true;
    // Words scheduled after this were never heard: they are not "played" for the echo rule.
    if (!this.cutAt || now < this.cutAt) this.cutAt = now;
  }
  /** When the listener stopped hearing this lane (ms), 0 if never cut. */
  cutAt = 0;
  /** Set by silence(): the air is free at endsAt, with no jitter gap after it. */
  cutShort = false;

  constructor(
    readonly id: number,
    readonly turnId: string,
    readonly priority: MouthPriority,
    readonly label: string,
    readonly maxWaitMs: number,
    private readonly mouth: CallMouth,
  ) {}

  get bytesPerSec(): number {
    return this.sampleRate * 2;
  }
  sec(bytes: number): number {
    return this.bytesPerSec ? Math.floor(bytes / 2) / this.sampleRate : 0;
  }
  get sentSec(): number {
    return this.sec(this.sentBytes);
  }

  start(sampleRate: number): void {
    if (this.state !== "idle") return;
    this.sampleRate = sampleRate;
    this.startedAt = this.mouth.now();
    this.state = "waiting";
    this.mouth.wantsAir(this);
  }
  frame(pcm: Buffer): void {
    this.push({ k: "frame", pcm });
  }
  words(wt: WordTimestamps): void {
    this.push({ k: "words", wt });
  }
  done(): void {
    if (this.state !== "dead" && this.state !== "over") this.finished = true;
    this.push({ k: "done" });
  }
  filler(text: string): void {
    this.push({ k: "filler", text });
  }

  /** Bytes of audio waiting in `ops`; past WAIT_HOLD_SEC the newest is dropped (and said so once). */
  private waitingBytes = 0;
  private waitDropped = false;

  private push(op: Op): void {
    if (this.state === "dead" || this.state === "over") return;
    if (this.state === "air") return this.forward(op);
    // Past the wait cap the rest of the lane is gone, words included: never played, never echo evidence.
    if (this.waitDropped && (op.k === "frame" || op.k === "words")) return;
    if (op.k === "frame" && this.bytesPerSec) {
      if (this.waitingBytes + op.pcm.length > WAIT_HOLD_SEC * this.bytesPerSec) {
        if (!this.waitDropped) this.mouth.noteWaitDrop(this);
        this.waitDropped = true;
        return;
      }
      this.waitingBytes += op.pcm.length;
    }
    this.ops.push(op);
  }

  /** On air: everything queued, in order. */
  air(raw: CallAudioOut): void {
    this.raw = raw;
    this.state = "air";
    this.onAirAt = this.mouth.now();
    this.endsAt = this.onAirAt;
    this.openSegment(0, this.onAirAt);
    raw.start(this.sampleRate);
    for (const op of this.ops.splice(0)) {
      if (this.state !== "air") return;
      this.forward(op);
    }
  }

  forward(op: Op): void {
    const raw = this.raw!;
    switch (op.k) {
      case "frame": {
        if (!op.pcm.length) return;
        const now = this.mouth.now();
        // A gap (synthesis slower than playback): the listener plays this frame late, and so its words.
        if (now > this.endsAt + 20 && this.sentBytes > 0) this.openSegment(this.sentSec, now);
        this.endsAt = Math.max(this.endsAt, now) + (op.pcm.length / this.bytesPerSec) * 1000;
        this.cutShort = false; // more of it after a cut plays from now, as any audio does
        this.keep(op.pcm);
        this.sentBytes += op.pcm.length;
        raw.frame(op.pcm);
        return;
      }
      case "words": {
        const { wt } = op;
        for (let i = 0; i < wt.words.length; i++) {
          const start = wt.start[i] ?? 0;
          const prev = this.spoken[this.spoken.length - 1];
          if (prev && /[.!?…]["'”’)]*$/.test(prev.word) && start > this.sentences[this.sentences.length - 1]) this.sentences.push(start);
          this.spoken.push({ word: wt.words[i], start });
        }
        raw.words(wt);
        return;
      }
      case "filler":
        this.untimed = `${this.untimed} ${op.text}`.trim();
        raw.filler?.(op.text);
        return;
      case "done":
        this.doneSent = true;
        raw.done();
        this.mouth.laneDone(this);
        return;
    }
  }

  private keep(pcm: Buffer): void {
    this.kept.push(pcm);
    this.keptBytes += pcm.length;
    const max = KEEP_SEC * this.bytesPerSec;
    while (this.kept.length > 1 && this.keptBytes - this.kept[0].length >= max) {
      this.keptBytes -= this.kept[0].length;
      this.keptFrom += this.kept[0].length;
      this.kept.shift();
    }
  }

  /** The kept audio from `fromSec` to what was sent; null if that part is no longer kept. */
  audioFrom(fromSec: number): Buffer | null {
    let from = Math.floor(fromSec * this.sampleRate) * 2;
    if (from < this.keptFrom) return null;
    from -= this.keptFrom;
    const all = Buffer.concat(this.kept);
    return from < all.length ? all.subarray(from) : null;
  }

  /** Every time the listener played second `sec` of this lane (ms) — twice for a re-said stretch. */
  wallsAt(sec: number): number[] {
    if (sec > this.sentSec) return []; // never sent (or dropped): never played
    return this.segments.filter((g) => sec >= g.sec0 && sec < g.sec1).map((g) => g.wall0 + (sec - g.sec0) * 1000);
  }

  /** When the last audio sent finishes playing, by the segments. */
  endWall(): number {
    const open = this.segments.find((g) => g.sec1 === Number.POSITIVE_INFINITY);
    if (open) return open.wall0 + Math.max(0, this.sentSec - open.sec0) * 1000;
    return Math.max(this.onAirAt, ...this.segments.map((g) => g.wall0 + (g.sec1 - g.sec0) * 1000));
  }

  /** The words the listener heard by `sec` on this lane's clock. */
  heardBy(sec: number): string {
    return this.spoken
      .filter((w) => w.start < sec)
      .map((w) => w.word)
      .join(" ");
  }
}

export interface DoorReport {
  /**
   * The listener could not play what was in flight: Twilio's buffer died with
   * its stream; an app reports its audio was suspended or the page is new.
   * False = what was sent is (being) played — nothing to re-say.
   */
  lost: boolean;
  /** How far the listener played the lane on air at the break, if it says (the app). Else the acknowledged position. */
  heardSec?: number | null;
}

export class CallMouth {
  readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly log: (line: string) => void;
  private readonly lanes: Lane[] = [];
  private onAir: Lane | null = null;
  /** The lane that was on air (or last on air) when the door broke. */
  private brokenAt: { lane: Lane; sentSec: number; doneSent: boolean } | null = null;
  private doorNote: string | null = null;
  private nextId = 0;
  /** The door is shut: the lane on air keeps going (the transport holds it); nothing new goes on air until it is back. */
  private doorShut = false;
  private pumpTimer: (() => void) | null = null;
  private closed = false;

  constructor(private readonly deps: MouthDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? realSchedule;
    this.log = deps.log ?? ((l) => console.log(l));
  }

  private get tag(): string {
    const id = typeof this.deps.callId === "function" ? this.deps.callId() : this.deps.callId;
    return `[mouth] ${id || "call"}`;
  }

  /** A lane for one piece of speech. Nothing is sent until it goes on air. */
  lane(opts: LaneOpts): CallAudioOut & { readonly laneId: number } {
    const lane = new Lane(++this.nextId, opts.turnId, opts.priority ?? "turn", opts.label ?? opts.priority ?? "turn", opts.maxWaitMs ?? 0, this);
    if (opts.text) lane.untimed = opts.text;
    if (this.closed) lane.state = "dead";
    this.lanes.push(lane);
    return Object.assign(lane, { laneId: lane.id });
  }

  /** Is anything audible right now (on air and not yet played out)? */
  get audible(): boolean {
    const a = this.onAir;
    return !!a && (!a.doneSent || this.now() < a.endsAt);
  }

  /** The air is free: a lane that starts now goes straight on air. */
  get free(): boolean {
    const a = this.onAir;
    if (this.doorShut) return false;
    return !a || a.state !== "air" || (a.doneSent && this.now() >= a.endsAt + (a.cutShort ? 0 : AIR_GAP_MS));
  }

  /** Lanes waiting for the air (for tests and the log). */
  get waiting(): number {
    return this.lanes.filter((l) => l.state === "waiting").length;
  }

  noteWaitDrop(lane: Lane): void {
    this.log(`${this.tag} ${lane.label} waited past ${WAIT_HOLD_SEC}s of audio for the air: the rest of it is dropped`);
  }

  wantsAir(lane: Lane): void {
    if (lane.priority === "turn") {
      // Turns run one at a time (the turn gate): a new turn's speech means the
      // one before is over. Its lane, if it never said done (a cancelled
      // synthesis never does), must not hold the air.
      for (const l of this.lanes) {
        if (l === lane || l.priority !== "turn" || l.turnId === lane.turnId || l.finished) continue;
        if (l.state !== "waiting" && l.state !== "air") continue;
        l.state = "dead";
        l.cancelWait?.();
        if (this.onAir === l) l.silence(this.now());
        this.log(`${this.tag} ${l.label} retired: turn ${lane.turnId} began`);
      }
    }
    if (lane.priority === "notice" && lane.maxWaitMs > 0) {
      lane.cancelWait = this.schedule(() => {
        if (lane.state !== "waiting") return;
        lane.state = "dead";
        this.log(`${this.tag} dropped ${lane.label}: waited ${lane.maxWaitMs}ms for the air`);
        this.prune();
      }, lane.maxWaitMs);
    }
    this.pump();
  }

  laneDone(lane: Lane): void {
    if (this.onAir !== lane) return;
    this.pump();
  }

  /** Put the next lane on air if the air is free; otherwise come back when it will be. */
  private pump(): void {
    this.pumpTimer?.();
    this.pumpTimer = null;
    if (this.closed) return;
    const a = this.onAir;
    // While the door is shut nothing is playing and the transport replays what it
    // holds back to back: a second lane now would be a second start the app
    // lets cut the first. The next lane waits for the door (reattached()).
    if (this.doorShut) return;
    if (a && a.state === "air") {
      if (!a.doneSent) return; // laneDone() pumps again
      // Still playing out on the listener's side: the next lane waits for its last sample.
      const wait = a.endsAt + (a.cutShort ? 0 : AIR_GAP_MS) - this.now();
      if (wait > 0) {
        if (this.lanes.some((l) => l.state === "waiting")) this.pumpTimer = this.schedule(() => this.pump(), wait);
        return;
      }
      a.state = "over";
    }
    this.onAir = null;
    const next = this.lanes
      .filter((l) => l.state === "waiting")
      .sort((x, y) => RANK[x.priority] - RANK[y.priority] || x.id - y.id)[0];
    if (next) {
      next.cancelWait?.();
      this.onAir = next;
      const waited = this.now() - next.startedAt;
      if (waited >= 50) this.log(`${this.tag} ${next.label} (${next.priority}) on air after ${waited}ms`);
      next.air(this.deps.open({ laneId: next.id, label: next.label }));
    }
    this.prune();
  }

  /** Forget lanes nobody can ask about any more (keep the last few for acks and re-say). */
  private prune(): void {
    const keep = new Set<Lane>([...(this.onAir ? [this.onAir] : []), ...(this.brokenAt ? [this.brokenAt.lane] : [])]);
    const finished = this.lanes.filter((l) => (l.state === "over" || l.state === "dead") && !keep.has(l));
    for (const l of finished.slice(0, Math.max(0, finished.length - 3))) this.lanes.splice(this.lanes.indexOf(l), 1);
  }

  /**
   * Barge-in, supersede, hang-up: every lane opened so far — or only `turnId`'s —
   * stops. On air or waiting, nothing more of it leaves. Returns how many.
   */
  cancel(why: string, only?: { turnId?: string }): number {
    let n = 0;
    for (const l of this.lanes) {
      if (l.state === "dead" || l.state === "over") continue;
      if (only?.turnId !== undefined && l.turnId !== only.turnId) continue;
      if (l.state === "air" && l.doneSent && this.now() >= l.endsAt) {
        l.state = "over";
        continue;
      }
      l.state = "dead";
      l.cancelWait?.();
      n++;
    }
    if (this.onAir && this.onAir.state === "dead") {
      // The listener's playback was cut where it was: the playout clock ends now.
      this.onAir.silence(this.now());
    }
    if (n) this.log(`${this.tag} cancelled ${n} lane(s) (${why}${only?.turnId ? ` ${only.turnId}` : ""})`);
    this.pump();
    return n;
  }

  /**
   * The listener stopped what it had queued (the app does on `voice-thinking`:
   * a real turn is starting). The lane on air stays on air — more of it may
   * still come and will be played from now — but nothing of it is audible
   * any more, so nothing waits on its old playout end.
   */
  listenerCut(): void {
    const a = this.onAir;
    if (a && a.state === "air") a.silence(this.now());
    this.pump();
  }

  /**
   * The turn is over: nothing more of it will be said. A lane of it that
   * never said done (a synthesis that failed after its fast line played)
   * says it now, so it does not hold the air for whatever is next.
   */
  turnOver(turnId: string): void {
    for (const l of this.lanes) {
      if (l.turnId !== turnId || l.finished) continue;
      if (l.state !== "air" && l.state !== "waiting") continue;
      l.done();
    }
  }

  /** The listener confirmed playing lane `laneId` up to `sec` (a phone mark, an app report). */
  ack(laneId: number, sec: number): void {
    const lane = this.lanes.find((l) => l.id === laneId);
    if (lane && sec > lane.ackedSec) lane.ackedSec = sec;
  }

  /** The door broke: what was on air, and how much of it had been sent, is the boundary to settle. */
  doorClosed(): void {
    const lane = this.onAir ?? null;
    this.brokenAt = lane && lane.sentBytes > 0 ? { lane, sentSec: lane.sentSec, doneSent: lane.doneSent } : null;
    // Nothing is playing anywhere now. The lane on air may go on (the transport
    // holds it); no other goes on air until the door is back (pump()).
    if (lane && lane.state === "air") lane.silence(this.now());
    // Shut whatever was on air — or nothing: no lane goes on air until doorOpen() (Codex r2).
    this.doorShut = true;
    this.pump();
  }

  /**
   * The door is back. Returns the re-say to send before anything held, or
   * null. At most once per lane; when a re-say is not possible, the next turn
   * is told what reached him (`takeDoorNote`).
   */
  reattached(report: DoorReport): Resay | null {
    const b = this.brokenAt;
    this.brokenAt = null;
    const resay = b ? this.settleBoundary(b, report) : null;
    // The lane that was on air plays again from now: the re-say, then what was
    // held for it — the next lane waits for that, not for a clock that ran on
    // while the door was shut. Nothing new goes on air until doorOpen(), which
    // the transport calls once it has replayed what it held.
    const a = this.onAir;
    if (a && a.state === "air") {
      const now = this.now();
      const heldSec = b && b.lane === a ? Math.max(0, a.sentSec - b.sentSec) : 0;
      const resaySec = resay ? resay.toSec - resay.fromSec : 0;
      a.endsAt = now + (resaySec + heldSec) * 1000;
      a.cutShort = resaySec + heldSec === 0; // nothing to play out: no gap to wait
      const brokeAt = b && b.lane === a ? b.sentSec : a.sentSec;
      const open = a.segments.find((g) => g.sec1 === Number.POSITIVE_INFINITY);
      if (report.lost && open) {
        // His audio died at the cut: the stretch before the break ends where he stopped hearing it.
        const cutSec = a.cutAt ? open.sec0 + (a.cutAt - open.wall0) / 1000 : brokeAt;
        open.sec1 = Math.max(open.sec0, Math.min(brokeAt, cutSec));
      }
      if (resay) {
        // The re-said stretch is its own (heard again); the rest follows it.
        if (open && open.sec1 === Number.POSITIVE_INFINITY) open.sec1 = Math.max(open.sec0, brokeAt);
        a.segments.push({ sec0: resay.fromSec, wall0: now, sec1: resay.toSec });
        a.segments.push({ sec0: resay.toSec, wall0: now + resaySec * 1000, sec1: Number.POSITIVE_INFINITY });
      } else if (open && open.sec1 !== Number.POSITIVE_INFINITY) a.segments.push({ sec0: brokeAt, wall0: now, sec1: Number.POSITIVE_INFINITY });
      else a.openSegment(brokeAt, now);
      // Heard again from now on: the cut no longer bounds it (the segments do).
      a.cutAt = 0;
    }
    return resay;
  }

  /** The transport has replayed what it held: the air is open again. Always call after reattached(). */
  doorOpen(): void {
    this.doorShut = false;
    this.pump();
  }

  private settleBoundary(b: { lane: Lane; sentSec: number; doneSent: boolean }, report: DoorReport): Resay | null {
    if (!report.lost) return null;
    const { lane } = b;
    const heard = Math.max(0, Math.min(b.sentSec, report.heardSec ?? lane.ackedSec));
    if (b.sentSec - heard < RESAY_MIN_LOST_SEC) return null;
    const from = [...lane.sentences].reverse().find((s) => s <= heard) ?? 0;
    const pcm = lane.state === "dead" || lane.resaid ? null : lane.audioFrom(from);
    if (!pcm || !pcm.length) {
      const words = lane.heardBy(heard);
      this.doorNote = lane.spoken.length
        ? `(The call's audio dropped while you were speaking. He heard you up to: "${words.slice(-200)}" — the rest of that did not reach him.)`
        : "(The call's audio dropped while you were speaking; some of what you said did not reach him.)";
      this.log(`${this.tag} door: ${(b.sentSec - heard).toFixed(1)}s of ${lane.label} unheard, not re-said (${lane.resaid ? "already re-said once" : "no longer kept"}) — the next turn is told`);
      return null;
    }
    lane.resaid = true;
    const end = Math.min(pcm.length, Math.max(0, Math.round((b.sentSec - from) * lane.sampleRate) * 2));
    this.log(`${this.tag} door: re-saying ${lane.label} from ${from.toFixed(1)}s (heard ${heard.toFixed(1)}s of ${b.sentSec.toFixed(1)}s sent)`);
    return { laneId: lane.id, sampleRate: lane.sampleRate, pcm: pcm.subarray(0, end), fromSec: from, toSec: b.sentSec, close: b.doneSent };
  }

  /** What the next turn should be told about a door break (once), or null. */
  takeDoorNote(): string | null {
    const n = this.doorNote;
    this.doorNote = null;
    return n;
  }

  /**
   * The words played on this call within [atMs - backSec, atMs + aheadSec],
   * by the playout clock — what could be coming back through his mic at that
   * moment (the echo rule's window, voice/echo-rule.ts).
   */
  playedNear(atMs: number, backSec: number, aheadSec: number): string {
    const from = atMs - backSec * 1000;
    const to = atMs + aheadSec * 1000;
    const out: string[] = [];
    for (const l of this.lanes) {
      if (!l.raw) continue; // never on air
      // Untimed words (a fixed line, a filler) count if the lane was audible in the window at all.
      // Nothing after a cut was heard: a word he never heard cannot be echo (and must not eat his words).
      const heardTo = l.cutAt || Number.POSITIVE_INFINITY;
      const audibleTo = Math.min(l.endWall(), heardTo);
      if (l.untimed && l.onAirAt <= to && audibleTo >= from) out.push(l.untimed);
      for (const w of l.spoken) {
        if (l.wallsAt(w.start).some((at) => at >= from && at <= to && at <= heardTo)) out.push(w.word);
      }
    }
    return out.join(" ");
  }

  /**
   * A turn's speech with no word timings (a voice that sends none) was audible
   * in the window: its words are not in playedNear, so the caller adds the
   * reply's recent text for it — the same rule over the only words there are.
   */
  untimedSpeechNear(atMs: number, backSec: number, aheadSec: number): boolean {
    const from = atMs - backSec * 1000;
    const to = atMs + aheadSec * 1000;
    return this.lanes.some((l) => {
      if (!l.raw || l.spoken.length || l.untimed || !l.sentBytes) return false;
      const audibleTo = Math.min(l.endWall(), l.cutAt || Number.POSITIVE_INFINITY);
      return l.onAirAt <= to && audibleTo >= from;
    });
  }

  /** The call is over: nothing more leaves. */
  close(): void {
    this.cancel("call-ended");
    this.closed = true;
    this.pumpTimer?.();
  }
}

/* ── The call's mouth, by call id ───────────────────────────────────────────
   Transports own their call's mouth (they hold its doors); the call core in
   index.ts reaches it by id for a barge-in, a supersede and the door note. */
const mouths = new Map<string, CallMouth>();
export function registerMouth(callId: string, mouth: CallMouth): void {
  mouths.set(callId, mouth);
}
export function mouthFor(callId: string): CallMouth | null {
  return mouths.get(callId) ?? null;
}
export function forgetMouth(callId: string, mouth?: CallMouth): void {
  if (!mouth || mouths.get(callId) === mouth) mouths.delete(callId);
}
