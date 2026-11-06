# memory-fetch — H-034 lazy-loader

The H-034 stable system prompt for AHI agents intentionally ships ~1.5–2K tokens — only what is universal: identity paragraph, the four worlds, three modes, methodology pointer, tool scope, state pointer. Everything else lives at a (Sha'ar, Shoresh) address. This skill is how an agent reaches into the rest of memory on demand.

## Files

| File              | Purpose                                                  |
|-------------------|----------------------------------------------------------|
| `SKILL.md`        | Skill definition (frontmatter + when-to-invoke)          |
| `memory_fetch.sh` | Thin POSIX-bash wrapper that execs the Node CLI          |
| `memory_fetch.mjs`| Heavy lifting — address resolution, index lookup, render |

## Why a Node CLI

Pure file I/O. No LLM spawn (cost: $0). The skill needs to read the same canonical address book the gateway uses (`$AHI_HOME/infra/sessions/scripts/shaar_shoresh_address_book.mjs`) so address resolution stays consistent across the system. Node + `import` does this trivially; Bash would need to embed/duplicate the address book.

## Address book

Canonical: `$AHI_HOME/infra/sessions/scripts/shaar_shoresh_address_book.mjs`.
TS-mirror (gateway runtime): `src/shaar-shoresh.ts` in the AHI app.

If you edit one, edit the other and note in `$AHI_HOME/mission-control/ACTIVITY_FEED.md`.

## Symlinking into ~/.claude/skills/

Per the standing harness deny-rule on direct writes to `~/.claude/skills/`, this skill lives at `$AHI_HOME/skills/torah/memory-fetch/` and is symlinked from `~/.claude/skills/memory-fetch` at session-end via `h030_finish.sh`. Until the symlink is in place, the skill is invokable by absolute-path bash (the recommended path for build-time testing).

## Cost

Zero LLM spawn. Index file is ~375KB; warm-cache reads are ~20–80ms.

## Foundational principle

This skill is the answer to the H-034 question: "does this move us closer to the שערים/שרשים structure, or away from it?" Letters as coordinates first, summaries at those coordinates second. Every retrieval here goes through the address.
