import type { WsClient } from "./ws";
import { claimPlayback } from "./nowplaying";
import { Ear, earSeconds } from "./ear";

/**
 * Voice-mode plumbing (3d2#6): the recorder lives deep in the composer
 * while the WS connection lives in App — this tiny bus carries voice
 * events down and voice frames up without threading props.
 *
 * It also owns TTS reply playback: after a voice turn the gateway sends
 * {type:"voice-tts", audioBase64, mimeType} to THIS socket (deployed
 * index.ts voiceTurnHandler) — played here once, app-wide.
 */

export interface VoiceEvent {
  type: string;
  voiceStreamId?: string;
  bot?: string;
  text?: string;
  error?: string;
  audioBase64?: string;
  mimeType?: string;
  [k: string]: unknown;
}

let activeWs: WsClient | null = null;
const listeners = new Set<(ev: VoiceEvent) => void>();

export function registerVoiceWs(ws: WsClient | null): void {
  activeWs = ws;
}

export function onVoiceEvent(fn: (ev: VoiceEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Is anything actually listening to voice events?
 *
 * Used to keep agent text-stream events off the voice bus when no call is up.
 * Those fire for every token of every ordinary chat reply, so with voice mode
 * off the dispatch must stay exactly as cheap as it was before this feature
 * existed — not "nearly free".
 */
export function hasVoiceListeners(): boolean {
  return listeners.size > 0;
}

let ttsPlayer: HTMLAudioElement | null = null;

/* ── Streamed reply playback (voice mode) ─────────────────────────────────
   A call's reply arrives as raw PCM s16le frames while it is still being
   generated, so there is no file to hand to an <audio> element — the element
   path stays for the DEGRADED blob fallback and for voice notes, and calls
   go through Web Audio instead.

   Frames are scheduled back-to-back on the audio clock rather than played on
   arrival. `cursor` is the time the next frame should start; scheduling
   against it is what keeps consecutive frames seamless instead of clicking
   at every boundary. If the network falls behind and `cursor` slips into the
   past (or within UNDERRUN_DEADLINE_S of it), we restart just ahead of
   `currentTime` and record the whole displacement in `gapOffset` so the
   karaoke clock stays aligned with what is actually being heard — otherwise
   the highlight drifts by exactly the length of the stall.
                                                                            */
/**
 * Rate to open the context with before the server has told us the real one.
 *
 * Must track `loadCartesiaConfig`'s default in src/config.ts. An AudioContext's
 * sample rate is fixed at construction, so a mismatch here is not a tuning
 * detail — it forces `beginVoiceStream` to tear down the context created
 * during the user's tap and build a new one inside a WebSocket handler, which
 * is exactly the situation browser autoplay policy blocks. Matching the
 * server's default means the common case keeps the gesture-created context.
 */
const STREAM_SAMPLE_RATE_FALLBACK = 44100;
/** Schedule this far ahead of the clock — absorbs jitter without audible lag. */
const SCHEDULE_LEAD_S = 0.03;
/**
 * A frame is appended back to back while at least this much is still queued
 * ahead of the clock. Only below it — a real underrun, or so close to one
 * that the start might miss its render deadline — does the cursor restart
 * SCHEDULE_LEAD_S ahead. It used to restart whenever under SCHEDULE_LEAD_S
 * was queued: a frame arriving 20 ms before the previous one ended got 10 ms
 * of silence inserted in front of it, and the karaoke clock never counted it
 * (call-pauses diagnosis). 10 ms is three or four render quanta at
 * 44.1/48 kHz: room for the start message to reach the audio thread.
 */
const UNDERRUN_DEADLINE_S = 0.01;

interface StreamPlayback {
  ctx: AudioContext;
  sources: Set<AudioBufferSourceNode>;
  cursor: number;
  audioStart: number;
  gapOffset: number;
  sampleRate: number;
  /** Seconds of audio scheduled this turn — the client half of the turn's audio total. */
  turnScheduledSec: number;
  /** Every reply source plays through this, so a barge candidate can DUCK it (part seven). */
  out: GainNode | null;
  /** Seam telemetry for the current turn — see `noteSeam`. */
  seams: SeamStats;
}

/* ── Seam telemetry (call pauses) ─────────────────────────────────
   The server's `[call-seam]` lines say when each piece of an answer was
   ready and released; these say what the app then did with it. At every
   frame after the first of a turn: how much audio was still queued ahead of
   the clock when it arrived, and how much silence scheduling it inserted.
   A frame that inserted silence, or arrived with under SEAM_LOW_WATER_MS
   queued, is reported as a `seam` line; the turn's totals ride on
   `turn-played`. `atSec` is where in the answer's audio the frame starts —
   the same number the server's line carries, so the two line up.
   Content-free: numbers only, never audio or words.                       */
const SEAM_LOW_WATER_MS = 80;
/** A long trickle could report every frame; past this, a turn's seams are only counted. */
const SEAM_REPORTS_PER_TURN = 24;

interface SeamStats {
  frames: number;
  underruns: number;
  insertedSec: number;
  minQueuedMs: number | null;
  reported: number;
}

const freshSeams = (): SeamStats => ({ frames: 0, underruns: 0, insertedSec: 0, minQueuedMs: null, reported: 0 });

/** One scheduled frame's seam numbers. `queuedSec` < 0 means the queue had already run dry. */
function noteSeam(s: StreamPlayback, atSec: number, queuedSec: number, insertedSec: number, frameSec: number): void {
  const st = s.seams;
  st.frames++;
  const queuedMs = Math.round(queuedSec * 1000);
  st.minQueuedMs = st.minQueuedMs === null ? queuedMs : Math.min(st.minQueuedMs, queuedMs);
  if (insertedSec > 0) {
    st.underruns++;
    st.insertedSec += insertedSec;
  }
  if (insertedSec <= 0 && queuedMs >= SEAM_LOW_WATER_MS) return;
  if (st.reported++ >= SEAM_REPORTS_PER_TURN) return;
  report("seam", {
    atSec: Number(atSec.toFixed(2)),
    queuedMs,
    gapMs: Math.round(insertedSec * 1000),
    frameMs: Math.round(frameSec * 1000),
    ctxState: s.ctx.state,
    ducked,
  });
}

/* ── Playback telemetry (part three) ──────────────────────────────
   Twice on 10/13 the first reply of a call lost audio the server had
   rendered and sent: the gateway log proves every sentence went out, and the
   app's own record shows the text settled whole, so nothing in the server's
   view can say where the sound went. These lines are the app's view: each
   time queued audio is silenced and why, how much was still unplayed, the
   audio context's state changes and output-device changes, and what a turn
   scheduled once it drained. They land in the gateway log as [voice-client]
   next to the server's per-turn audio total. Content-free: numbers and
   reasons, never audio or words.                                          */
const lastReportAt = new Map<string, number>();
function report(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  // Clock checks run every animation frame: one line per kind per 2 s at most.
  if (event.startsWith("clock-")) {
    const now = Date.now();
    if (now - (lastReportAt.get(event) ?? 0) < 2000) return;
    lastReportAt.set(event, now);
  }
  try {
    activeWs?.send({ type: "voice-client-event", event, ...fields });
  } catch {
    /* telemetry never breaks playback */
  }
}

/**
 * The call could not open the mic (voicemode.ts). Sent with NO voice session
 * — there is none yet — so it has its own message type; the gateway logs it
 * against the signed-in user. Error NAMES only, never messages.
 */
export function reportMicStartError(fields: Record<string, string | boolean>): void {
  try {
    activeWs?.send({ type: "voice-mic-error", ...fields });
  } catch {
    /* telemetry never breaks the call screen */
  }
}

/** Seconds still queued ahead of the clock, or 0. */
function unplayedSec(s: StreamPlayback | null): number {
  if (!s || s.audioStart < 0) return 0;
  return Math.max(0, s.cursor - s.ctx.currentTime);
}

function reportCut(reason: string): void {
  const left = unplayedSec(stream);
  if (left < 0.05) return;
  report("audio-cut", {
    reason,
    unplayedSec: Number(left.toFixed(2)),
    scheduledSec: Number((stream?.turnScheduledSec ?? 0).toFixed(2)),
    ctxState: stream?.ctx.state ?? null,
  });
}

/** The current reply's audio drained on its own — what it scheduled, and the gaps heard. */
export function reportVoiceTurnPlayed(): void {
  const s = stream;
  if (!s || s.turnScheduledSec <= 0) return;
  const ctx = s.ctx as AudioContext & { outputLatency?: number; baseLatency?: number };
  report("turn-played", {
    scheduledSec: Number(s.turnScheduledSec.toFixed(2)),
    gapSec: Number(s.gapOffset.toFixed(2)),
    ctxState: s.ctx.state,
    outputLatencyMs: typeof ctx.outputLatency === "number" ? Math.round(ctx.outputLatency * 1000) : null,
    frames: s.seams.frames,
    underruns: s.seams.underruns,
    insertedMs: Math.round(s.seams.insertedSec * 1000),
    minQueuedMs: s.seams.minQueuedMs,
  });
}

/**
 * The audio clock against the wall clock, sampled from the call screen's
 * animation loop. If the audio clock leaps ahead of real time while a reply
 * is queued, the browser skips what was scheduled inside the leap: audio
 * lost with no error. A clock that stands still while time passes delays it.
 * Both are reported; nothing is changed.
 */
let clockSample: { ctx: number; wall: number } | null = null;
export function checkVoiceClock(wallMs: number = Date.now()): void {
  const s = stream;
  if (!s) {
    clockSample = null;
    return;
  }
  const now = { ctx: s.ctx.currentTime, wall: wallMs / 1000 };
  const prev = clockSample;
  clockSample = now;
  if (!prev) return;
  const wall = now.wall - prev.wall;
  // A backgrounded tab throttles the loop; only judge short, regular gaps.
  if (wall <= 0 || wall > 1) return;
  const drift = now.ctx - prev.ctx - wall;
  const queued = unplayedSec(s);
  if (drift > 0.25 && queued > 0) {
    report("clock-jump", { aheadSec: Number(drift.toFixed(2)), unplayedSec: Number(queued.toFixed(2)), ctxState: s.ctx.state });
  } else if (drift < -0.5 && queued > 0 && s.ctx.state === "running") {
    report("clock-stall", { behindSec: Number((-drift).toFixed(2)), unplayedSec: Number(queued.toFixed(2)) });
  }
}

let deviceWatch = false;
function watchOutputDevices(): void {
  if (deviceWatch) return;
  const md = (globalThis.navigator as Navigator | undefined)?.mediaDevices;
  if (!md || typeof md.addEventListener !== "function") return;
  deviceWatch = true;
  md.addEventListener("devicechange", () => {
    if (!stream) return;
    report("device-change", {
      unplayedSec: Number(unplayedSec(stream).toFixed(2)),
      ctxState: stream.ctx.state,
    });
  });
}

let stream: StreamPlayback | null = null;

/**
 * A context created during a tap can still come up `suspended` — on iOS, and
 * on any tab that was backgrounded between the tap and the first frame. Every
 * frame would then be scheduled onto a clock that never advances: silence, no
 * error. Resuming is idempotent and costs nothing when already running.
 */
function resumeIfSuspended(s: StreamPlayback): void {
  if (s.ctx.state === "suspended") void s.ctx.resume().catch(() => {});
}

/**
 * A context at the stream's rate when the browser allows one. Older WebKit
 * rejects a `sampleRate` option; the default-rate context still plays the
 * frames, because buffers are created at `s.sampleRate` and resampled on
 * playback. Without this, the throw left the call with no playback at all.
 */
function openPlaybackContext(sampleRate: number): AudioContext {
  try {
    return new AudioContext({ sampleRate });
  } catch {
    return new AudioContext();
  }
}

/** Open the streamed-audio context for a call. Idempotent. */
export function beginVoiceStream(sampleRate = STREAM_SAMPLE_RATE_FALLBACK): void {
  if (stream && stream.sampleRate === sampleRate) {
    resumeIfSuspended(stream);
    return;
  }
  endVoiceStream();
  try {
    const s: StreamPlayback = {
      ctx: openPlaybackContext(sampleRate),
      sources: new Set(),
      cursor: 0,
      audioStart: -1,
      gapOffset: 0,
      sampleRate,
      turnScheduledSec: 0,
      out: null,
      seams: freshSeams(),
    };
    try {
      const g = s.ctx.createGain();
      g.gain.value = 1;
      g.connect(s.ctx.destination);
      s.out = g;
    } catch {
      s.out = null; // no gain stage: sources go straight out, ducking is a no-op
    }
    // A context that leaves `running` mid-reply stops its clock: whatever
    // was queued plays late, or not at all if it is then closed.
    s.ctx.onstatechange = () => {
      if (stream !== s) return;
      if (door && s.ctx.state !== "running" && unplayedSec(s) > 0) door.lost = true;
      report("ctx-state", { state: s.ctx.state, unplayedSec: Number(unplayedSec(s).toFixed(2)) });
    };
    resumeIfSuspended(s);
    stream = s;
    watchOutputDevices();
  } catch {
    stream = null;
  }
}

let ducked = false;

/**
 * Lower (or restore) the reply's volume without stopping it — what mic
 * energy does now, instead of cutting (part seven). A cut needs words.
 */
export function duckAgentAudio(on: boolean, level = 0.3): void {
  if (on !== ducked && stream) {
    // Ducked speech can sound like a pause on a quiet line: put it on the timeline.
    report(on ? "duck" : "duck-restore", {
      atSec: Number(Math.max(0, voiceStreamPosition() ?? 0).toFixed(2)),
      unplayedSec: Number(unplayedSec(stream).toFixed(2)),
    });
  }
  ducked = on;
  const g = stream?.out;
  if (!g) return;
  try {
    g.gain.value = on ? level : 1;
  } catch {
    /* context closing */
  }
}

export function isAgentAudioDucked(): boolean {
  return ducked;
}

/** Tear the streamed-audio context down at the end of a call. */
export function endVoiceStream(): void {
  // A call that ends with a cut must not start the NEXT call gated.
  cutUntilNextTurn = false;
  if (!stream) return;
  const dying = stream;
  stream = null;
  for (const s of dying.sources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  dying.sources.clear();
  void dying.ctx.close().catch(() => {});
}

/** Schedule one PCM s16le frame. Called for every binary WS frame. */
export function pushVoiceFrame(pcm: ArrayBuffer): void {
  // No context means no call. Opening one here would build it at the FALLBACK
  // rate for frames that straggle in after `endVoiceStream` — the tail of a
  // finished reply replayed slow and deep-pitched, seconds after the call
  // closed. A frame with nowhere to go is dropped, which is what it is.
  const s = stream;
  if (!s) return;
  // After a cut, the old reply's frames still in flight are dropped — see
  // `cutUntilNextTurn`. The next turn's `voice-tts-start` reopens the gate.
  if (cutUntilNextTurn) return;
  resumeIfSuspended(s);

  // s16le means two bytes per sample. An odd-length buffer is a truncated
  // frame — `new Int16Array` THROWS on it, which would take out the WS message
  // handler for the rest of the call, so it is dropped instead.
  if (pcm.byteLength < 2 || pcm.byteLength % 2 !== 0) return;
  const i16 = new Int16Array(pcm);
  if (i16.length === 0) return;
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  const buf = s.ctx.createBuffer(1, f32.length, s.sampleRate);
  buf.getChannelData(0).set(f32);
  const src = s.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(s.out ?? s.ctx.destination);

  const now = s.ctx.currentTime;
  const started = s.audioStart >= 0;
  const queuedSec = s.cursor - now;
  const contiguousAt = s.cursor;
  if (!started) {
    // A turn's first frame: the lead is startup cushion, not a gap.
    s.cursor = now + SCHEDULE_LEAD_S;
    s.audioStart = s.cursor;
    s.gapOffset = 0;
  } else if (queuedSec < UNDERRUN_DEADLINE_S) {
    // Underrun. Restart just ahead of the clock and count ALL of the
    // displacement — the silence already heard AND the lead in front of this
    // frame — so the karaoke clock stays on the words actually playing.
    s.cursor = now + SCHEDULE_LEAD_S;
    s.gapOffset += s.cursor - contiguousAt;
  }
  if (started) noteSeam(s, s.turnScheduledSec, queuedSec, s.cursor - contiguousAt, buf.duration);
  src.start(s.cursor);
  s.cursor += buf.duration;
  s.turnScheduledSec += buf.duration;
  s.sources.add(src);
  src.onended = () => s.sources.delete(src);
}

/**
 * Playback position within the current reply, in seconds.
 *
 * This is the karaoke clock: it is the AUDIO clock, not wall time, so it stays
 * correct across scheduling jitter and underruns. Returns null when nothing is
 * playing.
 */
export function voiceStreamPosition(): number | null {
  if (externalClock) return externalClock();
  if (!stream || stream.audioStart < 0) return null;
  return stream.ctx.currentTime - stream.audioStart - stream.gapOffset;
}

/* ── A broken door and the reply that was playing (voice step 3) ──────────
   While the call's socket is down the gateway holds what Michael says and
   replays it on the resume. What was ALREADY here keeps playing — unless the
   playback itself stopped (iOS suspends or interrupts the context on a lock
   or a cellular call; the clock stalls). Then the reply's unplayed rest is
   stale: on the resume this page says how far it got and that its audio did
   not survive, drops that rest, and the gateway re-says from the start of
   the sentence he was hearing — once (src/voice/mouth.ts). If the audio did
   survive, it says so and nothing is said twice.                          */
let door: { wall: number; ctxTime: number; queued: number; lost: boolean } | null = null;

/** The socket under a live call went down. */
export function noteVoiceDoorDown(wallMs: number = Date.now()): void {
  if (door) return;
  const s = stream;
  door = {
    wall: wallMs,
    ctxTime: s ? s.ctx.currentTime : 0,
    queued: unplayedSec(s),
    lost: !!s && s.ctx.state !== "running" && unplayedSec(s) > 0,
  };
}

/**
 * The resume's report: how far the reply on air had played (its own clock)
 * and whether its audio was lost while the door was down. Null when no door
 * broke or nothing was playing. A lost rest is dropped here.
 */
export function takeVoiceDoorReport(wallMs: number = Date.now()): { sec: number; lost: boolean } | null {
  const d = door;
  door = null;
  if (!d) return null;
  const s = stream;
  const pos = voiceStreamPosition();
  if (!s || pos === null) return null;
  // The clock stalled with audio queued: it did not play while we were away.
  const stalled = d.queued > 0.3 && s.ctx.currentTime - d.ctxTime < Math.min(d.queued, (wallMs - d.wall) / 1000) - 0.5;
  const lost = d.lost || stalled;
  const sec = Math.max(0, Math.round(pos * 100) / 100);
  if (lost) resetVoiceTurnAudio("door-lost");
  return { sec, lost };
}

/**
 * A call whose audio this module does not play (ElevenLabs: their SDK plays
 * it over WebRTC) supplies its own karaoke clock: seconds on the same axis as
 * its word timings. Null hands the clock back to the native stream.
 */
let externalClock: (() => number | null) | null = null;

export function setExternalVoiceClock(clock: (() => number | null) | null): void {
  externalClock = clock;
}

/** Is streamed audio still queued ahead of the clock? */
export function voiceStreamDraining(): boolean {
  if (!stream || stream.audioStart < 0) return false;
  return stream.cursor > stream.ctx.currentTime + 0.02;
}

/**
 * Playback position at the instant the agent was last cut off, in seconds.
 *
 * `stopAgentAudio` destroys the clock it reads from — that is its job — so by
 * the time the server's `voice-interrupt-ack` comes back there is nothing left
 * to ask how much had actually been heard. This is that answer, stamped before
 * the cut. Null when the agent was not audible when it was cut, which honestly
 * means "nothing was spoken".
 */
export function voiceCutPosition(): number | null {
  return cutPosition;
}

let cutPosition: number | null = null;

/**
 * True from a local cut (barge-in, end) until the next turn's audio begins.
 *
 * `stopAgentAudio` empties the queue, but the gateway does not hear about the
 * barge-in for a round trip, and synthesis runs ahead of playback — frames it
 * sent before the interrupt arrived are still on the wire. Without this gate
 * they were scheduled as they landed, and the agent came back for a beat of
 * the reply the user had just talked over.
 */
let cutUntilNextTurn = false;

/**
 * Was the current reply's audio CUT (barge-in, end) rather than drained?
 * Stopped audio is not draining either, so without asking this, a reply whose
 * synthesis had finished settled as fully spoken on the frame after the cut —
 * whole text, no INTERRUPTED — and the server's ack found nothing left to
 * settle (voice-streaming-bargein: "once the full text exists, talking over
 * me does not show the interrupted label").
 */
export function voiceAudioWasCut(): boolean {
  return cutUntilNextTurn;
}

/**
 * Before the first word of any reply.
 *
 * Not zero: the first word's timestamp STARTS at zero, so a position of 0
 * means "word one has just begun", which is a different claim from "nothing
 * was ever heard" — and the difference is one word put in the agent's mouth.
 */
const NOT_STARTED = -1;

/**
 * Where to freeze a turn that was cut off — the position to truncate at.
 *
 * Three answers in order of authority: the live clock if the audio is somehow
 * still running, the position stamped at the cut, and finally "it never
 * started". The old code had only the first and fell back to
 * MAX_SAFE_INTEGER, which reads as "all of it was spoken" — the exact
 * opposite of the truth, and a direct violation of the 3K contract, since
 * synthesis runs seconds ahead of playback and everything Sonic had produced
 * would freeze on screen as though the user had heard it.
 */
export function interruptPosition(): number {
  return voiceStreamPosition() ?? cutPosition ?? NOT_STARTED;
}

/**
 * Reset the per-turn clock so the next reply starts its own karaoke pass.
 *
 * Also STOPS anything still queued from the turn before. Resetting the cursor
 * alone was the old overlap: if the owner spoke over a reply too softly for
 * barge-in to fire, his words still became the next turn, and that turn's
 * first frame was scheduled at "now" while the old reply's remaining seconds
 * were still on the audio clock — the new answer started over the old tail.
 * A new turn only exists because he spoke, so whatever was still queued from
 * the old one is speech he already talked over. Every caller (the next turn's
 * voice-tts-start, settling a turn, a failed turn) is a point where the old
 * turn's audio must be gone.
 */
export function resetVoiceTurnAudio(reason = "reset"): void {
  cutPosition = null;
  duckAgentAudio(false);
  if (!stream) return;
  reportCut(reason);
  stream.turnScheduledSec = 0;
  stream.seams = freshSeams();
  for (const s of stream.sources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  stream.sources.clear();
  stream.cursor = 0;
  stream.audioStart = -1;
  stream.gapOffset = 0;
}

/** Called by App for every voice-family WS event. */
export function dispatchVoiceEvent(ev: VoiceEvent): void {
  if (ev.type === "voice-tts-start") {
    // A new turn's audio: the gate a cut closed opens again for it.
    cutUntilNextTurn = false;
    const rate = typeof ev.sampleRate === "number" ? ev.sampleRate : undefined;
    beginVoiceStream(rate);
    resetVoiceTurnAudio("next-turn");
  }
  if (ev.type === "voice-tts" && typeof ev.audioBase64 === "string") {
    // Degraded blob fallback (and voice notes) — the element path.
    try {
      ttsPlayer?.pause();
      ttsPlayer = new Audio(`data:${ev.mimeType || "audio/mp3"};base64,${ev.audioBase64}`);
      claimPlayback(ttsPlayer);
      void ttsPlayer.play().catch(() => {});
    } catch {
      /* audio unavailable — the durable voice-media upsert still lands */
    }
  }
  for (const l of listeners) l(ev);
}

/**
 * Is the agent actually making sound right now?
 *
 * This is the gate on barge-in: mic energy only counts as an interruption
 * while the agent is audible. Asking the element directly, rather than
 * tracking a separate state flag, keeps it true for exactly as long as sound
 * is coming out — including the tail after the last chunk.
 */
export function isAgentAudible(): boolean {
  // Streamed audio counts too, and MUST — this is the gate on barge-in, and a
  // call's reply never touches the element path. Checking only the element
  // would mean mic energy during a streamed reply was never read as an
  // interruption, and barge-in would silently stop working in exactly the
  // mode it exists for.
  if (voiceStreamDraining()) return true;
  return !!ttsPlayer && !ttsPlayer.paused && !ttsPlayer.ended;
}

/**
 * Cut the agent off mid-sentence, locally and immediately.
 *
 * The local cut MUST happen before the server is told. Waiting for the round
 * trip is what makes barge-in feel broken: the user talks over the agent and
 * keeps hearing it for another beat. Here they stop hearing it on the same
 * frame their speech was detected, and the gateway aborting generation
 * catches up a moment later.
 */
export function stopAgentAudio(reason = "cut"): void {
  reportCut(reason);
  duckAgentAudio(false);
  cutUntilNextTurn = true;
  // Stamp how far playback had actually got BEFORE tearing the clock down.
  // Everything below sets `audioStart` back to -1, after which
  // `voiceStreamPosition()` returns null forever — and the karaoke truncation
  // that decides which words were really spoken does not run until the
  // server's ack arrives, well after this point. Read it here or not at all.
  cutPosition = voiceStreamPosition();

  // Kill scheduled frames first. They are already queued on the audio clock,
  // so anything not stopped here KEEPS PLAYING regardless of what the server
  // does next — the local cut is the only thing that actually silences a
  // streamed reply on the frame the user started talking.
  if (stream) {
    for (const s of stream.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    stream.sources.clear();
    stream.cursor = 0;
    stream.audioStart = -1;
    stream.gapOffset = 0;
  }
  try {
    ttsPlayer?.pause();
    if (ttsPlayer) ttsPlayer.currentTime = 0;
  } catch {
    /* element already torn down */
  }
}

export function sendVoiceControl(payload: Record<string, unknown>): void {
  activeWs?.send(payload);
}

/** Make the call's socket prove it is alive now (ws.ts `probe`): a dead one is dropped and reopened. */
export function probeVoiceLink(): void {
  activeWs?.probe?.();
}

/* ── The mute gate ────────────────────────────────────────────────────────
   MUTE is a privacy promise, so it is enforced at the one place every mic
   frame must pass through on its way off the device, not at the place that
   draws the button. It previously lived only in the voice screen's React
   state, next to a `voice-mute` message the server has no handler for: the
   button lit up, the worklet kept posting frames, and the gateway kept
   transcribing the room — including whoever else was in it.

   The server enforces this too (websocket.ts drops frames on a muted
   session). Both, deliberately: this one is what stops the audio LEAVING the
   device, which is the promise the button is making. The server's is what
   holds if this is ever bypassed, and covers frames already in flight when
   the button was tapped.                                                   */
let uplinkMuted = false;

export function setVoiceUplinkMuted(on: boolean): void {
  uplinkMuted = on;
}

export function isVoiceUplinkMuted(): boolean {
  return uplinkMuted;
}

/* ── The floor, mirrored (always-on, slice 1) ─────────────────────────────
   The gateway owns the open-floor / standby state (src/voice/floor.ts) and
   tells the app on every change (`voice-floor`, and the resume snapshot). On
   STANDBY the uplink is gated by the ear (ear.ts): only speech, its pre-roll,
   its tail and a closing pad of digital silence leave the device; the rest
   is held and counted. On an open floor every frame goes, as before.

   Mute still wins over everything: a muted mic sends nothing in any state. */
export type FloorState = "open" | "standby";

let floor: FloorState = "open";
let ear: Ear | null = null;
let lastEarReportAt = 0;
const EAR_REPORT_EVERY_MS = 60_000;

export function setVoiceFloor(state: FloorState): void {
  if (state === floor) return;
  if (state === "open" && ear) reportEar("floor-open");
  floor = state;
  if (state === "standby") {
    ear ??= new Ear();
    ear.reset();
  } else {
    ear?.reset();
  }
}

export function voiceFloor(): FloorState {
  return floor;
}

/** The ear's counts, for the call's record and the gateway log. */
export function earCounts(): ReturnType<typeof earSeconds> & { utterances: number } {
  const c = ear?.counts ?? { sentFrames: 0, padFrames: 0, heldFrames: 0, utterances: 0 };
  return { ...earSeconds(c), utterances: c.utterances };
}

/** One content-free line into the gateway log: what standby held and what it let through. */
export function reportEar(why: string): void {
  if (!ear) return;
  lastEarReportAt = Date.now();
  report("ear", { why, ...earCounts() });
}

/** A new call: the floor is open and the ear's counts start from zero. */
export function resetVoiceFloor(): void {
  floor = "open";
  ear = null;
  lastEarReportAt = 0;
}

export function sendVoiceFrame(data: ArrayBuffer): void {
  if (uplinkMuted) return;
  if (floor === "open" || !ear) {
    activeWs?.sendBinary(data);
    return;
  }
  const d = ear.feed(data);
  // The pad of digital silence at the end is what lets the recognizer's own
  // turn detection close the utterance; no control frame is needed.
  for (const frame of d.send) activeWs?.sendBinary(frame);
  const now = Date.now();
  if (now - lastEarReportAt >= EAR_REPORT_EVERY_MS) reportEar("standby");
}
