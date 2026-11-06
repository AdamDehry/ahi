---
name: headless-browser-on-vps
description: Get a headless Chromium (Playwright) and poppler working on a Linux server where you have no sudo, then screenshot pages, render components, or read PDFs and slide decks as images. Use for UI screenshots, visual checks of a built page, or reading a PDF/design deck the agent can't parse as text. Not for driving a logged-in browser session (use browser-control).
version: 1.4.0
category: design
private: false
last_verified: 2026-11-06
verified_by: zali (build mobile-fixes, round 2)
---

# headless-browser-on-vps

Unpack the missing system libraries into your home, point `LD_LIBRARY_PATH` at them, and Playwright's cached headless shell runs without root.

## When to use

- Screenshot a page or a built web app on a server.
- Read a PDF or a multi-column design deck by rendering pages to PNG and looking at them.
- Preview one React component without starting the app.

## Steps

1. One-time: get the libraries Chromium needs without sudo:
   `mkdir -p ~/.local/chrome-deps && cd ~/.local/chrome-deps && apt-get download libnspr4 libnss3 [other missing libs] && for d in *.deb; do dpkg-deb -x "$d" root; done`
   then record the library path once: `echo "$HOME/.local/chrome-deps/root/usr/lib/x86_64-linux-gnu" > ~/.local/chrome-deps/libpath.txt`
   (Find what's missing with `ldd <chrome binary> | grep "not found"`.)
2. Every run: `export LD_LIBRARY_PATH=$(cat ~/.local/chrome-deps/libpath.txt)`.
3. Launch Playwright with the cached shell: `chromium.launch({ executablePath: '<~/.cache/ms-playwright/chromium_headless_shell-NNNN/...>' })`.
4. PWAs: warm each new context until a service worker controls the page (the app reloads once), then screenshot.
5. PDFs and decks: `pdftoppm -r 120 -png in.pdf out` (poppler libs from the same libpath), then read every PNG. Render EVERY page of multi-column design decks; text extraction scrambles them.
6. One component, static: render it with `react-dom/server` inside the same rig; with tsx set `globalThis.React` first (tsx emits classic JSX).
7. Real components with effects, data and the app's CSS (no gateway, no login): a throwaway Vite harness OUTSIDE the repo.
   - `index.html` + `main.tsx` that import the app's global CSS files in `main.tsx` order, wrap the component in the
     same shell classes the app uses (e.g. `.rd-app`, `.rd-app.phone` under 700px), and stub `window.fetch` for the
     endpoints it calls (return sample JSON). Pick the scene from `?view=…&n=…&theme=…`.
   - `vite.config.mjs`: `root` = harness dir, `esbuild: { jsx: "automatic" }` (NOT `@vitejs/plugin-react` — loaded from
     outside the project it can't resolve `react-refresh`), `resolve.alias` + `dedupe` for react/react-dom pointing at the
     project's `web/node_modules`, `server.fs.allow` = [harness, web], `hmr: false`.
   - Serve it as a named unit so it can be stopped exactly: `systemd-run --user --unit <name> --collect -p MemoryMax=900M
     bash -lc 'env -u NODE_ENV node <web>/node_modules/vite/bin/vite.js --config <harness>/vite.config.mjs > <log> 2>&1'`.
   - Screenshot per scene with `newPage({ viewport, reducedMotion })`; for layout bugs also log each element's
     `getBoundingClientRect()` and computed `animationName`, so before/after is measured, not eyeballed.
   - Feed sample data in the SAME shape production sends (e.g. newline-ended stream lines) — a tidy sample hid a real parsing bug once.
8. The WHOLE web app with demo data (marketing or README screenshots), from a worktree with no `node_modules`:
   - In the harness dir symlink `src -> <worktree>/app/web/src` and `node_modules -> <an install of the same package.json>`
     (read-only use), entry `import "./stubs"; import "./src/main.tsx";`, and set `resolve.preserveSymlinks: true` —
     otherwise every bare import ("marked", "@simplewebauthn/browser") fails, because Vite resolves from the REAL file path.
     Alias `virtual:pwa-register` to a stub exporting `registerSW(){}`.
   - `stubs.ts` replaces `window.fetch` (`/ui/session` → a demo owner, `/ui/messages` → sample thread, `/app/builds` → an
     empty view so cards don't sit on "Loading…", everything else 404) and `window.WebSocket` with a class that opens and
     sends `{type:"session"}` then `{type:"history",messages}` (give it the static CONNECTING/OPEN/CLOSING/CLOSED).
   - Pin sample timestamps to a fixed local hour so "Good morning" isn't stamped 4:47 PM.
   - README app shots (`docs/images/app-home.png`, `app-chat.png`) match the originals only with: viewport 1440x900,
     `deviceScaleFactor: 1.5`, `reducedMotion: "reduce"`, wait 3 s, then click the nav text first — `Home` for the home
     shot (the app opens on Messages, not Home), `Messages` for the chat shot — wait 2 s and shoot. Then with PIL:
     `.convert("RGB").resize((1600, 1000), LANCZOS).quantize(256, method=MEDIANCUT, dither=NONE)`, saved `optimize=True`
     (the originals are 1600x1000, 256-colour palette, ~85 KB). The demo user's `agents` list in `stubs.ts` must use the
     current agent ids — the rail and team strip draw each agent's initial from it.
   - Setup (Electron) screens: drive `app/onboarding/scripts/readme-shots.cjs` — it wraps the loopback preview and swaps in a
     sample owner, home path and fake key.

9. Before/after and "desktop unchanged" proof:
   - BEFORE code without touching the worktree: `git archive HEAD web/src web/public | tar -x -C /tmp/<x>-before`, a
     second harness on another port pointing at it.
   - Layout bugs: in the page, list every element whose `getBoundingClientRect().right > innerWidth` and every
     element with `scrollWidth > clientWidth` and overflow-x auto/scroll — a number before and after, not a picture.
   - Desktop unchanged: same scenes on both harnesses with `reducedMotion: "reduce"`, diff with PIL
     `ImageChops.difference(a, b).getbbox()`. Hover and caret leave a few-pixel diff: run the ORIGINAL twice and
     show the same bbox differs orig-vs-orig before calling it noise.
   - Media in a harness: `<img src="/ui/media/<id>">` never goes through the stubbed `fetch`. Serve it from a tiny
     Vite plugin in the harness config (`configureServer` → `server.middlewares.use`, `/ui/media/<id>[/thumb]` → a
     generated PNG and a 320 px JPEG thumb, as the gateway makes). Vite only reloads on a config change if it notices;
     after adding the plugin, restart the server (exact pid) and check with curl that the image, not index.html, comes back.
   - Chat threads are virtualized (react-virtuoso): rows off screen are not in the DOM. Scroll every scrollable element
     to the bottom before measuring the newest rows. A click that a banner or overlay intercepts: `locator.evaluate(e => e.click())`.
   - Measure image sharpness as `max(shownW/naturalW, shownH/naturalH) × devicePixelRatio` per `<img>` — > 2 is visibly blurry.
   - Media in a harness: `<img src="/ui/media/<id>">` never goes through the stubbed `fetch`. Serve it from a tiny
     Vite plugin in the harness config (`configureServer` → `server.middlewares.use`, `/ui/media/<id>[/thumb]` → a
     generated PNG and a 320 px JPEG thumb, as the gateway makes). After adding the plugin restart the server (exact pid)
     and curl an image: getting index.html back means the config didn't reload.
   - Chat threads are virtualized (react-virtuoso): off-screen rows are not in the DOM. Scroll every scrollable element
     to the bottom before measuring the newest rows. A click a banner or overlay intercepts: `locator.evaluate(e => e.click())`.
   - Image sharpness per `<img>`: `max(shownW/naturalW, shownH/naturalH) × devicePixelRatio`; above 2 is visibly blurry.
   - Playwright: `/tmp/pwc/node_modules/playwright-core` (1.64) runs with the cached
     `chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`.

## Gotchas

- No emoji font on most servers: emoji render as tofu boxes. Don't call that a bug in the page.
- `100dvh` and other real-viewport behavior can't be proven headless; say so instead of claiming it.
- Keep screenshots out of shipped commits (evidence folders only).
- Run heavy renders under oom-safe-test-runs on small boxes.
- `playwright-core` from some other folder may expect a newer browser build than the one cached; pass
  `executablePath` to the cached `chromium_headless_shell-NNNN` instead of downloading.
- Stopping a harness: if `systemctl` is denied, find the server's pid with `ss -ltnp | grep <port>` and kill that exact pid.
  Vite reloads itself when its config file changes, but NOT when symlinks or the entry change.

## Related skills

browser-control (logged-in, real Chrome) · oom-safe-test-runs
