# AHI Foreman — supervised build sessions

The foreman lets a supervisor agent (Michael) commission, watch, steer and close dedicated builder
sessions (Tzali, Avi) end to end, while the owner watches from anywhere and only gets pulled in for
real decisions.

## How it works

```
Michael (gateway turn)                    Build session (tmux + claude | codex)
  build_start.sh ────────────────────────► session starts in its workdir,
                                            addressed to Tzali/Avi
                                            │ works autonomously
       ◄──────── Stop hook (foreman_wake) ──┘ turn ends / goes idle
  gateway /ui/send wakes Michael
  Michael reads the tail, decides:
  build_say.sh "next step" ──────────────► typed into the live session
  ... loop until ...
  build_done.sh <id> done                  session closed, work ready for review
```

- **Steering is `tmux send-keys`.** `claude -p --resume` does NOT attach to a live interactive session;
  the design was pivoted to send-keys before any tool was built on it. Smoke-test a steering mechanic
  on day zero, not after.
- **Read path:** the builder's transcript JSONL under `~/.claude/projects/<workdir-slug>/` (Codex:
  `~/.codex/sessions/`) — read-only, never written.
- **Wake path:** Stop hook → `foreman_wake.sh` → gateway `POST /ui/send` → Michael. His reply lands in
  the owner's thread, so supervision is visible by construction.

## Commands (`$FOREMAN_ROOT/bin`, default `$AHI_HOME/foreman/bin`)

| Command | Purpose |
|---|---|
| `build_start.sh -r <runtime> -m <model> -e <effort> -w "<why>" <agent> <name> <workdir> <brief...>` | Start a supervised build (cap `FM_CAP`, default 5) |
| `build_from_brief.sh <brief.md>` | Start a build from a brief file with a header (agent, name, workdir, model…) |
| `build_say.sh <id> <msg>` | Steer — types into the live session |
| `build_keys.sh <id> approve\|deny\|raw ...` | Answer a permission dialog |
| `build_status.sh [id]` | List builds / full state + live pane snapshot |
| `build_list.sh`, `build_ledger.sh [filter]` | Active builds; history with model, effort, reason and outcome |
| `build_ask.sh <id> "<one question?>"` | Put ONE plain question in front of the owner |
| `build_answered.sh <id> "<answer>"` | Record the owner's answer so the build stops asking |
| `build_done.sh <id> [done\|failed\|abandoned]` | Close a build |
| `build_finish.sh <id> --shipped <repo>@<sha> ...` | Last step after a ship: ledger done, keepers archived and verified, copy removed |
| `fm_close.py sweep [--apply]` | Stragglers: archive+remove closed, merged copies; hold the rest with a reason |
| `fm_gates.py check\|render` | Verify and render the active gates (see ACTIVE-GATES.md) |
| `fm_status.py emit --kind ...` | What a BUILDER runs at each checkpoint (see below) |

The owner watches with `tmux attach -rt fm-<build-id>` (read-only), from the Claude/Codex apps when
remote control is on, or simply types into the pane — interventions land in the same transcript and
Michael sees them on the next wake.

## The three conditions (enforced in code)

1. **The ledger is append-only and outside the gateway.** `builds/<id>/meta.json` is written once,
   `events.jsonl` is append-only, and status is DERIVED from the last `status:*` event. There is no
   status file to rewrite, so no whole-file-rewriting process can clobber it. The gateway never opens
   these files.
2. **The steering mechanic is smoke-tested before anything is built on it.**
3. **Wake-loop guard + dead-man's switch.** Too many wakes in a window → the build is marked stalled,
   auto-wakes stop and Michael is told to escalate; wakes closer than the backoff are skipped. The
   heartbeat (every ~10 min) catches dead tmux sessions and builds that went dark.

## Rails

- Builders run with no permission pauses (`bypassPermissions`) **plus** per-workspace allow/deny rules
  written into the workdir's `.claude/settings.json` by `build_start`. Deny rules hold even in bypass
  mode, so the rails stand: no `git push`, no `systemctl`, no `rm -rf`, no access to the gateway's
  `.env`, no edits to soul files. Pushes and merges go through the supervisor's review.
- Claude Code reads settings literally: deny paths must be ABSOLUTE and resolved (`//abs/path`); an
  env var or a relative spelling silently matches nothing. Every path rail ships with a canary
  (`$FOREMAN_ROOT/canary/`) so a build can prove the rail fires.
- **A worktree is a cwd default, not a filesystem boundary.** When a real boundary is required, name
  the deny rail that provides it.
- Concurrency cap `FM_CAP` (default 5). The practical limit is the machine — watch RAM and disk, not
  a count; never impose a lower number on yourself without measuring.
- The foreman never touches gateway configuration as part of supervision, and a live service's tree
  is never a build workdir (build_start refuses it).

## Gates travel with the build

A ruling written in one place reaches only the turn that reads that place. So the active gates are a
machine-readable file (`ACTIVE-GATES.md`, carried from `QUEUE.md`), `build_start` installs a copy in
the build (`.foreman/ACTIVE-GATES.md`), renders it into the brief, and `fm_gate_guard.py` (a
PreToolUse hook) refuses any subagent spawn whose prompt does not carry the block, and any command a
gate's `forbid:` rail matches. A subagent never receives, resolves or echoes a live credential — the
parent performs any authenticated call and hands over the result.

## The model gate — no silent default

Every start states `-r` runtime, `-m` model (a full slug — aliases resolve silently, often to an older
generation, and are refused), `-e` effort and `-w` why (one line, written into `meta.json`). A model
choice with no recorded reason teaches the next build nothing; with one, the ledger becomes a record
of judgment. Read `MODEL-SELECTION.md` and `build_ledger.sh` before choosing.

- **Decide the runtime by fit, against your own bias.** One builder, two runtimes: Tzali on Claude Code
  IS Tzali on Codex — same soul, different capability set. Exhaustive sweeps and precision review suit
  one; ambiguous design work and long narrative merges suit the other. Whoever BUILDS does not GRADE.
- **Before writing "we have never measured X" — go count** in the ledger, not in memory.
- Effort words differ between the owner's picker and each runtime's CLI; `fm_effort.py` translates and
  refuses a value the runtime would silently drop. Never set effort with an interactive `/effort` in a
  build session — it becomes the global default for every new session.

## Runtime lanes

- **Claude:** launches with remote control when the login supports it (a setup-token disables it, so
  `CLAUDE_CODE_OAUTH_TOKEN` is unset for builder sessions); the session URL is recorded as an `rc-url`
  event. Startup dialogs are dismissed before the brief is typed, or they eat the keystrokes.
- **Codex:** a real interactive session in tmux; the `notify` shim (`foreman_codex_notify.sh`) feeds the
  same wake pipeline, and `fm_stop_watch.sh` polls as a floor because a push channel that stops firing
  must not cost an hour of dead air. Launch with an absolute binary path — a tmux server's PATH can be
  stale.

## Checkpoints are records, not prose

Builders report with `fm_status.py emit --kind progress|needs_owner|closed|failed --finished "…" --now
"…" [--checks P/T] [--question "…?"]`. The record is validated (plain sentences, no paths, ids or markup,
exactly one question for `needs_owner`), the foreman forwards it, and whatever renders it does so in
code. `progress` stays on the build timeline; the other three reach the owner.

## False idle = background shells

A Stop that arrives while the builder's own shells are still running is not an idle the supervisor is
owed. `fm_idle_bg.py` answers first: the first time, ONE steer is typed ("wait in the foreground, then
finish"); the acknowledgement turn is skipped. Michael is woken only on a real stop (closed / failed /
needs_owner) or when the same shells survive the steer.

## Ordered means delivered

Once an idea is designed and the owner says go, the build is the foreman's to deliver end to end.

1. **No babysitting.** A build never waits on the owner to keep moving.
2. **Open decisions do not stop the build.** An unsettled question becomes a NOTE ("a decision is coming
   up: X") while the rest continues. If it is still open when due, Michael decides and lists it in the
   ship note.
3. **Screw-in, not mud-in.** When deciding for the owner, pick the option that can be swapped in
   minutes, never the one that is a project to undo.
4. **The ship note is the only ask:** what we discussed, what we built, what we decided for you, one
   button.
5. **Everyone works.** Capacity is the machine and the cap, nothing self-imposed. Idle builders are a
   foreman failure too.

## Keeping the chain alive

- Wakes come from ACTIVE builds (the stop hook and the heartbeat). Closing the last active build while
  work is queued removes the foreman's own wake source. **Never let the active count hit zero while
  `QUEUE.md` has entries** — start the next build before closing the finished one. `build_done.sh` wakes
  Michael on the zero-active transition as a backstop; the backstop is not the plan.
- **Prefer `build_say.sh` into a LIVE session over close-and-restart.** Every fresh session pays the
  re-orientation tax again; roll several work orders through one session and cut fresh only at a real
  branch boundary or when it degrades.
- **A build is not over until it is FINISHED.** After the owner's OK and the ship, run
  `build_finish.sh` as the last step. It refuses (and changes nothing) unless the shipped commit
  CONTAINS the build's tip and the owner's OK is on record; it then closes the ledger, archives the
  keepers (reports, evidence, brief, ledger, untracked non-regenerable files), reads the archive back,
  and only then removes the copy. Secret files never go into the archive. Any doubt → the copy is held
  and it says why.
- Never `rm -rf` a builds folder. A folder whose `.git` is a DIRECTORY is a clone that may host other
  worktrees: the sweep lists it and never touches it.

## Close-out = review immediately, peer review every time

- The moment a build reports done, Michael reviews it in that same wake. A "closed" wake is a review
  order, not a status line.
- Every code build gets a second-runtime peer review before ship (correctness, efficiency, needless
  complexity): a Claude build is reviewed by Codex and vice versa. Run it in the build's worktree, say
  "make no changes" in the prompt, confirm `git status` is clean afterwards, and wait on it by
  notification — never with a `pgrep -f` loop, whose own command line matches forever. Blockers go
  back to the builder through `build_say.sh`.
- Every build runs ONE simplify pass over its own diff before reporting ready (no behaviour change;
  never cut security, validation, data-loss or error handling, or accessibility) and lands any new
  how-to on the skills shelf (`$AHI_HOME/skills/`) when one exists.

## Standing desks

A desk is a cron job that watches something and acts on its own (starts a build, wakes Michael). See
`desks/README.md` and the example desk. Every desk: UTC cron line, a lock, a KILL file, a DRY switch,
a trimmed log, state, one build at a time, and a cooldown so the same gap is never handed out twice.
