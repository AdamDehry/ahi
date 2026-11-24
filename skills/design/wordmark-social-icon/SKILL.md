---
name: wordmark-social-icon
description: Turn a website's CSS text wordmark into a square social profile icon (Instagram, Facebook, X, LinkedIn) that matches the site exactly — the browser measures the real CSS layout, the font's own outlines become a font-free SVG, a 1080 PNG is rendered from it, and two checks prove it (pixel diff against the browser's render, nothing outside the circle crop). Includes colour variants and a circle mock sheet at 360/110/40 px. Use when a brand has no logo file, only a styled text wordmark on its site, and needs an avatar or favicon-like mark. Not for drawing a new logo concept (use higgsfield-generate) or for photos.
version: 1.0.0
category: design
private: false
last_verified: 2026-11-24
verified_by: avi
---

# wordmark-social-icon

The site's CSS is the logo: let the browser lay it out, let the font draw it, and prove the SVG equals the page.

## When to use

- "Make a profile picture / avatar from our wordmark" for a brand whose logo is styled text on its site.
- A wordmark needs re-stacking (two lines) for a round crop but must stay true to the site.

## When NOT to use

- A new logo concept or illustrated mark — that is design exploration (higgsfield-generate).
- The brand already has a vector logo file — just place it.

## Required tools

- Headless Chromium + playwright-core (see `headless-browser-on-vps`).
- Python with fontTools, Pillow, cairosvg.
- The site's web font as a file. Google Fonts variable TTFs are at `github.com/google/fonts/raw/main/ofl/<family>/`.

## Workflow

1. **Read the wordmark from the site's source**, not a screenshot: the markup (often built in JS, e.g. a `wordmark()` helper), the CSS rules for it, the palette variables, and the font URL with its axes. Note the size it renders at in the header — it decides the optical size (below).
2. **Write one HTML page** with the site's rules copied verbatim, the text stacked as asked, at `font-size: <unitsPerEm>px` (usually 1000px) so 1 CSS px = 1 font unit. Convert any px values in the rule (radii, offsets) to em by dividing by the header size.
3. **Pin the optical size.** With `font-optical-sizing: auto` the browser picks `opsz` = the px size, so at 1000px you'd get the display cut, not what the header shows. Set `font-variation-settings: 'opsz' <header px>`. The small-size cut is also the more legible one at 110 px.
4. **Measure in the browser** (`page.evaluate`): each glyph's pen x via a `Range` per character (includes kerning and letter-spacing), each line's baseline via a zero-size inline-block with `vertical-align: baseline`, the box of any background chip — with its `transform` switched off, because transforms don't move layout — and read the rotation (`DOMMatrix` of the computed transform) and corner radii from computed style rather than retyping them. Refuse if `document.fonts.check()` says the font didn't load.
5. **Outline in Python**: `instantiateVariableFont` at the same axes (wght, opsz, wdth) → `SVGPathPen` through a `TransformPen (1,0,0,-1,x,baseline)` per glyph. A chip is a rounded-rect path with per-corner radii, wrapped with its glyphs in `rotate(deg cx cy)` (CSS and SVG agree on the sign).
6. **Fit the circle**: take ink points (glyph bounds + rotated chip corners), centre their box, scale so the farthest point sits at ~86% of the crop radius. One transform on a group; the background is a full-square rect (platforms crop it themselves).
7. **Variants**: same geometry, colours only, all from the site palette. Write one SVG per variant; render 1080 PNGs with cairosvg.
8. **Prove it**:
   - Shoot the HTML page with the same translate/scale and colours; diff against the SVG render. Allow strong differences only within 2 px of an edge (antialiasing): `FIND_EDGES` → threshold → `MaxFilter(5)`; anything outside that is a shape error and fails.
   - Circle safety: zero pixels differ from the background outside the safe radius.
9. **Mock it**: circles at 360, 110 (profile page) and 40 px (feed) on white and black (light/dark app themes). Look at the 40 px one before you name a pick.

## Gotchas

- `python3 -I` drops user site-packages (fontTools); use `-P` for your own scripts.
- Inline-only CSS (e.g. a `margin-left` that separates two words on one line) is meaningless once stacked — drop it and say so.
- A light background variant loses its edge on a white feed; say so in the pick.
- Check the copy itself: a site wordmark can differ from the brand name (singular vs plural). Follow the brief, flag the mismatch.

## Outputs

- `<brand>-icon-<variant>.svg` (outlined, no font dependency) and `.png` (1080×1080), a circle preview sheet, a one-command `build.sh`.
