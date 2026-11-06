# AHI

AHI is a small team of AI agents that lives on your own computer and works with you: in a calm web app, by voice, and (if you like) from your phone.

- **Michael** — your right hand. Plans, coordinates, keeps track, and brings the important decisions back to you.
- **Tzali** — builds and fixes software and keeps your setup running.
- **Avi** — design: turns ideas into thoughtful visuals and products.
- **Miriam** — personal assistant: your calendar, your documents, and a patient ear.

Each agent has its own character and purpose, and they share one foundation. You can change how they talk to you; you can't change who they are.

## Install

1. Go to **[Releases](../../releases/latest)** and download AHI Setup for your computer:
   - **Mac** — `AHI-Setup-…-mac-arm64.dmg` (Apple silicon) or `…-mac-x64.dmg` (Intel)
   - **Windows** — `AHI-Setup-…-win-x64.exe`
   - **Linux** — `AHI-Setup-…-linux-x86_64.AppImage`
2. Open it. AHI Setup walks you through everything, in the app:
   - your name and a name for your space
   - where your files live (AHI makes one folder with **Personal** and **Work**, plus a hidden system folder)
   - connecting a model — sign in with your own account
   - voice, if you want it
   - a private address so AHI opens on your phone, if you want it
3. At the end AHI Setup shows **your key** once. Save it in your password manager — it's how you sign in.
4. Click **Open AHI**. It opens in your browser. Keep AHI Setup open (minimized is fine) while you use AHI.

No cloning, no terminal, no code.

> The installers are not code-signed yet. On a Mac, right-click AHI Setup and choose **Open** the first time; on Windows, choose **More info → Run anyway**.

## What you need

- **A Claude account.** The agents think with Claude today. AHI Setup installs Claude's official tool and you sign in with your own account; AHI never sees your password.
- **Optional:** an OpenAI, Cartesia, ElevenLabs or Google key for spoken replies and voice calls with any agent.
- **Optional:** a Cloudflare account and a domain, for a private address to open AHI from your phone.
- Integrations (Gmail, Calendar, Drive, Telegram and more) start unconnected. Link the ones you want during setup or later from **Connections**.

## Your data

Everything lives on your computer, in the folder you chose. Your agents' memory, your documents and your settings are files you own. AHI sends a conversation to the model you connected only when you talk to an agent, and it never sends your key or your files anywhere else.

The agents' souls and library live in the hidden system folder (`AHI_OS`). They're readable files, nothing secret; to change how an agent works, ask Michael rather than editing them by hand.

## Good to know

- AHI runs while AHI Setup is open. Close it and AHI stops; open it again and AHI starts.
- **Staying up to date:** open **Settings → Updates**. AHI checks this project's latest release and tells you when a newer one is out. New and improved skills install with **Update skills** (anything they replace is kept in `AHI_OS/skills/_backup/`); a newer AHI itself comes as a new AHI Setup from the same release. Your folder and memory stay.
- The agents run on Claude for now. Other providers can be connected in setup, and will be able to run agents in a later version.
- **Supervised builds (Linux):** AHI Setup also installs the foreman, which lets Michael start, watch and close Tzali's and Avi's longer build sessions in the background. It needs `tmux`, `git` and `python3`; see `AHI_OS/foreman/README.md`. On a Mac or Windows it is not installed.

## For developers

```
app/            the AHI server (TypeScript, Node 22) and its web app (app/web, React + Vite)
app/onboarding/ AHI Setup (Electron): the installer, setup screens and the launcher
agents/         the agents' souls (copied into AHI_OS by setup)
mission-control/ starter files for Michael's workspace
skills/         the skills shelf: skills/<category>/<skill>/SKILL.md, plus MANIFEST.json
foreman/        supervised build sessions (Linux; copied into AHI_OS by setup) — see foreman/README.md
```

### Skills

Skills are the agents' step-by-step know-how, one shelf per category (`video`, `design`, `code-quality`,
`ops-infra`, `research`, `torah`, …). Every `SKILL.md` starts with frontmatter the app and the release read:

```yaml
name: oom-safe-test-runs      # = folder name
description: …                # when to use it (the trigger text)
version: 1.0.0                # bump on every change
category: code-quality        # = shelf folder
private: false                # only private: false skills are published
last_verified: 2026-11-05
verified_by: <who checked it>
sources: [ … ]                # where each step came from
```

`skills/MANIFEST.json` lists every skill's version and the release they ship in. A release keeps three
numbers in step — the `v*` tag, `app/package.json` `version` and `skills/MANIFEST.json` `release` — and the
workflow refuses to publish if they differ. Publishing attaches `ahi-skills.json` (every skill's files with
their sha256, built by `app/scripts/skills-bundle.mjs`); **Settings → Updates** compares it with the installed
`MANIFEST.json` and installs the newer skills.

Build the server and web app:

```sh
cd app && npm ci --include=dev && npm run build
cd web && npm ci --include=dev && npm run build
```

Run AHI Setup from source: `cd app/onboarding && npm ci --include=dev && npm run stage:runtime && npm start`. Installers are built for every platform by the **Build AHI Setup installers** workflow; pushing a `v*` tag publishes them as a release.

## License

See [LICENSE](LICENSE).
