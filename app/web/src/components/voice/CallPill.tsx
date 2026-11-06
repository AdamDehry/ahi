import { BOT_LABELS } from "../../lib/types";
import { formatElapsed, type VoicePhase } from "../../lib/voicelayer";
import type { FloorState } from "../../lib/voicebus";

/**
 * The minimized call (call-minimize-pill): a floating pill in the
 * bottom corner while the call screen is hidden and the owner moves around the app.
 *
 * It renders STATE it is handed — the same `useVoiceLayer` values the full
 * screen reads, from the same hook instance (VoiceLayer owns it; this is one
 * of its two faces). It subscribes to nothing and owns nothing: a call that
 * had two readers of its own state would have two truths.
 *
 * The orb pulses for as long as the call is live. Its hue follows the floor
 * the way the full screen's glow does — petrol while the owner speaks, brass while
 * Michael does — and between turns it breathes slowly from one to the other,
 * so a glance says "the call is still going" even when nobody is talking.
 * Grey means the link is down and the call is waiting to be resumed.
 */
export type PillTone = "petrol" | "brass" | "alt" | "down" | "ended";

export interface CallPillProps {
  bot: string;
  phase: VoicePhase;
  floor: FloorState;
  link: "ok" | "reconnecting";
  working: { sec: number; steps: number } | null;
  elapsedSec: number;
  /** the owner is being heard right now (the recognizer's interim text). */
  speaking: boolean;
  muted: boolean;
  onRestore: () => void;
}

/** Which hue the orb holds. Exported so the rule is testable without a render. */
export function pillTone(p: Pick<CallPillProps, "phase" | "link" | "speaking">): PillTone {
  if (p.phase === "ended") return "ended";
  if (p.link === "reconnecting") return "down";
  if (p.phase === "speaking") return "brass";
  if (p.phase === "listening" && p.speaking) return "petrol";
  return "alt";
}

/**
 * What the call is doing, in FINAL's words (voice.js voicePhaseLabel): the link first,
 * then work, then mute and the floor, then who is talking. Shared by the call header and the pill.
 */
export function callStateLabel(p: Pick<CallPillProps, "phase" | "link" | "working" | "floor" | "muted"> & { name?: string; speaking?: boolean }): string {
  const name = p.name ?? "Michael";
  if (p.phase === "ended") return "Call ended";
  if (p.phase === "connecting") return "Connecting";
  if (p.link === "reconnecting") return "Reconnecting";
  if (p.working) {
    const n = p.working.steps;
    return `Working · ${n > 0 ? `${n} task${n === 1 ? "" : "s"} · ` : ""}${formatElapsed(p.working.sec)}`;
  }
  if (p.muted) return "Microphone muted";
  if (p.floor === "standby") return `Standby · say ${name}`;
  if (p.phase === "speaking") return `${name} is speaking`;
  if (p.phase === "thinking") return "Thinking";
  if (p.speaking) return "Listening to you";
  return "Listening";
}

/** The pill's line (kept for callers and tests). */
export function pillLabel(p: Pick<CallPillProps, "phase" | "link" | "working" | "floor" | "muted"> & { name?: string; speaking?: boolean }): string {
  return callStateLabel(p);
}

export default function CallPill(props: CallPillProps) {
  const { bot, elapsedSec, onRestore } = props;
  const tone = pillTone(props);
  const name = BOT_LABELS[bot] ?? bot;
  const label = pillLabel({ ...props, name });
  return (
    <button
      type="button"
      className={`call-pill tone-${tone}${props.working ? " working" : ""}`}
      aria-label={`Return to the call with ${name}`}
      title={`${name} · ${label} · ${formatElapsed(elapsedSec)}`}
      onClick={onRestore}
    >
      <span className="cp-orb" aria-hidden="true">
        <span className="cp-ring" />
        <span className="cp-core" />
      </span>
      <span className="cp-text mono" role="status" aria-live="polite">
        <span className="cp-name">With {name}</span>
        <span className="cp-label">{label}</span>
        <span className="cp-timer">{formatElapsed(elapsedSec)}</span>
      </span>
      <svg className="cp-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6" /></svg>
    </button>
  );
}
