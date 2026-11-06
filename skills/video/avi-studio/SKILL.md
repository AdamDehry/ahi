---
name: avi-studio
description: Avi's live studio — how Avi makes films, ad campaigns and marketing WITH the owner, one step at a time, in his chat or on a call. Use for any creative production the owner asks Avi for. Holds ONE canonical guide per use case (guides/film.md, guides/ad-campaign.md, guides/marketing.md); Avi always follows the current guide, and every other skill (avi-video-pipeline, higgsfield-*, youtube-lessons) is a tool a guide points to. Not for one-off single images with no project behind them.
version: 1.1.0
category: video
private: false
last_verified: 2026-11-06
verified_by: skills-audit
owner: avi
---

# avi-studio — work like a director on a live call

**The owner's ruling (11/03):** good AI films come from walking through every step with the owner, the
way the app redesign was done with Codex. They don't come from "go make this movie" in the background.
Avi's chat and Avi's calls in the app are the studio.

## The loop (every step of every guide)

1. **Say the step.** One or two sentences: where we are in the guide, what this step decides.
2. **Start the job, keep talking.** Put one `[[studio_job: {…}]]` line in your reply (the gateway's hint
   shows the exact shape every turn). It runs in the background; a card appears in the chat at once
   ("making 4") — on a call too. Keep the conversation going while it works.
3. **The card becomes the decision.** When the job lands, the same card shows 2–4 lettered options
   (A–D) and your question. On a call you say one short line ("They're in. Which cabin?"). Then give
   your recommendation in a sentence, with the reason ("C: one lantern plus the daylight slivers, and
   the map reads"). Never describe pictures before they arrive.
4. **The owner answers** by voice ("B", "the second one, warmer"), by typing, by tapping an option (it
   arrives as "Which cabin? → B: label", naming its card; on a call the picture rides with it), or by pasting a picture.
5. **Regenerate or move on.** A fix uses the chosen file as a ref and sends at most three numbered
   fixes. A lock records the asset under its one name and goes to the next step.

Files you already have (a folder of takes from a Foreman build, earlier renders): put them up with
`[[studio_decision: {"ask":"…","options":[{"file":"/abs","label":"…"}]}]]` or `{"ask":"…","folder":"/abs"}`.
From outside a chat turn (a Foreman build): the gateway's studio decision script (`scripts/studio.mjs decision --to <owner> --bot avi --ask "…" --folder /abs`, where the install has it).

## Decision-card etiquette

- **One question per card.** 2–4 options. More than four is a contact sheet, not a decision.
- **Labels are what differs** ("lantern left", "two lamps"), not what is the same.
- **Recommend.** You are the designer. Say which you'd take and why, in one sentence. The owner decides.
- **Cheap before expensive.** Stills before video, drafts before finals; a card never asks the owner to
  approve money he hasn't seen priced (say the price in the sentence that starts an expensive job).

## Engines (what `engine` means in a job)

| engine | what it is | use it for |
|---|---|---|
| `nano-banana` | fal.ai Nano Banana 2 (edit when refs are given) | fast stills, fusions, character-sheet passes, variations |
| `nano-banana-pro` | fal.ai Nano Banana Pro | finer stills and edits when 2 isn't enough |
| `gpt-image` | fal.ai GPT Image 2 (edit when refs are given) | photoreal sheets from a reference face, precise edits ("erase the face from panel 1"), text in images |
| `avi` | a background Avi with every tool: Higgsfield MCP (Soul Cinema, Seedance, Cinema Studio, Soul ID), the avi-video-pipeline scripts | Soul Cinema exploration batches, Seedance takes (1–4), anything Higgsfield-only. One at a time, gateway-wide. |
| Foreman build (via Michael) | a full build session, hours | a whole scene's takes, a full spin, anything long — its outputs come back as a decision card |

The gateway's hint says which engines are on right now and why one is off (e.g. no fal key).

## The guides — one per use case, always current

| use case | guide | status |
|---|---|---|
| film (shorts, series, the Torah films) | `guides/film.md` | v1, 11/03 — from METHOD v2 (a Torah film project) + Higgsfield "Viral AI Short Film" |
| ad campaign (one product, paid ads, a commercial) | `guides/ad-campaign.md` | v0.1 seed — not yet from a tutorial |
| marketing (UGC, social, listings, brand stills) | `guides/marketing.md` | v0.1 seed — not yet from a tutorial |

**Avi always follows the current guide for the project's use case.** Read it before the first step of a
project; re-read the step you are on before each job. If a project doesn't fit any guide, say so and ask
The owner which guide to start from — don't improvise a third process.

### Updating a guide (every new tutorial)

1. Research the tutorial with `youtube-lessons` (frames, not just the transcript — transcripts loop).
   Keep the research note with the source (`$HOME/ai/skills/videos/yt/<id>/` or the project's research/videos/).
2. Diff it against the guide: **confirms / differs / adds**, each with a timestamp.
3. Fold the adds into the right step of the guide; write a deliberate difference down where we keep ours.
4. Bump `version` and `updated` in the frontmatter; add one changelog line at the bottom.
5. Tell the owner in one sentence what changed in how we work.

One file per use case. Never a second film guide "for this project" — a project's own notes (its bible,
its asset names) live with the project; the process lives here.
