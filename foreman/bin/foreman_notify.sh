#!/usr/bin/env bash
# Notification-hook target: the session is waiting (permission dialog etc).
# Logs the event; wakes Michael so approval doesn't dead-air until heartbeat.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

# ── WAKE-COLLISION: --deliver <build> <claim> ───────────────────────────────
# Called ONLY by lib.sh fm_drain_build_slots for a held permission wake: skips
# the hook half and goes out through the same permission-dialog call below.
# Exit 0 = handed over; 75 = not yet (inside the 5-min rate limit); else failed.
DELIVER_CLAIM=""
if [ "${1:-}" = "--deliver" ]; then
  BUILD_ID="${2:?build id}"; DELIVER_CLAIM="${3:?claim file}"
  [ "$(fm_status "$BUILD_ID")" = "active" ] || exit 0
  NOTE="$(python3 -B "$FM_WAKE_STATE" slot-field --claim "$DELIVER_CLAIM" --key note 2>/dev/null || true)"
else
HOOK_JSON="$(cat)"
CWD="$(printf '%s' "$HOOK_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cwd',''))")"
NOTE="$(printf '%s' "$HOOK_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('message','')[:200])")"
TRANSCRIPT="$(printf '%s' "$HOOK_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || true)"
# permission_prompt | idle_prompt | … when Claude Code sends it; else read the message.
NTYPE="$(printf '%s' "$HOOK_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('notification_type',''))" 2>/dev/null || true)"
if [ -z "$NTYPE" ]; then
  case "$NOTE" in *"waiting for your input"*) NTYPE="idle_prompt" ;; esac
fi

BUILD_ID=""
for d in "$BUILDS_DIR"/*/; do
  [ -f "$d/meta.json" ] || continue
  id="$(basename "$d")"
  wd="$(fm_meta "$id" workdir 2>/dev/null)" || continue
  if [ "$wd" = "$CWD" ] && [ "$(fm_status "$id")" = "active" ]; then BUILD_ID="$id"; break; fi
done
[ -z "$BUILD_ID" ] && exit 0

fm_event "$BUILD_ID" "awaiting" "$NOTE"
fm_build_transcript_note "$BUILD_ID" "${TRANSCRIPT:-}"

# ── WAKE-COLLISION: the idle reminder is not a permission dialog ────────────
# "Claude is waiting for your input" is Claude Code repeating, ~60s after a
# turn end, that the turn ended (the large majority of all notifications). Woken
# to Michael as "WAITING on a permission dialog" it is pure noise. The Stop hook already
# reports the turn end, so the reminder wakes no one unless that report is
# missing; a build Michael leaves unanswered is the waiting sweep's to re-wake.
if [ "$NTYPE" = "idle_prompt" ] && [ -z "${FM_WAKE_DEFER_DISABLE:-}" ]; then
  case "$(python3 -B "$FM_WAKE_STATE" reminder --build "$BUILD_ID" 2>/dev/null || echo unreported)" in
    reported)
      fm_event "$BUILD_ID" "awaiting-reminder" "turn end already reported to Michael; no second wake"
      exit 0 ;;
    stale)
      fm_event "$BUILD_ID" "awaiting-stale" "reminder of the turn before the latest steer; the session is working"
      exit 0 ;;
    *)
      # No Stop report for this turn end: the reminder is the only signal.
      # Hold it as an idle report and try to send it now.
      fm_build_wake_defer "$BUILD_ID" idle "notify-idle" "the turn end had no Stop report; this is its idle reminder" "${TRANSCRIPT:-}"
      fm_drain_pending_wakes "$BUILD_ID"
      exit 0 ;;
  esac
fi
fi

if [ -n "$DELIVER_CLAIM" ]; then
  # Inside the 5-min rate limit a held permission wake waits for the next tick.
  RECENT_D="$(python3 - "$BUILDS_DIR/$BUILD_ID/events.jsonl" <<'PY'
import json, sys, time
now = int(time.time())
n = 0
for l in open(sys.argv[1]):
    try: e = json.loads(l)
    except Exception: continue
    if e.get("type") == "awaiting-wake" and now - e.get("ts", 0) < 300: n += 1
print(n)
PY
)"
  [ "${RECENT_D:-0}" -gt 0 ] && exit 75
fi

if [ -z "$DELIVER_CLAIM" ]; then

# Rate-limit: only one awaiting-wake per 5 min. But do NOT silently drop —
# the session may stay blocked until heartbeat (up to 10 min). Write a
# self-contained retry script detached from the hook's process group + pipe
# FDs so hook teardown cannot kill it via SIGHUP or SIGPIPE.
RECENT="$(python3 - "$BUILDS_DIR/$BUILD_ID/events.jsonl" <<'PY'
import json, sys, time
now = int(time.time())
n = sum(1 for l in open(sys.argv[1])
        if (e := json.loads(l))["type"] == "awaiting-wake" and now - e["ts"] < 300)
print(n)
PY
)"

if [ "$RECENT" -gt 0 ]; then
  fm_event "$BUILD_ID" "awaiting-retry-scheduled" "rate-limited; retry in 120s"
  _bid="$BUILD_ID"
  _note="$NOTE"
  _bin="$(cd "$(dirname "$0")" && pwd)"
  _sched_ts="$(date +%s)"
  _rf="$(mktemp /tmp/fm-notify-retry.XXXXXX.sh)"
  cat > "$_rf" <<RETRY_SCRIPT
#!/usr/bin/env bash
trap 'rm -f "$_rf"' EXIT
source "$_bin/lib.sh"
sleep 120
[ "\$(fm_status "$_bid")" = "active" ] || exit 0
# Resolved check: if foreman acted (steer/keys) since we scheduled, the dialog
# was handled — firing now would send a spurious STILL-WAITING wake.
RESOLVED="\$(python3 - "$BUILDS_DIR/$_bid/events.jsonl" "$_sched_ts" <<'PY'
import json, sys
sched = int(sys.argv[2])
for l in open(sys.argv[1]):
    try:
        e = json.loads(l)
        if e["type"] in ("steer", "keys") and e["ts"] > sched:
            print("yes"); exit()
    except Exception:
        pass
print("no")
PY
)"
if [ "\$RESOLVED" = "yes" ]; then
  fm_event "$_bid" "wake-retry-resolved-noop" "dialog handled during rate-limit window; no wake needed"
  exit 0
fi
# wake-collision: in flight ⇒ HELD in the build's slot, not dropped.
if fm_wake_hold "$_bid" permission "notify retry"; then
  exit 0
fi
fm_event "$_bid" "awaiting-wake" ""
fm_wake_lock_set "$_bid"
FM_BRIEF_PRODUCER="foreman_notify.sh:permission-retry" \
FM_BRIEF_TRANSPORT="retry" \
fm_wake_michael <<__FOREMAN_NOTIFY_MSG__
(foreman — build $_bid STILL WAITING — retry after rate-limit window)
The session has been awaiting approval for over 2 minutes. Original message: $_note
Check the pane: $FOREMAN_ROOT/bin/build_status.sh $_bid
Approve with: $FOREMAN_ROOT/bin/build_keys.sh $_bid approve — but ONLY if clearly within scope.
__FOREMAN_NOTIFY_MSG__
RETRY_SCRIPT
  chmod 700 "$_rf"
  # setsid: new session — survives SIGHUP from hook teardown.
  # </dev/null >/dev/null 2>&1: detach from hook's pipe FDs — prevents SIGPIPE.
  setsid bash "$_rf" </dev/null >/dev/null 2>&1 &
  disown
  exit 0
fi

# ── Inflight dedup → HOLD, never drop ───────────────────────────────────────
fm_wake_hold "$BUILD_ID" permission "notify-hook" "${TRANSCRIPT:-}" "$NOTE" && exit 0
fi

[ -n "$NOTE" ] || NOTE="(held permission wake — the dialog text was not kept; read the pane)"
if [ -n "$DELIVER_CLAIM" ]; then
  fm_event "$BUILD_ID" "awaiting-wake" "held wake delivered"
else
  fm_event "$BUILD_ID" "awaiting-wake" ""
fi
fm_wake_lock_set "$BUILD_ID"

FM_BRIEF_PRODUCER="foreman_notify.sh:permission-dialog" \
FM_BRIEF_TRANSPORT="permission" \
fm_wake_michael <<EOF
(foreman — build $BUILD_ID is WAITING on a permission dialog)
Message: $NOTE
Check the pane: $FOREMAN_ROOT/bin/build_status.sh $BUILD_ID
Approve with: $FOREMAN_ROOT/bin/build_keys.sh $BUILD_ID approve — but ONLY if the pending action is clearly within the build brief. If it looks outside scope (pushes, deletions, system changes), deny and report to the owner.
EOF
WAKE_RC=$?
# wake-collision: the gateway did not take it — hold it, never lose it.
if [ "$WAKE_RC" -ne 0 ]; then
  fm_event "$BUILD_ID" "wake-post-failed" "rc=$WAKE_RC — gateway did not take the permission wake"
  fm_wake_lock_clear "$BUILD_ID"   # not handed over — must not read as already said
  [ -n "$DELIVER_CLAIM" ] && exit "$WAKE_RC"
  [ -n "${FM_WAKE_DEFER_DISABLE:-}" ] || \
    fm_build_wake_defer "$BUILD_ID" permission "notify-hook" "the gateway did not take it (rc=$WAKE_RC)" "${TRANSCRIPT:-}" "$NOTE"
fi
exit 0
