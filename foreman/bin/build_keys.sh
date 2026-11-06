#!/usr/bin/env bash
# Send raw keystrokes to a build session — for permission dialogs and menus.
# Usage: build_keys.sh <build-id> approve   (sends "1" + Enter — accept)
#        build_keys.sh <build-id> deny      (sends Escape — dismiss)
#        build_keys.sh <build-id> raw <tmux-send-keys args...>
set -euo pipefail
source "$(dirname "$0")/lib.sh"

BUILD_ID="${1:?build id}"; ACTION="${2:?approve|deny|raw}"; shift 2 || true
# NOT `TMUX` — reserved by tmux and already exported inside a pane; assigning to
# it aims every tmux call below at a socket named after the build.
TMUX_SESSION="$(fm_meta "$BUILD_ID" tmux)"
tmux has-session -t "$TMUX_SESSION" 2>/dev/null || { echo "ERROR: session $TMUX_SESSION not running" >&2; exit 1; }

case "$ACTION" in
  approve) tmux send-keys -t "$TMUX_SESSION" "1" Enter ;;
  deny)    tmux send-keys -t "$TMUX_SESSION" Escape ;;
  raw)     tmux send-keys -t "$TMUX_SESSION" "$@" ;;
  *) echo "unknown action: $ACTION" >&2; exit 1 ;;
esac
fm_wake_lock_clear "$BUILD_ID"
fm_event "$BUILD_ID" "keys" "$ACTION $*"
echo "sent"
