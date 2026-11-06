import { createVoiceStt, type VoiceSttCallbacks } from "../stt-select.js";
import { openScribeEar, type EarStt } from "./scribe-ear.js";
import { type ScreenFrame } from "../screen-frame.js";
import { parseSurface, ScreenWatch, type WatchPick } from "../screen-watch.js";

/* ============================================================
   eleven/side.ts — what rides beside an ElevenLabs call on the app's own
   socket: the side ear (his words as he says them) and the shared screen.

   ElevenLabs owns the call's audio and its turns. Two things it does not
   give us, and the native call does:

   THE EAR. ElevenLabs hands over his words only once a turn is final, so
   nothing painted while he talked ("I have no feedback that I'm saying
   anything", 10/22). The app taps the SDK's own microphone track (echo
   cancelled, the same audio ElevenLabs hears) and streams it here as the
   native call does; the gateway's own recognizer (stt-select: OpenAI today,
   Cartesia when it is back) turns it into `stt-interim` lines for the app to
   paint. DISPLAY ONLY: nothing here starts, ends or routes a turn — the
   ElevenLabs final replaces the interim line and is the one answered and
   kept. It runs only while the call is up: the app stops it on hang-up, the
   call's end stops it here (install.ts → endElevenCall), a closed socket
   stops it, so do 15 s without audio and a 45-minute cap. Every ear logs
   the minutes it listened, and how many partials and lines it painted.

   A LOST RECOGNIZER IS REOPENED (10/23 PM). Through 10/23 one dropped Scribe
   socket closed the ear for the rest of the call (its first mute did it:
   scribe-ear.ts now feeds silence through a mute). Now a Scribe loss while
   the call is live reopens Scribe after 1, 2, then 4 s, holding his frames
   meanwhile; three reopens that fail, or that each die inside 30 s, hand
   the ear to the voice-mode recognizer for the rest of the call. Only the
   real ends close it: app-stop, socket-closed, the call ended, no audio,
   the cap.

   THE SCREEN. The native share (web/src/lib/screenshare.ts) sends
   `screen-share` / `screen-frame` on the app socket naming the call. With no
   native voice session on that socket they land here, held per call (only
   the latest frame, in memory, never logged), and the call's brain hands the
   frame to the turn exactly as the native call does (voice/screen-frame.ts:
   inline image, scrubbed from the session transcript after the turn).

   Only a call this gateway minted for THIS user is accepted for either.
   ============================================================ */

/** A side-channel socket: just enough of `ws` to send JSON. */
export interface SideSocket {
  send(data: string): void;
  readonly readyState: number;
}

interface Ear {
  socket: SideSocket;
  bot: string;
  voiceStreamId: string;
  stt: EarStt | null;
  /** Frames that arrived before the recognizer was open. */
  early: Buffer[];
  startedAt: number;
  lastFrameAt: number;
  frames: number;
  muted: boolean;
  closed: boolean;
  timer: NodeJS.Timeout;
  /** How the app's tap started (its `ctx` field), for the log: tells a phone from a desktop. */
  appCtx: string;
  /** Bumped per recognizer: a late callback of a replaced one is ignored. */
  gen: number;
  /** When the current recognizer opened. */
  sttSince: number;
  /** Reopens in the current run of losses (reset by a recognizer that held 30 s). */
  attempts: number;
  reopens: number;
  reopenTimer: NodeJS.Timeout | null;
  /** Audio seconds billed by recognizers already let go, by provider. */
  billed: Map<string, number>;
  partials: number;
  lines: number;
}

interface Screen {
  frame: ScreenFrame | null;
  frames: number;
  since: number;
  /** Always-on screen watch (voice/screen-watch.ts): the rolling frames and, from the side ear, his words. */
  watch: ScreenWatch;
}

interface CallOwner {
  userId: string;
  bot: string;
  screen: Screen | null;
}

const EAR_IDLE_MS = 15_000;
const EAR_MAX_MS = 45 * 60_000;
const EARLY_MAX = 50; // 5 s of 100 ms frames; the newest are kept
/** The waits before each Scribe reopen; one more loss after the last hands over to the voice-mode recognizer. */
const REOPEN_BACKOFF_MS = [1_000, 2_000, 4_000];
/** A recognizer that held this long earns a fresh run of reopens. */
const REOPEN_HELD_MS = 30_000;
const OPEN = 1;

const calls = new Map<string, CallOwner>(); // by voiceStreamId

/**
 * The app's optional `ctx` on `eleven-ear-start` (web/src/lib/elevenear.ts):
 * its audio context's state and rate, the capture path, ms to its first
 * frame. Log text only — known keys, plain values, bounded; never trusted.
 */
export function describeAppCtx(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const c = raw as Record<string, unknown>;
  const word = (v: unknown): string | null => (typeof v === "string" && /^[\w:. -]{1,60}$/.test(v) ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
  const parts: string[] = [];
  const path = word(c.path);
  const rate = num(c.rate);
  const state = word(c.state);
  if (path) parts.push(path);
  if (rate !== null) parts.push(`${rate} Hz`);
  if (state) parts.push(state);
  if (c.primed === true) parts.push("primed");
  else if (c.primed === false) parts.push("late");
  const first = num(c.firstFrameMs);
  if (first !== null) parts.push(`first frame ${first} ms`);
  else if (c.firstFrameMs === null) parts.push("no frame yet");
  if (c.noInput === true) parts.push("no input");
  if (c.trackMuted === true) parts.push("track muted");
  const why = word(c.why);
  if (why) parts.push(why);
  return parts.length ? `app ${parts.join(", ")}` : "";
}
const ears = new Map<SideSocket, Ear>();

type EarSttFactory = (bot: string, cb: VoiceSttCallbacks) => Promise<EarStt>;

/**
 * The ear's recognizer: ElevenLabs Scribe realtime, which streams his words
 * (scribe-ear.ts); the voice-mode recognizer if Scribe will not open. Display
 * only either way. The voice-mode one is OpenAI's synthesised preview,
 * which painted a breath at a time.
 */
const openEarStt: EarSttFactory = async (bot, cb) => {
  try {
    return await openScribeEar(cb);
  } catch (err) {
    console.warn(`[eleven-ear] scribe would not open (${(err as Error)?.message ?? err}) — the voice-mode recognizer instead`);
    return createVoiceStt(bot, cb);
  }
};

/** Test seam: the recognizer factory. */
let sttFactory: EarSttFactory = openEarStt;
export function __setSideSttFactoryForTests(f: EarSttFactory | null): void {
  sttFactory = f ?? openEarStt;
}
export function __resetSideForTests(): void {
  for (const ear of [...ears.values()]) closeEar(ear, "test-reset");
  calls.clear();
}

/** install.ts: a conversation was minted for this user (side channels may open for it). */
export function noteElevenCall(voiceStreamId: string, userId: string, bot: string): void {
  calls.set(voiceStreamId, { userId, bot, screen: null });
}

/** install.ts: the call is over — its ear stops and its screen is dropped, now. */
export function endElevenCall(voiceStreamId: string, why = "call-ended"): void {
  const call = calls.get(voiceStreamId);
  calls.delete(voiceStreamId);
  if (call?.screen) {
    logShareOff(voiceStreamId, call.screen);
    call.screen.watch.clear();
  }
  for (const ear of [...ears.values()]) if (ear.voiceStreamId === voiceStreamId) closeEar(ear, why);
}

function owned(voiceStreamId: unknown, userId: string): CallOwner | null {
  if (typeof voiceStreamId !== "string") return null;
  const call = calls.get(voiceStreamId);
  return call && call.userId === userId ? call : null;
}

const send = (socket: SideSocket, ev: Record<string, unknown>): void => {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(ev));
  } catch {
    /* socket going away */
  }
};

/* ── The ear ─────────────────────────────────────────────────────────── */

/**
 * `eleven-ear-start` / `eleven-ear-stop` from the app. Returns true when the
 * message was one of ours (handled or refused).
 */
export function handleEarControl(socket: SideSocket, userId: string, msg: Record<string, unknown>): boolean {
  if (msg.type === "eleven-ear-stop") {
    const ear = ears.get(socket);
    if (ear && (msg.voiceStreamId === undefined || msg.voiceStreamId === ear.voiceStreamId)) closeEar(ear, "app-stop");
    return true;
  }
  if (msg.type !== "eleven-ear-start") return false;
  const call = owned(msg.voiceStreamId, userId);
  if (!call) {
    console.warn(`[eleven-ear] start refused: not a live ElevenLabs call of this user`);
    return true;
  }
  const voiceStreamId = msg.voiceStreamId as string;
  const prior = ears.get(socket);
  if (prior) {
    if (prior.voiceStreamId === voiceStreamId && !prior.closed) return true;
    closeEar(prior, "replaced");
  }
  const now = Date.now();
  const ear: Ear = {
    socket,
    bot: call.bot,
    voiceStreamId,
    stt: null,
    early: [],
    startedAt: now,
    lastFrameAt: now,
    frames: 0,
    muted: false,
    closed: false,
    appCtx: describeAppCtx(msg.ctx),
    gen: 0,
    sttSince: now,
    attempts: 0,
    reopens: 0,
    reopenTimer: null,
    billed: new Map(),
    partials: 0,
    lines: 0,
    timer: setInterval(() => {
      const t = Date.now();
      // A muted ear hears nothing by design: that is not a dead uplink. The
      // socket closing or the call ending still stops it.
      if (!ear.muted && t - ear.lastFrameAt > EAR_IDLE_MS) closeEar(ear, "no-audio");
      else if (t - ear.startedAt > EAR_MAX_MS) closeEar(ear, "max-duration");
    }, 2_000),
  };
  ear.timer.unref?.();
  ears.set(socket, ear);
  void sttFactory(call.bot, earCallbacks(ear, 0)).then(
    (stt) => {
      if (ear.closed) {
        void stt.close(ear.bot).catch(() => null);
        return;
      }
      attach(ear, stt);
      console.log(`[eleven-ear] ${voiceStreamId} listening (${stt.provider}${stt.supportsPartials ? "" : ", no partials"}${ear.appCtx ? `; ${ear.appCtx}` : ""}) — display only`);
    },
    (err: unknown) => {
      console.warn(`[eleven-ear] ${voiceStreamId} recognizer would not open: ${(err as Error)?.message ?? err}`);
      closeEar(ear, "recognizer-failed");
    },
  );
  return true;
}

/** A binary mic frame on a socket with no native voice session. True if an ear took it. */
export function feedEar(socket: SideSocket, frame: Buffer): boolean {
  const ear = ears.get(socket);
  if (!ear || ear.closed) return false;
  if (ear.muted) return true; // muted means muted: dropped, not transcribed
  ear.lastFrameAt = Date.now();
  ear.frames++;
  if (ear.stt) ear.stt.feed(frame);
  else {
    if (ear.early.length >= EARLY_MAX) ear.early.shift();
    ear.early.push(frame);
  }
  return true;
}

/** The callbacks of recognizer number `gen` of this ear; a replaced one's are inert. */
function earCallbacks(ear: Ear, gen: number): VoiceSttCallbacks {
  const live = (): boolean => !ear.closed && ear.gen === gen;
  const { socket, voiceStreamId, bot } = ear;
  return {
    onPartial: (text) => {
      if (!live()) return;
      ear.partials++;
      calls.get(voiceStreamId)?.screen?.watch.partial(text);
      send(socket, { type: "stt-interim", voiceStreamId, bot, text, side: true });
    },
    onTurnEnd: (text) => {
      if (!live()) return;
      ear.lines++;
      calls.get(voiceStreamId)?.screen?.watch.final(text);
      send(socket, { type: "stt-ear-final", voiceStreamId, bot, text });
    },
    onError: (err) => {
      if (live()) console.warn(`[eleven-ear] ${voiceStreamId} recognizer error: ${err.message.slice(0, 120)}`);
    },
    onDegraded: (mode, reason) => {
      if (live()) console.warn(`[eleven-ear] ${voiceStreamId} recognizer degraded (${mode}, ${reason})`);
    },
    onLost: (reason) => {
      if (live()) lost(ear, reason);
    },
  };
}

/** A recognizer is open for this ear: frames held meanwhile go first. */
function attach(ear: Ear, stt: EarStt): void {
  ear.stt = stt;
  ear.sttSince = Date.now();
  for (const f of ear.early.splice(0)) stt.feed(f);
}

/** Let a recognizer go, counting what it billed. */
function release(ear: Ear, stt: EarStt): Promise<void> {
  return stt.close(ear.bot).then(
    (usage) => {
      if (usage && typeof usage.audioSec === "number") ear.billed.set(stt.provider, (ear.billed.get(stt.provider) ?? 0) + usage.audioSec);
    },
    () => {},
  );
}

/**
 * The recognizer went away on its own. Scribe is reopened (1 s, 2 s, 4 s);
 * a run of three that fail or die young hands over to the voice-mode
 * recognizer. A lost voice-mode recognizer is the end: nothing is left.
 */
function lost(ear: Ear, reason: string): void {
  const stt = ear.stt;
  if (!stt || stt.provider !== "scribe" || !calls.has(ear.voiceStreamId)) {
    console.warn(`[eleven-ear] ${ear.voiceStreamId} recognizer lost (${reason}) — interim words stop; the call goes on`);
    closeEar(ear, "recognizer-lost");
    return;
  }
  ear.stt = null;
  ear.gen++;
  void release(ear, stt);
  if (Date.now() - ear.sttSince >= REOPEN_HELD_MS) ear.attempts = 0;
  console.warn(`[eleven-ear] ${ear.voiceStreamId} scribe dropped (${reason}) after ${Math.round((Date.now() - ear.sttSince) / 1000)} s`);
  retry(ear);
}

/** The next reopen, or the hand-over once the run is spent. */
function retry(ear: Ear): void {
  if (ear.closed) return;
  const n = ear.attempts++;
  if (n >= REOPEN_BACKOFF_MS.length) {
    fallBack(ear);
    return;
  }
  const wait = REOPEN_BACKOFF_MS[n];
  const gen = ear.gen;
  console.warn(`[eleven-ear] ${ear.voiceStreamId} reopening scribe in ${wait / 1000} s (attempt ${n + 1} of ${REOPEN_BACKOFF_MS.length})`);
  ear.reopenTimer = setTimeout(() => {
    ear.reopenTimer = null;
    if (ear.closed || ear.gen !== gen) return;
    openScribeEar(earCallbacks(ear, gen)).then(
      (stt) => {
        if (ear.closed || ear.gen !== gen) {
          void stt.close(ear.bot).catch(() => null);
          return;
        }
        ear.reopens++;
        const held = ear.early.length;
        attach(ear, stt);
        console.log(`[eleven-ear] ${ear.voiceStreamId} scribe reopened (attempt ${n + 1}), ${held} held frame(s) sent — words go on`);
      },
      (err: unknown) => {
        if (ear.closed || ear.gen !== gen) return;
        console.warn(`[eleven-ear] ${ear.voiceStreamId} scribe reopen ${n + 1} failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
        ear.gen++;
        retry(ear);
      },
    );
  }, wait);
  ear.reopenTimer.unref?.();
}

/** Scribe will not stay: the voice-mode recognizer carries the ear for the rest of the call. */
function fallBack(ear: Ear): void {
  const gen = ++ear.gen;
  console.warn(`[eleven-ear] ${ear.voiceStreamId} scribe would not stay open after ${REOPEN_BACKOFF_MS.length} reopen(s) — the voice-mode recognizer instead`);
  createVoiceStt(ear.bot, earCallbacks(ear, gen)).then(
    (stt) => {
      if (ear.closed || ear.gen !== gen) {
        void stt.close(ear.bot).catch(() => null);
        return;
      }
      const held = ear.early.length;
      attach(ear, stt);
      console.log(`[eleven-ear] ${ear.voiceStreamId} listening (${stt.provider}, after scribe), ${held} held frame(s) sent — display only`);
    },
    (err: unknown) => {
      if (ear.closed || ear.gen !== gen) return;
      console.warn(`[eleven-ear] ${ear.voiceStreamId} the voice-mode recognizer would not open either: ${(err as Error)?.message ?? err}`);
      closeEar(ear, "recognizer-failed");
    },
  );
}

/** `voice-mute` with no native session: the ear's second lock (the app stops sending first). */
export function muteEar(socket: SideSocket, on: boolean): boolean {
  const ear = ears.get(socket);
  if (!ear) return false;
  ear.muted = on;
  // Unmuting restarts the idle clock: the quiet while muted does not count.
  if (!on) ear.lastFrameAt = Date.now();
  console.log(`[eleven-ear] ${ear.voiceStreamId} ${on ? "muted" : "unmuted"}`);
  return true;
}

/** The app socket closed. */
export function socketGone(socket: SideSocket): void {
  const ear = ears.get(socket);
  if (ear) closeEar(ear, "socket-closed");
}

/** Live ears (health / tests). */
export function liveEars(): number {
  return ears.size;
}

function closeEar(ear: Ear, why: string): void {
  if (ear.closed) return;
  ear.closed = true;
  clearInterval(ear.timer);
  if (ear.reopenTimer) clearTimeout(ear.reopenTimer);
  ear.reopenTimer = null;
  if (ears.get(ear.socket) === ear) ears.delete(ear.socket);
  ear.early = [];
  const minutes = (Date.now() - ear.startedAt) / 60_000;
  const stt = ear.stt;
  ear.stt = null;
  // An ear that never got one frame is a known phone bug: say so.
  const reason = why === "no-audio" && ear.frames === 0 ? "no-audio (never fed)" : why;
  const line = (): void => {
    const billed = [...ear.billed].map(([p, sec]) => `, ${p} billed ${(sec / 60).toFixed(2)} audio minute(s)`).join("");
    const reopened = ear.reopens ? `, ${ear.reopens} reopen(s)` : "";
    console.log(
      `[eleven-ear] ${ear.voiceStreamId} stopped (${reason}) — ${minutes.toFixed(2)} minute(s) open, ${ear.frames} frame(s)${billed}${reopened}, ${ear.partials} partial(s) and ${ear.lines} line(s) painted`,
    );
  };
  if (!stt) line();
  else void release(ear, stt).then(line);
  // Clear the painted line: nothing more is coming from this ear.
  send(ear.socket, { type: "stt-interim", voiceStreamId: ear.voiceStreamId, bot: ear.bot, text: "", side: true });
}

/* ── The screen ──────────────────────────────────────────────────────── */

/**
 * `screen-share` / `screen-frame` on a socket with no native voice session.
 * True when it named an ElevenLabs call of this user (handled or refused).
 */
export function handleScreenControl(userId: string, msg: Record<string, unknown>): boolean {
  if (msg.type !== "screen-share" && msg.type !== "screen-frame") return false;
  const call = owned(msg.voiceStreamId, userId);
  if (!call) return false;
  const voiceStreamId = msg.voiceStreamId as string;
  if (msg.type === "screen-share") {
    if (msg.on === true) {
      call.screen ??= { frame: null, frames: 0, since: Date.now(), watch: new ScreenWatch() };
      call.screen.watch.surface = parseSurface(msg.surface);
      console.log(`[voice-screen] ${voiceStreamId} sharing ON (eleven, ${call.screen.watch.surface})`);
    } else if (call.screen) {
      logShareOff(voiceStreamId, call.screen);
      call.screen.watch.clear();
      call.screen = null;
    }
    return true;
  }
  // Accepted only while sharing is on; validated and size-capped; pixels never logged.
  if (!call.screen) return true;
  const frame = call.screen.watch.addFrame(msg);
  if (!frame) {
    console.warn(`[voice-screen] ${voiceStreamId} rejected an off-shape frame (eleven)`);
    return true;
  }
  call.screen.frame = call.screen.watch.latest();
  call.screen.frames++;
  return true;
}

/**
 * The frames for an ElevenLabs turn starting now (always-on): the engine says
 * nothing about when he began, so the window starts at his first word the side
 * ear heard since the last turn, or 10 s back. No record mode on this engine.
 */
export function elevenScreenPick(voiceStreamId: string, userName?: string): WatchPick | null {
  const watch = calls.get(voiceStreamId)?.screen?.watch;
  return watch ? watch.takeTurn({ fallbackFrom: Date.now() - 10_000, userName }) : null;
}

/** The latest shared frame of this call, or null when he is not sharing. */
export function elevenScreenFrame(voiceStreamId: string): ScreenFrame | null {
  return calls.get(voiceStreamId)?.screen?.frame ?? null;
}

function logShareOff(voiceStreamId: string, s: Screen): void {
  console.log(`[voice-screen] ${voiceStreamId} sharing OFF after ${Math.round((Date.now() - s.since) / 1000)}s, ${s.frames} frame(s) received (eleven)`);
}
