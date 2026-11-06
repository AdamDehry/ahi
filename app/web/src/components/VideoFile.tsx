import { memo } from "react";
import type { MediaRef } from "../lib/types";
import { downloadUrl, formatDuration, formatSize, mediaUrl } from "../lib/mediaFormat";
import { IconDownload } from "./icons";

/**
 * A video FILE: plays inline with the browser's own controls, fixed
 * height so the virtualized thread never re-measures when it loads (same rule
 * as .media-image), poster from the server's first-frame thumbnail.
 */
const VideoFile = memo(function VideoFile({ media }: { media: MediaRef }) {
  const meta = [formatDuration(media.durationSec), formatSize(media.size)].filter(Boolean).join(" · ");
  return (
    <div className="video-file" data-media-id={media.id}>
      <video
        src={mediaUrl(media.id)}
        poster={media.thumbnail ? `${mediaUrl(media.id)}/thumb` : undefined}
        controls
        preload="metadata"
        playsInline
      />
      <div className="vf-foot">
        <span className="af-name">{media.originalName}</span>
        <span className="af-meta mono-label">{meta}</span>
        <a className="af-download" href={downloadUrl(media.id)} download={media.originalName} aria-label={`Download ${media.originalName}`} title="Download">
          <IconDownload />
        </a>
      </div>
    </div>
  );
});

export default VideoFile;
