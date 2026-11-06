/**
 * In-app notification cues (the owner's Settings ruling: "you have specific sounds"). Synthesised with Web
 * Audio, so nothing is downloaded. They play inside the open app when new activity reaches the inbox, and once
 * as a preview when one is picked. Device alerts keep the device's own sound (web push can't choose one).
 */
type Note = [freq: number, at: number, dur: number, gain: number, type?: OscillatorType];
const TONES: Record<string, Note[]> = {
  Chime: [[880, 0, 0.35, 0.18], [1318.5, 0.09, 0.45, 0.12]],
  Glass: [[1567.98, 0, 0.5, 0.12, "triangle"], [2093, 0.05, 0.6, 0.06, "sine"]],
  Pulse: [[660, 0, 0.09, 0.16, "square"], [660, 0.15, 0.09, 0.16, "square"]],
  Bell: [[523.25, 0, 0.9, 0.16], [1046.5, 0, 0.6, 0.07], [1569, 0, 0.35, 0.04]],
};
export const TONE_NAMES = Object.keys(TONES);

let ctx: AudioContext | null = null;
export function playTone(name: string): void {
  const notes = TONES[name] ?? TONES.Chime;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, at, dur, gain, type = "sine"] of notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(gain, t0 + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.05);
    }
  } catch {
    /* no audio (blocked or unsupported): a cue is never required */
  }
}
