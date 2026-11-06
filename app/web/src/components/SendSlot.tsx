import { useRef, useState } from "react";
import { SendGlyph } from "./send-glyph";

/* ============================================================
   SendSlot — DESIGN LOCK v4, deck p.6 (frame 3A + glyph geometry cards),
   motion summary p.14.

   ONE slot, two glyphs, swapped IN PLACE:

     empty field  → voice glyph  → TAP ENTERS VOICE MODE
     first char   → send glyph   → 160ms crossfade, no movement
     field cleared→ voice glyph  → crossfades back

   Tap = enter voice mode. There is no long-press and no push-to-talk —
   that was the explicit call, and holding to talk is the interaction this
   replaces, not a fallback for it.

   Motion (p.14): press nudges 2px along the NOSE VECTOR (up-right, so the
   glyph moves the way it points, not straight down); release launches it
   up-right over 150ms and the glyph fades back in. Reduced motion gets an
   opacity dip and nothing else.
   ============================================================ */

/**
 * Voice glyph — 4 bars, 1.75px rounded caps, heights 7/16/12/7, gap 1.4px.
 * Bar 3 is petrol; the rest are ink. Geometry is from the lock, so the bar
 * centres are derived rather than eyeballed: 4×1.75 + 3×1.4 = 11.2 wide,
 * centred in the 36 box.
 */
const BAR_HEIGHTS = [7, 16, 12, 7];
const BAR_W = 1.75;
const BAR_GAP = 1.4;
const PETROL = "#2E6373";

const VoiceGlyph = () => {
  const total = BAR_HEIGHTS.length * BAR_W + (BAR_HEIGHTS.length - 1) * BAR_GAP;
  const firstCentre = (36 - total) / 2 + BAR_W / 2;
  return (
    <svg
      className="glyph glyph-voice"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 36 36"
      width="36"
      height="36"
      aria-hidden="true"
      focusable="false"
    >
      {BAR_HEIGHTS.map((h, i) => {
        const x = firstCentre + i * (BAR_W + BAR_GAP);
        return (
          <line
            key={i}
            x1={x}
            x2={x}
            y1={18 - h / 2}
            y2={18 + h / 2}
            stroke={i === 2 ? PETROL : "var(--glyph-ink)"}
            strokeWidth={BAR_W}
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
};

export default function SendSlot({
  hasText,
  voiceAvailable = true,
  live = false,
  busy = false,
  running = false,
  hasDraft = false,
  onSend,
  onStop,
  onEnterVoiceMode,
}: {
  hasText: boolean;
  /**
   * Voice mode is switched on for this agent. When it is not, the voice
   * glyph must never appear — the slot is a send button or it is nothing.
   */
  voiceAvailable?: boolean;
  /** Voice mode is open and the mic is streaming. */
  live?: boolean;
  /** Cargo is still uploading — send is refused until it lands. */
  busy?: boolean;
  /** The agent is actively generating this thread's turn. */
  running?: boolean;
  /** Text or cargo is ready to queue while a response is running. */
  hasDraft?: boolean;
  onSend: () => void;
  onStop: () => void;
  onEnterVoiceMode: () => void;
}) {
  const [launching, setLaunching] = useState(false);
  const timer = useRef<number | null>(null);

  function handleClick() {
    if (busy) return;
    if (running && !hasDraft) {
      onStop();
      return;
    }
    if (!hasText) {
      if (!voiceAvailable) return;
      onEnterVoiceMode();
      return;
    }
    // Launch, then send. The glyph leaves up-right and fades back; the
    // send itself must not wait on the animation.
    setLaunching(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLaunching(false), 150);
    onSend();
  }

  // With voice unavailable the slot is only ever a send button.
  const showsSend = hasText || !voiceAvailable;

  return (
    <button
      type="button"
      disabled={busy}
      className={
        `send-slot${running && !hasDraft ? " is-stop" : showsSend ? " is-send" : " is-voice"}` +
        `${launching ? " launching" : ""}${live ? " is-live" : ""}${busy ? " is-busy" : ""}`
      }
      onClick={handleClick}
      aria-pressed={!running && !showsSend ? live : undefined}
      aria-label={running && !hasDraft ? "Stop response" : running ? "Queue message" : showsSend ? "Send" : live ? "Leave voice mode" : "Enter voice mode"}
      title={busy ? "Waiting for attachments to finish" : running && !hasDraft ? "Stop response" : running ? "Queue message" : showsSend ? "Send" : live ? "Leave voice mode" : "Voice mode"}
    >
      <span className="send-slot-glyphs">
        {running && !hasDraft ? <span className="stop-glyph" /> : <>{voiceAvailable && <VoiceGlyph />}<SendGlyph /></>}
      </span>
    </button>
  );
}
