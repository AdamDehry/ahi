---
name: youtube-lessons
description: Use when the user or any agent hands me a YouTube URL and wants the practical content extracted — techniques, visual cues, tools, actionable steps, key quotes, timestamps. Not for "just summarize this video" (use web-browse for that). This skill uses optional remote Mac backend to fetch/transcribe/sample visual frames on the user's Mac, then fuses transcript + frames into a structured lessons report.
owner: shared
requires:
  - yt-dlp
  - mlx-whisper
  - ffmpeg
tags: [video, youtube, transcription, vision, knowledge-capture]
---

# youtube-lessons

Turn a YouTube URL into a captured, reusable skill-knowledge entry under `~/ai/skills/videos/yt/<id>/`.

Default path is v2 Vision: capture timestamped transcript plus sampled frames, then write the report from both. Transcript-only remains the fallback when the Mac is unavailable or the user pasted transcript text manually.

## When to use

- the user shares a YouTube link of a tutorial, talk, interview, or shiur and asks for "lessons", "techniques", "what they teach", "how to apply this", or "extract the skills."
- Agent needs to learn a workflow demonstrated on video (e.g., a Higgsfield tutorial) before building the `higgsfield` skill playbook.
- Capturing reference material that should persist and be searchable across future sessions.

## When NOT to use

- User just wants a quick summary — use `WebFetch` on the YouTube URL page instead, it's faster.
- User wants to watch the video themselves — don't run transcription, just confirm the URL works and hand it back.
- Video is already captured at `~/ai/skills/videos/yt/<id>/` with a `report.md` — re-read that instead of re-transcribing.

## Workflow

### VPS / H-037 transport note

On `your remote host`, YouTube may block datacenter fetches. Use the user's Mac as the residential fetch/transcription/frame backend:

```bash
$AHI_HOME/skills/youtube-lessons/scripts/capture-vision-vps.sh "<youtube-url>"
```

That command SSH-runs the Mac-side capture script over H-037, where yt-dlp fetches the video/audio from the user's residential IP, MLX Whisper transcribes on the M4, ffmpeg samples visual frames, and rsync copies only the lean bundle back to the VPS. If yt-dlp hits a bot-check, the Mac-side script retries with cookies from the dedicated CDP Chrome profile.

### 1. Confirm the ask

Before running the pipeline, confirm with the user:
- The URL (paste it back to verify).
- Whether this is worth capturing permanently — transcription takes ~2–5 minutes for a 30–60 min video on the M4, plus first-time model download (~1.5GB). If it's a one-shot question, `WebFetch` is cheaper.
- Whether the content is in English or another language (the skill auto-detects, but flagging Hebrew/other up-front lets us note it in the report).

### 2. Check cache first

```bash
# If the video was already captured, don't re-transcribe.
ls ~/ai/skills/videos/yt/<video-id>/report.md 2>/dev/null
```

Extract the 11-char video ID from the URL (the `v=` param for watch URLs, or the path segment for `youtu.be/` shortlinks). If `report.md` already exists, read it and answer from it. Mention to the user that it's a cached capture.

### 3. Run the v2 Vision capture pipeline

From the VPS:

```bash
$AHI_HOME/skills/youtube-lessons/scripts/capture-vision-vps.sh "<url>"
```

This writes/syncs:

- `metadata.json`
- `transcript.txt`
- `transcript.srt`
- `frames/`
- `frames-manifest.json`

The raw video/audio stays Mac-side to keep the VPS mirror lean.

Frame strategy:

- scene-change sampling with `select='gt(scene,0.4)'`
- max time gap of about 5 seconds so static-but-important moments are not missed
- downscale to roughly 768px wide
- cap around 120 delivered frames
- every frame is timestamp-named, e.g. `frame_02m54s.jpg`

Always check `frames-manifest.json` before writing the report. Mention how many frames were sampled and the span covered. If the frame count is suspiciously low or the span does not cover the full video, report that explicitly instead of silently trusting the capture.

### 3b. Transcript-only fallback

```bash
$AHI_HOME/skills/youtube-lessons/scripts/transcribe.sh "<url>"
```

This writes `audio.m4a`, `metadata.json`, `transcript.txt`, and `transcript.srt` to `~/ai/skills/videos/yt/<id>/` and prints the directory path to stdout. On failure (private, age-gated, live stream not ended) the script exits non-zero with a clear message — relay it to the user.

For non-English content pass the language flag via the model (uncommon — Whisper auto-detects reliably). Hebrew Torah shiurim work out of the box.

### 4. Read, watch, and extract

Read `transcript.txt`, `transcript.srt`, `frames-manifest.json`, and representative frames across the video. The `.srt` gives spoken timestamps; the manifest maps frame files to visual timestamps. Use both.

The report must include at least one visual observation that is not merely copied from the transcript, such as:

- on-screen text overlays
- charts/diagrams
- demonstrated movements or equipment setup
- before/after visuals
- UI workflows or button locations

### 5. Write the report

Create `~/ai/skills/videos/yt/<id>/report.md` using this structure:

```markdown
# {Title}

**Source:** {url}
**Channel:** {channel}
**Duration:** {HH:MM}
**Captured:** {date} by {agent-name}

## Thesis
One or two sentences — what this video actually argues or teaches. Not what it covers, but what it *claims*.

## Techniques demonstrated
- **[MM:SS]** Technique name — one-line description. Why it matters.
- **[MM:SS]** ...

## Tools / software mentioned
- **Name** — what it does, and whether the speaker endorses it or just mentions it.

## Actionable steps
Numbered, concrete steps the user could actually take today. Not "consider doing X" — "do X by doing Y."
1. ...
2. ...

## Quotes worth keeping
Short, exact quotes (under 15 words each) with timestamps. Use sparingly — only real signal.

## Caveats / what this video doesn't cover
What the speaker assumes, skips, or gets wrong. Prevents over-applying.

## Relevance to AHI
One short paragraph — does this connect to an active project? A skill we're about to build? Flag it for Michael if so.
```

### 6. Update the index

Append a row to `~/ai/skills/INDEX.md` under the "Captured knowledge" table:

```
| 2026-04-16 | video | {title} | {requesting-agent} | {one-line essence} |
```

### 7. Report back

Tell the user:
- Where the files live (`~/ai/skills/videos/yt/<id>/`).
- The one-line essence.
- Key techniques with timestamps (top 3–5).
- Suggest next actions if the content warrants it (e.g., "build the higgsfield skill from this").

## Inputs

- A YouTube URL.
- Optional: requesting agent name for the metadata.

## Outputs

- `~/ai/skills/videos/yt/<id>/transcript.txt`
- `~/ai/skills/videos/yt/<id>/transcript.srt`
- `~/ai/skills/videos/yt/<id>/metadata.json`
- `~/ai/skills/videos/yt/<id>/frames/`
- `~/ai/skills/videos/yt/<id>/frames-manifest.json`
- `~/ai/skills/videos/yt/<id>/report.md`
- New row in `~/ai/skills/INDEX.md`.
- Summary message to the user.

Mac-side raw media may remain in the Mac copy of the same directory, especially under `raw/`, but should not be copied into the VPS bundle.

## Notes & gotchas

- **First run downloads the Whisper model (~1.5GB).** Subsequent runs are cached at `~/.cache/huggingface/`. Warn the user on first invocation.
- **Transcription speed:** roughly 10–20x realtime on M4 with `whisper-large-v3-turbo`. A 60-min video → ~3–6 min transcription.
- **Language:** Whisper auto-detects. For Hebrew shiurim, output will be in Hebrew — the LLM extraction pass handles bilingual content fine.
- **Copyright:** the `report.md` should include at most one short quote (<15 words) per major section. Don't reproduce extended passages.
- **Live streams:** yt-dlp bails cleanly if the stream is ongoing. Wait for it to end and retry.
- **Age-gated / members-only:** not supported. The script reports and exits.
- **Music videos / heavy background music:** transcription quality degrades. Try anyway, note in the report if the transcript looks garbled.
- **Model upgrade path:** swap the default model in `scripts/transcribe.sh` if you need higher accuracy. `mlx-community/whisper-large-v3` is more accurate but 2–3x slower than turbo.
- **Vision proof check:** If a report does not cite at least one visual detail from the frames, it did not use v2 properly.

## Changelog

- `2026-06-16` — v2 Vision. Added optional remote Mac backend wrapper: Mac fetch/transcribe/frame extraction, VPS lean bundle, `frames-manifest.json`, and report fusion from transcript + sampled frames.
- `2026-04-16` — initial version. Pipeline: yt-dlp → mlx_whisper (large-v3-turbo) → LLM extraction → report.md. Storage at `~/ai/skills/videos/yt/<id>/`.
