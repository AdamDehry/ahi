#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, shutil, sys, time
from datetime import datetime
from pathlib import Path

AHI_HOME = Path(os.environ.get("AHI_HOME", Path.home() / "ahi")).expanduser().resolve()
PROJECTS_DIR = Path.home() / ".claude" / "projects"
INDEX_JSON = Path(os.environ.get("AHI_SESSIONS_INDEX", AHI_HOME / "state" / "primary" / "sessions" / "index.json")).expanduser()
TRASH_ROOT = Path(os.environ.get("AHI_PRUNE_TRASH", Path.home() / ".trash-ahi-subprocess-jsonls")).expanduser()
LOG_DIR = AHI_HOME / "state" / "primary" / "sessions" / "logs"
LOG_FILE = LOG_DIR / "prune_subprocess_jsonls.log"
TOOLING_PREFIXES = [
    "summarize this ai conversation",
    "you are labelling",
    "you are cataloging",
    "summarize this transcript",
    "extract structured data",
    "given this jsonl content",
    "given the following jsonl",
    "generate a short title",
    "write a short title",
    "classify this conversation",
    "categorize this conversation",
]

def log(msg: str) -> None:
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a") as fh:
            fh.write(line + "\n")
    except Exception:
        pass

def load_safelist() -> set[str]:
    if not INDEX_JSON.exists():
        return set()
    try:
        data = json.loads(INDEX_JSON.read_text())
        return {e["session_id"] for e in data if isinstance(e, dict) and e.get("session_id")}
    except Exception as exc:
        log(f"cannot read index; continuing with empty safelist: {exc}")
        return set()

def first_signal(jsonl: Path) -> str | None:
    try:
        with jsonl.open("r", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 200: break
                try: d = json.loads(line)
                except Exception: continue
                if d.get("type") == "queue-operation":
                    c = d.get("content", "")
                    if isinstance(c, str) and c.strip(): return c.strip().lower()[:300]
                if d.get("type") == "user" and d.get("parentUuid") is None:
                    msg = d.get("message") or {}
                    c = msg.get("content", "")
                    if isinstance(c, str) and c.strip(): return c.strip().lower()[:300]
                    if isinstance(c, list):
                        for item in c:
                            if isinstance(item, dict) and item.get("type") == "text":
                                txt = item.get("text", "")
                                if txt.strip(): return txt.strip().lower()[:300]
                if d.get("type") == "ai-title":
                    return "__ai_title_marker__"
    except Exception:
        return None
    return None

def classify(jsonl: Path, safelist: set[str]) -> tuple[str, str]:
    sid = jsonl.stem
    if sid in safelist: return "KEEP", "in-index"
    sig = first_signal(jsonl)
    if sig is None: return "AMBIGUOUS", "no-first-message"
    if sig == "__ai_title_marker__": return "TOOLING", "ai-title"
    for prefix in TOOLING_PREFIXES:
        if sig.startswith(prefix): return "TOOLING", f"prefix:{prefix[:30]}"
    return "KEEP", "real-content"

def project_dirs() -> list[Path]:
    if not PROJECTS_DIR.exists(): return []
    dirs = []
    for p in PROJECTS_DIR.iterdir():
        if p.is_dir() and not p.is_symlink():
            dirs.append(p)
    return dirs

def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--since-hours", type=float)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--trash-tag", default=None)
    args = ap.parse_args()
    safelist = load_safelist()
    cutoff = time.time() - args.since_hours * 3600 if args.since_hours else None
    tag = args.trash_tag or datetime.now().strftime("%Y-%m-%d")
    trash = TRASH_ROOT / tag
    totals = {"KEEP": 0, "TOOLING": 0, "AMBIGUOUS": 0}
    moved = 0
    for pd in project_dirs():
        for jsonl in pd.glob("*.jsonl"):
            if cutoff and jsonl.stat().st_mtime < cutoff: continue
            verdict, reason = classify(jsonl, safelist)
            totals[verdict] += 1
            if verdict == "TOOLING":
                dest = trash / pd.name / jsonl.name
                moved += jsonl.stat().st_size
                if not args.dry_run:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(jsonl), str(dest))
    log(f"TOTAL keep={totals['KEEP']} tooling={totals['TOOLING']} ambiguous={totals['AMBIGUOUS']} moved={moved}B dry_run={args.dry_run}")

if __name__ == "__main__":
    main()
