# Operating map: AHI

This is the AHI source tree: what AHI Setup carries and installs. Use this map to find where a
thing lives, where new work belongs, and what not to touch.

## Purpose

AHI is a small team of agents (Michael, Tzali, Avi, Miriam) that runs on the owner's own computer:
a server with a web app, voice, and an installer that sets it all up. On Linux it also carries a
foreman for supervised build sessions. This map is the one-page guide to the tree, for people and
agents alike.

## Contents

| Path | What it is |
|---|---|
| `app/` | The AHI server (TypeScript, Node 22): chat, voice, the agents' turns, memory search, `/ui/send` and the foreman endpoints |
| `app/web/` | The web app (React + Vite) the server serves |
| `app/onboarding/` | AHI Setup (Electron): the installer, the setup screens and the launcher |
| `agents/` | The agents' souls and shared foundation, copied into `AHI_OS` by setup |
| `mission-control/` | Starter files for Michael's workspace, copied into `AHI_OS` by setup |
| `skills/` | The skills shelf: `skills/<category>/<skill>/SKILL.md`, plus `MANIFEST.json` |
| `foreman/` | Supervised build sessions: Michael starts, steers and closes Tzali/Avi builds in tmux. Linux only; see `foreman/README.md` |
| `torah/` | The agents' library. It ships empty; texts arrive only when the owner asks, with their source |
| `runtimes/` | Entry points for other runtimes (`codex/`, `mat/`) |
| `infra/` | Shared infrastructure; `infra/sessions/` holds the session index built up as you work |
| `docs/` | Longer per-agent documentation |
| `.github/workflows/` | The installer build: a manual run makes review artifacts, a version tag publishes a release |
| `README.md`, `LICENSE`, `GUIDE.pdf`, `.env.example` | Distribution surface. `.env.example` holds names only, never values |

Created on the owner's machine, never committed: the owner's folder (`Personal/`, `Work/`) and its
hidden `AHI_OS/` system folder (the souls, mission control, the library and the skills) with `state/` (sign-in, memory), `logs/`, `documents/`, and on Linux
the foreman's `builds/`, `locks/`, `QUEUE.md` and `ACTIVE-GATES.md` (seeded from
`foreman/templates/`).

## Where new material belongs

- A new skill: on the skills shelf, then exported into `skills/`. Never hand-edit `skills/`.
- A server feature: `app/src/`, with its test in `app/test/`.
- A setup step: `app/onboarding/src/`, with its test in `app/onboarding/test/`.
- A new standing automation for the foreman: `foreman/desks/` (see `foreman/desks/README.md`).
- Work in progress, evidence, transcripts and logs: a build copy, never this tree.

## Read/write boundaries

- Never commit secrets, `state/`, sign-in files, or foreman runtime files (`.gitignore` lists them).
- AHI Setup copies only what it lists: the souls, mission control, the library, the public
  skills and, on Linux, the foreman. Nothing else in this tree reaches an owner's machine.
- Setup never overwrites a file the owner or their agents changed, including the foreman's
  `QUEUE.md` and `ACTIVE-GATES.md`.
- Builds never use the live server as their working folder; they work in a copy. The foreman
  refuses otherwise.

## Update workflow

Change the source here, run the tests that cover it, and keep these in step in the same commit:
`app/package.json` `version`, `app/web/package.json` `version` and `skills/MANIFEST.json`
`release`. The workflow refuses a tag that disagrees with them. Keep this map's Contents table in
step with the top-level folders.

## Testing

- Server: `npm test` in `app/`.
- Web app: `npm run build` in `app/web/` (type check and build).
- Setup: `npm test` in `app/onboarding/` (the workflow runs it on every OS).
- Foreman: `foreman/tests/smoke_install.sh` installs into a throwaway home and runs a dummy build
  start → status → steer → close, including a close with work still queued. No model is called.

## Deployment or archival protocol

AHI ships as AHI Setup installers. Running `.github/workflows/setup-release.yml` by hand builds them
for review; pushing a version tag `v<version>` builds them and publishes the GitHub release with the
skills bundle. Owners update from Settings → Updates in the app.

## Next authoritative map

This is the top of the tree. Folder guides one level down: `foreman/README.md`,
`foreman/FOREMAN.md`, `skills/README.md` and `app/onboarding/README.md`.
