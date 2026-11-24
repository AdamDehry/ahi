import { locale, t, tn, useT } from "../../i18n";

export interface VoiceSessionMeta {
  startedAt: number;
  durationSec: number;
  turns: number;
  transcript: { role: "user" | "agent"; text: string }[];
  /** A phone call's card (the phone leg); absent on an app call. */
  channel?: "phone";
  direction?: "inbound" | "outbound";
  /** How the call ended, in plain words, when it did not end cleanly (an ElevenLabs failure, a drop). */
  ending?: string;
}

/** The card's title: an app call is VOICE MODE, a phone call says so and which way it went. */
export const recordTitle = (record: Pick<VoiceSessionMeta, "channel" | "direction">): string =>
  record.channel !== "phone"
    ? t("voice.record.voiceMode")
    : record.direction === "outbound"
      ? t("voice.record.phoneMichaelCalled")
      : record.direction === "inbound"
        ? t("voice.record.phoneYouCalled")
        : t("voice.record.phone");

export const fmtDuration = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/** The compact call log card that remains in the main chat thread. */
export default function SessionRecordCard({
  record,
  onOpen,
}: {
  record: VoiceSessionMeta;
  onOpen: (record: VoiceSessionMeta) => void;
}) {
  const t = useT();
  const started = new Date(record.startedAt).toLocaleTimeString(locale(), {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <button
      type="button"
      className="session-record"
      aria-label={record.channel === "phone" ? t("voice.record.openPhone") : t("voice.record.openVoice")}
      onClick={() => onOpen(record)}
    >
      <span className="sr-title mono">{recordTitle(record)}</span>
      <span className="mono sr-meta">
        {started} · {fmtDuration(record.durationSec)} · {tn("voice.turns", record.turns)}
      </span>
      {record.ending ? <span className="mono sr-meta sr-ending" dir="auto">{record.ending}</span> : null}
    </button>
  );
}
