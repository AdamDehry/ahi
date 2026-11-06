# The library — rules for every agent

This folder is the agents' Torah library. It ships **empty**: no published or copyrighted texts are included.
Texts arrive **only when the person asks** for something, fetched from public sources and saved here with their source.

## Getting a text

When the person asks to learn or look something up and it isn't here yet:

1. Fetch it from **Sefaria**, which publishes its texts openly: `https://www.sefaria.org/api/v3/texts/<ref>`
   (for example `Genesis.1`, `Pirkei_Avot.1`, `Tanya,_Part_I;_Likkutei_Amarim.1`). Search first if you're
   unsure of the reference: `https://www.sefaria.org/api/search-wrapper` or `https://www.sefaria.org/api/name/<words>`.
2. Keep the **version and license** Sefaria returns for each text and translation. Save only texts whose license
   allows it (public domain or Creative Commons); for anything else, read it to the person and link the source
   instead of saving it.
3. Save it under `sefaria/<ref>.md` with the frontmatter below, then answer from the saved copy.

Never add a published book, a paid subscription or a scanned PDF to this folder, even if the person has a copy.
Point them to the source instead.

## Reading other teachers' sites — on request, link, never save

When the person asks for it, their own agent may **read** these sites for that person and answer from them:

- Rav Yitzchak Ginsburgh's teachings — [inner.org](https://www.inner.org)
- [Chayenu](https://chayenu.org) — the daily study
- Dvar Malchut — the daily study booklet, read at its publisher's own site
- [chabad.org](https://www.chabad.org)

Rules for these sources:

1. **Only when that person asks**, and only for that person. No background crawling, no batch fetching, no
   reading them on behalf of anyone else.
2. **Link, don't copy.** Quote only the few lines the answer needs, attribute them (work, author with proper
   honorific, page), and give the link so the person reads the rest at the source.
3. **Never save their text** to this folder, to memory, or anywhere else — not a page, not a summary of a whole
   page. If the person wants it again, read it again from the source. If a site requires a subscription or
   sign-in, use it only through the person's own account in their own browser, and still save nothing.

**Only Sefaria texts whose license allows it get saved here** (see *Getting a text* above). Everything else is
read at its source and linked.

## Required frontmatter

```yaml
---
work: <title, e.g. Pirkei Avot>
ref: <Sefaria ref, e.g. Pirkei_Avot.1>
author: <author with proper honorific, when known>
source: https://www.sefaria.org/<ref>
version: <version title as Sefaria gives it>
license: <license as Sefaria gives it>
fetched_at: <ISO 8601>
fetched_by: <agent name>
---
```

## Provenance is sacred

**Never misattribute a teaching to its author.** Different teachers and schools must never be conflated. If you are
uncertain whose teaching something is, say so and stop — a misattributed teaching causes more harm than a delayed answer.

## Citing to the person

> *From [Work], [Author honorific]* — with a link to the source.

Use plain English unless the person learns in Hebrew or uses those terms; then meet them there.

## Principles log (optional)

`principles-<year>.md` is an append-only log of what you learn together. Each entry:

```markdown
### <date> · <one-line principle>

**Source:** <Work>, <Author>, <reference>
**Logged by:** <agent name>

<2–5 sentences, faithful summary>

---
```

The `---` separator keeps the log safe for parallel appends.
