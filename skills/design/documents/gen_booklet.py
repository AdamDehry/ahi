#!/usr/bin/env python3
"""
gen_booklet.py — generate a multi-page booklet PDF with cover + TOC + sections.

Spec (JSON on stdin):
  {
    "title": "Shabbat Planning Guide",
    "out": "shabbat-guide.pdf",       # optional
    "cover": {
      "subtitle": "A handbook",        # optional
      "author": "Miriam"                # optional
    },
    "sections": [
      {"heading": "Introduction", "body_md": "..."},
      {"heading": "Week One",     "body_md": "..."}
    ]
  }

Writes to <--out-dir, default $AHI_HOME/ai/ahi-docs/generated>/<timestamp>-<slug>.pdf and prints ONLY
the absolute path to stdout.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

def log(msg):
    print(msg, file=sys.stderr)

try:
    import markdown as md_mod
    from weasyprint import HTML, CSS
except ImportError as e:
    log(f"[gen_booklet] Missing dependency: {e}")
    log("[gen_booklet] Install: $AHI_AI_ROOT/venvs/miriam-docs/venv/bin/pip install weasyprint markdown")
    sys.exit(2)

def output_dir(arg) -> Path:
    """--out-dir if given (the folder the agent's files note names), else <AHI_HOME or ~>/ai/ahi-docs/generated."""
    # Absolute, so the printed path is one send_file accepts.
    return (Path(arg).expanduser() if arg else Path(os.environ.get("AHI_HOME") or Path.home()) / "ai" / "ahi-docs" / "generated").resolve()

CSS_STYLE = """
@page {
    size: letter;
    margin: 0.9in;
    @bottom-center {
        content: counter(page);
        font-family: Georgia, serif;
        font-size: 9pt;
        color: #888;
    }
}
@page cover {
    margin: 0;
    @bottom-center { content: none; }
}
@page toc {
    @bottom-center { content: none; }
}
html { font-family: Georgia, "Times New Roman", serif; font-size: 11.5pt; line-height: 1.6; color: #222; }
.cover {
    page: cover;
    page-break-after: always;
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    background: linear-gradient(135deg, #faf6f0 0%, #f1e8d8 100%);
    padding: 2in 1in;
    box-sizing: border-box;
}
.cover h1 { font-size: 32pt; color: #1a1a1a; margin: 0 0 0.3em 0; font-weight: 600; }
.cover .subtitle { font-size: 14pt; color: #7a5a32; font-style: italic; margin-bottom: 1.5em; }
.cover .author { font-size: 11pt; color: #555; margin-top: auto; }
.cover .date { font-size: 10pt; color: #888; margin-top: 0.5em; }
.cover hr { width: 120px; border: none; border-top: 2px solid #b48a52; margin: 1.2em auto; }

.toc { page: toc; page-break-after: always; }
.toc h2 { font-size: 20pt; color: #b48a52; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; }
.toc ol { list-style: none; padding: 0; margin: 1.5em 0; counter-reset: toc-item; }
.toc li {
    counter-increment: toc-item;
    padding: 0.5em 0;
    border-bottom: 1px dotted #ddd;
    font-size: 12pt;
}
.toc li::before {
    content: counter(toc-item) ". ";
    color: #b48a52;
    font-weight: 600;
    margin-right: 0.4em;
}

.section { page-break-before: always; }
.section h2 {
    font-size: 20pt;
    color: #b48a52;
    border-bottom: 2px solid #b48a52;
    padding-bottom: 0.25em;
    margin-bottom: 0.8em;
}
.section h3 { font-size: 13.5pt; color: #1a1a1a; margin-top: 1.3em; }
.section h4 { font-size: 12pt; color: #333; margin-top: 1.1em; }
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
code { font-family: Menlo, monospace; font-size: 10pt; background: #f4f1ec; padding: 1px 4px; border-radius: 3px; }
pre { background: #f4f1ec; border: 1px solid #e5ddd0; padding: 0.7em 0.9em; border-radius: 4px; font-size: 9.5pt; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
th { background: #f4f1ec; font-weight: 600; }
"""

def slugify(s: str) -> str:
    s = re.sub(r"[^\w\s-]", "", (s or "booklet").strip().lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s[:60] or "booklet"

def main():
    ap = argparse.ArgumentParser(description="Reads the JSON spec on stdin.")
    ap.add_argument("--out-dir", help="Folder to write into (default: $AHI_HOME/ai/ahi-docs/generated)")
    args = ap.parse_args()
    try:
        spec = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        log(f"[gen_booklet] Invalid JSON on stdin: {e}")
        sys.exit(3)

    title = spec.get("title", "Booklet")
    sections = spec.get("sections", [])
    cover = spec.get("cover", {}) or {}

    if not sections:
        log("[gen_booklet] No sections in spec")
        sys.exit(3)

    out_dir = output_dir(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    if spec.get("out"):
        name = spec["out"] if spec["out"].endswith(".pdf") else spec["out"] + ".pdf"
    else:
        name = f"{ts}-{slugify(title)}.pdf"
    out_path = out_dir / name

    subtitle = cover.get("subtitle", "")
    author = cover.get("author", "")
    date_str = datetime.now().strftime("%B %Y")

    cover_html = f"""
<div class="cover">
    <h1>{title}</h1>
    {f'<div class="subtitle">{subtitle}</div>' if subtitle else ''}
    <hr>
    {f'<div class="author">by {author}</div>' if author else ''}
    <div class="date">{date_str}</div>
</div>
"""
    toc_items = "\n".join(f"<li>{s.get('heading', 'Section')}</li>" for s in sections)
    toc_html = f"""
<div class="toc">
    <h2>Contents</h2>
    <ol>{toc_items}</ol>
</div>
"""

    section_html_parts = []
    for s in sections:
        heading = s.get("heading", "Section")
        body_md = s.get("body_md", "")
        body_html = md_mod.markdown(
            body_md,
            extensions=["extra", "sane_lists", "tables", "fenced_code"],
        )
        section_html_parts.append(
            f'<div class="section"><h2>{heading}</h2>\n{body_html}\n</div>'
        )
    sections_html = "\n".join(section_html_parts)

    full_html = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>{title}</title></head>
<body>
{cover_html}
{toc_html}
{sections_html}
</body></html>
"""
    log(f"[gen_booklet] Rendering booklet '{title}' ({len(sections)} sections) -> {out_path}")
    HTML(string=full_html).write_pdf(str(out_path), stylesheets=[CSS(string=CSS_STYLE)])
    print(str(out_path))

if __name__ == "__main__":
    main()
