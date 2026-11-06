import type { CallAudioOut } from "./turn-audio.js";

/* ============================================================
   echo-window.ts — when was the agent actually audible? (B2, 10/14)

   The echo filter (ack-gate.ts `looksLikeEcho`) used to compare words only,
   so a real instruction that reused the agent's words — at any time after
   his reply — was dropped as his own voice coming back through the mic.

   An echo has a timing signature words alone cannot fake: it BEGINS while
   the agent's audio is playing. This module keeps that clock per call, from
   the audio the server sends:

     - a turn's first audio opens a window at `from`;
     - each frame extends `until` by its own duration, played back to back
       (the listener schedules frames on its own clock, turn-audio.ts), so
       `until` is when the last sample finishes, not when it was sent;
     - a barge-in or a superseded turn closes it now: the listener cut it.

   An utterance whose speech began inside [from, until + tail] may be echo;
   one that began after the agent went quiet never is. `tail` covers the
   wire and the listener's jitter buffer between our clock and its speaker.
   ============================================================ */

/** Slack after the estimated end of playback (network + jitter buffer). */
export const ECHO_TAIL_MS = 1_200;

interface Window {
  from: number;
  until: number;
}

const windows = new Map<string, Window>();

/** A turn's audio starts: a new window, replacing the last turn's. */
export function beginPlayout(voiceStreamId: string, now: number = Date.now()): void {
  windows.set(voiceStreamId, { from: now, until: now });
}

/** `ms` more audio was sent; it plays after whatever is already queued. */
export function notePlayout(voiceStreamId: string, ms: number, now: number = Date.now()): void {
  const w = windows.get(voiceStreamId);
  if (!w) {
    windows.set(voiceStreamId, { from: now, until: now + ms });
    return;
  }
  w.until = Math.max(w.until, now) + ms;
}

/** The listener stopped playing (barge-in, supersede): nothing is audible past now. */
export function cutPlayout(voiceStreamId: string, now: number = Date.now()): void {
  const w = windows.get(voiceStreamId);
  if (w && w.until > now) w.until = now;
}

/** When the agent's audio sent so far finishes playing (ms epoch), or null with no window. */
export function playoutEndsAt(voiceStreamId: string): number | null {
  return windows.get(voiceStreamId)?.until ?? null;
}

export function forgetPlayout(voiceStreamId: string): void {
  windows.delete(voiceStreamId);
}

/**
 * Did speech that began at `speechStartAt` overlap the agent's audio? False
 * when there is no window or no start time: without evidence, it is not echo.
 */
export function heardDuringPlayout(voiceStreamId: string, speechStartAt: number | null | undefined, tailMs = ECHO_TAIL_MS): boolean {
  const w = windows.get(voiceStreamId);
  if (!w || speechStartAt == null) return false;
  return speechStartAt >= w.from && speechStartAt <= w.until + tailMs;
}

/** Wrap one turn's downlink so everything it plays is on this call's clock. */
export function withPlayoutClock(voiceStreamId: string, out: CallAudioOut, now: () => number = Date.now): CallAudioOut {
  let bytesPerMs = 0;
  return {
    ...out,
    start(sampleRate) {
      bytesPerMs = (sampleRate * 2) / 1000; // PCM s16le mono
      beginPlayout(voiceStreamId, now());
      out.start(sampleRate);
    },
    frame(pcm) {
      if (bytesPerMs > 0) notePlayout(voiceStreamId, pcm.length / bytesPerMs, now());
      out.frame(pcm);
    },
  };
}
