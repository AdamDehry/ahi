import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { initTheme } from "./theme";
import { applyIOSFit } from "./lib/ios";
import { stashNav } from "./store";
import { reloadWhenNoCall, watchForReleases } from "./lib/releaseCheck";
import "./styles/tokens.css";
import "./styles/redesign-tokens.css";
import "./styles/app.css";
// Every rule inside is scoped under `.voice` (or the call-log card, which only
// renders for a message carrying meta.voiceSession), so with voice mode off
// this stylesheet cannot match anything in the rendered app.
import "./styles/voice.css";
import "./styles/feed.css";
import "./styles/schedule.css";
import "./components/search/search-card.css";
import "./redesign/shell.css";
import "./redesign/messages.css";
import "./redesign/call.css";
import "./redesign/media.css";
import "./redesign/pages.css";
import "./redesign/type-final.css";
import "./components/studio/studio-card.css";

// Installed PWAs can resume an old process without performing a fresh
// navigation, especially on mobile. Check for an update as soon as the app
// opens, then reload exactly once when the new worker takes control so the UI
// and server cannot remain on different releases.
if ("serviceWorker" in navigator) {
  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    // Never under a live call: the reload waits until the call has left
    // (lib/releaseCheck.ts). The screen he is on rides across the reload
    // (store.ts NavSnapshot) — a tap in this window used to be lost (the owner,
    // The Answer bar).
    reloadWhenNoCall(() => {
      stashNav();
      window.location.reload();
    });
  });

  registerSW({
    immediate: true,
    onRegisteredSW(_workerUrl, registration) {
      void registration?.update();
      // A tab left open across a ship never navigates, so the browser never
      // re-checks: check again when it comes back into view (desktop-call-view).
      if (registration) watchForReleases(() => void registration.update().catch(() => {}));
    },
  });
}

initTheme();
// Before the first render: the iPhone fit is a class on <html> (lib/ios.ts).
applyIOSFit();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
