/* ============================================================
   ear.ts — layer 1 of addressed-speech detection: the listener's own ear.

   On STANDBY (voice/floor.ts on the gateway; mirrored here by `voice-floor`)
   the call sends no audio — except while this ear hears speech. ink-2 bills
   every second of audio it receives, silence included, so a standing call
   left on all day would cost $124 a month ungated and a few dollars gated
   (ALWAYS-ON-VOICE.md §5). Most of a workday is silence or non-speech; this
   is where that cost disappears.

   The classifier is the gateway's `voice-noise-classifier.ts`, moved to the
   client where the decision is made (it ran on the server hot path once,
   decided nothing, and was removed): an energy floor plus speech-band
   dominance (300–3400 Hz) over a short DFT. Here it runs once per 100 ms
   frame on the main thread — a fraction of a millisecond — never inside the
   worklet's audio callback.

   What leaves the device on standby, per utterance:
     pre-roll  the PRE_ROLL_FRAMES frames before speech was confirmed, so the
               onset — the wake name — is not clipped;
     speech    every frame while the ear hears speech;
     tail      TAIL_MS of room after the last speech frame (soft endings);
     pad       PAD_MS of DIGITAL SILENCE (zeros, not the room), so the
               recognizer's turn detection sees the utterance end and commits
               it; otherwise a gated stream never ends a turn.
   Everything else is held: counted, never sent. The counts go to the gateway
   log as `[voice-client] … ear …` so the saving is measured, not estimated.

   On an OPEN floor the ear is bypassed: audio streams continuously, as every
   call did before this, because the recognizer's native turn detection wants
   the real silences between his sentences.
   ============================================================ */

export const FRAME_MS = 100;
export const PRE_ROLL_FRAMES = 2;
export const TAIL_MS = 500;
export const PAD_MS = 1200;

const SAMPLE_RATE = 16_000;
const MIN_ENERGY = 0.018;
const MIN_DOMINANCE = 0.58;
const DFT_N = 256;
const LOW_HZ = 300;
const HIGH_HZ = 3400;

/* Twiddles for the speech-band bins only — computed once. */
const BINS: { cos: Float32Array; sin: Float32Array }[] = [];
const BIN_IN_BAND: boolean[] = [];
for (let k = 1; k < DFT_N / 2; k++) {
  const hz = (k * SAMPLE_RATE) / DFT_N;
  BIN_IN_BAND[k] = hz >= LOW_HZ && hz <= HIGH_HZ;
  const cos = new Float32Array(DFT_N);
  const sin = new Float32Array(DFT_N);
  for (let t = 0; t < DFT_N; t++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / (DFT_N - 1));
    const angle = (2 * Math.PI * k * t) / DFT_N;
    cos[t] = Math.cos(angle) * win;
    sin[t] = Math.sin(angle) * win;
  }
  BINS[k] = { cos, sin };
}

export interface EarClassification {
  isSpeech: boolean;
  energy: number;
  speechBandDominance: number;
  confidence: number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Speech or ambient, over one s16le frame. The gateway classifier's rule, verbatim. */
export function classifyFrame(pcm: ArrayBuffer | Int16Array): EarClassification {
  const i16 = pcm instanceof Int16Array ? pcm : new Int16Array(pcm);
  if (i16.length < 32) return { isSpeech: false, energy: 0, speechBandDominance: 0, confidence: 0 };
  let sum = 0;
  for (let i = 0; i < i16.length; i++) {
    const s = i16[i] / 32768;
    sum += s * s;
  }
  const energy = Math.sqrt(sum / i16.length);
  // Quiet frames never reach the DFT: the energy floor alone rejects them.
  if (energy < MIN_ENERGY) return { isSpeech: false, energy, speechBandDominance: 0, confidence: 0 };
  const n = Math.min(DFT_N, i16.length);
  const start = i16.length - n;
  let total = 0;
  let speech = 0;
  for (let k = 1; k < DFT_N / 2; k++) {
    const { cos, sin } = BINS[k];
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const s = i16[start + t] / 32768;
      re += s * cos[t];
      im -= s * sin[t];
    }
    const mag = re * re + im * im;
    total += mag;
    if (BIN_IN_BAND[k]) speech += mag;
  }
  const speechBandDominance = total > 0 ? speech / total : 0;
  const energyScore = clamp01((energy - MIN_ENERGY) / Math.max(MIN_ENERGY * 2.5, 0.001));
  const bandScore = clamp01((speechBandDominance - MIN_DOMINANCE) / Math.max(1 - MIN_DOMINANCE, 0.001));
  const confidence = clamp01(energyScore * 0.45 + bandScore * 0.55);
  return {
    isSpeech: speechBandDominance >= MIN_DOMINANCE && confidence >= 0.45,
    energy,
    speechBandDominance,
    confidence,
  };
}

export type EarPhase = "idle" | "speech" | "tail" | "pad";

export interface EarDecision {
  /** Frames to send now, in order: pre-roll first on an onset, then this one. */
  send: ArrayBuffer[];
  phase: EarPhase;
  /** True on the frame speech was first confirmed — the utterance's onset. */
  onset: boolean;
  /** True on the frame the pad finished — the utterance is closed. */
  closed: boolean;
}

export interface EarCounts {
  /** Frames sent because the ear heard speech (plus pre-roll and tail). */
  sentFrames: number;
  /** Zero frames sent to close utterances. */
  padFrames: number;
  /** Frames held on standby — never left the device. */
  heldFrames: number;
  utterances: number;
}

/** A frame of digital silence, 100 ms at 16 kHz s16le. Zeros are not the room. */
export function silentFrame(): ArrayBuffer {
  return new ArrayBuffer((SAMPLE_RATE * FRAME_MS) / 1000 * 2);
}

/**
 * The standby gate, fed every mic frame. Stateful: holds the pre-roll ring,
 * the tail and pad clocks, and the counts.
 */
export class Ear {
  private phase: EarPhase = "idle";
  private ring: ArrayBuffer[] = [];
  private quietMs = 0;
  private padMs = 0;
  readonly counts: EarCounts = { sentFrames: 0, padFrames: 0, heldFrames: 0, utterances: 0 };

  constructor(
    private readonly opts: { tailMs?: number; padMs?: number; preRollFrames?: number; classify?: (pcm: ArrayBuffer) => boolean } = {},
  ) {}

  get current(): EarPhase {
    return this.phase;
  }

  /** The floor opened or the call ended: forget the utterance in progress. */
  reset(): void {
    this.phase = "idle";
    this.ring = [];
    this.quietMs = 0;
    this.padMs = 0;
  }

  feed(pcm: ArrayBuffer, frameMs: number = FRAME_MS): EarDecision {
    const speech = this.opts.classify ? this.opts.classify(pcm) : classifyFrame(pcm).isSpeech;
    const tailMs = this.opts.tailMs ?? TAIL_MS;
    const padTotal = this.opts.padMs ?? PAD_MS;
    const pre = this.opts.preRollFrames ?? PRE_ROLL_FRAMES;

    if (this.phase === "idle") {
      if (!speech) {
        this.ring.push(pcm);
        if (this.ring.length > pre) this.ring.shift();
        this.counts.heldFrames++;
        return { send: [], phase: "idle", onset: false, closed: false };
      }
      const send = [...this.ring, pcm];
      this.ring = [];
      this.phase = "speech";
      this.quietMs = 0;
      this.counts.utterances++;
      this.counts.sentFrames += send.length;
      return { send, phase: "speech", onset: true, closed: false };
    }

    if (this.phase === "speech" || this.phase === "tail") {
      if (speech) {
        this.phase = "speech";
        this.quietMs = 0;
        this.counts.sentFrames++;
        return { send: [pcm], phase: "speech", onset: false, closed: false };
      }
      this.quietMs += frameMs;
      if (this.quietMs <= tailMs) {
        this.phase = "tail";
        this.counts.sentFrames++;
        return { send: [pcm], phase: "tail", onset: false, closed: false };
      }
      // The tail is over: close the utterance with silence the recognizer can end a turn on.
      this.phase = "pad";
      this.padMs = frameMs;
      this.counts.padFrames++;
      this.counts.heldFrames++;
      const done = this.padMs >= padTotal;
      if (done) this.phase = "idle";
      return { send: [silentFrame()], phase: done ? "idle" : "pad", onset: false, closed: done };
    }

    // pad
    if (speech) {
      // He went on (or someone did): back to speech, the pad so far is harmless.
      this.phase = "speech";
      this.quietMs = 0;
      this.counts.sentFrames++;
      return { send: [pcm], phase: "speech", onset: false, closed: false };
    }
    this.padMs += frameMs;
    this.counts.padFrames++;
    this.counts.heldFrames++;
    const done = this.padMs >= padTotal;
    if (done) this.phase = "idle";
    return { send: [silentFrame()], phase: done ? "idle" : "pad", onset: false, closed: done };
  }
}

/** Seconds the counts stand for, for the log line and the report. */
export function earSeconds(c: EarCounts, frameMs: number = FRAME_MS): { sentSec: number; padSec: number; heldSec: number } {
  const f = frameMs / 1000;
  return {
    sentSec: Number((c.sentFrames * f).toFixed(1)),
    padSec: Number((c.padFrames * f).toFixed(1)),
    heldSec: Number((c.heldFrames * f).toFixed(1)),
  };
}
