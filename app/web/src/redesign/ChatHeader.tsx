/**
 * Conversation header (slice 2): avatar, name, role with the live connection
 * dot and word (FP-005, kept from the old top bar), and Gallery (Media,
 * Files, Links — FP-061). On a phone the top-left Search opens the full-width
 * agent picker (FINAL: no permanent agent strip on mobile).
 */
import { actions, useAppState } from "../store";
import { connectionDisplay } from "../lib/connection";
import { BOT_LABELS, BOT_SUBTITLES } from "../lib/types";
import { Icon } from "./icons";
import { IconMedia } from "../components/icons";
import { AgentAvatar } from "./AgentRail";

export default function ChatHeader({ bot, phone = false }: { bot: string; phone?: boolean }) {
  const s = useAppState();
  const { label, dot } = connectionDisplay(s.connection, s.restartingAt);
  const online = dot === "open";
  return (
    <header className={`rd-chat-header${phone ? " phone" : ""}`}>
      {phone && (
        <button type="button" className="rd-chat-control" aria-label="Choose an agent" onClick={actions.popMobile}>
          <Icon name="search" />
        </button>
      )}
      <div className="rd-chat-identity">
        <AgentAvatar bot={bot} />
        <div>
          <div className="rd-chat-name">{BOT_LABELS[bot] ?? bot}</div>
          <div className="rd-chat-role">
            <span className={`rd-status-dot ${dot}`} aria-hidden="true" />
            {online ? BOT_SUBTITLES[bot] ?? "Agent" : <span className="rd-status-word">{label.toLowerCase()}</span>}
          </div>
        </div>
      </div>
      <button
        type="button"
        className={`rd-chat-control${s.mediaPanelOpen ? " on" : ""}`}
        aria-label="Media, files and links"
        aria-pressed={s.mediaPanelOpen}
        onClick={() => actions.toggleMediaPanel()}
      >
        {/* The original rounded gallery mark from the current app (FINAL took it from there). */}
        <IconMedia />
      </button>
    </header>
  );
}
