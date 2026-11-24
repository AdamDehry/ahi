---
name: zero-dep-pdf-sheet
description: Typeset a print-quality PDF (worksheet, quote, certificate, invoice-like document) from Node with zero dependencies — embedded TrueType faces from Google Fonts, PNG logo with alpha, vector QR code, flow layout with a page budget — rendered from the same data model as the HTML and print views, and proved by tests that read the PDF's own text. Use when a build must ship a downloadable PDF that matches its web design and cannot add pdfkit/puppeteer at runtime. Not for editing existing PDFs (anthropic pdf skill) or markdown-to-PDF handouts (documents).
version: 1.1.0
category: design
private: false
last_verified: 2026-11-19
verified_by: zali
---

# zero-dep-pdf-sheet

One data model, two renderers (HTML and PDF), the same fonts in both, and tests that read the numbers back out of the PDF.

## When to use

- A site sells or delivers a document and the PDF must say exactly what the screen said.
- The box is small or the project must run with `node server.mjs` and no install step.
- You need a QR code or a logo on the PDF and no dependency for either.

## When NOT to use

- Editing, merging or filling an existing PDF: use the `pdf` skill.
- A one-off handout from markdown: use `documents`.
- Very complex layouts (tables spanning pages, RTL shaping, ligatures): use headless Chromium `page.pdf()`.

## Workflow

1. **Model first.** Write `buildModel(lockedCalc)` that returns every printed string, already formatted
   by one shared formatter (money, dates). HTML and PDF only lay it out; neither formats or computes.
   Mark the rows a preview must hide (`locked: true`), and redact them on the server, not in CSS.
2. **Fonts.** Web: variable woff2 (modern UA). PDF: static TTF per weight, fetched with an old UA:
   `curl -A "Mozilla/4.0" "https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@72,300"` returns
   `…ttf` URLs; pin `opsz` to get a display cut. Keep the OFL licence beside the files.
3. **Writer (≈250 lines, see sources).** Objects: Catalog, Pages, Page, content stream (Flate), per font
   `/TrueType` + `/FontDescriptor` + `/FontFile2` (Flate, `/Length1` = raw size) with `/Encoding
   /WinAnsiEncoding` and `/Widths` for codes 32–255 from the TTF's `hmtx` via `cmap` format 4. Images:
   RGB XObject + DeviceGray `/SMask` from a tiny PNG decoder (inflate + 5 filters). Links: `/Annots`
   `/Link` with `/URI`. Top-left coordinates in your API, flip `y` once in the writer.
4. **Layout.** Measure with the widths table, greedy word-wrap, and an `ensure(height)` that starts a new
   page with a running head. Draw page footers last so "Page 1 of N" is right.
5. **QR.** Byte mode, ECC M, versions 1–10, mask chosen by penalty (Nayuki's structure). Draw modules as
   filled rects; add a link annotation over it.
6. **Twin an existing HTML sheet (when the web design came first).** Lay the PDF out in the HTML's own CSS
   pixels and scale once: page width = the sheet's design width, one `cm` matrix at the top of every content
   stream, MediaBox and link rectangles multiplied by the same scale. Then every number in the renderer is a
   number you can read off the stylesheet (padding, font size, gap), and text sits where CSS puts it if you
   place it from the top of a line box: `baseline = top + (lineHeight - (ascent - descent) * size / 1000) / 2
   + ascent * size / 1000`, with ascent/descent from the TTF. Spacing that changes with the content (a tighter
   page when there are many rows) goes in the MODEL as numbers; the web page sets them as CSS variables and
   the PDF reads the same fields, so there is no second copy to keep in step.
7. **Photos.** A JPEG needs no decoder: an image XObject with `/Filter /DCTDecode` and the file's own bytes;
   read width and height from the SOF0/SOF2 marker. One 800px JPEG serves the web page and the PDF. Crop with
   a clip rectangle (`re W n`, draw, `Q`) to match `object-fit: cover`.
8. **Prove it.** Tests inflate each content stream, collect `(…) Tj` runs, decode octal escapes + WinAnsi,
   and assert every figure in the model appears in the PDF and the HTML. Add a page-budget test that
   renders every configuration and asserts `pages <= 2`. Check the print view the same way with
   Playwright `page.pdf({ format: 'Letter' })` + `pdfinfo`.
9. **Look at it.** `pdftoppm -r 80 -png out.pdf page` and read every page; decode the QR once with jsQR
   (install it in a throwaway `/tmp` tools folder, not the project).

## Notes & gotchas

- **The PDF fitting does not prove the print view fits.** The same sheet had 35px to spare in the PDF and
  overflowed the browser's print page by 1px (print CSS clips what overflows). Check both: the renderer throws
  on overflow and a test renders every configuration; and in a real browser, `emulateMedia({ media: 'print' })`
  and measure each page block's last child against the block's inner bottom, on the fullest case.
- **Tracked text wraps early.** Letter-spacing adds width the plain measure does not see: wrap with
  `width + tracking * (chars - 1)` or uppercase labels run into the next column.
- **Text state leaks:** `Tc` (character spacing) persists across `BT…ET`. Emit `0 Tc` on every text op
  or every label after a tracked one comes out letter-spaced and overlapping.
- **WinAnsi only:** U+2212 minus, →, ≈, ✓ are not encodable. Use an en dash as the minus everywhere
  (the shared formatter), and map the rest before encoding. `’ “ ” – — • · × ÷` are fine.
- **Speed:** the slow part is deflating ~100 KB fonts per request. Cache the compressed font stream per
  buffer (WeakMap): render drops from ~400 ms to ~60 ms.
- **CSS twin:** size the HTML sheet in `em` from one font size and use container queries in `em`
  (`@container (max-width: 49em)`), so a miniature (small font) keeps the wide layout while a phone
  stacks. A size container needs a definite width (`width: 100%`), or it collapses to zero inside a
  flex column with auto margins, which shows up only in print.
- **Class collisions:** give sheet classes their own names (`.gloss`, not `.note`) when the site CSS is
  loaded on the same page.
- **Escapes in sources:** the Write tool turns `’` into a literal `’`; scripted edits that match the
  escaped form silently miss. Match the literal character.

## Changelog

- `2026-11-19` — first version, from the SheetPal phase-1 build.
- `2026-11-19` — 1.1.0: twinning an existing HTML sheet (lay out in CSS pixels, scale once, spacing in the model),
  JPEG photos, the print-view fit check, tracked-text wrapping. From the SheetPal merge build.
