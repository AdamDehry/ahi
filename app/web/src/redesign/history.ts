/**
 * Back / Forward for the redesign (slice 1, NAV contract).
 *
 * The store stays the single source of truth. Every navigation-relevant change
 * pushes one browser history entry (`#/page/sub/id`); Back/Forward (the browser's,
 * the chrome's arrows, the phone edge-swipe) restore it through the same store
 * actions a tap would use, so drafts, the live call and the open thread are never
 * touched by navigating. Old deep links (#builds/<id>, #whatsapp/<key>, #feed,
 * ?review=) are still opened by App.tsx first; their entry is REPLACED, not pushed.
 */
import { actions, availableBots, getState, subscribe } from "../store";
import { canOpen, entryView, hashToRoute, isHashRoute, routeToHash, type RouteState } from "./nav";

function routeState(): RouteState {
  const s = getState();
  return {
    view: s.view, settingsOpen: s.settingsOpen, activeBot: s.activeBot,
    buildsItem: s.buildsItem, reviewItem: s.reviewItem, waKey: s.waItem?.key ?? null,
  };
}

/** Apply a `#/…` route to the store. Returns false when the hash is not ours or not allowed. */
export function applyHash(hash: string): boolean {
  const r = hashToRoute(hash);
  if (!r) return false;
  const s = getState();
  const admin = !!s.user?.admin;
  if (r.settings) {
    actions.toggleSettings(true);
    return true;
  }
  const view = r.view ?? (r.page ? entryView(r.page, admin) : null);
  if (!view || !canOpen(view, admin)) return false;
  if (view === "builds" && r.id) actions.openBuilds(r.id);
  else if (view === "review") actions.openReview(r.id);
  else if (view === "whatsapp" && r.id && /^[0-9a-f]{16}$/.test(r.id)) actions.openWhatsApp(r.id);
  else if (view === "messages") {
    actions.setView("messages");
    if (r.id && availableBots(s.user).includes(r.id)) actions.openMobileThread(r.id); // desktop: selects it; phone: opens the thread
  } else actions.setView(view);
  if (getState().settingsOpen) actions.toggleSettings(false);
  return true;
}

/** Phone: a conversation is open (WhatsApp-style) — it takes the whole screen; no top bar, dock or banners. */
export function phoneChatOpen(s: ReturnType<typeof getState>): boolean {
  return s.view === "messages" && s.mobileThreadOpen && !!s.activeBot && !s.settingsOpen;
}

/** Leave a phone conversation for the page before it (one Back); a cold open with nothing in-app behind it goes Home. */
export function leaveChat(): void {
  // Only entries this file pushed carry { ahi: 1 }, and each has an app page behind it.
  if ((window.history.state as { ahi?: number } | null)?.ahi === 1) window.history.back();
  else actions.setView("home");
}

let applying = false;

/** Start syncing. Call once, after the session is known. Returns a stop function. */
export function startHistorySync(): () => void {
  // A cold open on a redesign route lands there.
  if (window.location.hash.startsWith("#/")) {
    applying = true;
    applyHash(window.location.hash);
    applying = false;
  }
  let last = routeToHash(routeState());
  if (window.location.hash !== last) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + last);

  // One history entry per user action: several store writes in the same tick (setView then
  // openMobileThread) coalesce into a single push of the final route (review R1-C4).
  let scheduled = false;
  // An access redirect REPLACES the forbidden entry rather than leaving it one Back away (review R2-12).
  let replaceNext = false;
  const flush = () => {
    scheduled = false;
    const replace = replaceNext;
    replaceNext = false;
    const next = routeToHash(routeState());
    if (next === last) return;
    last = next;
    const ours = !replace && (window.location.hash === "" || window.location.hash.startsWith("#/"));
    const url = window.location.pathname + window.location.search + next;
    if (ours) window.history.pushState({ ahi: 1 }, "", url);
    else window.history.replaceState({ ahi: 1 }, "", url); // an old deep link was just opened
  };
  const unsub = subscribe(() => {
    const st = getState();
    // A session whose access changed (reconnect re-announce) must not stay on a view it may no
    // longer open (review R1-A2): back to Home, replacing the entry.
    if (st.user && !st.settingsOpen && !canOpen(st.view, !!st.user.admin)) {
      replaceNext = true;
      actions.setView("home"); // also clears any open build / review / WhatsApp item (phone layers close)
      return;
    }
    if (applying) {
      last = routeToHash(routeState());
      return;
    }
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });

  const onPop = () => {
    // An old deep link (#builds/<id>, #whatsapp/<key>, #feed) belongs to App.tsx's hashchange
    // handler, which runs after this; leave the URL alone so it can read it, then the store
    // change re-writes the URL as a redesign route (replace, not push).
    if (isHashRoute(window.location.hash)) return;
    applying = true;
    try {
      if (!applyHash(window.location.hash)) {
        // Not ours, or no longer allowed: put the URL back to where the store is.
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + routeToHash(routeState()));
      }
    } finally {
      applying = false;
      last = routeToHash(routeState());
    }
  };
  window.addEventListener("popstate", onPop);
  return () => {
    unsub();
    window.removeEventListener("popstate", onPop);
  };
}
