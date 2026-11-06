#!/usr/bin/env python3
"""fm_heartbeat — what the heartbeat owes each open build, decided in one place.

The rule: whenever a build is started, something keeps working in the
background to wake the supervisor, the builder (Tzali, Avi), or whoever needs
waking, until the build is completed.

The heartbeat used to be a dead-session detector: it noticed a dark build and
said so. It is now the OWNER of every open build. Each tick it asks, per build,
who is owed a wake — Michael, or the builder — and foreman_heartbeat.sh sends
it. This file only DECIDES. It reads the ledger, the executor's status file, the
transcript or rollout, and the pane; it writes nothing, sends nothing, and never
touches the network or a credential.

    fm_heartbeat.py plan   --build ID            -> "<action> [detail…]"
    fm_heartbeat.py budget --build ID --cause C [--spacing S] [--max N]
                                                 -> "wake K" | "escalate" | "quiet <why>"
    fm_heartbeat.py chain                        -> "stalled <build> <age_s> <next item>" | "none <why>"
    fm_heartbeat.py brief  --build ID            -> path of this build's composed brief (exit 1 if none)

plan actions, in the order they are checked (first match wins):
    died                       pane gone, no close recorded       -> mark failed, wake Michael
    close-pending <age_s>      pane gone, executor recorded closed -> NEVER mark failed; wake Michael to close
    resubmit <attempt>         lost start: launch-only ledger, empty composer, nothing ran -> re-send the brief
    lost-start <attempts>      the re-send did not take either     -> wake Michael
    recover-lost <kind> <age>  executor wrote closed/failed/needs_owner and no hook forwarded it
    held                       HOLD file: parked on purpose
    remind-needs-owner <min>   waiting on the owner: one reminder to Michael at 60 min, then every 6 h
    nudge <quiet_s>            working, but no transcript/pane change for N min -> "status?" to the builder
    dark <quiet_s> <why>       the nudge got no turn in 5 min (or could not be sent) -> wake Michael
    none <why>

Environment: BUILDS_DIR (required), FOREMAN_ROOT, QUEUE, FM_NOW (tests: the
clock), FM_CLAUDE_PROJECTS, CODEX_HOME, and the FM_HB_* thresholds below.
"""
import argparse
import glob
import importlib.util
import json
import os
import re
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "fm_wake_state", os.environ.get("FM_WAKE_STATE") or os.path.join(_HERE, "fm_wake_state.py"))
ws = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ws)


AHI_HOME = os.environ.get("FM_AHI_HOME") or os.environ.get("AHI_HOME") or os.path.expanduser("~/ahi")
FOREMAN_ROOT = os.environ.get("FOREMAN_ROOT") or os.path.join(AHI_HOME, "foreman")


def env_int(name, default):
    v = os.environ.get(name, "").strip()
    return int(v) if v.isdigit() else default


# ── thresholds (seconds) ─────────────────────────────────────────────────────
STALL_CLAUDE = env_int("FM_HB_STALL_CLAUDE", 1200)      # 20 min quiet → nudge
STALL_CODEX = env_int("FM_HB_STALL_CODEX", 1800)        # 30 min quiet → nudge
NUDGE_ANSWER = env_int("FM_HB_NUDGE_ANSWER", 300)       # no turn 5 min after a nudge → Michael
NUDGE_ECHO = 60                                         # the nudge's own keystrokes are not an answer
LOST_GRACE = env_int("FM_HB_LOST_GRACE", 300)           # a close record this old with no forward = lost wake
LOST_QUIET = env_int("FM_HB_LOST_QUIET", 120)           # …and the session has been quiet this long
LOST_START_AFTER = env_int("FM_HB_LOST_START_AFTER", 120)  # empty composer this long after launch
LAUNCH_GRACE = env_int("FM_HB_LAUNCH_GRACE", 300)       # no session + no `started` this soon after `created` = still launching
RESUBMIT_MAX = env_int("FM_HB_RESUBMIT_MAX", 1)         # re-sends before Michael is woken
NEEDS_OWNER_FIRST = env_int("FM_HB_NEEDS_OWNER_FIRST", 3600)
NEEDS_OWNER_EVERY = env_int("FM_HB_NEEDS_OWNER_EVERY", 21600)
CHAIN_AFTER = env_int("FM_HB_CHAIN_AFTER", 600)
CHAIN_LOOKBACK = env_int("FM_HB_CHAIN_LOOKBACK", 86400)
RATE_WINDOW = 3600
RATE_MAX = env_int("FM_HB_RATE_MAX", 3)                 # wakes per cause per hour

#: Written by build_start before and around the submit. A ledger holding only
#: these (plus wake plumbing that does not mean a turn ran) is a launch whose
#: brief may never have gone in.
LAUNCH = frozenset({"created", "gates", "gates-delivered", "tmux-server", "rc-url",
                    "rc-connected", "rc-missing", "auth-refreshed", "auth-fallback",
                    "submit-failed"})
#: Any one of these means the session was given work, or finished a turn.
NOT_LOST_START = frozenset({"started", "steer", "keys", "idle", "heartbeat-nudge"})
#: Acts only the foreman (Michael, or the owner at the keys) performs. One of them
#: starts a new episode: the per-cause attempt count and the escalation reset.
#: `ask` is deliberately absent — the heartbeat's own escalation writes one.
FOREMAN_ACTS = ("steer", "keys", "hold", "resume", "status:")
EXECUTOR_OWED = ("closed", "failed", "needs_owner")
SPINNER = re.compile(r"Working \([^)]*\)|esc to interrupt")


def now():
    return ws.now()


# ── readers ──────────────────────────────────────────────────────────────────
def executor_lines(meta):
    wd = meta.get("workdir") or ""
    try:
        with open(os.path.join(wd, ".foreman", "status.jsonl"), encoding="utf-8", errors="replace") as f:
            return f.read().split("\n")[:-1]   # complete lines only, as fm_status forward
    except OSError:
        return []


def parse_rec(raw):
    try:
        r = json.loads(raw)
    except ValueError:
        return None
    return r if isinstance(r, dict) and r.get("kind") else None


def rec_ts(rec, meta):
    t = ws.parse_iso(rec.get("at") or "")
    if t is not None:
        return t
    try:
        return int(os.stat(os.path.join(meta.get("workdir") or "", ".foreman", "status.jsonl")).st_mtime)
    except OSError:
        return now()


def cursor(build):
    v = ws.read_int(os.path.join(ws.bdir(build), "status.cursor"))
    return v or 0


def tmux(*args):
    try:
        return subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None


def pane_alive(meta):
    t = meta.get("tmux") or ""
    if not t:
        return False
    r = tmux("has-session", "-t", t)
    return r is not None and r.returncode == 0


def pane_text(meta):
    r = tmux("capture-pane", "-t", meta.get("tmux") or "", "-p")
    return r.stdout if r is not None and r.returncode == 0 else ""


def composer_state(text, runtime):
    """empty | full | none — the same reading as lib.sh fm_composer_state."""
    state = "none"
    for line in text.splitlines():
        t = line.lstrip()
        if t[:1] in ("❯", "›"):
            content = t[1:].replace(" ", " ").strip()
            empty = not content or (runtime == "codex" and content == "Ask Codex to do anything")
            state = "empty" if empty else "full"
    return state


def work_ts(build, meta):
    """Newest sign of life: transcript mtime or pane output, whichever is newer."""
    best = None
    t = ws.find_transcript(build, meta) if (meta.get("runtime") or "claude") != "codex" else None
    if t:
        try:
            best = int(os.stat(t).st_mtime)
        except OSError:
            pass
    pa = ws.pane_activity(meta)
    if pa is not None and (best is None or pa > best):
        best = pa
    return best


def codex_rollout_since(workdir, since):
    """Codex writes its rollout at the FIRST message (the file is created at
    the first steer, not at startup). So a rollout naming this workdir, written
    since launch, proves a brief went in."""
    home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    real = os.path.realpath(workdir)
    for path in glob.glob(os.path.join(home, "sessions", "**", "rollout-*.jsonl"), recursive=True):
        try:
            if os.stat(path).st_mtime < since:
                continue
            with open(path, errors="replace") as f:
                first = json.loads(f.readline())
        except (OSError, ValueError):
            continue
        payload = first.get("payload") if isinstance(first, dict) else None
        cwd = payload.get("cwd") if isinstance(payload, dict) else None
        if cwd and os.path.realpath(cwd) == real:
            return True
    return False


def hb_wakes(ev, cause, to=None):
    out = []
    for e in ev:
        if e.get("type") != "heartbeat-wake":
            continue
        d = e.get("detail") or ""
        if f"cause={cause} " not in d + " ":
            continue
        if to and f"to={to} " not in d + " ":
            continue
        out.append(e)
    return out


def episode_start(ev):
    t = 0
    for e in ev:
        ty = e.get("type", "")
        if any(ty == a or (a.endswith(":") and ty.startswith(a)) for a in FOREMAN_ACTS):
            t = e["ts"]
    return t


# ── plan ─────────────────────────────────────────────────────────────────────
def plan(build):
    meta = ws.read_meta(build)
    ev = ws.read_events(build)
    runtime = meta.get("runtime") or "claude"
    t = now()
    alive = pane_alive(meta)
    lines = executor_lines(meta)
    recs = [r for r in (parse_rec(x) for x in lines) if r]

    # 1. The session is gone. A recorded close is a finished build whose wake
    #    was lost, not a failure: reporting a finished build as failed is the
    #    worst message this file can cause.
    if not alive:
        # 1a. Still launching: build_start writes `created` and `gates`, then
        #     can spend a minute on a credential refresh and the /rc probe
        #     before `tmux new-session`. A tick in that window finds no session
        #     and would call a healthy build dead, sending the owner a false
        #     "Build failed". No `started` yet and a young
        #     record is a launch in progress, not a death. A launcher that truly
        #     crashed is still caught: the grace runs out and `died` fires.
        types = [e.get("type", "") for e in ev]
        if not any(x in NOT_LOST_START or x.startswith("status:") for x in types):
            created = min([e["ts"] for e in ev if e.get("type") == "created"]
                          or [meta.get("created") or 0])
            if created and t - created < LAUNCH_GRACE:
                return ("none", "launching")
        last_act = max([e["ts"] for e in ev if e.get("type") in ("steer", "keys")] or [0])
        if recs and recs[-1].get("kind") == "closed" and rec_ts(recs[-1], meta) >= last_act - ws.ACTIVITY_SLACK_S:
            return ("close-pending", str(max(0, t - rec_ts(recs[-1], meta))))
        return ("died",)

    # 2. Lost start. The launch logged its gates, then the brief never reached
    #    the composer.
    types = [e.get("type", "") for e in ev]
    if "created" in types and not any(x in NOT_LOST_START or x.startswith("status:") for x in types) and not recs:
        created = min(e["ts"] for e in ev if e.get("type") == "created")
        launch_last = max(e["ts"] for e in ev if e.get("type") in LAUNCH)
        tries = hb_wakes(ev, "resubmit", to="builder")
        ran = False
        if runtime == "codex":
            ran = codex_rollout_since(meta.get("workdir") or "", created - ws.ACTIVITY_SLACK_S)
        else:
            act = ws.transcript_activity(ws.find_transcript(build, meta))
            ran = act is not None and act >= created - ws.ACTIVITY_SLACK_S
        text = pane_text(meta)
        tail = "\n".join(text.splitlines()[-12:])
        if (not ran and not SPINNER.search(tail) and composer_state(text, runtime) == "empty"
                and t - launch_last >= LOST_START_AFTER
                and (not tries or t - tries[-1]["ts"] >= LOST_START_AFTER)):
            if len(tries) < RESUBMIT_MAX:
                return ("resubmit", str(len(tries) + 1))
            return ("lost-start", str(len(tries)))

    # 3. A close, failure or question the executor wrote that no hook forwarded.
    done = cursor(build)
    if done > len(lines):
        done = 0
    owed = [r for r in (parse_rec(x) for x in lines[done:]) if r and r.get("kind") in EXECUTOR_OWED]
    if owed:
        age = t - rec_ts(owed[-1], meta)
        wt = work_ts(build, meta)
        if age >= LOST_GRACE and (wt is None or t - wt >= LOST_QUIET):
            return ("recover-lost", owed[-1]["kind"], str(age))

    # 4. Parked on purpose.
    if os.path.exists(os.path.join(ws.bdir(build), "HOLD")):
        return ("held",)

    s = ws.compute_state(build)
    if s["state"] == "waiting" and not os.environ.get("FM_WAKE_DEFER_DISABLE"):
        # 5. Waiting on the owner: no storm. One reminder to Michael, then every 6 h.
        if s["asked"] or s["executor_needs_owner"]:
            since = max([s["turn_end"] or 0] + [e["ts"] for e in ev if e.get("type") == "ask"])
            sent = [e for e in hb_wakes(ev, "needs-owner") if e["ts"] >= since]
            gap = NEEDS_OWNER_EVERY if sent else NEEDS_OWNER_FIRST
            ref = sent[-1]["ts"] if sent else since
            if t - ref >= gap:
                return ("remind-needs-owner", str((t - since) // 60))
            return ("none", "waiting-on-owner")
        # Waiting on Michael belongs to the waiting ladder (fm_waiting_sweep).
        return ("none", "waiting-on-michael")

    # 6. Working, but silent. Ask the builder first; Michael only if it says nothing.
    wt = work_ts(build, meta)
    if wt is None:
        wt = max([e["ts"] for e in ev] or [t])
    quiet = t - wt
    nudges = hb_wakes(ev, "stall", to="builder")
    last = nudges[-1] if nudges else None
    if last and wt <= last["ts"] + NUDGE_ECHO:
        if "result=failed" in (last.get("detail") or ""):
            return ("dark", str(quiet), "nudge-not-delivered")
        if t - last["ts"] >= NUDGE_ANSWER:
            return ("dark", str(quiet), "nudge-unanswered")
        return ("none", "nudge-pending")
    if quiet >= (STALL_CODEX if runtime == "codex" else STALL_CLAUDE):
        return ("nudge", str(quiet))
    return ("none", "working")


def cmd_plan(a):
    print(" ".join(plan(a.build)))
    return 0


# ── budget: bounded, logged, never a storm ──────────────────────────────────
def budget(build, cause, spacing, max_attempts, no_escalate=False):
    ev = ws.read_events(build)
    t = now()
    start = episode_start(ev)
    tries = [e for e in hb_wakes(ev, cause) if e["ts"] >= start]
    if tries and spacing and t - tries[-1]["ts"] < spacing:
        return ("quiet", f"spacing {t - tries[-1]['ts']}s<{spacing}s")
    if max_attempts and len(tries) >= max_attempts:
        if no_escalate:
            return ("quiet", "handed-to-waiting-ladder")
        esc = [e for e in ev if e.get("type") == "heartbeat-escalate" and e["ts"] >= start
               and f"cause={cause} " in (e.get("detail") or "") + " "]
        return ("quiet", "escalated") if esc else ("escalate",)
    hour = [e for e in hb_wakes(ev, cause) if e["ts"] > t - RATE_WINDOW]
    if len(hour) >= RATE_MAX:
        return ("quiet", f"rate {len(hour)}/h")
    return ("wake", str(len(tries) + 1))


def cmd_budget(a):
    print(" ".join(budget(a.build, a.cause, a.spacing, a.max, a.no_escalate)))
    return 0


# ── chain: a done build, a runnable next item, and nothing launched ─────────
def queue_next():
    q = os.environ.get("QUEUE") or os.path.join(FOREMAN_ROOT, "QUEUE.md")
    try:
        with open(q, errors="replace") as f:
            for line in f:
                if re.match(r"^\s*-\s*\[\s\]", line):
                    return line.strip()
    except OSError:
        pass
    return ""


def chain():
    root = ws.builds_dir()
    t = now()
    active = 0
    closes, launches = [], []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return ("none", "no-registry")
    for n in names:
        if not os.path.isfile(os.path.join(root, n, "meta.json")):
            continue
        try:
            ev = ws.read_events(n)
        except SystemExit:
            continue
        status, st_ts = "active", None
        for e in ev:
            if e.get("type", "").startswith("status:"):
                status, st_ts = e["type"].split(":", 1)[1], e["ts"]
        if status == "active":
            active += 1
        elif status == "done" and st_ts is not None:
            closes.append((st_ts, n))
        first = min([e["ts"] for e in ev] or [ws.read_meta(n).get("created") or 0])
        launches.append(first)
    if active:
        return ("none", f"active={active}")
    closes = [c for c in closes if t - c[0] <= CHAIN_LOOKBACK]
    if not closes:
        return ("none", "no-recent-close")
    ts, bid = max(closes)
    if any(l > ts for l in launches):
        return ("none", "launched-since")
    if t - ts < CHAIN_AFTER:
        return ("none", f"young {t - ts}s")
    nxt = queue_next()
    if not nxt:
        return ("none", "queue-empty")
    return ("stalled", bid, str(t - ts), nxt)


def cmd_chain(_a):
    print(" ".join(chain()))
    return 0


def cmd_brief(a):
    """The brief build_start composed and gate-checked for THIS build: the
    meta.json prompt plus the active gates verbatim. The bare prompt
    carries no gate block, so it is never re-sent on its own."""
    meta = ws.read_meta(a.build)
    p = os.path.join(meta.get("workdir") or "", ".foreman", "BRIEF.txt")
    prompt = (meta.get("prompt") or "").strip()
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            body = f.read()
    except OSError:
        return 1
    if not prompt or prompt[:200] not in body:
        return 1   # a different build's brief (reused workdir) — never send it
    print(p)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("plan"); sp.add_argument("--build", required=True)
    sp = sub.add_parser("budget"); sp.add_argument("--build", required=True)
    sp.add_argument("--cause", required=True)
    sp.add_argument("--spacing", type=int, default=1200)
    sp.add_argument("--max", type=int, default=3, help="attempts per episode; 0 = no cap")
    sp.add_argument("--no-escalate", action="store_true",
                    help="past --max, go quiet: the waiting ladder owns the follow-up")
    sub.add_parser("chain")
    sp = sub.add_parser("brief"); sp.add_argument("--build", required=True)
    a = ap.parse_args(argv)
    return {"plan": cmd_plan, "budget": cmd_budget, "chain": cmd_chain, "brief": cmd_brief}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
