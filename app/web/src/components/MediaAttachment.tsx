import { memo, useState } from "react";
import type { MediaRef } from "../lib/types";
import VoiceNote from "./VoiceNote";
import AudioFile from "./AudioFile";
import VideoFile from "./VideoFile";
import { IconFiles } from "./icons";
import ExpandedMedia from "./ExpandedMedia";
import { downloadUrl, formatSize, sharpenOnLoad, thumbSrc } from "../lib/mediaFormat";


/** Media per the deployed contract (AUDIT.md §2.4), in the design grammar:
 *  image = radius-card thumbnail that opens the viewer; voice = the shared VoiceNote component
 *  (waveform fills the bar, speed control, collapsible transcript);
 *  document = file chip. */
const MediaAttachment = memo(function MediaAttachment({
  media,
  transcript,
}: {
  media: MediaRef;
  transcript?: string;
}) {
  if (media.type === "image") return <ImageAttachment media={media} />;

  if (media.type === "voice") {
    return <VoiceNote media={media} transcript={transcript} />;
  }

  // Files, not notes: an audio file plays inline on its own card.
  if (media.type === "audio") return <AudioFile media={media} />;
  if (media.type === "video") return <VideoFile media={media} />;

  return (
    <a className="media-doc" href={downloadUrl(media.id)} download={media.originalName}>
      <IconFiles />
      <span className="media-doc-name">{media.originalName}</span>
      <span className="mono-label">{formatSize(media.size)}</span>
    </a>
  );
});

/** A lone picture: its fixed-height box, and a tap opens the full-screen viewer (as the sent grid does). */
function ImageAttachment({ media }: { media: MediaRef }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="media-image" onClick={() => setOpen(true)} aria-label={media.originalName}>
        <img src={thumbSrc(media)} alt={media.originalName} loading="lazy" onLoad={(e) => sharpenOnLoad(e, media.id)} />
      </button>
      {open && <ExpandedMedia items={[media]} startIndex={0} onClose={() => setOpen(false)} />}
    </>
  );
}

export default MediaAttachment;
