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
    ? "ENTERED VOICE MODE"
    : record.direction === "outbound"
      ? "PHONE CALL · MICHAEL CALLED"
      : record.direction === "inbound"
        ? "PHONE CALL · YOU CALLED"
        : "PHONE CALL";

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
  const started = new Date(record.startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <button
      type="button"
      className="session-record"
      aria-label={record.channel === "phone" ? "Open phone call history" : "Open voice mode call history"}
      onClick={() => onOpen(record)}
    >
      <span className="sr-title mono">{recordTitle(record)}</span>
      <span className="mono sr-meta">
        {started} · {fmtDuration(record.durationSec)} · {record.turns}{" "}
        {record.turns === 1 ? "TURN" : "TURNS"}
      </span>
      {record.ending ? <span className="mono sr-meta sr-ending">{record.ending}</span> : null}
    </button>
  );
}
