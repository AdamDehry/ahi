---
name: vision
description: Shared image tools any agent can call from a chat turn — OCR an image (Google Cloud Vision), generate one image from a prompt, or edit images from references (both fal.ai). Use for "read the text in this photo", a receipt or document snapshot, or a quick in-chat image when the Higgsfield tools are not reachable. For real image generation and edits prefer higgsfield-generate; those two need a fal.ai key (FAL_KEY).
version: 1.2.0
category: design
private: false
last_verified: 2026-11-06
verified_by: skills-audit
---

# vision

Three small scripts, one job each. Each prints its result on stdout (text or a URL) and logs to stderr.

## When to use

- OCR: a photo of a page, receipt, label or screenshot whose text you need → `ocr.py`.
- Quick generate/edit inside a chat turn when Higgsfield is unavailable → `gen_image.py` / `edit_image.py`.
- Anything production-grade (ads, characters, product shots) → higgsfield-generate / avi-video-pipeline instead.

## Steps

1. OCR:
   `python3 $AHI_AI_ROOT/skills/design/vision/ocr.py /path/to/image.jpg`
   Key, first found wins: `GOOGLE_VISION_API_KEY` → `GOOGLE_TTS_API_KEY` (shared Google key with Vision enabled) → `GOOGLE_APPLICATION_CREDENTIALS` (service-account JSON path).
2. Generate one image:
   `python3 $AHI_AI_ROOT/skills/design/vision/gen_image.py --prompt "..." [--aspect 1:1] [--model fal-ai/flux/dev]`
   Needs `FAL_KEY` (or `FAL_API_KEY`); falls back to reading the secrets env file. Prints the hosted URL.
3. Edit from references:
   `python3 $AHI_AI_ROOT/skills/design/vision/edit_image.py --prompt "..." --ref <path-or-url> [--ref ...] [--negative "..."]`
   Default model `fal-ai/nano-banana-2/edit`, up to ~9 refs; local files are uploaded to fal first. Same key as step 2.
4. Exit codes: 0 success, 1 missing arg/credentials/dependency, 2 provider error.

## Gotchas

- Run with `python3 <script>`: the shebangs may point at a venv that does not exist on this machine.
- Never print a key; check presence by variable name only.

## Rulings this depends on

- F-9(b): only the parent turn handles credentials; these scripts read them from env themselves.

## Related skills

higgsfield-generate · avi-video-pipeline · documents
