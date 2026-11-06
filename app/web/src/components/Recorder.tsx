import { useCallback, useEffect, useRef, useState } from "react";
import { uploadVoiceNote } from "../lib/api";
import { drainVoiceOutbox, enqueueVoiceNote } from "../lib/voice-outbox";
import { IconMic, IconTrash, IconSend, IconPause, IconPlay } from "./icons";
import { claimCaptureSession, releaseCaptureSession, settleAudioSession } from "../lib/audiosession";

type Phase = "idle" | "recording" | "paused" | "sending";

const MIN_NOTE_MS = 400; // ignore accidental blips

/**
 * iOS/WebKit audio-session control (Step 8 mic fix) lives in
 * lib/audiosession.ts now: the call claims the same session, and the two
 * must not undo each other. "play-and-record" only while the mic is open,
 * "playback" the instant it closes.
 */
const SESSION_OWNER = "voice-note";

function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function formatTimer(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Composer voice recorder (3d4 — the owner's simplification): TAP the mic →
 * recording starts immediately in the locked state. No hold/swipe
 * gestures. The active bar has FIXED positions:
 *
 *   [🗑 delete] [● Recording…] [0:MM] ……spacer…… [⏸/▶] [➤ send]
 *
 * Pause is a real icon toggle (⏸ ⇄ ▶) acting on the RECORDING
 * (MediaRecorder.pause/resume, 3d3 §4b); Send is pinned far right and
 * never moves as the timer grows.
 *
 * Send path (3d3 §4b, outbox): MediaRecorder (webm/opus) →
 * blob → IndexedDB (lib/voice-outbox.ts) → POST /ui/voice-send
 * (deployed) → durable voice media + Whisper transcript, broadcast with
 * the media attached — the note arrives in the thread as a playable
 * voice message over the WS.
 *
 * The recorder does NOT own the upload any more. It records, hands the
 * blob to the queue, and is immediately ready to record again; the queue
 * is what retries, and what survives a reload. The only upload still
 * made from here is the fail-open one, for a device whose storage will
 * not take the note at all.
 */
export default function Recorder({ bot, onPhase }: { bot: string; onPhase?: (recording: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);

  const phaseRef = useRef<Phase>("idle");
  const mediaRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const pausedTotal = useRef(0);
  const pausedAt = useRef(0);

  const setPhaseBoth = useCallback(
    (p: Phase) => {
      phaseRef.current = p;
      setPhase(p);
      onPhase?.(p === "recording" || p === "paused");
    },
    [onPhase],
  );

  // timer tick
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current - pausedTotal.current), 250);
    return () => clearInterval(t);
  }, [phase]);

  function teardownAudio(): void {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        /* already stopped */
      }
    }
    recorderRef.current = null;
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    releaseCaptureSession(SESSION_OWNER);
  }

  async function start(): Promise<void> {
    if (phaseRef.current !== "idle") return;
    let stream: MediaStream;
    claimCaptureSession(SESSION_OWNER);
    try {
      // Android lever (Michael's review of PR #11): with echoCancellation/
      // noiseSuppression/autoGainControl on (the defaults), Android flips
      // the SYSTEM audio into VOICE_COMMUNICATION mode for the life of the
      // stream — that's the "everything sounds like speakerphone" effect.
      // A one-way voice note needs none of that call-oriented processing
      // (Whisper handles raw audio fine), so ask for plain media capture
      // and the phone stays in normal media mode even WHILE recording.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch {
      releaseCaptureSession(SESSION_OWNER);
      alert("Microphone access is required for voice notes.");
      return;
    }
    mediaRef.current = stream;
    chunksRef.current = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, pickMime() ? { mimeType: pickMime() } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(250); // chunked so nothing is lost on stop
    } catch (err) {
      // A recorder that cannot start must not keep the mic: a live track
      // left here holds the phone in communication mode, and on iOS can
      // make the next capture (a call) fail to open the mic at all.
      teardownAudio();
      alert(`Voice notes are not supported here (${(err as Error).name || "error"}).`);
      return;
    }
    recorderRef.current = recorder;

    startedAt.current = Date.now();
    pausedTotal.current = 0;
    setElapsed(0);
    setPhaseBoth("recording");
  }

  const cancel = useCallback(() => {
    if (phaseRef.current === "idle") return;
    chunksRef.current = [];
    teardownAudio();
    setPhaseBoth("idle");
  }, [setPhaseBoth]);

  const finish = useCallback(() => {
    if (phaseRef.current !== "recording" && phaseRef.current !== "paused") return;
    const recorder = recorderRef.current;
    if (!recorder) return;
    const durationMs = Date.now() - startedAt.current - pausedTotal.current;
    if (durationMs < MIN_NOTE_MS) {
      cancel();
      return;
    }
    const mime = recorder.mimeType || "audio/webm";
    setPhaseBoth("sending");
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];
      // Release the mic BEFORE the upload starts — the phone must leave
      // communication-audio mode the instant the recording ends, not when
      // the network round-trip finishes.
      mediaRef.current?.getTracks().forEach((t) => t.stop());
      mediaRef.current = null;
      recorderRef.current = null;
      releaseCaptureSession(SESSION_OWNER);
      const durationSec = Math.round(durationMs / 1000);

      // THE FIX. The recording goes to disk BEFORE any network
      // I/O. Everything after this line can fail — the network, the gateway,
      // the tab, the phone's battery — and the note is still there to send.
      // The owner lost a six-minute note twice because this write did not exist.
      const queued = await enqueueVoiceNote(bot, blob, durationSec);

      if (queued.persisted) {
        // The composer is free immediately: the outbox strip owns this note
        // now and shows it sending, queued or failed. The gateway BROADCASTS
        // the voice message (media attached) when it stores it, so the note
        // still arrives in the thread over the WS.
        setPhaseBoth("idle");
        void drainVoiceOutbox();
        return;
      }

      // FAIL OPEN (brief item 5). Storage refused the note — quota, private
      // mode, an evicted database. A storage fault must not cost a recording,
      // so this is exactly the old behaviour: one POST from memory, and the
      // alert if it fails. The outbox strip carries the warning that this
      // device has no safety net.
      const result = await uploadVoiceNote(bot, blob, durationSec, queued.id);
      if (!result.ok) alert(`Voice note failed: ${result.error}`);
      setPhaseBoth("idle");
    };
    try {
      recorder.stop();
    } catch {
      // recorder.stop() threw → onstop will never fire; without a full
      // teardown here the stream (and the phone's communication-audio
      // mode) leaks until the component unmounts.
      teardownAudio();
      setPhaseBoth("idle");
    }
  }, [bot, cancel, setPhaseBoth]);

  function togglePause(): void {
    if (phaseRef.current === "recording") {
      pausedAt.current = Date.now();
      try {
        recorderRef.current?.pause();
      } catch {}
      setPhaseBoth("paused");
    } else if (phaseRef.current === "paused") {
      pausedTotal.current += Date.now() - pausedAt.current;
      try {
        recorderRef.current?.resume();
      } catch {}
      setPhaseBoth("recording");
    }
  }

  useEffect(() => () => teardownAudio(), []);

  // Baseline: declare "playback" on mount. A previous visit's capture can
  // leave WebKit's session sticky in communication mode across reloads —
  // claiming playback here resets the whole phone's audio to full quality.
  // Not while a call holds the mic, though: see settleAudioSession.
  useEffect(() => {
    settleAudioSession();
  }, []);

  // Backgrounding the app mid-recording: iOS suspends the capture anyway,
  // and a "paused"/live stream held while hidden keeps the phone in
  // communication mode. Cancel and release instead of holding the mic.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && (phaseRef.current === "recording" || phaseRef.current === "paused")) {
        cancel();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [cancel]);

  if (phase === "idle") {
    return (
      <button
        type="button"
        className="composer-icon mic-live"
        title="Record a voice note"
        aria-label="Record voice note"
        onClick={() => void start()}
      >
        <IconMic />
      </button>
    );
  }

  if (phase === "sending") {
    return (
      <div className="recorder-strip" aria-live="polite">
        <span className="rec-dot transcribing" />
        <span className="mono-label">SENDING VOICE NOTE…</span>
      </div>
    );
  }

  // recording / paused — fixed layout (3d4):
  // [delete] [dot Recording…] [timer] …spacer… [pause/resume] [send]
  return (
    <div className="recorder-strip" aria-live="polite">
      <button type="button" className="composer-icon rec-cancel" onClick={cancel} aria-label="Delete recording" title="Delete">
        <IconTrash />
      </button>
      <span className={`rec-dot${phase === "paused" ? " paused" : ""}`} />
      <span className="rec-label">{phase === "paused" ? "Paused" : "Recording…"}</span>
      <span className="mono-label rec-timer">{formatTimer(elapsed)}</span>
      <div className="rec-right">
        <button
          type="button"
          className="rec-icon-btn"
          onClick={togglePause}
          aria-label={phase === "paused" ? "Resume recording" : "Pause recording"}
          title={phase === "paused" ? "Resume" : "Pause"}
        >
          {phase === "paused" ? <IconPlay /> : <IconPause />}
        </button>
        <button type="button" className="send-circle" onClick={finish} aria-label="Send voice note">
          <IconSend />
        </button>
      </div>
    </div>
  );
}
