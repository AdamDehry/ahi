---
name: avi-video-pipeline
description: Avi's production engine for AI-generated video shots. Use when generating character-driven cinematic video — short films, ads, series pilots, social content. Produces character-consistent shots via a multi-stage pipeline (character reference → outfit reference → fusion into master asset → motion via video engine). Config-driven — swap models in models.yaml as better options emerge. Not for single image generation (use fal.ai directly) and not for transcribing/analyzing existing video (use youtube-lessons).
owner: avi
requires:
  - fal.ai API key (FAL_API_KEY + FAL_KEY in ~/ai/secrets.env)
  - Python venv at ~/ai/venvs/fal/ with fal-client installed
  - ffmpeg (for future shot stitching)
tags: [video, production, character-consistent, pipeline, fal-ai]
---

# avi-video-pipeline

> **Durable part:** the methodology — character-first, master-asset, director-style prompting.
> **Volatile part:** the specific models — they live in `models.yaml` and change as better ones emerge.

## Core conviction

Character-consistent AI video production is **not** a single model call. It's a pipeline where each stage solves a different problem. Every stage can be swapped for a better tool as the field evolves — the pipeline shape stays.

New video tools arrive weekly. A skill that hardcodes today's best model is obsolete in a month. This skill encodes the **shape of the work**, not the tool list. Read the methodology first, then check `models.yaml` for what we're actually calling right now.

---

## The four-stage methodology

### Stage 1 — Character reference
**Problem solved:** lock an actor's face, identity, and presence into a single canonical image that can be referenced across future shots.

- One base prompt → generate multiple candidates → pick the strongest.
- Keep the prompt about face, bone structure, expression, lighting. **Not outfit.**
- Output: face reference image saved to `~/ai/skills/videos/characters/<name>/face.jpg`.

### Stage 2 — Outfit reference
**Problem solved:** lock wardrobe separately so specific details (a belt, a patch, a glowing accessory) don't drift between shots.

- Separate prompt from the face. **Do not combine outfit and face into one generation** — you lose control over both.
- Generate on a neutral background with catalog-style lighting. No person, no pose. Just the outfit.
- Output: outfit reference image saved to `~/ai/skills/videos/characters/<name>/outfit.jpg`.

### Stage 3 — Fusion (the screen test)
**Problem solved:** produce one canonical "this is the actor, this is what they wear" image that every subsequent shot references. Without this, identity drifts across shots.

- Take face + outfit references. Use an edit/fusion model that supports multiple input images and preserves identity.
- Prompt should explicitly instruct: *"Keep the face from image 1 exactly as shown. Dress in the outfit from image 2."*
- Output: master asset saved to `~/ai/skills/videos/characters/<name>/master.jpg`. **This is the irreplaceable artifact** — reuse it across every shot in the project.

### Stage 3b — Character sheet (OmniReference ingredient)
**Problem solved:** a single master image is insufficient for cross-scene character consistency — Seedance interprets one image as style/guidance, not identity lock. A multi-pose character sheet gives Seedance contextual understanding of the character across angles and expressions, which holds up across different scenes, lighting, and outfits.

- Run Nano Banana 2 on the master asset with a character-sheet prompt (default: six poses — front, three-quarter, profile, action pose, two close-ups).
- Output: `~/ai/skills/videos/characters/<name>/character-sheet.jpg`. Passed alongside master as an OmniReference ingredient on every subsequent motion call.
- Skip via `--skip-character-sheet` for atmospheric B-roll or when identity lock isn't required.
- Override the pose set via `--sheet-prompt "..."`.

### Stage 4 — Motion
**Problem solved:** turn the master asset into a moving shot without losing the character.

**All motion engines now accept a list of reference images (OmniReference pattern).** Seedance 2.0's `reference-to-video` accepts up to 9 references addressable as `@Image1..N` in the prompt. The pipeline automatically passes `[master, character-sheet, ...any --references]` in that order, so `@Image1` = master, `@Image2` = sheet, `@Image3+` = whatever you add (location, props, text graphics). Use these tags in the video prompt to route references explicitly.

**Three engines exist; each has a tradeoff. Style of character matters for engine selection — see Safety note below:**

| Engine | Identity lock | Freedom of motion | Best for | Safety filter |
|--------|---------------|-------------------|----------|---------------|
| `image-to-video` | Strongest — master is literal frame 1 | Limited — motion starts from that specific pose | Stylized characters (anime, illustration, comic-book) where frame-1 lock is safe | **Strict** — blocks photorealistic AI-generated faces as "likeness of real person" |
| `reference-to-video` with `@Image1` tags | Good — explicit anchoring in prompt | Higher — model interprets, not extrapolates | Default for photorealistic characters; action shots needing different opening pose | Lenient — works across styles |
| `reference-to-video` (no tags) | Weak — master is style guidance only | Highest | Atmospheric B-roll where exact character match doesn't matter | Lenient |

**Default engine in `models.yaml`: `seedance-ref2vid-tagged`.** Chosen for universal compatibility across character styles. Override to `seedance-img2vid` per-shot **only for stylized characters** where you've confirmed the safety filter doesn't trip. Discovered 2026-04-16 — see CHANGELOG.

**Safety filter note:** Seedance 2.0's `image-to-video` endpoint runs a stricter partner safety check that conservatively flags photorealistic AI faces. This is a good safety behavior for the ecosystem even when it's inconvenient for us. Two paths forward for photorealistic characters: (1) stick with `ref2vid-tagged` (the current default — works fine), or (2) generate characters in a non-photorealistic style from Stage 1 so the filter reads them as clearly fictional.

---

## Companion skill — `video-prompt-builder`

This skill generates cinematic shots. A separate **Avi-owned** skill, `video-prompt-builder` (installed at `~/.claude/skills/video-prompt-builder/`, contributed by Rourke Heath), produces the structured, director-quality prompts that feed this one. They chain:

```
creative brief → video-prompt-builder → structured 4-section output → extract Section 1 (shot-by-shot timeline)
              → avi-video-pipeline generate --video-prompt "<shot 1 block>" --character-name <name> --references ...
```

When the user describes a video concept ("dramatic trail running shoe film, mountain setting, 15 sec, Nike-style"), the right flow is:
1. Invoke `video-prompt-builder` with the brief → receive the 4-section output (shot-by-shot timeline, master effects inventory, density map, energy arc).
2. Extract **Section 1** only (the shot list) — ignore the other three sections at generation time.
3. For each shot: call `avi-video-pipeline` with the shot's prompt, the relevant character, and any OmniReference ingredients (location, props, text graphics) as `--references`.
4. Stitch shots together via `ffmpeg concat` (future helper skill).

Don't paste the entire 4-section output as the video prompt — it exceeds Seedance's 4000-character limit on fal.ai (3000-3500 on Higgsfield) and contains metadata the model doesn't need. Section 1 per-shot is the signal.

## Prompting principles (durable across models)

Apply to all stages but especially Stage 4. These survive model changes.

- **Write physics, not captions.** "Her boots hit the wet pavement with real weight — knees absorbing the landing" beats "she lands." The model understands mass and momentum when you describe what force does to a body.
- **Write camera behavior as a noun.** "The jolt. The reestablishment. The stabilization after impact." Not "the camera shakes."
- **Write dialogue as stage direction.** Put lines in the prompt as the actor's intent, not as text-to-speech input. Modern video models deliver.
- **Specific details anchor identity.** Generic props drift. A band-aid on the nose, a cyan power cell at the hip, a specific scar — these make the character feel real and consistent.
- **When the genre is well-known, get out of the way.** "K-pop synchronized formation" works better than 15 lines of choreography direction. The model knows what K-pop looks like.

Source: extracted from Higgsfield's Zephyr tutorial — see `~/ai/skills/videos/yt/LUWMI0zy0BQ/report.md` for the original lesson.

---

## Current stack (volatile — lives in `models.yaml`)

As of 2026-04-16 — the first production commit. Review against the changelog before trusting.

| Stage | Model (via fal.ai) | Typical cost | Why chosen |
|-------|---------------------|--------------|------------|
| Face | `fal-ai/flux/dev` | ~$0.025/image | Best identity + detail per dollar. Flux Pro tier available if budget allows. |
| Outfit | `fal-ai/flux/dev` | ~$0.025/image | Same model, different prompt. Product-photo-style works reliably. |
| Fusion | `fal-ai/nano-banana-2/edit` | ~$0.04/image | Preserves identity through fusion cleanly. Up to 14 reference images. |
| Motion | `bytedance/seedance-2.0/fast/image-to-video` | ~$2.42 / 10s @ 720p | Native audio, good physics, identity-locked when master is frame 1. |

**Total per-shot: ~$2.51 for a character we haven't generated yet. ~$2.42 for an additional shot of an existing character (stages 1–3 cached).**

Check `models.yaml` for the authoritative list. The table above is illustrative.

---

## How to use the skill

### Generate a first-ever shot of a new character

```bash
~/ai/venvs/fal/bin/python ~/.claude/skills/avi-video-pipeline/scripts/generate_shot.py \
  --character-name kira \
  --face-prompt "..." \
  --outfit-prompt "..." \
  --fusion-prompt "Combine the woman from image 1 with the outfit from image 2..." \
  --video-prompt "She vaults over the burning car..." \
  --duration 10 --aspect-ratio 16:9
```

Outputs land at `~/ai/skills/videos/generated/<YYYY-MM-DD-HHMM>-<slug>/`.
Character assets cached at `~/ai/skills/videos/characters/kira/`.

### Generate another shot of the same character (cached)

The script auto-detects an existing character directory and reuses the master asset. Only Stage 4 runs. ~$2.42, ~80s.

```bash
~/ai/venvs/fal/bin/python ~/.claude/skills/avi-video-pipeline/scripts/generate_shot.py \
  --character-name kira \
  --video-prompt "She stands on a rooftop at dawn, coat fluttering, rifle slung across her back..." \
  --duration 8 --aspect-ratio 21:9
```

### A/B test engines on the same prompt

Use `eval` mode when evaluating a new model or deciding between engines for a specific shot.

```bash
~/ai/venvs/fal/bin/python ~/.claude/skills/avi-video-pipeline/scripts/generate_shot.py eval \
  --character-name kira \
  --video-prompt "..." \
  --video-engines seedance-img2vid seedance-ref2vid-tagged
```

Outputs laid out side-by-side at `~/ai/skills/videos/evals/<timestamp>/<engine>/` for direct comparison.

---

## Adoption protocol — when a new model looks promising

Do not swap silently. Follow this:

1. **Add an engine adapter** to `scripts/generate_shot.py` — implement the `VideoEngine` / `ImageEngine` / `FusionEngine` interface as appropriate.
2. **Run `eval` mode** comparing the new engine against the current default, same prompt, same character. Document the comparison at `~/ai/skills/videos/evals/<date>-<engine-name>/README.md`.
3. **If the new engine wins** — update `models.yaml`, add a `CHANGELOG.md` entry explaining the swap, the eval results, and the new cost.
4. **Keep the old engine available** — don't delete. Later shots may benefit from the older behavior. The engine registry is additive.

Never commit a swap without running `eval`. Vibes aren't a protocol.

---

## Evolution protocol — when a new stage makes sense

If a future tool consolidates multiple stages (e.g., a single model does character + outfit + motion with baked-in consistency), treat it as a **parallel pipeline**, not a replacement. Add a new entry-point (e.g., `generate_shot.py --pipeline unified`) and run evals against the four-stage version. Keep both until one is clearly dominant across use cases.

Some stages will always matter (the master asset is a reusable artifact; a unified model doesn't change that for cross-shot consistency). Others may dissolve. Watch for the pattern.

---

## Ritual — monthly review

Part of the `innovation-scan` scheduled task (see H-013). Once a month:

1. Read the month's innovation scans at `~/ai/skills/innovation-scan/`.
2. For each stage, ask: is our current model still the best available at our price point?
3. If yes, note in `CHANGELOG.md` under "Reviews — no change."
4. If no, open an adoption protocol.

---

## Production workflow — stills-first pipeline

Learned on the HVAC ad (H-015, April 2026): **generate all keyframe stills first, get approval, THEN animate.** Stills cost ~$0.04-0.10 each. Animations cost ~$2.42 each. A bad still caught before animation saves $2.42. A bad still caught after wastes it.

```
For each scene in the ad:
  1. Generate keyframe still (Nano Banana 2 / Flux)     ~$0.08
  2. Review still — check character, outfit, props, setting
  3. If wrong → regen still (cheap)                      ~$0.08
  4. If right → approve and move to next scene
  5. After ALL stills approved → animate each one         ~$2.42/each
```

Never animate a still you haven't approved. Iteration at the still level is 30x cheaper than iteration at the video level.

---

## Voice & dialogue strategy

Three tiers, cheapest first:

| Tier | Method | Cost | When to use |
|------|--------|------|-------------|
| **1. Seedance dialogue delivery** | Write lines as stage direction in the video prompt. Seedance generates the character speaking. | $0 (included in motion cost) | First attempt always. Works when the model knows the genre/delivery style. |
| **2. OmniReference audio input** | Record or generate VO separately → pass as `@Audio1` reference alongside character sheet. Seedance syncs motion to audio. | VO cost only (~$5-10 via ElevenLabs) | When Tier 1 delivery doesn't land — accent, timing, or emotion needs specific control. |
| **3. Post-production lipsync** | Generate silent video → run through Lipsync Studio with separate audio track. | ~$1-3 per clip | Last resort. Most control but highest uncanny-valley risk. |

**Music integration:** Seedance accepts audio clips as OmniReference ingredients. Upload the background track BEFORE generation — the model generates with beat/rhythm awareness. Music is part of the generation, not added after.

---

## Nano Banana 2 — known failure modes

Documented from HVAC ad production (6 stills, 10 generations, 4 regens). These patterns are durable — they reflect how the model interprets ambiguous prompts.

### 1. Lifestyle accessory substitution
**Trigger:** describing a prop by its body-relationship only ("mask around his neck", "device on his belt").
**Result:** model substitutes the most common consumer accessory that fits that relationship — headphones, smartwatch, phone holster.
**Fix:** anchor EVERY prop with three specifics: **material + color + contact points**.
- Bad: "N95 mask around his neck"
- Good: "white disposable N95 respirator mask with elastic straps, pulled down and resting under his chin against his throat, white color clearly visible against the grey polo"

### 2. Generic tool substitution
**Trigger:** naming a tool category without visual specifics ("vacuum", "drill", "equipment").
**Result:** model generates the most common consumer version (black Craftsman shop-vac, cordless DeWalt drill).
**Fix:** describe the EXACT tool with color, shape, and industrial context.
- Bad: "holding a vacuum hose"
- Good: "bright red cylindrical industrial duct-cleaning vacuum unit with ribbed black flexible hose"

### 3. Beard/facial hair erasure
**Trigger:** character reference has subtle facial hair; prompt doesn't explicitly reinforce it.
**Result:** model defaults to clean-shaven, especially on younger-looking characters.
**Fix:** triple-anchor facial hair: describe it in the prompt, reinforce with texture language, AND add "clean-shaven, smooth face, no beard" to negatives.

### 4. Spatial concept limits
**Trigger:** describing a visual concept that requires understanding of how physical objects interact (e.g., "logo split across two panels that separate when a door opens").
**Result:** model renders the simplest interpretation — logo appears intact on one surface.
**Status:** current limitation. Use post-production editing for complex spatial relationships.

---

## Notes & gotchas

- **fal.ai endpoints:** Bytedance models (Seedance) use `bytedance/...` without the `fal-ai/` prefix. Every other model uses `fal-ai/...`. This cost us two debug retries the first time.
- **Auth:** `~/ai/secrets.env` sets both `FAL_API_KEY` (REST) and `FAL_KEY` (fal_client SDK). Source in-shell before running scripts, or rely on `~/.zshrc` auto-load for new shells.
- **Copyright:** never reproduce someone else's character without permission. This skill is for original characters only, or ones the user owns.
- **Cost control:** always check `models.yaml` estimates before running — a 15s Seedance 2.0 Standard video at 1080p is a very different bill from a 5s Fast at 720p.
- **Character reuse:** the master asset (`~/ai/skills/videos/characters/<name>/master.jpg`) is the irreplaceable asset. Back up across projects.
- **Prompt length:** Seedance 2.0 accepts 3000-4000 chars on fal.ai (3000-3500 on Higgsfield UI). When chaining from `video-prompt-builder`, extract Section 1 per-shot only — don't paste the full 4-section output.
- **OmniReference ordering matters:** pass refs as `[master, character-sheet, location, props, text-graphics]`. `@Image1` = master (identity), `@Image2` = sheet (angle context), `@Image3+` = scene ingredients. Consistent ordering across shots prevents confusion.

## Changelog
See [CHANGELOG.md](./CHANGELOG.md).
