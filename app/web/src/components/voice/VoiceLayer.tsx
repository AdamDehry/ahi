import { useEffect, useRef } from "react";
import VoiceTranscript from "./VoiceTranscript";
import VoiceControls from "./VoiceControls";
import DropBar from "./DropBar";
import CallPill, { callStateLabel } from "./CallPill";
import { BOT_LABELS } from "../../lib/types";
import { IconChevronDown } from "../icons";
import { sendVoiceControl } from "../../lib/voicebus";
import { showToast } from "../../lib/toast";
import {
  buildTranscript,
  countTurns,
  formatElapsed,
} from "../../lib/voicelayer";
import { useCallLayer } from "../../lib/callLayer";
import { registerCallAnswerSink } from "../../lib/studioBus";

/**
 * The immersive voice screen (frames 3B–3F).
 *
 * A call is its own mode — a separate surface over the chat, with its own
 * thread and its own ending. The surface, the transcript pane and the control
 * rail are separate components so a screen-share surface can mount beside the
 * transcript later without a rebuild.
 *
 * Mounted ONLY while a call is live. With voice mode off for the agent this
 * component is never rendered, never subscribes, and never touches audio.
 *
 * Two faces, one call (call-minimize-pill). This component OWNS the
 * call's state — `useVoiceLayer` runs here and nowhere else — and renders
 * either the full screen or, while `minimized`, the floating pill. The
 * switch is a render branch, not a mount: the hook instance, its socket
 * subscription, the mic, the timer and the turns are untouched either way.
 * That is what makes "move around the app while the call keeps going" a
 * property of the structure rather than a promise. The host that mounts
 * this (CallHost) sits in the app shell, so no view change unmounts it.
 */
/** Let the glow collapse to the baseline before the layer slides away. */
const EXIT_DELAY_MS = 1100;
/** An ordinary End: just long enough for the call record to go out (it is sent from the effect above). */
const QUICK_EXIT_MS = 120;

export default function VoiceLayer({
  bot,
  onExit,
  minimized = false,
  onMinimize,
  onRestore,
  viaEleven = false,
}: {
  bot: string;
  /** The gateway carries this agent's calls over ElevenLabs (session `elevenBots`). */
  viaEleven?: boolean;
  onExit: () => void;
  /** Show the pill instead of the screen. The call does not change. */
  minimized?: boolean;
  /** Minimize control (header button, Escape). Absent: no minimize offered. */
  onMinimize?: () => void;
  /** Tapping the pill. */
  onRestore?: () => void;
}) {
  // Native, or ElevenLabs when the gateway says so (lib/callLayer.ts) — one screen for both.
  const call = useCallLayer(bot, viaEleven);
  const recorded = useRef(false);

  const {
    phase,
    provisional,
    turns,
    muted,
    barging,
    elapsedSec,
    errorText,
    hearing,
    sharing,
    canShare,
    toggleShare,
    recording,
    canRecord,
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
  } = call;

  // The one label that says what the call is doing (always-on): the link
  // first (nothing else is true while it is down), then work, then the floor.
  const stateLabel = callStateLabel({ phase, link, working, floor, muted, name: BOT_LABELS[bot] ?? bot, speaking: provisional.length > 0 });
  const stateClass = link === "reconnecting" ? " link-down" : working ? " working" : floor === "standby" ? " standby" : "";

  /**
   * The call's final state, read by the effects below without being a
   * dependency of them. See the exit effect for why that distinction is
   * load-bearing rather than a micro-optimisation.
   */
  /* Live studio: while this call is live, a tap on one of the
     agent's decision cards goes INTO the call as a drop (the picture rides
     along), not into the chat. Native calls only: the ElevenLabs rollback
     path has no drops, so there the tap stays a chat message. */
  const live = phase === "listening" || phase === "thinking" || phase === "speaking";
  const sendDropRef = useRef(sendDrop);
  sendDropRef.current = sendDrop;
  useEffect(() => {
    if (!live || call.transport !== "native") return;
    return registerCallAnswerSink(bot, (a) => sendDropRef.current({ text: a.text, image: null, mediaId: a.mediaId, preview: a.preview }));
  }, [live, bot, call.transport]);

  const latest = useRef({ turns, elapsedSec, onExit, voiceStreamId, transport: call.transport });
  const interruptedRef = useRef(interrupted);
  interruptedRef.current = interrupted;
  latest.current = { turns, elapsedSec, onExit, voiceStreamId, transport: call.transport };

  /**
   * The call log (3F).
   *
   * Reported to the SERVER, which is what writes it — gateway state files are
   * cached in-process and rewritten whole, so a card written anywhere else is
   * erased by the next save. `recorded` guards against a double-send: a call
   * produces exactly one card, and re-entering `ended` must not append a
   * second one.
   */
  useEffect(() => {
    if (phase !== "ended" || recorded.current) return;
    recorded.current = true;

    const { turns: finalTurns, elapsedSec: finalSec, voiceStreamId: id } = latest.current;
    const turnCount = countTurns(finalTurns);
    // A call with nothing in it is not a call worth logging — entering voice
    // mode and immediately leaving should leave the thread as it was.
    //
    // If this send goes nowhere (a dead socket — the exact case in R4-1), the
    // gateway writes the card from its own record of the call instead. The
    // `voiceStreamId` is what lets it tell "the client reported" from "the
    // client never could", so it never writes a second card for a call the
    // client already logged.
    // An ElevenLabs call's card is written by the gateway when the engine's
    // socket closes (src/voice/eleven/install.ts); the app has nothing to send.
    if (turnCount > 0 && latest.current.transport === "native") {
      sendVoiceControl({
        type: "voice-session-record",
        bot,
        voiceStreamId: id,
        record: {
          startedAt: Date.now() - finalSec * 1000,
          durationSec: finalSec,
          turns: turnCount,
          transcript: buildTranscript(finalTurns),
        },
      });
    }
  }, [phase, bot]);

  /**
   * Leave the call screen once the glow has collapsed.
   *
   * `phase` is the ONLY dependency, and that is the whole fix. This effect
   * used to also depend on `turns`, `elapsedSec` and `onExit`; the call timer
   * kept ticking through `ended`, so `elapsedSec` changed twice a second, and
   * every re-run cleared the pending timeout while the one-shot record guard
   * above made the body return before it could schedule another. The timeout
   * was cancelled forever and `onExit` never fired — the layer is fixed,
   * inset 0, aria-modal, so the user was sealed inside a dead screen with no
   * way back, and every single call ended there.
   *
   * Keyed on `phase` alone, this runs exactly once per entry into `ended` and
   * nothing a parent re-render does can cancel it. `onExit` is read through
   * the ref for the same reason: a parent that rebuilds the callback each
   * render must not be able to reach in and reset the timer.
   */
  useEffect(() => {
    if (phase !== "ended") return;
    // As FINAL: an ordinary End closes the call straight away and a small toast says where it
    // went — no ended screen. A call that was CUT OFF keeps its screen for the exit delay: that note
    // ("completed turns are saved") is the one the owner needs to read.
    if (!interruptedRef.current) {
      const name = BOT_LABELS[bot] ?? bot;
      showToast(countTurns(latest.current.turns) > 0 ? `Voice conversation saved in ${name}’s chat.` : "Call ended.", 2600);
    }
    const t = window.setTimeout(() => latest.current.onExit(), interruptedRef.current ? EXIT_DELAY_MS : QUICK_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  const preCall = phase === "connecting" || phase === "denied" || phase === "failed";
  // Only a live call minimizes. Pre-call states need their screen (the
  // permission card, the retry); a minimized call that fails to resume shows
  // its ending on the pill for the exit delay, then leaves with it.
  const canMinimize = !!onMinimize && !preCall && phase !== "ended";
  const showPill = minimized && !preCall;

  // Escape minimizes the full screen (optional in the brief; cheap here).
  useEffect(() => {
    if (!canMinimize || minimized) return;
    const w = globalThis.window as Window | undefined;
    if (!w || typeof w.addEventListener !== "function") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onMinimize?.();
    };
    w.addEventListener("keydown", onKey);
    return () => w.removeEventListener("keydown", onKey);
  }, [canMinimize, minimized, onMinimize]);

  if (showPill) {
    return (
      <CallPill
        bot={bot}
        phase={phase}
        floor={floor}
        link={link}
        working={working}
        elapsedSec={elapsedSec}
        speaking={provisional.length > 0}
        muted={muted}
        onRestore={onRestore ?? (() => {})}
      />
    );
  }

  return (
    <section
      className={`voice s-${phase}${barging ? " barge" : ""}${provisional.length > 0 ? " user-talking" : ""}${phase === "ended" && !interrupted ? " quick-end" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Voice call with ${BOT_LABELS[bot] ?? bot}`}
    >
      {/* Stacked glow layers, crossfaded by opacity only (3I). Bone until the
          call connects — hues are reserved for active states (3L). */}
      <div className="glow glow-bone" />
      <div className="glow glow-petrol" />
      <div className="glow glow-brass" />
      <div className="baseline" />

      <header className="voice-head">
        {/* Minimize: the screen goes, the call stays (the pill takes over). */}
        {canMinimize && (
          <button type="button" className="vh-min" aria-label="Minimize call" title="Minimize (Esc)" onClick={onMinimize}>
            {/* A small down arrow, as FINAL — not the spelled-out word. */}
            <IconChevronDown />
          </button>
        )}
        <span className={`agent-dot live${floor === "standby" ? " standby" : ""}${link === "reconnecting" ? " link-down" : ""}`} />
        <strong>{BOT_LABELS[bot] ?? bot}</strong>
        {/* Mono system labels stay English always — chrome, not speech (3J). */}
        {/* WORKING: a turn is in flight and the agent has gone quiet over it.
            The glance that tells "busy" from "frozen" (voice-call-drop). */}
        <span className={`mono vh-label${stateClass}`}>{stateLabel}</span>
        <span className="mono vh-timer">{formatElapsed(elapsedSec)}</span>
      </header>

      {/* While sharing, say so plainly and keep STOP one tap away. */}
      {/* Recording ("watch this" or REC): a red dot and a running timer; one tap stops it and he reviews it. */}
      {sharing && recording && !preCall && phase !== "ended" && (
        <button type="button" className="share-banner recording mono" onClick={toggleRecord} aria-label="Stop recording" role="status">
          <span className="rec-dot" />
          <span className="rec-timer">REC {formatElapsed(Math.max(0, Math.floor((Date.now() - recording.since) / 1000)))}</span>
          · MICHAEL IS WATCHING · TAP TO STOP
        </button>
      )}
      {sharing && !recording && !preCall && phase !== "ended" && (
        <button type="button" className="share-banner mono" onClick={toggleShare} aria-label="Stop sharing screen">
          <span className="share-dot" />
          MICHAEL CAN SEE YOUR SCREEN · TAP TO STOP
        </button>
      )}

      <VoiceTranscript turns={turns} provisional={provisional} />

      {working && phase !== "ended" && (
        <div className="work-note mono" role="status">
          {`${(BOT_LABELS[bot] ?? bot).toUpperCase()} IS WORKING · ${formatElapsed(working.sec)}` +
            (working.steps ? ` · ${working.steps} STEP${working.steps === 1 ? "" : "S"}` : "")}
        </div>
      )}

      {phase === "connecting" && (
        <div className="center-note mono">{"ALLOW MICROPHONE\nTO START THE CALL"}</div>
      )}
      {/* An interrupted call says so. Reporting a plain "CALL ENDED" for a
          call that was cut off is what left the owner unsure whether anything had
          survived — the turns that completed ARE saved, and the screen is
          where he finds that out (R4-3). */}
      {phase === "ended" && (
        <div className="center-note mono">
          {interrupted
            ? `CALL INTERRUPTED · ${formatElapsed(elapsedSec)}\n${errorText ?? "The connection dropped."}\nCOMPLETED TURNS ARE SAVED`
            : `MIC OFF · CALL ENDED · ${formatElapsed(elapsedSec)}`}
        </div>
      )}

      {/* A call that cannot hear says so, in the same place the call's other
          states speak. Silence here is what left the owner talking to a dead line
          for minutes after unmuting (2026-10-13). */}
      {!preCall && phase !== "ended" && hearing !== "ok" && (
        <div className="center-note mono" role="status">
          {hearing === "lost"
            ? "CAN'T HEAR YOU · SPEECH LINE DROPPED\nHANG UP AND CALL AGAIN"
            : hearing === "gap"
              ? "MISSED A FEW SECONDS WHILE RECONNECTING\nSAY THAT AGAIN"
              : "RECONNECTING THE MIC LINE…"}
        </div>
      )}

      {/* Denied is a calm hairline card, warn tone on the BORDER only — never
          a red alarm. The native prompt can't be styled, so the design works
          around it rather than fighting it (3L). */}
      {(phase === "denied" || phase === "failed") && (
        <div className="perm-card">
          <div className="mono perm-title">
            {phase === "denied" ? "MICROPHONE BLOCKED" : "CALL FAILED TO START"}
          </div>
          <p>
            {phase === "denied"
              ? "Enable the microphone in your browser's site settings, then try again."
              : (errorText ?? "Something went wrong starting the call.")}
          </p>
          <div className="perm-actions mono">
            <button type="button" className="perm-retry" onClick={retryMic}>
              RETRY
            </button>
            <button type="button" className="perm-back" onClick={onExit}>
              BACK TO CHAT
            </button>
          </div>
        </div>
      )}

      {/* Drop an image, a link or a note in without hanging up (part six). */}
      {!preCall && phase !== "ended" && <DropBar onSend={sendDrop} busy={dropBusy} error={dropError} />}

      {!preCall && (
        <VoiceControls
          muted={muted}
          onToggleMute={toggleMute}
          onEnd={end}
          sharing={sharing}
          canShare={canShare}
          onToggleShare={toggleShare}
          recording={!!recording}
          canRecord={canRecord}
          onToggleRecord={toggleRecord}
          standby={floor === "standby"}
          onToggleStandby={phase === "ended" ? undefined : toggleStandby}
        />
      )}
    </section>
  );
}
