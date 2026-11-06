#!/usr/bin/env python3
"""fm_brief_header — the machine header a brief must carry before build_from_brief.sh
will launch it (and before any UI offers a Start button for it).

If another component (a UI, a gateway) validates the same contract in its own
language, both should run one shared fixture set (`fixtures <dir>` below) so the
two validators cannot drift apart.

THE HEADER is a flat front-matter block at the very top of the brief:

    ---
    feed: brief                      # format marker; must be exactly "brief"
    agent: tzali                     # tzali | avi
    runtime: claude                  # claude | codex
    model: claude-opus-5-5           # full slug, never a bare alias
    effort: high                     # claude: low medium high xhigh max · codex: none low medium high xhigh ultra max
    name: add-export-button          # build name (kebab-case, <= 60)
    repo: /abs/path/to/repo          # optional — the git repo to cut a worktree from
    branch: feat/add-export-button   # with repo: required
    worktree: add-export-button      # with repo: required — the folder under the worktrees dir
    workdir: /abs/path               # without repo: required
    why: <one line, 15..300 chars>   # the model-gate reason; lands in meta.json
    pre_approved: no                 # yes | no — yes = runs to a preview with no approve step
    summary: <one line, <= 160>      # what the brief is, in one line
    track: trk-phase-d               # optional — the tracker row this brief backs (trk-…, bld-… or idea-…)
    ---

Flat `key: value` lines only; no nesting, no lists, no quotes needed. Unknown
keys are errors (a typo must not pass as "optional"). Anything after the
closing `---` is the human brief and is not read here.

USAGE
    fm_brief_header.py validate <brief.md>      → JSON {valid, header, errors, sha256, path}; exit 0 valid, 2 invalid, 1 unreadable
    fm_brief_header.py scan <dir>               → JSON array, one per *.md (valid or not)
    fm_brief_header.py fixtures <dir>           → runs every <dir>/*.md against <dir>/expected.json; exit 0 = parity
"""
import hashlib
import json
import os
import re
import sys

MARKER = "brief"
AGENTS = ("tzali", "avi")
RUNTIMES = ("claude", "codex")
EFFORT = {
    "claude": ("low", "medium", "high", "xhigh", "max"),
    "codex": ("none", "low", "medium", "high", "xhigh", "ultra", "max"),
}
YESNO = ("yes", "no")
REQUIRED = ("feed", "agent", "runtime", "model", "effort", "name", "why", "pre_approved", "summary")
OPTIONAL = ("repo", "branch", "worktree", "workdir", "track")
KNOWN = set(REQUIRED) | set(OPTIONAL)
NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$")
MODEL_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]{2,60}(?:\[1m\])?$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/\-]{0,100}$")
TRACK_RE = re.compile(r"^(?:trk|bld|idea)-[a-z0-9._-]{1,80}$")
BARE_ALIASES = ("opus", "sonnet", "haiku", "fable", "gpt")
LINE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$")


def split_front_matter(text):
    """→ (block_lines, error). The block must open on line 1 with `---` and close with `---`."""
    lines = text.split("\n")
    if not lines or lines[0].rstrip() != "---":
        return None, "no front matter: the brief must open with --- on line 1"
    for i in range(1, len(lines)):
        if lines[i].rstrip() == "---":
            return lines[1:i], None
    return None, "front matter never closes: no second --- line"


def parse_block(lines):
    fields, errors = {}, []
    for n, raw in enumerate(lines, start=2):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = LINE_RE.match(line)
        if not m:
            errors.append(f"line {n}: not a key: value line")
            continue
        key, value = m.group(1), m.group(2)
        value = re.sub(r"\s+#.*$", "", value).strip()  # trailing comment
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        if key in fields:
            errors.append(f"line {n}: duplicate key {key}")
            continue
        fields[key] = value
    return fields, errors


def validate_fields(f):
    errors = []
    for k in f:
        if k not in KNOWN:
            errors.append(f"unknown key: {k}")
    for k in REQUIRED:
        if not f.get(k):
            errors.append(f"missing: {k}")
    if f.get("feed") and f["feed"] != MARKER:
        errors.append(f"feed must be exactly {MARKER!r}")
    if f.get("agent") and f["agent"] not in AGENTS:
        errors.append("agent must be one of " + ", ".join(AGENTS))
    rt = f.get("runtime")
    if rt and rt not in RUNTIMES:
        errors.append("runtime must be one of " + ", ".join(RUNTIMES))
    model = f.get("model")
    if model:
        if not MODEL_RE.match(model):
            errors.append("model must be a full slug (letters, digits, dots, dashes; optional [1m])")
        elif model in BARE_ALIASES:
            errors.append(f"model is a bare alias ({model}) — name the full slug")
    eff = f.get("effort")
    if eff and rt in EFFORT and eff not in EFFORT[rt]:
        errors.append(f"effort for {rt} must be one of " + ", ".join(EFFORT[rt]))
    name = f.get("name")
    if name and not NAME_RE.match(name):
        errors.append("name must be kebab-case, 1..60 chars")
    why = f.get("why", "")
    if why and not (15 <= len(why) <= 300):
        errors.append("why must be one line of 15..300 chars")
    pa = f.get("pre_approved")
    if pa and pa not in YESNO:
        errors.append("pre_approved must be yes or no")
    summ = f.get("summary", "")
    if summ and len(summ) > 160:
        errors.append("summary must be <= 160 chars")
    repo = f.get("repo")
    if repo:
        if not repo.startswith("/"):
            errors.append("repo must be an absolute path")
        if not f.get("branch"):
            errors.append("branch is required when repo is set")
        elif not BRANCH_RE.match(f["branch"]):
            errors.append("branch has characters git would refuse")
        if not f.get("worktree"):
            errors.append("worktree is required when repo is set")
        elif not NAME_RE.match(f["worktree"]):
            errors.append("worktree must be kebab-case, 1..60 chars")
        if f.get("workdir"):
            errors.append("workdir and repo are exclusive — with repo the worktree is the workdir")
    else:
        if not f.get("workdir"):
            errors.append("workdir is required when repo is not set")
        elif not f["workdir"].startswith("/"):
            errors.append("workdir must be an absolute path")
        for k in ("branch", "worktree"):
            if f.get(k):
                errors.append(f"{k} only makes sense with repo")
    track = f.get("track")
    if track and not TRACK_RE.match(track):
        errors.append("track must be trk-…, bld-… or idea-…")
    return errors


def normalized(f):
    out = {k: f[k] for k in REQUIRED if k in f}
    out["pre_approved"] = f.get("pre_approved") == "yes"
    for k in OPTIONAL:
        out[k] = f.get(k) or None
    return out


def validate_text(text):
    block, err = split_front_matter(text)
    if err:
        return {"valid": False, "header": None, "errors": [err]}
    fields, errors = parse_block(block)
    errors += validate_fields(fields)
    if errors:
        return {"valid": False, "header": None, "errors": errors}
    return {"valid": True, "header": normalized(fields), "errors": []}


def validate_file(path):
    try:
        raw = open(path, "rb").read()
    except OSError as e:
        return {"path": path, "valid": False, "header": None, "errors": [f"unreadable: {e}"], "sha256": None}
    out = validate_text(raw.decode("utf-8", errors="replace"))
    out["path"] = path
    out["sha256"] = hashlib.sha256(raw).hexdigest()
    return out


def cmd_validate(path):
    out = validate_file(path)
    print(json.dumps(out, indent=2))
    if out["sha256"] is None:
        return 1
    return 0 if out["valid"] else 2


def cmd_scan(d):
    rows = []
    for n in sorted(os.listdir(d)):
        if n.endswith(".md"):
            rows.append(validate_file(os.path.join(d, n)))
    print(json.dumps(rows, indent=2))
    return 0


def cmd_fixtures(d):
    expected = json.load(open(os.path.join(d, "expected.json")))
    bad = 0
    for name, exp in sorted(expected.items()):
        got = validate_file(os.path.join(d, name))
        ok = got["valid"] == exp["valid"]
        if ok and exp["valid"]:
            ok = got["header"] == exp["header"]
        if ok and not exp["valid"]:
            ok = all(any(needle in e for e in got["errors"]) for needle in exp.get("error_contains", []))
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" → {json.dumps(got)}"))
        bad += 0 if ok else 1
    print(f"{len(expected) - bad}/{len(expected)} fixtures agree")
    return 0 if bad == 0 else 1


def main(argv):
    if len(argv) < 3 or argv[1] not in ("validate", "scan", "fixtures"):
        print(__doc__.strip().split("USAGE", 1)[1], file=sys.stderr)
        return 1
    if argv[1] == "validate":
        return cmd_validate(argv[2])
    if argv[1] == "scan":
        return cmd_scan(argv[2])
    return cmd_fixtures(argv[2])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
