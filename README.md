# AHI Michael

A purpose-aligned AI agent that runs on your machine. Michael is your COO and right-hand strategist — accessible from Claude Code on your computer and (optionally) from Telegram on your phone. He remembers what matters across sessions, coordinates work, and keeps mission control current.

This repository contains everything needed to set Michael up on a fresh Mac (Linux and Windows are supported with minor differences noted below).

## What you need

- **Claude Max subscription** with the **Claude Code** desktop app installed and signed in. Get it at [claude.ai/download](https://claude.ai/download).
- **Node.js 20 or newer.** Install from [nodejs.org/en/download](https://nodejs.org/en/download), or via Homebrew (`brew install node`) on macOS.
- **(Optional) Telegram account** if you want to message Michael from your phone. The wizard walks you through creating a bot via `@BotFather`.
- **(Optional) OpenAI or Gemini API key** if you want voice replies. Either provider works.

## Install

Clone this repo, then from the repo directory run:

```
./install.sh        # macOS / Linux
.\install.ps1       # Windows PowerShell
```

The wizard takes 3-5 minutes and walks you through five steps:

1. Your name and (optional) one-line context
2. Confirm Claude Code is ready
3. Telegram setup (skip if not using)
4. Voice provider selection (skip if not using)
5. Install — copies files, builds the gateway, registers the auto-start service

When it finishes, open Claude Code in your install directory (default `~/ahi/`) and type:

> Hi Michael, who are you?

Michael will introduce himself.

## Where things live

By default Michael installs at `~/ahi/`:

```
~/ahi/
  .claude/                # Claude Code project config (CLAUDE.md, settings)
  agents/soul/MICHAEL.md  # Michael's identity (personalized with your name)
  mission-control/        # HANDOFF, TODO, TODAY, ACTIVITY_FEED — your work surface
  infra/sessions/         # Session index — built up as you work
  gateway/                # Telegram + voice gateway (Node service)
  state/                  # Logs, per-user state, generated files
  skills/                 # Optional Python skills (PDF, Excel, OCR)
```

The `state/` directory is per-install and never committed. The `gateway/.env` file holds your secrets and is locked to your user (chmod 600).

## Day-to-day use

- **Claude Code:** open a session in `~/ahi/` and Michael is ready.
- **Telegram (if set up):** message your bot directly. The gateway runs in the background.
- **Mission control:** Michael keeps `mission-control/HANDOFF.md`, `TODAY.md`, `TODO.md`, and `ACTIVITY_FEED.md` current as you work.

## Troubleshooting

- **Gateway won't start:** check `~/ahi/state/logs/gateway.err.log`.
- **`claude` command not found:** make sure Claude Code is installed and in `PATH`.
- **Permission denied on `.env`:** that's expected — only your user can read it.
- **macOS LaunchAgent not loading:** run `launchctl load -w ~/Library/LaunchAgents/ai.ahi.gateway.plist` manually.

## Uninstall

```
node ~/ahi/installer/lib/uninstall.js
```

Backs up your `.env` to `~/ahi-michael.env.bak-<timestamp>`, unloads the LaunchAgent, and removes `~/ahi/`.

## Linux note

Auto-start on Linux uses systemd. After install, drop a unit file at `~/.config/systemd/user/ahi-gateway.service`:

```ini
[Unit]
Description=AHI Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/ahi/gateway
ExecStart=/usr/bin/node %h/ahi/gateway/dist/index.js
Restart=always
Environment=AHI_HOME=%h/ahi

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now ahi-gateway`.

## Windows note

The installer copies files and builds the gateway, but does not register a Windows Service. To run the gateway on login, create a Task Scheduler entry pointing at `node %USERPROFILE%\ahi\gateway\dist\index.js` with the start-in directory set to `%USERPROFILE%\ahi\gateway`.

## License

See `LICENSE` for terms.
