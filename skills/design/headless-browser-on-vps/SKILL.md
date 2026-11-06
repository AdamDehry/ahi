---
name: headless-browser-on-vps
description: Get a headless Chromium (Playwright) and poppler working on a Linux server where you have no sudo, then screenshot pages, render components, or read PDFs and slide decks as images. Use for UI screenshots, visual checks of a built page, or reading a PDF/design deck the agent can't parse as text. Not for driving a logged-in browser session (use browser-control).
version: 1.0.0
category: design
private: false
last_verified: 2026-11-05
verified_by: skills-audit
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
6. One component: render it with `react-dom/server` inside the same rig; with tsx set `globalThis.React` first (tsx emits classic JSX).

## Gotchas

- No emoji font on most servers: emoji render as tofu boxes. Don't call that a bug in the page.
- `100dvh` and other real-viewport behavior can't be proven headless; say so instead of claiming it.
- Keep screenshots out of shipped commits (evidence folders only).
- Run heavy renders under oom-safe-test-runs on small boxes.

## Related skills

browser-control (logged-in, real Chrome) · oom-safe-test-runs
