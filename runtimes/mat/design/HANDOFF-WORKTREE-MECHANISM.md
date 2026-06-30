# MAT Handoff And Worktree Mechanism Design

Status: DRAFT for Claude Code Phase 2.

## Design Summary

MAT coordination has two layers:

1. A human-readable ledger named `MAT-HANDOFF.md`.
2. Optional git worktrees for target projects that are actual git repositories.

For the current bootstrap task, `$AHI_HOME` is not a git repo, so the Phase 1 handoff lives at:

```text
$AHI_HOME/MAT-HANDOFF.md
```

For future project work, MAT should discover the target repo and create session worktrees under:

```text
$AHI_HOME/workspaces/mat/<task-slug>/
```

## Helper Scripts To Implement

Recommended directory:

```text
$AHI_HOME/runtimes/mat/scripts/
```

Recommended commands:

```text
mat-session-init
mat-worktree-prepare
mat-handoff-checkpoint
mat-handoff-wait
mat-prompt-for-mat
```

These may be separate shell scripts or one `mat` command with subcommands. Prefer the simpler implementation that fits the existing AHI shell style.

## `mat-session-init`

Inputs:

```text
--task-slug <slug>
--project-root <path>
--mode relay|conjunction
--runtimes codex,claude-code
```

Behavior:

1. Create `$AHI_HOME/workspaces/mat/<task-slug>/`.
2. Create or initialize `MAT-HANDOFF.md`.
3. Detect whether `project-root` is in a git repo.
4. Record repo root, mode, expected runtimes, and checkpoint names in the handoff header.

## `mat-worktree-prepare`

Inputs:

```text
--runtime codex|claude-code
--task-slug <slug>
--project-root <path>
```

Behavior for git repo projects:

1. Resolve repo root.
2. Create runtime worktree in the MAT session directory.
3. Create runtime branch.
4. Expose the shared ledger at `<worktree-root>/MAT-HANDOFF.md`.

Behavior for non-git projects:

1. Do not attempt `git worktree`.
2. Print the global handoff path.
3. Use runtime-specific scratch if needed.

## `mat-handoff-checkpoint`

Inputs:

```text
--checkpoint <number>
--name <short-name>
--runtime codex|claude-code
--mode relay|conjunction
--summary-file <path>
```

Behavior:

1. Append a timestamped checkpoint block.
2. Include worktree path, branch, changed files, verification, blockers, and next prompt when available.
3. End with exact text: `CHECKPOINT <number> COMPLETE`.

## `mat-handoff-wait`

Inputs:

```text
--checkpoint <number>
--expect codex,claude-code
--handoff <path>
```

Behavior:

1. Check for the expected checkpoint completion lines.
2. In a non-interactive implementation, exit 0 when all are present and nonzero when missing.
3. Optional polling mode may sleep and recheck, but should print what it is waiting for.

Important: the agent protocol matters more than the script. If the peer checkpoint is missing, the runtime must not continue past the checkpoint.

## `mat-prompt-for-mat`

Inputs:

```text
--task <text or file>
--mode relay|conjunction
--project-root <path>
--task-slug <slug>
--checkpoints <list>
```

Behavior:

1. Render `$AHI_HOME/runtimes/mat/templates/prompt-for-MAT.md`.
2. Print one artifact the operator can paste.
3. In CONJUNCTION mode, the same artifact is pasted into both runtimes.
4. In RELAY mode, the handoff-producing runtime may render a tailored next prompt.

## Ledger Format

The ledger is append-only during active coordination. Do not rewrite peer notes unless the operator explicitly asks.

Header:

```md
# MAT-HANDOFF

- Task:
- Mode:
- Project root:
- Session dir:
- Handoff path:
- Expected runtimes:
- Checkpoints:
```

Checkpoint:

```md
## CHECKPOINT <n> - <name>

- Runtime:
- Timestamp UTC:
- Branch:
- Worktree:
- Completed:
- Files changed:
- Verification:
- Blockers:
- Next action:
- Next prompt:

CHECKPOINT <n> COMPLETE
```

## Lens Notes

- Michael lens: A single append-only ledger gives each runtime enough state to resume without asking the operator to reconstruct context.
- Avi lens: The ledger is readable Markdown, not a hidden state database. The machinery can be inspected without feeling like machinery.

