import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const EDGE = 8; // px kept clear of the viewport edge

/** Right-click context menu — portals into the same top menu layer as the
 *  dropdowns (always above content), anchored at the cursor. Closes on
 *  Escape, outside press and scroll; arrow keys move between items and
 *  focus goes back where it came from on close. */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  autoFocus = true,
}: {
  x: number;
  y: number;
  items: Array<{ label: string; danger?: boolean; onSelect: () => void }>;
  onClose: () => void;
  autoFocus?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Callers pass a fresh arrow each render; the listeners must not re-arm
  // (and re-steal focus) every time the parent re-renders.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Keep the whole panel on screen: a press near the right or bottom edge
  // opens leftward / upward instead of spilling off it.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || typeof window === "undefined") return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width > window.innerWidth - EDGE ? Math.max(EDGE, x - width) : x;
    const top = y + height > window.innerHeight - EDGE ? Math.max(EDGE, y - height) : y;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const panel = panelRef.current;
    const opener = document.activeElement as HTMLElement | null;
    // A touch-opened menu leaves focus alone: moving it would drop the
    // phone keyboard, and the resize that follows reads as a scroll.
    if (autoFocus) panel?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      if (!buttons.length) return;
      e.preventDefault();
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    const close = () => closeRef.current();
    document.addEventListener("keydown", onKey);
    // Capture: the thread scrolls inside its own scroller, not the window.
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      // Hand focus back (e.g. to the composer) unless something else —
      // a rename field the item opened — has already taken it. Only when we
      // moved it: refocusing the composer would wipe a selection the menu
      // just made (phone Select text).
      const now = document.activeElement;
      if (autoFocus && opener && opener !== document.body && (!now || now === document.body || panel?.contains(now))) {
        opener.focus?.({ preventScroll: true });
      }
    };
  }, []);

  return createPortal(
    <div className="menu-layer">
      <div className="menu-backdrop" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div ref={panelRef} className="dropdown-panel context-menu" role="menu" style={{ left: pos.left, top: pos.top }}>
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={`dropdown-item${it.danger ? " danger" : ""}`}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
