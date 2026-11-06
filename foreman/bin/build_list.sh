#!/usr/bin/env bash
# List all builds: ID, agent, status, age.
# Usage: build_list.sh
set -euo pipefail
source "$(dirname "$0")/lib.sh"

python3 - "$BUILDS_DIR" <<'PY'
import json, os, sys, time

builds_dir = sys.argv[1]
now = time.time()

def age_str(created):
    secs = int(now - created)
    d, secs = divmod(secs, 86400)
    h, secs = divmod(secs, 3600)
    m       = secs // 60
    if d:   return f"{d}d {h}h"
    if h:   return f"{h}h {m}m"
    return f"{m}m"

def derived_status(events_path):
    status = "active"
    try:
        for line in open(events_path):
            e = json.loads(line.strip())
            if e.get("type", "").startswith("status:"):
                status = e["type"].split(":", 1)[1]
    except FileNotFoundError:
        status = "unknown"
    return status

rows = []
try:
    entries = sorted(os.listdir(builds_dir))
except FileNotFoundError:
    entries = []

for entry in entries:
    meta_path   = os.path.join(builds_dir, entry, "meta.json")
    events_path = os.path.join(builds_dir, entry, "events.jsonl")
    if not os.path.isfile(meta_path):
        continue
    meta   = json.load(open(meta_path))
    status = derived_status(events_path)
    age    = age_str(meta.get("created", now))
    rows.append((meta["build_id"], meta.get("agent", "?"), status, age))

if not rows:
    print("(no builds)")
    sys.exit(0)

id_w  = max(len(r[0]) for r in rows)
ag_w  = max(len(r[1]) for r in rows)
st_w  = max(len(r[2]) for r in rows)

hdr = f"{'BUILD_ID':<{id_w}}  {'AGENT':<{ag_w}}  {'STATUS':<{st_w}}  AGE"
print(hdr)
print("-" * len(hdr))
for bid, agent, status, age in rows:
    print(f"{bid:<{id_w}}  {agent:<{ag_w}}  {status:<{st_w}}  {age}")
PY
