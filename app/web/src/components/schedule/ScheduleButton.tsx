import { useEffect } from "react";
import { scheduleUi, useScheduleUi, badgeText } from "../../lib/schedule";

/** Calendar glyph, drawn on the same 16-unit grid and stroke as the header's other icons. */
export const IconCalendar = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="1.8" y="2.8" width="12.4" height="11.2" rx="2" />
    <path d="M1.8 6.4h12.4M5.2 1.6v2.4M10.8 1.6v2.4" />
    <path d="M4.8 9.2h1.4M7.3 9.2h1.4M9.8 9.2h1.4M4.8 11.6h1.4M7.3 11.6h1.4" />
  </svg>
);

/**
 * One badge poll for the whole app, however many headers show the icon
 * (desktop topbar, phone root, a pushed thread): ref-counted, every 60 s, and
 * on coming back to the foreground.
 */
let mounted = 0;
let timer: number | null = null;
const onVisible = () => document.visibilityState === "visible" && void scheduleUi.refreshBadge();

function startPoll() {
  if (mounted++ > 0) return;
  void scheduleUi.refreshBadge();
  timer = window.setInterval(() => document.visibilityState === "visible" && void scheduleUi.refreshBadge(), 60_000);
  document.addEventListener("visibilitychange", onVisible);
}

function stopPoll() {
  if (--mounted > 0) return;
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
}

/** The header's calendar icon (next to the gallery icon, always visible), with the unread badge. */
export default function ScheduleButton() {
  const { open, unread } = useScheduleUi();
  useEffect(() => {
    startPoll();
    return stopPoll;
  }, []);
  const badge = badgeText(unread);
  return (
    <button
      className={`topbar-btn sc-btn${open ? " active" : ""}`}
      aria-label={badge ? `Schedule, ${unread} new` : "Schedule"}
      title="Schedule"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => (open ? scheduleUi.close() : scheduleUi.open())}
    >
      <IconCalendar />
      {badge && <span className="sc-badge">{badge}</span>}
    </button>
  );
}
