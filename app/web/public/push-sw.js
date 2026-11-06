/**
 * push-sw.js — Web Push handlers (Step 8, 2026-07-13).
 *
 * Pulled into the generated Workbox service worker via
 * `workbox.importScripts` (vite.config.ts) — vite-plugin-pwa stays in
 * generateSW mode, we just add push behavior on top.
 *
 * Server-side settings (per-agent mute, quiet hours, sound, vibration)
 * are enforced BEFORE a push is sent (gateway src/push.ts) — anything
 * that arrives here is meant to be shown. One exception: when the app is
 * open and focused, the WS thread already renders the message, so the
 * banner is suppressed to avoid double-notifying.
 *
 * OS notification settings are respected by construction: plain
 * notifications, no interruption-level overrides; `silent`/`vibrate`
 * only ever reduce what the OS would do.
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "AHI", body: event.data ? event.data.text() : "New message" };
  }

  event.waitUntil(
    (async () => {
      // Suppress the banner when a window is focused — the in-app thread
      // (WS) is already showing the message.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const focused = clients.some((c) => c.focused && c.visibilityState === "visible");
      if (focused) return;

      const options = {
        body: data.body || "New message",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        // Same tag per messageId: the voice-note upgrade of a text
        // message REPLACES its notification instead of stacking.
        tag: data.tag || undefined,
        data: { url: data.url || "/", bot: data.bot || null },
        silent: data.silent === true,
        timestamp: data.timestamp || Date.now(),
      };
      if (Array.isArray(data.vibrate) && data.vibrate.length > 0) {
        options.vibrate = data.vibrate;
      }
      await self.registration.showNotification(data.title || "AHI", options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an existing app window if one exists; open one otherwise. A
      // deep link (review desk: /?review=<id>) is handed to the running app,
      // which routes to it without a reload (App.tsx listens for ahi-open).
      for (const client of clients) {
        if ("focus" in client) {
          if (url !== "/") client.postMessage({ type: "ahi-open", url });
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
