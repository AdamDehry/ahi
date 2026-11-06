---
name: avi-video-pipeline
description: Avi's production engine for AI video — character-consistent cinematic shots for short films, ads, series and social, including shots where a character TALKS. Higgsfield first (MCP in chat, `higgsfield` CLI in scripts) — reference sheets and named Elements lock identity, Seedance 2.5 / Cinema Studio 4.0 / Kling 4 do motion, native audio carries dialogue, a sound pass adds ducked music. Run it inside avi-studio's live loop, so the owner approves each step. Not for a one-off image with no project behind it (use higgsfield-generate). Not for analysing an existing video (use youtube-lessons).
version: 3.0.0
category: video
private: false
last_verified: 2026-11-05
verified_by: skills-audit
requires:
  - Higgsfield account (MCP connector in chat, or the `higgsfield` CLI logged in)
  - ffmpeg + numpy for the sound pass (scripts/mix_native.py); a MediaPipe venv for scripts/av_sync.py
  - optional legacy path: FAL_KEY / FAL_API_KEY and a venv with fal-client (scripts/generate_shot.py)
tags: [video, production, character-consistent, dialogue, lip-sync, native-audio, higgsfield]
---

# avi-video-pipeline

> **Durable part:** the method. Design the character first, give every asset one name, approve stills before motion, and let the model that draws the mouth speak the words.
> **Volatile part:** the models. They live in `models.yaml` (`higgsfield:` block) and change monthly.

## When to use

- A film, ad, series beat or social clip with a recurring character, prop or place.
- Any shot where someone speaks on camera.
- Use it as the engine under `avi-studio`. The studio guide decides the step; this skill says how to make it.

## The loop (every step, live with the owner)

1. **Recommend.** MCP `models_explore` (`action: recommend`) for the shot. Cross-check `models.yaml`.
2. **Recipe.** MCP `get_workflow_instructions`: no argument for multi-step video, `character-sheet` for sheets, `ugc-video` for UGC.
3. **Preflight cost.** Call `balance`, and use the CLI `higgsfield generate cost …` for exact credits. The house rail is ≤60 credits per job unless the owner raises it. An 8s Seedance 2.5 shot at 720p is 56.
4. **Generate in batches.** `generate_image_batch` / `generate_video_batch` → `jobs_wait` (≤15s per call) → one `show_generation_by_ids`.
5. **Owner picks.** Offer 2–4 options with a one-line recommendation. A fix reuses the chosen file as a reference and lists at most three numbered changes.
6. **Lock and name.** Record the asset under its one name, then go to the next step. Never animate an unapproved still. Stills are about 30× cheaper to redo than video.

## The method — reference sheets and named Elements

1. **Script first.** Ask for a specific script (beats, seconds, lines per beat), not "write a script". Keep dialogue at or under ~2.8 words/s.
2. **Project with folders.** Create a Cinema Studio project with folders: characters / props / locations / shots.
3. **Character sheet per actor.** One clean-background sheet with front, left profile, right profile and full body. Make it with a GPT Image edit from the approved face, or the MCP `character-sheet` workflow. This replaces v2's six-pose Nano Banana composite and Soul ID training.
4. **Prop sheets.** Front, back and 3/4 for every prop that recurs. Anchor each prop with material + colour + contact points (see Gotchas).
5. **Locations.** Make Soul Cinema batches of variations, then pick one.
6. **Name everything once.** Give each asset one name. Introduce it to the chat by that name. Add it to Higgsfield as an **Element with the identical name**. Refer to it only by that name in every prompt after that (`manage_reference_elements`).
7. **Motion.**
   - Pick the engine from `models.yaml` → `higgsfield.motion`:
     - `seedance_2_5`: default; omni_reference, 4–30s, voice reference.
     - `cinematic_studio_video_4_0`: when you want lens, era and lighting control and its own prompt direction.
     - `kling4_0`: long takes, up to 7 element ids, no voice lock.
     - `seedance_2_0`: 4K hero shots.
   - Prompting: write **multishot** prompts with hard cuts on the second marks. Use one continuous crane pull-back to show scale. Hold the 180-degree line. Comedy lands in the edit, not in the prompt.
   - Hand-written Seedance prompts: use `references/seedance-prompting.md`.

## Prompting principles (durable)

- **Write physics, not captions.** "Her boots hit the wet pavement with real weight" beats "she lands".
- **Write camera behavior as a noun:** "The jolt. The reestablishment."
- **Dialogue goes verbatim, in quotes, on the AUDIO line.** Intent and attitude go in PERSONA/ACTION.
- **Specific details anchor identity:** a band-aid on the nose, a cyan power cell at the hip.
- **When the genre is well known, get out of the way:** "K-pop synchronized formation".

## Dialogue shots — native audio first

The model that draws the mouth speaks the words, and you keep that audio. A dub over a generated mouth never matches. One-page SOP: `SOP-TALKING-VIDEO.md`. Evidence: `references/higgsfield-audit-2026-10.md` and `references/talking-video-research-2026-10.md`.

1. **Blocks, in fixed order.** `talking_shot.py` assembles them:
   - IDENTITY (same text every shot)
   - PERSONA (one sentence, verbatim)
   - ACTION (second marks, then camera)
   - AUDIO: `He speaks to camera with <VOICE>, over the natural ambience of <place>: "<lines>"`
   - SUFFIX (lips form every word; one closed-mouth beat; no subtitles; no music)
2. **Line rules.**
   - ≤~2.8 words/s.
   - Em dashes become commas; no phonetic respelling; at most 1–2 CAPS words.
   - Medium close-up and a locked camera while speaking.
   - Never generate music in the shot.
3. **Lock the voice.**
   - Cut 5–12s of one speaker from the first approved take: `talking_shot.py voice-ref`. Attach it to every later shot.
   - Keep the VOICE text identical shot to shot.
   - An accent cannot be designed from text. It only arrives through the voice reference (a consented real voice).
   - Models that take a voice reference: `seedance_2_5`, `seedance_2_0`, `wan3_0`, `grok_video_v15`, `minimax_h3`. Kling and Veo do not.
4. **Fallback order.** Use it only when the voice must be one exact recorded or cloned voice:
   1. `voice_change`: keeps the timing, so the mouth still matches.
   2. `sync_so` (Sync Lipsync 3: input video + input audio, `sync_mode` bounce/loop/cut_off/silence/remap).
   3. LipSync Studio in the Higgsfield web app (a person runs it).

   Never mux separate TTS onto a native take and call it synced.

```bash
S=~/.claude/skills/avi-video-pipeline/scripts
python3 $S/talking_shot.py cost --ref <still job id or path> --identity-file id.txt --persona-file persona.txt \
  --voice-file voice.txt --action-file shot1.txt --lines-file shot1-lines.txt --ambience "a quiet street, birds" --duration 8
python3 $S/talking_shot.py make  ...same args... --out work/seg/S1
python3 $S/talking_shot.py voice-ref work/seg/S1/take.mp4 --start 1.7 --end 7.9 --out characters/<name>/voice-lock.wav
python3 $S/talking_shot.py make ... --voice-ref characters/<name>/voice-lock.wav --out work/seg/S2
```

## Sound pass

`python3 ~/.claude/skills/avi-video-pipeline/scripts/mix_native.py --takes a.mp4 b.mp4 --music bed.wav --floor floor.wav --out cut.mp4`

- **Levels.** The native dialogue is the main bus, at −18 dB RMS. Music sits at −37, sidechain-ducked. Add a continuous floor at −45 to hide seams.
- **Verification.** The script checks the delivered file: video MD5 unchanged, audio length = picture length, no digital-silence blocks, peak ≤ −0.3 dBFS, dialogue unmoved ≤0.02s.
- **ffmpeg traps it designs out.** `sidechaincompress` truncates, so it uses `apad`. `alimiter` auto-levels, so it sets `level=disabled`. It never concats per-take AAC, so it uses PCM concat with one encode. The concat demuxer offsets by container length, not picture, so it concats video-only intermediates.
- **Sync proof.** `scripts/av_sync.py take.mp4 --method landmarks` (MediaPipe venv) works on realistic medium close-ups. For stylised faces, use word timestamps plus an 8 fps mouth strip: lips close on m/b/p and round on o/oo.

## Gotchas

**Prop and character anchoring:**
- **Accessory substitution.** "Mask around his neck" becomes headphones. Anchor every prop with material + colour + contact points.
- **Generic tools.** "Vacuum" becomes a consumer shop-vac. Name the exact tool, its colour and shape.
- **Facial hair erasure.** Triple-anchor it: describe it, reinforce the texture, and put "clean-shaven" in the negatives.
- **Spatial concepts** (a logo split across opening doors) render naively. Fix them in post.

**Models and limits:**
- **Safety filter.** Image-to-video modes check strictly for photoreal AI faces. Reference/omni modes are lenient.
- **Prompt length and prices change.** Read the model's limit in `models_explore` and price with `generate cost`. Don't trust old tables.

**Rights:**
- **Copyright.** Use original characters only, or ones the owner holds rights to. Use consented voices only.

## Legacy fal.ai path (evals, installs with a fal account)

`scripts/generate_shot.py` runs the original four stages:
1. face (flux)
2. outfit (flux)
3. fusion (nano-banana edit)
4. Seedance motion

Its `eval` mode A/B-tests engines. It reads `models.yaml` → `stages:`, needs `FAL_KEY`/`FAL_API_KEY`, and writes under `$HOME/ai/skills/videos/`. On fal, Bytedance endpoints have no `fal-ai/` prefix.

## Adoption protocol

A new model goes through a live A/B on the same prompt and assets, then a `models.yaml` change, then a `CHANGELOG.md` entry (why, cost, result). Old engines stay listed. Once a month, compare `models_explore` (action list) against `models.yaml` and log "no change" or open an A/B.

## Related skills

- avi-studio — the live loop and the guide per use case.
- higgsfield-generate — single images and clips, Marketing Studio.
- higgsfield-content-factory — UGC campaigns.
- higgsfield-product-photoshoot — product stills.
- youtube-lessons — learn from a tutorial and fold it in here.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
