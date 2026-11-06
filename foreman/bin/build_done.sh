#!/usr/bin/env bash
# Close a build. Usage: build_done.sh <build-id> [done|failed|abandoned]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
# Branch-only close → "review, post the card, done". Optional: absent = no note.
[ -f "$(dirname "$0")/fm_branch_note.sh" ] && source "$(dirname "$0")/fm_branch_note.sh"

BUILD_ID="${1:?build id}"; STATUS="${2:-done}"

CURRENT="$(fm_status "$BUILD_ID")"
# Heartbeat race: a build the heartbeat marked failed ONLY because its tmux
# session was gone may still be closed as done — its
# executor may well have finished. Any other failed (or done, abandoned) stays
# final. The new status:done is appended; the ledger keeps the failed line.
if [ "$CURRENT" = "failed" ] && [ "$STATUS" = "done" ]; then
  LAST_DETAIL="$(python3 - "$BUILDS_DIR/$BUILD_ID/events.jsonl" <<'PY'
import json, sys
d = ""
for l in open(sys.argv[1]):
    try: e = json.loads(l)
    except ValueError: continue
    if str(e.get("type", "")).startswith("status:"): d = e.get("detail", "")
print(d)
PY
)"
  if [ "$LAST_DETAIL" = "heartbeat: tmux session gone" ]; then
    echo "NOTE: build $BUILD_ID was marked failed by the heartbeat (session gone); closing it as done" >&2
    fm_event "$BUILD_ID" "reopened-close" "failed (heartbeat: tmux session gone) -> done"
    CURRENT=active
  fi
fi
if [ "$CURRENT" != "active" ]; then
  echo "WARNING: build $BUILD_ID is already '$CURRENT' — refusing to close again" >&2
  exit 1
fi

# NOT `TMUX` — reserved by tmux and already exported inside a pane. Assigning to
# it made has-session below return false for a LIVE session, so closing a build
# from inside a pane skipped the kill entirely and left the runtime running with
# its build marked closed (an orphaned runtime).
TMUX_SESSION="$(fm_meta "$BUILD_ID" tmux)"

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  tmux send-keys -t "$TMUX_SESSION" "/exit" Enter; sleep 3
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  # Do not take the kill on faith. `kill-session` failing used to be swallowed by
  # `|| true`, which is what let an orphan survive a "closed" build in silence.
  # A close that did not close must SAY so — the ledger and the operator both
  # need to know the difference between "stopped" and "believed stopped".
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "WARNING: session $TMUX_SESSION SURVIVED close — orphaned runtime still running." >&2
    echo "         Kill by hand: tmux kill-session -t $TMUX_SESSION" >&2
    fm_event "$BUILD_ID" "orphan" "kill-session failed; $TMUX_SESSION still alive"
  fi
fi
fm_wake_lock_clear "$BUILD_ID"
fm_event "$BUILD_ID" "status:$STATUS" "closed by foreman"
echo "build $BUILD_ID closed: $STATUS"
GATE_RECONCILE_NOTICE="$(bash "$FOREMAN_ROOT/bin/foreman_wake.sh" --gate-reconcile-notice)"
printf '%s\n' "$GATE_RECONCILE_NOTICE"

# ── CHAIN GUARD ──────────────────────────────────────────────────────────────
# Foreman wakes originate ONLY from active builds (stop-hook + heartbeat).
# Closing the last one while work remains deletes the wake source, so a queued
# wave silently stops at Michael's briefing and waits on the owner to say "next."
# Detect the zero-active transition and make the gap itself a wake source.
ACTIVE=0
for d in "$BUILDS_DIR"/*/; do
  [ -f "$d/meta.json" ] || continue
  if [ "$(fm_status "$(basename "$d")")" = "active" ]; then ACTIVE=$((ACTIVE + 1)); fi
done

# A work order is an UNCHECKED task line: "- [ ] do the thing". Nothing else counts.
# Taking "the first non-comment, non-blank line" instead made a markdown separator
# ("---") or a stray line of prose read as an order and wake Michael on it.
# Commenting the offending line just moves the bug down a line; the parser was the defect.
# Tradeoff, deliberate: an order written WITHOUT the checkbox will not fire the chain.
# That is documented at the top of QUEUE.md. A chain that misses a badly-formatted order
# is safer than one that tries to start a build on a horizontal rule.
QUEUE="${FOREMAN_ROOT}/QUEUE.md"
NEXT="$(fm_queue_open | head -1)"

# ── THE CHAIN CHECKS THE GATES BEFORE IT NAMES A NEXT ITEM ─────────────────
# The parser above sees "- [ ]" and is structurally blind to the gate comment
# lines that block the item it is about to fire: the ruling can sit three lines
# from the order and the code that reads the order cannot see it. Left alone, the
# chain will keep auto-firing an item that several rulings say must not start.
#
# So the chain asks the gate source whether the item it found is gated, and if
# it is, it does not name it as next. It reports the queue as BLOCKED and quotes
# the rulings. fm_gates.py is the same machine-readable source the launcher and
# the PreToolUse guard read — one source, three consumers, which is the entire
# reason for having one rather than three greps.
#
# ADDITIVE: if fm_gates.py is absent NEXT_GATED stays empty and the chain
# behaves exactly as it did before. Rollback is deleting a file.
NEXT_GATED=""
if [ -n "$NEXT" ] && [ -x "$FOREMAN_ROOT/bin/fm_gates.py" ]; then
  NEXT_GATED="$("$FOREMAN_ROOT/bin/fm_gates.py" gates-blocking "$NEXT" 2>/dev/null || true)"
fi

# ── A TERMINAL BUILD OUTCOME IS A VISIBLE MILESTONE ────────────────────────
# A build that completes, fails or is abandoned is a BUILD PROGRESS milestone,
# declared automatically — never by a manual environment declaration.
#
# This script is the only place that KNOWS a build closed and what
# it closed as — $STATUS is its own argument. So the declaration is made here,
# structurally, by two routes that must agree:
#   * the header line `(foreman BUILD CLOSED … — status <s>)`, which fm_brief.py
#     recognises on its own. Load-bearing: it survives a deferred wake, a lost
#     environment, and anyone reading the ledger a month from now.
#   * FM_BRIEF_CLASS=PROGRESS on the call, as a brace. If the header ever drifts
#     the milestone still lands, and the drift is visible as axis=declaration
#     instead of axis=terminal-outcome.
#
# THE CHAIN DOES NOT BECOME A SECOND WAKE. If the only wake here were the chain
# wake (zero-active transition only), a build that closed while another ran would
# be invisible to the owner. So every close wakes exactly once and the queue state
# rides along as CONTEXT of that one event: the outcome is the event, continuation
# is infrastructure.
NAME="$(fm_meta "$BUILD_ID" name 2>/dev/null || true)"
CLOSE_CONTEXT="Active builds now: $ACTIVE"

if [ "$ACTIVE" -eq 0 ] && [ -n "$NEXT" ] && [ -n "$NEXT_GATED" ]; then
  fm_event "$BUILD_ID" "chain-blocked" "next queue item is GATED; no next action named"
  CLOSE_CONTEXT="$CLOSE_CONTEXT — zero active, and THE QUEUE IS BLOCKED.
The next unchecked item is GATED and is NOT named as a next action; the rulings say it does not start:
$NEXT_GATED
The item itself, for reference only: $NEXT
Ungate it on the record, or choose a different item deliberately. No build has been started."
  echo "chain BLOCKED: next item is gated, no action named"
elif [ "$ACTIVE" -eq 0 ] && [ -n "$NEXT" ]; then
  fm_event "$BUILD_ID" "chain-wake" "zero active builds, queue non-empty"
  CLOSE_CONTEXT="$CLOSE_CONTEXT — zero active, queue NOT empty.
Next in the queue: $NEXT
Full queue: $QUEUE
DO NOT STOP AT THE BRIEFING: the owner's 'Build closed' has already been sent from the record; start the next item with
$FOREMAN_ROOT/bin/build_start.sh and strike its line from $QUEUE once it is running. Better next time:
roll the next order into a LIVE session with build_say.sh instead of closing first."
  echo "chain wake fired: zero active, next = $NEXT"
elif [ "$ACTIVE" -eq 0 ]; then
  CLOSE_CONTEXT="$CLOSE_CONTEXT — zero active, and the queue holds no unchecked item."
fi

# A branch-only build closes into a review card, not a deploy.
BRANCH_NOTE=""
if declare -F fm_branch_close_note >/dev/null; then
  BRANCH_NOTE="$(fm_branch_close_note "$BUILD_ID" "$STATUS" "$(fm_meta "$BUILD_ID" workdir 2>/dev/null || true)" || true)"
fi
[ -n "$BRANCH_NOTE" ] && CLOSE_CONTEXT="$CLOSE_CONTEXT
$BRANCH_NOTE"

# ── FOREMAN MESSAGES: ONE CLOSE, ONCE ──────────────────────────────────────
# The owner's "Build closed" / "Build failed" is rendered by the gateway from a
# record, not by Michael from this wake. Forward anything the executor wrote
# since its last stop first — if it already sent its own closed record, the
# gateway has said the close and this one lands on the timeline only. The
# record id is fixed per build+status, so a re-run is a no-op. Fail-soft: a
# gateway without /foreman/status changes nothing below.
WORKDIR="$(fm_meta "$BUILD_ID" workdir 2>/dev/null || true)"
[ -n "$WORKDIR" ] && fm_status_forward "$BUILD_ID" "$WORKDIR"
# Ship lane (optional integration): a manifest in the worktree reaches the card as
# "built, awaiting review". Fail-soft; a gateway without the Ship flow skips it.
FM_SHIP_POST="${FM_SHIP_POST:-$FM_GATEWAY_DIR/scripts/ship/ship_post.py}"
if [ -n "$WORKDIR" ] && [ -f "$WORKDIR/.foreman/ship.json" ]; then
  if [ -x "$FM_SHIP_POST" ]; then
    SHIP_LIVE_DIR="$FM_GATEWAY_DIR" python3 -B "$FM_SHIP_POST" stage "$BUILD_ID" candidate manifest=@"$WORKDIR/.foreman/ship.json" >/dev/null 2>&1 || true
  else
    echo "note: ship manifest present but no Ship flow configured (FM_SHIP_POST) — skipped"
  fi
fi
fm_status_foreman_event "$BUILD_ID" "$STATUS" "$WORKDIR"
STATUS_BLOCK="$(fm_status_take_unwoken "$BUILD_ID")"

FM_BRIEF_CLASS=PROGRESS FM_BRIEF_BUILD_ID="$BUILD_ID" \
FM_BRIEF_PRODUCER="build_done.sh:terminal-close" \
FM_BRIEF_TRANSPORT="terminal-close" \
fm_wake_michael <<EOF || true
(foreman BUILD CLOSED — build $BUILD_ID / "$NAME" — status $STATUS)
$GATE_RECONCILE_NOTICE
$CLOSE_CONTEXT
$STATUS_BLOCK
EOF
