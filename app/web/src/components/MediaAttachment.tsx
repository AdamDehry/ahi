import { memo } from "react";
import type { MediaRef } from "../lib/types";
import VoiceNote from "./VoiceNote";
import AudioFile from "./AudioFile";
import VideoFile from "./VideoFile";
import { IconFiles } from "./icons";

function mediaUrl(id: string): string {
  return `/ui/media/${encodeURIComponent(id)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Media per the deployed contract (AUDIT.md §2.4), in the design grammar:
 *  image = radius-card thumbnail; voice = the shared VoiceNote component
 *  (waveform fills the bar, speed control, collapsible transcript);
 *  document = file chip. */
const MediaAttachment = memo(function MediaAttachment({
  media,
  transcript,
}: {
  media: MediaRef;
  transcript?: string;
}) {
  if (media.type === "image") {
    const src = media.thumbnail ? `${mediaUrl(media.id)}/thumb` : mediaUrl(media.id);
    return (
      <a className="media-image" href={mediaUrl(media.id)} target="_blank" rel="noopener noreferrer">
        <img src={src} alt={media.originalName} loading="lazy" />
      </a>
    );
  }

  if (media.type === "voice") {
    return <VoiceNote media={media} transcript={transcript} />;
  }

  // Files, not notes: an audio file plays inline on its own card.
  if (media.type === "audio") return <AudioFile media={media} />;
  if (media.type === "video") return <VideoFile media={media} />;

  return (
    <a className="media-doc" href={`${mediaUrl(media.id)}?dl=1`} download={media.originalName}>
      <IconFiles />
      <span className="media-doc-name">{media.originalName}</span>
      <span className="mono-label">{formatSize(media.size)}</span>
    </a>
  );
});

export default MediaAttachment;
