# MAT Runbook — day-to-day operation

> **MAT** = **M**ichael · **A**vi · **T**zali — three masteries, one mind, across two runtimes (Claude Code + Codex).
> One command boots it. One pasted prompt runs it. One file (`MAT-HANDOFF.md`) keeps both runtimes in sync.

This runbook is for the operator. It assumes the Phase 2 build is in place:

- Launcher: `$AHI_HOME/runtimes/codex/launch-as.sh` (adds the `mat` identity).
- Helpers: `$AHI_HOME/runtimes/mat/scripts/mat.sh` (session / worktree / handoff / prompt).
- Protocol (source of truth): `$AHI_HOME/agents/MAT-COLLABORATION-PROTOCOL.md`.
- Souls (source of truth): `$AHI_HOME/agents/soul/{MICHAEL,AVI,TZALI}.md`.

---

## 1. The one-minute version

**Boot MAT in Codex:**

```sh
~/ai/runtimes/codex/launch-as.sh mat
```

On first boot, Codex may ask whether you trust `$AHI_HOME/runtimes/codex`; choose **Yes**.
If the composed MAT prompt appears in the input box instead of immediately submitting,
press **Enter** to send it. MAT should then acknowledge in one voice and wait for direction.

**Talk to it:** just say *"Hey MAT, …"* and describe what you want. MAT carries all
three lenses (Michael = architecture/ops, Avi = design/clarity, Tzali = build/verify)
and names the leading lens only when it helps you.

**For a two-runtime task** (Codex *and* Claude Code working the same job), generate one
prompt and paste it into both:

```sh
~/ai/runtimes/mat/scripts/mat.sh prompt --mode conjunction \
  --task "what you want done" --task-slug my-task --project-root /path/to/repo
```

That's it. Everything below is detail for when you want it.

---

## 2. Booting MAT

| Runtime | How to boot |
|---|---|
| **Codex** | `$AHI_HOME/runtimes/codex/launch-as.sh mat` |
| **Codex (preview only)** | `$AHI_HOME/runtimes/codex/launch-as.sh mat --dry-run` → writes `$AHI_HOME/runtimes/codex/.last-system-prompt.md`, does not launch |
| **Claude Code** | Open Claude Code, then paste a MAT prompt (see §5). Claude Code reads its identity from the pasted prompt + repo `AGENTS.md`/`CLAUDE.md`. |

`launch-as.sh mat` composes one system prompt from: the MAT boot header → Michael soul
→ Avi soul → Tzali soul → shared neshamah → AHI Foundation → universal NESHAMA/USER
layers (if present) → the MAT collaboration protocol → per-soul memories → runtime
orientation. The single-agent identities (`michael`, `tzali`, `avi`, `miriam`)
are unchanged — `launch-as.sh tzali` still does exactly what it always did.

Check what's wired up:

```sh
~/ai/runtimes/codex/launch-as.sh --list   # shows the mat composite block + file status
~/ai/runtimes/mat/scripts/mat.sh --list   # shows protocol/template/ledger status
```

---

## 3. The two modes

### RELAY (sequential) — one runtime at a time

Use when the work has phases or one runtime is naturally better for the next step
(e.g. *Codex designs → Claude builds → Codex finalizes* — that's how MAT itself was built).

1. Runtime A works its phase.
2. Runtime A writes a checkpoint block to `MAT-HANDOFF.md` **including a tailored prompt
   for Runtime B**, ending with the exact line `CHECKPOINT <n> COMPLETE`.
3. Runtime A **stops**.
4. You paste Runtime B's tailored prompt into Runtime B. It picks up from the ledger.

### CONJUNCTION (parallel) — both runtimes at once

Use when Codex and Claude Code can work related slices simultaneously.

1. Generate **one** prompt (`mat.sh prompt --mode conjunction …`) and paste the **same**
   prompt into both runtimes.
2. Each runtime works in **its own git worktree** (no clobbering).
3. Both append progress to the **same** `MAT-HANDOFF.md`.
4. Neither crosses a checkpoint until both have written `CHECKPOINT <n> COMPLETE` (§4).

---

## 4. The sync / wait rule (the heart of MAT)

> **Neither MAT instance proceeds past checkpoint N until the other expected instance has
> written `CHECKPOINT N COMPLETE` (plus its notes) to `MAT-HANDOFF.md`.**

This is how the two runtimes "wait for each other regardless of who works faster." It is
primarily a **discipline the agent follows**, with helper commands to make it mechanical:

**Write a checkpoint** (before crossing it):

```sh
~/ai/runtimes/mat/scripts/mat.sh checkpoint \
  --checkpoint 1 --name "scaffold" --runtime codex --mode conjunction \
  --task-slug my-task --project-root /path/to/repo \
  --completed "scaffolded module X" --files "src/x.ts" --verification "npm test green"
```

(Add `--next-prompt "…"` or `--next-prompt-file FILE` in RELAY mode to embed the handback.)

**Check / wait for the peer:**

```sh
# one-shot check — exit 0 if all expected runtimes are complete, non-zero if not
~/ai/runtimes/mat/scripts/mat.sh wait --checkpoint 1 \
  --expect codex,claude-code --task-slug my-task --project-root /path/to/repo

# polling mode — re-checks every --interval seconds, prints what it's waiting on
~/ai/runtimes/mat/scripts/mat.sh wait --checkpoint 1 \
  --expect codex,claude-code --task-slug my-task --project-root /path/to/repo \
  --poll --interval 20 --timeout 600
```

`wait` matches a checkpoint to a runtime by reading each block's `- Runtime:` field and its
`CHECKPOINT N COMPLETE` line. Runtime labels are normalized, so `Claude Code`, `claude-code`,
and `CLAUDE-CODE` all count as `claude-code`.

---

## 5. Generating the prompt to paste

```sh
~/ai/runtimes/mat/scripts/mat.sh prompt --mode conjunction \
  --task "Build the onboarding flow and verify it end to end" \
  --task-slug onboarding --project-root /path/to/app --checkpoints "1,2,3"
```

- Reads the canonical template `$AHI_HOME/runtimes/mat/templates/prompt-for-MAT.md` (the part
  between `## BEGIN PROMPT` and `## END PROMPT`) and fills in every `{{placeholder}}`.
- Prints **one** artifact. In **CONJUNCTION**, paste the same artifact into both runtimes —
  each self-identifies as `codex` or `claude-code` from its environment.
- Long task text: use `--task-file path/to/brief.md` instead of `--task "…"`.
- For a git project it prints the per-runtime worktree paths; for a non-git project it
  prints the work-in-place note and points at the global ledger.

---

## 6. Worktree & file conventions

MAT never assumes `$AHI_HOME` is a git repo — it discovers the real target repo first.

**Git-backed project** (recommended for real builds):

```text
~/ai/workspaces/mat/<task-slug>/
  ├── MAT-HANDOFF.md          # the one shared ledger
  ├── codex/                  # worktree, branch mat/<task-slug>/codex
  │     └── MAT-HANDOFF.md    # symlink -> ../MAT-HANDOFF.md
  └── claude-code/            # worktree, branch mat/<task-slug>/claude-code
        └── MAT-HANDOFF.md    # symlink -> ../MAT-HANDOFF.md
```

Set it up:

```sh
mat.sh session-init --task-slug <slug> --project-root /path/to/repo --mode conjunction --checkpoints "1,2"
mat.sh worktree-prepare --runtime codex       --task-slug <slug> --project-root /path/to/repo
mat.sh worktree-prepare --runtime claude-code --task-slug <slug> --project-root /path/to/repo
```

Each runtime then works **only inside its own worktree** and commits there; you see both
sides' commits on the shared filesystem and review/merge the branches when done.

**Non-git task** (e.g. editing the AHI filesystem itself):

- No worktrees are created. Each runtime works in place.
- The shared ledger is the global `$AHI_HOME/MAT-HANDOFF.md`.
- `worktree-prepare` detects this and just prints a runtime scratch dir + the global ledger
  path instead of running `git worktree`.

The visible coordination filename is **always** `MAT-HANDOFF.md`, wherever it physically lives.

---

## 7. Troubleshooting

| Symptom | What it means | Fix |
|---|---|---|
| **Peer checkpoint missing** — `wait` keeps reporting a runtime as missing | That runtime hasn't written `CHECKPOINT N COMPLETE` yet, or wrote a different `Runtime:` label | Confirm the peer actually ran `mat.sh checkpoint` (or wrote the block by hand) with a matching `--checkpoint N` and a `- Runtime:` value of `codex`/`claude-code`. Do **not** proceed past the checkpoint until it appears. |
| **Wrong worktree** — edits show up on the other runtime's branch | The runtime cd'd into the peer's worktree | Each runtime works only in `$AHI_HOME/workspaces/mat/<slug>/<its-own-runtime>/`. Move the change to the correct worktree (or cherry-pick the commit) and re-run. |
| **"non-git" when you expected worktrees** | `--project-root` points outside a git repo (e.g. `$AHI_HOME`) | Point `--project-root` at the actual repo, or accept the non-git fallback (work in place + global ledger). `git -C <root> rev-parse --show-toplevel` tells you the repo root. |
| **Stale handoff** — ledger describes an old run | A previous session's `MAT-HANDOFF.md` is still in place | The ledger is append-only by design. Start a fresh `--task-slug` (gets its own session dir + ledger), or archive the old ledger and re-run `session-init` (use `--force` to rewrite the header — it will refuse to clobber a non-empty ledger otherwise). |
| **`session-init` says "ledger already exists … leaving it intact"** | Overwrite protection — it won't destroy peer checkpoints | Expected and safe. Use a new `--task-slug`, or `--force` if you genuinely want a fresh header. |
| **Branch already exists** on `worktree-prepare` | A prior run created `mat/<slug>/<runtime>` | The helper attaches a worktree to the existing branch instead of failing. To start clean, remove the old worktree (`git worktree remove`) and delete the branch, or use a new slug. |
| **Codex shows the full MAT prompt instead of answering** | The TUI loaded the composed prompt into the input buffer and is waiting for confirmation | Press **Enter** to submit it. If a "Create a plan?" prompt appears, dismiss or choose the normal mode you want, then submit. |
| **MAT feels like a committee** (three voices arguing) | The mode is being over-used for trivial work | MAT should speak as one. For a quick single-lens task, boot a single agent (`launch-as.sh tzali`) instead. Reserve MAT for work that genuinely benefits from the cross-lens / cross-runtime cover. |

**Restore the launcher** if a change ever regresses single-agent behavior:

```sh
cp $AHI_HOME/runtimes/codex/launch-as.sh.pre-mat.bak $AHI_HOME/runtimes/codex/launch-as.sh
```

---

## 8. Quick reference

```sh
# Boot
~/ai/runtimes/codex/launch-as.sh mat                 # launch MAT on Codex
~/ai/runtimes/codex/launch-as.sh mat --dry-run       # preview composed prompt only

# Generate the pasteable prompt (both runtimes in conjunction)
mat.sh prompt --mode conjunction --task "…" --task-slug S --project-root P

# Set up a parallel git session
mat.sh session-init     --task-slug S --project-root P --mode conjunction --checkpoints "1,2"
mat.sh worktree-prepare --runtime codex       --task-slug S --project-root P
mat.sh worktree-prepare --runtime claude-code --task-slug S --project-root P

# Coordinate
mat.sh checkpoint --checkpoint 1 --name "…" --runtime codex --mode conjunction --task-slug S --project-root P
mat.sh wait       --checkpoint 1 --expect codex,claude-code --task-slug S --project-root P [--poll]
```

(`mat.sh` lives at `$AHI_HOME/runtimes/mat/scripts/mat.sh`.)
