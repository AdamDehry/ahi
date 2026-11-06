---
name: _template
description: Template skill. Not a real skill — copy this directory to <category>/<your-skill-name>/ to start a new one. Never trigger on its own.
version: 1.0.0
category: <the shelf folder it lives on, e.g. video, design, code-quality, ops-infra, research, torah>
private: true            # false only if it holds nothing personal, no keys, hosts or machine paths (it will be published)
last_verified: <YYYY-MM-DD you last ran it>
verified_by: <agent>
sources:
  - <file:line, URL or session each step came from>
---

# Skill Name

_One sentence that captures the essence of what this skill does._

## When to use

List the specific situations that should pull this skill in. The more concrete, the better — the router uses this to decide. Examples:

- "User asks me to generate a video on Higgsfield."
- "User hands me a YouTube link and wants the techniques extracted."
- "Before any production deploy of the AHI Gateway."

## When NOT to use

Optional but recommended — edge cases that look similar but aren't this skill's job. Prevents false triggering.

- "User wants a summary of a YouTube video" → use `web-browse`, not this.

## Required tools

Every tool, MCP, or binary this skill depends on. If a tool is missing, the skill should bail early with a clear message.

- `mcp__Claude_in_Chrome__*` (Chrome extension connected)
- `yt-dlp` installed locally
- `whisper` or `faster-whisper` installed

## Workflow

Numbered, step-by-step. Write it the way you'd brief a colleague who has never done this before. Include decision points, not just actions.

1. **Understand the ask.** Confirm the URL, the output format the user wants, and whether they want lessons extracted or just the raw transcript.
2. **Fetch.** Use `yt-dlp` to pull audio.
3. **Transcribe.** Run Whisper over the audio. Save transcript to `$AHI_AI_ROOT/tmp/<video-id>.txt`.
4. **Extract.** Use an LLM pass to pull out:
   - Core thesis (1–2 sentences)
   - Techniques demonstrated (with timestamps)
   - Tools / software mentioned
   - Actionable steps the user could apply
5. **Report.** Return a structured summary to the user. Offer to save to a specific location if the content warrants it.

## Inputs

What the agent needs to start. Keep this tight.

- A URL or identifier.
- Optional: output preferences (depth, format).

## Outputs

What the user gets back. Be specific.

- A markdown report with the structure above.
- Transcript file path (if saved).

## Notes & gotchas

Edge cases, known failure modes, things that have bitten us before.

- Whisper CPU transcription of a 60-minute video takes ~10 min on this Mac. Warn the user.
- If the video has no audio track (slideshow), fall back to captions if present.

## Changelog

- `2026-04-16` — initial template created.
