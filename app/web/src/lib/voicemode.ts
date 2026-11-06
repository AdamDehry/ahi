import {
  beginVoiceStream,
  duckAgentAudio,
  isAgentAudible,
  isVoiceUplinkMuted,
  onVoiceEvent,
  reportMicStartError,
  sendVoiceControl,
  takeVoiceDoorReport,
  dispatchVoiceEvent,
  sendVoiceFrame,
  stopAgentAudio,
  voiceCutPosition,
} from "./voicebus";
import { DUCK_GAIN, DUCK_HOLD_MS } from "./barge";
import { audioSessionType, claimCaptureSession, releaseCaptureSession } from "./audiosession";

/* ============================================================
   voicemode.ts — the client half of the voice turn loop.

   Ported from the simulator's proven audio path, which the merge brief
   pins: raw PCM streamed into Web Audio. There is NO container format
   anywhere in voice mode — no OGG, no WebM. `mic-worklet.js` (shipped
   verbatim from the sim) downsamples the context rate to 16kHz s16le mono
   and posts 100ms frames; those go straight out as WS binary.

   This is deliberately NOT the Recorder. Recorder captures a one-way voice
   NOTE and asks for raw media capture with echoCancellation OFF, because a
   note needs no call-oriented processing and Android would otherwise drop
   the whole phone into VOICE_COMMUNICATION mode. Voice mode is the opposite
   case: the agent is speaking out loud while the mic is open, so
   echoCancellation is REQUIRED or the agent's own voice barges in on itself.

   That difference is exactly what the owner's post-merge device test covers —
   barge-in with open speakers on the S25, where browser-level echo
   cancellation is unproven on his hardware.
   ============================================================ */

export type VoicePhase = "idle" | "connecting" | "listening" | "denied";

interface VoiceModeSession {
  bot: string;
  voiceStreamId: string;
  stream: MediaStream;
  ctx: AudioContext;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
}

let active: VoiceModeSession | null = null;

/* ── Barge-in, client fast path (ported from the sim, proven live) ────────
   Energy on the mic WHILE the agent is audible means the user has started
   talking over the reply. The sim's constants come across unchanged: two
   consecutive frames above 0.02 RMS. Frames are 100ms, so this is ~200ms of
   sustained speech — long enough that a cough or a door does not cut the
   agent off, short enough to feel immediate.

   The threshold assumes the browser's echo cancellation is keeping the
   agent's own voice out of the mic. That holds on the hardware the sim ran
   on; on the S25 with open speakers it is unproven, and it is exactly what
   the owner's device test has to settle. If it fails there, this counter is what
   would trip on the agent's own voice — so it is the first thing to look at,
   and BARGE_RMS is the knob.                                             */
const BARGE_RMS = 0.02;
const BARGE_FRAMES = 2;

let bargeHot = 0;
let unduckTimer = 0;

/**
 * Energy on the mic while the agent is audible. Part seven:
 * energy alone no longer CUTS the reply — background noise and our own echo
 * were stopping replies the owner never talked over. It DUCKS the reply instead
 * (instant feedback, nothing lost) and the reply comes back up after
 * DUCK_HOLD_MS unless the recognizer confirms real words, which is what cuts
 * (voicelayer.ts, on `stt-interim`, via barge.ts).
 */
function detectBargeIn(rms: number): void {
  // A muted mic must not barge: frames are already dropped at the send
  // chokepoint, but detection is local — without this gate, room noise
  // while muted would still cut the agent's reply (R2 review finding).
  if (isVoiceUplinkMuted() || !isAgentAudible()) {
    bargeHot = 0;
    return;
  }
  bargeHot = rms > BARGE_RMS ? bargeHot + 1 : 0;
  if (bargeHot < BARGE_FRAMES) return;
  bargeHot = 0;
  duckAgentAudio(true, DUCK_GAIN);
  window.clearTimeout(unduckTimer);
  unduckTimer = window.setTimeout(() => duckAgentAudio(false), DUCK_HOLD_MS);
}

/**
 * A confirmed barge-in (real words over the reply): cut locally FIRST, so
 * he stops hearing the agent now, then tell the gateway to abort.
 */
export function bargeIn(): void {
  window.clearTimeout(unduckTimer);
  stopAgentAudio("barge-in");
  // How far he got, stamped at the cut: the gateway keeps only that much of
  // the reply in the record and tells the model (voice-streaming-bargein).
  interruptVoiceMode(voiceCutPosition());
}

/* ── The iPhone feasibility gate (voice step 2, design item 7) ───────────
   No server design keeps a PWA's mic alive on a locked or backgrounded
   iPhone; whether iOS does is a fact to MEASURE on the owner's phone, not to
   assume. So the call logs every lifecycle edge that decides it, as the
   numbers-and-tokens `voice-client-event` lines the gateway already keeps:
   the page hidden/shown/frozen (pagehide's `persisted` = kept in memory),
   the mic track muted/unmuted/ended by the OS (an incoming cellular call
   mutes it; a kill ends it), and the capture context's state (WebKit's
   `interrupted`). Read beside the gateway's door and resume lines, one test
   call answers the gate: does the mic come back after a lock, a background,
   a cellular call — and how long is the gap. Listeners only: nothing here
   changes what the call does.                                              */
function tellLifecycle(session: VoiceModeSession, event: string, fields: Record<string, unknown>): void {
  if (active !== session) return;
  sendVoiceControl({ type: "voice-client-event", event, ...fields });
}

/** The mic track's own edges, for whichever stream the call is capturing from now. */
function watchMicTracks(session: VoiceModeSession): void {
  const tell = (event: string, fields: Record<string, unknown>) => {
    if (session.stream !== stream) return; // a track from before a re-open
    tellLifecycle(session, event, fields);
  };
  const stream = session.stream;
  for (const track of stream.getAudioTracks?.() ?? []) {
    if (typeof track.addEventListener !== "function") continue;
    track.addEventListener("mute", () => tell("mic-track", { state: "muted" }));
    track.addEventListener("unmute", () => tell("mic-track", { state: "unmuted" }));
    track.addEventListener("ended", () => {
      tell("mic-track", { state: "ended" });
      // Killed while he is looking at the call: bring it back now. Otherwise on his return.
      if (session.stream === stream && pageVisible()) void checkCallMic("track-ended");
    });
  }
}

const pageVisible = (): boolean => (globalThis.document as Document | undefined)?.visibilityState !== "hidden";

function watchCallLifecycle(session: VoiceModeSession): void {
  const tell = (event: string, fields: Record<string, unknown>) => tellLifecycle(session, event, fields);
  watchMicTracks(session);
  const ctx = session.ctx as AudioContext & { addEventListener?: AudioContext["addEventListener"] };
  if (typeof ctx.addEventListener === "function") {
    ctx.addEventListener("statechange", () => tell("mic-ctx", { state: String(ctx.state) }));
  }
  const win = globalThis.window as Window | undefined;
  const doc = globalThis.document as Document | undefined;
  if (!win || typeof win.addEventListener !== "function") return;
  // Voice step 3: every way back to the page also checks the mic (checkCallMic).
  const back = (why: string) => {
    if (active === session && pageVisible()) void checkCallMic(why);
  };
  const onHide = (e: PageTransitionEvent) => tell("page", { state: "hide", persisted: e.persisted === true });
  const onShow = (e: PageTransitionEvent) => {
    tell("page", { state: "show", persisted: e.persisted === true });
    back("page-show");
  };
  const onFreeze = () => tell("page", { state: "freeze" });
  const onResume = () => {
    tell("page", { state: "resume" });
    back("page-resume");
  };
  const onOnline = () => {
    tell("network", { state: "online" });
    back("online");
  };
  const onOffline = () => tell("network", { state: "offline" });
  const onVisibility = () => {
    if (pageVisible()) back("visible");
  };
  win.addEventListener("pagehide", onHide);
  win.addEventListener("pageshow", onShow);
  win.addEventListener("online", onOnline);
  win.addEventListener("offline", onOffline);
  doc?.addEventListener?.("freeze", onFreeze);
  doc?.addEventListener?.("resume", onResume);
  doc?.addEventListener?.("visibilitychange", onVisibility);
  lifecycleCleanup = () => {
    win.removeEventListener("pagehide", onHide);
    win.removeEventListener("pageshow", onShow);
    win.removeEventListener("online", onOnline);
    win.removeEventListener("offline", onOffline);
    doc?.removeEventListener?.("freeze", onFreeze);
    doc?.removeEventListener?.("resume", onResume);
    doc?.removeEventListener?.("visibilitychange", onVisibility);
  };
}

/* ── The mic comes back on its own (voice step 3, the iPhone gate's answer) ──
   iOS takes the mic on a lock, a cellular call or Siri: the track ENDS, or it
   stays MUTED after he is back (a known WebKit behaviour after an
   interruption), and the capture context is suspended or interrupted. The
   call then looks alive and hears nothing. On every way back to the page —
   visible, shown, resumed, back online — and on a track that ends while he is
   looking, the call checks its mic: a stopped context is resumed; a dead or
   still-muted track is replaced by a fresh capture, wired into the same
   worklet, so the call — its id, its socket, its turn in flight — never
   changes. Each attempt is one `mic-reopen` line in the gateway log (why,
   and ok / failed / gave-up), so his test call shows what iOS did and what
   the app did about it. Bounded: MIC_REOPEN_MAX per call. If it cannot come
   back, the call says so on screen rather than listen to nothing.          */
export const MIC_MUTED_GRACE_MS = 1_500;
export const MIC_REOPEN_MAX = 5;
let micCheck: Promise<string> | null = null;
let micReopens = 0;

/** The call's mic, as iOS left it: live, still muted by the OS, or gone. */
export function callMicState(session: Pick<VoiceModeSession, "stream">): "ok" | "muted" | "ended" {
  const tracks = session.stream.getAudioTracks?.() ?? session.stream.getTracks?.() ?? [];
  if (!tracks.length || tracks.every((t) => t.readyState === "ended")) return "ended";
  if (tracks.every((t) => t.muted === true)) return "muted";
  return "ok";
}

/**
 * Bring the call's mic back if iOS took it. One check at a time. Resolves
 * with what it did: "none" (no call), "ok", "resumed" (the context only),
 * "reopened", "failed", "gave-up".
 */
export function checkCallMic(why: string): Promise<string> {
  if (!active) return Promise.resolve("none");
  micCheck ??= runMicCheck(active, why).finally(() => {
    micCheck = null;
  });
  return micCheck;
}

async function runMicCheck(session: VoiceModeSession, why: string): Promise<string> {
  let did = "ok";
  if (session.ctx.state !== "running" && session.ctx.state !== "closed") {
    try {
      await session.ctx.resume();
    } catch {
      /* checked just below */
    }
    // A resume that failed, or left the context interrupted, is not a working
    // mic however live the track looks (Codex, step 3): say so, and the next
    // return tries again.
    if ((session.ctx.state as string) !== "running") {
      tellLifecycle(session, "mic-reopen", { why, state: "ctx-stuck", ctx: String(session.ctx.state).slice(0, 24) });
      return "failed";
    }
    did = "resumed";
  }
  let state = callMicState(session);
  if (state === "muted") {
    // Coming back from a cellular call the track unmutes by itself, usually at once.
    await new Promise((r) => (globalThis.window ?? globalThis).setTimeout(r, MIC_MUTED_GRACE_MS));
    if (active !== session) return "none";
    state = callMicState(session);
  }
  if (state === "ok") {
    if (did === "resumed") tellLifecycle(session, "mic-reopen", { why, state: "ctx-resumed" });
    return did;
  }
  if (micReopens >= MIC_REOPEN_MAX) {
    tellLifecycle(session, "mic-reopen", { why, state: "gave-up", mic: state });
    // The call screen says it cannot hear (its "lost" hearing state) instead of listening to nothing.
    dispatchVoiceEvent({ type: "stt-health", state: "lost", error: "The microphone did not come back." });
    return "gave-up";
  }
  micReopens++;
  claimCaptureSession(SESSION_OWNER);
  const opened = await openCallMic((c) => navigator.mediaDevices.getUserMedia(c));
  if (active !== session) {
    if (opened.ok) opened.stream.getTracks().forEach((t) => t.stop());
    return "none";
  }
  if (!opened.ok) {
    tellLifecycle(session, "mic-reopen", { why, state: "failed", mic: state, error: errName(opened.err).toLowerCase().slice(0, 24) });
    return "failed";
  }
  try {
    session.source.disconnect();
  } catch {
    /* already gone with the old track */
  }
  session.stream.getTracks().forEach((t) => t.stop());
  const source = session.ctx.createMediaStreamSource(opened.stream);
  source.connect(session.node);
  session.stream = opened.stream;
  session.source = source;
  watchMicTracks(session);
  if ((session.ctx.state as string) === "suspended") void session.ctx.resume().catch(() => {});
  tellLifecycle(session, "mic-reopen", { why, state: "ok", mic: state, n: micReopens });
  return "reopened";
}

let lifecycleCleanup: (() => void) | null = null;

export function isVoiceModeActive(): boolean {
  return active !== null;
}

/**
 * The socket came back while a call is live (always-on, slice 1): claim the
 * same call by id. The gateway parks a call for a grace window after its
 * socket closes and hands it to the socket that names it; `resume: true`
 * tells it a refusal must be a refusal, not a new call.
 */
export function resumeVoiceMode(): boolean {
  if (!active) return false;
  // How far the reply on air had played, and whether its audio survived the
  // gap (voicebus.ts): the gateway re-says from the sentence start if not.
  const played = takeVoiceDoorReport();
  sendVoiceControl({ type: "voice-start", bot: active.bot, voiceStreamId: active.voiceStreamId, resume: true, ...(played ? { played } : {}) });
  return true;
}

export function activeVoiceStreamId(): string | null {
  return active?.voiceStreamId ?? null;
}

/* ── Opening the mic, and telling a refusal from a failure ───────────────
   "MICROPHONE BLOCKED" tells someone to go dig through Settings. It is only
   true for a real refusal, so it is only shown for one. Everything else is
   retried once on the plainest request there is (`audio: true`), and if
   that fails too the call says it FAILED, names the error, and the gateway
   logs it — a family member's iPhone showed BLOCKED for weeks on a mic it had
   permission for, because every error was mapped to "denied".             */

/** The call's own constraints. echoCancellation is the load-bearing one — see the header. */
export const CALL_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

const SESSION_OWNER = "voice-call";

export type MicPermission = "granted" | "denied" | "prompt" | "unknown";
export type MicErrorKind = "denied" | "retry";

export interface VoiceStartError {
  name: string;
  message: string;
  stage: "mic" | "audio";
}

let lastStartError: VoiceStartError | null = null;

/** Why the last start failed, for the CALL FAILED card. Null after a good start. */
export function voiceStartError(): VoiceStartError | null {
  return lastStartError;
}

function errName(err: unknown): string {
  const n = (err as { name?: unknown } | null)?.name;
  return typeof n === "string" && n ? n : "Error";
}

function errMessage(err: unknown): string {
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(err);
}

/**
 * A refusal or not. Only NotAllowedError / SecurityError (and Chrome's old
 * PermissionDeniedError) can mean the user said no — and even those do not
 * when the browser says the permission is GRANTED: iOS rejects with
 * NotAllowedError when its audio session has no input device (WebKit bug
 * 319706, and the "playback" override described in audiosession.ts).
 */
export function classifyMicError(err: unknown, permission: MicPermission): MicErrorKind {
  const name = errName(err);
  const refusal = name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError";
  if (!refusal) return "retry";
  return permission === "granted" ? "retry" : "denied";
}

async function micPermission(): Promise<MicPermission> {
  try {
    const perms = (globalThis.navigator as Navigator | undefined)?.permissions;
    if (!perms?.query) return "unknown";
    const st = await perms.query({ name: "microphone" as PermissionName });
    return st.state === "granted" || st.state === "denied" || st.state === "prompt" ? st.state : "unknown";
  } catch {
    return "unknown"; // older Safari: "microphone" is not a queryable name
  }
}

type OpenMic =
  | { ok: true; stream: MediaStream; retried: boolean }
  | { ok: false; denied: boolean; retried: boolean; err: unknown; permission: MicPermission };

/** getUserMedia with the call's constraints, then once more with `audio: true`. */
export async function openCallMic(gum: (c: MediaStreamConstraints) => Promise<MediaStream>): Promise<OpenMic> {
  try {
    return { ok: true, stream: await gum({ audio: CALL_AUDIO_CONSTRAINTS }), retried: false };
  } catch (first) {
    const permission = await micPermission();
    if (classifyMicError(first, permission) === "denied") return { ok: false, denied: true, retried: false, err: first, permission };
    console.warn(`[voicemode] mic failed (${errName(first)}: ${errMessage(first)}); retrying with audio:true`);
    try {
      return { ok: true, stream: await gum({ audio: true }), retried: true };
    } catch (second) {
      const p2 = await micPermission();
      return { ok: false, denied: classifyMicError(second, p2) === "denied", retried: true, err: second, permission: p2 };
    }
  }
}

/* ── The tap ───────────────────────────────────────────────────────────
   iOS only lets audio START inside a user gesture (or once the page is
   capturing). The call used to build both of its audio contexts after an
   await, from an effect, nowhere near the tap. `primeVoiceAudio` runs IN
   the tap: it claims the audio session for capture before anything asks
   for the mic, opens the reply's playback context, and opens + resumes the
   mic's context, which `startVoiceMode` then adopts.                     */
let primedCtx: AudioContext | null = null;

export function primeVoiceAudio(): void {
  claimCaptureSession(SESSION_OWNER);
  beginVoiceStream();
  if (primedCtx && primedCtx.state !== "closed") {
    void primedCtx.resume().catch(() => {});
    return;
  }
  try {
    primedCtx = new AudioContext();
    void primedCtx.resume().catch(() => {});
  } catch {
    primedCtx = null; // startVoiceMode builds its own
  }
}

function takePrimedCtx(): AudioContext {
  const ctx = primedCtx && primedCtx.state !== "closed" ? primedCtx : new AudioContext();
  primedCtx = null;
  return ctx;
}

function dropPrimedCtx(): void {
  const ctx = primedCtx;
  primedCtx = null;
  if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
}

function failStart(err: unknown, stage: VoiceStartError["stage"], fields: { permission: MicPermission; retried: boolean }): void {
  lastStartError = { name: errName(err), message: errMessage(err), stage };
  reportMicStartError({
    errName: lastStartError.name,
    stage,
    permission: fields.permission,
    retried: fields.retried,
    audioSession: audioSessionType() ?? "none",
    standalone: Boolean((globalThis.navigator as { standalone?: boolean } | undefined)?.standalone),
  });
}

/**
 * Open the mic and start streaming to the gateway.
 *
 * One session at a time; calling this while active is a no-op so a double
 * tap cannot open two recognizers (and pay for two).
 *
 * "denied" = a real refusal (MICROPHONE BLOCKED); "idle" = the call could
 * not start for any other reason, with the cause in `voiceStartError()`.
 */
export async function startVoiceMode(bot: string): Promise<VoicePhase> {
  if (active) return "listening";
  lastStartError = null;

  // Before getUserMedia, always — on iOS a capture opened under the
  // "playback" declaration has no input device (audiosession.ts). The tap
  // already did this via primeVoiceAudio; this covers any other caller.
  claimCaptureSession(SESSION_OWNER);

  const opened = await openCallMic((c) => navigator.mediaDevices.getUserMedia(c));
  if (!opened.ok) {
    failStart(opened.err, "mic", { permission: opened.permission, retried: opened.retried });
    releaseCaptureSession(SESSION_OWNER);
    dropPrimedCtx();
    return opened.denied ? "denied" : "idle";
  }
  const stream = opened.stream;

  const voiceStreamId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const ctx = takePrimedCtx();
    // Created after an await, a context starts suspended on iOS and the
    // worklet is never pulled: an open mic that sends nothing. The page is
    // capturing now, which WebKit counts as permission to start audio.
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule("/mic-worklet.js");
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "mic-capture");

    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      const pcm = e.data?.pcm;
      if (pcm) sendVoiceFrame(pcm);
      detectBargeIn(e.data?.rms ?? 0);
    };
    source.connect(node);
    // The worklet emits nothing downstream; it must still be pulled by the
    // graph, so terminate it at a silent gain rather than the destination
    // (connecting to the destination would echo the mic into the speakers).
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);

    // Announce BEFORE audio can arrive so the gateway has a session to feed;
    // frames that beat the upstream STT socket are queued server-side.
    sendVoiceControl({ type: "voice-start", bot, voiceStreamId });

    active = { bot, voiceStreamId, stream, ctx, node, source };
    micReopens = 0;
    watchCallLifecycle(active);
    return "listening";
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    releaseCaptureSession(SESSION_OWNER);
    dropPrimedCtx();
    console.warn("[voicemode] failed to start:", errMessage(err));
    failStart(err, "audio", { permission: "granted", retried: opened.retried });
    return "idle";
  }
}

/**
 * How long to let a buffered thought commit after the user taps stop.
 *
 * Sized to the composer's longest ordinary hold (incompleteHoldMs, 1500ms)
 * plus a margin for the commit to travel back. NOT sized to maxHoldMs — a
 * thought that has been held for seven seconds is not what someone who just
 * tapped stop is waiting on.
 */
const COMMIT_GRACE_MS = 2000;

/**
 * Wait for the server to either commit the buffered thought (`stt-final`) or
 * tell us there was nothing (`voice-empty`) — whichever lands first, bounded.
 */
function waitForCommit(voiceStreamId: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      off();
      window.clearTimeout(timer);
      resolve();
    };
    const off = onVoiceEvent((ev) => {
      if (ev.voiceStreamId && ev.voiceStreamId !== voiceStreamId) return;
      if (ev.type === "stt-final" || ev.type === "voice-empty") finish();
    });
    const timer = window.setTimeout(finish, COMMIT_GRACE_MS);
  });
}

/**
 * Close the mic and end the session.
 *
 * `reason` is a short token the gateway writes into its one `[call-end]`
 * line (websocket.ts: end-button, stall, screen-closed…). It is the only
 * way the server learns WHY the app hung up — a call that just vanished
 * from the log is what made an earlier drop a guess instead of a reading.
 */
export async function stopVoiceMode(reason = "unspecified"): Promise<void> {
  const session = active;
  active = null;
  bargeHot = 0;
  lifecycleCleanup?.();
  lifecycleCleanup = null;
  if (!session) {
    // A tap that primed audio but never got a call (the layer closed
    // first) must not leave the phone declared for capture.
    if (primedCtx) {
      dropPrimedCtx();
      releaseCaptureSession(SESSION_OWNER);
    }
    return;
  }

  // Close the utterance, but do NOT cancel in the same breath.
  //
  // `voice-end` is an utterance boundary; on a native-turn provider it
  // deliberately does not commit, because the composer's hold is still
  // deciding whether the thought is finished. Cancelling immediately after
  // therefore threw away anything inside that hold — tap stop right after
  // speaking and your last sentence vanished. Give the commit a bounded
  // moment to land first. The mic is released below regardless, so nothing
  // is still being captured while we wait; the server already has the audio.
  sendVoiceControl({ type: "voice-end", bot: session.bot, voiceStreamId: session.voiceStreamId });
  const committed = waitForCommit(session.voiceStreamId);

  try {
    session.node.port.onmessage = null;
    session.node.disconnect();
    session.source.disconnect();
  } catch {
    /* graph already torn down */
  }
  session.stream.getTracks().forEach((t) => t.stop());
  releaseCaptureSession(SESSION_OWNER);
  try {
    await session.ctx.close();
  } catch {
    /* context already closed */
  }

  // Now the thought has either landed as a turn or provably wasn't one, so
  // tearing the session down can no longer lose it. Cancel (not interrupt) —
  // a turn already dispatched keeps generating and still replies.
  await committed;
  sendVoiceControl({ type: "voice-cancel", bot: session.bot, voiceStreamId: session.voiceStreamId, reason });
}

/**
 * Barge-in: the user started talking over the reply. Tell the gateway to
 * stop generating and stop speaking — it aborts the in-flight turn through
 * the same path the turn gate's supersede uses.
 */
export function interruptVoiceMode(heardSec?: number | null): void {
  if (!active) return;
  sendVoiceControl({
    type: "voice-interrupt",
    bot: active.bot,
    voiceStreamId: active.voiceStreamId,
    ...(typeof heardSec === "number" && Number.isFinite(heardSec) && heardSec >= 0 ? { heardSec: Number(heardSec.toFixed(3)) } : {}),
  });
}
