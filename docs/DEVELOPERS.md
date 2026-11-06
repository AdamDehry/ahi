# AHI for developers

The front page ([README](../README.md)) is for people using AHI. This page is for people building it.

## Repo layout

```
app/            the AHI server (TypeScript, Node 22) and its web app (app/web, React + Vite)
app/onboarding/ AHI Setup (Electron): the installer, setup screens and the launcher
agents/         the agents' souls (copied into AHI_OS by setup)
mission-control/ starter files for Michael's workspace
skills/         the skills shelf: skills/<category>/<skill>/SKILL.md, plus MANIFEST.json
foreman/        supervised build sessions (Linux; copied into AHI_OS by setup) — see foreman/README.md
docs/           this page and the README's screenshots (docs/images)
```

## Build

Build the server and web app:

```sh
cd app && npm ci --include=dev && npm run build
cd web && npm ci --include=dev && npm run build
```

Run AHI Setup from source: `cd app/onboarding && npm ci --include=dev && npm run stage:runtime && npm start`. Installers are built for every platform by the **Build AHI Setup installers** workflow; pushing a `v*` tag publishes them as a release.

The README's setup screenshots come from AHI Setup's loopback preview with sample data:
`cd app/onboarding && node scripts/readme-shots.cjs` (writes `docs/images/setup-*.png`; needs Playwright's Chromium,
set `CHROMIUM_PATH` to use a specific one). Shrink them below ~400 KB each before committing.

## Supervised builds (Linux)

On Linux, AHI Setup also installs the foreman, which lets Michael start, watch and close Tzali's and Avi's longer
build sessions in the background. It needs `tmux`, `git` and `python3`; see `AHI_OS/foreman/README.md`. On a Mac
or Windows it is not installed.

## Skills

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
