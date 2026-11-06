---
name: browser-control
description: Drive Chrome through Microsoft's official Playwright MCP server. Use for browser navigation, clicking, typing, screenshots, DOM/text inspection, and attaching to an already-open Chrome session through CDP when the user is logged into a paid or licensed web app.
version: 1.0.1
category: ops-infra
private: false
last_verified: 2026-11-05
verified_by: skills-audit
---

# browser-control

Browser automation for AHI agents through Microsoft's official `@playwright/mcp` package.

## Available MCP servers

- `browser-control` — Mode A, Playwright-managed Chrome with persistent profile:
  `$AHI_HOME/state/browser-control/chrome-profile/`
- `browser-control-cdp` — Mode B, attach to a Chrome instance on:
  `http://127.0.0.1:9222`
- `mac-as-hands` — H-037 gateway path. On `your remote host`, run:
  `${AHI_AI_ROOT:-$HOME/ai}/infra/mac-as-hands/bin/mac-cdp-tunnel start`, then connect to:
  `http://127.0.0.1:19222`

## When to use

- Navigate to URLs, read page titles/text, inspect page structure, click buttons, type into fields, and take screenshots.
- Use Mode A for normal browsing where a dedicated automation profile is acceptable.
- Use Mode B for paid or licensed services where the user can manually log in inside a CDP-enabled Chrome profile, such as a paid or licensed web app.

## Safety guardrails

- Never auto-submit forms with financial, legal, destructive, or account-changing consequences without explicit user confirmation in chat.
- Never type credentials into login forms. Let the user log in manually, then attach afterward.
- For paid/licensed services, default to a manual-login profile. Do not automate login itself.
- Chrome 136+ does not honor `--remote-debugging-port` against the default Chrome profile. Do not promise attachment to the user's normal already-open Chrome profile unless that browser was originally launched with a non-default CDP user data directory.
- Treat browser screenshots as potentially sensitive. Save them only under:
  `$AHI_HOME/state/browser-control/screenshots/`
- Screenshots in that directory are automatically purged after 7 days by the local LaunchAgent `ai.ahi.browser-control-screenshot-purge`.

## Usage

Mode A prompt:

```text
Use browser-control to open https://example.com, take a screenshot, and report the page title plus screenshot path.
```

Mode B prompt:

```text
Attach to Chrome on port 9222, take a screenshot of the current tab, and tell me what you see.
```

Before Mode B works, Chrome must be launched with remote debugging enabled and a non-default user data directory. See `README.md` for the exact command.

For H-037, the Mac launches Chrome with CDP bound to `127.0.0.1:9222` only. The VPS never reaches that port directly; it opens an SSH local forward to `127.0.0.1:19222` through the Tailscale-only Mac SSH path.
