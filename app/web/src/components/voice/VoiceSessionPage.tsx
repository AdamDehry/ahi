import { BOT_LABELS } from "../../lib/types";
import { IconBack } from "../icons";
import { fmtDuration, type VoiceSessionMeta } from "./SessionRecordCard";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function VoiceSessionPage({
  bot,
  record,
  onClose,
}: {
  bot: string;
  record: VoiceSessionMeta;
  onClose: () => void;
}) {
  const title = BOT_LABELS[bot] ?? bot;
  const started = formatTime(record.startedAt);

  return (
    <section className="voice-history-page" aria-label="Voice mode call history">
      <header className="voice-history-head">
        <button type="button" className="voice-history-back" aria-label="Back to chat" onClick={onClose}>
          <IconBack />
        </button>
        <div className="voice-history-title">
          <strong>{title}</strong>
          <span className="mono-label">
            {started} · {fmtDuration(record.durationSec)} · {record.turns} {record.turns === 1 ? "TURN" : "TURNS"}
          </span>
        </div>
        {/* ONE way out, not two (R4-7). The header used to carry a back-arrow
            AND an X, both wired to the same `onClose` — two controls making the
            same promise, which reads as a choice that isn't one. The arrow wins:
            this is a page pushed over the chat, and back is what a pushed page
            offers. The spacer keeps the 3-column grid symmetric so the title
            stays optically centred, same trick as the mobile Settings header. */}
        <span className="voice-history-back" aria-hidden="true" />
      </header>

      <div className="voice-history-thread">
        {record.transcript.length > 0 ? (
          record.transcript.map((line, i) =>
            line.role === "user" ? (
              <div key={`${line.role}-${i}`} className="voice-history-row user">
                <div className="voice-history-bubble user">{line.text}</div>
              </div>
            ) : (
              <div key={`${line.role}-${i}`} className="voice-history-row agent">
                <div className="voice-history-agent-sig">
                  <span className="agent-dot" data-bot={bot} />
                  <span className="agent-name" data-bot={bot}>{title}</span>
                </div>
                <div className="voice-history-bubble agent">{line.text}</div>
              </div>
            ),
          )
        ) : (
          <div className="voice-history-empty mono-label">NO TRANSCRIPT</div>
        )}
      </div>
    </section>
  );
}
