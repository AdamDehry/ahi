import { memo, useSyncExternalStore } from "react";
import type { MediaRef } from "../lib/types";
import { pauseVoice, playVoice, seekVoice, subscribeVoice, voicePlaying, voiceProgress } from "../lib/nowplaying";
import { formatDuration, formatSize, mediaUrl } from "../lib/mediaFormat";
import { IconDownload, IconPlay } from "./icons";

/**
 * An audio FILE — an mp3 Michael sends, a song the owner drops in. Not a
 * voice note: no waveform, no transcript, no speed chip. A file card with
 * its real name, size and duration, an inline play button and a Download
 * that hands the browser the original file under its original name.
 *
 * Playback goes through the same app-lifetime player as voice notes, so it
 * keeps playing while the row scrolls out of the virtualized thread, and
 * starting it pauses anything else that is playing.
 */
const AudioFile = memo(function AudioFile({ media }: { media: MediaRef }) {
  const playing = useSyncExternalStore(subscribeVoice, () => voicePlaying(media.id));
  const progress = useSyncExternalStore(subscribeVoice, () => voiceProgress(media.id));
  const url = mediaUrl(media.id);
  const meta = [formatDuration(media.durationSec), formatSize(media.size)].filter(Boolean).join(" · ");

  return (
    <div className="audio-file" data-media-id={media.id}>
      <button
        type="button"
        className={`af-play${playing ? " is-playing" : ""}`}
        aria-label={playing ? `Pause ${media.originalName}` : `Play ${media.originalName}`}
        onClick={(e) => {
          e.stopPropagation();
          if (playing) pauseVoice();
          else playVoice(media.id, url, 1);
        }}
      >
        {playing ? <span className="vn-pause-glyph" /> : <IconPlay />}
      </button>
      <div className="af-body">
        {/* BIDI: the name is plaintext so the extension never jumps. */}
        <span className="af-name">{media.originalName}</span>
        <div
          className="af-track"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            if (!r.width) return;
            const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            if (!playing && progress === 0) playVoice(media.id, url, 1);
            seekVoice(media.id, ratio, media.durationSec ?? 0);
          }}
        >
          <i style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
        </div>
        <span className="af-meta mono-label">{meta}</span>
      </div>
      <a
        className="af-download"
        href={`${url}?dl=1`}
        download={media.originalName}
        aria-label={`Download ${media.originalName}`}
        title="Download"
        onClick={(e) => e.stopPropagation()}
      >
        <IconDownload />
      </a>
    </div>
  );
});

export default AudioFile;
