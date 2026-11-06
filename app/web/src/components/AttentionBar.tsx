import { useEffect, useState } from "react";
import { actions, useAppState } from "../store";
import { clock, liveShip, type AttentionItem } from "../lib/ship";
import { IconClose } from "./icons";

/**
 * The attention bar: a slim line at the top of EVERY screen,
 * chat included, desktop and phone — what is ready and the one action.
 *
 *   Ready to ship — voice call drop            Ship
 *   Michael needs you — client portal          Answer
 *   Shipping voice call drop · restarting 0:07         (while a ship lands)
 *   Shipped voice call drop · back on 7a1b2c3   ×       (for a moment after)
 *
 * One bar per pending item, dismissible for the session ("Not now"); it comes
 * back when a NEW item arrives (a new key), never for the same one. Nothing
 * repeats and nothing animates for attention after it first appears. Tapping
 * opens the card.
 */
export default function AttentionBar({ mobile = false }: { mobile?: boolean }) {
  const { attention, attentionDismissed, shipWatch, shipLive, connection, restartingAt, gatewayShaBefore, gatewayShaNow, user } = useAppState();
  const [now, setNow] = useState(() => Date.now());
  const live = shipLive ? liveShip({ ship: shipLive, connection, restartingAt, shaBefore: gatewayShaBefore, shaNow: gatewayShaNow, now }) : null;
  const ticking = !!live && (live.phase !== "back" && live.phase !== "rolled_back" && live.phase !== "failed");

  // A clock only while a ship is moving — the elapsed figure is the visual.
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  if (!user?.admin) return null;

  const items: AttentionItem[] = attention.filter((it) => !attentionDismissed.includes(it.key));
  // While a ship lands, the bar IS the restart visual; the others wait their turn underneath it.
  const shipLine = live && shipWatch ? shipRow(shipWatch.title, live, shipWatch.cardId) : null;
  const rows = shipLine ? [shipLine] : items.slice(0, 2).map(itemRow);
  if (!rows.length) return null;

  return (
    <div className={`attn${mobile ? " mobile" : ""}`} role="status" aria-live="polite">
      {rows.map((r) => (
        <div key={r.key} className={`attn-row ${r.tone}`}>
          <button type="button" className="attn-main" onClick={r.onOpen}>
            {r.dot && <span className={`attn-dot ${r.dot}`} />}
            <span className="attn-line">{r.line}</span>
            {r.action && <span className="attn-action mono-label">{r.action}</span>}
          </button>
          {r.onDismiss && (
            <button type="button" className="attn-x" aria-label="Not now" onClick={r.onDismiss}>
              <IconClose />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

interface Row {
  key: string;
  tone: "ship" | "you" | "live" | "back" | "trouble";
  dot: "" | "pulse" | "ok" | "warn";
  line: string;
  action: string | null;
  onOpen: () => void;
  onDismiss: (() => void) | null;
}

function itemRow(it: AttentionItem): Row {
  return {
    key: it.key,
    tone: it.kind === "ship" ? "ship" : it.kind === "rolled-back" ? "trouble" : "you",
    dot: it.kind === "rolled-back" ? "warn" : "",
    line: it.line,
    action: it.action,
    onOpen: () => actions.openBuilds(it.cardId),
    onDismiss: () => actions.dismissAttention(it.key),
  };
}

function shipRow(title: string, live: ReturnType<typeof liveShip> & object, cardId: string): Row {
  const open = () => actions.openBuilds(cardId);
  const done = () => actions.watchShip(null);
  switch (live.phase) {
    case "back":
      return { key: "ship-live", tone: "back", dot: "ok", line: `Shipped ${title} · back on ${live.sha ?? "the new build"}`, action: null, onOpen: open, onDismiss: done };
    case "rolled_back":
      return { key: "ship-live", tone: "trouble", dot: "warn", line: `Rolled back — ${title} is on ${live.sha ?? "the previous build"}`, action: "See why", onOpen: open, onDismiss: done };
    case "failed":
      return { key: "ship-live", tone: "trouble", dot: "warn", line: `Ship stopped — ${title}`, action: "See why", onOpen: open, onDismiss: done };
    case "restarting":
      return { key: "ship-live", tone: "live", dot: "pulse", line: `Shipping ${title} · restarting · ${clock(live.elapsedMs)} dark`, action: null, onOpen: open, onDismiss: null };
    case "reconnecting":
      return { key: "ship-live", tone: "live", dot: "pulse", line: `Shipping ${title} · coming back`, action: null, onOpen: open, onDismiss: null };
    case "building":
    case "shipping":
      return { key: "ship-live", tone: "live", dot: "pulse", line: `Shipping ${title} · ${live.label.toLowerCase()} · ${clock(live.elapsedMs)}`, action: null, onOpen: open, onDismiss: null };
    default:
      return { key: "ship-live", tone: "live", dot: "pulse", line: `Shipping ${title} · waking Michael · ${clock(live.elapsedMs)}`, action: null, onOpen: open, onDismiss: null };
  }
}
