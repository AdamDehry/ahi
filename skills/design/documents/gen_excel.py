#!/usr/bin/env python3
"""
gen_excel.py — generate an .xlsx from a JSON spec on stdin.

Spec:
  {
    "title": "Budget 2026",
    "out": "budget-2026.xlsx",        # optional
    "sheets": [
      {
        "name": "Summary",
        "headers": ["Item", "Amount", "Notes"],
        "rows": [
          ["Rent", 3200, "monthly"],
          ["Groceries", 900, ""]
        ]
      }
    ]
  }

Writes to $AHI_HOME/ahi-docs/generated/<timestamp>-<slug>.xlsx and prints ONLY
the absolute path to stdout. Logs to stderr.
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

def log(msg):
    print(msg, file=sys.stderr)

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError as e:
    log(f"[gen_excel] Missing dependency: {e}")
    log("[gen_excel] Install: $AHI_HOME/venvs/miriam-docs/venv/bin/pip install openpyxl")
    sys.exit(2)

OUTPUT_DIR = Path.home() / "ai" / "ahi-docs" / "generated"

def slugify(s: str) -> str:
    s = re.sub(r"[^\w\s-]", "", (s or "workbook").strip().lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s[:60] or "workbook"

def main():
    try:
        spec = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        log(f"[gen_excel] Invalid JSON on stdin: {e}")
        sys.exit(3)

    title = spec.get("title", "Workbook")
    sheets = spec.get("sheets", [])
    if not sheets:
        log("[gen_excel] No sheets in spec")
        sys.exit(3)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    if spec.get("out"):
        name = spec["out"] if spec["out"].endswith(".xlsx") else spec["out"] + ".xlsx"
    else:
        name = f"{ts}-{slugify(title)}.xlsx"
    out_path = OUTPUT_DIR / name

    wb = Workbook()
    wb.remove(wb.active)

    header_font = Font(bold=True, color="FFFFFF", size=11)
    header_fill = PatternFill("solid", fgColor="B48A52")
    thin_border = Border(
        left=Side(style="thin", color="DDDDDD"),
        right=Side(style="thin", color="DDDDDD"),
        top=Side(style="thin", color="DDDDDD"),
        bottom=Side(style="thin", color="DDDDDD"),
    )

    for sheet_spec in sheets:
        ws = wb.create_sheet(sheet_spec.get("name", "Sheet1")[:31])
        headers = sheet_spec.get("headers", [])
        rows = sheet_spec.get("rows", [])

        if headers:
            ws.append(headers)
            for col_idx, _ in enumerate(headers, start=1):
                cell = ws.cell(row=1, column=col_idx)
                cell.font = header_font
                cell.fill = header_fill
                cell.alignment = Alignment(horizontal="left", vertical="center")
                cell.border = thin_border

        for row in rows:
            ws.append(row)

        # Basic styling for data rows
        last_row = ws.max_row
        last_col = ws.max_column
        for r in range(2, last_row + 1):
            for c in range(1, last_col + 1):
                cell = ws.cell(row=r, column=c)
                cell.border = thin_border
                cell.alignment = Alignment(vertical="center")

        # Auto-width (approx)
        for col_idx in range(1, last_col + 1):
            max_len = 8
            for r in range(1, last_row + 1):
                val = ws.cell(row=r, column=col_idx).value
                if val is not None:
                    l = len(str(val))
                    if l > max_len:
                        max_len = l
            ws.column_dimensions[get_column_letter(col_idx)].width = min(max_len + 2, 60)

        ws.freeze_panes = "A2"

    log(f"[gen_excel] Writing '{title}' -> {out_path}")
    wb.save(str(out_path))
    print(str(out_path))

if __name__ == "__main__":
    main()
