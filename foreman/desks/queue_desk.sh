#!/usr/bin/env bash
# queue_desk.sh — example standing desk: keep the chain alive.
#
# The foreman's wakes come from ACTIVE builds. If the last build closes while QUEUE.md still has open
# work, nothing wakes the supervisor and the queue just sits. This desk notices that and wakes Michael
# ONCE per queue state (cooldown), so the next build gets started.
#
# Open work = the unchecked "- [ ]" lines of $FOREMAN_ROOT/QUEUE.md (fm_queue_open, the same parser the
# close chain uses). If the next item is held by an active gate, the desk stays quiet, like the chain.
#
# Cron (UTC, every 15 min):  */15 * * * * $FOREMAN_ROOT/desks/queue_desk.sh >/dev/null 2>&1
# KILL:  touch $FOREMAN_ROOT/QUEUE-DESK-OFF        DRY:  FM_QUEUE_DESK_DRY=1 queue_desk.sh
# Always exits 0 so cron never alarms; reasons go to the log.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../bin/lib.sh"

NAME=queue-desk
[ -e "$FOREMAN_ROOT/QUEUE-DESK-OFF" ] && { echo "$NAME: OFF switch present"; exit 0; }
mkdir -p "$FM_LOG_DIR" "$FM_STATE_DIR" "$FM_LOCKS_DIR"
LOG="$FM_LOG_DIR/$NAME.log"
STATE="$FM_STATE_DIR/$NAME.state"           # "<queue signature> <epoch announced>"
COOLDOWN="${FM_QUEUE_DESK_COOLDOWN:-21600}"   # 6 h: the same queue state is never re-announced sooner
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

exec 9>"$FM_LOCKS_DIR/$NAME.lock"
flock -n 9 || exit 0                               # a previous tick is still running

open="$(fm_queue_open)"
n_open="$(printf '%s' "$open" | grep -c . || true)"
active=0
if [ "$n_open" -gt 0 ]; then                       # only an open queue makes the build scan worth it
  for d in "$BUILDS_DIR"/*/; do
    [ -f "$d/meta.json" ] && [ "$(fm_status "$(basename "$d")")" = active ] && { active=1; break; }
  done
fi

gated=""
[ "$n_open" -gt 0 ] && [ "$active" -eq 0 ] && \
  gated="$("$FOREMAN_ROOT/bin/fm_gates.py" gates-blocking "$(printf '%s\n' "$open" | head -1)" 2>/dev/null || true)"

if [ "$n_open" -eq 0 ] || [ "$active" -gt 0 ]; then
  log "open=$n_open active=$active — nothing to do"
elif [ -n "$gated" ]; then
  log "open=$n_open active=0 — next item is held by a gate; nothing to announce"
else
  sig="$(printf '%s' "$open" | sha256sum | cut -c1-16)"
  last_sig="" last_at=0
  [ -f "$STATE" ] && read -r last_sig last_at < "$STATE"
  now="$(date +%s)"
  if [ "$sig" = "$last_sig" ] && [ $((now - ${last_at:-0})) -lt "$COOLDOWN" ]; then
    log "open=$n_open active=0 — already announced, cooling down"
  elif [ "${FM_QUEUE_DESK_DRY:-0}" = "1" ]; then
    log "DRY: would wake Michael — $n_open open item(s), no active build"
    printf '%s\n' "$open"
  else
    printf 'Queue desk: no build is active and QUEUE.md has %s open item(s):\n%s\nStart the next build (or mark the items done).\n' \
      "$n_open" "$open" | fm_wake_michael >> "$LOG" 2>&1 || log "wake failed (logged, will retry after cooldown)"
    printf '%s %s\n' "$sig" "$now" > "$STATE"
    log "woke Michael — $n_open open item(s)"
  fi
fi
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
