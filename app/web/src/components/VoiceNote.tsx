import { memo, useEffect, useState, useSyncExternalStore } from "react";
import type { MediaRef } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import {
  pauseVoice,
  playVoice,
  seekVoice,
  setActiveRate,
  subscribeVoice,
  voiceCurrentId,
  voicePlaying,
  voiceProgress,
} from "../lib/nowplaying";
import { IconPlay } from "./icons";

function mediaUrl(id: string): string {
  return `/ui/media/${encodeURIComponent(id)}`;
}

function formatDuration(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Global playback speed (3d2#8): ONE persisted app-wide default.
// Changing it on any note updates every note from then on.
const SPEEDS = [1, 1.5, 2];
const SPEED_KEY = "ahi-voice-speed";
const speedListeners = new Set<() => void>();

function getGlobalSpeed(): number {
  const raw = Number(localStorage.getItem(SPEED_KEY));
  return SPEEDS.includes(raw) ? raw : 1;
}

function cycleGlobalSpeed(): number {
  const next = SPEEDS[(SPEEDS.indexOf(getGlobalSpeed()) + 1) % SPEEDS.length];
  localStorage.setItem(SPEED_KEY, String(next));
  for (const l of speedListeners) l();
  return next;
}

function useGlobalSpeed(): number {
  return useSyncExternalStore(
    (fn) => {
      speedListeners.add(fn);
      return () => speedListeners.delete(fn);
    },
    getGlobalSpeed,
  );
}

/** Deterministic decorative waveform — heights derived from the media id.
 *  FIXED count + fixed gap per device (3d2#7): every note on a given
 *  device renders the exact same layout. Counts land the flexed bars on
 *  the v2 3px-bar/1.5px-gap density (2B literally draws 30 on mobile). */
const BAR_COUNT = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches ? 30 : 56;

function waveHeights(id: string, n = BAR_COUNT): number[] {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Array.from({ length: n }, () => {
    h = (h * 1103515245 + 12345) >>> 0;
    return 5 + (h % 13);
  });
}

/**
 * The shared voice-note component:
 *  - fixed-width bar (min(--voice-note-max, 100%)), left-aligned fixed
 *    waveform geometry — identical for agent and user variants, and
 *    unaffected by transcript expand/collapse (3d2#7)
 *  - playback speed: global persisted default, chip visible only while
 *    the note is playing (3d2#8)
 *  - collapsible markdown transcript (3c#3 / 3c2#1)
 *
 * Step 5 #0: the component owns NO audio. Playback lives in the
 * nowplaying singleton so it survives Virtuoso unmounting this row —
 * scrolling away keeps the sound; scrolling back re-syncs the waveform
 * and pause glyph from the store.
 */
const VoiceNote = memo(function VoiceNote({ media, transcript }: { media: MediaRef; transcript?: string }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const speed = useGlobalSpeed();

  const playing = useSyncExternalStore(subscribeVoice, () => voicePlaying(media.id));
  const progress = useSyncExternalStore(subscribeVoice, () => voiceProgress(media.id));

  // A speed change (from ANY note) applies to the active playback live.
  useEffect(() => {
    if (voiceCurrentId() === media.id) setActiveRate(speed);
  }, [speed, media.id]);

  function toggle() {
    if (playing) pauseVoice();
    else playVoice(media.id, mediaUrl(media.id), getGlobalSpeed());
  }

  function seek(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    seekVoice(media.id, ratio, media.durationSec ?? 0);
  }

  const bars = waveHeights(media.id);
  const playedUntil = Math.round(progress * bars.length);
  const text = (transcript ?? media.transcript ?? "").trim();

  return (
    <div className="voice-note">
      <div className="vn-bar">
        <button type="button" className="vn-play" onClick={toggle} aria-label={playing ? "Pause voice note" : "Play voice note"}>
          {playing ? <span className="vn-pause-glyph" /> : <IconPlay />}
        </button>
        <button type="button" className="vn-wave" onClick={seek} aria-label="Seek">
          {bars.map((h, i) => (
            <i key={i} style={{ height: `${h}px` }} className={i < playedUntil ? "played" : ""} />
          ))}
        </button>
        <span className="mono-label vn-dur">{formatDuration(media.durationSec) || "VOICE"}</span>
        {/* The chip SLOT is permanently reserved (3d2 §9): the button is
            always in layout and only fades in while playing — waveform,
            duration, and the TRANSCRIPT label never move. */}
        <button
          type="button"
          className={`vn-speed mono-label${playing ? " on" : ""}`}
          onClick={playing ? cycleGlobalSpeed : undefined}
          tabIndex={playing ? 0 : -1}
          aria-hidden={!playing}
          aria-label="Playback speed"
        >
          {speed}×
        </button>
      </div>
      {text && (
        <>
          <button
            type="button"
            className="vn-transcript-toggle mono-label"
            onClick={() => setShowTranscript(!showTranscript)}
            aria-expanded={showTranscript}
          >
            <span className={`vn-chevron${showTranscript ? " open" : ""}`} />
            TRANSCRIPT
          </button>
          {showTranscript && (
            <div className="vn-transcript msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
          )}
        </>
      )}
    </div>
  );
});

export default VoiceNote;
