// Mic capture worklet: downsample the context rate (usually 48k) to 16 kHz
// s16le mono and post 100 ms frames (1600 samples) to the main thread.
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;      // e.g. 3 at 48k
    this.acc = [];
    this.accLen = 0;
    this.FRAME = 1600;                    // 100 ms @ 16k
    this.phase = 0;
    this.calls = 0;                       // process() calls, for the two notes below
  }
  process(inputs) {
    // Two one-time notes for the main thread (the ElevenLabs side ear logs
    // them): the graph is being pulled at all, and — after ~1 s of pulls with
    // no channel — the source gives it nothing. Ignored by the native call.
    if (this.calls === 0) this.port.postMessage({ alive: true });
    this.calls++;
    const ch = inputs[0]?.[0];
    if (!ch) {
      if (this.calls === 375) this.port.postMessage({ noInput: true }); // 375 × 128 samples ≈ 1 s at 48k
      return true;
    }
    // simple averaging decimator — adequate for speech STT
    for (let i = 0; i < ch.length; i++) {
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const j = Math.max(0, i - Math.floor(this.ratio) + 1);
        let sum = 0, n = 0;
        for (let k = j; k <= i; k++) { sum += ch[k]; n++; }
        this.acc.push(sum / n);
        this.accLen++;
      }
    }
    while (this.accLen >= this.FRAME) {
      const frame = this.acc.slice(0, this.FRAME);
      this.acc = this.acc.slice(this.FRAME);
      this.accLen -= this.FRAME;
      const pcm = new Int16Array(this.FRAME);
      let energy = 0;
      for (let i = 0; i < this.FRAME; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        pcm[i] = s * 0x7fff;
        energy += s * s;
      }
      this.port.postMessage(
        { pcm: pcm.buffer, rms: Math.sqrt(energy / this.FRAME) },
        [pcm.buffer],
      );
    }
    return true;
  }
}
registerProcessor("mic-capture", MicCapture);
