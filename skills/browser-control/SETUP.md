# browser-control Setup

This skill is optional. It ships with the public AHI framework but needs user
configuration before it can run.

Install Playwright MCP and Chrome/Chromium:

- `npm install -g @playwright/mcp` or configure it through your agent client.
- Install Chrome or Chromium.
- Use `skills/browser-control/scripts/launch-chrome-cdp.sh` for a dedicated
  remote-debugging profile.

Never commit browser profiles, cookies, screenshots, or credentials. The public
repo only stores scripts and instructions.

