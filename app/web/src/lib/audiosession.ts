/* ============================================================
   audiosession.ts — the one owner of iOS's page audio session.

   WebKit (iOS 17+) exposes navigator.audioSession so a page can DECLARE
   its audio mode instead of letting WebKit guess (Step 8 mic fix,
   2026-07-13): "play-and-record" while the mic is open, "playback" the
   rest of the time, so a PWA that captured once does not leave the whole
   phone in tinny communication mode.

   The declaration is a hard override, not a hint. WebKit applies the
   page's type ahead of everything else, INCLUDING an active capture
   (MediaSessionManagerCocoa.mm: `if (categoryOverride != None) category =
   categoryOverride;` comes before the capture branch). With "playback"
   declared, iOS gets a playback-only session, there is no input device,
   and getUserMedia fails with NotAllowedError ("No AVAudioSessionCapture
   Device") even though permission was granted. That is why a family member's
   iPhone recorded voice notes fine but every call said MICROPHONE
   BLOCKED: the note recorder declared "play-and-record" before opening
   the mic, the call never did, and the recorder had declared "playback"
   the moment the chat mounted.

   So every capture path claims the session here, and the resting
   "playback" is only declared when nobody holds the mic. No-op on
   browsers without the API (desktop, Android Chrome).
   ============================================================ */

export type AudioSessionKind = "auto" | "playback" | "play-and-record";

interface AudioSessionLike {
  type: string;
}

function session(): AudioSessionLike | undefined {
  return (globalThis.navigator as { audioSession?: AudioSessionLike } | undefined)?.audioSession;
}

function setType(kind: AudioSessionKind): void {
  const s = session();
  if (!s) return;
  try {
    s.type = kind;
  } catch {
    /* older WebKit builds may reject unknown values — never fatal */
  }
}

/** The page's declared type, or null where the API does not exist. */
export function audioSessionType(): string | null {
  return session()?.type ?? null;
}

const holders = new Set<string>();

/**
 * Declare "play-and-record" for `owner` (the note recorder, a call). Must
 * run BEFORE getUserMedia — on iOS a capture started under "playback" has
 * no input device.
 */
export function claimCaptureSession(owner: string): void {
  holders.add(owner);
  setType("play-and-record");
}

/** `owner` closed its mic. The phone goes back to playback once nobody holds it. */
export function releaseCaptureSession(owner: string): void {
  holders.delete(owner);
  if (holders.size === 0) setType("playback");
}

/**
 * The resting declaration (app mount): "playback", unless a capture is
 * live — a recorder mounting mid-call must not pull the call's mic away.
 */
export function settleAudioSession(): void {
  if (holders.size === 0) setType("playback");
}

/** Test seam. */
export function resetAudioSessionForTest(): void {
  holders.clear();
}
