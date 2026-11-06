#!/usr/bin/env python3
"""THE MODEL GATE — PreToolUse(Bash) hook. Every build starts by evaluating the
build, recalling which model built what before, and THEN deciding runtime,
model and effort.

A default that fires silently is a decision nobody made. build_start.sh keeps its
defaults (a hand-run command must still work) and enforces the same gate itself;
this hook catches the mistake one step earlier, before the tool call runs, and
hands back the recall needed to choose again.

Python, not bash-with-a-heredoc: a heredoc IS stdin, so a wrapper written that
way eats the hook payload and then silently allows everything. It did, for one
test round. Exit 0 = allow. Exit 2 = block, stderr goes to the model.

Register in settings.json → hooks.PreToolUse, matcher "Bash".
"""
import json
import os
import glob
import sys

AHI_HOME = os.environ.get("FM_AHI_HOME") or os.environ.get("AHI_HOME") or os.path.expanduser("~/ahi")
FOREMAN_ROOT = os.environ.get("FOREMAN_ROOT") or os.path.join(AHI_HOME, "foreman")
FOREMAN = FOREMAN_ROOT
BUILDS_DIR = os.environ.get("BUILDS_DIR") or os.path.join(FOREMAN_ROOT, "builds")
SHEET = f"{FOREMAN}/MODEL-SELECTION.md"

# Effort vocabulary lives in ONE place — fm_effort.py — because it is
# runtime-AND-model dependent and because picker words are not the flag values.
# A second copy here drifts wrong in both directions (accepting a value the API
# 400s, missing one the CLI silently drops). See fm_effort.py's header.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fm_effort import resolve as resolve_effort  # noqa: E402

# Bare aliases resolve to whatever the CLI currently maps them to, without saying
# so. Current examples — extend when a vendor adds a new family alias.
ALIAS_TRAP = {"opus", "sonnet", "fable", "haiku", "gpt-5.6", "gpt-5", "gpt-6", "gpt-6.1"}
READ_ONLY = ("cat ", "less ", "head ", "tail ", "grep ", "ls ", "wc ", "sed -n", "bat ", "rg ")


def record():
    """What each model has actually done here — the recall, at the moment of choosing."""
    rows = []
    for p in glob.glob(os.path.join(BUILDS_DIR, "*", "meta.json")):
        try:
            d = json.load(open(p))
        except Exception:
            continue
        ev = os.path.join(os.path.dirname(p), "events.jsonl")
        status, eff = "active", d.get("effort")
        if os.path.exists(ev):
            for line in open(ev):
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                t = e.get("type", "")
                if t.startswith("status:"):
                    status = t.split(":", 1)[1]
                elif t == "started" and not eff:
                    for tok in e.get("detail", "").split():
                        if tok.startswith("effort="):
                            eff = tok.split("=", 1)[1]
        rows.append((d.get("build_id", ""), d.get("model"), eff or "default", status, d.get("why") or ""))

    tally = {}
    for _bid, m, e, s, _w in rows:
        t = tally.setdefault(f"{m} @ {e}", {"n": 0, "ok": 0, "bad": 0})
        t["n"] += 1
        if s == "done":
            t["ok"] += 1
        elif s in ("failed", "abandoned", "stalled"):
            t["bad"] += 1

    out = ["OUR RECORD (every build on this machine):"]
    for k, t in sorted(tally.items(), key=lambda kv: -kv[1]["n"])[:8]:
        out.append(f"  {t['ok']}/{t['n']} clean, {t['bad']} bad — {k}")
    out.append("LAST 5:")
    for bid, m, e, s, w in sorted(rows)[-5:]:
        out.append(f"  {bid} — {m} @ {e} → {s}" + (f"   [{w[:60]}]" if w else ""))
    return "\n".join(out)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # never break a tool call on a parse error

    if payload.get("tool_name") != "Bash":
        return 0
    cmd = (payload.get("tool_input") or {}).get("command", "")
    if "build_start.sh" not in cmd:
        return 0
    if any(cmd.lstrip().startswith(p) for p in READ_ONLY):
        return 0  # reading the script is not starting a build

    import shlex
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        tokens = cmd.split()
    idx = next((n for n, t in enumerate(tokens) if t.endswith("build_start.sh")), None)
    if idx is None:
        return 0

    flags, rest, n = {}, tokens[idx + 1:], 0
    while n < len(rest) - 1:
        if rest[n] in ("-r", "-m", "-e", "-w"):
            flags[rest[n]] = rest[n + 1]
            n += 2
        else:
            n += 1

    problems = []
    rt = flags.get("-r", "")
    if rt not in ("claude", "codex"):
        problems.append("-r missing or invalid (claude|codex)")

    model = flags.get("-m", "")
    if not model:
        problems.append("-m missing — name the model explicitly")
    elif model in ALIAS_TRAP:
        problems.append(
            f"-m '{model}' is a BARE ALIAS. Aliases resolve silently to whatever the CLI "
            "maps them to, which has been a previous generation. Use the full slug.")
    elif rt == "claude" and not model.startswith("claude-"):
        problems.append(f"-m '{model}' is not a claude model slug")
    elif rt == "codex" and not model.startswith("gpt-"):
        problems.append(f"-m '{model}' is not a codex model slug")

    # Effort is checked against the runtime AND the model, and against the words
    # people actually say. The point is not tidiness: a value this runtime would
    # DROP must never reach it, because dropping is silent and the ledger then
    # records an effort the build never ran at.
    effort = flags.get("-e", "")
    value, why_not = resolve_effort(rt or "claude", model, effort)
    if why_not:
        problems.append(f"-e '{effort}': {why_not}" if effort else why_not)
    elif value != effort.strip().lower():
        # Not a problem — a translation. Say it out loud so the order and the
        # ledger agree on one word.
        print(f"NOTE: effort '{effort}' is the picker's word; the flag takes '{value}'. "
              f"Re-issue with -e {value}.", file=sys.stderr)

    if len(flags.get("-w", "").strip()) < 15:
        problems.append("-w missing or too thin — one line on WHY this model at this effort for "
                        "THIS build. It is written to meta.json and becomes the record the next "
                        "decision reads.")

    if not problems:
        return 0

    print("MODEL GATE — build refused, nothing was started.\n", file=sys.stderr)
    for p in problems:
        print(f"  ✗ {p}", file=sys.stderr)
    print(f"""
Runtime, model and effort are three decisions made FOR THIS BUILD, every time.
Read {SHEET} (it is short), weigh this build's shape
against the record below, then re-issue with -r -m -e -w.

{record()}

Full history: {FOREMAN}/bin/build_ledger.sh""", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
