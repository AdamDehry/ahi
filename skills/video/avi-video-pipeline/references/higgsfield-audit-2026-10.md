# Higgsfield audit — talking video, October 2026

Avi, 2026-10-09, build `video-pipeline-v2`. Read-only checks through the installed CLI
(`higgsfield 1.1.24`), the claude.ai Higgsfield MCP connector and first-party docs. Every
cost below is a live `generate cost` / `get_cost` preflight on the owner's account (Ultimate
plan, 1,199.25 credits at start), not a published price.

## 1. What claude.ai's connector actually does for a talking video

The connector's `ugc-video` workflow (the one claude.ai loads for any creator / presenter
/ talking-character video) hard-codes the call:

```
model: seedance_2_5   mode: omni_reference   generate_audio: true
medias: character image (+ board, + product) as image references
"Seedance 2.5 renders native audio ... never make a separate generate_audio call."
"Do not add a separate narration/TTS job."
```

Dialogue goes into the prompt verbatim on one line —
`Audio: He speaks to camera, <voice>, <room tone>: "<words>"` — with rules that matter
for sync: no phonetic respelling, max 1–2 CAPS words, one closed-mouth beat per clip,
no dramatic pauses, music only on request and always ducked, no subtitles.
Accent by text alone "lands roughly one render in three"; their fix is a 5–10s voice
sample attached as an audio reference ("accent and vocal delivery reference only — do
not copy words").

**That is the whole difference between the owner's claude.ai results and our David cuts.**
claude.ai keeps the audio the model generated with the mouth. We threw it away and
dubbed a TTS track over a mouth that was animated to other words.

General connector defaults, for reference: `seedance_2_5` general video, `kling3_0` for
multi-shot / audio / motion transfer, `marketing_studio_video` for ads, `minimax_h3` for
2K keyframes.

## 2. Video models with native dialogue + sound in one pass

| model | native audio | voice reference (audio_references) | cost seen |
|---|---|---|---|
| **seedance_2_5** | yes (`generate_audio`, default on) | **yes** | 720p **7 cr/s** (8s = 56, 10s = 70) · 480p or draft 3 cr/s · 1080p 12 cr/s · 4–30s |
| seedance_2_0 | yes | yes | 720p 4.5 cr/s (10s = 45) · 4–15s |
| wan3_0 | yes | yes | 10s = 17.5 |
| grok_video_v15 | yes | yes | 720p 10s = 45 |
| minimax_h3 | — | yes | not priced |
| kling3_0 | yes (`sound`) | no — start/end image only | std 10s = 17.5 · pro 10s = 20 |
| kling_o3_image_reference | yes | no | not priced |
| veo3_1 | yes | no | 8s = 32 |
| flux_3_video, gemini_omni(_flash_1_1) | yes | no | not priced |

Only models that take an audio reference can **lock a voice** across shots. Of those,
`seedance_2_5` is the connector's own default and the one proven here.

`seedance_2_5` extras worth knowing: `draft: true` renders a 480p draft at the 480p
price that can be finalized at 1080p within 7 days (stills-first economics, for video);
`video_extension` and `video_edit` modes; up to 30s per job.

## 3. LipSync Studio — the September claim was wrong, but only half wrong

September's note said "Higgsfield has no lipsync model — confirmed across all 87." What
is true: **no lip-sync model is exposed through the CLI or the MCP connector**, then or
now (106 models listed today, none lip-sync; marketplace search for "lip" is empty).

What is false: Higgsfield **does** have LipSync Studio, in the web app. Higgsfield's own
post (2026-07-07) lists 10 models, naming Veo 3, Kling 2.6 LipSync, Wan 2.5 Speak and
Kling Avatars 2.0; input is a still image + audio; "no video-to-video dubbing"; Veo 3 is
58 credits per 1080p clip. It is not callable by an agent today.

What the connector does expose:
- **`dubbing`** — translate the speech of an existing video into one of 18 languages
  and lip-sync the result back. A language tool, not a "fix my sync" tool.
- **`voice_change`** — replace the voice in a video with a preset or workspace voice,
  keeping the original timing. Because timing is kept, the mouth stays where it was. This
  is the right post tool for "the take is perfect, the voice is wrong".

## 4. Audio models (voice, SFX, music)

| model | use | cost seen | note |
|---|---|---|---|
| seed_audio | TTS, preset or element voice, can take an audio reference | 0.1 | connector default TTS |
| qwen_audio_tts | TTS with a 128-char `instruction` | 0.01 / line | accent instruction **did not work**: 3/3 judged American |
| elevenlabs_v4 / _turbo | TTS, up to 10 voices per dialogue | 0.92 / ~9s line | `[strong Israeli accent]` tag **did not work**: judged American |
| text2speech_v2 | TTS with a selectable engine (ElevenLabs, MiniMax, Seed Speech, Vibe Voice, Cozy Voice) | not priced | |
| mirelo_text_to_audio | SFX | 0.25 / s | **connector says "game pipeline only"** — see risk below |
| sonilo_music | music | 1.88 / 30s | **connector says "game pipeline only"** |
| inworld_text_to_speech | TTS incl. Hebrew voices (Oren, Yael) | — | **connector says "game pipeline only"** |

Voice cloning is `create_voice` (a widget, consent-shaped) → a workspace "element"
voice usable by seed_audio, qwen, text2speech_v2 and `voice_change`. Not used: the
cousin's clone is blocked on his memo and the brief forbids cloning anyone.

**Risk to flag:** the David SOUND-SOP generates SFX with `mirelo` and music with `sonilo`
through the CLI. The CLI allows it, but the MCP connector's own tool text says both
"exist ONLY for the game-generation pipeline and must not be used for standalone audio."
Before we keep relying on them, someone should confirm that is an agent-routing
instruction rather than a terms-of-use restriction. Until then the pipeline prefers the
model's native ambience and treats mirelo/sonilo as optional.

## 5. Character consistency

- **Video:** identity comes from image references in `omni_reference` mode (character
  image, optionally a sheet). Same reference + same identity/persona text every shot.
- **Soul ID** (`higgsfield soul-id`, ~25 credits to train) locks a face for the *image*
  models (`soul_2`, `soul_cinema_studio`, `text2image_soul_v2`). Use it to make the
  reference stills; video still takes those stills as references. In testing a trained
  Soul ID drifted on hair and beard, so restate them in text.
- **Voice:** an audio reference on every dialogue shot, the same file every time.

## 6. Instruments — what can and cannot be measured here

- `sync_probe.py` (David series) measures *placement*: where a dub sits relative to the
  engine track. With native audio the delivered track **is** the engine track, so its
  error is 0.00s by construction. That class of bug (v1's 4.2s/4.3s/3.3s errors) cannot
  occur.
- `scripts/av_sync.py` (new) measures audio against the mouth on one file. In landmark
  mode (MediaPipe, `$HOME/ai/venvs/avsync`) it is reliable on a realistic face at medium
  close-up. On the stylised David it finds a face in only ~40–75% of frames, and the
  Pixar grin reads as an open mouth, so its David numbers are **coarse, not a verdict**.
  The September motion probe's threshold caps "mouth active" at about 45% of frames by
  construction, so it under-reads dense dialogue. Don't use it alone.
- Word timestamps (OpenAI `whisper-1`, verbose JSON) plus an 8 fps mouth strip at those
  times is what actually settles phoneme-level sync on a cartoon. It is evidence for a
  human, not a number.
- The blind audio judge remains good for accent / voice count / brand name, and
  worthless for background (unchanged from September).

## Sources

- Connector: `get_workflow_instructions(ugc-video)`, `references/ugc-clip.md`,
  `references/monologue-craft.md` (read 2026-10-09).
- CLI: `higgsfield model list`, `model get`, `generate cost`, `account status`.
- [Higgsfield — How to make AI lipsync videos (2026-07-07)](https://higgsfield.ai/blog/make-ai-lipsync-videos)
