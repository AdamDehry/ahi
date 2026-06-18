---
name: room-redesign
description: Avi's interior-design rendering skill. Takes a project + room (e.g. villa-8 / primary-bedroom), reads room photos and an optional 2D floor plan from `~/creative/interior-design/<project>/<room>/input/`, applies Avi's design lens to elevate the brief into a directed visual prompt, then generates redesigned room renderings via fal.ai's GPT Image 2 edit endpoint. Use whenever the user asks (often by voice note) to "redesign the [room] at [project]", "show me what [room] could look like", or otherwise points Avi at a real room he has photographed. Not for original-from-scratch concepts (those are pure generation, not edits) and not for product staging (that's a different brief).
owner: avi
requires:
  - fal.ai API key (FAL_API_KEY + FAL_KEY in $AHI_HOME/.env)
  - Python venv at $AHI_HOME/venvs/fal/ with fal-client installed
tags: [design, interiors, image-edit, fal-ai, gpt-image-2, generative]
---

# room-redesign

> the user sends Avi a voice note: *"Redesign the primary bedroom at villa-8 — going for warm Japandi, low and grounded, lots of natural light, almost no color."* Avi takes it from there.

## Core conviction

A redesign is not a filter applied to a photo. It is **a reading of the room, then a directed reimagining**. The user's brief is a starting point — almost always under-specified. The model only renders what is asked of it. So the value Avi adds happens *before* the API call: looking at the room, hearing what it could be, and writing a prompt that describes the redesigned space with enough specificity that the model can build it.

The model is a brush. Avi is the painter. the user is the patron describing the painting he hopes for.

---

## Where files live (the path scheme)

All interior-design projects live under the user's canonical creative tree:

```
$AHI_HOME/workspaces/interior-design/<project>/<room>/
  input/    — the user drops room photos and (optionally) a floor plan here
  output/   — Avi writes renders here
  brief_<ts>.txt        — exact prompt sent to the model (per run)
  manifest_<ts>.json    — full request/response audit trail (per run)
```

`<project>` is the address or property name (e.g. `villa-8`, `34-elm-st`).
`<room>` is the specific space within it (e.g. `primary-bedroom`, `kitchen`, `living-room`).

**Skills folder is for skill instructions only** — never write project files into `~/.claude/skills/` or `~/ai/skills/`. Those are code. Project artifacts go to `$HOME/creative/...`.

---

## What this skill does NOT do

- **It does not decorate.** If the brief is "make it pretty," that is not enough. Avi pushes back and asks what the room is *for* before generating.
- **It does not fight the room.** Load-bearing walls, window placement, ceiling height, doorways — these are constraints the model should respect. The floor plan (when provided) is the contract.
- **It does not chase trends.** If "mid-century modern" is requested but the room reads as something else honestly, Avi names the tension and offers two paths: ride the user's brief, or recommend a more honest direction.
- **It does not generate from scratch.** Pure-generation room concepts (no source photo) belong elsewhere. This skill is an *edit* — there is always a real room being reimagined.

---

## The workflow Avi follows when triggered

### 0. Triage the request

the user usually arrives by voice note (transcribed by the AHI Gateway and forwarded to Avi). Pull two things out of the message before doing anything else:

1. **Project + room** — *"the primary bedroom at villa-8"* → `--project villa-8 --room primary-bedroom`. If either is ambiguous, ask one short question. Don't guess.
2. **The design intent** — vibe, era, mood, materials, what the room is *for*. This is the seed of the prompt — but Avi is going to elevate it, not pass it through.

If the project/room directory doesn't exist yet, ask the user to drop photos into `$AHI_HOME/workspaces/interior-design/<project>/<room>/input/` first. Don't create empty dirs speculatively.

### 1. Read the room (Atzilut)

Go to `$AHI_HOME/workspaces/interior-design/<project>/<room>/input/` and `ls` it. Then **inspect every image**:

1. **Categorize the photos.** Which angles? Wide shots, corner shots, detail shots? Which one(s) carry the most architectural information (window light, ceiling, dominant wall)? Which are redundant?
2. **Find the floor plan.** A floor plan looks 2D and top-down — line drawing, dimensions labeled, no perspective. If one is present, identify it explicitly. If the user said he'd send one but it's not in `input/` yet, note that and proceed without it (you can always re-render once it arrives).
3. **Read the bones.** Ceiling height, window orientation, natural light direction, existing finishes (wood tone, wall texture, floor material), door positions, fixed elements (radiators, columns, built-ins). These are not changing. The redesign respects them.
4. **Read what the user said.** What is *under* the words? "Mid-century modern" is rarely about the 1950s — it's usually about warmth, restraint, honest materials, an absence of clutter. "Add a reading nook" is rarely about the nook — it's about wanting the room to support a quiet, contemplative use it currently doesn't.
5. **Identify the gap.** Between what the room is now and what the user is reaching for — what's the actual move? Often it's one or two decisions (the lighting, the palette, the focal point) and everything else follows.

This step is non-negotiable. Skipping it produces generic AI-room renderings that look like every other AI redesign.

### 2. Pick the input image(s)

GPT Image 2's edit endpoint accepts up to 16 reference images. **More is not better.** Pick the smallest set that gives the model what it needs:

- **Single dominant angle:** the photo that shows the most of the room — usually a wide corner shot. This becomes `image_urls[0]` and anchors the redesign's framing.
- **One or two complementary angles** (optional): if a second wall, ceiling detail, or adjacent zone matters and isn't visible from the dominant angle, include it. Skip if redundant.
- **Floor plan** (optional, if available): always passed last via `--floorplan`. It's a hint, not a constraint — reinforce dimensions in the prompt text too.

Default if the user hasn't been specific: pass the floor plan (if present) and let the script auto-sweep `input/` for room photos. The script caps at 12 room photos and skips the floorplan automatically when sweeping.

If you have many photos and want to be selective, use `--photos name1.jpg name2.jpg` to pin the subset.

### 3. Elevate the brief (Yetzirah)

Take the user's words and turn them into a directed visual specification. The prompt that goes to the model should describe **the redesigned room as if you were standing in it**, not "what to change."

Bad prompt: *"Make it warm Japandi."*

Good prompt: *"Reimagine this primary bedroom as warm Japandi — low and grounded, oak and cream and warm stone, almost no color beyond the materials themselves. Low-profile platform bed in pale oak with a slightly oversized headboard upholstered in raw oatmeal linen. Linen bedding in cream and unbleached cotton. Two paper-shaded floor lamps flanking the bed at eye level — no overhead lighting, the room reads from sources at human height. Single tatami mat under the bed runs to the foot, surrounded by warm wide-plank oak flooring. One low oak bench at the foot of the bed. Single ikebana arrangement in a stoneware vessel on a wall-mounted oak shelf. Walls a soft warm white with a faint plaster texture. Sheer linen curtains on the window, gathered loosely, allowing the natural light to wash the room. Calm, hushed, considered. Keep the existing window placement, doorways, ceiling height, and the room's geometry exactly as in the source photo. No people in the frame."*

What that elevated prompt does:
- **Names specific objects** (paper-shaded floor lamps, tatami mat, oak shelf) — the model needs anchors, not adjectives.
- **Says what NOT to do** (no overhead lighting, no people) — explicit absence is a design decision.
- **Preserves the bones** ("keep the existing window placement, doorways, ceiling height, and geometry") — the room must remain the same room.
- **Names the feeling** ("calm, hushed, considered") at the end — emotional direction follows the spec, doesn't replace it.

When a floor plan is provided, fold its dimensions into the prompt: *"The room is approximately 14ft x 16ft with a single window on the east wall and the door on the south wall."* The script also appends a generic floor-plan instruction automatically when `--floorplan` is set.

### 4. Generate (Asiyah)

```bash
$AHI_HOME/venvs/fal/bin/python ~/ai/skills/room-redesign/scripts/redesign.py \
  --project villa-8 --room primary-bedroom \
  --description "Reimagine this primary bedroom as warm Japandi — ..." \
  --num-images 2 \
  --quality high
```

Optional flags:

| Flag | Purpose |
|------|---------|
| `--photos NAME [NAME ...]` | Select a specific subset of photos by filename (resolved inside the room's `input/`). Omit to auto-sweep all images. |
| `--floorplan NAME` | Filename of the floor plan inside `input/` (or absolute path). Sent as the final reference image. |
| `--style modern\|scandinavian\|mediterranean\|industrial` | Light style preamble prepended to the description. A safety net for thin briefs, not a replacement for craft. |
| `--num-images N` | 1–4 variants per call. Default 1. |
| `--quality high\|medium\|low` | Default `high`. Use `medium` for early iteration (~$0.06/image), `high` for final picks (~$0.22/image). |
| `--size auto\|square_hd\|portrait_4_3\|landscape_4_3\|...` | Default `auto` (infers from source — recommended). |
| `--output-format png\|jpeg\|webp` | Default `png`. |
| `--project-root PATH` | Override `$AHI_HOME/workspaces/interior-design/`. Rarely needed. |
| `--dry-run` | Validate inputs and print the assembled prompt without calling the API. Use this when iterating on the prompt before paying for renders. |

The script:
1. Resolves `<project-root>/<project>/<room>/input/` and validates it exists.
2. Resolves the photos (explicit `--photos` or auto-sweep) and floor plan.
3. Loads `FAL_KEY` from `$AHI_HOME/.env` automatically (no need to `source`).
4. Uploads references to fal storage, calls `openai/gpt-image-2/edit`.
5. Saves renders to `output/render_<UTC-ts>_NN.png` and writes `brief_<ts>.txt` + `manifest_<ts>.json` next to `output/`.

**stdout contract:** each render's absolute path on its own line, then the output directory path. Avi parses this to present results.

### 5. Present (Hamtakah)

When the renders come back, Avi:

1. **Names what was attempted in each variant.** Not "here are 3 options" — instead: *"Variant 1 leans into the oatmeal-linen warmth and reads the most lived-in. Variant 2 pulled toward grayer Japandi — closer to a Scandinavian read. Variant 3 took 'low and grounded' literally and gave us a futon-height bed which may actually be the right call."*
2. **Calls out the design decisions.** Why no overhead light? Why is the headboard upholstered? What is the tatami doing? If Avi can't articulate it, the render isn't finished thinking.
3. **Names what's still wrong.** Almost always there's something — a lamp shade that drifted into IKEA-generic, wall art the model invented that doesn't belong. Honesty here is fidelity, not criticism.
4. **Offers the next move.** *"Want me to push variant 1 cooler and try the futon-height bed from variant 3?"* — the next iteration is one prompt away. Make it easy for the user to say yes.
5. **Replies with the output paths.** Tell the user exactly where the files are: `$AHI_HOME/workspaces/interior-design/villa-8/primary-bedroom/output/render_*.png`.

---

## Iteration patterns

A single render is rarely the answer. Common follow-up moves:

- **Palette shift** — same composition, push the tones (warmer / cooler / more saturated / more neutral). Re-run with a tightened palette description and the same source photos.
- **Lighting direction** — overhead → eye-level, daylight → evening, hard → soft. Often the single biggest mood lever.
- **Element swap** — keep the room, change one piece (the rug, the chair, the mirror). Describe the swap explicitly in the prompt.
- **Layout shift** — when a floor plan is in play, re-run with a different furniture arrangement description. The model respects layout intent surprisingly well when the prompt names where things sit.

When iterating, prefer `--quality medium` until the direction is right, then bake the final at `--quality high`.

Subsequent runs against the same room each get their own timestamped `render_*`, `brief_*`, and `manifest_*` files — they don't overwrite each other.

---

## fal.ai endpoint reference (volatile)

Confirmed 2026-04-29 via fal.ai docs.

| Field | Value |
|-------|-------|
| Model ID | `openai/gpt-image-2/edit` |
| HTTP | POST |
| URL (sync) | `https://fal.run/openai/gpt-image-2/edit` |
| URL (queue) | `https://api.fal.ai/queue/openai/gpt-image-2/edit` |
| Auth | `Authorization: Key $FAL_KEY` header (REST) or env-loaded `FAL_KEY` (`fal_client` SDK) |
| Required input | `prompt` (string), `image_urls` (array of strings — one or more source URLs) |
| Optional input | `mask_image_url`, `image_size` (default `auto`), `quality` (default `high`), `num_images` (default 1), `output_format` (default `png`), `sync_mode` (default false) |
| Response | `{ "images": [{ "url": "...", "content_type": "...", "width": ..., "height": ... }, ...] }` |
| Pricing | ~$0.06/image @ 1024² medium, ~$0.22/image @ 1024² high (April 2026) |

If the model is renamed or moved, update this section AND `scripts/redesign.py`. Don't let SKILL.md drift from reality.

**Multi-image input:** the endpoint accepts an array of source images. The script sends `[room_photo_1, ..., room_photo_N, floor_plan]` when both are provided. The model uses the additional images as cross-reference context. The dominant room photo should always be `image_urls[0]`.

---

## Auth & environment

`FAL_KEY` and `FAL_API_KEY` live in `$AHI_HOME/.env`. The script loads them automatically — no need to `source` first. (Avi's agent file mentions `~/ai/secrets.env` but the actual location is `$AHI_HOME/.env`. The script reads the right path.)

Python venv: `$AHI_HOME/venvs/fal/bin/python` with `fal-client` installed. Same venv used by `avi-video-pipeline` — do not duplicate.

---

## When to escalate or pivot

- **GPT Image 2 refuses or returns a degraded result** — fall back to Nano Banana Pro Edit (`fal-ai/nano-banana-pro/edit`) using the same prompt. Note in the manifest that we fell back, and why.
- **The brief is unclear** — do not generate. Ask the user one sharp question first: *"Is this room going to be primarily a place to sleep, or do you want it to also support reading and quiet work?"* The answer changes the design.
- **The render keeps missing the bones** (wall placement, window, doors drift) — the model is being asked to do too much. Tighten the prompt to **describe the existing architecture explicitly** ("preserve the single east-facing window with white casing, the door on the south wall, the existing wood plank flooring") and reduce the variant count to 1. One careful render beats four sloppy ones.

---

## Notes & gotchas

- **`image_size: auto`** (the default for the edit endpoint) infers dimensions from the input photo. Override only if the user wants a specific aspect ratio (e.g., `portrait_4_3` for a vertical phone-ready render).
- **Output format** defaults to PNG. For sharing on Telegram or social, JPEG is smaller — pass `--output-format jpeg`.
- **Cost discipline** — at `high` quality, four variants is ~$0.88. Use `--quality medium` for early iteration; switch to `high` only once the direction is locked.
- **The floor plan is a hint, not a constraint.** GPT Image 2 will not perfectly respect 2D top-down geometry as a cross-reference. Treat the floor plan as additional context and reinforce dimensions in the prompt text.
- **Don't include real people.** This skill is for the room. If a person ends up in a render unintentionally, regenerate with "no people in the room" in the prompt.
- **Don't write into the skills folder.** Skills hold instructions and code. Project files go to `$HOME/creative/...`.
