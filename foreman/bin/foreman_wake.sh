#!/usr/bin/env bash
# Stop-hook target. Runs INSIDE the build session's hook context: receives hook
# JSON on stdin (session_id, transcript_path, cwd). Maps cwd → build, applies
# the wake-loop guard (too many wakes → stall alert), then wakes Michael via
# the gateway (lib.sh fm_wake_michael). Always exits 0 on the hook path so it
# can never break the builder's session.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

# Detect gate-source drift at the chain/wake boundary without making either
# boundary depend on the check (it only ever prints a notice). Launch-time
# refusal lives in build_start.sh.
fm_gate_reconcile_notice() {
  local checker="$FOREMAN_ROOT/bin/fm_gates.py"
  local report rc first counts summary keys repairs
  if [ ! -f "$checker" ]; then
    printf '!!! GATE-RECONCILE RED-UNKNOWN — checker missing: %s; caller continues\n' "$checker"
    return 0
  fi
  if report="$(python3 "$checker" check 2>&1)"; then rc=0; else rc=$?; fi
  first="${report%%$'\n'*}"
  if [ "$rc" -eq 0 ] && [ "$first" = "GATE RECONCILE — PASS" ]; then
    counts="$(printf '%s\n' "$report" | sed -n 's/^  entries     : //p' | head -1)"
    [ -n "$counts" ] || counts="counts unavailable"
    printf 'GATE-RECONCILE GREEN — %s\n' "$counts"
    return 0
  fi
  if [ "$rc" -eq 1 ] && [ "$first" = "GATE RECONCILE — FAILED" ]; then
    summary="$(printf '%s\n' "$report" | python3 -c '
import re, shlex, sys
recarray = sys.stdin.read().splitlines()
tool = sys.argv[1]
keys = []
repairs = []
uncarried = False
for line in recarray:
    mark = re.match(r"^\s*✗\s+([^:\s]+)", line)
    if mark and mark.group(1) not in keys:
        keys.append(mark.group(1))
    if "✗ UNCARRIED at " in line:
        uncarried = True
        continue
    if uncarried:
        head = re.match(r"^\s*#\s+((?:F|R|G|D)-?\d+[A-Za-z]?(?:\([a-z]\))?)\b(.*)$", line)
        if head:
            key = head.group(1)
            anchor = key + head.group(2)
            if key not in keys:
                keys.append(key)
            repairs.append("%s --add %s --key %s --write" %
                           (shlex.quote(tool), shlex.quote(anchor), shlex.quote(key)))
        uncarried = False
    drift = re.match(r"^\s*✗\s+([^:\s]+):\s+(?:QUEUE-DRIFTED|TRANSCRIPTION-DIVERGED)", line)
    if drift:
        repairs.append("%s %s --write" % (shlex.quote(tool), shlex.quote(drift.group(1))))
print(",".join(keys) if keys else "<unparsed>")
for repair in dict.fromkeys(repairs):
    print(repair)
' "$FOREMAN_ROOT/bin/fm_recarry.py")"
    keys="${summary%%$'\n'*}"
    repairs=""
    case "$summary" in *$'\n'*) repairs="${summary#*$'\n'}" ;; esac
    printf '!!! GATE-RECONCILE RED — failing keys: %s; caller continues\n' "$keys"
    if [ -n "$repairs" ]; then
      while IFS= read -r repair; do
        printf '!!! GATE-RECONCILE REPAIR — %s\n' "$repair"
      done <<< "$repairs"
    fi
    printf '%s\n' "$report"
    return 0
  fi
  printf '!!! GATE-RECONCILE RED-UNKNOWN — check rc=%s, first line=%q; caller continues\n' "$rc" "$first"
  [ -z "$report" ] || printf '%s\n' "$report"
  return 0
}

if [ "${1:-}" = "--gate-reconcile-notice" ]; then
  fm_gate_reconcile_notice
  exit $?
fi

# ── WAKE-COLLISION: --deliver <build> <claim> ───────────────────────────────
# Called ONLY by lib.sh fm_drain_build_slots, for a wake that was held in the
# build's slot. It skips the hook half (no new idle event, no re-forward, no
# second hold check) and goes out through the SAME idle-report call below, read
# NOW — so a held wake carries the latest state, never a stale copy.
# Exit 0 = handed to Michael (or durably queued as a pending wake); 75 = not yet (the
# drain keeps the slot); anything else = not delivered (the drain restores it).
DELIVER_CLAIM=""
WAKE_PREAMBLE=""
FALSE_IDLE_NOTE=""   # set only on the hook path; pre-set so the --deliver path cannot trip set -u at the heredoc (that once killed every held wake, rc=1, unlogged)
if [ "${1:-}" = "--deliver" ]; then
  BUILD_ID="${2:?build id}"; DELIVER_CLAIM="${3:?claim file}"
  [ "$(fm_status "$BUILD_ID")" = "active" ] || exit 0
  CWD="$(fm_meta "$BUILD_ID" workdir 2>/dev/null || true)"
  TRANSCRIPT="$(python3 -B "$FM_WAKE_STATE" slot-field --claim "$DELIVER_CLAIM" --key transcript 2>/dev/null || true)"
  [ -n "$TRANSCRIPT" ] || TRANSCRIPT="$(cat "$BUILDS_DIR/$BUILD_ID/transcript.path" 2>/dev/null || true)"
else
HOOK_JSON="$(cat)"
CWD="$(printf '%s' "$HOOK_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cwd',''))")"
TRANSCRIPT="$(printf '%s' "$HOOK_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('transcript_path',''))")"

# Map workdir → active build.
BUILD_ID=""
for d in "$BUILDS_DIR"/*/; do
  [ -f "$d/meta.json" ] || continue
  id="$(basename "$d")"
  wd="$(fm_meta "$id" workdir 2>/dev/null)" || continue
  if [ "$wd" = "$CWD" ] && [ "$(fm_status "$id")" = "active" ]; then BUILD_ID="$id"; break; fi
done
[ -z "$BUILD_ID" ] && exit 0  # not a foreman build — stay silent
fi
GATE_RECONCILE_NOTICE="$(fm_gate_reconcile_notice)"

if [ -z "$DELIVER_CLAIM" ]; then
fm_event "$BUILD_ID" "idle" "session went idle"
fm_build_transcript_note "$BUILD_ID" "$TRANSCRIPT"

# ── FOREMAN MESSAGES: forward the executor's status records FIRST ──────────
# Before every guard below: a throttled, deferred or in-flight-suppressed wake
# must not hold back a record. The owner's "I need you" / "Build closed" reach
# their chat on the stop that wrote them; the copy for Michael rides the next wake
# that actually reaches him (fm_status_take_unwoken).
fm_status_forward "$BUILD_ID" "$CWD"

# ── FALSE IDLE: background shells still running ─────────────────────────────
# The builder ended its turn to wait on background jobs. That is not an idle
# the foreman owes Michael: steer the builder once ("wait in the foreground,
# then finish"), log it, and let the session carry on. Michael is woken only
# when the executor wrote a real close, or the same shells survive the steer
# and the acknowledgement turn (fm_idle_bg.py decides; it never raises).
FALSE_IDLE_NOTE=""
exec 9>>"$BUILDS_DIR/$BUILD_ID/idle-bg.lock"; flock -w 10 9 || true   # the twin hook entry runs this script too
_bg="$(python3 -B "$(dirname "$0")/fm_idle_bg.py" check --build "$BUILD_ID" --self $$ 2>/dev/null || true)"
_bg_verdict="$(printf '%s' "$_bg" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("verdict",""))' 2>/dev/null || true)"
_bg_detail="$(printf '%s' "$_bg" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("detail",""))' 2>/dev/null || true)"
_bg_why="$(printf '%s' "$_bg" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("why",""))' 2>/dev/null || true)"
case "$_bg_verdict" in
  skip-steer|skip)
    fm_event "$BUILD_ID" "idle-background" "$_bg_why: $_bg_detail — not waking Michael"
    if [ "$_bg_verdict" = "skip-steer" ]; then
      FM_SAY_EVENT=heartbeat-nudge "$(dirname "$0")/build_say.sh" "$BUILD_ID" \
"(foreman) Your turn ended while background shell(s) are still running: $_bg_detail. Michael was NOT woken. Never end a turn to wait on a background job: wait for it in the foreground (BashOutput / Monitor / a foreground wait), then continue with the next step and finish with REPORT.md and the status record. If a shell is a server you are keeping up on purpose, say so in one line and carry on." \
        >/dev/null 2>&1 || fm_event "$BUILD_ID" "idle-background-steer-failed" "the foreground steer did not reach the session"
    fi
    exit 0 ;;
  dup) exit 0 ;;
  wake)
    FALSE_IDLE_NOTE="
NOTE from the foreman ($_bg_why): $_bg_detail.
" ;;
esac

# ── Inflight dedup → HOLD, never drop ───────────────────────────────────────
# A wake that cannot go now — an earlier one for this build is in flight, or a
# Michael turn is running — is held in the build's slot and delivered by the
# drain the moment Michael is free. Dropping it here (a plain `exit 0`) lost
# finished builds: nothing ever re-fired for them.
fm_wake_hold "$BUILD_ID" idle "stop-hook" "$TRANSCRIPT" && exit 0
fi

# ── Wake-loop guard: ≥6 wakes in 30min → stall; <90s since last wake → skip ──
GUARD="$(python3 - "$BUILDS_DIR/$BUILD_ID/events.jsonl" <<'PY'
import json, sys, time
now = int(time.time())
wakes = []
for line in open(sys.argv[1]):
    e = json.loads(line)
    if e["type"] == "wake": wakes.append(e["ts"])
recent = [t for t in wakes if now - t < 1800]
alerts = [e["ts"] for e in (json.loads(l) for l in open(sys.argv[1])) if e["type"] == "wake-cap" and now - e["ts"] < 1800]
if len(recent) >= 6 and not alerts: print("stall")
elif len(recent) >= 6: print("capped")
elif wakes and now - wakes[-1] < 90: print("skip")
else: print("wake")
PY
)"

if [ "$GUARD" = "stall" ]; then
  # The cap is a WARNING, not a freeze: a healthy builder taking many short turns
  # trips it too, and a frozen build sits until someone looks. The build stays
  # ACTIVE (the heartbeat keeps owning it); Michael gets one alert per 30 min;
  # further wakes inside the window take the backoff path.
  fm_event "$BUILD_ID" "wake-cap" "6 wakes/30min — alerting Michael once; build stays active"
  fm_wake_lock_set "$BUILD_ID"
  FM_BRIEF_PRODUCER="foreman_wake.sh:stall" \
  FM_BRIEF_TRANSPORT="stall" \
  fm_wake_michael <<EOF
(foreman STALL ALERT — build $BUILD_ID)
$GATE_RECONCILE_NOTICE

This build hit the wake-rate cap: 6 supervision wakes in 30 minutes. It is NOT frozen: it stays active, the heartbeat keeps watching it, and you will not get another cap alert for 30 minutes. Many short turns can be a healthy builder; check the pane before assuming a loop.
$(fm_status_take_unwoken "$BUILD_ID")
Assess with: $FOREMAN_ROOT/bin/build_status.sh $BUILD_ID
If it is working, do nothing. If steering really is looping, tell the owner or close it: $FOREMAN_ROOT/bin/build_done.sh $BUILD_ID failed
EOF
  exit 0
fi

# Inside the cap window after the alert: hold the wake for the drain's ladder
# (≥10 min spacing, bounded) — never a 92 s retry per Stop, never a silent drop.
if [ "$GUARD" = "capped" ]; then
  [ -n "$DELIVER_CLAIM" ] && exit 75
  fm_event "$BUILD_ID" "wake-cap-held" "inside the 30 min cap window; wake deferred to the drain"
  [ -n "${FM_WAKE_DEFER_DISABLE:-}" ] || fm_build_wake_defer "$BUILD_ID" idle "wake-cap" "6 wakes/30min, alert already sent" "$TRANSCRIPT"
  exit 0
fi

# A held wake that comes due inside the 90s backoff waits for the next drain
# tick (≤2 min) — never a detached sleeper for a wake the cron already owns.
[ "$GUARD" = "skip" ] && [ -n "$DELIVER_CLAIM" ] && exit 75

if [ "$GUARD" = "skip" ]; then
  # Do NOT silently drop — the session may stay blocked indefinitely.
  # Write a self-contained retry script and detach it from the hook's process
  # group + pipe FDs so hook teardown (SIGHUP, SIGPIPE) cannot kill it.
  fm_event "$BUILD_ID" "wake-skipped-retry" "backoff <90s; retry pending in background"
  _bid="$BUILD_ID"
  _transcript="$TRANSCRIPT"
  _name="$(fm_meta "$BUILD_ID" name)"
  _agent="$(fm_meta "$BUILD_ID" agent)"
  _bin="$(cd "$(dirname "$0")" && pwd)"
  _sched_ts="$(date +%s)"
  _rf="$(mktemp /tmp/fm-wake-retry.XXXXXX.sh)"
  # Unquoted heredoc: outer vars ($_bid, $_bin, etc.) expand at write time.
  # Inner \$ escapes leave $TAIL etc. as runtime vars in the generated script.
  # <<'PY' markers become literal <<'PY' in the script (quoted inner heredoc).
  cat > "$_rf" <<RETRY_SCRIPT
#!/usr/bin/env bash
trap 'rm -f "$_rf"' EXIT
source "$_bin/lib.sh"
sleep 92
[ "\$(fm_status "$_bid")" = "active" ] || exit 0
# Resolved check: if foreman acted (steer/keys) since we scheduled, the session
# moved on — firing now would send a spurious STILL-WAITING wake.
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
  fm_event "$_bid" "wake-retry-resolved-noop" "session advanced during backoff; no wake needed"
  exit 0
fi
# wake-collision: in flight ⇒ HELD in the build's slot, not dropped.
if fm_wake_hold "$_bid" idle "stop-hook retry" "$_transcript"; then
  exit 0
fi
fm_event "$_bid" "wake" "retry after backoff skip"
fm_wake_lock_set "$_bid"
TAIL="\$(fm_transcript_tail "$_transcript" 1200)"
[ -z "\$TAIL" ] && TAIL="\$(tmux capture-pane -t "\$(fm_meta "$_bid" tmux)" -p 2>/dev/null | grep -vE '^\s*\$' | tail -15)"
STATUS_BLOCK="\$(fm_status_take_unwoken "$_bid")"
FM_BRIEF_PRODUCER="foreman_wake.sh:retry" \
FM_BRIEF_TRANSPORT="retry" \
fm_wake_michael <<__FOREMAN_WAKE_MSG__
(foreman wake retry — build $_bid / "$_name")
$GATE_RECONCILE_NOTICE

The $_agent build session was still idle after a suppressed wake (backoff <90s). Retry firing now.
---
\$TAIL
---
\$STATUS_BLOCK
You are the foreman. Read, decide, act — one of:
- DEFAULT — next step, or the NEXT WORK ORDER into this live session:
    $FOREMAN_ROOT/bin/build_say.sh $_bid "your instruction"
  A live session already holds the branch, the worktree and the test state. Rolling the next order
  through it beats closing and restarting; a fresh session pays the whole re-orientation tax again.
- Approve a pending permission dialog:  $FOREMAN_ROOT/bin/build_keys.sh $_bid approve
- Inspect deeper:  $FOREMAN_ROOT/bin/build_status.sh $_bid
- Build complete:  $FOREMAN_ROOT/bin/build_done.sh $_bid done
  Only at a real branch boundary or when the session is degrading. Closing the LAST active build kills
  your own wake source — if $FOREMAN_ROOT/QUEUE.md is non-empty, START THE NEXT ONE FIRST.
DECIDE: rule the call yourself. Stop only when the thing genuinely can't be built as drawn —
then bring the owner the constraint and the question, never a decision already made for them.
Your reply goes to the build's timeline, not the owner's chat. To ask the owner: $FOREMAN_ROOT/bin/build_ask.sh $_bid "<one question?>"
Never touch gateway config.
__FOREMAN_WAKE_MSG__
RETRY_SCRIPT
  chmod 700 "$_rf"
  # setsid: new session — survives SIGHUP from hook teardown.
  # </dev/null >/dev/null 2>&1: detach from hook's pipe FDs — prevents SIGPIPE.
  setsid bash "$_rf" </dev/null >/dev/null 2>&1 &
  disown
  exit 0
fi

if [ -n "$DELIVER_CLAIM" ]; then
  _kind="$(python3 -B "$FM_WAKE_STATE" slot-field --claim "$DELIVER_CLAIM" --key kind 2>/dev/null || true)"
  _held="$(python3 -B "$FM_WAKE_STATE" slot-field --claim "$DELIVER_CLAIM" --key count 2>/dev/null || true)"
  fm_event "$BUILD_ID" "wake" "waking michael — held wake delivered (kind=${_kind:-idle}, held=${_held:-1})"
  # The preamble rides in the blank line under the gate notice: empty for an
  # ordinary wake, so that message is byte-for-byte what it was.
  _pre="$(python3 -B "$FM_WAKE_STATE" preamble --build "$BUILD_ID" --claim "$DELIVER_CLAIM" 2>/dev/null || true)"
  [ -n "$_pre" ] && WAKE_PREAMBLE="
$_pre
"
else
  fm_event "$BUILD_ID" "wake" "waking michael"
fi
fm_wake_lock_set "$BUILD_ID"
TAIL="$(fm_transcript_tail "$TRANSCRIPT" 1200)"
# Codex-lane fallback: no Claude transcript → use a live pane snapshot.
[ -z "$TAIL" ] && TAIL="$(tmux capture-pane -t "$(fm_meta "$BUILD_ID" tmux)" -p 2>/dev/null | grep -vE '^\s*$' | tail -15)"
NAME="$(fm_meta "$BUILD_ID" name)"
AGENT="$(fm_meta "$BUILD_ID" agent)"
STATUS_CLAIM="$(fm_status_claim_unwoken "$BUILD_ID")"
STATUS_BLOCK=""
[ -n "$STATUS_CLAIM" ] && STATUS_BLOCK="$(fm_status_format_unwoken "$STATUS_CLAIM")"

FM_BRIEF_PRODUCER="foreman_wake.sh:idle-report" \
FM_BRIEF_TRANSPORT="idle-report" \
fm_wake_michael <<EOF
(foreman wake — build $BUILD_ID / "$NAME")
$GATE_RECONCILE_NOTICE
$WAKE_PREAMBLE
The $AGENT build session just went idle. Its last report:
---
$TAIL
---
$STATUS_BLOCK$FALSE_IDLE_NOTE
You are the foreman. Read, decide, act — one of:
- DEFAULT — next step, or the NEXT WORK ORDER into this live session:
    $FOREMAN_ROOT/bin/build_say.sh $BUILD_ID "your instruction"
  A live session already holds the branch, the worktree and the test state. Rolling the next order
  through it beats closing and restarting; a fresh session pays the whole re-orientation tax again.
  One session per integration lane — cut a new one only at a real branch boundary.
- Approve a pending permission dialog:  $FOREMAN_ROOT/bin/build_keys.sh $BUILD_ID approve
- Inspect deeper:  $FOREMAN_ROOT/bin/build_status.sh $BUILD_ID
- Build complete:  $FOREMAN_ROOT/bin/build_done.sh $BUILD_ID done   (the owner's "Build closed" is sent for you, once)
  Only at a real branch boundary or when the session is degrading. Closing the LAST active build kills
  your own wake source — if $FOREMAN_ROOT/QUEUE.md is non-empty, START THE NEXT ONE FIRST.
DECIDE: build to our own design — rule the call yourself and log it. Stop only when the thing
genuinely can't be built as drawn, and then bring the owner the constraint and the question,
never a decision already made for them.
Your reply to this wake goes to the build's timeline, not the owner's chat. To ask the owner: $FOREMAN_ROOT/bin/build_ask.sh $BUILD_ID "<one question?>"
Never touch gateway config as part of supervision.
EOF
WAKE_RC=$?

# ── wake-collision: a wake whose POST failed is HELD, not lost ──────────────
# rc 0 covers delivered AND refused-then-queued (the pending-wake queue keeps the payload); a
# non-zero rc is the gateway not answering. Put the status records back, and
# hold the wake in the slot for the drain — the deliver path's own drain
# restores its claim, so only the hook path re-holds.
fm_status_settle_unwoken "$BUILD_ID" "$STATUS_CLAIM" "$WAKE_RC"
if [ "$WAKE_RC" -ne 0 ]; then
  fm_event "$BUILD_ID" "wake-post-failed" "rc=$WAKE_RC — gateway did not take the wake"
  # The marker means "a wake was handed over at this time"; this one was not.
  # Left set, the held copy would later read as already said and be discarded.
  fm_wake_lock_clear "$BUILD_ID"
  [ -n "$DELIVER_CLAIM" ] && exit "$WAKE_RC"
  [ -n "${FM_WAKE_DEFER_DISABLE:-}" ] || \
    fm_build_wake_defer "$BUILD_ID" idle "stop-hook" "the gateway did not take it (rc=$WAKE_RC)" "$TRANSCRIPT"
fi
exit 0
