export interface VoiceNoiseClassification {
  isSpeech: boolean;
  confidence: number;
  energy: number;
  speechBandDominance: number;
}

export interface VoiceNoiseOptions {
  sampleRate?: number;
  minEnergy?: number;
  minSpeechBandDominance?: number;
}

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_MIN_ENERGY = 0.018;
const DEFAULT_MIN_DOMINANCE = 0.58;

/**
 * Lightweight speech-vs-ambient classifier.
 *
 * Input may be Float32 PCM (-1..1), Int16 PCM, or raw s16le bytes. The
 * classifier intentionally stays dependency-free: energy floor + speech-band
 * dominance (300-3400Hz) is enough to reject most short ambient transients
 * before they cut off TTS playback.
 */
export function classifyVoiceNoise(
  input: Float32Array | Int16Array | ArrayBuffer | Buffer,
  opts: VoiceNoiseOptions = {},
): VoiceNoiseClassification {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const minEnergy = opts.minEnergy ?? DEFAULT_MIN_ENERGY;
  const minDominance = opts.minSpeechBandDominance ?? DEFAULT_MIN_DOMINANCE;
  const samples = toFloat32(input);
  if (samples.length < 32) {
    return { isSpeech: false, confidence: 0, energy: 0, speechBandDominance: 0 };
  }

  const energy = rms(samples);
  const speechBandDominance = bandDominance(samples, sampleRate, 300, 3400);
  const energyScore = clamp01((energy - minEnergy) / Math.max(minEnergy * 2.5, 0.001));
  const bandScore = clamp01((speechBandDominance - minDominance) / Math.max(1 - minDominance, 0.001));
  const confidence = clamp01(energyScore * 0.45 + bandScore * 0.55);
  return {
    isSpeech: energy >= minEnergy && speechBandDominance >= minDominance && confidence >= 0.45,
    confidence,
    energy,
    speechBandDominance,
  };
}

function toFloat32(input: Float32Array | Int16Array | ArrayBuffer | Buffer): Float32Array {
  if (input instanceof Float32Array) return input;
  if (input instanceof Int16Array) {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = input[i] / 32768;
    return out;
  }
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const out = new Float32Array(Math.floor(buf.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function bandDominance(samples: Float32Array, sampleRate: number, lowHz: number, highHz: number): number {
  const n = Math.min(512, nextPowerOfTwo(samples.length));
  if (n < 32) return 0;
  const start = Math.max(0, samples.length - n);
  let total = 0;
  let speech = 0;
  for (let k = 1; k < n / 2; k++) {
    const hz = (k * sampleRate) / n;
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / (n - 1));
      const angle = (2 * Math.PI * k * t) / n;
      const s = samples[start + t] * win;
      re += s * Math.cos(angle);
      im -= s * Math.sin(angle);
    }
    const mag = re * re + im * im;
    total += mag;
    if (hz >= lowHz && hz <= highHz) speech += mag;
  }
  return total > 0 ? speech / total : 0;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
