#!/usr/bin/env python3
"""fm_codex_rollout — record which Codex rollout file is this build's.

A UI can show a Codex build live by tailing its rollout JSONL
($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl). Codex creates that
file only when the first message is submitted, so build_start cannot know the
path at launch. This helper runs in the background right after the
"started" event, waits (bounded) for the file, and appends ONE event:

    {"ts": ..., "type": "codex-rollout", "detail": "session=<id> path=<path>"}

A reader should prefer that event over its own discovery. Identity rule — the same
one foreman_codex_notify.sh's fm1_thread_state already trusts: session_meta.cwd
is the build's workdir, written by the interactive TUI (not `codex exec`, not a
sub-agent thread), created no earlier than the build. Earliest match wins; the
workdir lock means one build per folder at a time.

Reads meta.json and the FIRST LINE of candidate rollouts only. Prints paths and
ids, never content. Never fails the build: every exit is 0 except usage errors.

  fm_codex_rollout.py record <build-id> [--timeout S]   wait, then append the event (idempotent)
  fm_codex_rollout.py find <build-id>                   print the match, or nothing
"""
import calendar
import json
import os
import sys
import time

AHI_HOME = os.environ.get("FM_AHI_HOME") or os.environ.get("AHI_HOME") or os.path.expanduser("~/ahi")
FOREMAN_ROOT = os.environ.get("FOREMAN_ROOT") or os.path.join(AHI_HOME, "foreman")
BUILDS_DIR = os.environ.get("BUILDS_DIR") or os.path.join(FOREMAN_ROOT, "builds")
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
SLACK = 120  # seconds of clock slack between the build's `created` and Codex's session timestamp
DAY = 86400


def first_line(path, limit=512 * 1024):
    try:
        with open(path, "rb") as fh:
            line = fh.readline(limit)
        return line.decode("utf-8", "replace") if line.endswith(b"\n") else None
    except OSError:
        return None


def same_dir(a, b):
    if not a or not b:
        return False
    if a.rstrip("/") == b.rstrip("/"):
        return True
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def match_meta(head, workdir):
    try:
        row = json.loads(head)
    except ValueError:
        return None
    if row.get("type") != "session_meta" or not isinstance(row.get("payload"), dict):
        return None
    p = row["payload"]
    if not same_dir(str(p.get("cwd", "")), workdir):
        return None
    if p.get("originator") == "codex_exec" or p.get("source") == "exec":
        return None
    if p.get("thread_source") not in (None, "user"):  # null on app-server API threads
        return None
    if "source" in p and not isinstance(p["source"], str):  # {"subagent": ...}
        return None
    return p.get("id") if isinstance(p.get("id"), str) else None


def name_time(name):
    # rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl
    try:
        stamp = name[len("rollout-"):len("rollout-") + 19]
        return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H-%M-%S"))
    except (ValueError, OverflowError):
        return None


def day_dirs(root, start, end):
    out = []
    t = start - DAY
    while t <= end + DAY:
        d = time.gmtime(t)
        p = os.path.join(root, "%04d" % d.tm_year, "%02d" % d.tm_mon, "%02d" % d.tm_mday)
        if p not in out:
            out.append(p)
        t += DAY
    return out


def read_meta(build_id):
    with open(os.path.join(BUILDS_DIR, build_id, "meta.json"), encoding="utf-8") as fh:
        return json.load(fh)


def find(build_id, now=None):
    meta = read_meta(build_id)
    workdir = meta.get("workdir") or ""
    created = int(meta.get("created") or 0)
    if not workdir or not created:
        return None
    now = int(now if now is not None else time.time())
    root = os.path.join(CODEX_HOME, "sessions")
    best = None
    for d in day_dirs(root, created - SLACK, now):
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for n in names:
            if not (n.startswith("rollout-") and n.endswith(".jsonl")):
                continue
            t = name_time(n)
            if t is None or t < created - SLACK or t > now + SLACK:
                continue
            if best and t >= best[0]:
                continue
            path = os.path.join(d, n)
            head = first_line(path)
            sid = match_meta(head, workdir) if head else None
            if sid:
                best = (t, sid, path)
    return {"session": best[1], "path": best[2]} if best else None


def already_recorded(events_path):
    try:
        with open(events_path, encoding="utf-8") as fh:
            return any('"codex-rollout"' in line for line in fh)
    except OSError:
        return False


def record(build_id, timeout):
    events = os.path.join(BUILDS_DIR, build_id, "events.jsonl")
    if already_recorded(events):
        return 0
    deadline = time.time() + timeout
    while True:
        try:
            m = find(build_id)
        except (OSError, ValueError):
            m = None
        if m:
            with open(events, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"ts": int(time.time()), "type": "codex-rollout", "detail": "session=%s path=%s" % (m["session"], m["path"])}) + "\n")
            return 0
        if time.time() >= deadline:
            try:
                with open(events, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"ts": int(time.time()), "type": "codex-rollout-missing", "detail": "no rollout for this workdir within %ss; readers fall back to discovery" % int(timeout)}) + "\n")
            except OSError:
                pass
            return 0
        time.sleep(1)


def main(argv):
    if len(argv) < 3 or argv[1] not in ("record", "find"):
        sys.stderr.write(__doc__)
        return 2
    build_id = argv[2]
    if "/" in build_id or build_id.startswith("."):
        sys.stderr.write("bad build id\n")
        return 2
    if argv[1] == "find":
        try:
            m = find(build_id)
        except (OSError, ValueError):
            m = None
        if m:
            print("session=%s path=%s" % (m["session"], m["path"]))
        return 0
    timeout = 120
    if "--timeout" in argv:
        timeout = int(argv[argv.index("--timeout") + 1])
    return record(build_id, timeout)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
