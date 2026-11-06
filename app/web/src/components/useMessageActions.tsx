import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalMessage } from "../lib/types";
import {
  copyableText,
  copyText,
  filesOf,
  prefetchVoiceFile,
  saveFiles,
  shareFiles,
  saveVoice,
  shareText,
  shareVoice,
  voiceMediaOf,
  voiceNoteBase,
} from "../lib/messageActions";
import { showToast } from "../lib/toast";
import ContextMenu from "./ContextMenu";

export const LONG_PRESS_MS = 500;
/** Finger travel that turns a press into a scroll (or a selection drag). */
const MOVE_SLOP = 10;

type Item = { label: string; onSelect: () => void };

/**
 * Phone only: put the bubble's text under a native selection, so the
 * platform's own handles and Copy take over for copying part of it. (A
 * long-press now opens our menu instead of selecting a word.)
 */
export function selectBubbleText(el: Element): boolean {
  const blocks = el.querySelectorAll(".msg-text");
  const sel = window.getSelection?.();
  if (!blocks.length || !sel) return false;
  const last = blocks[blocks.length - 1];
  const range = document.createRange();
  range.setStart(blocks[0], 0);
  range.setEnd(last, last.childNodes.length);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/** The menu for one message — empty when there is nothing to offer (an
 *  image with no caption), in which case the native menu is left alone.
 *  `touch` + the bubble element add Select text (desktop selects by mouse). */
export function messageMenuItems(msg: LocalMessage, touch = false, el: Element | null = null): Item[] {
  const items: Item[] = [];
  const voice = voiceMediaOf(msg);
  const text = copyableText(msg);
  if (text) {
    items.push({
      label: voice ? "Copy transcript" : "Copy",
      onSelect: () => void copyText(text).then((ok) => showToast(ok ? "Copied" : "Couldn't copy")),
    });
  }
  if (voice) {
    const base = voiceNoteBase(msg);
    items.push({ label: "Share audio", onSelect: () => void shareVoice(voice, base) });
    items.push({ label: "Save audio", onSelect: () => void saveVoice(voice, base) });
  } else if (text) {
    items.push({ label: "Share", onSelect: () => void shareText(text) });
    if (touch && el) items.push({ label: "Select text", onSelect: () => void selectBubbleText(el) });
  }
  // Files: the original file, under its own name.
  const files = filesOf(msg);
  if (files.length) {
    const one = files.length === 1;
    items.push({ label: one ? "Share file" : `Share ${files.length} files`, onSelect: () => void shareFiles(files) });
    items.push({ label: one ? "Save file" : `Save ${files.length} files`, onSelect: () => void saveFiles(files) });
  }
  return items;
}

/** A live selection touching this bubble means the person is copying a
 *  piece of it — the browser's own menu does that better than ours. */
function selectionTouches(el: Element): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
  return sel.containsNode(el, true);
}

/** Links (and the image / document chips, which are links) keep their
 *  native menu: open in a new tab, copy link, save image. */
function onLink(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.("a[href]");
}

/**
 * Right-click (desktop) or long-press (phone) anywhere on a bubble → Copy /
 * Share / Save audio. Spread `bind` on the bubble's outer element and render
 * `menu` beside it.
 */
export function useMessageActions(msg: LocalMessage) {
  const [menu, setMenu] = useState<{ x: number; y: number; touch: boolean; el: HTMLElement } | null>(null);
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Set when a long-press opened the menu: the release's click (play,
  // retry) and the platform's own long-press contextmenu are swallowed.
  const fired = useRef(false);

  const open = useCallback(
    (x: number, y: number, touch: boolean, el: HTMLElement) => {
      const voice = voiceMediaOf(msg);
      // Start the fetch now (the server converts on first ask) so Share
      // still holds the tap's user activation when the file is ready.
      if (voice) void prefetchVoiceFile(voice, voiceNoteBase(msg)).catch(() => {});
      setMenu({ x, y, touch, el });
    },
    [msg],
  );

  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);

  useEffect(() => cancelPress, [cancelPress]);

  const onContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    if (fired.current) {
      e.preventDefault();
      return;
    }
    if (onLink(e.target) || selectionTouches(e.currentTarget)) return;
    if (!messageMenuItems(msg).length) return;
    e.preventDefault(); // on Android this also stops the long-press word selection
    // Android raises its own long-press contextmenu, often before our timer:
    // whichever comes first opens the menu, once, as a touch menu.
    const touch = !!press.current || (e.nativeEvent as PointerEvent).pointerType === "touch";
    cancelPress();
    if (touch) {
      fired.current = true;
      navigator.vibrate?.(12);
    }
    open(e.clientX, e.clientY, touch, e.currentTarget);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    fired.current = false;
    if (e.pointerType === "mouse" || !e.isPrimary || onLink(e.target)) return;
    cancelPress();
    const el = e.currentTarget;
    const { clientX: x, clientY: y, pointerId: id } = e;
    const timer = setTimeout(() => {
      press.current = null;
      if (selectionTouches(el) || !messageMenuItems(msg).length) return;
      fired.current = true;
      navigator.vibrate?.(12);
      open(x, y, true, el);
    }, LONG_PRESS_MS);
    press.current = { id, x, y, timer };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_SLOP) cancelPress();
  };

  const onClickCapture = (e: React.MouseEvent<HTMLElement>) => {
    if (!fired.current) return;
    fired.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  // Shift+F10 / the Menu key from anything focused inside the bubble (the
  // play button, the transcript toggle) — keyboard reach with no new tab stops.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
    if (!messageMenuItems(msg).length) return;
    e.preventDefault();
    const r = (e.target as HTMLElement).getBoundingClientRect?.();
    open(r ? r.left : 0, r ? r.bottom : 0, false, e.currentTarget);
  };

  const close = useCallback(() => setMenu(null), []);

  return {
    bind: {
      onContextMenu,
      onPointerDown,
      onPointerMove,
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress,
      onClickCapture,
      onKeyDown,
    },
    menu: menu && (
      <ContextMenu x={menu.x} y={menu.y} items={messageMenuItems(msg, menu.touch, menu.el)} onClose={close} autoFocus={!menu.touch} />
    ),
  };
}
