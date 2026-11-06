/* ============================================================
   releaseCheck.ts — a long-open tab picks up a new release, and the release
   reload never lands on a live call (desktop-call-view, 10/15).

   main.tsx checks for a new service worker once, when the app opens, and the
   browser itself re-checks only on a navigation. The app is a single page: a
   desktop tab left open across a ship never navigates, so it kept running the
   old release. That is the likeliest reason the owner's Mac had no Minimize on the
   call screen the iPhone (reopened, so updated) showed cleanly.

   Two rules, both pure so they can be tested without a browser:
   - CHECK again when the tab comes back into view, at most every
     RELEASE_CHECK_EVERY_MS, and never while a call is live (an update found
     mid-call would reload the page under it).
   - RELOAD for a new release only when no call is live. A release that takes
     control during a call (the browser's own check, or a check that raced a
     call starting) waits; the page reloads once the call has left.
   ============================================================ */
import { getState, subscribe } from "../store";

export const RELEASE_CHECK_EVERY_MS = 10 * 60_000;

export function shouldCheckForRelease(o: { visible: boolean; inCall: boolean; lastCheckAt: number; now: number }): boolean {
  return o.visible && !o.inCall && o.now - o.lastCheckAt >= RELEASE_CHECK_EVERY_MS;
}

/** Run `reload` now when no call is live, else once the store's call is gone. */
export function reloadWhenNoCall(reload: () => void): void {
  if (!getState().call) {
    reload();
    return;
  }
  let done = false;
  const unsubscribe = subscribe(() => {
    if (done || getState().call) return;
    done = true;
    unsubscribe();
    reload();
  });
}

/** Re-check for a new release whenever the tab becomes visible again (throttled, never mid-call). */
export function watchForReleases(check: () => void, now: () => number = Date.now): () => void {
  let lastCheckAt = now();
  const onVisible = (): void => {
    const t = now();
    if (!shouldCheckForRelease({ visible: document.visibilityState === "visible", inCall: !!getState().call, lastCheckAt, now: t })) return;
    lastCheckAt = t;
    check();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
}
