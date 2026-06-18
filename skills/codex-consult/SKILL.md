---
name: codex-consult
description: Consult OpenAI's Codex CLI (GPT-5 / Codex Plus) non-interactively for a second opinion, alternative architecture, deep-reasoning sanity check, or to cross-validate a tricky bug fix. Use when you want another frontier model's take before committing — especially on hard debugging, security review, algorithm choices, or when stuck on something for >10 minutes. NOT a replacement for your own reasoning — it's a peer reviewer. Skip for trivial tasks; each call burns Codex Plus quota.
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
$AHI_HOME/skills/codex-consult/codex_consult.sh "your prompt"

# Or via stdin
cat plan.md | $AHI_HOME/skills/codex-consult/codex_consult.sh

# Custom timeout (default 90s) and model
$AHI_HOME/skills/codex-consult/codex_consult.sh --timeout 180 --model gpt-5-codex "prompt"
```

Returns Codex's final message on stdout. Diagnostics go to stderr.

## Examples

**Architecture sanity check:**
```bash
$AHI_HOME/skills/codex-consult/codex_consult.sh "I'm building a Telegram gateway that fans out to 5 LLM agents via long polling. Each agent has its own bot token and soul file. Coordination via shared markdown files in mission-control/. Is the markdown-file coordination layer going to bite me at scale, or is it fine for <10 concurrent agents and <100 msgs/min?"
```

**Bug second opinion:**
```bash
$AHI_HOME/skills/codex-consult/codex_consult.sh "$(cat <<'EOF'
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
