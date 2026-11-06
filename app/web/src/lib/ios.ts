/* ============================================================
   ios.ts — the app always fits the iPhone screen.

   On iPhone the app zoomed in or out "on its own". It was not on its own:
   iOS zooms the page in whenever a text field with a font-size under 16px
   takes focus, and leaves it zoomed after the keyboard closes. Every field
   in the app was under 16px (composer 15, add-bill 14, settings 13, the
   call's drop line 14, clipboard 15), so every tap into one zoomed.
   Android never auto-zooms on focus, which is why the S25 was fine.

   The fix is iPhone-only, so Android renders exactly as before:
   - `html.ios` (set here, at boot) lifts every text field to 16px
     (app.css, --fs-field-ios) and pins text-size-adjust, so rotating the
     phone does not inflate the type either.
   - The viewport gains maximum-scale=1. Since iOS 10 Safari ignores it for
     the user's own pinch-zoom (accessibility stays intact) but honours it
     for focus zoom — a second guard for any field added later at 14px.
   - When the keyboard closes, the page is put back at the top. The shell
     is a fixed 100dvh box that never scrolls, but iOS scrolls the window
     to keep a focused field above the keyboard and, in an installed PWA,
     does not always scroll it back — the app is left shifted up.

   `navigator.userAgent` carries "iPhone"/"iPad" in every iOS browser
   (they are all WebKit); iPadOS in desktop mode reports a Mac with touch.
   ============================================================ */

interface NavLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

export function isIOS(nav: NavLike): boolean {
  if (/iPhone|iPad|iPod/.test(nav.userAgent)) return true;
  return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}

/** `content` of the viewport meta with maximum-scale=1 (once, order kept). */
export function withMaxScale(content: string): string {
  if (/maximum-scale\s*=/.test(content)) return content;
  return `${content.trim().replace(/,\s*$/, "")}, maximum-scale=1`;
}

const FIELD = "input, textarea, select, [contenteditable='true']";

export function applyIOSFit(doc: Document = document, win: Window = window): boolean {
  if (!isIOS(win.navigator)) return false;
  doc.documentElement.classList.add("ios");

  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = withMaxScale(meta.content);

  // Keyboard closed (focus left every field): put the page back. Deferred a
  // frame so a tap from one field straight into another is not a "close".
  doc.addEventListener("focusout", () => {
    win.setTimeout(() => {
      const el = doc.activeElement;
      if (el && el.matches?.(FIELD)) return;
      if (win.scrollX !== 0 || win.scrollY !== 0) win.scrollTo(0, 0);
    }, 50);
  });
  return true;
}
