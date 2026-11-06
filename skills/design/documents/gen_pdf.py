#!/usr/bin/env python3
"""
gen_pdf.py — generate a nicely formatted PDF from a title + markdown body.

Usage:
    echo "markdown body..." | gen_pdf.py --title "My Document"
    gen_pdf.py --title "My Document" --body "markdown body..."
    gen_pdf.py --title "My Document" --body-file /path/to/body.md
    gen_pdf.py --title "..." --out custom-name.pdf   # optional custom filename

Writes PDF to <--out-dir, default $AHI_HOME/ai/ahi-docs/generated>/<timestamp>-<slug>.pdf and prints
ONLY the absolute path to stdout. Logs go to stderr.
"""
import argparse
import re
import sys
import os
from datetime import datetime
from pathlib import Path

def log(msg):
    print(msg, file=sys.stderr)

try:
    import markdown as md_mod
    from weasyprint import HTML, CSS
except ImportError as e:
    log(f"[gen_pdf] Missing dependency: {e}")
    log("[gen_pdf] Install into venv: $AHI_AI_ROOT/venvs/miriam-docs/venv/bin/pip install weasyprint markdown")
    sys.exit(2)

def output_dir(arg) -> Path:
    """--out-dir if given (the folder the agent's files note names), else <AHI_HOME or ~>/ai/ahi-docs/generated."""
    # Absolute, so the printed path is one send_file accepts.
    return (Path(arg).expanduser() if arg else Path(os.environ.get("AHI_HOME") or Path.home()) / "ai" / "ahi-docs" / "generated").resolve()

CSS_STYLE = """
@page {
    size: letter;
    margin: 0.9in 0.9in 1in 0.9in;
    @bottom-center {
        content: counter(page) " of " counter(pages);
        font-family: Georgia, serif;
        font-size: 9pt;
        color: #888;
    }
}
html {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 11.5pt;
    line-height: 1.55;
    color: #222;
}
h1.doc-title {
    font-family: Georgia, serif;
    font-size: 22pt;
    font-weight: 600;
    color: #1a1a1a;
    margin: 0 0 0.15em 0;
    padding: 0;
    border-bottom: 2px solid #b48a52;
    padding-bottom: 0.3em;
}
p.doc-meta {
    color: #888;
    font-size: 9.5pt;
    font-style: italic;
    margin: 0 0 1.6em 0;
}
h1, h2, h3, h4 {
    font-family: Georgia, serif;
    color: #1a1a1a;
    line-height: 1.3;
    page-break-after: avoid;
}
h1 { font-size: 18pt; margin-top: 1.4em; }
h2 { font-size: 14.5pt; margin-top: 1.2em; color: #b48a52; }
h3 { font-size: 12.5pt; margin-top: 1em; }
p { margin: 0 0 0.8em 0; }
ul, ol { margin: 0 0 0.9em 1.3em; }
li { margin-bottom: 0.3em; }
blockquote {
    border-left: 3px solid #b48a52;
    margin: 1em 0;
    padding: 0.4em 1em;
    color: #555;
    font-style: italic;
    background: #faf6f0;
}
code {
    font-family: "Menlo", "Consolas", monospace;
    font-size: 10pt;
    background: #f4f1ec;
    padding: 1px 4px;
    border-radius: 3px;
}
pre {
    background: #f4f1ec;
    border: 1px solid #e5ddd0;
    border-radius: 4px;
    padding: 0.7em 0.9em;
    overflow-x: auto;
    font-size: 9.5pt;
    line-height: 1.4;
}
table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
}
th, td {
    border: 1px solid #ddd;
    padding: 6px 10px;
    text-align: left;
}
th {
    background: #f4f1ec;
    font-weight: 600;
}
hr { border: none; border-top: 1px solid #ddd; margin: 1.4em 0; }
a { color: #8a6a3f; text-decoration: none; }
"""

def slugify(title: str) -> str:
    s = re.sub(r"[^\w\s-]", "", title.strip().lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s[:60] or "document"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", required=True)
    ap.add_argument("--body", help="Markdown body (if omitted, reads stdin)")
    ap.add_argument("--body-file", help="Path to a markdown file")
    ap.add_argument("--out", help="Optional output filename (name only, not path)")
    ap.add_argument("--out-dir", help="Folder to write into (default: $AHI_HOME/ai/ahi-docs/generated)")
    args = ap.parse_args()

    if args.body_file:
        body_md = Path(args.body_file).read_text(encoding="utf-8")
    elif args.body:
        body_md = args.body
    else:
        body_md = sys.stdin.read()

    if not body_md.strip():
        log("[gen_pdf] Empty body; nothing to render")
        sys.exit(3)

    out_dir = output_dir(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    if args.out:
        name = args.out if args.out.endswith(".pdf") else args.out + ".pdf"
    else:
        name = f"{ts}-{slugify(args.title)}.pdf"
    out_path = out_dir / name

    body_html = md_mod.markdown(
        body_md,
        extensions=["extra", "sane_lists", "tables", "fenced_code"],
    )
    date_str = datetime.now().strftime("%B %d, %Y")
    full_html = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>{args.title}</title></head>
<body>
<h1 class="doc-title">{args.title}</h1>
<p class="doc-meta">{date_str}</p>
{body_html}
</body></html>
"""

    log(f"[gen_pdf] Rendering '{args.title}' -> {out_path}")
    HTML(string=full_html).write_pdf(str(out_path), stylesheets=[CSS(string=CSS_STYLE)])
    print(str(out_path))

if __name__ == "__main__":
    main()
