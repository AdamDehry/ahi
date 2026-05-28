# AHI

AHI is a multi-persona, purpose-aligned AI suite that runs on your machine. It gives you a small build team of agents through Claude Code, an optional Telegram gateway, and an optional voice layer.

The v1 suite ships with three personas:

- **Michael** — coordinator, strategist, and right hand
- **Tzali** — builder, engineer, and systems operator
- **Avi** — designer, visual conscience, and product taste layer

Each agent has its own soul file, tool defaults, memory pointers, and optional Telegram bot token. They share the same AHI foundation: distinct agents, one kavana underneath.

## What You Need

- **Claude Max subscription** with the **Claude Code** desktop app installed and signed in. Get it at [claude.ai/download](https://claude.ai/download).
- **Node.js 20 or newer.** Install from [nodejs.org/en/download](https://nodejs.org/en/download), or via Homebrew (`brew install node`) on macOS.
- **Optional: Telegram account** if you want to message agents from your phone. The wizard walks you through creating one bot per enabled agent via `@BotFather`.
- **Optional: OpenAI or Gemini API key** if you want voice replies. Either provider works.

## Install

Clone this repo, then from the repo directory run:

```bash
./install.sh        # macOS / Linux
.\install.ps1       # Windows PowerShell
```

The wizard takes a few minutes and walks you through six steps:

1. Your name and optional one-line context
2. Confirm Claude Code is ready
3. Choose which agents to enable: Michael, Tzali, Avi, or all three
4. Telegram setup for each selected agent
5. Voice provider selection
6. Install — copies files, builds the gateway, registers the auto-start service

When it finishes, open Claude Code in your install directory (default `~/ahi/`) and try:

> Hi Michael, who are you?

For engineering work, talk to Tzali. For design judgment, talk to Avi.

## Meet The Agents

### Michael

Michael is the coordinator and strategic operator. Use him for planning, prioritization, delegation, mission control, and turning vague intent into a sharper work order.

Default model: Sonnet. Default tools include file access, shell access, web research, subagent delegation, and selected skills.

### Tzali

Tzali is the builder and systems engineer. Use him for code, infrastructure, debugging, deployments, repo work, and implementation plans that need to survive contact with the real system.

Default model: Opus. Default tools include read/write/edit, shell access, web research, subagent delegation, and skills.

### Avi

Avi is the designer and visual conscience. Use him for UI/UX direction, product feel, brand surfaces, visual critique, design specs, and creative work where taste matters.

Default model: Opus. Default tools include read/write access, search, web research, design-oriented skills, and no shell by default.

## Where Things Live

By default AHI installs at `~/ahi/`:

```text
~/ahi/
  .claude/                # Claude Code project config
  agents/soul/            # Persona files: MICHAEL.md, TZALI.md, AVI.md
  mission-control/        # HANDOFF, TODO, TODAY, ACTIVITY_FEED
  infra/sessions/         # Session index built up as you work
  gateway/                # Telegram + voice gateway
  state/                  # Logs, per-user state, generated files
  skills/                 # Optional Python skills
```

The `state/` directory is per-install and never committed. `gateway/.env` holds secrets and is locked to your user (`chmod 600`).

## Day-To-Day Use

- **Claude Code:** open a session in `~/ahi/` and address the agent you need.
- **Telegram:** message the agent-specific bot you configured.
- **Dashboard:** open the local gateway UI and use the agent filter/send target.
- **Mission control:** agents keep `mission-control/HANDOFF.md`, `TODAY.md`, `TODO.md`, and `ACTIVITY_FEED.md` current as you work.

## Configuration

The gateway loads one bot per configured token:

```env
MICHAEL_BOT_TOKEN=
TZALI_BOT_TOKEN=
AVI_BOT_TOKEN=
```

Users and their allowed agents are configured in `gateway/config/users.json`:

```json
[
  {
    "name": "Primary",
    "agents": ["michael", "tzali", "avi"],
    "admin": true
  }
]
```

## Troubleshooting

- **Gateway won't start:** check `~/ahi/state/logs/gateway.err.log`.
- **`claude` command not found:** make sure Claude Code is installed and in `PATH`.
- **Permission denied on `.env`:** expected; only your user can read it.
- **macOS LaunchAgent not loading:** run `launchctl load -w ~/Library/LaunchAgents/ai.ahi.gateway.plist` manually.

## Uninstall

```bash
node ~/ahi/installer/lib/uninstall.js
```

The uninstaller backs up `gateway/.env` to `~/ahi.env.bak-<timestamp>`, unloads the LaunchAgent when it belongs to this install, and removes `~/ahi/`.

## Linux Note

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

## Windows Note

The installer copies files and builds the gateway, but does not register a Windows Service. To run the gateway on login, create a Task Scheduler entry pointing at `node %USERPROFILE%\ahi\gateway\dist\index.js` with the start-in directory set to `%USERPROFILE%\ahi\gateway`.

## License

See `LICENSE` for terms.
