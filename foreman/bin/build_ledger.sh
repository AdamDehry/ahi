#!/usr/bin/env bash
# BUILD LEDGER — what each model has actually done here.
# Usage: build_ledger.sh [filter]     filter = substring match on any column
#
# Reads $BUILDS_DIR/*/ directly; there is no second copy to drift. Effort is
# read from meta.json when present and recovered from the "started" event for
# older builds, from before effort was recorded in meta.json.
# "why" exists only for builds started after the model gate; older rows show "—"
# and that absence is the honest answer, not a blank to be backfilled by guess.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
exec python3 - "$BUILDS_DIR" "${1:-}" <<'PY'
import json, os, sys, glob, time

BUILDS = sys.argv[1]
filt = (sys.argv[2] if len(sys.argv) > 2 else "").lower()

rows = []
for p in sorted(glob.glob(f"{BUILDS}/*/meta.json")):
    try:
        d = json.load(open(p))
    except Exception:
        continue
    bid = d.get("build_id") or os.path.basename(os.path.dirname(p))
    ev = os.path.join(os.path.dirname(p), "events.jsonl")
    status, eff, start, end = "active", d.get("effort"), d.get("created"), None
    if os.path.exists(ev):
        for line in open(ev):
            try:
                e = json.loads(line)
            except Exception:
                continue
            t = e.get("type", "")
            if t.startswith("status:"):
                status, end = t.split(":", 1)[1], e.get("ts")
            elif t == "started":
                start = e.get("ts", start)
                if not eff:
                    for tok in e.get("detail", "").split():
                        if tok.startswith("effort="):
                            eff = tok.split("=", 1)[1]
    mins = round((end - start) / 60) if (start and end) else None
    rows.append(dict(id=bid, agent=d.get("agent") or "?", rt=d.get("runtime") or "?",
                     model=d.get("model") or "?", eff=eff or "default", mins=mins,
                     status=status, why=d.get("why") or ""))

if filt:
    rows = [r for r in rows if filt in json.dumps(r).lower()]

CLEAN, BAD = "done", ("failed", "abandoned", "stalled")
tally = {}
for r in rows:
    t = tally.setdefault(f"{r['rt']}  {r['model']} @ {r['eff']}", {"n": 0, "ok": 0, "bad": 0, "mins": []})
    t["n"] += 1
    if r["status"] == CLEAN:
        t["ok"] += 1
    elif r["status"] in BAD:
        t["bad"] += 1
    if r["mins"]:
        t["mins"].append(r["mins"])

print(f"\nBUILD LEDGER — {len(rows)} builds" + (f" matching '{filt}'" if filt else "") + "\n")
print(f"{'combination':<44} {'n':>3} {'clean':>6} {'bad':>4} {'median min':>11}")
print("-" * 72)
for k, t in sorted(tally.items(), key=lambda kv: -kv[1]["n"]):
    m = sorted(t["mins"])
    med = m[len(m) // 2] if m else "—"
    print(f"{k:<44} {t['n']:>3} {t['ok']:>6} {t['bad']:>4} {str(med):>11}")

print("\nchronological\n" + "-" * 72)
for r in rows:
    mark = {"done": "✓", "failed": "✗", "abandoned": "✗", "stalled": "!"}.get(r["status"], "·")
    line = f"{mark} {r['id']:<34} {r['agent']:<6} {r['model']} @ {r['eff']}"
    if r["mins"]:
        line += f"  {r['mins']}m"
    print(line)
    if r["why"]:
        print(f"      why: {r['why']}")
PY
