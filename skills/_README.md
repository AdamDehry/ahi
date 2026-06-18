# AHI Skills

This directory contains portable skills for the public AHI distribution.

Skills are framework instructions and helper scripts. They should not contain
credentials, private transcripts, customer data, machine-specific absolute
paths, or generated artifacts. Use `$AHI_HOME`, `$HOME`, and paths relative
to the installed AHI directory.

Optional skills that require paid accounts, local CLIs, browser profiles, or
MCP connectors include a `SETUP.md` with the user-supplied prerequisites.

## Included

- `youtube-lessons` - capture lessons from YouTube videos
- `video-prompt-builder` - structure prompts for AI video work
- `avi-video-pipeline` - character-consistent video pipeline playbook
- `audit-codebase` - structured code/security/performance audits
- `browser-control` - Playwright/CDP browser operation
- `codex-consult` - optional Codex CLI second opinion
- `room-redesign` - optional productized interior redesign workflow
- `find-skills` - discover/install additional skills
- `memory-fetch` - load AHI brain entries by Sha'ar/Shoresh address
- `higgsfield-*` - optional Higgsfield account/MCP workflows
