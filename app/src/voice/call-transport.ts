import type { CallAudioOut } from "./turn-audio.js";
import type { MouthPriority } from "./mouth.js";

/* ============================================================
   call-transport.ts — one call core, two ways to reach it.

   A call is the same thing whether the owner is in the app or on the phone: one
   recognizer, one turn composer, one turn gate, the same brain, memory and
   voice. What differs is only the wire:

     app    — the PWA's WebSocket: binary PCM 16 kHz up, binary PCM + JSON
              control events down (websocket.ts, appTransport);
     phone  — a Twilio Media Stream: μ-law 8 kHz both ways, and no screen
              (phone/stream.ts).

   So a call talks to its listener through a `CallTransport`, and the
   listener talks to the call through the `CallAudioIn` that `openCall`
   (websocket.ts) hands back:

     audioIn   CallAudioIn       transport → core: caller audio, utterance
                                 end, barge-in, hang-up
     audioOut  CallAudioOut      core → transport: one turn's speech
                                 (turn-audio.ts)
     event     JSON events       core → transport: voice-thinking,
                                 stream-chunk, stt-interim/final, voice-error…
                                 The app renders them; the phone uses the few
                                 it can (spoken text for its echo guard, a
                                 text-only reply to say aloud) and drops the rest.
   ============================================================ */

export type CallTransportKind = "app" | "phone";

export interface CallTransport {
  readonly kind: CallTransportKind;
  /** A control event toward the listener. */
  event(msg: Record<string, unknown>): void;
  /**
   * A lane of the call's one mouth (voice/mouth.ts) for one piece of speech:
   * it goes on air when nothing else is audible, in `priority` order, and a
   * barge-in cancels it by `turnId`. Default priority "turn".
   */
  audioOut(ids: CallSpeechIds): CallAudioOut;
  /**
   * Per-turn invoke additions this surface needs (the phone's own rules).
   * Absent on the app: its turns are exactly as before.
   */
  turnHints?(): CallTurnHints | null;
}

export interface CallSpeechIds {
  voiceStreamId: string;
  bot: string;
  /** The turn this speech belongs to (a fixed line: its own id). */
  turnId?: string;
  priority?: MouthPriority;
  /** For the log: "turn", "command", "status"… */
  label?: string;
  /** A fixed line's text (it has no word timings): what the echo rule hears played. */
  text?: string;
}

export interface CallTurnHints {
  /** Appended to the system prompt, never to the spoken message. */
  extraSystemHint?: string;
  /** Tool patterns denied on this surface on top of the agent's own. */
  disallowedTools?: string[];
}

/** The uplink half of a call — what a transport drives. */
export interface CallAudioIn {
  readonly voiceStreamId: string;
  /** Caller audio: PCM s16le, 16 kHz, mono. */
  audio(pcm: Buffer): void;
  /**
   * The transport's own VAD heard an utterance end. Advisory for native-turn
   * recognizers (ink-2, openai); the boundary itself for Google.
   */
  endUtterance(): Promise<void>;
  /**
   * The transport's own VAD heard him start again. Its end of speech before
   * this was a pause, not the end: the turn's clock must not count from it
   * (voice step 5 — the phone's VAD ends on a soft pause the recognizer
   * talks through, and the hold counted from his FIRST pause).
   */
  speechResumed?(): void;
  /** The caller talked over the reply: stop generating and stop speaking. */
  interrupt(): void;
  /**
   * The call is over. Writes its card if it had turns. `why` is the
   * transport's reason token for the end line (`caller-hung-up`,
   * `door-lost`…); absent reads as `hangup`.
   */
  hangup(why?: string): Promise<void>;
  /**
   * The transport's door broke and came back on the same call (voice step 2:
   * a phone stream re-attached). Counted on the call's end line, as the
   * app's resumes are.
   */
  reattached?(gapMs: number): void;
}
