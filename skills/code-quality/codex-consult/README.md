# codex-consult

A skill for AHI agents to consult OpenAI's Codex CLI (GPT-5 / Codex Plus) as a second-opinion peer.

## Why this exists

Frontier models disagree productively. When Tzali, Michael, or any other AHI agent
is about to commit a non-trivial decision — an architecture choice, a security
finding, a tricky bug fix — getting Codex's independent take catches blind spots
that a single model's reasoning misses.

This skill makes that consultation a one-liner from any agent's bash tool, with
no human in the loop and no TUI babysitting.

## When an agent should invoke it

| Situation | Invoke? |
|-----------|---------|
| Stuck >10 min on a bug | Yes |
| Architecture decision with >2hr of code at stake | Yes |
| Cross-validate a security review finding | Yes |
| Compare against an alternative implementation | Yes |
| Want validation rather than critique | No |
| Trivial question | No |
| Inside a tight loop | No (quota) |
| Answer is in the codebase already | No (read it) |

## The Critical Gotcha — `codex exec`, not `codex`

This is the difference between a working skill and one that hangs forever.

The Codex CLI's top-level invocation:
```
codex "your prompt"
```
spawns the **interactive TUI** and waits for keyboard input. From an agent's
non-interactive bash subprocess, this hangs until the harness's outer timeout
kicks in — long after any useful response window.

The non-interactive subcommand is:
```
codex exec "your prompt"
```
which streams events, writes the final message to stdout (or to
`--output-last-message <file>`), and exits cleanly with a return code.

**Always use `codex exec`. The wrapper script enforces this — but if you ever
re-implement this skill, do not regress on it.**

## Auth & binary

- Binary: bundled inside `Codex.app` at `/Applications/Codex.app/Contents/Resources/codex`
  (not on PATH by default on this Mac Mini as of 2026-04-26).
- Auth: `~/.codex/auth.json` — run `codex login` once if missing.
- Override binary path: `CODEX_BIN=/path/to/codex`.

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Skill manifest with frontmatter, description, examples |
| `codex_consult.sh` | The wrapper script — POSIX bash, no Python deps |
| `README.md` | This file |

## Smoke test

```bash
~/.claude/skills/codex-consult/codex_consult.sh "Reply with exactly the single word PONG and nothing else."
# Expect: PONG
```

Verified 2026-04-26 on Codex CLI 0.125.0-alpha.3 (~7.5s round-trip).

## Future-proofing

- The `--output-last-message` flag is documented in `codex exec --help` for
  this version; if a future Codex CLI removes it, fall back to parsing the last
  non-empty line of `--json` JSONL output.
- If/when Codex ships an HTTP API, port this to `requests` against the API
  and drop the subprocess entirely — same interface, much faster.
