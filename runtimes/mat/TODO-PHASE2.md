# MAT Phase 2 TODOs For Claude Code

Status: DRAFT. These are implementation markers, not completed work.

## Launcher

- TODO(MAT-launcher): Extend `$AHI_HOME/runtimes/codex/launch-as.sh`.
- TODO(MAT-launcher): Add `mat` as a valid agent.
- TODO(MAT-launcher): Add `compose_mat_prompt` and keep existing single-agent composition unchanged.
- TODO(MAT-launcher): Reuse `append_section`.
- TODO(MAT-launcher): Include Michael, Avi, Tzali, shared AHI core, and `$AHI_HOME/agents/MAT-COLLABORATION-PROTOCOL.md`.
- TODO(MAT-launcher): Confirm `launch-as.sh mat --dry-run` and an existing single-agent dry run both work.

## Handoff And Worktrees

- TODO(MAT-tools): Create `$AHI_HOME/runtimes/mat/scripts`.
- TODO(MAT-tools): Implement session init.
- TODO(MAT-tools): Implement worktree prepare with safe non-git fallback.
- TODO(MAT-tools): Implement checkpoint append.
- TODO(MAT-tools): Implement checkpoint wait/check.
- TODO(MAT-tools): Implement prompt generator from `$AHI_HOME/runtimes/mat/templates/prompt-for-MAT.md`.

## Runbook

- TODO(MAT-runbook): Write `$AHI_HOME/runtimes/mat/RUNBOOK.md`.
- TODO(MAT-runbook): Include "Hey MAT" day-to-day use.
- TODO(MAT-runbook): Include RELAY and CONJUNCTION examples.
- TODO(MAT-runbook): Include troubleshooting for missing checkpoint, wrong worktree, non-git project, and stale handoff.

## Lens Notes

- Michael lens: The TODOs are scoped to implementation and verification, with no identity reinvention.
- Avi lens: The output should leave the operator with one command, one prompt, and one handoff file.

