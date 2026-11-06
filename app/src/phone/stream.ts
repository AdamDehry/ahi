/* ============================================================
   phone/stream.ts — one Twilio Media Stream = one call, as a CallTransport.

   Twilio connects a WebSocket per call (<Connect><Stream>) and speaks JSON:
     connected → start {streamSid, callSid, customParameters} → media* /
     mark* / dtmf* → stop.
   We answer with media (base64 μ-law 8 kHz), mark (tell me when playback
   reaches here) and clear (drop everything you have queued — barge-in).

   This file owns everything that is phone-specific about a call:
     - the ticket check: the stream proves it belongs to a call the signed
       webhook admitted (phone/index.ts mints the ticket);
     - the passphrase gate: on an inbound call nothing reaches the agent until
       the passphrase is heard (phone/passphrase.ts); those turns are consumed
       before the call core logs or records them;
     - server-side barge-in: the app decides barge-in on the handset from mic
       level; a phone has no client, so here real words heard while Michael is
       still playing cut the caller off (Twilio `clear` + the call's interrupt);
     - the downlink: PCM from the sequencer → 8 kHz μ-law in 20 ms frames, a
       mark at the end of every turn so we know when playback really ended;
     - lines of our own (greeting, passphrase prompts, a reply that only has
       text) rendered in the call's voice through `say`.
   Everything else — STT, the composer, the turn gate, brain, memory, voice,
   the call card — is the shared call core (websocket.ts openCall).
   ============================================================ */

import type { WebSocket } from "ws";
import type { CallAudioOut } from "../voice/turn-audio.js";
import type { CallAudioIn, CallTransport, CallTurnHints } from "../voice/call-transport.js";
import { Vad } from "../voice/vad.js";
import { decodeMulaw, Downsampler, encodeMulaw, MULAW_FRAME_BYTES, Upsampler2x } from "./audio.js";
import { MAX_PASSPHRASE_WORDS, matchesPassphrase, normalizeWords, type PassphraseRecord } from "./passphrase.js";
import { splitCallLines } from "../voice-tts-stream.js";
import { doorCloseLine } from "../voice/loop-watch.js";
import { ACK_EVERY_SEC, CallMouth, forgetMouth, registerMouth, type MouthPriority } from "../voice/mouth.js";
import { withPlayoutClock } from "../voice/echo-window.js";
import { ECHO_AHEAD_S, ECHO_BACK_S, ECHO_SHARE, echoShare, echoWords, formatEchoVerdict, oldEchoRules } from "../voice/echo-rule.js";

/** What the signed webhook decided about this call (carried by the ticket). */
export interface PhoneCallInfo {
  callSid: string;
  direction: "inbound" | "outbound";
  /** Outbound only: why Michael is calling ("the phone-leg build is done"). */
  reason?: string;
  /**
   * Minted by the re-attach webhook (voice step 2): this stream is the same
   * phone call coming back after its media socket broke, not a new call.
   */
  reattach?: boolean;
}

export interface OpenCallOptions {
  voiceStreamId: string;
  /** Return true to consume a committed turn before the core sees it. */
  interceptTurn?: (text: string) => boolean;
  /** May the caller's words be shown to a model before they commit (voice/gate-draft.ts)? Never while the passphrase is owed. */
  mayDraft?: () => boolean;
  channel: "phone";
  direction: "inbound" | "outbound";
}

export interface PhoneStreamDeps {
  /** Redeem the stream's ticket. Null = not a call we admitted. One use. */
  claimTicket(ticket: string, callSid: string): PhoneCallInfo | null;
  /** The shared call core. */
  openCall(transport: CallTransport, opts: OpenCallOptions): CallAudioIn | { error: string };
  /** One line in the call's voice: PCM s16le mono and its rate. */
  say(text: string, voiceStreamId: string): Promise<{ pcm: Buffer; sampleRate: number }>;
  /** The stored passphrase hash, or null if none is set. */
  passphrase(): PassphraseRecord | null;
  /** The passphrase check; defaults to matchesPassphrase. Tests inject one they resolve by hand. */
  checkPassphrase?(heard: string, rec: PassphraseRecord): Promise<boolean>;
  /**
   * Agent turns in flight on this call (voice/turn-liveness.ts). The idle
   * fuse is not idle while Michael is working: a ten-minute silent task used
   * to get "I'll let you go" under it (voice-call-drop §6).
   */
  turnsInFlight?(voiceStreamId: string): number;
  /**
   * A re-attach ticket's stream (voice step 2): hand this socket to the call
   * still running for its CallSid. True = adopted, and this stream steps
   * aside without ending anything; false = that call is over. Absent = no
   * re-attach on this line: a broken stream ends the call, as before.
   */
  adopt?(info: PhoneCallInfo, ws: WebSocket, streamSid: string): boolean;
  /** The call opened on its first stream: file it by CallSid, for re-attach. */
  onOpened?(stream: PhoneStream): void;
  /** The call is over. */
  onEnded?(stream: PhoneStream): void;
  /**
   * End the phone call itself (Twilio REST). Only for endings that are ours
   * — the goodbye, a door that never came back — so the line never sits open
   * in silence behind a TwiML that would otherwise redirect. Best effort.
   */
  hangupCall?(callSid: string): Promise<void>;
  /** Lines and limits; all optional. */
  options?: Partial<PhoneStreamOptions>;
  log?: (line: string) => void;
  now?: () => number;
}

export interface PhoneStreamOptions {
  /** Inbound, before the passphrase. */
  lockedGreeting: string;
  /** After the passphrase is heard. */
  unlockedLine: string;
  /** A wrong passphrase, more tries left. */
  wrongLine: string;
  /** A stream must send `start` within this, or it is closed (it was never a call). */
  startDeadlineMs: number;
  /** A goodbye line gets this long to render and play before the line is cut regardless. */
  goodbyeCapMs: number;
  /** Out of tries or out of time. */
  goodbyeLine: string;
  /**
   * Outbound: what Michael opens with when there is no reason, and the
   * greeting put in front of a reason that has none of its own. He has caller
   * ID: never a self-introduction (phoneOpener).
   */
  outboundGreeting: string;
  /** The line's owner by name (from setup's user record), for the greeting and the call prompt; null = generic lines. */
  ownerName: string | null;
  passphraseTries: number;
  /** Locked this long → goodbye. */
  passphraseWindowMs: number;
  /**
   * A call is cut at this length regardless. 0 = never (voice step 2: the
   * call ends when the owner ends it; a forgotten call is the idle question's job).
   */
  maxCallMs: number;
  /**
   * Silence from both sides this long, and Michael not working → he asks
   * `idleQuestion` once. Not a hang-up (voice step 2).
   */
  idleMs: number;
  /** "Still with me?" */
  idleQuestion: string;
  /** No sound from the owner's side this long after the question → `idleGoodbye`. */
  idleConfirmMs: number;
  idleGoodbye: string;
  /**
   * The media socket broke under a live call: how long the call waits for
   * Twilio's redirect to bring a new stream (voice step 2). 0 = no waiting:
   * a broken stream ends the call.
   */
  reattachWindowMs: number;
  /** Re-attaches one call may make; a stream that keeps breaking ends the call. */
  maxReattaches: number;
  /** Audio held for the new stream while the call waits, in seconds of speech. */
  reattachHoldSec: number;
  /** Real words heard while Michael plays this many → barge-in. */
  bargeMinWords: number;
}

export const PHONE_STREAM_DEFAULTS: PhoneStreamOptions = {
  lockedGreeting: "Michael here. Passphrase?",
  unlockedLine: "Got it. Go ahead.",
  wrongLine: "That's not it. Say it again, slowly, one word at a time.",
  goodbyeLine: "I can't open this line. Goodbye.",
  outboundGreeting: "Hey, it's Michael.",
  ownerName: null,
  startDeadlineMs: 10_000,
  goodbyeCapMs: 10_000,
  passphraseTries: 3,
  passphraseWindowMs: 60_000,
  maxCallMs: 0,
  idleMs: 15 * 60_000,
  idleQuestion: "Still with me?",
  idleConfirmMs: 2 * 60_000,
  idleGoodbye: "I'll let you go. Bye.",
  reattachWindowMs: 15_000,
  maxReattaches: 5,
  reattachHoldSec: 30,
  bargeMinWords: 1,
};

/**
 * Said under someone who is talking, these do not mean "stop" — "yeah",
 * "mm-hm" while Michael explains. Anything else does.
 */
const BACKCHANNEL = new Set([
  "yeah", "yes", "yep", "ok", "okay", "right", "sure", "mhm", "mm", "hmm", "uh", "um", "huh", "uhhuh", "mmhm", "ah", "oh", "got", "it", "cool", "nice",
]);

/** A greeting at the start of a line ("Hey Dana,", "Good morning."). */
const GREETING = /^\s*(?:hey|hi|hello|yo|morning|good (?:morning|afternoon|evening))\b/i;
/** A self-introduction as its own clause: "it's Michael", "this is Michael", "Michael here". */
const SELF_INTRO = /(^|[.,!?;:—-]\s*)(?:(?:it'?s|this is)\s+michael|michael here)\s*(?=[.,!?;:—-]|$)([.,!?;:—-]?)\s*/gi;

/** Drop a self-introduction clause from a line (the caller ID already says who is calling). */
export function stripSelfIntro(text: string): string {
  return text
    // The clause's own closing mark ends the sentence before it: "Hey Dana, it's Michael. Quick one." → "Hey Dana. Quick one."
    .replace(SELF_INTRO, (_m, lead: string, tail: string) => (tail ? `${tail} ` : lead))
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:—-]+/, "")
    .trim();
}

/**
 * The outbound opener: ONE greeting, no self-introduction (caller ID
 * already says who is calling; a check-in once said the greeting twice). The
 * reason is said as it is when it carries its own greeting; otherwise the
 * greeting goes in front. No reason: the greeting alone.
 */
export function phoneOpener(reason: string | undefined, opts: Pick<PhoneStreamOptions, "outboundGreeting"> = PHONE_STREAM_DEFAULTS): string {
  const why = stripSelfIntro((reason ?? "").trim());
  const greeting = stripSelfIntro(opts.outboundGreeting) || PHONE_STREAM_DEFAULTS.outboundGreeting;
  if (!why) return greeting;
  return GREETING.test(why) ? why : `${greeting} ${why}`;
}

/**
 * The greeting and unlock line for a named owner ("Hey Dana." / "Got it. Go ahead, Dana."); no name = the
 * generic defaults. Test or env overrides (deps.streamOptions) still win over these.
 */
export function phoneLinesFor(name: string | null | undefined): Partial<PhoneStreamOptions> {
  const n = (name ?? "").trim();
  if (!n) return { ownerName: null };
  return { ownerName: n, outboundGreeting: `Hey ${n}.`, unlockedLine: `Got it. Go ahead, ${n}.` };
}

/** The phone's surface rules, appended to every phone turn's system prompt. */
export function phoneSystemHint(info: Pick<PhoneCallInfo, "direction" | "reason">, opener?: string, ownerName?: string | null): string {
  const who = (ownerName ?? "").trim();
  const how =
    info.direction === "outbound"
      ? `You (Michael) placed this call to ${who ? `${who}'s` : "the owner's"} cell${info.reason ? ` about: ${info.reason}` : ""}.`
      : `${who || "The owner"} called your phone number and passed the spoken passphrase.`;
  return [
    `PHONE CALL. ${how}`,
    // The opener was already heard; the model was answering its own greeting again.
    opener
      ? `You already opened the call by saying: "${opener}". It was heard. Do not greet again or introduce yourself — caller ID already shows who is calling; go straight on.`
      : "The call is already open. Do not greet or introduce yourself — caller ID already shows who is calling; go straight on.",
    "This is an ordinary phone line: no screen, no app. Speak in short, natural sentences; never say 'on screen', never read out links, ids or paths, and never hand over a file — offer to put it in the app instead.",
    "Work lines (» ) are not heard on a phone and only appear in the call's transcript in the app afterward, so say \"I'll put the details in the app\" rather than pointing at a screen.",
    "Do not take destructive or irreversible actions from the phone: no deleting, deploying, merging, restarting, pushing, sending messages or money, or changing credentials. Say it will be queued for approval in the app instead.",
  ].join(" ");
}

/**
 * Tool patterns denied on phone turns, on top of the agent's own denials.
 * A floor, not a wall (a command can be spelled around a prefix rule); the
 * system hint above carries the rule itself. No spaces inside a pattern: the
 * gateway joins its deny list into one CLI argument.
 */
export const PHONE_DISALLOWED_TOOLS = [
  "Bash(rm:*)",
  "Bash(rmdir:*)",
  "Bash(systemctl:*)",
  "Bash(kill:*)",
  "Bash(pkill:*)",
  "Bash(sudo:*)",
  "Bash(shred:*)",
];

/** Endings the gateway chose — the line must be cut from our side too. */
const OUR_ENDINGS = new Set(["we hung up", "goodbye cap", "door lost", "bad message"]);

/** "caller hung up" → `caller-hung-up`: the `why` on the call's end line. */
export function phoneEndToken(why: string): string {
  return why.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "hangup";
}

export class PhoneStream {
  private readonly opts: PhoneStreamOptions;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  private streamSid = "";
  private info: PhoneCallInfo | null = null;
  private call: CallAudioIn | null = null;
  private closed = false;
  /** The socket under the call right now; replaced on re-attach (voice step 2). */
  private ws: WebSocket;
  private unbindSocket: (() => void) | null = null;
  /** This stream was a re-attach and gave its socket to the call (it is done, the call is not). */
  private handedOff = false;
  /**
   * The media socket broke and the call waits for Twilio's redirect. What the
   * call says meanwhile is held, in order, for the stream that re-attaches.
   */
  private parked: { since: number; timer: NodeJS.Timeout; code: number } | null = null;
  private held: Array<{ msg: Record<string, unknown>; ulawBytes: number }> = [];
  private heldUlawBytes = 0;
  private heldDropped = false;
  /** Re-attaches asked for (the webhook) and made, and the total time spent waiting. */
  private reattachRequests = 0;
  private reattaches = 0;
  private gapMs = 0;
  /** When the idle question was asked; 0 = not asked since the caller last made a sound. */
  private idleAskedAt = 0;

  private readonly up = new Upsampler2x();
  private readonly vad = new Vad({ threshold: 0.02, silenceMs: 700 });

  /** Locked until the passphrase is heard (inbound only). */
  private locked = false;
  private checking = false;
  /** Words arrived while the running check was in flight. */
  private heardDuringCheck = false;
  /**
   * Every word heard while locked, across consecutive locked turns (newest
   * last, capped). Phone-band recognition mashes an odd word pair into one
   * token ("Copalanthen 7"); said again slowly, the right words land in later
   * turns, and the check runs over the run of them. Memory only; cleared on
   * unlock and at the end of the call.
   */
  private heardWhileLocked: string[] = [];
  /** Goodbye is playing: nothing more is checked, unlocked or answered. Irreversible. */
  private ending = false;
  private startTimer: NodeJS.Timeout | null = null;
  private triesLeft: number;
  private lockTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  /** Bumped on barge-in: a downlink from before it sends nothing more. */
  private generation = 0;
  private markSeq = 0;
  /** Marks sent and not yet echoed: while any is out, Michael is audible. */
  private readonly pendingMarks = new Set<string>();
  /** When the audio sent so far finishes playing, by our own clock. */
  private playbackEnd = 0;
  private onMarksDrained: (() => void) | null = null;
  /** What Michael has been saying, for the barge-in echo guard. */
  private recentSpoken = "";
  /** The outbound opener as said (told to every turn, so it never greets again). */
  private opener: string | null = null;
  /** When Twilio last sent us anything, and sends of ours that could not go out (step 0). */
  private lastInAt = 0;
  private sendsDropped = 0;
  /** The socket failed (its `error` event), for the door line that follows. */
  private socketError = "";
  private lastSaid = { text: "", at: 0 };
  /** When the caller's current speech began (the VAD's onset): the echo rule's window is around it. */
  private speechStartedAt = 0;
  /**
   * The call's one mouth (voice/mouth.ts): every turn's speech and every line
   * of our own goes on air through it, one at a time. Its acks come from
   * Twilio's marks: `markAcks` maps a mark to the lane and the second of it
   * that had played when Twilio echoed the mark.
   */
  private readonly mouth: CallMouth;
  private readonly markAcks = new Map<string, { laneId: number; sec: number }>();

  constructor(
    ws: WebSocket,
    private readonly deps: PhoneStreamDeps,
  ) {
    this.ws = ws;
    this.opts = { ...PHONE_STREAM_DEFAULTS, ...(deps.options ?? {}) };
    this.log = deps.log ?? ((l) => console.log(l));
    this.now = deps.now ?? Date.now;
    this.triesLeft = this.opts.passphraseTries;
    this.mouth = new CallMouth({
      open: (info) => withPlayoutClock(this.voiceStreamId, this.downlink(info.laneId)),
      now: this.now,
      log: this.log,
      callId: () => this.voiceStreamId,
    });
    this.bindSocket(ws);
    // A socket that never says which call it is was never a call.
    this.startTimer = setTimeout(() => {
      if (this.info || this.closed) return;
      this.log("[phone] stream sent no start within the deadline — closed");
      this.closeSocket(4408, "no start");
      void this.end("no start");
    }, this.opts.startDeadlineMs);
    this.startTimer.unref?.();
  }

  /**
   * Listen to one socket. Every handler checks it is still the call's socket:
   * after a re-attach the old one's late events must not touch the call.
   */
  private bindSocket(ws: WebSocket): void {
    const onMessage = (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (ws !== this.ws) return;
      this.lastInAt = this.now();
      if (isBinary) return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Valid JSON is not a Twilio message: `null`, a number, an array or an
      // object without an event closes this connection instead of throwing.
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof (msg as { event?: unknown }).event !== "string") {
        this.log("[phone] stream sent a message that is not a Twilio event — closing it");
        this.closeSocket(4400, "bad message");
        void this.end("bad message");
        return;
      }
      try {
        this.onMessage(msg as Record<string, unknown>);
      } catch (err) {
        this.log(`[phone] stream message failed (${(err as Error).message}) — closing it`);
        this.closeSocket(4400, "bad message");
        void this.end("bad message");
      }
    };
    const onClose = (code: number, reason: Buffer) => {
      if (ws !== this.ws) return;
      // A close we did not start (Twilio's `stop` and our own end() come first
      // and set `closed`; a socket error ends the call first too, and still
      // gets its line): the door line, for step 0's question of why.
      if (this.info && (!this.closed || this.socketError)) {
        const why = [reason?.toString() ?? "", this.socketError ? `error ${this.socketError}` : ""].filter(Boolean).join(" ");
        this.log(doorCloseLine("phone", this.voiceStreamId, code, why, this.lastInAt, ws.bufferedAmount, this.now()));
      }
      if (this.closed) return;
      // Voice step 2: the door closed, the call did not. Twilio runs the
      // TwiML's <Redirect> next and the same call comes back on a new stream.
      if (this.canPark()) this.park(code);
      else void this.end(this.socketError ? "socket error" : "socket closed");
    };
    const onError = (err: Error) => {
      if (ws !== this.ws) return;
      this.socketError = (err?.message ?? "error").slice(0, 60);
      // A socket that fails is followed by its close, which parks the call
      // when it can be re-attached; when it cannot, end now, as before.
      if (!this.canPark()) void this.end("socket error");
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
    this.unbindSocket = () => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
  }

  get voiceStreamId(): string {
    return this.info ? `phone-${this.info.callSid}` : "";
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get callSid(): string {
    return this.info?.callSid ?? "";
  }

  /** What the webhook admitted this call as (a re-attach ticket carries it). */
  get callInfo(): PhoneCallInfo {
    const { reattach: _r, ...info } = this.info ?? { callSid: "", direction: "inbound" as const };
    return info;
  }

  /** The call itself is over (or never was one): nothing re-attaches to it. */
  get isOver(): boolean {
    return this.closed;
  }

  /** Waiting for a new stream (voice step 2). */
  get isParked(): boolean {
    return this.parked !== null;
  }

  /** Re-attaches made so far, and the total gap they cost. */
  get reattachStats(): { reattaches: number; gapMs: number } {
    return { reattaches: this.reattaches, gapMs: this.gapMs };
  }

  // ── Re-attach (voice step 2) ─────────────────────────────────────────

  /**
   * A broken stream may wait for a new one: the call is live, ours to keep,
   * and either has re-attaches left to ask for or one already granted that
   * has not arrived yet (Twilio's redirect can beat the old socket's close —
   * the last allowed one must not be voided by it).
   */
  private canPark(): boolean {
    return (
      !!this.info && !!this.call && !this.closed && !this.ending && !this.handedOff &&
      !!this.deps.adopt && this.opts.reattachWindowMs > 0 &&
      (this.reattachRequests < this.opts.maxReattaches || this.reattachRequests > this.reattaches)
    );
  }

  /**
   * Twilio's redirect asks whether this call can take a new stream. Counted
   * here, so a stream that keeps failing — or never connects — stops at
   * `maxReattaches` and the next redirect is answered with a hang-up.
   */
  requestReattach(): boolean {
    if (!this.info || !this.call || this.closed || this.ending || this.handedOff) return false;
    if (this.reattachRequests >= this.opts.maxReattaches) return false;
    this.reattachRequests++;
    // Twilio is actively bringing a stream: the wait starts again from now
    // (a stream that failed to connect redirects again). Bounded by the count.
    if (this.parked) this.armParkTimer(this.parked.since);
    return true;
  }

  private armParkTimer(since: number): void {
    if (!this.parked) return;
    clearTimeout(this.parked.timer);
    const timer = setTimeout(() => {
      if (this.parked?.since !== since) return;
      this.log(`[phone] ${this.voiceStreamId} no new stream within ${Math.round(this.opts.reattachWindowMs / 1000)}s — ending the call`);
      void this.end("door lost");
    }, this.opts.reattachWindowMs);
    timer.unref?.();
    this.parked.timer = timer;
  }

  /**
   * The socket under the call closed without a hang-up. Keep the call — its
   * recognizer, the turn in flight, the passphrase state — and hold what it
   * says for the stream Twilio's redirect brings. If none comes inside the
   * window, the call ends, and the end line says the door never came back.
   */
  private park(code: number): void {
    const since = this.now();
    // What was on air is the boundary the re-attach settles (voice/mouth.ts).
    this.mouth.doorClosed();
    this.markAcks.clear();
    // Marks sent on the dead socket will never be echoed: nothing is playing.
    this.pendingMarks.clear();
    this.openMark = null;
    this.playbackEnd = since;
    this.parked = { since, timer: setTimeout(() => {}, 0), code };
    this.armParkTimer(since);
    this.log(
      `[phone] ${this.voiceStreamId} parked: media stream closed (code=${code}) with Michael ${this.call ? "on the call" : "gone"}; ` +
        `waiting up to ${Math.round(this.opts.reattachWindowMs / 1000)}s for Twilio to re-attach (${this.opts.maxReattaches - this.reattachRequests} left)`,
    );
  }

  /**
   * A new stream for this call (its re-attach ticket checked out). It takes
   * over from the old socket — closed, or about to be: Twilio has already
   * left it — gets the held speech in order, and no opener: he is mid-call.
   */
  attach(ws: WebSocket, streamSid: string): boolean {
    if (this.closed || this.ending || this.handedOff || !this.info) return false;
    const now = this.now();
    const old = this.ws;
    this.unbindSocket?.();
    if (old !== ws && old.readyState !== 3 /* CLOSED */) {
      // Twilio redirected before we saw the old socket close: it is dead to
      // Twilio. Its close still gets its door line — with its own code and
      // reason, and the error it had if any — and the takeover is a line of
      // its own, so the recovery never stands in for the cause.
      const lastIn = this.lastInAt;
      const error = this.socketError;
      old.once("close", (code: number, reason: Buffer) => {
        const why = [reason?.toString() ?? "", error ? `error ${error}` : ""].filter(Boolean).join(" ");
        this.log(doorCloseLine("phone", this.voiceStreamId, code, why, lastIn, 0, this.now()));
      });
      this.log(`[phone] ${this.voiceStreamId} a new stream arrived while the old one was still ${old.readyState === old.OPEN ? "open" : "closing"} — taking over`);
      this.pendingMarks.clear();
      this.openMark = null;
      if (old.readyState === old.OPEN) this.closeSocket(1000, "replaced", old);
    }
    const gap = this.parked ? now - this.parked.since : 0;
    if (this.parked) clearTimeout(this.parked.timer);
    this.parked = null;
    this.ws = ws;
    this.streamSid = streamSid;
    this.lastInAt = now;
    this.socketError = "";
    this.bindSocket(ws);
    this.reattaches++;
    this.gapMs += gap;
    const held = this.held;
    const dropped = this.heldDropped;
    this.held = [];
    this.heldUlawBytes = 0;
    this.heldDropped = false;
    this.playbackEnd = now;
    // Twilio's buffer died with the old stream: whatever it had not played is
    // lost. Re-say from the start of the sentence that was playing — once —
    // before what was held (voice/mouth.ts).
    const resay = this.mouth.reattached({ lost: true });
    if (resay) {
      const out = this.downlink();
      out.start(resay.sampleRate);
      out.frame(resay.pcm);
      out.done();
    }
    let frames = 0;
    for (const h of held) {
      if (h.msg.event === "media") {
        frames++;
        this.playbackEnd = Math.max(this.playbackEnd, this.now()) + (h.ulawBytes / 8_000) * 1_000;
      }
      if (h.msg.event === "mark") this.pendingMarks.add(String((h.msg.mark as { name?: string }).name ?? ""));
      this.send({ ...h.msg, streamSid });
    }
    // What was held is out: the next lane may go on air (voice/mouth.ts).
    this.mouth.doorOpen();
    this.call?.reattached?.(gap);
    this.armIdle();
    this.log(
      `[phone] ${this.voiceStreamId} re-attached on a new stream (#${this.reattaches}, gap ${(gap / 1000).toFixed(1)}s, total ${(this.gapMs / 1000).toFixed(1)}s): ` +
        `replayed ${frames} frame(s)${dropped ? ", some held audio dropped" : ""}`,
    );
    return true;
  }

  /** Hold one outbound message for the next stream. Speech is bounded; marks and the rest are small and always kept. */
  private hold(msg: Record<string, unknown>, ulawBytes = 0): void {
    if (msg.event === "clear") {
      // A barge-in while the door was shut: nothing held is wanted any more.
      this.held = [];
      this.heldUlawBytes = 0;
      return;
    }
    if (ulawBytes && this.heldUlawBytes + ulawBytes > this.opts.reattachHoldSec * 8_000) {
      this.heldDropped = true;
      return;
    }
    const { streamSid: _sid, ...rest } = msg;
    this.held.push({ msg: rest, ulawBytes });
    this.heldUlawBytes += ulawBytes;
  }

  /**
   * Michael is audible: a mark is outstanding. Bounded by our own playback
   * clock — if a mark never comes back (a synthesis error left a turn
   * without its closing mark), he stops counting as audible 5 s after the
   * audio sent would have finished, so barge-in and the idle watchdog recover.
   */
  get playing(): boolean {
    if (!this.pendingMarks.size) return false;
    if (this.now() > this.playbackEnd + 5_000) {
      this.pendingMarks.clear();
      this.openMark = null;
      return false;
    }
    return true;
  }

  // ── Twilio → us ──────────────────────────────────────────────────────

  private onMessage(msg: Record<string, unknown>): void {
    if (this.closed) return;
    switch (msg.event) {
      case "start":
        this.onStart(msg);
        return;
      case "media":
        this.onMedia(msg);
        return;
      case "mark": {
        const name = String((msg.mark as Record<string, unknown> | undefined)?.name ?? "");
        this.pendingMarks.delete(name);
        // Playback truth: Twilio played up to this mark.
        const ack = this.markAcks.get(name);
        if (ack) {
          this.markAcks.delete(name);
          this.mouth.ack(ack.laneId, ack.sec);
        }
        if (!this.pendingMarks.size) {
          this.armIdle();
          const fn = this.onMarksDrained;
          this.onMarksDrained = null;
          fn?.();
        }
        return;
      }
      case "stop":
        void this.end("caller hung up");
        return;
      default:
        return; // connected, dtmf: nothing to do
    }
  }

  private onStart(msg: Record<string, unknown>): void {
    if (this.info) return;
    if (this.startTimer) clearTimeout(this.startTimer);
    const start = (msg.start ?? {}) as Record<string, unknown>;
    const streamSid = String(start.streamSid ?? msg.streamSid ?? "");
    const callSid = String(start.callSid ?? "");
    const params = (start.customParameters ?? {}) as Record<string, unknown>;
    const ticket = typeof params.ticket === "string" ? params.ticket : "";
    const info = streamSid && callSid && ticket ? this.deps.claimTicket(ticket, callSid) : null;
    if (!info) {
      this.log(`[phone] stream refused: no valid ticket (call ${callSid ? callSid.slice(-6) : "?"})`);
      this.closeSocket(4403, "forbidden");
      return;
    }
    if (info.reattach) {
      // The same phone call, back on a new stream: the call it belongs to
      // takes this socket. This stream was only its doorway.
      if (this.deps.adopt?.(info, this.ws, streamSid)) {
        this.handedOff = true;
        this.closed = true;
        this.unbindSocket?.();
        this.unbindSocket = null;
        return;
      }
      this.log(`[phone] call …${callSid.slice(-6)}: a re-attach stream for a call that is over — closed`);
      this.closeSocket(4410, "call over");
      this.closed = true;
      return;
    }
    this.streamSid = streamSid;
    this.info = info;
    this.locked = info.direction === "inbound";
    registerMouth(this.voiceStreamId, this.mouth);

    const opened = this.deps.openCall(this.transport(), {
      voiceStreamId: this.voiceStreamId,
      interceptTurn: (text) => this.interceptTurn(text),
      // The passphrase must never reach a model: no drafting until it is said (or while goodbye plays).
      mayDraft: () => !this.locked && !this.ending,
      channel: "phone",
      direction: info.direction,
    });
    if ("error" in opened) {
      this.log(`[phone] ${this.voiceStreamId} could not open the call: ${opened.error}`);
      void this.sayThenHangup("Sorry, I can't take calls right now.");
      return;
    }
    this.call = opened;
    this.log(`[phone] ${this.voiceStreamId} ${info.direction} call open${this.locked ? " (locked)" : ""}`);
    this.deps.onOpened?.(this);

    // Off by default (voice step 2). When set: hard — the goodbye is capped
    // (goodbyeCapMs), so the call ends by then regardless.
    if (this.opts.maxCallMs > 0) {
      this.maxTimer = setTimeout(() => void this.sayThenHangup("We've hit the call limit. Talk soon."), this.opts.maxCallMs);
      this.maxTimer.unref?.();
    }
    this.armIdle();

    if (this.locked) {
      if (!this.deps.passphrase()) {
        // The webhook already refuses inbound calls with no passphrase set; this is the backstop.
        void this.sayThenHangup(this.opts.goodbyeLine);
        return;
      }
      this.lockTimer = setTimeout(() => {
        if (this.locked) void this.sayThenHangup(this.opts.goodbyeLine);
      }, this.opts.passphraseWindowMs);
      this.lockTimer.unref?.();
      void this.sayLine(this.opts.lockedGreeting, false, { priority: "door", label: "locked-greeting" });
    } else {
      this.opener = phoneOpener(info.reason, this.opts);
      void this.sayLine(this.opener, false, { priority: "door", label: "opener" });
    }
  }

  private onMedia(msg: Record<string, unknown>): void {
    if (!this.call) return;
    const media = (msg.media ?? {}) as Record<string, unknown>;
    if (media.track && media.track !== "inbound") return;
    const payload = typeof media.payload === "string" ? media.payload : "";
    if (!payload) return;
    const pcm8k = decodeMulaw(Buffer.from(payload, "base64"));
    const ev = this.vad.feed(pcm8k, this.now());
    if (ev === "onset") {
      this.speechStartedAt = this.now();
      // He went on after a pause: the end of speech before it was not his last (the turn's clock).
      this.call.speechResumed?.();
      // A sound from his side answers the idle question, whatever it was.
      this.idleAskedAt = 0;
      this.armIdle();
    }
    if (ev === "end") void this.call.endUtterance();
    this.call.audio(this.up.push(pcm8k));
  }

  // ── The passphrase gate ──────────────────────────────────────────────

  /** Runs inside the call core's turn dispatch, before it logs or records anything. */
  private interceptTurn(text: string): boolean {
    if (this.ending) return true; // goodbye is playing: consumed, never checked
    if (!this.locked) return false;
    const words = normalizeWords(text);
    if (!words.length) return true;
    // The rolling buffer: this turn's words after the ones before it.
    this.heardWhileLocked = [...this.heardWhileLocked, ...words].slice(-MAX_PASSPHRASE_WORDS);
    if (this.checking) {
      this.heardDuringCheck = true;
      return true;
    }
    const rec = this.deps.passphrase();
    if (!rec) return true;
    this.checkPassphrase(rec, false);
    return true;
  }

  /**
   * One check over the buffer as it stands. A wrong result with words heard
   * while it ran is checked once more before any try is counted (the phrase
   * often lands while a check over a fragment is still running); a re-check
   * never re-checks, so one spoken attempt costs at most one try.
   */
  private checkPassphrase(rec: PassphraseRecord, isRecheck: boolean): void {
    this.checking = true;
    this.heardDuringCheck = false;
    void (this.deps.checkPassphrase?.bind(this.deps) ?? matchesPassphrase)(this.heardWhileLocked.join(" "), rec)
      .catch(() => false)
      .then((ok) => {
        this.checking = false;
        // A result that lands after goodbye started is void, right or wrong.
        if (this.closed || this.ending) return;
        if (ok) {
          this.locked = false;
          this.heardWhileLocked = [];
          if (this.lockTimer) clearTimeout(this.lockTimer);
          this.log(`[phone] ${this.voiceStreamId} passphrase accepted`);
          void this.sayLine(this.opts.unlockedLine, false, { priority: "door", label: "unlocked" });
          return;
        }
        if (!isRecheck && this.heardDuringCheck) {
          this.log(`[phone] ${this.voiceStreamId} passphrase re-checked`);
          this.checkPassphrase(rec, true);
          return;
        }
        this.triesLeft--;
        this.log(`[phone] ${this.voiceStreamId} passphrase refused (${this.triesLeft} left)`);
        if (this.triesLeft <= 0) void this.sayThenHangup(this.opts.goodbyeLine);
        else void this.sayLine(this.opts.wrongLine, false, { priority: "door", label: "wrong-passphrase" });
      });
  }

  // ── The transport the call core talks to ─────────────────────────────

  private transport(): CallTransport {
    return {
      kind: "phone",
      event: (msg) => this.onCoreEvent(msg),
      audioOut: (ids) => this.mouth.lane({ turnId: ids.turnId ?? "turn", priority: ids.priority ?? "turn", label: ids.label ?? "turn", text: ids.text }),
      turnHints: (): CallTurnHints | null =>
        this.info
          ? { extraSystemHint: phoneSystemHint(this.info, this.opener ?? undefined, this.opts.ownerName), disallowedTools: PHONE_DISALLOWED_TOOLS }
          : null,
    };
  }

  private onCoreEvent(msg: Record<string, unknown>): void {
    if (this.closed) return;
    switch (msg.type) {
      case "stt-interim":
        if (typeof msg.text === "string") this.maybeBargeIn(msg.text);
        return;
      // A closed utterance: a short "wait, stop" may never have had a preview (voice/server-barge.ts).
      case "stt-utterance":
        if (typeof msg.text === "string") this.maybeBargeIn(msg.text);
        return;
      // The gateway cut the turn itself (a lone "stop"): nothing queued may keep playing.
      case "voice-interrupt-ack":
        if (this.playing) this.clearPlayback("stop");
        return;
      case "stream-chunk":
        if (typeof msg.chunk === "string") this.recentSpoken = (this.recentSpoken + " " + msg.chunk).slice(-600);
        return;
      case "voice-tts": {
        // The degraded path (no streaming voice) or an error line: the app
        // would play a file; the phone says the text in the call's voice —
        // its SPOKEN lines only, never the "» " work lines (paths, commands).
        // The core sends the phone text only, so this is the one synthesis.
        if (typeof msg.text !== "string") return;
        const spoken = splitCallLines(msg.text)
          .filter((l) => l.kind === "spoken")
          .map((l) => l.text.trim())
          .filter(Boolean)
          .join(" ");
        if (spoken) void this.sayLine(spoken, true, { priority: "turn", label: "reply-text" });
        return;
      }
      case "voice-error":
      case "stt-health":
        if (typeof msg.error === "string" && msg.error.trim()) void this.sayLine(msg.error, true, { priority: "line", label: "error" });
        return;
      default:
        return;
    }
  }

  /**
   * Real words while Michael is audible → stop him. Backchannel ("yeah",
   * "mm-hm") does not count, and neither do words he is saying himself (a
   * speakerphone hearing its own output).
   */
  private maybeBargeIn(partial: string): void {
    if (this.ending || this.locked || !this.playing) return;
    const words = normalizeWords(partial).filter((w) => !BACKCHANNEL.has(w));
    if (words.length < this.opts.bargeMinWords) return;
    const spoken = new Set(normalizeWords(this.recentSpoken));
    const old = words.every((w) => spoken.has(w));
    if (oldEchoRules()) {
      if (old) return;
    } else {
      // The one echo rule (voice/echo-rule.ts): his words against what was
      // PLAYING around them. A reply with no word timings falls back to its
      // recent text — the same rule over the only words there are.
      const at = this.speechStartedAt || this.now();
      const ahead = (this.now() - at) / 1000 + ECHO_AHEAD_S;
      const near =
        this.mouth.playedNear(at, ECHO_BACK_S, ahead) +
        (this.mouth.untimedSpeechNear(at, ECHO_BACK_S, ahead) ? ` ${this.recentSpoken.slice(-200)}` : "");
      const share = echoShare(partial, near);
      const one = share >= ECHO_SHARE;
      if (one || old) this.log(formatEchoVerdict(this.voiceStreamId, "phone-barge", one, old, share, echoWords(partial).length));
      if (one) return;
    }
    this.log(`[phone] ${this.voiceStreamId} barge-in`);
    this.clearPlayback();
    this.call?.interrupt();
  }

  private clearPlayback(why = "barge-in"): void {
    this.generation++;
    // Nothing queued or on air may put audio back on top of the cut.
    this.mouth.cancel(why);
    this.send({ event: "clear", streamSid: this.streamSid });
    // Twilio echoes every outstanding mark after a clear; until it does, we
    // already know nothing is playing.
    this.pendingMarks.clear();
    // A mark reserved by the cut reply must not be reused: the next reply
    // gets a fresh one, so it counts as audible from its first frame.
    this.openMark = null;
    this.playbackEnd = this.now();
    this.onMarksDrained = null;
  }

  /**
   * One lane's raw downlink (the mouth opens it when the lane goes on air):
   * PCM at any rate in, 20 ms μ-law frames out, a mark every ACK_EVERY_SEC of
   * audio — Twilio echoes it when playback gets there, which is how the mouth
   * knows what was PLAYED — and a mark at the end. `laneId` 0: no acks (a re-say).
   */
  private downlink(laneId = 0): CallAudioOut {
    const gen = this.generation;
    let ds: Downsampler | null = null;
    let carry = Buffer.alloc(0);
    let sentUlaw = 0;
    let ackedAt = 0;
    const live = () => !this.closed && gen === this.generation;
    return {
      start: (sampleRate) => {
        if (!live()) return;
        ds = new Downsampler(sampleRate);
        this.armIdle();
      },
      frame: (pcm) => {
        if (!live() || !ds) return;
        carry = Buffer.concat([carry, encodeMulaw(ds.push(pcm))]);
        let off = 0;
        for (; off + MULAW_FRAME_BYTES <= carry.length; off += MULAW_FRAME_BYTES) {
          // Audible from the first frame until its mark comes back.
          this.markPending();
          this.sendMedia(carry.subarray(off, off + MULAW_FRAME_BYTES));
          sentUlaw += MULAW_FRAME_BYTES;
          if (laneId && sentUlaw - ackedAt >= ACK_EVERY_SEC * 8_000) {
            ackedAt = sentUlaw;
            this.sendAckMark(laneId, sentUlaw / 8_000);
          }
        }
        carry = carry.subarray(off);
      },
      words: () => {},
      done: () => {
        if (!live()) return;
        if (carry.length) {
          // Pad the tail to a whole frame with μ-law silence (0xFF).
          this.sendMedia(Buffer.concat([carry, Buffer.alloc(MULAW_FRAME_BYTES - carry.length, 0xff)]));
          carry = Buffer.alloc(0);
        }
        // The end mark acknowledges the whole lane.
        this.sendMark(laneId ? { laneId, sec: Number.POSITIVE_INFINITY } : undefined);
      },
    };
  }

  private openMark: string | null = null;

  /** Make sure a mark is outstanding for audio that has been sent. */
  private markPending(): void {
    if (this.openMark) return;
    this.openMark = `m${++this.markSeq}`;
    this.pendingMarks.add(this.openMark);
  }

  /** Close the current run of audio with its mark. */
  private sendMark(ack?: { laneId: number; sec: number }): void {
    const name = this.openMark ?? `m${++this.markSeq}`;
    this.openMark = null;
    this.pendingMarks.add(name);
    if (ack) this.markAcks.set(name, ack);
    this.send({ event: "mark", streamSid: this.streamSid, mark: { name } });
  }

  /** A mid-lane mark: echoed when Twilio has played `sec` seconds of lane `laneId`. */
  private sendAckMark(laneId: number, sec: number): void {
    const name = `m${++this.markSeq}`;
    this.pendingMarks.add(name);
    this.markAcks.set(name, { laneId, sec });
    this.send({ event: "mark", streamSid: this.streamSid, mark: { name } });
  }

  private sendMedia(ulaw: Buffer): void {
    const msg = { event: "media", streamSid: this.streamSid, media: { payload: ulaw.toString("base64") } };
    if (this.parked) return this.hold(msg, ulaw.length);
    this.playbackEnd = Math.max(this.playbackEnd, this.now()) + (ulaw.length / 8_000) * 1_000;
    this.send(msg);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.closed) return;
    if (this.parked) return this.hold(msg);
    if (this.ws.readyState !== this.ws.OPEN) {
      this.sendsDropped++;
      return;
    }
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      this.sendsDropped++;
      /* the close handler ends the call */
    }
  }

  // ── Lines of our own ─────────────────────────────────────────────────

  /**
   * Say one line in the call's voice, through the mouth: it waits for the air
   * (never over a reply), in its priority. `dedupe`: skip a line said in the
   * last few seconds.
   */
  async sayLine(
    text: string,
    dedupe = false,
    how: { priority?: MouthPriority; label?: string; maxWaitMs?: number } = {},
  ): Promise<void> {
    if (this.closed) return;
    if (dedupe && this.lastSaid.text === text && this.now() - this.lastSaid.at < 5_000) return;
    this.lastSaid = { text, at: this.now() };
    // The lane is taken BEFORE rendering: a barge-in while the line renders
    // cancels it, and the stale render then sends nothing.
    const label = how.label ?? "line";
    const out = this.mouth.lane({ turnId: `line:${label}`, priority: how.priority ?? "line", label, maxWaitMs: how.maxWaitMs, text });
    let rendered: { pcm: Buffer; sampleRate: number };
    try {
      rendered = await this.deps.say(text, this.voiceStreamId);
    } catch (err) {
      this.log(`[phone] ${this.voiceStreamId} could not render a line: ${(err as Error).message}`);
      return;
    }
    out.start(rendered.sampleRate);
    out.frame(rendered.pcm);
    out.done();
    this.recentSpoken = (this.recentSpoken + " " + text).slice(-600);
  }

  /**
   * Say a last line, let it play, end the call. Terminal the moment it is
   * called: `ending` latches (no passphrase check runs or lands, no turn
   * reaches the agent, no barge-in), and the whole goodbye — render and
   * playback — is capped at goodbyeCapMs; then the line is cut regardless.
   */
  async sayThenHangup(text: string): Promise<void> {
    if (this.closed || this.ending) return;
    this.ending = true;
    this.locked = true; // nothing more reaches the agent
    this.heardWhileLocked = [];
    const hard = setTimeout(() => void this.end("goodbye cap"), this.opts.goodbyeCapMs);
    hard.unref?.();
    // The goodbye is the last thing said: whatever is playing or waiting is cut
    // here — Twilio's buffer cleared, its marks forgotten, every lane cancelled —
    // so the goodbye's own mark is the one the hang-up waits on.
    this.clearPlayback("goodbye");
    await this.sayLine(text, false, { priority: "door", label: "goodbye" });
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      if (!this.playing) return resolve();
      this.onMarksDrained = resolve;
      // Our own playback clock, in case the mark is never echoed.
      setTimeout(resolve, Math.max(0, this.playbackEnd - this.now()) + 1_000).unref?.();
    });
    clearTimeout(hard);
    await this.end("we hung up");
  }

  /**
   * The idle fuse. Idle means nobody is talking AND Michael is not working
   * (a turn in flight re-arms it exactly as his own voice does). Since voice
   * step 2 idle is a QUESTION, not a hang-up: Michael asks once whether the owner
   * is still there, and only silence from his side after it ends the call.
   */
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.closed) return;
    const wait = this.idleAskedAt ? this.opts.idleConfirmMs : this.opts.idleMs;
    this.idleTimer = setTimeout(() => {
      const working = (this.deps.turnsInFlight?.(this.voiceStreamId) ?? 0) > 0;
      if (this.playing || working || this.parked) return this.armIdle(); // check again later
      if (!this.idleAskedAt) {
        this.idleAskedAt = this.now();
        this.log(`[phone] ${this.voiceStreamId} quiet for ${Math.round(this.opts.idleMs / 60_000)} min — asking if anyone is still there`);
        // Droppable: if Michael is talking by then, the question answers itself.
        void this.sayLine(this.opts.idleQuestion, false, { priority: "notice", label: "idle-question", maxWaitMs: 3_000 });
        this.armIdle();
        return;
      }
      void this.sayThenHangup(this.opts.idleGoodbye);
    }, wait);
    this.idleTimer.unref?.();
  }

  // ── The end ──────────────────────────────────────────────────────────

  private closeSocket(code: number, reason: string, ws: WebSocket = this.ws): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  async end(why: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.mouth.close();
    if (this.info) forgetMouth(this.voiceStreamId, this.mouth);
    for (const t of [this.startTimer, this.lockTimer, this.maxTimer, this.idleTimer, this.parked?.timer]) if (t) clearTimeout(t);
    this.parked = null;
    this.held = [];
    this.heldUlawBytes = 0;
    this.heardWhileLocked = [];
    if (this.info) {
      const doors = this.reattaches ? ` · re-attached ${this.reattaches}x, ${(this.gapMs / 1000).toFixed(1)}s between streams` : "";
      this.log(`[phone] ${this.voiceStreamId} ended: ${why}${this.sendsDropped ? ` (${this.sendsDropped} send(s) dropped)` : ""}${doors}`);
    }
    const call = this.call;
    this.call = null;
    // Closing the stream ends <Connect>. Without re-attach the TwiML's
    // <Hangup/> ends the call; with it, Twilio's redirect gets a hang-up
    // answer — and an ending that is ours also ends the call directly, so
    // the line never waits on that answer.
    this.closeSocket(1000, "done");
    if (this.info && this.deps.hangupCall && OUR_ENDINGS.has(why)) {
      void this.deps.hangupCall(this.info.callSid).catch((err) => this.log(`[phone] ${this.voiceStreamId} hang-up via Twilio failed: ${(err as Error).message}`));
    }
    try {
      if (call) await call.hangup(phoneEndToken(why));
    } catch (err) {
      this.log(`[phone] ${this.voiceStreamId} call teardown failed: ${(err as Error).message}`);
    } finally {
      // Unfiled whatever the teardown did: an ended call must never sit in
      // the re-attach map.
      if (this.info) this.deps.onEnded?.(this);
    }
  }
}
