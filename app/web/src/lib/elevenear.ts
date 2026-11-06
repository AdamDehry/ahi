import type { Conversation } from "@elevenlabs/client";
import { sendVoiceControl, sendVoiceFrame } from "./voicebus";

/* ============================================================
   elevenear.ts — his words on screen as he says them, on an ElevenLabs call.

   ElevenLabs gives us his transcript only once a turn is final. The native
   call painted it live, and the owner wants that back ("I have no feedback that
   I'm saying anything", 10/22). So the app taps the microphone the SDK
   already opened — its own track, echo-cancelled, the exact audio ElevenLabs
   hears; no second getUserMedia (on iOS a second capture can silence the
   first) — and streams it to the gateway's own recognizer through the same
   worklet and the same socket the native call uses. The gateway answers with
   `stt-interim` lines (src/voice/eleven/side.ts).

   Display only. ElevenLabs still owns the turn: its final replaces the
   interim line and is what Michael answers and the thread keeps. Mute stops
   the frames on the device (voicebus's uplink gate) and on the gateway. The
   tap stops when the call ends, and the gateway stops its side too.

   The phone (10/23): the ear announced itself and then sent nothing, ever
   (0 frames, desktop 18,005). Its AudioContext was built seconds after the
   tap, from a callback, with a fire-and-forget resume — iOS keeps such a
   context suspended, so the worklet is never pulled. Now:
     · the context is born IN the call tap (`primeElevenEar`, beside the
       voice priming) and the ear adopts it; its resume is awaited, and it is
       resumed again whenever iOS suspends or interrupts it mid-call;
     · the ear waits for its first frame before announcing, and a worklet
       that yields nothing (or will not load) gives way to a
       ScriptProcessorNode — deprecated, but it runs everywhere — instead of
       going silent; frames that came first are held and sent after;
     · the announce carries how it started (`ctx`: state, rate, path, first
       frame), so the gateway log tells a phone from a desktop.
   ============================================================ */

/** How long the worklet module may take to load before the fallback. */
const ADD_MODULE_MS = 4_000;
/** How long a worklet gets to produce its first frame before the fallback. */
const FIRST_FRAME_MS = 2_500;
/** How long the fallback gets before the ear announces anyway (never fed). */
const FALLBACK_FRAME_MS = 2_500;
/** How long a resume may take before we go on without it. */
const RESUME_WAIT_MS = 1_500;
/** A context primed by a tap that no call adopted is closed after this. */
const PRIMED_TTL_MS = 30_000;
/** Frames held until the announce (5 s of 100 ms frames; the gateway holds as many). */
const HELD_MAX = 50;
const FRAME_16K = 1600; // 100 ms at 16 kHz

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** I/O seam (tests): the control and frame senders. */
let io = { control: sendVoiceControl, frame: sendVoiceFrame };
export function __setEarIoForTests(t: { control: typeof sendVoiceControl; frame: typeof sendVoiceFrame } | null): void {
  io = t ?? { control: sendVoiceControl, frame: sendVoiceFrame };
}

/* ── The tap ─────────────────────────────────────────────────────────── */

let primed: { ctx: AudioContext; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Run INSIDE the call tap: open (and resume) the context the ear will use, so
 * iOS lets it run. Unused by a native call; closed after PRIMED_TTL_MS if no
 * ElevenLabs call adopts it.
 */
export function primeElevenEar(): void {
  const ttl = (ctx: AudioContext): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      if (primed?.ctx === ctx) primed = null;
      void ctx.close().catch(() => {});
    }, PRIMED_TTL_MS);
  if (primed && primed.ctx.state !== "closed") {
    // A second tap keeps the context and restarts its clock, so it cannot
    // close under the call this tap starts.
    clearTimeout(primed.timer);
    primed.timer = ttl(primed.ctx);
    void primed.ctx.resume().catch(() => {});
    return;
  }
  try {
    const ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    primed = { ctx, timer: ttl(ctx) };
  } catch {
    primed = null; // the ear builds its own
  }
}

function takePrimed(): AudioContext | null {
  const p = primed;
  primed = null;
  if (!p) return null;
  clearTimeout(p.timer);
  return p.ctx.state === "closed" ? null : p.ctx;
}

/* ── The track ───────────────────────────────────────────────────────── */

/** The SDK's microphone track (LiveKit's local publication), or null. */
function micTrack(conv: Conversation): MediaStreamTrack | null {
  try {
    // Not public API: the WebRTC connection's LiveKit room. Read-only use.
    const room = (conv as unknown as { connection?: { room?: { localParticipant?: { getTrackPublication?: (s: string) => { track?: { mediaStreamTrack?: MediaStreamTrack } } | undefined } } } })
      .connection?.room;
    const track = room?.localParticipant?.getTrackPublication?.("microphone")?.track?.mediaStreamTrack ?? null;
    return track && track.readyState === "live" ? track : null;
  } catch {
    return null;
  }
}

/* ── The paths ───────────────────────────────────────────────────────── */

type EarPath = "worklet" | "script";

interface Tap {
  path: EarPath;
  close(): void;
}

/** What the worklet tells us besides frames: it ran, or it ran with no input. */
interface TapNotes {
  alive: boolean;
  noInput: boolean;
}

async function workletTap(ctx: AudioContext, source: AudioNode, onFrame: (pcm: ArrayBuffer) => void, notes: TapNotes): Promise<Tap> {
  // A load that never settles would hold the ear forever; bounded, it is one
  // more way to the script processor. A late settle is harmless:
  // no node was made from it.
  await Promise.race([
    ctx.audioWorklet.addModule("/mic-worklet.js"),
    wait(ADD_MODULE_MS).then(() => Promise.reject(new Error(`worklet module not loaded in ${ADD_MODULE_MS} ms`))),
  ]);
  const node = new AudioWorkletNode(ctx, "mic-capture");
  node.port.onmessage = (e: MessageEvent<{ pcm?: ArrayBuffer; alive?: boolean; noInput?: boolean }>) => {
    if (e.data?.pcm) onFrame(e.data.pcm);
    else if (e.data?.alive) notes.alive = true;
    else if (e.data?.noInput) notes.noInput = true;
  };
  source.connect(node);
  // Pulled by the graph, never heard: a silent sink, not the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  return {
    path: "worklet",
    close() {
      node.port.onmessage = null;
      try {
        source.disconnect(node);
        node.disconnect();
        sink.disconnect();
      } catch {
        /* already torn down */
      }
    },
  };
}

/**
 * The context's rate down to 16 kHz s16le mono, in 100 ms frames — the
 * worklet's averaging decimator (web/public/mic-worklet.js), on the main
 * thread for the ScriptProcessorNode path. Exported for tests.
 */
export function makeDownsampler(rate: number, onFrame: (pcm: ArrayBuffer) => void): (ch: Float32Array) => void {
  const ratio = rate / 16000;
  let phase = 0;
  let acc = new Float32Array(FRAME_16K);
  let n = 0;
  return (ch) => {
    for (let i = 0; i < ch.length; i++) {
      phase += 1;
      if (phase < ratio) continue;
      phase -= ratio;
      const j = Math.max(0, i - Math.floor(ratio) + 1);
      let sum = 0;
      for (let k = j; k <= i; k++) sum += ch[k];
      acc[n++] = sum / (i - j + 1);
      if (n === FRAME_16K) {
        const pcm = new Int16Array(FRAME_16K);
        for (let x = 0; x < FRAME_16K; x++) pcm[x] = Math.max(-1, Math.min(1, acc[x])) * 0x7fff;
        onFrame(pcm.buffer);
        acc = new Float32Array(FRAME_16K);
        n = 0;
      }
    }
  };
}

function scriptTap(ctx: AudioContext, source: AudioNode, onFrame: (pcm: ArrayBuffer) => void): Tap {
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const feed = makeDownsampler(ctx.sampleRate, onFrame);
  node.onaudioprocess = (e: AudioProcessingEvent) => {
    feed(e.inputBuffer.getChannelData(0));
    // Its output is the speakers' path: keep it silent.
    e.outputBuffer.getChannelData(0).fill(0);
  };
  source.connect(node);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  return {
    path: "script",
    close() {
      node.onaudioprocess = null;
      try {
        source.disconnect(node);
        node.disconnect();
        sink.disconnect();
      } catch {
        /* already torn down */
      }
    },
  };
}

/* ── The ear ─────────────────────────────────────────────────────────── */

export interface ElevenEar {
  stop(): void;
}

/** How the ear started: one field on `eleven-ear-start`, one console line. */
export interface EarStart {
  state: string;
  rate: number;
  path: EarPath;
  /** ms from the tap to the first frame; null = none came before the announce. */
  firstFrameMs: number | null;
  /** Born in the call tap (true) or built late (false). */
  primed: boolean;
  /** The worklet ran but its input had no channel (the track gave nothing). */
  noInput?: boolean;
  /** The track was muted by the device when the ear started. */
  trackMuted?: boolean;
  /** Why the fallback was taken, if it was. */
  why?: string;
}

/** Resume, awaited, but never longer than `ms`; true if it is running. */
async function resumeWithin(ctx: AudioContext, ms: number): Promise<boolean> {
  if (ctx.state === "running") return true;
  await Promise.race([ctx.resume().catch(() => {}), wait(ms)]);
  return (ctx.state as string) === "running";
}

/** Resolves when `has()` turns true, or after `ms`. */
async function until(has: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!has() && Date.now() < end) await wait(50);
  return has();
}

/**
 * Start the side ear for this call. Resolves to a handle (stop()), or null
 * when the SDK's track could not be tapped — the call goes on without live
 * words, and says so in the console.
 */
export async function startElevenEar(conv: Conversation, bot: string, voiceStreamId: string): Promise<ElevenEar | null> {
  const track = micTrack(conv);
  if (!track) {
    console.warn("[eleven-ear] no microphone track to tap — live words off for this call");
    takePrimed()?.close().catch(() => {});
    return null;
  }
  const t0 = Date.now();
  let ctx: AudioContext | null = null;
  let tap: Tap | null = null;
  let stopped = false;
  let announced = false;
  let firstFrameAt = 0;
  const held: ArrayBuffer[] = [];
  const onFrame = (pcm: ArrayBuffer): void => {
    if (stopped) return;
    if (!firstFrameAt) {
      firstFrameAt = Date.now();
      console.info(`[eleven-ear] first frame after ${firstFrameAt - t0} ms (${tap?.path ?? "?"})`);
    }
    if (announced) io.frame(pcm);
    else if (held.length < HELD_MAX) held.push(pcm);
  };
  try {
    const adopted = takePrimed();
    ctx = adopted ?? new AudioContext();
    const c = ctx;
    // iOS suspends ("interrupted") a running context when the audio session
    // changes under it — the SDK opening the mic does exactly that. Resume.
    c.onstatechange = () => {
      if (!stopped && c.state !== "running" && c.state !== "closed") void c.resume().catch(() => {});
    };
    const running = await resumeWithin(c, RESUME_WAIT_MS);
    if (!running) console.warn(`[eleven-ear] context still ${c.state} after resume — trying anyway`);
    const source = c.createMediaStreamSource(new MediaStream([track]));
    const notes: TapNotes = { alive: false, noInput: false };
    let why: string | undefined;
    try {
      tap = await workletTap(c, source, onFrame, notes);
      if (!(await until(() => firstFrameAt > 0 || stopped, FIRST_FRAME_MS)) && !stopped) {
        why = notes.noInput ? "worklet-no-input" : notes.alive ? "worklet-no-frames" : "worklet-never-ran";
        tap.close();
        tap = null;
      }
    } catch (err) {
      why = "worklet-failed";
      console.warn(`[eleven-ear] worklet would not load: ${(err as Error)?.message ?? err}`);
      tap?.close();
      tap = null;
    }
    if (!tap && !stopped) {
      console.warn(`[eleven-ear] worklet gave nothing (${why}) — falling back to the script processor`);
      if (c.state !== "running") void c.resume().catch(() => {});
      tap = scriptTap(c, source, onFrame);
      await until(() => firstFrameAt > 0 || stopped, FALLBACK_FRAME_MS);
    }
    if (stopped) return null;
    const start: EarStart = {
      state: c.state,
      rate: c.sampleRate,
      path: tap!.path,
      firstFrameMs: firstFrameAt ? firstFrameAt - t0 : null,
      primed: !!adopted,
      ...(notes.noInput ? { noInput: true } : {}),
      ...(track.muted ? { trackMuted: true } : {}),
      ...(why ? { why } : {}),
    };
    // Announce, then what came before it, in order: the gateway has an ear to feed.
    io.control({ type: "eleven-ear-start", bot, voiceStreamId, ctx: start });
    announced = true;
    for (const f of held.splice(0)) io.frame(f);
    console.info(
      `[eleven-ear] listening for live words: ${start.path}, ${start.rate} Hz, ${start.state}, ${start.primed ? "primed in the tap" : "built late"}, first frame ${start.firstFrameMs === null ? "none yet" : `${start.firstFrameMs} ms`}`,
    );
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        tap?.close();
        c.onstatechange = null;
        void c.close().catch(() => {});
        io.control({ type: "eleven-ear-stop", voiceStreamId });
      },
    };
  } catch (err) {
    console.warn(`[eleven-ear] could not start: ${(err as Error)?.message ?? err} — live words off for this call`);
    tap?.close();
    if (ctx) ctx.onstatechange = null;
    void ctx?.close().catch(() => {});
    return null;
  }
}
