/**
 * The call's control row — FINAL voice.js one for one: Mute, Share screen, End, Standby,
 * each a round icon with its word beneath. REC (record for Michael to watch) sits beside Share while
 * sharing — the record feature stays (the owner: "the share screen should still have the record feature").
 * Accessible names are unchanged (Mute microphone / Share screen / End call / Record for Michael to watch).
 */
import { useT } from "../../i18n";

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
  const t = useT();
  return (
    <footer className="voice-controls">
      <button
        type="button"
        className={`voice-control mute${muted ? " on" : ""}`}
        aria-label={muted ? t("voice.ctl.unmuteMic") : t("voice.ctl.muteMic")}
        aria-pressed={muted}
        onClick={onToggleMute}
      >
        <MicIcon muted={muted} />
        <span aria-hidden="true">{muted ? t("voice.ctl.unmute") : t("voice.ctl.mute")}</span>
      </button>

      {/* Desktop only: phones have no getDisplayMedia, so no button. */}
      {canShare && onToggleShare && (
        <button
          type="button"
          className={`voice-control share${sharing ? " on" : ""}`}
          aria-label={sharing ? t("voice.ctl.stopSharingScreen") : t("voice.ctl.shareScreen")}
          aria-pressed={sharing}
          onClick={onToggleShare}
        >
          <MonitorIcon />
          <span aria-hidden="true">{sharing ? t("voice.ctl.stopShare") : t("voice.ctl.shareScreen")}</span>
        </button>
      )}

      {/* While sharing: record a stretch for Michael to watch quietly and review on stop (or say "watch this"). */}
      {canRecord && onToggleRecord && (
        <button
          type="button"
          className={`voice-control rec${recording ? " on" : ""}`}
          aria-label={recording ? t("voice.ctl.stopRecording") : t("voice.ctl.recordForMichael")}
          aria-pressed={recording}
          onClick={onToggleRecord}
        >
          <RecIcon on={recording} />
          <span aria-hidden="true">{recording ? t("common.done") : t("voice.ctl.record")}</span>
        </button>
      )}

      <button type="button" className="voice-control voice-end end" aria-label={t("voice.ctl.endCall")} onClick={onEnd}>
        <XIcon />
        <span aria-hidden="true">{t("voice.ctl.end")}</span>
      </button>

      {onToggleStandby && (
        <button
          type="button"
          className={`voice-control standby${standby ? " on" : ""}`}
          aria-label={standby ? t("voice.ctl.resumeLabel") : t("voice.ctl.standbyLabel")}
          aria-pressed={standby}
          onClick={onToggleStandby}
        >
          <ClockIcon />
          <span aria-hidden="true">{standby ? t("voice.ctl.resume") : t("voice.ctl.standby")}</span>
        </button>
      )}
    </footer>
  );
}
