const CACHE_NAME = "ahi-dashboard-shell-v77";
const APP_SHELL = [
  "/",
  "/ui",
  "/ui/style.css?v=77",
  "/ui/app.js?v=77",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

const STATIC_RE = /\.(?:css|js|mjs|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|otf|json|webmanifest)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isLiveUiRequest(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(networkFirst(request, "/"));
    return;
  }

  if (STATIC_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

function isLiveUiRequest(url) {
  if (!url.pathname.startsWith("/ui/")) return false;
  return !STATIC_RE.test(url.pathname);
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === "basic") {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return (await cache.match(request)) ||
      (fallbackUrl ? await cache.match(fallbackUrl) : null) ||
      new Response("", { status: 504, statusText: "Gateway Timeout" });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && response.type === "basic") {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}
