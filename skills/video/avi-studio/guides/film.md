---
use_case: film
version: 1
updated: 2026-11-03
summary: Short films and series, made with the owner step by step — script interview, cast and sets as stills, timed multi-shot takes, edit
owner: avi
sources: METHOD v2 (a Torah film project, 28 Oct 2026, 30+ tutorials) · Higgsfield "I Made a Viral AI Short Film From Scratch" (CHHH8tNioSc, 14 Jul 2026)
---

# FILM — the guide

*The one canonical film process. Every film follows it; a project's own facts (its bible, cast, asset
names, rulings) live with the project. Timestamps cite the source video as [id mm:ss]. The full
research behind it: the film project's own `research/METHOD.md`
(cited by video) and `research/videos/<id>.md` (one note per tutorial).*

## How this guide runs in the studio

Every step below is done **live with the owner**: say the step → start a studio job → keep talking → the card
lands with 2–4 options → the owner picks or fixes → lock it or regenerate → next step. "🔒" marks the moments
where an asset or a document is **locked**: it gets its one name, it goes on the project's board, and
later steps may only reference it, never re-invent it. Nothing expensive starts before the locks it
depends on.

| 🔒 Lock | What the owner has approved | How it reached him |
|---|---|---|
| 1 | Script + beat sheet + look book | text in chat; look-book frames as one card |
| 2 | Each main character: sheet, costume states, voice | sheet cards; one 10 s talking test per lead |
| 3 | Every set, from both sides, plus the floor plan | plate cards (master, reverse, third wall) |
| 4 | Storyboard + hero keyframes per scene | one board card per scene; keyframe cards |
| 5 | Draft cut | a folder card of the 480p/720p assembly |
| 6 | Final | 1080p (4K where it earns it), mixed and graded |

About 95% of the spend comes after lock 4. Draft first, final only for winners.

**Rules that hold at every step**
- **One name per asset, everywhere.** `@char_eduardo_v1`, `@loc_cabin_v1`, `@prop_map_v1`: the same name in
  Higgsfield Elements, in our prompts and in the project's board. "The prompts will auto match your inputs
  by these tags" [CHHH8tNioSc 10:37]. Versioned; the approved version is marked.
- **Write in numbers, not adjectives:** metres, degrees, seconds, centimetres. Spatial information before
  style; dialogue timing before voice style.
- **Fix in one thread with at most three numbered fixes,** in intention words, not volume words
  ("dismissive disbelief, refusal with contempt, not volume") [CHHH8tNioSc 34:13].
- **Price before you press.** Say the cost in the sentence that starts any video job.

---

## 0. Project setup (once per film, 0 credits)

- A project folder (its bible, beat sheets, prompts, cost ledger) and **one Higgsfield Cinema Studio
  project** with a folder per scene and sub-folders for Characters, Locations, Props, Videos, plus the
  canvas as the board of locked assets. "Two weeks and 400 generations later, you'll be glad you did
  this" [CHHH8tNioSc 05:41].
- Studio jobs for this project carry `"guide":"film"` and the step (`"step":"3 characters"`), so every card
  says where it belongs.

## 1. Script — interview, don't write (0 credits) 🔒1

- **Never ask for "a script".** Give the idea in one line and ask to *expand* it; let the interview run:
  runtime, settings, tone, twists. "Nothing good comes out of one lazy request" [CHHH8tNioSc 04:42–05:10].
  On a call this is just the conversation: Avi asks the owner the questions.
- For a sourced script (the Torah films) the beats are fixed by the manuscript; what we name is the feeling.
- **Beat sheet, per scene:** three sentences of feeling; per beat, the mood and the turn; what each character
  wants from the other and where the feeling lives (eyes, voice, hands); what they must not do.
- **Exact lines, word for word.** Shorten what's awkward spoken; numbers and names in words; pauses written in.
- **A persistence list:** who wears what, who holds what, where the window and door are, headcount, what never
  breaks [CHHH8tNioSc 29:33].
- **The sound idea** now: room tone, where silence is, the sound that arrives *before* a reveal.
- **Look book:** light logic (motivated sources in frame), the colour pair, lens language, grade per act, two
  to four film references.
- *Studio:* look-book frames as one job (`nano-banana`, n 4, "Which world feels like ours?"); the text locks
  in chat.

## 2. Characters — identity, costume states, voice 🔒2

**Sheet layout (the rule that matters most).** Three panels on seamless **mid-grey** under soft even light:
1. a face close-up — **the only face on the sheet**;
2. full body front, **face erased** (or neck-down);
3. full body back, face erased.

Why: with several faces on one sheet "Seedance doesn't understand which face to grab… by scene 5 our hero is a
stranger" [CHHH8tNioSc 06:47]. Grey background: "the win rate is much higher… zero background clutter"
[CHHH8tNioSc 06:04–06:10]. The close-up gives the face to lock onto; the full body gives height.

- **Model by job:** from a reference face → `gpt-image` ("the best model right now for editing and creating a
  photorealistic character sheet when you already have a reference" [CHHH8tNioSc 06:27]) or Nano Banana Pro;
  from scratch → Soul Cinema via `avi` (cheap variety), then GPT Image 2 for the clean sheet; then a second
  GPT Image 2 edit: "Erase the face from the full body shot on the first panel" [CHHH8tNioSc 07:00].
- **One sheet per world** for the same person (`@hero_ship`, `@hero_desert`, …) [CHHH8tNioSc 25:43].
- **Costume and damage states are separate elements** with **validity windows** in the take prompt: "Valid
  from 0.0s to 3.2s only" / "from 3.2s to the final frame", plus "WARDROBE STATE SWAP — HARD-CONTINUITY RULE…
  permanent and irreversible" [CHHH8tNioSc 29:18–29:37].
- **Family likeness** is generated *from* the first character's approved sheet with an IDENTITY LOCKS
  paragraph naming the shared features.
- **One high-contrast signature per character** that survives any light (a beard and a striped cloak; a kohl
  wing and a gold collar). Minor characters too, or their faces drift.
- **Voice:** one library voice per character for the whole film (The owner, 10/28: no human recordings), seeded into
  the video element; a phonetic description carried word for word. Seedance's auto-voice only for extras.
- **Test-animate before locking.** Plastic skin and dead hair show only in motion.
- *Studio:* sheet passes as `gpt-image` jobs, n 2–4, refs = the identity source; the erase pass as a 1-option
  card ("Keep it?"). Lock 2 = the sheet card + one 10 s talking test (`avi`, Seedance, priced first).

## 3. Locations — production-design plates, both sides 🔒3

- **"Locations carry the whole film. If the setting looks cheap, every shot inside it does too. And no amount
  of prompting fixes that later"** [CHHH8tNioSc 07:27].
- **Prompt like a production designer:** SCENE · REFERENCES & MOOD · CAMERA · zones · FOREGROUND · LIGHT ·
  GRADE · lens and film stock · "empty location, no people".
- **Always a 3/4 angle.** "It adds depth, which gives the camera way more to hold onto when it moves… much
  higher win rate than a flat head-on shot" [CHHH8tNioSc 08:08].
- **Raw pass cheap, finish precise:** Soul Cinema for variety (8 images = 1 credit) via `avi`, or
  `nano-banana`; GPT Image 2 for the edits and the final clean plate [CHHH8tNioSc 10:10–10:25].
- **Pick for lighting logic, out loud.** Count the light sources, check the key prop reads, name the reject
  reason ("feels like there are two lamps"; "the table got shoved into the corner") [CHHH8tNioSc 08:25–08:53].
  This is exactly the sentence Avi says when the card lands.
- **Fix, don't re-roll:** "Use @loc_x as the exact base. Keep everything unchanged — EXCEPT…". Relight when the
  architecture is right and the mood is wrong.
- **Both sides of every room:** master, reverse, third wall — "environment and light reference only… at the
  master plate's exposure" [CHHH8tNioSc 32:43–33:11: "USE BOTH SIDES OF THE LOCATION"].
- **Lock the room, never "style reference only":** "LOCATION LOCK: the exact room from this image, unchanged…
  geometry only".
- **Several plates per world, one per beat** (jungle 1 the giant tree, 2 the ruins path, 3 the cliff).
- **Floor plan** for every dialogue set: doors, windows, furniture, positions, cameras, the 180° line.
- *Studio:* plate batches as `nano-banana` or `avi` (Soul Cinema) jobs, n 4, "Which cabin?"; the reverse and
  third wall as `gpt-image` edits with the master as ref.

## 4. Props, extras, continuity

- **Key props get their own element:** three angles on grey, "must remain the same object throughout". Diptych
  sheets (front 3/4 + rear 3/4) for ships and vehicles [CHHH8tNioSc 09:08].
- **An extras sheet** per world so crowds match and aren't clones [CHHH8tNioSc 12:21].
- **Annotate references:** a circle or arrow drawn on the sheet says *where* an action lands
  [CHHH8tNioSc 17:26].
- **Continuity table per scene,** start and end: costume, jewellery, hair, held props, physical state.
- **Every reference must still show every persistent detail** (one ref missing the headphones made them vanish).

## 5. Blocking, shot list, storyboard 🔒4

- **The shot list is the timed prompt itself** (§7): time range, lens, height, move, focus, who is where and
  what is behind them, the beat, the line.
- **Coverage per dialogue:** an establishing wide that locks geography; OTS both ways; clean singles;
  close-ups for the turn; inserts for hands and props.
- **State the axis:** "THE 180° AXIS: … every camera sits on the ___ side of this line … THE AXIS HOLDS ACROSS
  EVERY CUT". Repeat identical framings: "the third shot repeats the first shot's framing"
  [CHHH8tNioSc 34:25–34:33].
- **Grey-box previz** for geography and big movement (Blender on the Mac, or 3D Jutsu): carries camera and
  action, never subtle acting. Tell the model the mannequins are placeholders.
- **Storyboard:** one board per scene, 8–12 panels, locked elements attached (GPT Image 2 / Nano Banana Pro).
  Ladder: a short read with details to protect → three lighting tests → the board → lock → only then video.
- *Studio:* the board as a 1-option card per scene ("Board for scene 2 — go?"); lighting tests as a 3-option card.

## 6. Keyframes

- Hero shots get a still first frame (and a last frame where needed): the turn, a reveal, a match cut.
  Nano Banana edit with the elements attached; plan three attempts.
- **Finish start frames by hand before video:** crop each face, enhance the crop, mask it back.
- **Chain generations:** a shot's last frame (or a lucky angle) is the next shot's start frame; write the
  **end-state handoff** into the prompt ("The final frames show him mid-stride toward the doorway, hands
  empty") and the next part's first frame ("the generation starts with him landing on the deck")
  [CHHH8tNioSc 13:35, 18:13, 32:09].

## 7. Takes — the house prompt, drafts, fixes

**The house prompt (one block per take):**
```
STYLE (first 20% governs) · ACTIVE REFERENCES (@name — who, costume in words, voice in words,
"100% matches the reference", validity window; @loc — "exact room, geometry only"; @prop — "the same
object throughout") · SCENE CONTEXT (the beat, what each wants) · LOCATION MAP / FIRST FRAME & BLOCKING
(metres, screen-left/right, x/y %, what is behind each, the axis, HEADCOUNT LOCK) · FORMAT MODE (timed
multishot, "cuts only at the specified points", or SINGLE CONTINUOUS TAKE) · SHOTS ([SHOT 1] 0.0–6.0 s —
size, lens/FOV, height, move, focus; beats timed to 0.5 s; the line with its delivery note;
"6.0s HARD CUT") · PERFORMANCE (physical micro-acting) · PHYSICS (mass, sway in cm) · LIGHTING ·
COLOR GRADE (one warm mass + one accent) · AUDIO (room tone, timed SFX to 0.1 s, each line with its
speaker) · POSITIVE LOCKS (what must stay true, said positively) · OUTPUT (duration, aspect, takes)
```
Source: the skill output read on screen [CHHH8tNioSc 25:47–25:57] and METHOD §8.1.

- **Engines and money** (Higgsfield credits ≈ $0.053 at top-up, measured 10/28):
  - dialogue and acting: Seedance 2.5 — draft 480p 3/s, 720p 7/s, final 1080p 16/s;
  - hero wides and fast action: Seedance 2.0 native 4K, 22/s (15 s × 4 takes = 1,320);
  - cheap dialogue drafts, B-roll: Kling 3.0, 2/s.
- **Run four takes per batch at draft resolution; check framing and blocking only.** If all four are wrong,
  the prompt is wrong. **Re-make only the winners at final resolution.** *(Deliberate difference: the
  Higgsfield short generates every iteration at 4K — about 33–40k credits for the film. We keep draft-first.)*
- **Patch good takes, don't discard them:** keep refs and camera, list only the broken beats.
- **Rules that save takes:** split a 15 s dialogue scene in two; overlap lines across takes; hide joins
  behind a foreground wipe or whip pan; generate handles; attach every character who should be in shot;
  end a multi-shot with two singles to seed the next clip.
- *Studio:* a take batch is an `avi` job (Seedance via Higgsfield MCP), n up to 4, priced in the sentence
  that starts it; the card shows the four takes; the owner picks or sends numbered fixes. A whole scene of takes
  (dozens) goes to a Foreman build and comes back as a folder card.

## 8. Performance and dialogue

- Acting comes from words: the emotional change across the clip, physical business, eyes ("the second his eyes
  move, you lose it"), timed micro-beats (the masseter tightens, a delayed swallow, the inner brow lifts).
- **The strongest AI acting is restraint.** Fix acting by naming the intention and the *absence* of volume
  [CHHH8tNioSc 34:13, 34:31].
- Keep synced lines short (2–4 s); longer speech over the listener, hands, backs, or V.O.
- Dialogue written like a screenplay inside the prompt with a delivery note; Seedance speaks it natively.
- **Quality gate per clip, re-make once on:** waxy skin or dead eyes, wrong hands, lip-sync drift, a wrong prop,
  one character's face bleeding into another (the Higgsfield short's ten-year-old has the presenter's
  moustache [CHHH8tNioSc 34:19]).

## 9. Sound

- First pass: Seedance native audio, directed by the timed AUDIO block; "NO MUSIC" in generation.
- Sound as transition and POV: the new space is heard before the reveal; "muffled underwater-like ambience…
  opening into full jungle ambience" [CHHH8tNioSc 25:47].
- Native AI audio is a draft track. Final: stacked ambience beds per location, foley matched in perspective,
  layered key moments, a mix. Score in post: two or three returning themes; silence where restraint is asked.

## 10. Edit, grade, deliver 🔒5 🔒6

- **Draft cut** can be assembled in Cinema Studio's own Project Timeline (video + audio rows, colour-coded
  scenes) [CHHH8tNioSc 13:57, 34:57] — fast for lock 5. **Finals** in DaVinci Resolve on the owner's Mac.
- Cut each scene from the best passages of several takes; cut on movement; regenerate missing coverage mid-edit.
- Hard cuts by default; transitions are designed into the generation (the explosion that carries to the next
  world; the sandstorm that swallows the frame; the fall that lands on the couch) [CHHH8tNioSc 18:13–19:43].
- Grade is mostly in the prompt; a final pass matches shots and holds each act's palette.
- 480p is drafts only. Finals 1080p; native 4K for wides and fast action; 4K master by upscale after the edit,
  only on clips used.
- *Studio:* lock 5 and lock 6 are folder cards (the assembly, the master) with a one-line ask.

## 11. Self-review before anything reaches the owner

Story (beats and lines match the script; the project's restraint rules held) · Geography (one window, one door,
the axis held, eyelines meet) · Coverage (wide, both OTS, singles, close-ups, inserts; turns held) · Continuity
(costume states change only at their time; props the same object; headcount; no identity bleed) · Sound
(voices consistent, room tone present, silence where asked) · Picture (1080p+, no waxy skin, extra fingers,
morphing props) · Cost (ledger updated, each job priced before it was sent).

---

## Tools this guide points to

| Need | Tool |
|---|---|
| Fast stills, fusions, sheets passes | studio engine `nano-banana` / `nano-banana-pro` |
| Photoreal sheet from a reference, precise edits | studio engine `gpt-image` |
| Soul Cinema, Seedance, Cinema Studio, Soul ID, voice change | studio engine `avi` (Higgsfield MCP); skills `higgsfield-generate`, `avi-video-pipeline` (reference sheets + named Elements) |
| The fal motion pipeline (master asset → Seedance ref2vid) | skill `avi-video-pipeline` (a tool — this guide is the process) |
| Shot-by-shot prompt drafting | `avi-video-pipeline` references/seedance-prompting.md (then rewrite into the house prompt, §7) |
| Researching a new tutorial | skill `youtube-lessons` (read frames: transcripts loop) |
| Long batches (a scene's takes, renders) | a Foreman build via Michael → a folder card (`scripts/studio.mjs decision`) |

## Budget per finished minute (measured prices, 10/28)

Stills ≈60–100 · drafts at 480p ≈1,100 · finals at 1080p ≈1,450 · native-4K wides ≈500 · extends and repairs
≈300 → **≈3,400–3,500 credits ≈ $180–185 a finished minute**, plus ≈200 credits per main character once.
Benchmarks: Higgsfield's 30 s commercial ≈2,100 credits; the Higgsfield viral short at 4K throughout ≈33–40k
credits by our count.

## What the Higgsfield "Viral AI Short Film" tutorial changed (diff, 11/03)

Research note: the film project's `research/videos/CHHH8tNioSc.md`
(every contact sheet read; 25 minutes of Stage-3 narration are lost to a transcription loop, so Stage 3 comes
from on-screen text).

**Confirms (already in our process):** three-panel grey sheets as elements; one name per asset across Claude
and Elements; timed multi-shot house prompts with OPTICS/CAMERA/AUDIO/locks; both sides of the location;
native Seedance dialogue; numbered fixes in one chat; costume states with validity windows; the 180° axis as a
written rule; annotated references; an extras sheet; Soul Cinema for the raw pass, GPT Image 2 for the edit.
Most of this was folded into that project's METHOD on 10/28 — but never into a project-agnostic guide, and the
canonical `avi-video-pipeline` skill still teaches the April fal-only method. **This guide is that fold.**

**Adds, folded now:**
1. **Every batch is a decision with the owner, not only the six locks** — the tutorial's working rhythm (4 takes →
   pick → fix → re-run) is exactly the studio card. The locks stay; the cards happen at every step.
2. **Pick out loud, for lighting logic** — the presenter's reject reasons (two lamps, table in the corner, map
   on the side wall) are the model for Avi's recommendation sentence on every location card (§3).
3. **Win-rate defaults written into the templates:** grey background for sheets, 3/4 angle for locations,
   "erase the face from the body panels" as its own edit pass (§2, §3).
4. **One sheet per world for the same hero** (§2) and **several plates per world, one per beat** (§3).
5. **End-state / first-frame handoff sentences** between consecutive generations (§6).
6. **Cinema Studio's Project Timeline for the draft cut** (§10) — Resolve stays for finals.

**Differs, deliberately:** the tutorial renders every iteration at native 4K (1,320 credits per 4-take run).
We keep draft-first, then finals for winners only (§7).

**Still open:** the tutorial's own `higgsfield-seedance-prompt` skill, script and prompts sit behind the
blog links in its description; nothing was fetched (nothing leaves the machine without the owner). Ask the owner whether
to open them — they would replace our reconstruction of the skill's format with the original.

## Changelog

- **v1 · 2026-11-03** — first canonical film guide. Generalised from METHOD v2 (a Torah film project, 10/28) and folded the
  Higgsfield viral short-film tutorial (CHHH8tNioSc); restructured around the live studio loop.
