/**
 * The call's control row — FINAL voice.js one for one: Mute, Share screen, End, Standby,
 * each a round icon with its word beneath. REC (record for Michael to watch) sits beside Share while
 * sharing — the record feature stays (the owner: "the share screen should still have the record feature").
 * Accessible names are unchanged (Mute microphone / Share screen / End call / Record for Michael to watch).
 */
const MicIcon = ({ muted }: { muted: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    {muted && <path d="M4 4l16 16" />}
  </svg>
);
const MonitorIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="12.5" rx="2" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </svg>
);
const XIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
const ClockIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const RecIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="rec-glyph">
    {on ? <rect x="8" y="8" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" /> : <circle cx="12" cy="12" r="5" fill="#e5484d" stroke="none" />}
  </svg>
);

export default function VoiceControls({
  muted,
  onToggleMute,
  onEnd,
  sharing = false,
  canShare = false,
  onToggleShare,
  recording = false,
  canRecord = false,
  onToggleRecord,
  standby = false,
  onToggleStandby,
}: {
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  sharing?: boolean;
  canShare?: boolean;
  onToggleShare?: () => void;
  recording?: boolean;
  canRecord?: boolean;
  onToggleRecord?: () => void;
  standby?: boolean;
  onToggleStandby?: () => void;
}) {
  return (
    <footer className="voice-controls">
      <button
        type="button"
        className={`voice-control mute${muted ? " on" : ""}`}
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={muted}
        onClick={onToggleMute}
      >
        <MicIcon muted={muted} />
        <span aria-hidden="true">{muted ? "Unmute" : "Mute"}</span>
      </button>

      {/* Desktop only: phones have no getDisplayMedia, so no button. */}
      {canShare && onToggleShare && (
        <button
          type="button"
          className={`voice-control share${sharing ? " on" : ""}`}
          aria-label={sharing ? "Stop sharing screen" : "Share screen"}
          aria-pressed={sharing}
          onClick={onToggleShare}
        >
          <MonitorIcon />
          <span aria-hidden="true">{sharing ? "Stop share" : "Share screen"}</span>
        </button>
      )}

      {/* While sharing: record a stretch for Michael to watch quietly and review on stop (or say "watch this"). */}
      {canRecord && onToggleRecord && (
        <button
          type="button"
          className={`voice-control rec${recording ? " on" : ""}`}
          aria-label={recording ? "Stop recording" : "Record for Michael to watch"}
          aria-pressed={recording}
          onClick={onToggleRecord}
        >
          <RecIcon on={recording} />
          <span aria-hidden="true">{recording ? "Done" : "Record"}</span>
        </button>
      )}

      <button type="button" className="voice-control voice-end end" aria-label="End call" onClick={onEnd}>
        <XIcon />
        <span aria-hidden="true">End</span>
      </button>

      {onToggleStandby && (
        <button
          type="button"
          className={`voice-control standby${standby ? " on" : ""}`}
          aria-label={standby ? "Resume — Michael listens again" : "Standby — Michael waits for his name"}
          aria-pressed={standby}
          onClick={onToggleStandby}
        >
          <ClockIcon />
          <span aria-hidden="true">{standby ? "Resume" : "Standby"}</span>
        </button>
      )}
    </footer>
  );
}
