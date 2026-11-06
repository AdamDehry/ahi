import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  beginVoiceStream,
  endVoiceStream,
  interruptPosition,
  onVoiceEvent,
  probeVoiceLink,
  checkVoiceClock,
  isAgentAudible,
  reportVoiceTurnPlayed,
  resetVoiceTurnAudio,
  sendVoiceControl,
  noteVoiceDoorDown,
  setVoiceUplinkMuted,
  stopAgentAudio,
  voiceAudioWasCut,
  voiceStreamDraining,
  voiceStreamPosition,
  reportEar,
  resetVoiceFloor,
  setVoiceFloor,
  type FloorState,
  type VoiceEvent,
} from "./voicebus";
import {
  appendDisplayText,
  commitDisplayText,
  createKaraokeState,
  ingestWordTimings,
  isDisplayReemission,
  recentSpokenText,
  sanitizeForTranscript,
  setServerTextFollowsVoice,
  truncateAtInterrupt,
  type KaraokeState,
} from "./karaoke";
import {
  activeVoiceStreamId,
  bargeIn,
  primeVoiceAudio,
  resumeVoiceMode,
  startVoiceMode,
  stopVoiceMode,
  voiceStartError,
} from "./voicemode";
import { confirmsBargeIn } from "./barge";
import { canShareScreen, startScreenShare, stopScreenShare } from "./screenshare";
import { uploadStaged } from "./staging";

/* ============================================================
   voicelayer.ts — the voice screen's state machine.

   A call is its OWN mode, not a decoration on the chat: it has its own
   thread, its own lifecycle, and it ends by producing a record. This hook
   owns that lifecycle and nothing about how it looks.

   Phases map to the deck's colour states (3B/3L):
     connecting → BONE   (pre-call; hues are reserved for active states)
     listening  → PETROL (the owner speaks)
     thinking   → PETROL (still his turn to hold)
     speaking   → BRASS  (Michael speaks)
     ended      → glow collapses to the baseline
   ============================================================ */

export type VoicePhase =
  | "off"
  | "connecting"
  | "denied"
  | "failed"
  | "listening"
  | "thinking"
  | "speaking"
  | "ended";

export interface UserVoiceTurn {
  kind: "user";
  id: string;
  text: string;
  /** Dropped into the call from the call screen (part six), not spoken. */
  dropped?: boolean;
  /** Local preview of a dropped image. */
  image?: string;
  /**
   * What the work gate did with a remark said into running work (always-on):
   * `status` answered from the beat, `addition`/`queued` delivered after,
   * `ask` asked back, `stop-for` stopped the work for it, `name` opened the floor,
   * `merged` the rest of a thought he paused in (one turn with the piece before).
   */
  tag?: string;
}

/**
 * Something heard on the call that was not for Michael (always-on): an
 * overheard line on standby without the wake name, or a second speaker's
 * reply on an open floor. Shown greyed as "(not for me)" for this screen
 * only — never in the call record, never in the thread (§6).
 */
export interface AsideVoiceTurn {
  kind: "aside";
  id: string;
  text: string;
  reason: string;
}

export interface AgentVoiceTurn {
  kind: "agent";
  id: string;
  /** Mutable — the rAF karaoke loop reads this without re-rendering. */
  karaoke: KaraokeState;
  settled: boolean;
  interrupted: boolean;
  failed: string | null;
  /** Final spoken prose. Saved call records read this, not timing tokens. */
  committedText: string;
  /**
   * Work lines (part five): progress and technical detail the agent wrote on
   * this turn that were shown, never spoken. In order, one entry per line.
   */
  work: string[];
  /** The filler line this turn opened with, if one played — for the echo check only. */
  filler?: string;
}

export type VoiceTurn = UserVoiceTurn | AgentVoiceTurn | AsideVoiceTurn;

/**
 * The echo check's window (voice-streaming-bargein): what he hears through his
 * mic is what was said since his utterance began, plus the recognizer's lag.
 */
const ECHO_BACK_S = 2.5;
const ECHO_AHEAD_S = 0.5;
/** An utterance whose end the recognizer never committed must not widen the window forever. */
const ECHO_MAX_UTTERANCE_S = 8;
/** With no current reply, the tail of the last one is all that can still be echoing. */
const ECHO_SETTLED_TAIL_WORDS = 20;

/**
 * What Michael could be saying into his mic right now, to tell his words from
 * an echo. Only the words around the playback position — never the reply's
 * unplayed rest. A voice with no word timings (Gemini) falls back to the
 * reply's text so far, as before.
 */
export function echoCandidateText(
  turn: Pick<AgentVoiceTurn, "karaoke" | "filler"> | null,
  t: number | null,
  utteranceSec: number,
  lastSettled: string,
): string {
  if (!turn) return lastSettled.split(/\s+/).slice(-ECHO_SETTLED_TAIL_WORDS).join(" ");
  const words = turn.karaoke.words;
  if (!words.length || t === null) return `${turn.karaoke.displayText} ${turn.filler ?? ""}`.trim();
  const back = Math.min(Math.max(0, utteranceSec), ECHO_MAX_UTTERANCE_S) + ECHO_BACK_S;
  const near = recentSpokenText(turn.karaoke, t, back, ECHO_AHEAD_S);
  // The filler plays before the reply's first word: echo of it is possible
  // for as long as it could still be in his utterance.
  const filler = turn.filler && t - back < words[0].start ? turn.filler : "";
  return `${filler} ${near}`.trim();
}

/** Barge-in glow flip: reflex, deliberately faster than the 400ms handoff. */
export const BARGE_FLIP_MS = 150;

export interface VoiceLayerApi {
  phase: VoicePhase;
  /** Live (uncommitted) transcript of what the owner is saying right now. */
  provisional: string;
  turns: VoiceTurn[];
  muted: boolean;
  /** True for BARGE_FLIP_MS after an interrupt — drives the fast hue flip. */
  barging: boolean;
  elapsedSec: number;
  errorText: string | null;
  /**
   * Whether the call can hear. "reconnecting" while the gateway reopens a
   * dropped speech line (usually sub-second); "lost" once it gave up. A call
   * that cannot hear must say so on screen: going quiet instead is the
   * mute bug. "gap": it reconnected but some of what he said
   * while it was away is gone (B4) — he is asked to say it again; cleared
   * the moment new speech is heard.
   */
  hearing: "ok" | "reconnecting" | "lost" | "gap";
  /** Michael can see his screen right now (he chose to share it). */
  sharing: boolean;
  /** Screen sharing exists on this device (desktop browsers). */
  canShare: boolean;
  /** Open the browser's picker, or stop sharing. */
  toggleShare: () => void;
  /**
   * Record mode (src/voice/screen-watch.ts): Michael is watching a recording
   * of the shared screen and staying quiet until it stops. `since` is this
   * device's clock when it started, for the timer. Null when not recording.
   */
  recording: { since: number; how: string } | null;
  /** The REC button exists: sharing, on a call that supports record mode. */
  canRecord: boolean;
  /** Start a recording, or stop it (Michael then reviews it). */
  toggleRecord: () => void;
  /** FINAL's Standby button: the floor to standby ("say Michael" opens it), or back open. Absent = no standby on this engine. */
  toggleStandby?: () => void;
  /**
   * Drop an image and/or text into the call (part six). `mediaId` drops a
   * picture that is ALREADY the user's media (a studio card's option), with
   * `preview` for the transcript; no upload.
   */
  sendDrop: (drop: { text: string; image: File | null; mediaId?: string; preview?: string }) => void;
  dropBusy: boolean;
  dropError: string | null;
  /**
   * The call ended because it was CUT OFF, not because anyone ended it.
   *
   * The ended screen has to say so. A call that froze and then quietly
   * reported "CALL ENDED" is what left the owner holding a dead screen with no
   * idea whether anything had been saved (R4-3).
   */
  interrupted: boolean;
  /** This call's id, held past teardown so the record can still name it. */
  voiceStreamId: string | null;
  /**
   * The socket under the call (always-on): "reconnecting" while it is down
   * and the call waits to be resumed by id; the watchdog pauses meanwhile.
   */
  link: "ok" | "reconnecting";
  /** Open floor or standby (voice/floor.ts on the gateway), for the header. */
  floor: FloorState;
  /**
   * The agent is busy and has gone quiet: a turn is in flight (the gateway's
   * `voice-working` beats say so) but nothing has been said or shown for a
   * while. Null while it is talking, listening, or the call is over. The
   * screen shows it so a glance tells "busy" from "frozen".
   */
  working: { sec: number; steps: number } | null;
  toggleMute: () => void;
  end: () => void;
  retryMic: () => void;
  leave: () => void;
}

/**
 * The turn watchdog's clock, and what counts as life.
 *
 * Only armed while we are waiting on the agent (`thinking`/`speaking`). It
 * used to count only voice events as life, and a working turn sends none: the
 * agent says a line, then runs tools for minutes. 45 s into that honest
 * silence it ended the call with "the connection dropped" (12:24 AM —
 * the socket was fine, the model was 56 s into writing a file). Liveness now
 * means the connection and the TURN are alive: the gateway sends a
 * `voice-working` beat every few seconds for as long as a turn runs
 * (src/voice/turn-liveness.ts), and audio still queued to play counts too.
 *
 * `stallMs` is still the backstop that catches a WiFi drop. A socket whose
 * network vanishes does not necessarily emit `close` — it can sit there until
 * a TCP timeout that never comes on mobile — so waiting for the connection
 * status to change is not enough on its own. With beats every 10 s, 45 s of
 * nothing is four missed beats: the gateway or the line is gone.
 *
 * `quietMs`: how long the agent must be silent (no text, no audio) before the
 * screen says WORKING. `livenessTtlMs`: a beat older than this no longer
 * vouches for the turn. Mutable so the harness can shorten the clocks
 * (test/voice-layer.test.ts) — real timers, no fakes.
 */
export const voiceWatchdog = {
  stallMs: 45_000,
  quietMs: 6_000,
  livenessTtlMs: 30_000,
  /**
   * How long a call waits for its socket to come back before it ends with
   * "connection-lost" (always-on), when the gateway has not said. Since voice
   * step 2 the gateway says: `voice-started` carries its holds (10 min open,
   * an hour muted or on standby), and the app waits the same one plus
   * `holdMarginMs`, so the gateway — which refuses a resume past its own —
   * is the one that decides. A resume refused by the gateway ends it sooner.
   */
  resumeGraceMs: 600_000,
  holdMarginMs: 10_000,
};

/** Events the listener can perceive: the reply being said or shown. */
const PERCEIVED_EVENTS = new Set(["stream-chunk", "voice-tts-start", "voice-tts-words", "voice-work", "voice-filler", "voice-tts"]);

let turnSeq = 0;
const nextId = (): string => `vt-${++turnSeq}`;

export function useVoiceLayer(bot: string, active: boolean): VoiceLayerApi {
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [provisional, setProvisional] = useState("");
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [muted, setMuted] = useState(false);
  const [barging, setBarging] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [hearing, setHearing] = useState<"ok" | "reconnecting" | "lost" | "gap">("ok");
  const [sharing, setSharing] = useState(false);
  const [recording, setRecording] = useState<{ since: number; how: string } | null>(null);
  const [dropBusy, setDropBusy] = useState(false);
  /** Object URLs of images dropped into THIS call's transcript; revoked when the call is discarded (S4). */
  const dropPreviews = useRef<string[]>([]);
  const [dropError, setDropError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  /**
   * Kept in state (not just read from voicemode) because the call log is
   * built AFTER the mic is released, by which point `activeVoiceStreamId()`
   * is already null — the id has to outlive the session it names.
   */
  const [voiceStreamId, setVoiceStreamId] = useState<string | null>(null);
  const [working, setWorking] = useState<{ sec: number; steps: number } | null>(null);
  const [link, setLink] = useState<"ok" | "reconnecting">("ok");
  const [floor, setFloor] = useState<FloorState>("open");
  /** When the socket went down under a live call; 0 while it is up. */
  const linkDownAt = useRef(0);
  /** The gateway's holds (voice-started), and the one this drop waits for — chosen at the drop, as the gateway does. */
  const holds = useRef<{ openMs: number; quietMs: number } | null>(null);
  const linkGraceMs = useRef(voiceWatchdog.resumeGraceMs);
  const mutedRef = useRef(false);
  const floorRef = useRef<FloorState>("open");
  /**
   * Why this call is ending, as the token the gateway logs (voicemode.ts).
   * Set by whichever path ends the call, read when the mic is released.
   */
  const endReason = useRef<string | null>(null);

  const startedAt = useRef<number>(0);
  const agentTurn = useRef<AgentVoiceTurn | null>(null);
  /**
   * A `listening` transition that arrived while audio is still draining.
   *
   * The server flips to listening when SYNTHESIS finishes, but Sonic renders
   * faster than realtime — so `done` lands seconds before the user has heard
   * the reply. Applying it immediately turned the glow petrol while Michael
   * was still talking. Playback is the only thing that knows when the voice
   * actually stops, and it lives here.
   */
  const deferredListening = useRef(false);
  const lastSettledAgentText = useRef("");
  /** When the recognizer first heard words of the utterance in progress (ms epoch), 0 between utterances. */
  const utteranceHeardAt = useRef(0);

  const beginAgentTurn = useCallback((): AgentVoiceTurn => {
    const existing = agentTurn.current;
    if (existing && !existing.settled) return existing;
    const turn: AgentVoiceTurn = {
      kind: "agent",
      id: nextId(),
      karaoke: createKaraokeState(),
      settled: false,
      interrupted: false,
      failed: null,
      committedText: "",
      work: [],
    };
    agentTurn.current = turn;
    setTurns((prev) => [...prev, turn]);
    return turn;
  }, []);

  const settleAgentTurn = useCallback((interrupted: boolean) => {
    const turn = agentTurn.current;
    if (!turn || turn.settled) return;
    if (interrupted) {
      // Spoken words hold; the unspoken remainder collapses (3K). What was
      // never said must not stay on screen as if it had been.
      //
      // The live clock is normally already gone by the time we get here: a
      // barge-in cuts the audio locally on the frame the user starts talking,
      // and only then asks the server to stop, so this runs a round trip after
      // the clock was destroyed. Falling back to MAX_SAFE_INTEGER treated
      // "I can't tell" as "all of it was spoken" and froze the entire reply on
      // screen — including the part Sonic had synthesised seconds ahead of
      // playback and nobody ever heard. `interruptPosition()` is the honest
      // answer; it lives in voicebus, next to the clocks it reconciles.
      truncateAtInterrupt(turn.karaoke, interruptPosition());
      turn.interrupted = true;
    }
    turn.committedText = commitDisplayText(turn.karaoke, interrupted);
    lastSettledAgentText.current = turn.committedText;
    turn.settled = true;
    agentTurn.current = null;
    // Only a CUT stops audio. A turn that settles on its own (karaoke passed
    // its last word, or the queue drained) must leave its own audio playing:
    // the karaoke clock can run ahead of what is still queued — word timings
    // that end early, or an audio clock that jumps when the phone first
    // routes call audio — and stopping here is what cut the owner's first reply
    // after "Loud and clear" while the rest of its text appeared.
    // The next turn's voice-tts-start, a real turn starting (voice-thinking)
    // and a confirmed barge-in each stop whatever is still queued.
    if (interrupted) resetVoiceTurnAudio("interrupted");
    // A turn that was cut off before it said or wrote anything is not a turn.
    // Leaving an empty bubble tagged INTERRUPTED would put a beat in the
    // transcript that never happened.
    const empty = turn.karaoke.words.length === 0 && turn.karaoke.displayText.length === 0;
    setTurns((prev) => (empty ? prev.filter((t) => t !== turn) : [...prev]));
  }, []);

  /** CALL FAILED TO START, naming what failed — never "blocked" for a non-refusal. */
  const failToStart = useCallback(() => {
    const err = voiceStartError();
    setErrorText(
      err
        ? err.stage === "mic"
          ? `The microphone would not open (${err.name}). Tap retry; if it keeps failing, close and reopen the app.`
          : `The call's audio would not start (${err.name}). Tap retry.`
        : null,
    );
    setPhase("failed");
  }, []);

  /* ── Enter / leave ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    setPhase("connecting");
    setTurns([]);
    setDropBusy(false);
    setProvisional("");
    setErrorText(null);
    setHearing("ok");
    setSharing(false);
    setRecording(null);
    setInterrupted(false);
    setVoiceStreamId(null);
    setMuted(false);
    setVoiceUplinkMuted(false);
    setWorking(null);
    setLink("ok");
    setFloor("open");
    linkDownAt.current = 0;
    holds.current = null;
    resetVoiceFloor();
    endReason.current = null;
    agentTurn.current = null;
    deferredListening.current = false;
    lastSettledAgentText.current = "";
    startedAt.current = Date.now();
    setElapsedSec(0);
    beginVoiceStream();

    void startVoiceMode(bot).then((result) => {
      if (cancelled) return;
      setVoiceStreamId(activeVoiceStreamId());
      // The native permission prompt is unstyleable, so the design works
      // AROUND it: everything stays bone until it resolves, and a refusal
      // becomes a calm card rather than an alarm.
      if (result === "denied") setPhase("denied");
      else if (result === "idle") failToStart();
    });

    return () => {
      cancelled = true;
      // The call is over: so is anything he was showing it.
      stopScreenShare(bot);
      // ...and the previews of what he dropped in: its transcript is
      // discarded with it (the next call starts from an empty one).
      for (const url of dropPreviews.current.splice(0)) URL.revokeObjectURL(url);
      // What standby held back, for the log, before the call's state goes.
      reportEar("call-end");
      void stopVoiceMode(endReason.current ?? "screen-closed");
      endVoiceStream();
      // A mute must never outlive the call that set it — the next call opens
      // with a lit mic and an unlit button otherwise.
      setVoiceUplinkMuted(false);
    };
  }, [active, bot, failToStart]);

  /* ── Release the mic the moment the call ends ──────────────────────────
     Every route into `ended` — the END button, a server `voice-cancelled`, a
     future one — must close the mic, and it must not wait for the layer to
     unmount. It previously happened ONLY in the unmount cleanup above, which
     is a promise the ended screen cannot keep on its own: it renders "MIC OFF"
     while getUserMedia, the worklet and the server's recognizer are all still
     live. Whatever else `ended` means, it means the microphone is closed.
     `stopVoiceMode` is idempotent, so the unmount path staying is harmless. */
  useEffect(() => {
    if (!active || phase !== "ended") return;
    void stopVoiceMode(endReason.current ?? "ended");
  }, [active, phase]);

  /* ── Call timer ────────────────────────────────────────────────────── */
  useEffect(() => {
    // Stops at `ended`: the timer is the CALL's duration, and the call is
    // over. It also has to stop for the number on the ended card — and for
    // the call log, which is derived from it — to mean anything. (Leaving it
    // running was also what re-rendered the ended screen twice a second and
    // kept the exit timer from ever firing.)
    if (!active || phase === "off" || phase === "ended") return;
    const iv = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 500);
    return () => window.clearInterval(iv);
  }, [active, phase]);

  /**
   * The call was cut off — by a dead socket or a turn that stopped producing.
   *
   * Ends the call the same way the END button does, so everything downstream
   * (mic release, the record, the exit timer) runs on the one path that is
   * already proven, and the user gets an ending instead of a frozen screen.
   * The reply in flight keeps whatever was actually spoken and loses the rest,
   * exactly as a barge-in does — the unheard remainder was never said.
   */
  /** The current phase, readable from event handlers without re-subscribing them. */
  const phaseRef = useRef<VoicePhase>("off");
  phaseRef.current = phase;
  mutedRef.current = muted;
  floorRef.current = floor;

  /**
   * Synthesis finished and playback drained: settle the reply and go back to
   * listening. Lived only in the animation loop before always-on; a hidden
   * tab gets no frames, so it is also called from the watchdog tick and on
   * becoming visible.
   */
  const settleIfDrained = useCallback(() => {
    if (!deferredListening.current || voiceStreamDraining()) return;
    deferredListening.current = false;
    // Silence because he cut it is not the end of the reply: it settles cut
    // off at what he heard, with its INTERRUPTED tag, at once.
    const cut = voiceAudioWasCut();
    if (!cut) reportVoiceTurnPlayed();
    settleAgentTurn(cut);
    setPhase((p) => (p === "speaking" ? "listening" : p));
  }, [settleAgentTurn]);

  const failCall = useCallback(
    (reason: string, token: string) => {
      setPhase((p) => {
        if (p === "ended" || p === "off") return p;
        endReason.current ??= token;
        stopAgentAudio("call-failed");
        settleAgentTurn(true);
        setInterrupted(true);
        setErrorText(reason);
        return "ended";
      });
    },
    [settleAgentTurn],
  );

  /* ── Turn watchdog, and the WORKING state ──────────────────────────────
     `lastEventAt`: any voice event, the gateway's `voice-working` beats
     included — life. `lastPerceivedAt`: the reply being said or shown.
     `liveness`: the last beat, with the turn's age and tool-call count.
     The watchdog fires only when NOTHING has arrived for `stallMs` and no
     audio is still queued to play — a long reply plays on after its last
     event, and that is not a stall either. */
  const lastEventAt = useRef(0);
  const lastPerceivedAt = useRef(0);
  const liveness = useRef<{ at: number; sinceMs: number; tools: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    if (phase !== "thinking" && phase !== "speaking") {
      setWorking(null);
      return;
    }
    const now = Date.now();
    lastEventAt.current = now;
    lastPerceivedAt.current = now;
    const iv = window.setInterval(() => {
      const t = Date.now();
      const draining = voiceStreamDraining();
      // A hidden desktop tab gets no animation frames, so the playback clock's
      // settle check runs here too (always-on §8: the background tab).
      settleIfDrained();
      // The socket is down: nothing CAN arrive. The stall clock waits with the
      // call; the resume grace below is what bounds the wait.
      if (linkDownAt.current) lastEventAt.current = t;
      if (t - lastEventAt.current >= voiceWatchdog.stallMs && !draining) {
        // Voice step 2: a reply that stopped arriving is not the end of the
        // call. Either the socket is dead without saying so — the probe finds
        // out in seconds, and the link then reconnects and resumes the call by
        // id — or the turn itself is lost while the line is fine, and he
        // simply gets the floor back. The log says which.
        lastEventAt.current = t;
        probeVoiceLink();
        stopAgentAudio("stall");
        settleAgentTurn(true);
        deferredListening.current = false;
        setPhase((p) => (p === "thinking" || p === "speaking" ? "listening" : p));
        sendVoiceControl({ type: "voice-client-event", event: "stall-settled" });
        return;
      }
      const beat = liveness.current;
      const busy =
        !draining &&
        t - lastPerceivedAt.current >= voiceWatchdog.quietMs &&
        beat !== null &&
        t - beat.at <= voiceWatchdog.livenessTtlMs;
      setWorking((prev) => {
        if (!busy) return prev === null ? prev : null;
        const sec = Math.floor((beat!.sinceMs + (t - beat!.at)) / 1000);
        return prev && prev.sec === sec && prev.steps === beat!.tools ? prev : { sec, steps: beat!.tools };
      });
    }, 1000);
    return () => window.clearInterval(iv);
  }, [active, phase, settleAgentTurn, settleIfDrained]);

  /* ── The link: a call outlives its socket for the grace window ────────── */
  useEffect(() => {
    if (!active || link !== "reconnecting") return;
    const iv = window.setInterval(() => {
      if (!linkDownAt.current) return;
      if (Date.now() - linkDownAt.current >= linkGraceMs.current) {
        failCall("The connection dropped and did not come back.", "connection-lost");
      }
    }, 1000);
    return () => window.clearInterval(iv);
  }, [active, link, failCall]);

  /* ── The background tab ───────────────────────────────────────────────
     Desktop browsers keep the mic and the socket alive in a hidden tab but
     stop animation frames and slow timers to one a minute. The state that
     depended on frames (settling a reply once its audio drained) runs on the
     watchdog tick above and again the moment the tab is visible; the switch
     itself is logged so a quiet hour in the log has its explanation.       */
  useEffect(() => {
    if (!active) return;
    const doc = globalThis.document as Document | undefined;
    if (!doc || typeof doc.addEventListener !== "function") return;
    const onVisibility = (): void => {
      sendVoiceControl({ type: "voice-client-event", event: "visibility", state: doc.visibilityState === "hidden" ? "hidden" : "visible" });
      if (doc.visibilityState !== "hidden") settleIfDrained();
    };
    doc.addEventListener("visibilitychange", onVisibility);
    return () => doc.removeEventListener("visibilitychange", onVisibility);
  }, [active, settleIfDrained]);

  /* ── Server events ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (!active) return;
    return onVoiceEvent((ev: VoiceEvent) => {
      const now = Date.now();
      lastEventAt.current = now;
      if (PERCEIVED_EVENTS.has(ev.type)) lastPerceivedAt.current = now;
      switch (ev.type) {
        case "voice-connection-lost":
          // The socket carrying this call is gone. Since always-on slice 1 the
          // gateway PARKS the call for a grace window instead of ending it, so
          // a live call waits: the header says RECONNECTING, the watchdog
          // pauses, and the socket that comes back claims the call by id
          // (`voice-connection-open` below). A call that never connected has
          // nothing to resume and ends as before. The card is safe either
          // way: the server writes it from its own record if we never can.
          if (phaseRef.current === "listening" || phaseRef.current === "thinking" || phaseRef.current === "speaking") {
            if (!linkDownAt.current) {
              linkDownAt.current = now;
              // Where the reply on air stood, for the resume's report (voicebus.ts).
              noteVoiceDoorDown(now);
              const h = holds.current;
              const quiet = mutedRef.current || floorRef.current === "standby";
              linkGraceMs.current = h ? (quiet ? h.quietMs : h.openMs) + voiceWatchdog.holdMarginMs : voiceWatchdog.resumeGraceMs;
              setLink("reconnecting");
            }
          } else {
            failCall("The connection dropped.", "connection-lost");
          }
          break;

        case "voice-connection-open":
          // The socket is back: claim the same call by id. The gateway answers
          // `voice-started` with `resumed`, or `voice-error` if the call is gone.
          if (linkDownAt.current) resumeVoiceMode();
          break;

        case "voice-floor":
          if (ev.state === "open" || ev.state === "standby") {
            setVoiceFloor(ev.state);
            setFloor(ev.state);
          }
          break;

        case "voice-aside": {
          // Not for him: shown greyed for this screen only, kept nowhere.
          const text = typeof ev.text === "string" ? ev.text.trim() : "";
          setProvisional("");
          if (text) setTurns((prev) => [...prev, { kind: "aside", id: nextId(), text, reason: typeof ev.reason === "string" ? ev.reason : "aside" }]);
          break;
        }

        case "voice-gate": {
          // What the work gate did with the last thing he said into running work.
          const verdict = typeof ev.verdict === "string" ? ev.verdict : "";
          const text = typeof ev.text === "string" ? ev.text.trim() : "";
          if (!verdict) break;
          setTurns((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              const t = prev[i];
              if (t.kind !== "user") continue;
              if (text && t.text.trim() !== text) continue;
              const next = [...prev];
              next[i] = { ...t, tag: verdict };
              return next;
            }
            return text ? [...prev, { kind: "user", id: nextId(), text, tag: verdict }] : prev;
          });
          break;
        }

        case "voice-screen-record":
          // The gateway owns the recording ("watch this" or the REC button); the dot and timer follow it.
          if (ev.on === true) setRecording({ since: now, how: typeof ev.how === "string" ? ev.how : "button" });
          else if (ev.on === false) setRecording(null);
          break;

        case "voice-mute-state":
          // "Michael, go quiet": the gateway muted the call; the button and the
          // uplink gate follow, so nothing leaves the device either.
          if (typeof ev.on === "boolean") {
            setVoiceUplinkMuted(ev.on);
            setMuted(ev.on);
          }
          break;

        case "voice-working":
          // The gateway's beat: a turn is in flight (src/voice/turn-liveness.ts).
          // Life for the watchdog, and the numbers the WORKING state shows.
          liveness.current = {
            at: now,
            sinceMs: typeof ev.sinceMs === "number" ? ev.sinceMs : 0,
            tools: typeof ev.tools === "number" ? ev.tools : 0,
          };
          break;

        case "voice-started":
          // Connected: bone blooms to petrol (3L). Only from a pre-call
          // phase — a late `voice-started` must not yank a live call back.
          setPhase((p) => (p === "connecting" ? "listening" : p));
          // Show the reply as it is spoken, unless the gateway says not to.
          setServerTextFollowsVoice(ev.textFollowsVoice !== false);
          {
            const h = ev.hold as { openMs?: unknown; quietMs?: unknown } | undefined;
            if (h && typeof h.openMs === "number" && typeof h.quietMs === "number" && h.openMs > 0) {
              holds.current = { openMs: h.openMs, quietMs: Math.max(h.openMs, h.quietMs) };
            }
          }
          if (ev.resumed === true) {
            // The call came back on a new socket (always-on): the link is up,
            // and the snapshot says where things stand — the turn in flight,
            // the floor, the mute. Whatever the gateway held is replayed
            // right behind this event.
            const gap = linkDownAt.current ? now - linkDownAt.current : 0;
            linkDownAt.current = 0;
            setLink("ok");
            lastEventAt.current = now;
            const w = ev.working as { sinceMs?: number; tools?: number } | null | undefined;
            liveness.current = w ? { at: now, sinceMs: typeof w.sinceMs === "number" ? w.sinceMs : 0, tools: typeof w.tools === "number" ? w.tools : 0 } : null;
            const f = ev.floor as { state?: string } | null | undefined;
            if (f?.state === "open" || f?.state === "standby") {
              setVoiceFloor(f.state);
              setFloor(f.state);
            }
            if (typeof ev.muted === "boolean") {
              setVoiceUplinkMuted(ev.muted);
              setMuted(ev.muted);
            }
            sendVoiceControl({ type: "voice-client-event", event: "resumed", gapMs: Math.round(gap), heldAudioDropped: ev.heldAudioDropped === true });
          }
          break;

        case "call-drop-ack":
          if (ev.ok === false) setDropError(typeof ev.error === "string" ? ev.error : "That didn't go through.");
          break;

        case "stt-health":
          if (ev.state === "ok" && ev.gap === true) setHearing("gap");
          else if (ev.state === "ok" || ev.state === "reconnecting" || ev.state === "lost") {
            setHearing(ev.state);
          }
          break;

        case "stt-interim": {
          const heard = typeof ev.text === "string" ? ev.text : "";
          setProvisional(heard);
          // He is speaking again after a gap: the "say that again" is answered.
          if (heard) setHearing((h) => (h === "gap" ? "ok" : h));
          // Part seven: the ONLY thing that cuts a reply he is talking over —
          // the recognizer confirming real words (not noise, not a
          // backchannel, not our own voice through his mic).
          if (heard && !utteranceHeardAt.current) utteranceHeardAt.current = now;
          if (heard && isAgentAudible()) {
            // Echo is judged against what was just SAID, never the reply's
            // unplayed rest — that is what kept a finished reply talking over him.
            const saying = echoCandidateText(
              agentTurn.current,
              voiceStreamPosition(),
              (now - utteranceHeardAt.current) / 1000,
              lastSettledAgentText.current,
            );
            if (confirmsBargeIn(heard, saying)) bargeIn();
          }
          break;
        }

        case "stt-final": {
          const text = typeof ev.text === "string" ? ev.text.trim() : "";
          setProvisional("");
          utteranceHeardAt.current = 0;
          if (!text) break;
          // Part seven: a commit alone no longer touches the reply. It may be
          // a backchannel the gateway answers with silence ("Awesome." at
          // 18:33Z cut a 15-second reply here). `voice-thinking`, sent only
          // when a real turn starts, settles and stops the old reply instead;
          // a confirmed barge-in has already cut it.
          // The provisional line rides up into history as a real bubble (3C).
          setTurns((prev) => [...prev, { kind: "user", id: nextId(), text }]);
          break;
        }

        case "voice-thinking":
          // A real turn is starting (not a silent ack). It closes the previous
          // agent turn, whatever happened to it — otherwise `beginAgentTurn`
          // would hand the NEXT reply the same line and weld two answers
          // together — and stops anything still queued from it: he spoke, and
          // that speech is being answered. A reply that settled on its own
          // keeps its full text; one still unsettled is cut at what was heard.
          settleAgentTurn(true);
          resetVoiceTurnAudio("user-turn");
          setPhase("thinking");
          break;

        case "voice-tts-start":
          // A new reply: an older turn's "synthesis done" no longer applies —
          // left armed, it would settle THIS turn at its first word's end.
          deferredListening.current = false;
          resetVoiceTurnAudio("next-turn");
          setPhase("speaking");
          beginAgentTurn();
          break;

        case "voice-tts-words": {
          const turn = beginAgentTurn();
          if (Array.isArray(ev.words) && Array.isArray(ev.start) && Array.isArray(ev.end)) {
            ingestWordTimings(turn.karaoke, {
              words: ev.words as string[],
              start: ev.start as number[],
              end: ev.end as number[],
            });
            setTurns((prev) => [...prev]);
          }
          break;
        }

        case "voice-filler":
          // The front voice's line opens this turn (no word timings): kept
          // only so the echo check knows the words that are playing.
          if (typeof ev.text === "string" && ev.text.trim()) beginAgentTurn().filler = ev.text.trim();
          break;

        case "voice-tts-done":
          // Synthesis finished, NOT playback. Settling here re-rendered the
          // whole block white mid-read; the rAF loop settles it once the
          // audio has actually drained past the last word.
          deferredListening.current = true;
          break;

        case "stream-chunk":
          if (typeof ev.chunk === "string") {
            if (!agentTurn.current && isDisplayReemission(lastSettledAgentText.current, ev.chunk)) {
              break;
            }
            const turn = beginAgentTurn();
            if (appendDisplayText(turn.karaoke, ev.chunk)) {
              turn.committedText = "";
              setTurns((prev) => [...prev]);
            }
          }
          break;

        case "voice-work": {
          // Shown, never spoken. A fragment continues the line before it
          // unless that line was finished.
          if (typeof ev.text !== "string" || !ev.text) break;
          const turn = agentTurn.current ?? beginAgentTurn();
          const last = turn.work.length - 1;
          const open = last >= 0 && !/(?:[.!?…]["')\]]?|\n)\s*$/.test(turn.work[last]);
          if (open) turn.work[last] += ev.text;
          else turn.work.push(ev.text);
          setTurns((prev) => [...prev]);
          break;
        }

        case "stream-tool-use": {
          // The message before a tool call is complete. Without a separator
          // the next message's first word was welded onto it on screen and in
          // the call record ("timestamped one.I sent it"). Any
          // re-emission of that message has already arrived by now: the CLI
          // sends a message's text before its tool call.
          const turn = agentTurn.current;
          const shown = turn?.karaoke.displayText ?? "";
          if (turn && shown && !/\s$/.test(shown)) {
            turn.karaoke.displayText = `${shown} `;
            turn.karaoke.messageStart = turn.karaoke.displayText.length;
          }
          break;
        }

        case "voice-empty":
          setPhase("listening");
          break;

        case "voice-interrupt-ack":
          settleAgentTurn(true);
          break;

        case "voice-error": {
          const text = typeof ev.error === "string" ? ev.error : "Something went wrong.";
          if (ev.code === "no-such-call" || ev.code === "not-your-call") {
            // A resume the gateway refused: the grace window ran out, or it
            // restarted. The call is over; say so and end it honestly.
            failCall(text, "resume-refused");
            break;
          }
          setErrorText(text);
          // Before the call connects this becomes the CALL FAILED card. After
          // it connects there is no card — and an error that renders nowhere
          // reads as the agent simply going quiet. The transcript already
          // knows how to show a failed turn, so it goes there, on the turn it
          // actually happened to, and the call carries on.
          const turn = agentTurn.current;
          if (turn && !turn.settled) {
            turn.failed = text;
            turn.committedText = sanitizeForTranscript(turn.karaoke.displayText || text);
            turn.karaoke.committedText = turn.committedText;
            lastSettledAgentText.current = turn.committedText;
            turn.settled = true;
            agentTurn.current = null;
            resetVoiceTurnAudio("turn-error");
            setTurns((prev) => [...prev]);
          }
          // A pre-call failure is the CALL FAILED card; mid-call, the turn
          // above carries the error and the call returns to listening.
          setPhase((p) =>
            p === "connecting"
              ? "failed"
              : p === "thinking" || p === "speaking"
                ? "listening"
                : p,
          );
          break;
        }

        case "voice-tts":
          // The DEGRADED path: no streamed audio this turn, so no
          // `voice-tts-start` and no `voice-tts-done` will ever arrive. The
          // glow would sit in `thinking` for the rest of the call waiting for
          // a signal that is not coming. The blob still plays through the
          // element; the turn is over as far as this state machine goes.
          settleAgentTurn(false);
          setPhase((p) => (p === "thinking" || p === "speaking" ? "listening" : p));
          break;

        case "voice-cancelled":
          endReason.current ??= "server-cancelled";
          setPhase("ended");
          break;
      }
    });
  }, [active, beginAgentTurn, settleAgentTurn, failCall]);

  /* ── Playback clock: karaoke settle + deferred listening ───────────── */
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      checkVoiceClock();

      const turn = agentTurn.current;
      const t = voiceStreamPosition();
      if (turn && !turn.settled && t !== null) {
        const words = turn.karaoke.words;
        const last = words[words.length - 1];
        // Settle only once synthesis is done AND playback has passed the last
        // word — audio is buffered ahead of synthesis, so either alone is early.
        if (deferredListening.current && last && t >= last.end) settleAgentTurn(false);
      }

      settleIfDrained();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, settleAgentTurn, settleIfDrained]);

  /* ── Local barge-in: the glow must flip on the same frame ──────────── */
  useEffect(() => {
    if (!active) return;
    return onVoiceEvent((ev) => {
      if (ev.type !== "voice-interrupt-ack") return;
      setBarging(true);
      window.setTimeout(() => setBarging(false), BARGE_FLIP_MS);
      setPhase("listening");
    });
  }, [active]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      // The gate that actually stops audio leaving the device. The message to
      // the server is the second lock, not the first — this used to be the
      // only line here, and it meant MUTE lit the button and changed nothing:
      // the worklet kept posting frames, the gateway kept transcribing, and a
      // conversation happening in the room got answered.
      setVoiceUplinkMuted(next);
      sendVoiceControl({ type: "voice-mute", bot, on: next });
      return next;
    });
  }, [bot]);

  const toggleRecord = useCallback(() => {
    const callId = activeVoiceStreamId();
    if (!callId || !sharing) return;
    // The gateway answers with `voice-screen-record`; the dot waits for it, so it never shows a recording that is not happening.
    sendVoiceControl({ type: "screen-record", bot, on: !recording, voiceStreamId: callId });
  }, [bot, sharing, recording]);

  // Standby / Resume: the same floor "Michael, go to sleep" / "wake up" moves on the gateway; it answers with voice-floor.
  const toggleStandby = useCallback(() => {
    const callId = activeVoiceStreamId();
    if (!callId) return;
    sendVoiceControl({ type: "voice-standby", bot, on: floor !== "standby", voiceStreamId: callId });
  }, [bot, floor]);

  const toggleShare = useCallback(() => {
    if (sharing) {
      stopScreenShare(bot);
      setSharing(false);
      return;
    }
    // The share belongs to THIS call (B5): a picker accepted after hang-up
    // is void inside startScreenShare, and the gateway checks the id.
    void startScreenShare(bot, () => setSharing(false), activeVoiceStreamId()).then((ok) => setSharing(ok));
  }, [bot, sharing]);

  /**
   * Part six: an image goes up first through the save-only upload (the same
   * path chat staging uses), then the call is told by media id; text goes
   * straight over the socket. The drop shows in the call transcript at once.
   */
  const sendDrop = useCallback(
    (drop: { text: string; image: File | null; mediaId?: string; preview?: string }) => {
      setDropError(null);
      // S4: a drop belongs to the call it was made in. An upload that
      // finishes after hang-up is discarded here, and the gateway refuses a
      // drop naming any call but the live one.
      const callId = activeVoiceStreamId();
      if (!callId) {
        setDropError("The call isn't connected.");
        return;
      }
      if (drop.mediaId && !drop.image) {
        setTurns((prev) => [...prev, { kind: "user", id: nextId(), text: drop.text, dropped: true, image: drop.preview }]);
        sendVoiceControl({ type: "call-drop", bot, text: drop.text, mediaId: drop.mediaId, voiceStreamId: callId });
        return;
      }
      const preview = drop.image ? URL.createObjectURL(drop.image) : undefined;
      if (preview) dropPreviews.current.push(preview);
      setTurns((prev) => [...prev, { kind: "user", id: nextId(), text: drop.text, dropped: true, image: preview }]);
      if (!drop.image) {
        sendVoiceControl({ type: "call-drop", bot, text: drop.text, voiceStreamId: callId });
        return;
      }
      setDropBusy(true);
      void uploadStaged(drop.image)
        .then((r) => {
          if (activeVoiceStreamId() !== callId) return; // that call is over
          if (!r.ok) {
            setDropError(`The image didn't upload (${r.error}).`);
            return;
          }
          sendVoiceControl({ type: "call-drop", bot, text: drop.text, mediaId: r.mediaId, voiceStreamId: callId });
        })
        .finally(() => {
          if (activeVoiceStreamId() === callId) setDropBusy(false);
        });
    },
    [bot],
  );

  // Leaving the live call (ended, failed) stops sharing on the same frame.
  useEffect(() => {
    if (phase === "ended" || phase === "failed" || phase === "off") {
      stopScreenShare(bot);
      setSharing(false);
      setRecording(null);
    }
  }, [phase, bot]);

  const end = useCallback(() => {
    endReason.current ??= "end-button";
    stopAgentAudio("end-call");
    setPhase("ended");
  }, []);

  const retryMic = useCallback(() => {
    // RETRY is a tap: the same audio priming the call button does (iOS).
    primeVoiceAudio();
    setPhase("connecting");
    setErrorText(null);
    void startVoiceMode(bot).then((result) => {
      if (result === "denied") setPhase("denied");
      else if (result === "idle") failToStart();
    });
  }, [bot, failToStart]);

  const leave = useCallback(() => {
    setPhase("off");
  }, []);

  return useMemo(
    () => ({
      phase,
      provisional,
      turns,
      muted,
      barging,
      elapsedSec,
      errorText,
      hearing,
      sharing,
      canShare: canShareScreen(),
      toggleShare,
      recording,
      canRecord: sharing,
      toggleRecord,
      toggleStandby,
      sendDrop,
      dropBusy,
      dropError,
      interrupted,
      voiceStreamId,
      link,
      floor,
      working,
      toggleMute,
      end,
      retryMic,
      leave,
    }),
    [
      phase,
      provisional,
      turns,
      muted,
      barging,
      elapsedSec,
      errorText,
      hearing,
      sharing,
      toggleShare,
      recording,
      toggleRecord,
      toggleStandby,
      sendDrop,
      dropBusy,
      dropError,
      interrupted,
      voiceStreamId,
      link,
      floor,
      working,
      toggleMute,
      end,
      retryMic,
      leave,
    ],
  );
}

/** Turn count for the call log — user turns are the countable unit. */
export function countTurns(turns: VoiceTurn[]): number {
  return turns.filter((t) => t.kind === "user").length;
}

/** Compact transcript for the call log card. */
export function buildTranscript(turns: VoiceTurn[]): { role: "user" | "agent"; text: string }[] {
  return turns
    // Asides are not kept (§6): they leave with the screen.
    .filter((t): t is UserVoiceTurn | AgentVoiceTurn => t.kind !== "aside")
    .map((t) =>
      t.kind === "user"
        ? {
            role: "user" as const,
            text: t.dropped
              ? `(dropped in) ${[t.image ? "[image]" : "", sanitizeForTranscript(t.text)].filter(Boolean).join(" ")}`
              : sanitizeForTranscript(t.text),
          }
        : {
            role: "agent" as const,
            // Work lines were shown, not said; the record keeps them, marked.
            text: [
              t.committedText || t.karaoke.committedText || sanitizeForTranscript(t.karaoke.displayText),
              ...(t.work ?? []).map((w) => w.trim()).filter(Boolean).map((w) => `(on screen) ${w}`),
            ]
              .filter((x) => x.trim())
              .join("\n"),
          },
    )
    .filter((t) => t.text.trim().length > 0);
}

export const formatElapsed = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
