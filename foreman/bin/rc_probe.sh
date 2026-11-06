#!/usr/bin/env bash
# Probe a Claude Code pane for Remote Control: poll the pane up to ROUNDS times
# (2s apart) for "/rc active" and a claude.ai/code session URL.
# Usage: rc_probe.sh <tmux-session> [rounds=10]
# Prints exactly one line: RC_PROBE_RESULT=rc-url <url> | rc-connected | rc-missing
set -euo pipefail
TMUX_SESSION="$1"; ROUNDS="${2:-10}"
RC_URL=""; RC_ACTIVE=""
for _ in $(seq 1 "$ROUNDS"); do
  RC_PANE="$(tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null || true)"
  if [ -z "$RC_URL" ]; then
    RC_URL="$(printf '%s' "$RC_PANE" | grep -oE 'https://claude\.ai/code/[a-zA-Z0-9_]+' | head -1 || true)"
  fi
  RC_ACTIVE="$(printf '%s' "$RC_PANE" | grep -oE '/rc active' | head -1 || true)"
  if [ -n "$RC_ACTIVE" ]; then break; fi
  sleep 2
done
if [ -n "$RC_ACTIVE" ] && [ -n "$RC_URL" ]; then echo "RC_PROBE_RESULT=rc-url $RC_URL"
elif [ -n "$RC_ACTIVE" ]; then echo "RC_PROBE_RESULT=rc-connected"
else echo "RC_PROBE_RESULT=rc-missing"; fi
