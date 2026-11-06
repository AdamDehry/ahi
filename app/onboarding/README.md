# AHI Setup

A self-contained desktop setup app with an optional paired browser mode for Linux servers. All implementation lives here; gateway and redesign files are unchanged.

The setup flow names a workspace, prepares an empty AHI home, installs and signs in through official model CLIs, stores optional voice credentials, prepares optional remote access, and records requested connections. AHI's agents run on Claude today, so setup requires a connected Claude account and makes it the default brain; other providers can be connected and are kept for later. On finish it installs the bundled AHI server into the home (with only the public skills), makes the owner's sign-in key once, and starts AHI.

Development requires Node 22.22.2 or later:

```sh
cd onboarding
npm ci --include=dev
npm test
npm run stage:runtime
npm start
```

For the labeled browser preview, use `npm run preview`, then open `http://127.0.0.1:4189`. Its sign-ins are fixtures and it refuses API keys. `npm run test:ui` captures each screen using Playwright Chromium. `npm run probe` installs actual official CLIs into clean homes inside this directory and checks their signed-out behavior; it never logs in. `npm run test:native` exercises the real desktop bridge. Its headless display switches are test-only.

`npm run dist` builds the native platform’s review installer without publishing. `npm run stage:runtime` must run first. The manual GitHub workflow builds each architecture on a matching native runner, so the OS credential binding and bundled Node match the target. Actual Mac/Windows outputs require those runners; this Linux worktree contains the AppImage and unpacked Linux app. See root REPORT and DECISIONS for paths, measured checks and limitations.

Linux VPS owners can run `./AHI-Setup-0.1.0-linux-x86_64.AppImage --ozone-platform=headless --disable-gpu --headless-setup`. On a minimal Linux host, Electron desktop mode needs libnss3 and libnspr4. On systems without FUSE, run `--appimage-extract` in a new empty directory, then `squashfs-root/AppRun --ozone-platform=headless --disable-gpu --headless-setup`. Use an SSH local forward for port 4189 and open `http://127.0.0.1:4189` on the local computer. Enter the private pairing code from the SSH terminal. The server binds only loopback. The folder field refers to the VPS, and provider login scripts run in its SSH terminal. Stop the process to invalidate the browser’s setup session. Do not expose or proxy this setup server publicly. When setup finishes it installs and starts AHI on the VPS (port 18789, or `AHI_PORT`); forward that port the same way to open it, or set up remote access.

For a minimal VPS that cannot run Electron’s Linux libraries, the extracted artifact also has a direct server entry: `squashfs-root/resources/runtime/node squashfs-root/resources/setup-server/src/headless-runner.cjs`. It uses the same setup service and pairing protocol, with no graphical shell and no system Node dependency.

Before a tunnel is routed or started, Setup checks the port: `GET /health` must answer with this home's `home` id and an unsigned `GET /ui/session` must answer 401. On the bundled server's port, Setup starts AHI first, which it does only once setup is finished. Cloudflare setup is skippable. Domain ownership/purchases and persistent background tunnel service installation remain with the owner and installed agent.

Production sign-ins, actual OS keychain persistence, native Mac/Windows installers, full chat handoff, speech playback and authenticated phone/PWA operation still require the native checklist. The dependency audit carries npm-bundled advisories that automatic fixes cannot resolve; this is a working review preview, not a release-cleared distribution.
