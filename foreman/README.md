# Foreman

The foreman is how Michael runs a build team. It starts a builder (Zali or Avi) in its own tmux
session on Claude Code or Codex, types steering into it, wakes Michael whenever the builder stops,
and closes the build out — reviewed, archived and cleaned — when the work ships. The owner can watch
or type into any session at any time, and is only asked for real decisions.

## Needs

Linux with a systemd user session (the engine places its tmux server in its own systemd scope so a
gateway restart cannot take builds down, and reads `/proc` to tell a working builder from an idle
one). macOS and Windows are not supported yet. Also: `tmux`, `git`, `python3`, `flock`, the `claude`
CLI signed in, optionally the `codex` CLI, and the AHI gateway running (its `/ui/send` endpoint is how
Michael is woken). Without a gateway, builds still start, run and close; wakes are logged to
`foreman/failed-wakes.log` instead of delivered.

## Install

On Linux, AHI Setup places `foreman/` in your hidden system folder (`<your AHI folder>/AHI_OS/foreman`)
and runs `foreman/bin/fm_setup.sh`. A source install copies it into `$AHI_HOME` (default `~/ahi`) and
runs the same script. It creates the runtime folders, seeds `QUEUE.md` and `ACTIVE-GATES.md` from
`templates/` (never overwriting yours) and checks the gates. Then add the heartbeat — the dead-man's
switch that notices dead or dark builds — to your crontab. The printed lines carry the paths setup
ran with:

```bash
$AHI_HOME/foreman/bin/fm_setup.sh --print-cron     # prints the lines; add them with crontab -e
```

## First build

```bash
cd $AHI_HOME/foreman/bin
./build_start.sh -r claude -m claude-opus-5-5 -e high -w "small refactor, needs design judgment" \
  zali tidy-utils ~/code/myrepo "Zali — tidy src/utils: split the 400-line file, keep behaviour, run the tests."
./build_status.sh                 # all builds; ./build_status.sh <id> for one, with a live pane snapshot
./build_say.sh <id> "also add a test for the date parser"
./build_done.sh <id> done
```

Every start must state runtime, model (full slug), effort and a one-line reason — see
`MODEL-SELECTION.md`. Watch a build with `tmux attach -rt fm-<id>`.

## What is here

| Path | What |
|---|---|
| `FOREMAN.md` | The rulebook: how the loop works, the rails, and the lessons behind them |
| `BRIEFING-CONTRACT.md` | How a raw wake becomes a structured brief for Michael |
| `MODEL-SELECTION.md` | Choosing runtime, model and effort — and recording why |
| `WORKTREES.md` | Build copies: cutting, sharing dependencies, cleaning, retiring |
| `ACTIVE-GATES.md` / `QUEUE.md` | Your rulings: authored in QUEUE.md, carried machine-readably into every build (seeded from `templates/`) |
| `bin/` | The engine: `build_*` commands, hooks (`foreman_wake.sh`, `foreman_notify.sh`, `foreman_codex_notify.sh`), the heartbeat, gates, status records, close-out |
| `desks/` | Standing jobs that act on their own; `queue_desk.sh` is the example |
| `canary/` | Decoy files that prove a build's path rails fire |
| `tests/smoke_install.sh` | Installs into a throwaway `$AHI_HOME` and runs a dummy build start → status → close |

Runtime state (`builds/`, `locks/`, `state/`, `logs/`) is created on install and never shipped.

## Configuration

Everything resolves from the foreman's home: `FM_AHI_HOME` if set, else `AHI_HOME` (default `~/ahi`).
Under AHI Setup the server runs with `AHI_HOME` set to your AHI folder and passes `FM_AHI_HOME` (the
`AHI_OS` folder), `FOREMAN_ROOT`, `FM_USERS_JSON`, `FM_GATEWAY_DIR` and `GATEWAY_URL` to Michael's
turns, so builds he starts protect the right souls and state. Overrides: `FOREMAN_ROOT`, `FM_GATEWAY_DIR`
(gateway tree, default `$AHI_HOME/gateway`), `FM_WORKTREES_DIR` (build copies, default
`$AHI_HOME/builds`), `GATEWAY_URL` (default `http://localhost:18789`), `FM_GATEWAY_TOKEN` (else the
first admin user in `FM_USERS_JSON`, default `$FM_GATEWAY_DIR/config/users.json`), `FM_CAP` (concurrent builds, default 5),
`AHI_FM_CLAUDE_BIN`, `FM_CODEX_BIN`. Archiving on finish is local by default
(`$AHI_HOME/state/build-archive/`); set `FM_RESTIC_REPO` and `FM_RESTIC_PASSWORD_FILE` to archive
to restic instead.
