import { useState } from "react";
import { BOT_LABELS } from "../lib/types";
import { useAppState, type VoiceOutboxItem } from "../store";
import { discardVoiceNote, retryVoiceNote } from "../lib/voice-outbox";
import { IconMic, IconTrash } from "./icons";
import { t, useT } from "../i18n";

/**
 * The outbox strip — a voice note that has not reached the gateway is
 * VISIBLE (brief item 3). It sits above the composer pill, in the same
 * position and grammar as the steer preview.
 *
 * It renders this agent's queued notes, and a count for any belonging to
 * other agents so that a note can never be waiting somewhere the user
 * cannot see it. The warning line appears when the device would not store
 * the note at all — the one case where a failed send is still lost.
 */
function formatDuration(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function describe(item: VoiceOutboxItem): string {
  if (item.state === "sending") return t("media.outboxSending");
  if (item.state === "failed") return item.lastError ? t("media.outboxFailedWith", { error: item.lastError }) : t("media.outboxFailed");
  if (item.attempts > 0) return t("media.outboxWaitingNetwork");
  return t("media.outboxQueued");
}

export default function VoiceOutbox({ bot }: { bot: string }) {
  const t = useT();
  const { voiceOutbox, voiceOutboxWarning } = useAppState();
  // Arming a discard, per note. Deleting audio the server never received is
  // irreversible and this component exists because that audio matters, so the
  // first tap asks and the second one does it.
  const [armed, setArmed] = useState<string | null>(null);

  const mine = voiceOutbox.filter((item) => item.bot === bot);
  const elsewhere = voiceOutbox.filter((item) => item.bot !== bot);
  if (!mine.length && !elsewhere.length && !voiceOutboxWarning) return null;

  return (
    <div className="voice-outbox" role="status" aria-live="polite">
      {voiceOutboxWarning && <p className="voice-outbox-warning">{t(voiceOutboxWarning)}</p>}
      {mine.map((item) => (
        <div key={item.id} className={`voice-outbox-row ${item.state}`}>
          <span className="voice-outbox-glyph" aria-hidden="true">
            <IconMic />
          </span>
          <span className="mono-label voice-outbox-time">{formatDuration(item.durationSec)}</span>
          <span className="voice-outbox-state">{describe(item)}</span>
          {item.state !== "sending" && (
            <button
              type="button"
              className="voice-outbox-action"
              onClick={() => void retryVoiceNote(item.id)}
            >
              {t("common.retry")}
            </button>
          )}
          {item.state !== "sending" &&
            (armed === item.id ? (
              <button
                type="button"
                className="voice-outbox-action discard armed"
                onClick={() => {
                  setArmed(null);
                  void discardVoiceNote(item.id);
                }}
              >
                {t("media.deleteConfirm")}
              </button>
            ) : (
              <button
                type="button"
                className="voice-outbox-action discard"
                aria-label={t("media.deleteVoiceNote")}
                title={t("media.deleteVoiceNote")}
                onClick={() => setArmed(item.id)}
              >
                <IconTrash />
              </button>
            ))}
        </div>
      ))}
      {elsewhere.length > 0 && (
        <p className="voice-outbox-elsewhere">
          {elsewhere.length === 1
            ? t("media.elsewhereOne", { name: BOT_LABELS[elsewhere[0].bot] ?? elsewhere[0].bot })
            : t("media.elsewhereOther", { n: elsewhere.length })}
        </p>
      )}
    </div>
  );
}
