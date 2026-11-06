/* phone-audio.test.ts — the phone line's sound: G.711 μ-law and the two resamplers. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  decodeMulaw,
  Downsampler,
  downsamplerTapCount,
  encodeMulaw,
  linearToMulaw,
  mulawToLinear,
  MULAW_FRAME_BYTES,
  pcmView,
  Upsampler2x,
} from "../src/phone/audio.js";

function sine(freq: number, rate: number, seconds: number, amp = 12_000): Buffer {
  const n = Math.round(rate * seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  return b;
}

function rms(s: Int16Array, from = 0): number {
  let sum = 0;
  for (let i = from; i < s.length; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / Math.max(1, s.length - from));
}

/** Rising zero crossings per second — a cheap frequency estimate. */
function freqOf(s: Int16Array, rate: number, from = 0): number {
  let crossings = 0;
  for (let i = from + 1; i < s.length; i++) if (s[i - 1] < 0 && s[i] >= 0) crossings++;
  return (crossings * rate) / (s.length - from);
}

describe("phone audio: G.711 μ-law", () => {
  it("encodes the reference points of the standard", () => {
    assert.equal(linearToMulaw(0), 0xff, "silence is 0xFF");
    assert.equal(linearToMulaw(32767), 0x80, "full positive scale");
    assert.equal(linearToMulaw(-32768), 0x00, "full negative scale");
    assert.equal(mulawToLinear(0xff), 0);
    assert.equal(mulawToLinear(0x7f), 0);
  });

  it("decodes to the standard's magnitudes (top segment ±32124)", () => {
    assert.equal(mulawToLinear(0x80), 32124);
    assert.equal(mulawToLinear(0x00), -32124);
  });

  it("round-trips within μ-law's quantisation error, symmetric in sign", () => {
    for (const x of [1, 10, 100, 1_000, 5_000, 12_345, 30_000]) {
      for (const v of [x, -x]) {
        const back = mulawToLinear(linearToMulaw(v));
        // Segment step is 2^(exp+3); the error is at most half of it plus the bias rounding.
        const tol = Math.max(8, Math.abs(v) / 16);
        assert.ok(Math.abs(back - v) <= tol, `${v} → ${back}`);
      }
    }
    for (let b = 0; b < 256; b++) assert.equal(mulawToLinear(b) + mulawToLinear(b ^ 0x80), 0, `code ${b}`);
  });

  it("buffer codecs agree with the per-sample ones and keep length", () => {
    const pcm = sine(440, 8_000, 0.05);
    const ulaw = encodeMulaw(pcm);
    assert.equal(ulaw.length, pcm.length / 2);
    const back = decodeMulaw(ulaw);
    assert.equal(back.length, pcm.length);
    const a = pcmView(pcm);
    const b = pcmView(back);
    for (let i = 0; i < a.length; i++) assert.equal(b[i], mulawToLinear(linearToMulaw(a[i])));
  });

  it("a frame is 20 ms at 8 kHz", () => {
    assert.equal(MULAW_FRAME_BYTES, 160);
  });
});

describe("phone audio: downlink resampling to 8 kHz", () => {
  for (const rate of [48_000, 44_100, 24_000, 16_000]) {
    it(`${rate} Hz → 8 kHz keeps a 1 kHz tone (length, pitch, level)`, () => {
      const ds = new Downsampler(rate);
      const out = ds.push(sine(1_000, rate, 1));
      assert.ok(Math.abs(out.length - 8_000) <= 2, `got ${out.length} samples`);
      const settle = 100;
      assert.ok(Math.abs(freqOf(out, 8_000, settle) - 1_000) < 15, `pitch ${freqOf(out, 8_000, settle)}`);
      const level = rms(out, settle) / (12_000 / Math.SQRT2);
      assert.ok(level > 0.9 && level < 1.1, `level ${level}`);
    });
  }

  it("filters what the phone cannot carry: a 6 kHz tone does not alias into the band", () => {
    const out = new Downsampler(48_000).push(sine(6_000, 48_000, 0.5));
    // Unfiltered decimation would fold 6 kHz down to a full-level 2 kHz tone.
    assert.ok(rms(out, 100) < 12_000 * 0.05, `leak ${rms(out, 100)}`);
  });

  for (const rate of [48_000, 44_100, 24_000, 16_000]) {
    it(`${rate} Hz: 4.6 kHz (folds to 3.4 kHz) is crushed, 3.4 kHz speech is kept`, () => {
      const stop = new Downsampler(rate).push(sine(4_600, rate, 0.5));
      assert.ok(rms(stop, 200) < (12_000 / Math.SQRT2) * 10 ** (-60 / 20), `4.6 kHz leak ${rms(stop, 200)}`);
      const pass = new Downsampler(rate).push(sine(3_400, rate, 0.5));
      const level = rms(pass, 200) / (12_000 / Math.SQRT2);
      assert.ok(level > 0.9, `3.4 kHz level ${level}`);
    });
  }

  it("scales its taps with the input rate (odd, never fewer than 63)", () => {
    assert.equal(downsamplerTapCount(8_000), 63);
    assert.equal(downsamplerTapCount(16_000), 127);
    assert.equal(downsamplerTapCount(48_000), 379);
    assert.equal(downsamplerTapCount(44_100) % 2, 1);
  });

  it("is stateful: the same audio in odd-sized chunks equals it whole (no clicks at boundaries)", () => {
    const pcm = sine(700, 44_100, 0.3);
    const whole = new Downsampler(44_100).push(pcm);
    const ds = new Downsampler(44_100);
    const parts: number[] = [];
    let off = 0;
    for (const size of [2, 998, 3_000, 77 * 2, 9_000, 1_234]) {
      parts.push(...ds.push(pcm.subarray(off, Math.min(pcm.length, off + size))));
      off += size;
    }
    parts.push(...ds.push(pcm.subarray(off)));
    assert.equal(parts.length, whole.length);
    for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(parts[i] - whole[i]) <= 1, `sample ${i}`);
  });

  it("8 kHz in is passed through untouched", () => {
    const pcm = sine(300, 8_000, 0.05);
    assert.deepEqual([...new Downsampler(8_000).push(pcm)], [...pcmView(pcm)]);
  });
});

describe("phone audio: uplink 8 kHz → 16 kHz for the recognizer", () => {
  it("doubles the length, keeps every original sample, interpolates between them", () => {
    const pcm = sine(500, 8_000, 0.1);
    const up = new Upsampler2x();
    const out = pcmView(up.push(pcm));
    const src = pcmView(pcm);
    assert.equal(out.length, src.length * 2);
    for (let i = 1; i < src.length; i++) {
      assert.equal(out[i * 2 + 1], src[i]);
      assert.equal(out[i * 2], Math.round((src[i - 1] + src[i]) / 2));
    }
  });

  it("carries the last sample across chunks", () => {
    const up = new Upsampler2x();
    up.push(Buffer.from(Int16Array.from([0, 1000]).buffer));
    const out = pcmView(up.push(Buffer.from(Int16Array.from([3000]).buffer)));
    assert.deepEqual([...out], [2000, 3000]);
  });
});
