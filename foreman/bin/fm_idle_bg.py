#!/usr/bin/env python3
"""fm_idle_bg — is this Stop a FALSE IDLE (background shells still running)?

A build must run end to end without the owner. A common failure: the builder
launches long jobs as background shells (a dry run, npm test, a render) and ends
its turn to wait for them. Claude's Stop hook fires, the foreman reads "went
idle", wakes Michael, and the build sits until a human steers it ("wait in the
foreground, then finish"). Fixing that by hand over and over is exactly the
foreman's job, so the fix lives here.

    fm_idle_bg.py check --build ID --self PID   -> one JSON line:
        {"verdict": "none"|"skip-steer"|"skip"|"wake", "why": ..., "detail": ...,
         "shells": [{"pid", "etimes", "cmd"}], "pids": "1,2,3"}

    none        no background shell under the session's claude process: a real idle
    skip-steer  shells running, first time this episode: log, steer the builder once
                ("wait in the foreground, then finish"), do NOT wake Michael
    skip        shells running, same set, the builder's acknowledgement turn after the
                steer: log, do NOT wake Michael
    wake        shells running but Michael must see it anyway: the executor just wrote
                closed/failed/needs_owner (a real stop with a server left up), or the
                same shells survived the steer AND the ack turn (the builder is not
                following) — the normal wake goes out with `detail` as a note

Only the Stop-hook path calls this (never --deliver). Reads the ledger, meta,
the executor's status.jsonl, `ps` and the tmux pane pid; writes nothing.
Environment: BUILDS_DIR (required), FM_TMUX_SOCKET (optional), FM_NOW (tests).
"""
import argparse
import json
import os
import subprocess
import sys
import time

EXECUTOR_OWED = ("closed", "failed", "needs_owner")
EPISODE_START = ("steer", "keys", "started")
SNAPSHOT_MARK = "shell-snapshots"          # Claude's Bash tool: `bash -c source ~/.claude/shell-snapshots/…`
MIN_AGE_S = 2                              # a just-spawned sibling hook is not a background job
RECENT_RECORD_S = 900
DUP_WINDOW_S = 8                           # the twin hook entry runs within seconds of the first


def now():
    v = os.environ.get("FM_NOW", "").strip()
    return int(v) if v.isdigit() else int(time.time())


def bdir(build):
    return os.path.join(os.environ["BUILDS_DIR"], build)


def read_meta(build):
    with open(os.path.join(bdir(build), "meta.json"), encoding="utf-8") as f:
        return json.load(f)


def read_events(build):
    out = []
    try:
        with open(os.path.join(bdir(build), "events.jsonl"), encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and "ts" in e:
                    out.append(e)
    except OSError:
        pass
    return out


def tmux_pane_pid(session):
    cmd = ["tmux"]
    sock = os.environ.get("FM_TMUX_SOCKET", "").strip()
    if sock:
        cmd += ["-L", sock]
    cmd += ["list-panes", "-t", session, "-F", "#{pane_pid}"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    for tok in r.stdout.split():
        if tok.isdigit():
            return int(tok)
    return None


def ps_table():
    try:
        r = subprocess.run(["ps", "-e", "-o", "pid=,ppid=,etimes=,args="], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return {}
    rows = {}
    for line in r.stdout.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 3 or not parts[0].isdigit():
            continue
        rows[int(parts[0])] = {
            "ppid": int(parts[1]) if parts[1].isdigit() else 0,
            "etimes": int(parts[2]) if parts[2].isdigit() else 0,
            "args": parts[3] if len(parts) > 3 else "",
        }
    return rows


def ancestors(pid, rows):
    seen = set()
    while pid and pid not in seen and pid in rows:
        seen.add(pid)
        pid = rows[pid]["ppid"]
    return seen


def background_shells(claude_pid, self_pid, rows):
    mine = ancestors(self_pid, rows)
    out = []
    for pid, r in rows.items():
        if r["ppid"] != claude_pid or pid in mine:
            continue
        if SNAPSHOT_MARK not in r["args"] or "foreman_wake" in r["args"]:
            continue
        if r["etimes"] < MIN_AGE_S:
            continue
        # The shell is `bash -c source <snapshot> …; eval …`: name it by its busiest child.
        kids = [k for k, kr in rows.items() if kr["ppid"] == pid]
        cmd = rows[kids[0]]["args"] if kids else r["args"]
        out.append({"pid": pid, "etimes": r["etimes"], "cmd": cmd[:120]})
    out.sort(key=lambda s: s["pid"])
    return out


def recent_executor_record(meta, t):
    p = os.path.join(meta.get("workdir") or "", ".foreman", "status.jsonl")
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            lines = [x for x in f.read().split("\n")[:-1] if x.strip()]
        mtime = int(os.stat(p).st_mtime)
    except OSError:
        return None
    for raw in reversed(lines):
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("kind") in EXECUTOR_OWED:
            return rec.get("kind") if t - mtime <= RECENT_RECORD_S else None
        return None
    return None


def episode_events(ev):
    start = 0
    for e in ev:
        if e.get("type") in EPISODE_START or str(e.get("type", "")).startswith("status:"):
            start = e["ts"]
    return [e for e in ev if e["ts"] > start or (start == 0)]


def prior_pidsets(ev):
    sets = []
    for e in ev:
        if e.get("type") != "idle-background":
            continue
        d = e.get("detail") or ""
        for tok in d.split():
            if tok.startswith("pids="):
                sets.append(tok[5:])
    return sets


def check(build, self_pid):
    t = now()
    meta = read_meta(build)
    rows = ps_table()
    claude_pid = tmux_pane_pid(meta.get("tmux") or "")
    shells = background_shells(claude_pid, self_pid, rows) if claude_pid else []
    pids = ",".join(str(s["pid"]) for s in shells)
    base = {"shells": shells, "pids": pids}
    if not shells:
        return {**base, "verdict": "none", "why": "no-background-shells", "detail": ""}
    names = "; ".join(f"{s['cmd']} ({s['etimes']}s)" for s in shells)
    detail = f"{len(shells)} background shell(s) still running pids={pids} — {names}"
    kind = recent_executor_record(meta, t)
    if kind:
        return {**base, "verdict": "wake", "why": f"executor-{kind}",
                "detail": f"{detail}; the executor wrote `{kind}`, so this is a real stop with a job or server left up"}
    ev = read_events(build)
    # The worktree settings list the Stop hook twice (both foreman paths resolve
    # to this script), so every Stop runs it twice: the second runner must not
    # log or steer again.
    last_bg = [e for e in ev if e.get("type") == "idle-background"]
    if last_bg and t - last_bg[-1]["ts"] <= DUP_WINDOW_S and f"pids={pids}" in (last_bg[-1].get("detail") or ""):
        return {**base, "verdict": "dup", "why": "twin-hook-run", "detail": detail}
    prior = prior_pidsets(episode_events(ev))
    same = sum(1 for p in prior if p == pids)
    if not prior:
        return {**base, "verdict": "skip-steer", "why": "first-false-idle", "detail": detail}
    if same <= 1:
        return {**base, "verdict": "skip", "why": "ack-turn-after-steer" if same == 1 else "new-shell-set", "detail": detail}
    return {**base, "verdict": "wake", "why": "shells-survived-steer",
            "detail": f"{detail}; the builder ended its turn {same + 1} times with the same shells after the foreground steer"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("check")
    sp.add_argument("--build", required=True)
    sp.add_argument("--self", type=int, default=os.getpid())
    a = ap.parse_args(argv)
    try:
        res = check(a.build, a.self)
    except Exception as exc:  # the hook must never die on this: no verdict = normal wake
        res = {"verdict": "none", "why": f"error:{type(exc).__name__}", "detail": "", "shells": [], "pids": ""}
    print(json.dumps(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
