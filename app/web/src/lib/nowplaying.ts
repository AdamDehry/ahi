/** Single global "now playing" (3d2 §9d): starting any audio pauses
 *  whatever else is playing — voice notes and the TTS reply alike. */
let current: HTMLAudioElement | null = null;

export function claimPlayback(audio: HTMLAudioElement): void {
  if (current && current !== audio && !current.paused) current.pause();
  current = audio;
}

// ── Singleton voice-note player (Step 5 #0) ─────────────────────────
//
// The chat is a virtualized list: rows unmount the moment they scroll
// out of the window. When each VoiceNote owned its <audio>, unmount
// killed playback mid-listen. The audio element now lives HERE, for the
// app lifetime; VoiceNote is a thin subscriber that renders whatever
// this store says about its media id. Exactly ONE module audio ever
// exists, and it participates in claimPlayback like any other player
// (TTS ⇄ voice-note cross-pause unchanged).
let audio: HTMLAudioElement | null = null;
let currentId: string | null = null;
let playing = false;
let progress = 0; // 0..1 for the currentId note
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function subscribeVoice(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Primitive selectors — useSyncExternalStore-safe (no snapshot objects,
// so no referential-identity churn between emits).
export function voiceCurrentId(): string | null {
  return currentId;
}
export function voicePlaying(id: string): boolean {
  return playing && currentId === id;
}
export function voiceProgress(id: string): number {
  return currentId === id ? progress : 0;
}

export function playVoice(id: string, url: string, speed: number): void {
  if (currentId !== id) {
    audio?.pause();
    audio = new Audio(url);
    currentId = id;
    progress = 0;
    audio.addEventListener("timeupdate", () => {
      if (audio!.duration) {
        progress = audio!.currentTime / audio!.duration;
        emit();
      }
    });
    audio.addEventListener("ended", () => {
      playing = false;
      progress = 0;
      emit();
    });
    // Reflect EXTERNAL pauses too — another note or the TTS player
    // claiming playback pauses this element (3d2 §9d).
    audio.addEventListener("pause", () => {
      playing = false;
      emit();
    });
  }
  audio!.playbackRate = speed;
  claimPlayback(audio!); // one player at a time, notes + TTS alike
  void audio!.play()
    .then(() => {
      playing = true;
      emit();
    })
    .catch(() => {
      playing = false;
      emit();
    });
}

export function pauseVoice(): void {
  audio?.pause(); // the 'pause' listener flips state + emits
}

/** Seek within the ACTIVE note only — an idle note's bar is not a
 *  scrubber for someone else's playback. */
export function seekVoice(id: string, ratio: number, fallbackDur: number): void {
  if (currentId !== id || !audio) return;
  const dur = audio.duration || fallbackDur || 0;
  if (dur) {
    audio.currentTime = ratio * dur;
    progress = ratio;
    emit();
  }
}

/** Live speed change for whatever is playing (global speed chip). */
export function setActiveRate(rate: number): void {
  if (audio) audio.playbackRate = rate;
}
