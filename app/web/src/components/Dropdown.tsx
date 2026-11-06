import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Anchored dropdown primitive (design: Mac-menubar style — the panel falls
 * from its trigger, never screen-centered).
 *
 * The panel renders in a PORTAL to document.body inside a dedicated
 * top stacking context (--z-menu), so it can never be buried under page
 * content (fix 3c#1 — peek/view menus rendered behind MC cards). A
 * transparent click-catcher backdrop sits underneath it in click mode;
 * hover mode (the sidebar peek) uses pointer-enter/leave on both the
 * trigger and the panel with a short grace timer.
 */
/** Room under the panel's top edge before the window ends. */
export const MENU_EDGE_GAP = 12;
/** The panel never runs past the window: it caps at the room left under its
 *  top edge and scrolls inside (on a short window the view menu
 *  ran under the bottom edge and Vault could not be reached). The floor keeps
 *  a few rows usable even when the trigger sits very low. */
export function panelMaxHeight(top: number, viewportHeight: number): number {
  return Math.max(120, Math.floor(viewportHeight - top - MENU_EDGE_GAP));
}

export default function Dropdown({
  trigger,
  open,
  onOpenChange,
  hover = false,
  label,
  children,
}: {
  trigger: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hover?: boolean;
  /** Optional mono micro-label at the top of the panel (e.g. AGENTS). */
  label?: string;
  children: React.ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  // Measure the trigger and pin the panel just under it. Re-measure on
  // resize; close on scroll of anything outside the panel (cheap + safe).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setPos({ left: rect.left, top: rect.bottom + 4, maxHeight: panelMaxHeight(rect.bottom + 4, window.innerHeight) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  function scheduleClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => onOpenChange(false), 140);
  }

  function cancelClose() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  const hoverTriggerProps = hover
    ? {
        onPointerEnter: () => {
          cancelClose();
          onOpenChange(true);
        },
        onPointerLeave: scheduleClose,
      }
    : {};

  return (
    <>
      <div className="dropdown-anchor" ref={anchorRef} {...hoverTriggerProps}>
        {trigger}
      </div>
      {open &&
        pos &&
        createPortal(
          <div className="menu-layer">
            {!hover && <div className="menu-backdrop" onPointerDown={() => onOpenChange(false)} />}
            <div
              className="dropdown-panel"
              role="menu"
              ref={panelRef}
              style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
              onPointerEnter={hover ? cancelClose : undefined}
              onPointerLeave={hover ? scheduleClose : undefined}
            >
              {label && <div className="dropdown-label mono-label">{label}</div>}
              <div className="dropdown-scroll">{children}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
