#!/usr/bin/env bash
# The OWNER of every open build. Runs every 10 min from cron (or a timer);
# `--if-open` is the fast tick (every 3 min, exits at once when no build is open).
#
# Install (UTC crontab; the lock is taken below, the KILL file is checked first):
#   */10 * * * * $FOREMAN_ROOT/bin/foreman_heartbeat.sh >> $FM_LOG_DIR/foreman-heartbeat.log 2>&1
#   */3  * * * * $FOREMAN_ROOT/bin/foreman_heartbeat.sh --if-open >> $FM_LOG_DIR/foreman-heartbeat.log 2>&1
# (write the expanded paths into the crontab; cron does not know these variables).
# Pause it without touching cron: touch $FOREMAN_ROOT/heartbeat.KILL
#
# The rule: whenever a build is started, something keeps working in the
# background to wake the supervisor, the builder, or whoever needs waking,
# until the build is completed. A plain dead-man's switch only SURFACES a dark
# build; this decides, per build, who is
# owed a wake and sends it — Michael through the build's wake slot (delivered by
# foreman_wake.sh), the builder through build_say.sh. fm_heartbeat.py decides;
# this file acts and logs. Every wake it sends is a `heartbeat-wake` event (cause,
# attempt, to whom, by what route, result); a cause that stays owed after its
# attempts gets ONE `heartbeat-escalate`, through build_ask.sh.
#
# It never marks a FINISHED build failed: a gone session whose executor recorded
# a close is a lost wake, and Michael is told to close it done.
#
# FEW WAKE CALL SITES. Every Michael wake here rides an existing route (the
# slot → foreman_wake.sh idle report, or the FIFO → lib.sh's replay) except the
# three direct ones below — died, dark, parked. Fewer call sites = fewer places
# a wake can be malformed or bypass the guards.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
HB="$FM_BIN_DIR/fm_heartbeat.py"

# KILL switch: an operator can stop every heartbeat action without editing cron.
FM_HB_KILL="${FM_HB_KILL:-$FOREMAN_ROOT/heartbeat.KILL}"
if [ -e "$FM_HB_KILL" ]; then
  printf '[%s] heartbeat paused: %s exists\n' "$(date -Is)" "$FM_HB_KILL"
  exit 0
fi

# ── the fast tick: nothing open, nothing to own ─────────────────────────────
if [ "${1:-}" = "--if-open" ]; then
  _open=0
  for d in "$BUILDS_DIR"/*/; do
    [ -f "$d/meta.json" ] || continue
    [ "$(fm_status "$(basename "$d")")" = "active" ] && { _open=1; break; }
  done
  [ "$_open" = 1 ] || exit 0
fi

# ── one tick at a time: two overlapping ticks must not double-wake ──────────
# fm_hold_lock.sh holds the lock for the life of this process and releases it on
# any exit. A second tick waits FM_HOLD_LOCK_WAIT (default 30s), then runs AFTER
# the first — every decision reads the ledger the first tick just wrote, so it
# sends nothing twice — or gives up. A lock dir that cannot be written fails
# OPEN: an unguarded heartbeat is better than none.
if [ -z "${FM_HB_LOCKED:-}" ]; then
  _lock="$FM_LOCKS_DIR/heartbeat.lock"
  if mkdir -p "$FM_LOCKS_DIR" 2>/dev/null && : >> "$_lock" 2>/dev/null; then
    FM_HB_LOCKED=1 exec bash "$FM_BIN_DIR/fm_hold_lock.sh" "$_lock" heartbeat bash "$0" "$@"
  fi
  echo "heartbeat: lock $_lock unusable — running unguarded" >&2
fi

hb_log() { printf '[%s] heartbeat %s\n' "$(date -Is)" "$*"; }

# heartbeat-wake: the one ledger line every heartbeat wake leaves behind.
hb_wake_event() { # id cause attempt to via result reason
  fm_event "$1" "heartbeat-wake" "cause=$2 attempt=$3 to=$4 via=$5 result=$6 — $7"
  hb_log "$1 wake cause=$2 attempt=$3 to=$4 via=$5 result=$6"
}

# One plain question to the owner, once per cause per episode, when Michael has not
# moved after the cause's attempts. build_ask.sh renders it in code.
hb_escalate() { # id cause question
  fm_event "$1" "heartbeat-escalate" "cause=$2 — $3"
  hb_log "$1 escalate cause=$2"
  bash "$FM_BIN_DIR/build_ask.sh" "$1" "$3" </dev/null >/dev/null 2>&1 \
    || fm_event "$1" "heartbeat-escalate-failed" "cause=$2 — build_ask.sh refused or could not deliver"
}

hb_escalate_question() { # cause
  case "$1" in
    lost-start)     echo "This build never received its brief and Michael has not answered three heartbeat wakes about it, should it be closed?" ;;
    close-pending)  echo "This build finished but its session is gone and Michael has not closed it after three heartbeat wakes, can you close it?" ;;
    chain-stalled)  echo "The last build closed and the next queued item has not started after three heartbeat wakes to Michael, should it start?" ;;
    *)              echo "Michael has not answered three heartbeat wakes about this build, can you look at it?" ;;
  esac
}

# Michael is owed a wake about an OPEN build. It goes into the build's own slot
# as kind=owed and out through foreman_wake.sh --deliver — the same idle report,
# rendered at delivery with the latest pane, transcript and status records, and
# the reason on top. A Michael turn already running ⇒ the 2-minute drain delivers it.
# $6 = esc | noesc (noesc: past max, the waiting ladder owns the follow-up).
# $7/$8 = an event to write ONLY when the wake goes out (never once per tick).
hb_owe_michael() { # id cause reason spacing max esc|noesc [event_type event_detail]
  local id="$1" cause="$2" reason="$3" verdict k flag=""
  [ "${6:-esc}" = "noesc" ] && flag="--no-escalate"
  read -r verdict k <<< "$(python3 -B "$HB" budget --build "$id" --cause "$cause" \
                             --spacing "$4" --max "$5" $flag 2>/dev/null)"
  case "$verdict" in
    wake)
      [ -z "${7:-}" ] || fm_event "$id" "$7" "${8:-}"
      fm_build_wake_defer "$id" owed heartbeat "$reason" </dev/null
      hb_wake_event "$id" "$cause" "$k" michael slot ok "$reason"
      fm_drain_pending_wakes "$id" </dev/null >/dev/null 2>&1 || true ;;
    escalate) hb_escalate "$id" "$cause" "$(hb_escalate_question "$cause")" ;;
    *) hb_log "$id owed cause=$cause quiet: ${k:-?}" ;;
  esac
}

# Put the foreman's hooks back if something stripped them (a gateway booted
# from the worktree can regenerate settings.json without the Stop hook).
# fm_settings_merge only ADDS what is missing and leaves the bytes alone when
# nothing is; the event is written only when the file actually changed.
hb_overlay() { # id workdir
  local id="$1" wd="$2" ov tmp="" before after
  [ "$(fm_meta "$id" runtime 2>/dev/null || echo claude)" = "codex" ] && return 0
  [ -n "$wd" ] && [ -d "$wd" ] || return 0
  ov="$BUILDS_DIR/$id/settings.overlay.json"
  if [ ! -r "$ov" ]; then
    # Launched before build_start kept its overlay: the hooks are what wakes
    # Michael, so re-assert at least those, spelled exactly as build_start does.
    tmp="$(mktemp /tmp/fm_hb_overlay.XXXXXX)" || return 0
    cat > "$tmp" <<EOF
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "$FOREMAN_ROOT/bin/foreman_wake.sh" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command", "command": "$FOREMAN_ROOT/bin/foreman_notify.sh" } ] }
    ]
  }
}
EOF
    ov="$tmp"
  fi
  mkdir -p "$wd/.claude" 2>/dev/null || { [ -z "$tmp" ] || rm -f "$tmp"; return 0; }
  before="$({ cksum < "$wd/.claude/settings.json"; } 2>/dev/null || echo absent)"
  if fm_settings_merge "$wd/.claude/settings.json" "$ov" 2>/dev/null; then
    after="$({ cksum < "$wd/.claude/settings.json"; } 2>/dev/null || echo absent)"
    if [ "$before" != "$after" ]; then
      fm_event "$id" "heartbeat-overlay-reasserted" "foreman hooks were missing from the workdir settings; merged back from $(basename "$ov")"
      hb_log "$id overlay re-asserted"
    fi
  else
    hb_log "$id overlay merge refused (see fm_settings_merge) — left as is"
  fi
  [ -z "$tmp" ] || rm -f "$tmp"
  return 0
}

# ── the three original wakes, unchanged in what they say ────────────────────
hb_died() { # id workdir
  local ID="$1" WORKDIR="$2"
  fm_event "$ID" "status:failed" "heartbeat: tmux session gone"
  # FOREMAN MESSAGES: the owner hears "stopped unexpectedly" once, rendered in code.
  fm_status_foreman_event "$ID" died "$WORKDIR"
  hb_wake_event "$ID" died 1 michael direct ok "tmux session gone, no close recorded"
  FM_BRIEF_PRODUCER="foreman_heartbeat.sh:died" \
  FM_BRIEF_TRANSPORT="heartbeat" \
  fm_wake_michael <<EOF
(foreman heartbeat — build $ID DIED)
Its tmux session is gone but the build was never closed. Inspect the transcript via $FOREMAN_ROOT/bin/build_status.sh $ID, tell the owner what happened, and decide whether to restart it with build_start.sh.
EOF
}

hb_dark() { # id workdir quiet why
  local ID="$1" WORKDIR="$2" QUIET="$3" WHY="$4" d="$BUILDS_DIR/$1" verdict k
  # Spaced like every other heartbeat wake. The dark-run cap below is what stops the loop.
  read -r verdict k <<< "$(python3 -B "$HB" budget --build "$ID" --cause dark --spacing "${FM_HB_DARK_SPACING:-1200}" --max 0 2>/dev/null)"
  [ "$verdict" = "wake" ] || { hb_log "$ID dark quiet: ${k:-?}"; return 0; }
  fm_event "$ID" "dark" "no transcript or pane activity ${QUIET}s; $WHY"

  # ── HOW MANY TIMES HAS THIS ALREADY FIRED WITH NO EFFECT? ─────────────────
  # An unanswered dark alarm can re-fire all night, waking a fresh supervisor
  # each time at real cost and reporting nothing, because a wake that fails
  # leaves no trace the next run can see. Count the TRAILING run of dark events.
  # ONLY A FOREMAN-PRODUCED EVENT RESETS IT — steer, status:, hold, resume.
  # Resetting on ANY non-dark event is weaker than it reads: a wedged build that
  # still emits its own `awaiting`/`idle` hook would zero the counter forever.
  # Build-side events are NEUTRAL: they neither count nor clear. The heartbeat's
  # own nudge is logged heartbeat-nudge, not steer, so it is neutral too.
  local DARK_RUN
  DARK_RUN="$(python3 -c "
import json
FOREMAN = ('steer', 'status:', 'hold', 'resume')
n = 0
for l in open('$d/events.jsonl'):
    try: t = json.loads(l).get('type','')
    except Exception: continue
    if t == 'dark': n += 1
    elif any(t.startswith(p) for p in FOREMAN): n = 0
print(n)" 2>/dev/null || echo 1)"
  case "$DARK_RUN" in ''|*[!0-9]*) DARK_RUN=1 ;; esac

  if [ "$DARK_RUN" -ge "${FM_DARK_MAX:-3}" ]; then
    # Three unanswered alarms is not a louder alarm, it is a broken one. Park
    # the build so the loop stops, and say so ONCE. The HOLD skip means no
    # further dark wake fires for it; the tmux-died check stays live, which
    # is the alarm that still matters while a build is parked.
    printf 'dark-cap: %s consecutive dark alarms with no foreman-produced event; parked %s\n' \
      "$DARK_RUN" "$(date -Is)" > "$d/HOLD"
    fm_event "$ID" "hold" "dark-cap: $DARK_RUN consecutive dark alarms, no foreman event between them — wake loop stopped"
    hb_wake_event "$ID" dark "$DARK_RUN" michael direct ok "parked after $DARK_RUN unanswered dark alarms"
    FM_BRIEF_PRODUCER="foreman_heartbeat.sh:parked" \
    FM_BRIEF_TRANSPORT="heartbeat" \
    fm_wake_michael <<EOF
(foreman heartbeat — build $ID PARKED after $DARK_RUN unanswered DARK alarms)
The dark alarm has now fired $DARK_RUN times on this build with no foreman-produced
event in between, so the wake loop is STOPPED and a HOLD file is written. No further
dark wake will fire for this build until the HOLD is removed.
READ THIS BEFORE ACTING: the previous alarms may have failed because YOUR OWN TURN
could not complete. Diagnose from METADATA ONLY — $d/events.jsonl, file mtimes under
$WORKDIR, process lines. Do NOT capture the build's pane into this conversation
(a wedged pane pulled into the supervisor's turn can wedge that turn too, alarm after
alarm). If the pane must be read, read it in a throwaway session and bring back a
classification, not its content.
Then: close it, or clear $d/HOLD to resume alarms.
EOF
  else
    # FOREMAN MESSAGES: the owner hears "went dark" once per build (gateway-side
    # dedupe), rendered in code; the alarm count and diagnosis stay Michael's.
    fm_status_foreman_event "$ID" dark "$WORKDIR"
    hb_wake_event "$ID" dark "$DARK_RUN" michael direct ok "$WHY after ${QUIET}s quiet"
    FM_BRIEF_PRODUCER="foreman_heartbeat.sh:dark" \
    FM_BRIEF_TRANSPORT="heartbeat" \
    fm_wake_michael <<EOF
(foreman heartbeat — build $ID has gone DARK, alarm $DARK_RUN of ${FM_DARK_MAX:-3})
No transcript or pane activity for $((QUIET / 60)) minutes while the session is
supposedly working, and the heartbeat's "status?" nudge to the builder got no turn
($WHY). Likely a hung permission dialog or a wedged turn.
Diagnose from METADATA FIRST — $d/events.jsonl, file mtimes under $WORKDIR, and the
process lines — then approve, steer, or close it. Do NOT pipe the build's transcript
or pane into this conversation as a first move. If you must see the pane,
read it in a throwaway session and bring back a classification, not its content.
EOF
  fi
}

# ── the builder is owed a wake ──────────────────────────────────────────────
hb_nudge() { # id workdir quiet
  local ID="$1" WORKDIR="$2" QUIET="$3" TS state rc=0
  TS="$(fm_meta "$ID" tmux)"
  # Only into an EMPTY composer: text typed into a permission menu would be read
  # as a choice, and a composer already holding text is someone else's message.
  state="$(fm_composer_state "$TS" "$(fm_meta "$ID" runtime 2>/dev/null || true)")"
  if [ "$state" != "empty" ]; then
    hb_wake_event "$ID" stall 1 builder say failed "composer=$state, not typing into it; quiet ${QUIET}s"
    hb_dark "$ID" "$WORKDIR" "$QUIET" "the nudge was not sent: composer=$state"
    return 0
  fi
  FM_SAY_EVENT=heartbeat-nudge bash "$FM_BIN_DIR/build_say.sh" "$ID" \
    "status? — foreman heartbeat: this session has shown no activity for $((QUIET / 60)) minutes. Reply in one line with what you are doing. If you are finished, record your close and stop." \
    </dev/null >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    hb_wake_event "$ID" stall 1 builder say ok "quiet ${QUIET}s"
  else
    hb_wake_event "$ID" stall 1 builder say failed "build_say rc=$rc; quiet ${QUIET}s"
    hb_dark "$ID" "$WORKDIR" "$QUIET" "the nudge could not be delivered"
  fi
}

# Lost start: the launch logged its gates, the brief never submitted. Re-send the
# brief build_start composed and gate-checked — the meta.json prompt PLUS the
# active gates verbatim (gates must be carried); the bare prompt carries no gate block and is
# never sent on its own. A second failure goes to Michael.
hb_resubmit() { # id workdir attempt
  local ID="$1" WORKDIR="$2" K="$3" BRIEF_FILE rc=0
  BRIEF_FILE="$(python3 -B "$HB" brief --build "$ID" 2>/dev/null)" || BRIEF_FILE=""
  if [ -z "$BRIEF_FILE" ]; then
    hb_wake_event "$ID" resubmit "$K" builder say failed "no composed brief for this build to re-send"
    hb_lost_start "$ID" "the composed brief was not found, so nothing was re-sent"
    return 0
  fi
  FM_SAY_EVENT=heartbeat-resubmit bash "$FM_BIN_DIR/build_say.sh" "$ID" "$(cat "$BRIEF_FILE")" \
    </dev/null >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    hb_wake_event "$ID" resubmit "$K" builder say ok "lost start: brief never submitted; re-sent the composed brief"
  else
    hb_wake_event "$ID" resubmit "$K" builder say failed "lost start: re-send did not submit (build_say rc=$rc)"
    hb_lost_start "$ID" "the re-send did not submit either (build_say rc=$rc)"
  fi
}

hb_lost_start() { # id why
  hb_owe_michael "$1" lost-start \
    "lost start: the launch logged its gates but the brief never reached the session; $2. The composer is empty and nothing has run. Read the pane, then re-send the brief with build_say or close it abandoned" \
    "${FM_HB_SPACING:-1200}" 3 esc
}

# ── per build ───────────────────────────────────────────────────────────────
for d in "$BUILDS_DIR"/*/; do
  [ -f "$d/meta.json" ] || continue
  ID="$(basename "$d")"
  [ "$(fm_status "$ID")" = "active" ] || continue
  # NOT `TMUX` — reserved by tmux and already exported inside a pane. Assigning
  # to it made has-session fail for EVERY live build, so a heartbeat run from
  # inside a pane would mark every healthy build "failed" and wake Michael for
  # each one. (fm_heartbeat.py reads the session name from meta.json.)
  WORKDIR="$(fm_meta "$ID" workdir)"

  hb_overlay "$ID" "$WORKDIR"
  read -r ACT A1 A2 <<< "$(python3 -B "$HB" plan --build "$ID" 2>/dev/null || echo "none plan-error")"

  case "$ACT" in
    died|close-pending)
      # Session gone. Re-read the executor's status tail and forward anything it
      # wrote BEFORE deciding — a close it recorded must reach the owner as a close.
      # KNOWN FALSE POSITIVE: a build whose final command restarts the gateway
      # service can kill its own tmux when foreman sessions live in the gateway's
      # cgroup. A recorded close takes the close-pending branch instead of being
      # called a death.
      fm_status_forward "$ID" "$WORKDIR"
      read -r ACT A1 A2 <<< "$(python3 -B "$HB" plan --build "$ID" 2>/dev/null || echo "died")"
      if [ "$ACT" = "close-pending" ]; then
        # Never mark it failed. It finished; its wake was lost with its session.
        hb_owe_michael "$ID" close-pending \
          "its session is gone, but its executor recorded the build CLOSED $((A1 / 60)) min ago. It finished; the close wake was lost with the session. Close it done with build_done. Do not mark it failed" \
          "${FM_HB_SPACING:-1200}" 1 noesc \
          heartbeat-close-pending "session gone, executor recorded closed $((A1 / 60)) min ago — not marking failed"
      else
        hb_died "$ID" "$WORKDIR"
      fi ;;
    resubmit) hb_resubmit "$ID" "$WORKDIR" "$A1" ;;
    lost-start) hb_lost_start "$ID" "the heartbeat already re-sent the composed brief ${A1} time(s) and it still did not take" ;;
    recover-lost)
      fm_status_forward "$ID" "$WORKDIR"
      fm_event "$ID" "heartbeat-recovered" "executor recorded $A1 $((A2 / 60)) min ago and no stop-hook wake followed — forwarded it, waking Michael"
      hb_owe_michael "$ID" lost-close \
        "lost wake recovered: the executor recorded $A1 $((A2 / 60)) min ago and its stop hook never reported it, so the record was forwarded now. Act on it" \
        "${FM_HB_SPACING:-1200}" 1 noesc ;;
    remind-needs-owner)
      hb_owe_michael "$ID" needs-owner \
        "reminder: this build has waited on the OWNER for $A1 min. The owner has the question; nothing has moved since. No storm: re-ask once if it matters, rule it yourself if it is yours to rule, or park it with a HOLD. Next reminder in 6 h" \
        0 0 esc ;;
    nudge) hb_nudge "$ID" "$WORKDIR" "$A1" ;;
    dark)
      case "$A2" in
        nudge-not-delivered) hb_dark "$ID" "$WORKDIR" "$A1" "the nudge could not be delivered" ;;
        *) hb_dark "$ID" "$WORKDIR" "$A1" "no turn within $(( ${FM_HB_NUDGE_ANSWER:-300} / 60 )) min of the nudge" ;;
      esac ;;
    *) : ;;   # none, held — nothing owed this tick
  esac
done

# ── the chain: a build closed done, the queue has a runnable next item, and
# nothing has launched for 10 min → Michael is owed "chain stalled after <id>".
# The closed build is not active, so the slot cannot carry this one: it goes
# through the FIFO and lib.sh's replay, with its reason said out loud.
read -r C_ACT C_ID C_AGE C_NEXT <<< "$(python3 -B "$HB" chain 2>/dev/null || echo none)"
if [ "$C_ACT" = "stalled" ]; then
  C_GATED=""
  if [ -x "$FOREMAN_ROOT/bin/fm_gates.py" ]; then
    C_GATED="$("$FOREMAN_ROOT/bin/fm_gates.py" gates-blocking "$C_NEXT" 2>/dev/null || true)"
  fi
  if [ -n "$C_GATED" ]; then
    hb_log "$C_ID chain: next item is gated — build_done already reported the queue blocked"
  else
    read -r V K <<< "$(python3 -B "$HB" budget --build "$C_ID" --cause chain-stalled --spacing "${FM_HB_SPACING:-1200}" --max 3 2>/dev/null)"
    case "$V" in
      wake)
        hb_wake_event "$C_ID" chain-stalled "$K" michael fifo ok "zero active $((C_AGE / 60)) min after the close; next: $C_NEXT"
        FM_PENDING_WHY="the chain stalled after $C_ID" FM_BRIEF_BUILD_ID="$C_ID" \
        fm_queue_pending_wake "foreman_heartbeat.sh" <<EOF || true
(foreman heartbeat — CHAIN STALLED after build $C_ID, wake $K of 3)
That build closed done $((C_AGE / 60)) minutes ago. Zero builds are active and nothing has
launched since, but the queue has an unchecked, ungated next item:
$C_NEXT
Start it with $FOREMAN_ROOT/bin/build_start.sh and strike its line from the queue,
or record why it waits. After wake 3 the owner is asked once whether it should start.
EOF
        ;;
      escalate) hb_escalate "$C_ID" chain-stalled "$(hb_escalate_question chain-stalled)" ;;
      *) hb_log "$C_ID chain stalled, quiet: ${K:-?}" ;;
    esac
  fi
fi

# ── WAKE-COLLISION: the waiting-on-Michael ladder, then one held wake ────────
# The 2-minute cron (fm_stop_watch.sh) runs both on its own; running them here too
# means a dead cron cannot strand a held wake or a waiting build. Both are
# idempotent: the sweep takes a lock and spaces re-wakes by ledger time, and
# every drain claims its item atomically.
fm_waiting_sweep || true
fm_drain_pending_wakes || true
