#!/usr/bin/env bash
# Fast idle-detector for codex builds — the guaranteed wake floor.
#
# WHY: the codex `notify` hook (foreman_codex_notify.sh) can fire once at
# launch and then never again for the rest of a session, so every stop falls
# through to the heartbeat — tens of minutes of dead air per stop. This
# watcher makes that non-blocking by polling instead of trusting the push
# channel.
#
# Cron is the reliable wake fabric; ad-hoc sleep-watchers and setsid workers
# can die silently.
#
# Install (UTC crontab, expanded paths):
#   */2 * * * * $FOREMAN_ROOT/bin/fm_stop_watch.sh >> $FM_LOG_DIR/foreman-stop-watch.log 2>&1
#
# Decision rule (per pass, codex builds only):
#   pane shows the idle composer AND no Working/esc-to-interrupt spinner
#   AND the last ledger event is >=180s old
#   AND the last ledger event is not already a poll-wake or dark
#   -> fm_event poll-wake + fm_wake_michael (with an origin line).
# Self-dedup: after firing, the poll-wake IS the newest event, so the watcher
# stays silent until a steer (new event) starts the next work/stop cycle.
# Deliberate pauses use the HOLD file, same contract as the heartbeat.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

# ── DRAIN ONE DEFERRED WAKE PER TICK ────────────────────────────────────────
# A wake refused by the concurrency guard is QUEUED, not dropped — without this
# call the duplicate-supervisor guard would simply trade a duplicated chain for
# a dark one, and a dark chain costs more. Deliberately ABOVE the codex-only
# pane scan below, and runtime-agnostic: it covers claude builds too.
# First the waiting-on-Michael ladder — a build done and unanswered for 10 min
# is re-woken (bounded), then the owner hears "waiting on Michael" — and then
# the drain, which also delivers per-build held wakes.
fm_waiting_sweep || true
fm_drain_pending_wakes || true

NOW="$(date +%s)"
for d in "$BUILDS_DIR"/*/; do
  [ -f "$d/meta.json" ] || continue
  ID="$(basename "$d")"
  [ "$(fm_status "$ID")" = "active" ] || continue
  [ -f "$d/HOLD" ] && continue                    # deliberate pause — silence expected
  RUNTIME="$(fm_meta "$ID" runtime 2>/dev/null || true)"
  [ "$RUNTIME" = "codex" ] || continue            # pane grammar below is codex-only

  # NOT `TMUX` — reserved by tmux and already exported inside a pane.
  TMUX_SESSION="$(fm_meta "$ID" tmux)"
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null || continue  # heartbeat case-1 owns death

  PANE="$(timeout 3 tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null)" || continue
  # Same pinned pane grammar as foreman_codex_notify.sh; re-measure after a Codex upgrade.
  printf '%s\n' "$PANE" | grep -Eq 'Working \([^)]*\)|esc to interrupt' && continue
  printf '%s\n' "$PANE" | grep -Fq '› Ask Codex to do anything' || continue

  LAST_LINE="$(tail -1 "$d/events.jsonl" 2>/dev/null)" || continue
  read -r LAST_TS LAST_TYPE <<< "$(printf '%s' "$LAST_LINE" | python3 -c '
import json, sys
try:
    r = json.loads(sys.stdin.read())
    print(r.get("ts", 0), r.get("type", "?"))
except Exception:
    print(0, "?")')"
  case "$LAST_TYPE" in poll-wake|dark) continue ;; esac   # already surfaced this stop
  [ $((NOW - LAST_TS)) -ge 180 ] || continue              # give steers/notify a head start

  fm_event "$ID" "poll-wake" "pane idle, last event type=$LAST_TYPE age=$((NOW - LAST_TS))s; codex notify did not fire"
  FM_BRIEF_PRODUCER="fm_stop_watch.sh:idle-stop" \
  FM_BRIEF_TRANSPORT="stop-watch" \
  fm_wake_michael <<EOF
(foreman stop-watch — build $ID pane is IDLE, turn ended)
The codex session shows the idle composer with no spinner, and no steer or wake has followed the last ledger event (type=$LAST_TYPE, $((NOW - LAST_TS))s ago). The primary codex notify hook did not fire. Read the pane tail and steer or hold: $FOREMAN_ROOT/bin/build_status.sh $ID
origin: cron poll watcher (fm_stop_watch.sh), pane=$TMUX_SESSION
EOF
done
