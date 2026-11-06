import { memo, useLayoutEffect, useRef, useState } from "react";
import type { LocalMessage } from "../lib/types";
import { BOT_LABELS } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { DigestCard } from "./panel";
import { splitBuildsBlock } from "./panel/digest";
import { actions } from "../store";
import { flushOutbox } from "../lib/outbox";
import MediaAttachment from "./MediaAttachment";
import SentGrid from "./SentGrid";
import SessionRecordCard, { type VoiceSessionMeta } from "./voice/SessionRecordCard";
import SearchCard from "./search/SearchCard";
import StudioCard from "./studio/StudioCard";
import { useMessageActions } from "./useMessageActions";

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ── Sent-message collapse (3e#2) — SENT messages only. The owner's pasted
// prompts can run hundreds of lines; fold them to ~10 like Claude Code /
// Codex do, with a READ MORE toggle in the TRANSCRIPT-label voice.
// Expanded state lives outside React so it survives Virtuoso unmount/
// remount while scrolling (no re-collapse jump).
const CLAMP_LINES = 10; // keep in sync with --sent-clamp-lines
const expandedSent = new Set<string>();

function SentText({ id, text }: { id: string; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(expandedSent.has(id));
  const [clampable, setClampable] = useState(false);

  // Measure RENDERED lines, not characters: a message only collapses when
  // its full content overflows the cap by more than a line and a half —
  // no READ MORE that hides a single line.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 24;
    setClampable(el.scrollHeight > lineH * (CLAMP_LINES + 1.5));
  }, [text]);

  const collapsed = clampable && !expanded;
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation(); // don't trigger the failed-bubble retry click
    if (expanded) expandedSent.delete(id);
    else expandedSent.add(id);
    setExpanded(!expanded);
  };

  return (
    <>
      <div
        ref={ref}
        className={`msg-text${collapsed ? " collapsed" : ""}`}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
      {clampable && (
        <button type="button" className="msg-expand-toggle mono-label" onClick={toggle} aria-expanded={expanded}>
          {expanded ? "READ LESS" : "READ MORE"}
        </button>
      )}
    </>
  );
}

/**
 * One completed message, in the Ink & Brass chat grammar (design §1A):
 *  - agent = bare text on the ground; signature line (dot + name + mono
 *    time) is all the framing it gets
 *  - user  = quiet surface container, right-aligned, corner softened
 *    toward the composer
 * memo + the markdown LRU keep re-renders free while scrolling.
 */
const MessageBubble = memo(function MessageBubble({
  msg,
  onOpenVoiceSession,
}: {
  msg: LocalMessage;
  onOpenVoiceSession?: (record: VoiceSessionMeta) => void;
}) {
  const isUser = msg.direction === "in";
  // Right-click / long-press → Copy · Share · Save audio.
  const { bind: actionProps, menu } = useMessageActions(msg);

  // The call log (3F). Its PRESENCE is the discriminator — a card is a
  // different kind of thing from a message, but giving it a new contentType
  // would force every existing reader (Telegram bridge, retrieval corpus,
  // exports) to learn a shape that is meaningless to them. Anything that
  // doesn't know about it still renders the plain, true line.
  const voiceSession = msg.meta?.voiceSession;
  if (voiceSession) {
    return (
      <div className="session-record-row">
        <SessionRecordCard record={voiceSession} onOpen={onOpenVoiceSession ?? (() => {})} />
      </div>
    );
  }

  // Inline search: same rule — the card's presence is the
  // discriminator, and `text` stays the plain twin for every other reader.
  // It needs its message id: that is how the gateway finds its pictures.
  const search = msg.meta?.search;
  if (search && msg.meta?.messageId) {
    const byLabel = search.by === msg.bot ? BOT_LABELS[msg.bot] ?? msg.bot : msg.senderName || search.by;
    return (
      <div className="search-card-row">
        <SearchCard card={search} messageId={msg.meta.messageId} bot={msg.bot} byLabel={byLabel} />
      </div>
    );
  }

  // Live studio: a job's card, then its decision — the same rule.
  // Updated in place when the job lands (same messageId).
  const studio = msg.meta?.studio;
  if (studio && msg.meta?.messageId) {
    return (
      <div className="studio-card-row">
        <StudioCard card={studio} messageId={msg.meta.messageId} bot={msg.bot} byLabel={BOT_LABELS[msg.bot] ?? msg.bot} />
      </div>
    );
  }

  // Voice messages: the transcript is the message text — it renders
  // INSIDE the collapsible VoiceNote (fix 3c#3), never as a separate body.
  const isVoice = msg.media?.type === "voice";

  // Cargo sent as ONE message (lock v4). When a message carries more than a
  // single attachment the sent grid owns the layout; a lone attachment keeps
  // the existing single-media treatment so nothing about today's voice notes,
  // photos or docs changes.
  const cargo = msg.mediaList && msg.mediaList.length > 1 ? msg.mediaList : null;

  if (isUser) {
    const status = msg.failed ? " failed" : msg.pending ? " pending" : "";
    // "The crossing" (lock v4): a bubble that has just formed around cargo
    // runs the seam around its border ONCE and then resolves to the standard
    // hairline. It is keyed to the pending window, so it cannot re-trigger on
    // a re-render after the send is reconciled.
    const crossing = cargo && msg.pending ? " crossing" : "";
    const retry = () => {
      if (!msg.failed || !msg.localId) return;
      actions.retrySend(msg.bot, msg.localId);
      flushOutbox();
    };
    return (
      <div className="row-user">
        <div
          className={`bubble-user${status}${isVoice ? " has-voice" : ""}${cargo ? " has-cargo" : ""}${crossing}`}
          onClick={msg.failed ? retry : undefined}
          role={msg.failed ? "button" : undefined}
          title={msg.failed ? "Tap to retry" : undefined}
          {...actionProps}
        >
          {cargo ? (
            <SentGrid items={cargo} />
          ) : (
            msg.media && <MediaAttachment media={msg.media} transcript={isVoice ? msg.text : undefined} />
          )}
          {/* 4F: the caption lands LAST, in body type — never detached. */}
          {msg.text && !isVoice && (
            <SentText id={msg.localId ?? msg.meta?.messageId ?? `${msg.timestamp}|in`} text={msg.text} />
          )}
        </div>
        {/* Step 5 #2: the agent-time treatment under the owner's own bubble —
            text, voice, and media sends alike. Status spans stay. */}
        <span className="user-time mono-label">{formatTime(msg.timestamp)}</span>
        {msg.pending && <span className="bubble-status mono-label">SENDING</span>}
        {msg.failed && <span className="bubble-status failed mono-label">NOT SENT — TAP TO RETRY</span>}
        {(msg.cancelled || msg.meta?.turnStatus === "cancelled") && <span className="bubble-status cancelled mono-label">MESSAGE CANCELED</span>}
        {(msg.steered || msg.meta?.turnStatus === "steered") && <span className="bubble-status cancelled mono-label">RESPONSE STEERED</span>}
        {menu}
      </div>
    );
  }

  const label = BOT_LABELS[msg.bot] ?? msg.bot;
  // The menu portals out, but React events still bubble up the component
  // tree — it renders beside the bound element, never inside it.
  return (
    <>
      <div className="agent-run" {...actionProps}>
        <div className="agent-sig">
          <span className="agent-dot" data-bot={msg.bot} />
          <span className="agent-name" data-bot={msg.bot}>
            {label}
          </span>
          <span className="agent-time mono-label">{formatTime(msg.timestamp)}</span>
          {msg.contentType !== "text" && <span className="tool-chip">{chipLabel(msg)}</span>}
        </div>
        {cargo ? (
          <SentGrid items={cargo} />
        ) : (
          msg.media && <MediaAttachment media={msg.media} transcript={isVoice ? msg.text : undefined} />
        )}
        {msg.text && !isVoice && <AgentText text={msg.text} fromDesk={!!msg.meta?.turnId?.startsWith("review-")} />}
      </div>
      {menu}
    </>
  );
});

/** The type chip by what the message actually carries: an mp3 is AUDIO, not
 *  a DOCUMENT (contentType stays coarse for the Telegram bridge and corpus). */
function chipLabel(msg: LocalMessage): string {
  const list = msg.mediaList && msg.mediaList.length ? msg.mediaList : msg.media ? [msg.media] : [];
  if (list.length > 1) return `${list.length} FILES`;
  if (list[0]?.type === "audio") return "AUDIO";
  if (list[0]?.type === "video") return "VIDEO";
  return msg.contentType.toUpperCase();
}

/**
 * Agent text. In the review desk's own scheduled messages (turn ids
 * "review-…"), the day-close's Builds line renders as the Builds card — the
 * same tally the panel opens with (B8). Nothing else is re-parsed.
 */
function AgentText({ text, fromDesk }: { text: string; fromDesk: boolean }) {
  const split = fromDesk ? splitBuildsBlock(text) : null;
  if (!split) return <div className="msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  const { before, block, after } = split;
  const oldest = block.oldestDays;
  return (
    <>
      {before && <div className="msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(before) }} />}
      <DigestCard
        cells={[
          { value: block.open, label: "Open", tone: block.open ? "" : "zero" },
          { value: block.needYou, label: "Need you", tone: block.needYou ? "you" : "zero" },
          oldest === null ? { value: "—", label: "Oldest", tone: "zero" } : { value: oldest || "<1", unit: "D", label: "Oldest", tone: oldest >= 7 ? "old" : "" },
        ]}
        needsYou={block.names}
        more={block.more}
        toClose={block.toClose ? { count: block.toClose, oldest: null } : null}
        onOpen={() => actions.openBuilds()}
      />
      {after && <div className="msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(after) }} />}
    </>
  );
}

export default MessageBubble;
