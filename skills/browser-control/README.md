# browser-control

This skill gives AHI agents Chrome browser control through Microsoft's official Playwright MCP server, `@playwright/mcp`.

## Installed MCP servers

### Mode A: Persistent Playwright-managed profile

Claude MCP server: `browser-control`

This launches a Chrome instance controlled by Playwright and stores browser state here:

```bash
$AHI_HOME/state/browser-control/chrome-profile/
```

Use this when a separate automation profile is fine. Logins survive across sessions because the profile is persistent.

### Mode B: Attach to existing Chrome via CDP

Claude MCP server: `browser-control-cdp`

This connects to:

```bash
http://127.0.0.1:9222
```

Use this for live demos and paid/licensed tools like a paid or licensed web app. The user logs in manually in a CDP-enabled Chrome profile, then Michael attaches to that browser session.

Important: Chrome 136+ ignores `--remote-debugging-port` when it is launched against the default Chrome user data directory. That means the user's normal already-open Chrome profile cannot be attached to retroactively. Use a non-default profile for the demo, then log in manually once.

## CDP launch command for the user / David

Launch a separate Chrome instance with remote debugging enabled:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/ai/runtimes/browser-control/chrome-cdp-profile" \
  --no-first-run \
  --no-default-browser-check
```

Do not use `$HOME/Library/Application Support/Google/Chrome` for CDP. Modern Chrome blocks remote debugging against that default profile.

Quick verification:

```bash
curl http://127.0.0.1:9222/json/version
```

## H-037: VPS to Mac CDP bridge

From `your remote host`, after Tailscale and SSH are live:

```bash
~/ai/infra/mac-as-hands/bin/mac-cdp-tunnel start
~/ai/infra/mac-as-hands/bin/mac-cdp-smoke "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

The gateway endpoint is:

```bash
http://127.0.0.1:19222
```

This is an SSH local forward to the Mac's `127.0.0.1:9222`; neither port is exposed on the tailnet or LAN.

## Ready prompt for Michael

```text
Attach to Chrome on port 9222, take a screenshot of the current tab, and tell me what you see.
```

## Files

- Persistent Chrome profile:
  `$AHI_HOME/state/browser-control/chrome-profile/`
- Screenshots/output:
  `$AHI_HOME/state/browser-control/screenshots/`
- Screenshot purge script:
  `$AHI_HOME/skills/browser-control/scripts/purge-screenshots.sh`
- LaunchAgent:
  `$HOME/Library/LaunchAgents/ai.ahi.browser-control-screenshot-purge.plist`

Screenshots older than 7 days are purged automatically.
