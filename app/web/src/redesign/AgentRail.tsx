/**
 * Messages agent rail (slice 2, FINAL): one icon per agent you may message, the open one marked. Search
 * widens this same rail in place, as the concept (recording 2): the search field on top, each
 * avatar stretched to its name, last message and time, no second panel over the page; closing it (or
 * choosing an agent, or Esc) folds it back to icons. One durable conversation per agent — no named threads.
 */
import { useEffect, useRef, useState } from "react";
import { actions, availableBots, lastMessage, useAppState } from "../store";
import { agentMatches, previewText, relativeTime } from "../components/Sidebar";
import { BOT_LABELS } from "../lib/types";
import { Icon } from "./icons";
import { agentInitials, railOrder } from "./agents";

export function AgentAvatar({ bot, size = "md" }: { bot: string; size?: "md" | "sm" | "xs" }) {
  return (
    <span className={`rd-avatar ${size}`} data-bot={bot} aria-hidden="true">
      {agentInitials(bot)}
    </span>
  );
}

export default function AgentRail({ activeBot }: { activeBot: string | null }) {
  const { user, threads } = useAppState();
  const bots = railOrder(availableBots(user));
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const collapse = () => {
    setExpanded(false);
    setQuery("");
    requestAnimationFrame(() => toggleRef.current?.focus());
  };
  useEffect(() => {
    if (!expanded) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && collapse();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);
  const shown = bots.filter((b) => agentMatches(threads, b, query));
  return (
    <aside className={`rd-agent-rail${expanded ? " expanded" : ""}`} aria-label="Agents">
      <div className="rd-agent-rail-search">
        {expanded ? (
          <div className="rd-agent-search-field" role="search">
            <button type="button" className="rd-chat-control" aria-label="Collapse agent search" onClick={collapse}>
              <Icon name="arrow-left" />
            </button>
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats…" aria-label="Search agent chats" />
            <Icon name="search" />
          </div>
        ) : (
          <button ref={toggleRef} type="button" className="rd-chat-control rd-agent-search" aria-label="Search agent chats" aria-expanded={false} onClick={() => setExpanded(true)}>
            <Icon name="search" />
          </button>
        )}
      </div>
      <nav className="rd-agent-switcher" aria-label="Agent chats">
        {shown.map((bot) => {
          const label = BOT_LABELS[bot] ?? bot;
          const last = lastMessage(threads, bot);
          return (
            <button
              key={bot}
              type="button"
              className={`rd-agent-switch${bot === activeBot ? " selected" : ""}`}
              aria-label={`Message ${label}`}
              aria-current={bot === activeBot ? "true" : undefined}
              title={expanded ? undefined : label}
              onClick={() => {
                actions.setActiveBot(bot);
                if (expanded) collapse();
              }}
            >
              <AgentAvatar bot={bot} />
              {expanded && (
                <span className="rd-agent-switch-text">
                  <span className="rd-agent-switch-top">
                    <strong>{label}</strong>
                    <time>{relativeTime(last?.timestamp)}</time>
                  </span>
                  <small>{previewText(last)}</small>
                </span>
              )}
            </button>
          );
        })}
        {expanded && !shown.length && (
          <p className="rd-agent-search-note">
            No chats match.
            <br />
            Try an agent’s name.
          </p>
        )}
      </nav>
      {expanded && <p className="rd-agent-search-note bottom">Search names or anything in your chat history.</p>}
    </aside>
  );
}
