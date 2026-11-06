#!/usr/bin/env bash
# Steer a build session: types the message into the live tmux session.
# Usage: build_say.sh <build-id> <message...>
set -euo pipefail
source "$(dirname "$0")/lib.sh"

BUILD_ID="${1:?build id}"; shift
MSG="${*:?message}"
# NOT `TMUX` — reserved by tmux and already exported inside a pane. Assigning to
# it points has-session at a socket named after the build, so a steer sent from
# inside a pane dies on "session not running" while the session is fine. This is
# the live supervision channel: when it fails, foreman instructions never reach
# the builder.
TMUX_SESSION="$(fm_meta "$BUILD_ID" tmux)"

tmux has-session -t "$TMUX_SESSION" 2>/dev/null || { echo "ERROR: session $TMUX_SESSION not running" >&2; exit 1; }
# `set -e` alone would abort here with no message and no ledger entry, which
# reads to the foreman as "nothing happened" rather than "the steer is sitting
# unsent in the composer". Say which it is — an undelivered order is the one
# failure that must never be quiet.
if ! fm_send_submit "$TMUX_SESSION" "$MSG"; then
  if [ -n "${FM_SAY_EVENT:-}" ]; then
    fm_event "$BUILD_ID" "steer-failed" "$FM_SAY_EVENT: $(printf '%s' "$MSG" | head -c 300)"
  else
    fm_event "$BUILD_ID" "steer-failed" "$MSG"
  fi
  echo "ERROR: steer NOT delivered to $BUILD_ID — the message may be sitting unsent in the composer." >&2
  echo "       Inspect: $FOREMAN_ROOT/bin/build_status.sh $BUILD_ID" >&2
  echo "       Nudge:   $FOREMAN_ROOT/bin/build_keys.sh $BUILD_ID raw Enter" >&2
  exit 1
fi
fm_wake_lock_clear "$BUILD_ID"
# FM_SAY_EVENT: the heartbeat's own typing (a "status?" nudge, a lost brief
# re-sent) is logged as heartbeat-nudge / heartbeat-resubmit, not "steer" —
# a steer is a FOREMAN act and resets the heartbeat's dark counter; a nudge must not.
case "${FM_SAY_EVENT:-steer}" in
  heartbeat-nudge|heartbeat-resubmit) fm_event "$BUILD_ID" "$FM_SAY_EVENT" "$(printf '%s' "$MSG" | head -c 300)" ;;
  *) fm_event "$BUILD_ID" "steer" "$MSG" ;;
esac
echo "steered $BUILD_ID"
