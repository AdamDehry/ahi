/* ============================================================
   vad.ts — ported from the voice-mode simulator.

   Minimal RMS voice-activity detector over PCM s16le frames. Two jobs:

     1. Non-native-turn STT paths (Google / OpenAI) — decide end-of-thought
        from sustained silence after speech.
     2. Barge-in — detect speech onset while the agent is speaking.

   Deliberately simple: energy + hangover. The browser applies
   echoCancellation, so agent playback should not re-enter the mic at
   barge-triggering levels. (That assumption is exactly what the owner's S25
   open-speaker device test in the merge brief is there to prove.)

   Note the gateway already ships `voice-noise-classifier.ts`, which answers a
   different question — "is this frame speech or ambient room noise" — over a
   single buffer. This is a stateful utterance tracker; the two compose.
   ============================================================ */

export type VadEvent = "onset" | "end";

export interface VadOptions {
  /** RMS (0..1) above which a frame counts as speech. */
  threshold?: number;
  /** Sustained silence that ends an utterance. */
  silenceMs?: number;
  /** Consecutive speech frames required to confirm onset. */
  onsetFrames?: number;
}

export class Vad {
  private readonly threshold: number;
  private readonly silenceMs: number;
  private readonly onsetFrames: number;

  speaking = false;
  private consecSpeech = 0;
  private lastSpeechAt = 0;
  utteranceStartedAt = 0;

  constructor({ threshold = 0.012, silenceMs = 850, onsetFrames = 3 }: VadOptions = {}) {
    this.threshold = threshold;
    this.silenceMs = silenceMs;
    this.onsetFrames = onsetFrames;
    this.reset();
  }

  reset(): void {
    this.speaking = false;
    this.consecSpeech = 0;
    this.lastSpeechAt = 0;
    this.utteranceStartedAt = 0;
  }

  /** RMS of a PCM s16le buffer, normalized to 0..1. */
  static rms(buf: Buffer): number {
    const n = Math.floor(buf.length / 2);
    if (n === 0) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const s = buf.readInt16LE(i * 2) / 32768;
      sum += s * s;
    }
    return Math.sqrt(sum / n);
  }

  /**
   * Feed one frame. Returns an event or null:
   *   "onset" — speech confirmed after silence (utterance began / barge-in)
   *   "end"   — utterance ended (silence held for silenceMs after speech)
   */
  feed(frame: Buffer, nowMs: number = Date.now()): VadEvent | null {
    const energy = Vad.rms(frame);
    const isSpeech = energy >= this.threshold;

    if (isSpeech) {
      this.consecSpeech += 1;
      this.lastSpeechAt = nowMs;
      if (!this.speaking && this.consecSpeech >= this.onsetFrames) {
        this.speaking = true;
        this.utteranceStartedAt = nowMs;
        return "onset";
      }
      return null;
    }

    this.consecSpeech = 0;
    if (this.speaking && nowMs - this.lastSpeechAt >= this.silenceMs) {
      this.speaking = false;
      return "end";
    }
    return null;
  }
}
