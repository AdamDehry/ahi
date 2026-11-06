#!/usr/bin/env python3
"""fm_wake_state — what a build is doing, and the per-build pending wake slot.

Wake collisions: when two builds finish close together, every wake toward
Michael after the first can be dropped as "another wake in flight"; nothing
re-fires, and an hour later the dark detector tells the owner both builds
"went dark" when they were simply waiting. This file is the one place that
answers the three questions that failure turns on:

  1. Is this build WORKING or DONE-WAITING?            (`state`)
     Idle or awaiting-input is waiting, not dark. Only a session that is silent
     while supposedly working can go dark.
  2. Has Michael been waiting too long to answer it?   (`sweep-decide`)
     Bounded re-wakes, then the owner hears "waiting on Michael" — never "went dark".
  3. Where does a wake go when it cannot be sent now?  (`slot-*`)
     Into ONE durable slot per build. N held wakes for a build collapse into
     one; the message is rendered when it is DELIVERED, so it carries the latest
     state, not the state at the moment it was held. One build's slot can never
     absorb another build's wake: the slot lives in that build's own directory.

Read-only except for the slot files and their lock, all inside
$BUILDS_DIR/<build>/. Never touches the network, a credential, tmux or a pane.

    fm_wake_state.py state        --build ID [--field NAME]
    fm_wake_state.py sweep-decide --build ID          -> none … | rewake K N | tell-owner K N
    fm_wake_state.py sweep-all                        -> "<build> rewake|tell-owner K N" per build to act on
    fm_wake_state.py reminder     --build ID          -> reported | stale | unreported
    fm_wake_state.py slot-put     --build ID --kind idle|permission|waiting|owed
                                  --origin WHO --reason WHY
                                  [--transcript PATH] [--note TEXT] [--rewake K/N]
    fm_wake_state.py slot-claim   --build ID          -> claim path, or nothing
    fm_wake_state.py slot-restore --build ID --claim PATH
    fm_wake_state.py slot-check   --build ID --claim PATH -> deliver|covered|stale|inactive <why>
    fm_wake_state.py slot-field   --claim PATH --key K
    fm_wake_state.py slots                            -> "<first_ts> <build>" per pending slot, oldest first
                                                         (and restores a claim orphaned by a killed drain)
    fm_wake_state.py preamble     --build ID --claim PATH

Environment: BUILDS_DIR (required), FM_NOW (tests: the clock),
FM_CLAUDE_PROJECTS (default ~/.claude/projects), FM_WAITING_REWAKE_AFTER (600),
FM_WAITING_MAX_REWAKES (2).
"""
import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

# ── event vocabulary (foreman ledger types) ───────────────────────────────────
#: The session's turn ended, or it is blocked on input: it is waiting.
TURN_END = frozenset({
    "idle",                      # claude Stop hook
    "awaiting",                  # claude Notification hook (permission or idle reminder)
    "poll-wake",                 # codex: fm_stop_watch.sh saw the idle composer
    "codex-main-notify",         # codex: main-thread notify
    "codex-notify-unsuppressed",
    "codex-wake-retry-fire",
    "codex-wake-retry-cap",
    # heartbeat-owner: the heartbeat found a turn end whose own
    # hook was lost — an executor close record nobody forwarded, or a session
    # that is gone with its close recorded. Same meaning as a Stop hook.
    "heartbeat-recovered",
    "heartbeat-close-pending",
})
#: Something was typed into the session: it is working again.
WORK_START = frozenset({"started", "steer", "keys",
                        # heartbeat-owner: text the heartbeat typed into the
                        # session (a "status?" nudge, a lost brief re-sent).
                        "heartbeat-nudge", "heartbeat-resubmit"})
#: A wake for this build was handed to Michael (or durably queued for him).
WAKE_SENT = frozenset({"wake", "awaiting-wake", "poll-wake"})
#: Michael asked the owner about this build: it is waiting on the owner, not on Michael.
ASKED = frozenset({"ask"})
REWAKE = "waiting-rewake"
TOLD = "waiting-on-michael"

#: Claude Code's idle reminder fires ~60s after a turn ends. One that lands
#: within this many seconds of a steer is about the turn BEFORE the steer.
IDLE_PROMPT_STALE_S = 60
IDLE_PROMPT_RE = re.compile(r"waiting for your input", re.I)
#: The Stop hook writes its event a moment after the last transcript line.
ACTIVITY_SLACK_S = 5
#: Transcript entry types that mean the session did something.
ACTIVITY_TYPES = frozenset({"user", "assistant", "queue-operation"})
TAIL_BYTES = 256 * 1024

#: owed — the heartbeat decided someone owes this build an answer. Its reason
#: is the message; it is never "covered".
KINDS = ("idle", "permission", "waiting", "owed")
SLOT = "wake.pending"


def now():
    v = os.environ.get("FM_NOW", "").strip()
    return int(v) if v.isdigit() else int(time.time())


def builds_dir():
    d = os.environ.get("BUILDS_DIR")
    if not d:
        sys.exit("fm_wake_state: BUILDS_DIR is not set")
    return d


def bdir(build):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,120}", build or ""):
        sys.exit(f"fm_wake_state: bad build id {build!r}")
    return os.path.join(builds_dir(), build)


def read_events(build):
    out = []
    try:
        with open(os.path.join(bdir(build), "events.jsonl"), errors="replace") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and isinstance(e.get("ts"), int):
                    out.append(e)
    except FileNotFoundError:
        pass
    return out


def read_meta(build):
    try:
        with open(os.path.join(bdir(build), "meta.json")) as f:
            m = json.load(f)
        return m if isinstance(m, dict) else {}
    except (OSError, ValueError):
        return {}


def read_int(path):
    try:
        with open(path) as f:
            v = f.read().strip()
        return int(v) if v.isdigit() else None
    except OSError:
        return None


# ── transcript: the one signal that says the model actually did something ────
def claude_slug(workdir):
    # Claude Code names a project dir by replacing every non-alphanumeric
    # character with "-". A naive `sed 's|/|-|g'` keeps "_" and ".", so for any
    # workdir containing them it looks in a directory that does not exist.
    return re.sub(r"[^A-Za-z0-9]", "-", workdir)


def find_transcript(build, meta):
    p = os.path.join(bdir(build), "transcript.path")
    try:
        with open(p) as f:
            t = f.read().strip()
        if t and os.path.isfile(t):
            return t
    except OSError:
        pass
    wd = meta.get("workdir") or ""
    if not wd:
        return None
    root = os.environ.get("FM_CLAUDE_PROJECTS") or os.path.expanduser("~/.claude/projects")
    best, best_m = None, -1
    for slug in dict.fromkeys((claude_slug(wd), wd.replace("/", "-"))):
        d = os.path.join(root, slug)
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for n in names:
            if not n.endswith(".jsonl"):
                continue
            fp = os.path.join(d, n)
            try:
                m = os.stat(fp).st_mtime
            except OSError:
                continue
            if m > best_m:
                best, best_m = fp, m
    return best


def parse_iso(s):
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except (ValueError, AttributeError):
        return None


def transcript_activity(path):
    """Newest timestamp of a user/assistant/queue entry, from the file's tail.
    Metadata lines (cost-state, bridge-session, …) carry no timestamp and are
    ignored: they touch the file's mtime without meaning the model did anything,
    which is why mtime is not used here."""
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            chunk = f.read()
    except OSError:
        return None
    lines = chunk.split(b"\n")
    if size > TAIL_BYTES:
        lines = lines[1:]  # first line is partial
    best = None
    for raw in lines:
        if not raw.strip():
            continue
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(e, dict) or e.get("type") not in ACTIVITY_TYPES:
            continue
        ts = parse_iso(e.get("timestamp") or "")
        if ts is not None and (best is None or ts > best):
            best = ts
    return best


def pane_activity(meta):
    """tmux's last-output time for the build's pane — the only liveness signal a
    codex build (no Claude transcript) has. WEAK: a redraw counts as output, so
    it may only ever make a build look busier. It is used to hold back a re-wake,
    never to discard a held wake (see slot-check)."""
    target = meta.get("tmux") or ""
    if not target:
        return None
    try:
        out = subprocess.run(["tmux", "display-message", "-p", "-t", target, "#{window_activity}"],
                             capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return int(out) if out.isdigit() and int(out) > 0 else None


def executor_needs_owner(meta, since):
    """True when the executor's latest record is a needs_owner written at or
    after `since`: the owner was asked directly, so the build waits on the owner."""
    wd = meta.get("workdir") or ""
    try:
        with open(os.path.join(wd, ".foreman", "status.jsonl"), errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return False
    for raw in reversed(lines):
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(rec, dict) or "kind" not in rec:
            continue
        if rec.get("kind") != "needs_owner":
            return False
        at = parse_iso(rec.get("at") or "")
        return at is None or since is None or at >= since - ACTIVITY_SLACK_S
    return False


# ── state ────────────────────────────────────────────────────────────────────
def compute_state(build):
    d = bdir(build)
    meta = read_meta(build)
    ev = read_events(build)
    status = "active"
    for e in ev:
        t = e.get("type", "")
        if t.startswith("status:"):
            status = t.split(":", 1)[1]
    work_start = turn_end = None
    last_ws = None
    for e in ev:
        t, ts = e.get("type", ""), e["ts"]
        if t in WORK_START:
            last_ws = ts
            work_start = ts
        elif t in TURN_END:
            if (t == "awaiting" and IDLE_PROMPT_RE.search(e.get("detail") or "")
                    and last_ws is not None and ts - last_ws < IDLE_PROMPT_STALE_S):
                continue  # reminder about the turn before the steer
            turn_end = ts
    runtime = meta.get("runtime") or "claude"
    live = status == "active" and not os.path.exists(os.path.join(d, "HOLD"))
    transcript = find_transcript(build, meta) if (live and runtime != "codex") else None
    activity = transcript_activity(transcript)
    source = "transcript" if activity is not None else None
    lock_ts = read_int(os.path.join(d, "wake.lock"))
    held = os.path.exists(os.path.join(d, "HOLD"))
    working_by = None
    if status != "active":
        state = "inactive"
    elif held:
        state = "held"
    elif turn_end is None or (work_start is not None and turn_end < work_start):
        state, working_by = "working", "event"
    elif activity is not None and activity > turn_end + ACTIVITY_SLACK_S:
        # it did something after its turn ended (the owner typed, or a steer landed)
        state, working_by = "working", "transcript"
    else:
        state = "waiting"
        if transcript is None:
            pa = pane_activity(meta)
            if pa is not None and pa > turn_end + ACTIVITY_SLACK_S:
                state, working_by, source, activity = "working", "pane", "pane", pa
    after = turn_end if turn_end is not None else 0
    wakes = [e["ts"] for e in ev if e.get("type") in WAKE_SENT and e["ts"] >= after]
    rewakes = [e["ts"] for e in ev if e.get("type") == REWAKE and e["ts"] >= after]
    return {
        "build": build,
        "state": state,
        "status": status,
        "runtime": runtime,
        "work_start": work_start,
        "turn_end": turn_end,
        "activity": activity,
        "activity_source": source,
        "working_by": working_by,
        "transcript": transcript,
        "lock_ts": lock_ts,
        "last_contact": max([after] + wakes + rewakes) if turn_end is not None else None,
        "rewakes": len(rewakes),
        "told": any(e.get("type") == TOLD and e["ts"] >= after for e in ev),
        "asked": any(e.get("type") in ASKED and e["ts"] >= after for e in ev),
        "executor_needs_owner": (state == "waiting" and executor_needs_owner(meta, work_start)),
        "pending": os.path.exists(os.path.join(d, SLOT)),
        "held": held,
    }


def cmd_state(a):
    s = compute_state(a.build)
    if a.field:
        v = s.get(a.field)
        print("" if v is None else v)
    else:
        print(json.dumps(s, sort_keys=True))
    return 0


def cmd_reminder(a):
    """Claude Code's idle reminder ("Claude is waiting for your input") fires
    ~60s after a turn ends. It is not a new state. reported — the Stop hook
    already reported this turn end (Michael was woken, or the wake is held);
    stale — it is about the turn before the latest steer; unreported — no Stop
    report exists for this turn end, so this reminder is the only signal."""
    ev = read_events(a.build)
    t = now()
    last_ws = last_idle = None
    for e in ev:
        if e.get("type") in WORK_START:
            last_ws = e["ts"]
        elif e.get("type") == "idle":
            last_idle = e["ts"]
    if last_ws is not None and t - last_ws < IDLE_PROMPT_STALE_S and (last_idle is None or last_idle < last_ws):
        print("stale")
    elif last_idle is not None and (last_ws is None or last_idle >= last_ws):
        print("reported")
    else:
        print("unreported")
    return 0


def rewake_after():
    return int(os.environ.get("FM_WAITING_REWAKE_AFTER") or 600)


def max_rewakes():
    return int(os.environ.get("FM_WAITING_MAX_REWAKES") or 2)


def decide(build):
    """(act, a, b) — none | rewake K N | tell-owner K N: the waiting-on-Michael ladder."""
    s = compute_state(build)
    if s["state"] != "waiting" or s["asked"] or s["executor_needs_owner"]:
        return ("none", s["state"] if s["state"] != "waiting" else "waiting-on-owner", "")
    age = now() - s["last_contact"]
    if age < rewake_after():
        return ("none", f"waiting {age}s", "")
    n = max_rewakes()
    if s["rewakes"] < n:
        return ("rewake", str(s["rewakes"] + 1), str(n))
    if not s["told"]:
        return ("tell-owner", str(s["rewakes"]), str(n))
    return ("none", "already-told", "")


def cmd_sweep_decide(a):
    print(" ".join(x for x in decide(a.build) if x))
    return 0


def cmd_sweep_all(a):
    """One process per cron tick, not one per build: every active, un-held
    build whose ladder says act, as "<build> <act> K N"."""
    root = builds_dir()
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return 0
    for n in names:
        d = os.path.join(root, n)
        if not os.path.isfile(os.path.join(d, "meta.json")) or os.path.exists(os.path.join(d, "HOLD")):
            continue
        try:
            act, x, y = decide(n)
        except SystemExit:
            continue
        if act != "none":
            print(n, act, x, y)
    return 0


# ── the slot ─────────────────────────────────────────────────────────────────
def lock(build):
    fd = os.open(os.path.join(bdir(build), SLOT + ".lock"), os.O_CREAT | os.O_RDWR, 0o664)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def read_slot(path):
    out = {}
    try:
        with open(path, errors="replace") as f:
            for line in f:
                k, sep, v = line.rstrip("\n").partition("=")
                if sep:
                    out[k] = v
    except OSError:
        return None
    return out


def write_slot(path, slot):
    tmp = f"{path}.part.{os.getpid()}"
    with open(tmp, "w") as f:
        for k in ("v", "build", "kind", "first_ts", "last_ts", "count", "origin", "reason",
                  "transcript", "note", "rewake"):
            v = str(slot.get(k, "")).replace("\n", " ")
            f.write(f"{k}={v}\n")
    os.replace(tmp, path)


def merge(old, new):
    """Collapse two pending wakes for ONE build into one. The newest signal names
    the kind, except that an idle reminder never downgrades a pending permission
    dialog or a waiting re-wake; first_ts keeps the oldest so the age is honest."""
    if not old:
        return new
    out = dict(old)
    out["count"] = int(old.get("count") or 1) + int(new.get("count") or 1)
    out["first_ts"] = min(int(old.get("first_ts") or new["first_ts"]), int(new["first_ts"]))
    out["last_ts"] = max(int(old.get("last_ts") or 0), int(new.get("last_ts") or 0))
    rank = {"idle": 0, "owed": 1, "permission": 2, "waiting": 3}
    newer_is_real_turn_end = new.get("origin", "").startswith("stop-hook")
    if rank.get(new.get("kind"), 0) >= rank.get(old.get("kind"), 0) or newer_is_real_turn_end:
        out["kind"] = new.get("kind")
        out["origin"] = new.get("origin", "")
        out["reason"] = new.get("reason", "")
        out["note"] = new.get("note", "")
    if new.get("rewake"):
        out["rewake"] = new["rewake"]
        out["kind"] = "waiting"
    if out.get("kind") != "waiting":
        out["rewake"] = ""
    if new.get("transcript"):
        out["transcript"] = new["transcript"]
    return out


def cmd_slot_put(a):
    d = bdir(a.build)
    if not os.path.isdir(d):
        return 1
    t = now()
    new = {"v": 1, "build": a.build, "kind": a.kind, "first_ts": t, "last_ts": t, "count": 1,
           "origin": a.origin, "reason": a.reason, "transcript": a.transcript or "",
           "note": (a.note or "")[:300], "rewake": a.rewake or ""}
    fd = lock(a.build)
    try:
        path = os.path.join(d, SLOT)
        slot = merge(read_slot(path), new)
        write_slot(path, slot)
    finally:
        os.close(fd)
    print(slot["count"])
    return 0


def cmd_slot_claim(a):
    d = bdir(a.build)
    fd = lock(a.build)
    try:
        path = os.path.join(d, SLOT)
        if not os.path.exists(path):
            return 0
        claim = f"{path}.claim.{os.getpid()}"
        os.replace(path, claim)
    finally:
        os.close(fd)
    print(claim)
    return 0


def cmd_slot_restore(a):
    """Undelivered: put the claim back, merged with anything that arrived since."""
    d = bdir(a.build)
    fd = lock(a.build)
    try:
        path = os.path.join(d, SLOT)
        held = read_slot(a.claim)
        if held is None:
            return 0
        newer = read_slot(path)
        write_slot(path, merge(held, newer) if newer else held)
        os.unlink(a.claim)
    finally:
        os.close(fd)
    return 0


def cmd_slot_field(a):
    s = read_slot(a.claim) or {}
    print(s.get(a.key, ""))
    return 0


ORPHAN_CLAIM_S = 600


def recover_orphans(build):
    """A drain killed mid-delivery leaves its claim behind and the slot empty.
    Past ORPHAN_CLAIM_S (no delivery takes that long) put it back, merged."""
    d = bdir(build)
    try:
        names = [n for n in os.listdir(d) if n.startswith(SLOT + ".claim.")]
    except OSError:
        return
    for n in names:
        p = os.path.join(d, n)
        try:
            if time.time() - os.stat(p).st_mtime < ORPHAN_CLAIM_S:
                continue
        except OSError:
            continue
        fd = lock(build)
        try:
            held, newer = read_slot(p), read_slot(os.path.join(d, SLOT))
            if held is not None:
                write_slot(os.path.join(d, SLOT), merge(held, newer) if newer else held)
            os.unlink(p)
        finally:
            os.close(fd)


def cmd_slots(a):
    rows = []
    root = builds_dir()
    try:
        names = os.listdir(root)
    except OSError:
        return 0
    for n in names:
        if os.path.isfile(os.path.join(root, n, "meta.json")):
            recover_orphans(n)
        s = read_slot(os.path.join(root, n, SLOT))
        if s is None:
            continue
        ft = s.get("first_ts", "")
        rows.append((int(ft) if ft.isdigit() else 0, n))
    for ft, n in sorted(rows):
        print(ft, n)
    return 0


def cmd_slot_check(a):
    """At delivery, re-ask whether this held wake still says anything true.
    deliver — yes. covered — the last wake handed to Michael was rendered after
    the newest thing the session did, so it already said this (duplicate hooks,
    a reminder of a turn end Michael was already told about). stale — the session
    is working again; its next turn end reports. inactive — closed."""
    s = compute_state(a.build)
    slot = read_slot(a.claim) or {}
    kind = slot.get("kind", "idle")
    if s["status"] != "active":
        print("inactive", s["status"])
        return 0
    if s["state"] == "held":
        print("stale", "held")
        return 0
    if kind == "owed":
        # The heartbeat already decided this is owed, from the same ledger, a
        # moment ago. Only a close or a deliberate HOLD (above) cancels it.
        print("deliver", "owed")
        return 0
    if kind == "waiting" and (s["asked"] or s["executor_needs_owner"]):
        print("stale", "waiting-on-owner")
        return 0
    if s["state"] == "working" and (s["working_by"] != "pane" or kind == "waiting"):
        print("stale", f"session-working ({s['working_by']})")
        return 0
    lock_ts, act = s["lock_ts"], s["activity"]
    if (kind != "waiting" and s["activity_source"] == "transcript" and lock_ts is not None and act is not None
            and lock_ts >= act and (s["work_start"] is None or lock_ts >= s["work_start"])):
        print("covered", f"last-wake={lock_ts} activity={act}")
        return 0
    print("deliver", s["state"])
    return 0


def cmd_preamble(a):
    """The lines that ride at the top of a deferred or re-wake idle report.
    Plain, short, and true at delivery time."""
    s = compute_state(a.build)
    slot = read_slot(a.claim) or {}
    t = now()
    first = int(slot.get("first_ts") or t)
    held_s = max(0, t - first)
    count = int(slot.get("count") or 1)
    kind = slot.get("kind", "idle")
    out = []
    if kind == "waiting":
        k, _, n = (slot.get("rewake") or "1/2").partition("/")
        mins = (t - s["turn_end"]) // 60 if s.get("turn_end") else None
        since = f"{mins} min ago" if mins is not None else "a while ago"
        out.append(f"WAITING ON MICHAEL — re-wake {k} of {n}. This build's session ended its turn {since} "
                   "and is waiting for its supervisor. No foreman act has followed the last wake: "
                   "no say, keys, close, hold or ask. It is still open.")
        out.append("Act on it now: send its next order, close it, ask the owner, or park it on purpose "
                   "by writing a one-line reason to its HOLD file. "
                   f"After re-wake {n}, the owner is told this build is waiting on Michael.")
    elif kind == "owed":
        why = slot.get("reason") or "this build is owed an answer"
        extra = f" ({count} heartbeat signals collapsed into this one)" if count > 1 else ""
        out.append(f"FOREMAN HEARTBEAT — {why}{extra}. The report below was read at delivery, so it is current.")
    else:
        why = slot.get("reason") or "another wake was in flight"
        extra = f"; {count} signals for this build collapsed into this one" if count > 1 else ""
        out.append(f"(Deferred wake — held {held_s}s because {why}{extra}. "
                   "Nothing was dropped. The report below was read at delivery, so it is current.)")
    print("\n".join(out))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("state", "sweep-decide", "reminder"):
        sp = sub.add_parser(name)
        sp.add_argument("--build", required=True)
        if name == "state":
            sp.add_argument("--field", default="")
    sp = sub.add_parser("slot-put")
    sp.add_argument("--build", required=True)
    sp.add_argument("--kind", choices=KINDS, required=True)
    sp.add_argument("--origin", required=True)
    sp.add_argument("--reason", default="")
    sp.add_argument("--transcript", default="")
    sp.add_argument("--note", default="")
    sp.add_argument("--rewake", default="")
    sp = sub.add_parser("slot-claim")
    sp.add_argument("--build", required=True)
    for name in ("slot-restore", "slot-check", "preamble"):
        sp = sub.add_parser(name)
        sp.add_argument("--build", required=True)
        sp.add_argument("--claim", required=True)
    sp = sub.add_parser("slot-field")
    sp.add_argument("--claim", required=True)
    sp.add_argument("--key", required=True)
    sub.add_parser("slots")
    sub.add_parser("sweep-all")
    a = p.parse_args(argv)
    return {
        "state": cmd_state, "sweep-decide": cmd_sweep_decide, "sweep-all": cmd_sweep_all,
        "reminder": cmd_reminder,
        "slot-put": cmd_slot_put,
        "slot-claim": cmd_slot_claim, "slot-restore": cmd_slot_restore, "slot-check": cmd_slot_check,
        "slot-field": cmd_slot_field, "slots": cmd_slots, "preamble": cmd_preamble,
    }[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
