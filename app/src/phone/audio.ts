/* ============================================================
   phone/audio.ts — the phone line's sound: G.711 μ-law at 8 kHz, both ways.

   A Twilio Media Stream carries 8 kHz μ-law mono in 20 ms frames (160 bytes).
   The call core speaks and hears PCM s16le: the STT wants 16 kHz in, and the
   call voice comes out at whatever rate its provider streams (Cartesia 44.1k,
   ElevenLabs 48k, Gemini 24k). So:

     uplink   μ-law 8k → PCM 8k → ×2 → PCM 16k   (Upsampler2x, for the STT)
     downlink PCM Nk → low-pass + resample → PCM 8k → μ-law   (Downsampler)

   Why resample here rather than ask the TTS for `ulaw_8000`: the call's three
   voices reach us through three streaming clients that all hand the sequencer
   PCM (and the filler is rendered as PCM too). Converting at the transport
   keeps every one of them untouched and the phone a pure second transport.
   The cost is ~6M multiply-adds a second per call at 48 kHz (the taps scale with the input rate).

   Both resamplers are STATEFUL across chunks: TTS frames arrive in arbitrary
   sizes, and a filter that restarts per chunk clicks at every boundary.
   ============================================================ */

// ── G.711 μ-law ──────────────────────────────────────────────────────────

const BIAS = 0x84;
const CLIP = 32635;

/** One linear s16 sample → one μ-law byte (ITU-T G.711). */
export function linearToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One μ-law byte → one linear s16 sample. */
export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  // No -0: both zero codes (0xFF, 0x7F) decode to plain silence.
  return sign && magnitude ? -magnitude : magnitude;
}

const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) DECODE[i] = mulawToLinear(i);

/** μ-law bytes → PCM s16le at the same rate. */
export function decodeMulaw(ulaw: Buffer): Buffer {
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) out.writeInt16LE(DECODE[ulaw[i]], i * 2);
  return out;
}

/** PCM s16le → μ-law bytes at the same rate. */
export function encodeMulaw(pcm: Buffer | Int16Array): Buffer {
  const samples = pcm instanceof Int16Array ? pcm : pcmView(pcm);
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = linearToMulaw(samples[i]);
  return out;
}

/** A Buffer of s16le as samples (copied: Buffer offsets need not be aligned). */
export function pcmView(pcm: Buffer): Int16Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2);
  return out;
}

// ── Uplink: 8 kHz → 16 kHz ───────────────────────────────────────────────

/**
 * Doubles the rate by linear interpolation. The phone band stops at 3.4 kHz,
 * so there is nothing above 4 kHz to reconstruct; the STT only needs the
 * sample rate it was opened at.
 */
export class Upsampler2x {
  private last: number | null = null;

  push(pcm8k: Buffer): Buffer {
    const s = pcmView(pcm8k);
    const out = Buffer.alloc(s.length * 4);
    let prev = this.last ?? (s.length ? s[0] : 0);
    for (let i = 0; i < s.length; i++) {
      out.writeInt16LE(Math.round((prev + s[i]) / 2), i * 4);
      out.writeInt16LE(s[i], i * 4 + 2);
      prev = s[i];
    }
    if (s.length) this.last = s[s.length - 1];
    return out;
  }
}

// ── Downlink: N kHz → 8 kHz ──────────────────────────────────────────────

/** Windowed-sinc low-pass taps (Blackman), cutoff in cycles/sample. */
function lowpassTaps(cutoff: number, count: number): Float64Array {
  const taps = new Float64Array(count);
  const mid = (count - 1) / 2;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (count - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < count; i++) taps[i] /= sum;
  return taps;
}

/**
 * Taps scale with the input rate (63 per 8 kHz of input, odd), so the
 * transition band is the same width in Hz at every rate: measured −0.4 dB at
 * 3.4 kHz (speech kept), −78 dB at 4 kHz and −90 dB at 4.6 kHz (nothing folds
 * back into the band) at 48k, 44.1k, 24k and 16k alike. A fixed 63 taps gave
 * only −22 dB at 4.6 kHz and −4.3 dB at 3.4 kHz at 48k.
 */
const TAPS_PER_8K = 63;
export function downsamplerTapCount(inRate: number, outRate = 8_000): number {
  const n = Math.max(TAPS_PER_8K, Math.round((TAPS_PER_8K * inRate) / outRate));
  return n % 2 ? n : n + 1;
}
/** Pass band edge: the phone network carries up to ~3.4 kHz. */
const CUTOFF_HZ = 3_600;

/**
 * Any rate down to 8 kHz: an anti-alias low-pass at the input rate, then the
 * filtered signal is read at the output instants by linear interpolation.
 * Only the output instants are filtered (two taps-worth per output sample),
 * not every input sample.
 */
export class Downsampler {
  readonly inRate: number;
  readonly outRate: number;
  private readonly taps: Float64Array;
  private readonly tapCount: number;
  private readonly step: number;
  /** The last TAP_COUNT input samples, oldest first; absolute index of [0] is `base`. */
  private hist: Float64Array;
  private base: number;
  /** Next output instant, in absolute input-sample units. */
  private t = 0;
  private readonly passthrough: boolean;

  constructor(inRate: number, outRate = 8_000) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error(`bad rates ${inRate}→${outRate}`);
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    this.passthrough = inRate === outRate;
    this.tapCount = downsamplerTapCount(inRate, outRate);
    this.taps = lowpassTaps(Math.min(CUTOFF_HZ, outRate * 0.45) / inRate, this.tapCount);
    this.hist = new Float64Array(this.tapCount);
    this.base = -this.tapCount;
  }

  /** PCM s16le at `inRate` → PCM samples at `outRate`. */
  push(pcm: Buffer): Int16Array {
    const input = pcmView(pcm);
    if (this.passthrough) return input;
    const x = new Float64Array(this.hist.length + input.length);
    x.set(this.hist, 0);
    for (let i = 0; i < input.length; i++) x[this.hist.length + i] = input[i];
    const total = this.base + x.length; // absolute index one past the last sample
    const out: number[] = [];
    const filtered = (n: number): number => {
      // y[n] = Σ taps[k]·x[n-k]; history is zero before the first sample.
      let acc = 0;
      for (let k = 0; k < this.tapCount; k++) {
        const j = n - k - this.base;
        if (j >= 0) acc += this.taps[k] * x[j];
      }
      return acc;
    };
    while (Math.floor(this.t) + 1 <= total - 1) {
      const i = Math.floor(this.t);
      const frac = this.t - i;
      const y = frac === 0 ? filtered(i) : filtered(i) * (1 - frac) + filtered(i + 1) * frac;
      out.push(Math.max(-32768, Math.min(32767, Math.round(y))));
      this.t += this.step;
    }
    // Keep enough history for the next output's filter window.
    const keep = Math.min(this.tapCount + 1, x.length);
    this.hist = x.slice(x.length - keep);
    this.base = total - keep;
    return Int16Array.from(out);
  }
}

/** μ-law frame size Twilio plays: 20 ms at 8 kHz. */
export const MULAW_FRAME_BYTES = 160;
