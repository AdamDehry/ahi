---
name: rtl-language-switch
description: Make a React web app and its Electron shell switchable to another language with full right-to-left (Hebrew first) — a typed string catalog that will not compile with a missing translation, root lang/dir, a mechanical pass from physical to logical CSS, per-message dir="auto", mirrored direction icons, the saved per-user choice on the server, and the agents and voice following it. Use when an app must be offered in Hebrew/Arabic or any second language. Not for a static landing page (static-landing-site).
version: 1.0.0
category: code-quality
private: false
last_verified: 2026-11-24
verified_by: zali
---
# rtl-language-switch

One catalog per surface, keys typed from the English source, `dir` at the root, logical CSS everywhere, `dir="auto"` on what people write.

## When to use
- "Let owners switch the whole app to Hebrew" (or any language), right to left included.
- A second language for a React app that has hundreds of hard-coded strings.

## When NOT to use
- A single static page in one language: `static-landing-site` (lang/dir in the HTML, logical CSS).

## Workflow
1. **Core first, alone** (before any helper touches a file):
   - `i18n/catalog/<area>.ts`: `export const en = {...} satisfies Record<string,string>;` and
     `export const he: Record<keyof typeof en, string> = {...}`. A missing or extra Hebrew key is a type error.
     One file per area, keys prefixed `<area>.`, so parallel helpers never edit the same file.
   - `i18n/index.ts`: `t(key, params)`, `tn(base, n)` for `_one/_other`, `useT()` (useSyncExternalStore — components
     re-render on switch, no reload), `setLang()` sets `<html lang dir>`, `locale()` for Intl.
     Plural key type that works: `{ [K in Key]: K extends \`${infer B}_other\` ? (\`${B}_one\` extends Key ? B : never) : never }[Key]`
     (the `Key extends infer K ? …` form collapses to `never`).
   - In RTL wrap every interpolated value in U+2068…U+2069 (first-strong isolate) inside `t()`: Latin names, numbers
     and paths in a Hebrew sentence stop jumping around. Only in RTL, so English output stays byte-identical.
   - Convert ONE screen yourself (the sign-in) as the worked example; write the conventions as `i18n/README.md`.
2. **Fan out** the string extraction by disjoint file groups, one helper per group, each owning its catalog files.
   Rules that matter: English text byte-identical (tests compare it); module-level label tables become key tables
   translated at render; never splice translated fragments; `dir="auto"` on the TEXT element of anything a person
   wrote (never on an aligned container — logical margins resolve against the element's own direction, so a bubble
   with `dir="auto"` would jump sides); code/paths/URLs `dir="ltr"`; arrows inside strings flip (→ becomes ←, ↗ becomes ↖).
   Hand them a glossary so one term is one word everywhere. Serialize typechecks with `flock` on a small box.
3. **CSS mechanically** (you, not the helpers): a script rewrites `margin/padding/border-left|right` →
   `-inline-start|end`, `left/right:` → `inset-inline-*`, `text-align/float left|right` → `start/end`, corner radii
   → `border-start-start-radius`…, 4-value `padding/margin` whose left≠right → `-block` + `-inline`. It must SKIP
   rules that centre with `left:50%` + `translateX(-50%)` and rules that slide with `translateX`; fix those, slide-in
   keyframes, toggles and `transform-origin` by hand in one `rtl.css`. Multi-value `border-radius` on bubbles (the
   tail corner) → logical longhands. CSS `content: "text"` → `content: attr(data-caption)` fed from the catalog.
4. **Mirror direction glyphs** with `:root[dir=rtl] .flip-rtl { scale: -1 1 }` — `scale` composes with an existing
   `transform`, and a send glyph's fly-out animation mirrors for free. A text glyph (‹ ›) needs
   `span.flip-rtl { display: inline-block }`; don't swap glyphs through catalog keys.
   **Motion along the line** (switch knobs, slide-ins, parallax): one `--dir: 1` on `:root`, `-1` under `[dir=rtl]`,
   and `translateX(calc(15px * var(--dir)))` in the component's own rule — no mirrored copies or `-rtl` keyframes.
5. **Keep timelines LTR** (`direction: ltr` on audio/seek bars) when their JS seeks by `clientX` from the left; mirror
   edge-swipe-back to the right edge; dropdowns anchor with `right:` in RTL.
6. **Messages:** `unicode-bidi: plaintext` on message paragraphs/list items so mixed Hebrew/English paragraphs each
   read their own way. Chat sides flip by themselves once alignment is logical (`align-items: flex-end` → left in Hebrew,
   as WhatsApp does). Hebrew has no case: reset `letter-spacing` under `:lang(he)` and give Hebrew-capable fonts first.
7. **Server:** save the choice per user (`ui-prefs.json` in the state dir), return it on the session so a new device
   opens in it; one line in the per-turn agent context ("Answer in Hebrew by default; follow them if they switch").
8. **Desktop shell:** one UMD catalog file that the pages load as a script and the main process `require`s (tray, dialogs);
   setup's first screen picks the language (default: the OS's preferred languages, `iw` = `he`); the shell follows
   the server's saved choice by reading `/ui/session` after sign-in and when its window blurs/hides.
9. **Voice:** check every provider per language — a live STT that is English-only must be swapped (or the gap said
   plainly in Settings), recognizers get the language code, TTS gets the language when the text is in it.
10. **Test:** one test walks every catalog (same keys, non-empty, same placeholders, arrows turned, keys in their own
    area once) and scans the plain-JS surfaces for keys used but missing. Screenshot each main screen in the new language.

## Gotchas
- A logo like "ahi." renders ".ahi" in RTL (the dot is neutral). Wrap the TEXT in `<bdi dir="ltr">`; putting
  `direction: ltr` on the padded container flips its logical padding too.
- An empty `dir="auto"` field falls back to ltr, so a Hebrew placeholder reads backwards:
  `:root[dir=rtl] :is(input,textarea)[dir=auto]:placeholder-shown { direction: rtl }`.
- Keep English byte-identical for dates: one `dateLocale()` (English → `[]`, the browser's format) instead of a
  copy of that rule in every view.
- A per-user prefs file read in voice hot paths: cache keyed on the file's inode+mtime+size, never a timer, so
  another process's write is still seen on the next lookup.
- Root tests that read CSS text break when properties go logical; update the assertion to the logical spelling.
- `Intl` with the browser default locale changes nothing for English users; `locale()` everywhere for shown dates.
- An Electron tray menu is rebuilt, not mutated, on language change; register its click handler only once.
- Speech: a short English utterance left to auto-detect is heard as another language; pin the recognizer to the
  owner's language instead of "auto".

## Related skills
`static-landing-site` (static Hebrew RTL pages), `headless-browser-on-vps` (screenshots), `isolated-gateway-e2e` (preview), `simplify-pass`.
