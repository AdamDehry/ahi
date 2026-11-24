# Languages and right to left

The app speaks English and Hebrew. English is the source; every other language is a full translation.
A key without a translation does not compile, and `test/i18n-catalog.test.ts` fails on it too.

## Use a string

```tsx
import { useT } from "../i18n";

function Thing() {
  const t = useT();               // subscribes: the component re-renders when the language changes
  return <button aria-label={t("common.close")}>{t("chat.send")}</button>;
}
```

- Every component that renders text calls `useT()`, even if a parent already did (memoized children
  would otherwise keep the old language).
- Code outside React (`lib/*.ts`) imports `t` from `i18n` and calls it when the text is produced, never at
  module load. Module-level tables hold **keys** (typed `Key`), translated at render.
- `{name}` placeholders: `t("chat.from", { name })`. Numbers are formatted for the language; in Hebrew
  every value is wrapped in a bidi isolate so a Latin name or a number keeps its own direction.
- Counts: a `_one` / `_other` pair and `tn("common.daysAgo", n)`. The Hebrew `_one` may drop `{n}`.
- Dates and numbers: `toLocaleString(locale(), …)`; never a hard-coded `"en-US"`.

## Add a key

Keys are `<area>.<camelCase>` and live in `catalog/<area>.ts`, English and Hebrew side by side. The English
text is exactly what the screen said before (existing tests compare it). Shared words live in
`catalog/common.ts`.

Hebrew is plain, natural Israeli Hebrew, the way a good Israeli app talks: short, plural imperative
(נסו, בחרו, לחצו), not word-for-word from the English. Product and brand names stay in Latin letters
(AHI, Claude, OpenAI, Gmail, WhatsApp, GitHub) and so do the agents' names. An arrow that points
"forward" flips with the reading direction: `→` in English is `←` in Hebrew, `↗` is `↖`.

## Right to left

- `<html dir="rtl" lang="he">` flips the whole layout; stylesheets use logical properties
  (`margin-inline-start`, `inset-inline-end`, `text-align: start`), and so do inline styles
  (`marginInlineStart`, `insetInlineEnd`).
- Anything a person wrote (messages, names, notes, file names, subjects, transcripts) gets `dir="auto"` on
  the element that holds the text, never on a positioned container: logical margins resolve against an
  element's own direction, so `dir="auto"` on a bubble would undo its side.
- Code, paths, URLs and keys stay left to right: `dir="ltr"`, or `<bdi>` inside a sentence.
- Icons that point along the reading direction mirror: the redesign `Icon` does it for chevrons and
  arrows; elsewhere add the class `flip-rtl`.
