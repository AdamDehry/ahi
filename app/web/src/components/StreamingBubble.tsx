import { memo } from "react";
import type { StreamState } from "../store";
import { BOT_LABELS } from "../lib/types";
import { renderStreamingMarkdown } from "../lib/markdown";

/**
 * A live streaming reply — same bare-text agent grammar as a completed
 * message, plus the blinking brass caret and mono tool chips (design:
 * "the working state is part of the identity, not a spinner"). The
 * stable markdown prefix renders from the memo cache; only the growing
 * tail block re-parses per chunk (lib/markdown.ts).
 */
const StreamingBubble = memo(function StreamingBubble({ stream }: { stream: StreamState }) {
  const { stableHtml, tailHtml } = renderStreamingMarkdown(stream.text);
  const label = BOT_LABELS[stream.bot] ?? stream.bot;

  return (
    <div className={`agent-run streaming${stream.error ? " errored" : ""}`}>
      <div className="agent-sig">
        <span className="agent-dot" data-bot={stream.bot} />
        <span className="agent-name" data-bot={stream.bot}>
          {label}
        </span>
        <span className="agent-time mono-label">NOW</span>
      </div>
      <div className="msg-text">
        {stableHtml && <span dangerouslySetInnerHTML={{ __html: stableHtml }} />}
        {tailHtml && <span dangerouslySetInnerHTML={{ __html: tailHtml }} />}
        {!stream.done && <span className="stream-caret" />}
      </div>
      {stream.error && <div className="stream-error mono-label">{stream.error.toUpperCase()}</div>}
      {stream.tools.length > 0 && (
        <div className="tool-chips">
          {stream.tools.map((t) => (
            <span key={t} className="tool-chip">
              {t.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

export default StreamingBubble;
