#!/usr/bin/env bash
# Show a build's state: meta, derived status, recent events, live pane snapshot.
# Usage: build_status.sh <build-id>     (or with no args: list all builds)
set -euo pipefail
source "$(dirname "$0")/lib.sh"

if [ $# -eq 0 ]; then
  for d in "$BUILDS_DIR"/*/; do
    [ -f "$d/meta.json" ] || continue
    id="$(basename "$d")"
    echo "$id  status=$(fm_status "$id")  agent=$(fm_meta "$id" agent)"
  done
  exit 0
fi

BUILD_ID="$1"
echo "── meta ──"; cat "$BUILDS_DIR/$BUILD_ID/meta.json"
echo; echo "── status: $(fm_status "$BUILD_ID") ──"
echo "── last 10 events ──"; tail -10 "$BUILDS_DIR/$BUILD_ID/events.jsonl"
# NOT `TMUX` — that name is reserved by tmux ("<socket>,<pid>,<session>") and is
# already exported inside a pane, so assigning to it points every tmux call below
# at a socket named after the build. From the gateway TMUX is unset, the
# assignment stays shell-local, and the damage is invisible.
TMUX_SESSION="$(fm_meta "$BUILD_ID" tmux)"
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "── live pane (last 25 lines) ──"
  tmux capture-pane -t "$TMUX_SESSION" -p | tail -25
else
  echo "── tmux session not running ──"
fi
