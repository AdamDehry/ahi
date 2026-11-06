#!/usr/bin/env python3
"""fm_status — structured build-status records.

The executor does not report to the owner in prose. It writes one record per
checkpoint; the foreman forwards it; a gateway that supports it renders it in
code (optional: see lib.sh fm_status_post / FM_STATUS_ENDPOINT — without the
endpoint the records still reach Michael on his wakes and stay in the ledger).

EXECUTOR (writes a file in its own worktree; no network, no credential):

    fm_status.py emit --kind progress   --finished "..." --now "..." --checks 12/14
    fm_status.py emit --kind needs_owner --finished "..." --now "..." --question "...?"
    fm_status.py emit --kind closed     --finished "..." --now "..." --checks 41/41
    fm_status.py emit --kind failed     --finished "..." --now "<one plain sentence>"

  → appends one JSON line to ./.foreman/status.jsonl. Refused (exit 2, reasons on
    stderr) if a line breaks the contract, so the executor fixes it while it
    still can. --checks is what the test runner MEASURED: passed/total.

FOREMAN (lib.sh / foreman_wake.sh / build_done.sh / heartbeat / build_ask.sh):

    fm_status.py forward --build ID --workdir DIR --state DIR [--title T]
        new executor lines since the cursor → stamped JSON lines on stdout
    fm_status.py make --build ID --kind K --source foreman|michael [--id X] ...
        one stamped record on stdout
    fm_status.py foreman --build ID --event done|failed|abandoned|dark|died|ask|waiting [--workdir DIR]
        one record for a foreman event, carrying the executor's last word
    fm_status.py latest --workdir DIR      last valid executor line, or nothing
    fm_status.py ask-block                 record on stdin → #FMASK1 block (needs_owner)
    fm_status.py selftest --fixture PATH   shared rail fixture parity with the gateway

WHY A FILE (the least-plumbing path): the stop hook already fires on every
executor stop, already maps the worktree to its build, and is foreman code that
holds the gateway token. The executor needs nothing new — no endpoint, no
credential (a builder never receives a live credential), no new hook.
It writes inside its own worktree, which every write rail already allows.

TWIN: a gateway that renders these records should validate the same contract
on receipt, with the same rail ids and patterns; `selftest --fixture` checks
parity against a shared fixture.
"""
import argparse
import json
import os
import re
import secrets
import sys
import time

VERSION = 1
KINDS = ("progress", "needs_owner", "closed", "failed")
CAUSES = ("error", "dark", "died", "abandoned")
SOURCES = ("executor", "foreman", "michael")
BUILD_ID_RE = re.compile(r"^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]{0,80}$")
RECORD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{3,120}$")
CAP_LINE = 200
CAP_QUESTION = 300
CAP_TITLE = 60
CAP_CHECKS = 100_000
STATUS_REL = os.path.join(".foreman", "status.jsonl")

# Mirror these in any gateway-side validator — same ids, same order, same patterns.
TEXT_RAILS = (
    ("newline", re.compile(r"[\r\n  ]")),
    ("control-char", re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")),
    ("bracket", re.compile(r"[()\[\]{}<>]")),
    ("markup", re.compile(r"[`*_#|\\]")),
    ("url", re.compile(r"[a-z][a-z0-9+.-]*://", re.I)),
    ("path-absolute", re.compile(r"(?:^|[\s\"'=:,;])~?/[A-Za-z0-9._-]+")),
    ("path-relative", re.compile(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/|\b[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b")),
    ("gate-id", re.compile(r"\b(?:FM|F|R|G|D|S|RA|SR|MC)-\d+[A-Za-z]?\b|\bgate[- ]?set\b|\bG\d\b", re.I)),
    ("build-id", re.compile(r"\b\d{8}-\d{6}\b")),
    ("hash", re.compile(r"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b", re.I)),
    ("env-var", re.compile(r"\$[A-Za-z_{]")),
    ("reply-label", re.compile(r"\bno reply needed\b|\bno reply required\b|\breply in this format\b", re.I)),
)


def rail_hits(text):
    return [rid for rid, rx in TEXT_RAILS if rx.search(text)]


def normalize_line(s):
    return re.sub(r"[ \t ]+", " ", s).strip()


def line_errors(value, cap):
    errs = []
    if not value:
        errs.append("empty")
    if len(value) > cap:
        errs.append(f"longer than {cap} characters")
    errs.extend(f"rail:{r}" for r in rail_hits(value))
    return errs


def question_errors(q):
    errs = line_errors(q, CAP_QUESTION)
    if q and not q.endswith("?"):
        errs.append("must end with ?")
    if q.count("?") > 1:
        errs.append("more than one question")
    return errs


def validate(rec, strict_text=True):
    """Return (errors, text_errors). strict_text folds text errors into errors —
    the executor's emit is strict; forwarding is not (the gateway falls back)."""
    errors, text = [], {}
    known = {"v", "id", "build", "title", "kind", "finished", "now", "checks", "question", "cause", "source", "at"}
    if not isinstance(rec, dict):
        return ["record must be a JSON object"], text
    errors += [f"unknown field: {k}" for k in rec if k not in known]
    if rec.get("v") != VERSION:
        errors.append(f"v must be {VERSION}")
    if not isinstance(rec.get("id"), str) or not RECORD_ID_RE.match(rec["id"]):
        errors.append("id missing or malformed")
    if not isinstance(rec.get("build"), str) or not BUILD_ID_RE.match(rec["build"]):
        errors.append("build id missing or malformed")
    kind = rec.get("kind")
    if kind not in KINDS:
        errors.append("kind must be one of " + ", ".join(KINDS))
    if rec.get("source", "executor") not in SOURCES:
        errors.append("source must be one of " + ", ".join(SOURCES))
    c = rec.get("checks")
    if c is not None:
        ok = (isinstance(c, dict) and set(c) <= {"passed", "total"}
              and all(isinstance(c.get(k), int) and not isinstance(c.get(k), bool) for k in ("passed", "total"))
              and 0 <= c["passed"] <= c["total"] <= CAP_CHECKS)
        if not ok:
            errors.append("checks must be {passed, total} integers with 0 <= passed <= total")
    cause = rec.get("cause")
    if cause is not None:
        if kind != "failed":
            errors.append("cause is only allowed on kind failed")
        elif cause not in CAUSES:
            errors.append("cause must be one of " + ", ".join(CAUSES))
    q = rec.get("question")
    if kind == "needs_owner" and not q:
        errors.append("needs_owner requires a question")
    if kind != "needs_owner" and q:
        errors.append("question is only allowed on kind needs_owner")
    for f in ("finished", "now"):
        v = rec.get(f, "")
        if not isinstance(v, str):
            errors.append(f"{f} must be a string")
            continue
        e = line_errors(normalize_line(v), CAP_LINE)
        if e:
            text[f] = e
    if isinstance(q, str) and q:
        e = question_errors(normalize_line(q))
        if e:
            text["question"] = e
    t = rec.get("title")
    if isinstance(t, str) and t:
        e = line_errors(normalize_line(t), CAP_TITLE)
        if e:
            text["title"] = e
    if strict_text:
        errors += [f"{f}: {m}" for f, ms in text.items() for m in ms]
    return errors, text


def new_id(prefix="e"):
    return f"{prefix}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{secrets.token_hex(3)}"


def parse_checks(s):
    if s is None:
        return None
    m = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", s)
    if not m:
        raise ValueError(f"--checks must be PASSED/TOTAL, got {s!r}")
    return {"passed": int(m.group(1)), "total": int(m.group(2))}


def build_record(a, build, source, rid=None, title=None):
    rec = {
        "v": VERSION,
        "id": rid or new_id("e" if source == "executor" else source[0]),
        "build": build,
        "kind": a.kind,
        "finished": normalize_line(a.finished or ""),
        "now": normalize_line(a.now or ""),
        "checks": parse_checks(a.checks),
        "source": source,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if title:
        rec["title"] = title
    if a.question:
        rec["question"] = normalize_line(a.question)
    if getattr(a, "cause", None):
        rec["cause"] = a.cause
    return rec


# ── executor ────────────────────────────────────────────────────────────────

PLACEHOLDER_BUILD = "00000000-000000-executor"  # stamped over by the forwarder


def cmd_emit(a):
    try:
        rec = build_record(a, PLACEHOLDER_BUILD, "executor")
    except ValueError as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 2
    errors, _ = validate(rec, strict_text=True)
    if errors:
        print("REFUSED — fix and re-run:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        print("Plain sentences only: no brackets, paths, gate ids, build ids, hashes or markup.", file=sys.stderr)
        return 2
    del rec["build"]  # the forwarder owns the build id; an executor cannot pick one
    path = os.path.join(a.dir or os.getcwd(), STATUS_REL)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    where = {"progress": "the build timeline only", "needs_owner": "the owner's chat as \"I need you\"",
             "closed": "the owner's chat as \"Build closed\"", "failed": "the owner's chat as \"Build failed\""}[a.kind]
    print(f"recorded {a.kind} {rec['id']} → {where} (at your next stop)")
    return 0


# ── foreman ─────────────────────────────────────────────────────────────────

def read_lines(workdir):
    path = os.path.join(workdir, STATUS_REL)
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().split("\n")
    except FileNotFoundError:
        return []


def cmd_forward(a):
    """New executor lines since the cursor → stamped records on stdout, one per
    line. Unparseable lines go out as {"malformed": "<line>"} so Michael still
    sees them; the gateway never does."""
    os.makedirs(a.state, exist_ok=True)
    cursor_path = os.path.join(a.state, "status.cursor")
    try:
        done = int(open(cursor_path).read().strip() or 0)
    except (FileNotFoundError, ValueError):
        done = 0
    lines = read_lines(a.workdir)
    # Only newline-terminated lines are complete: split() leaves either "" (file
    # ends in a newline) or a half-written line last, and both wait.
    complete = lines[:-1]
    if done > len(complete):
        done = 0  # file was replaced/truncated — start over; the gateway dedupes by id
    # The status file belongs to the WORKDIR, not the build, and workdirs are
    # reused (resumes and rebases run in a folder holding an earlier build's
    # records). A fresh cursor starts at 0, so every earlier record would go out
    # stamped with THIS build's id, and the owner's "Build closed" would describe
    # someone else's work. A record written before this build began is not this
    # build's: skip it, cursor still advances.
    started = 0.0
    try:
        with open(os.path.join(a.state, "meta.json"), encoding="utf-8") as f:
            started = float(json.load(f).get("created") or 0)
    except (OSError, ValueError, TypeError):
        started = 0.0
    for raw in complete[done:]:
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
            if not isinstance(rec, dict):
                raise ValueError
        except ValueError:
            print(json.dumps({"malformed": raw[:2000]}, ensure_ascii=False))
            continue
        at = rec.get("at")
        if started and isinstance(at, str):
            try:
                written = time.mktime(time.strptime(at, "%Y-%m-%dT%H:%M:%SZ")) - time.timezone
            except (ValueError, OverflowError):
                written = None
            if written is not None and written < started - 60:
                continue  # an earlier build's record in a reused workdir
        rec["build"] = a.build
        rec["source"] = "executor"
        if a.title:
            rec["title"] = a.title
        print(json.dumps(rec, ensure_ascii=False))
    tmp = cursor_path + ".tmp"
    with open(tmp, "w") as f:
        f.write(str(len(complete)))
    os.replace(tmp, cursor_path)
    return 0


def cmd_make(a):
    try:
        rec = build_record(a, a.build, a.source, rid=a.id, title=a.title)
    except ValueError as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 2
    errors, _ = validate(rec, strict_text=False)
    if errors:
        for e in errors:
            print(f"REFUSED: {e}", file=sys.stderr)
        return 2
    print(json.dumps(rec, ensure_ascii=False))
    return 0


#: Foreman events → (kind, cause, fixed "now" sentence). Fixed sentences, so the
#: foreman's half of the owner's chat is as deterministic as the renderer.
FOREMAN_EVENTS = {
    "done": ("closed", None, "Closed."),
    "failed": ("failed", "error", "Michael closed it as failed, and the details are on its timeline."),
    "abandoned": ("failed", "abandoned", "Michael stopped it before it finished."),
    "dark": ("failed", "dark", "It has been quiet for over half an hour, and Michael is checking on it."),
    "died": ("failed", "died", "Its session ended without closing, and Michael is checking whether it finished."),
    "ask": ("needs_owner", None, "Waiting on your answer."),
    # wake-collision: a build that finished and sat unanswered by
    # Michael through his bounded re-wakes. NOT "went dark" — nothing is wrong
    # with the build; its supervisor has not answered. Fixed words, like dark.
    "waiting": ("needs_owner", None, "Waiting on Michael."),
}

#: The one question a "waiting" record puts to the owner. Fixed, so the gateway's
#: chat dedupe says it once per build, and it passes every text rail.
WAITING_QUESTION = ("It finished its turn and is waiting on Michael, "
                    "who has not answered the wakes about it. Can you check on Michael?")


def latest_record(workdir):
    for raw in reversed(read_lines(workdir) if workdir else []):
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("kind") in KINDS:
            return rec
    return None


def clean(value, cap=CAP_LINE):
    v = normalize_line(value) if isinstance(value, str) else ""
    return v if v and not line_errors(v, cap) else ""


def cmd_foreman(a):
    """One record for a foreman event, carrying the executor's own last word
    where it has one: its `finished` line and its measured checks on a close,
    its own failure sentence when it already said it failed."""
    kind, cause, now = FOREMAN_EVENTS[a.event]
    last = latest_record(a.workdir) or {}
    finished = clean(last.get("finished")) or ("Closed by Michael." if a.event == "done" else "Work was in progress.")
    if a.event == "failed" and last.get("kind") == "failed" and clean(last.get("now")):
        now = clean(last.get("now"))
    checks = last.get("checks") if a.event in ("done", "failed") else None
    if checks is not None and validate({**_probe(a.build), "checks": checks})[0]:
        checks = None  # an unmeasurable count is reported as none, never invented
    rec = {
        "v": VERSION,
        # Deterministic for a close: re-running it is the same record, which the
        # gateway treats as a no-op. Alarms and asks get a fresh id each time.
        "id": f"{a.event}-{a.build}" if a.event in ("done", "failed", "abandoned") else new_id(a.event),
        "build": a.build,
        "kind": kind,
        "finished": finished,
        "now": now,
        "checks": checks,
        "source": "michael" if a.event == "ask" else "foreman",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if a.title:
        rec["title"] = a.title
    if cause:
        rec["cause"] = cause
    if a.event == "waiting":
        rec["question"] = WAITING_QUESTION
    if a.event == "ask":
        if not a.question:
            print("REFUSED: ask needs --question", file=sys.stderr)
            return 2
        rec["question"] = normalize_line(a.question)
    # An ask Michael writes by hand is held to the executor's standard: refuse
    # it here, while he can still rephrase, rather than fall back at render.
    errors, _ = validate(rec, strict_text=(a.event in ("ask", "waiting")))
    if errors:
        for e in errors:
            print(f"REFUSED: {e}", file=sys.stderr)
        return 2
    print(json.dumps(rec, ensure_ascii=False))
    return 0


def _probe(build):
    return {"v": VERSION, "id": "probe-0000", "build": build, "kind": "progress", "finished": "x", "now": "x"}


def cmd_latest(a):
    rec = latest_record(a.workdir)
    if rec:
        print(json.dumps(rec, ensure_ascii=False))
    return 0


def cmd_ask_block(_a):
    """needs_owner record on stdin → the executor-ask block fm_brief.py reads, so
    Michael's own envelope is DECISION REQUIRED, never 'no reply needed'. The
    executor declared the ask by writing the record; this only transcribes it."""
    rec = json.loads(sys.stdin.read())
    if rec.get("kind") != "needs_owner":
        return 0
    what = normalize_line(str(rec.get("question", "")))[:CAP_QUESTION]
    print("#FMASK1")
    print("kind: blocked")
    print(f"what: {what}")
    print("#FMASK-END")
    return 0


def cmd_selftest(a):
    fx = json.load(open(a.fixture, encoding="utf-8"))
    bad = 0
    for c in fx["cases"]:
        got = rail_hits(c["text"])
        if got != c["rails"]:
            bad += 1
            print(f"FAIL {c['text']!r}: got {got}, want {c['rails']}")
    seen = {r for c in fx["cases"] for r in c["rails"]}
    for rid, _ in TEXT_RAILS:
        if rid not in seen:
            bad += 1
            print(f"FAIL rail {rid} never exercised")
    print(f"rails parity: {len(fx['cases'])} cases, {bad} failures — {'OK' if not bad else 'FAILED'}")
    return 1 if bad else 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="fm_status.py", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    def fields(sp, kind_required=True):
        sp.add_argument("--kind", choices=KINDS, required=kind_required)
        sp.add_argument("--finished", required=True, help="one line: what is actually done")
        sp.add_argument("--now", required=True, help="one line: where it stands now")
        sp.add_argument("--checks", help="PASSED/TOTAL as measured, e.g. 41/41")
        sp.add_argument("--question", help="needs_owner only: exactly one question ending in ?")
        sp.add_argument("--cause", choices=CAUSES, help="failed only")

    e = sub.add_parser("emit")
    fields(e)
    e.add_argument("--dir", help="worktree (default: cwd)")
    f = sub.add_parser("forward")
    f.add_argument("--build", required=True)
    f.add_argument("--workdir", required=True)
    f.add_argument("--state", required=True, help="the build's foreman dir (cursor lives here)")
    f.add_argument("--title")
    m = sub.add_parser("make")
    fields(m)
    m.add_argument("--build", required=True)
    m.add_argument("--source", choices=("foreman", "michael"), required=True)
    m.add_argument("--id")
    m.add_argument("--title")
    fo = sub.add_parser("foreman")
    fo.add_argument("--build", required=True)
    fo.add_argument("--event", choices=tuple(FOREMAN_EVENTS), required=True)
    fo.add_argument("--workdir", help="the build's worktree, to carry the executor's last record")
    fo.add_argument("--title")
    fo.add_argument("--question", help="ask only")
    l = sub.add_parser("latest")
    l.add_argument("--workdir", required=True)
    sub.add_parser("ask-block")
    s = sub.add_parser("selftest")
    s.add_argument("--fixture", required=True)

    a = p.parse_args(argv)
    return {"emit": cmd_emit, "forward": cmd_forward, "make": cmd_make, "latest": cmd_latest,
            "ask-block": cmd_ask_block, "selftest": cmd_selftest, "foreman": cmd_foreman}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
