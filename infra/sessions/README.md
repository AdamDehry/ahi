# AHI Brain Sessions

This directory contains the public, empty brain-building pipeline.

Runtime data lives under:

- `$AHI_HOME/state/primary/sessions/index.json`
- `$AHI_HOME/state/primary/sessions/transcripts/`
- `$AHI_HOME/state/primary/sessions/logs/`

The public repo intentionally ships no real transcripts, memories, customer
data, or private session history.

## Automatic loop

1. Claude Code writes JSONL session files under `~/.claude/projects/`.
2. The AHI Stop hook calls `gateway/hooks/ahi-brain-record.sh`.
3. The hook runs `infra/sessions/scripts/process-session.mjs`.
4. The script writes a Markdown transcript, summary, category, and
   Sha'ar/Shoresh coordinates into the runtime index.
5. The existing `UserPromptSubmit` retrieval hook can surface matching
   memories on later turns.

The installer also schedules `brain-build.mjs` as a periodic catch-up job
where the host OS supports it.
