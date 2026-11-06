---
name: documents
description: Miriam's document generators — a formatted PDF from markdown, a multi-sheet Excel workbook from a JSON spec, and a multi-page booklet PDF with cover and table of contents. Use when someone asks an agent for "a PDF of this", "put it in a spreadsheet", "make a booklet/handout/guide". Not for editing an existing PDF or Office file (use the anthropic pdf/xlsx/docx skills).
version: 1.1.0
category: design
private: false
last_verified: 2026-11-05
verified_by: skills-audit
---

# documents

Three generators. Each prints ONLY the absolute output path on stdout and logs to stderr.

## When to use

- Turning a chat answer into a clean PDF, a table into .xlsx, or a guide into a booklet.

## Steps

1. PDF from markdown:
   `echo "<markdown>" | python3 $AHI_HOME/skills/design/documents/gen_pdf.py --title "My Document"`
   or `--body "..."` / `--body-file path.md`; optional `--out name.pdf`.
2. Excel from JSON on stdin:
   `echo '{"title":"Budget","sheets":[{"name":"Summary","headers":["Item","Amount"],"rows":[["Rent",3200]]}]}' | python3 $AHI_HOME/skills/design/documents/gen_excel.py`
3. Booklet from JSON on stdin:
   `{"title":"…","cover":{"subtitle":"…","author":"Miriam"},"sections":[{"heading":"…","body_md":"…"}]}` → `python3 $AHI_HOME/skills/design/documents/gen_booklet.py`
4. Output lands in the agent's generated-docs folder (path printed); send that path back with the file tool.

## Gotchas

- Call them by their full shelf path in chat turns.
- Dependencies: `markdown` + `weasyprint` (PDF, booklet), `openpyxl` (Excel), from the miriam-docs venv. A missing module exits 1 with the pip line to run.
- Shebangs may point at a venv that is not on this machine; always run with an explicit interpreter.
- The output folder is per principal; do not repoint it without checking the principal filter (gate R-1 / F-32).

## Rulings this depends on

- R-1 / F-32 (principal privacy filter stays fleet-wide).

## Related skills

vision · anthropic pdf/xlsx/docx skills (editing existing files)
