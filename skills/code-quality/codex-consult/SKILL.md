---
name: codex-consult
description: Consult OpenAI's Codex CLI (GPT-5 / Codex Plus) non-interactively for a second opinion, alternative architecture, deep-reasoning sanity check, or to cross-validate a tricky bug fix. Use when you want another frontier model's take before committing — especially on hard debugging, security review, algorithm choices, or when stuck on something for >10 minutes. NOT a replacement for your own reasoning — it's a peer reviewer. Skip for trivial tasks; each call burns Codex Plus quota.
version: 1.1.1
category: code-quality
private: false
last_verified: 2026-11-05
verified_by: skills-audit
---

# codex-consult

Single-shot bridge to the locally-installed Codex CLI. Returns Codex's final answer as plain text on stdout.

## When to invoke

- Stuck on a bug for >10 minutes — get a second pair of eyes
- About to commit a non-trivial design decision and want a sanity check
- Cross-validate a security finding or threat model
- Get an alternative implementation to compare against
- "Am I thinking about this right?" before writing 200 lines of code

## When NOT to invoke

- Trivial questions you can answer yourself
- Anything where the answer is in the codebase you can read
- High-frequency loops (every call costs Codex Plus quota)
- When you just want validation rather than honest critique

## Usage

```bash
~/.claude/skills/codex-consult/codex_consult.sh "your prompt"

# Or via stdin
cat plan.md | ~/.claude/skills/codex-consult/codex_consult.sh

# Custom timeout (default 90s) and model
~/.claude/skills/codex-consult/codex_consult.sh --timeout 180 --model <current Codex model slug> "prompt"
```

Returns Codex's final message on stdout. Diagnostics go to stderr.

## Peer review before ship

The close-out second opinion on a finished build's diff. Whoever built it does not grade it.

1. Make an empty directory OUTSIDE the repo and run from there. With the repo as cwd, Codex runs
   commands anyway (tests, builds) and can collide with your own runs.
2. Pipe the prompt and the diff in; tell it not to run commands:
   ```bash
   mkdir -p ../codex-review && cd ../codex-review
   { echo "Review this diff for correctness, needless complexity and missed edge cases. Do not run commands."; \
     git -C <repo> diff <base>..HEAD; } \
     | codex exec --skip-git-repo-check -C "$PWD" -o review.md -
   ```
3. Run it in the FOREGROUND. A background run that prints one line and leaves no `review.md` died — rerun it
   in the foreground.
4. On hosts where bubblewrap is refused, `--sandbox read-only` fails before Codex can even run `git`. Don't
   rely on the sandbox there; the piped diff plus an empty cwd is the containment.
5. Verify every finding against the code. Fix what is real; dismiss the rest with the evidence, in the
   build's report.
6. Keep `review.md` with the build (not in `/tmp`, which does not survive a reboot).
7. Use the Codex binary and model your install pins; a stale second `codex` earlier on PATH can refuse
   current models — check `command -v codex`.

## Examples

**Architecture sanity check:**
```bash
~/.claude/skills/codex-consult/codex_consult.sh "I'm building a Telegram gateway that fans out to 5 LLM agents via long polling. Each agent has its own bot token and soul file. Coordination via shared markdown files in mission-control/. Is the markdown-file coordination layer going to bite me at scale, or is it fine for <10 concurrent agents and <100 msgs/min?"
```

**Bug second opinion:**
```bash
~/.claude/skills/codex-consult/codex_consult.sh "$(cat <<'EOF'
Bash heredoc behavior surprised me:
  python3 <<'PY' "$1"
  ...
  PY
The $1 ends up as sys.argv[0] (script name), not sys.argv[1]. Why?
EOF
)"
```

## Implementation notes

- Wraps `codex exec` (the non-interactive entrypoint), NOT bare `codex` (which spawns the TUI and hangs)
- Uses `--ephemeral` so no session files get persisted
- Uses `--skip-git-repo-check` so it works from any directory
- Auto-detects binary: `$CODEX_BIN` → `codex` in PATH → `/Applications/Codex.app/Contents/Resources/codex`
- Final message captured via `--output-last-message <file>`, not stdout parsing
- Timeout enforced via a perl-based portable wrapper (macOS lacks GNU `timeout`)

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success — final message on stdout |
| 1 | No prompt provided |
| 2 | Codex binary not found |
| 3 | Auth missing (`~/.codex/auth.json`) — run `codex login` |
| 4 | Timeout |
| 5 | `codex exec` returned non-zero |
| 6 | No output captured |
