#!/usr/bin/env bash
# Codex `notify` hook shim. Codex invokes: <script> <build-id> <json-payload>.
#
# Codex emits agent-turn-complete for both its auxiliary title thread and the
# real work thread. A notify is suppressed only when BOTH structural identity
# says "auxiliary" and the measured TUI spinner says "working". All
# unknown/error states fail toward the wake channel. Suppression starts a
# bounded recheck worker; it never drops the wake. A notify hook must never
# break the builder's session, so every path exits 0.
set -uo pipefail

BUILD_ID="${1:-}"
PAYLOAD="${2:-}"
[ -z "$BUILD_ID" ] && exit 0

AHI_HOME="${FM_AHI_HOME:-${AHI_HOME:-$HOME/ahi}}"
FOREMAN_ROOT="${FOREMAN_ROOT:-$AHI_HOME/foreman}"
BUILDS_DIR="${BUILDS_DIR:-$FOREMAN_ROOT/builds}"
FM1_WAKE_SCRIPT="${FM1_WAKE_SCRIPT:-$FOREMAN_ROOT/bin/foreman_wake.sh}"
# A ~40 min ceiling (30s x 80). A short cap (say 60s) fires fail-open on every
# real codex build: they run 5-25 minutes, so the cap is hit while the pane is
# still legitimately "working" and the supervisor is woken mid-work. The loop
# fires early the moment the pane goes idle, so a long ceiling costs nothing.
# If this watcher dies, the stop-watch and heartbeat paths still catch completion.
FM1_RETRY_INTERVAL_SECONDS="${FM1_RETRY_INTERVAL_SECONDS:-30}"
FM1_RETRY_MAX_CHECKS="${FM1_RETRY_MAX_CHECKS:-80}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

# The retry entrypoint deliberately uses the same script so there is no
# generated temporary program whose behaviour can drift from this decision.
MODE="notify"
if [ "${1:-}" = "--retry" ]; then
  MODE="retry"
  BUILD_ID="${2:-}"
  WORKDIR="${3:-}"
  TMUX_NAME="${4:-}"
  SCHEDULED_TOKEN="${5:-}"
fi

if ! source "$FOREMAN_ROOT/bin/lib.sh" 2>/dev/null; then
  # The shared helper is itself allowed to fail, but that must not silently
  # consume the only wake. Reconstruct only the legacy cwd payload and send it
  # through the existing wake script; no suppression is attempted.
  FALLBACK_WORKDIR="$(python3 - "$BUILDS_DIR/$BUILD_ID/meta.json" <<'PY' 2>/dev/null
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["workdir"])
PY
)" || FALLBACK_WORKDIR=""
  if [ -n "$FALLBACK_WORKDIR" ] && [ -x "$FM1_WAKE_SCRIPT" ]; then
    printf '{"cwd": "%s", "transcript_path": ""}' "$FALLBACK_WORKDIR" | "$FM1_WAKE_SCRIPT"
    exit 0
  fi
  printf '%s\n' "codex-notify UNKNOWN: cannot load wake library or fallback wake path" >&2
  exit 0
fi

fm1_direct_alert() {
  local reason="$1"
  FM_BRIEF_PRODUCER="foreman_codex_notify.sh:unknown" \
  FM_BRIEF_TRANSPORT="codex-notify" \
  fm_wake_michael <<EOF
(foreman Codex notify UNKNOWN — build $BUILD_ID)
The Codex notify shim refused to suppress this notification: $reason
Inspect: $FOREMAN_ROOT/bin/build_status.sh $BUILD_ID
EOF
}

fm1_fire_wake() {
  local workdir="$1"
  if [ -x "$FM1_WAKE_SCRIPT" ]; then
    # The same {cwd, transcript_path} payload a Claude Stop hook sends.
    printf '{"cwd": "%s", "transcript_path": ""}' "$workdir" | "$FM1_WAKE_SCRIPT"
  else
    fm1_direct_alert "wake script unavailable: $FM1_WAKE_SCRIPT"
  fi
}

# Three states. Recognised forms are deliberately pinned in one place and were
# measured against one Codex CLI release — re-measure after upgrading. A cosmetic
# UI rename must return unknown (wake), never working (suppress).
fm1_pane_state() {
  local tmux_name="$1" pane rc
  if ! command -v timeout >/dev/null 2>&1 || ! command -v tmux >/dev/null 2>&1; then
    printf '%s\n' unknown
    return 0
  fi
  pane="$(timeout 3 tmux capture-pane -t "$tmux_name" -p 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' unknown
  elif printf '%s\n' "$pane" | grep -Eq 'Working \([^)]*\)|esc to interrupt'; then
    printf '%s\n' working
  elif printf '%s\n' "$pane" | grep -Fq '› Ask Codex to do anything'; then
    printf '%s\n' idle
  else
    printf '%s\n' unknown
  fi
}

# Structural discriminator measured before this patch: the real completion's
# thread-id equals session_meta.payload.id in an exact-workdir rollout. The
# intermediate title generator has the same event type but no such rollout.
# stdout is only the state; rollout content is never rendered.
fm1_thread_state() {
  local workdir="$1" thread_id="$2"
  python3 - "$CODEX_HOME" "$workdir" "$thread_id" <<'PY'
import json
import pathlib
import sys

root, workdir, thread_id = sys.argv[1:]
if not thread_id:
    print("unknown")
    raise SystemExit

ids = set()
try:
    for path in pathlib.Path(root, "sessions").glob("*/*/*/rollout-*.jsonl"):
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                row = json.loads(line)
                if row.get("type") != "session_meta":
                    continue
                payload = row.get("payload") or {}
                if payload.get("cwd") == workdir and payload.get("id"):
                    ids.add(str(payload["id"]))
                break
except Exception:
    print("unknown")
    raise SystemExit

if not ids:
    print("unknown")
elif thread_id in ids:
    print("main")
else:
    print("auxiliary")
PY
}

fm1_elapsed_from_ledger() {
  python3 - "$BUILDS_DIR/$BUILD_ID/events.jsonl" <<'PY'
import json
import sys
import time

try:
    started = None
    with open(sys.argv[1], encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            if row.get("type") == "started":
                started = int(row["ts"])
    print(max(0, int(time.time()) - started) if started is not None else "unknown")
except Exception:
    print("unknown")
PY
}

fm1_main_notify_since() {
  python3 - "$BUILDS_DIR/$BUILD_ID/events.jsonl" "$1" <<'PY'
import json
import sys

try:
    token = sys.argv[2]
    after_marker = False
    with open(sys.argv[1], encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            if row.get("type") == "codex-wake-deferred" and f"token={token}" in row.get("detail", ""):
                after_marker = True
            elif after_marker and row.get("type") == "codex-main-notify":
                print("yes")
                raise SystemExit
except Exception:
    pass
print("no")
PY
}

fm1_retry() {
  local lock_file status check pane_state
  lock_file="$BUILDS_DIR/$BUILD_ID/codex-notify-retry.lock"
  if ! command -v flock >/dev/null 2>&1; then
    fm_event "$BUILD_ID" "codex-wake-retry-unknown" "flock unavailable; waking"
    fm1_fire_wake "$WORKDIR"
    return
  fi
  exec 9>"$lock_file" || {
    fm_event "$BUILD_ID" "codex-wake-retry-unknown" "retry lock unavailable; waking"
    fm1_fire_wake "$WORKDIR"
    return
  }
  if ! flock -n 9; then
    fm_event "$BUILD_ID" "codex-wake-retry-dedup" "bounded recheck already armed"
    return
  fi

  for ((check=1; check<=FM1_RETRY_MAX_CHECKS; check++)); do
    sleep "$FM1_RETRY_INTERVAL_SECONDS"

    status="$(fm_status "$BUILD_ID" 2>/dev/null)" || status="unknown"
    case "$status" in
      done|failed|abandoned|stalled)
        fm_event "$BUILD_ID" "codex-wake-retry-resolved-noop" "build status=$status"
        return
        ;;
      active) ;;
      *)
        fm_event "$BUILD_ID" "codex-wake-retry-unknown" "build status unreadable; waking"
        fm1_fire_wake "$WORKDIR"
        return
        ;;
    esac

    if [ "$(fm1_main_notify_since "$SCHEDULED_TOKEN")" = "yes" ]; then
      fm_event "$BUILD_ID" "codex-wake-retry-resolved-noop" "main-thread notify arrived"
      return
    fi

    pane_state="$(fm1_pane_state "$TMUX_NAME")" || pane_state="unknown"
    fm_event "$BUILD_ID" "codex-wake-retry-check" "check=$check/$FM1_RETRY_MAX_CHECKS pane=$pane_state"
    case "$pane_state" in
      idle|unknown)
        fm_event "$BUILD_ID" "codex-wake-retry-fire" "pane=$pane_state after deferred auxiliary notify"
        fm1_fire_wake "$WORKDIR"
        return
        ;;
      working)
        if [ "$check" -eq "$FM1_RETRY_MAX_CHECKS" ]; then
          fm_event "$BUILD_ID" "codex-wake-retry-cap" "still working at cap; waking fail-open"
          fm1_fire_wake "$WORKDIR"
          return
        fi
        ;;
      *)
        fm_event "$BUILD_ID" "codex-wake-retry-unknown" "detector returned invalid state; waking"
        fm1_fire_wake "$WORKDIR"
        return
        ;;
    esac
  done
}

if [ "$MODE" = "retry" ]; then
  [ -n "$BUILD_ID" ] && [ -n "$WORKDIR" ] && [ -n "$TMUX_NAME" ] || {
    fm1_direct_alert "retry arguments missing"
    exit 0
  }
  fm1_retry
  exit 0
fi

META="$BUILDS_DIR/$BUILD_ID/meta.json"
META_FIELDS="$(python3 - "$META" <<'PY'
import json
import sys

try:
    row = json.load(open(sys.argv[1], encoding="utf-8"))
    workdir = row["workdir"]
    tmux_name = row["tmux"]
    if "\t" in workdir or "\t" in tmux_name:
        raise ValueError("tab in metadata")
    print(f"{workdir}\t{tmux_name}")
except Exception:
    raise SystemExit(1)
PY
)" || {
  fm1_direct_alert "build metadata unreadable"
  exit 0
}
IFS=$'\t' read -r WORKDIR TMUX_NAME <<< "$META_FIELDS"

PAYLOAD_FIELDS="$(printf '%s' "$PAYLOAD" | python3 -c '
import json, sys
try:
    row = json.load(sys.stdin)
    event_type = str(row.get("type", ""))
    thread_id = str(row.get("thread-id", ""))
    if "\t" in event_type or "\t" in thread_id:
        raise ValueError("tab in payload")
    print(f"{event_type}\t{thread_id}")
except Exception:
    raise SystemExit(1)
' 2>/dev/null)" || {
  fm_event "$BUILD_ID" "codex-notify-unknown" "payload unreadable; waking"
  fm1_fire_wake "$WORKDIR"
  exit 0
}
IFS=$'\t' read -r TYPE THREAD_ID <<< "$PAYLOAD_FIELDS"

case "$TYPE" in
  agent-turn-complete) ;;
  *) exit 0 ;;
esac

# Cheap telemetry comes only from the recorded started event. Elapsed time is
# intentionally never used in a branch: a genuine intermediate pause occurred
# seven seconds after launch, so no duration threshold can decide idleness.
ELAPSED="$(fm1_elapsed_from_ledger)" || ELAPSED="unknown"
THREAD_STATE="$(fm1_thread_state "$WORKDIR" "$THREAD_ID" 2>/dev/null)" || THREAD_STATE="unknown"
fm_event "$BUILD_ID" "codex-notify-observed" "thread=$THREAD_STATE elapsed_since_started=${ELAPSED}s"

case "$THREAD_STATE" in
  main)
    fm_event "$BUILD_ID" "codex-main-notify" "exact-workdir rollout identity matched"
    fm1_fire_wake "$WORKDIR"
    ;;
  auxiliary)
    PANE_STATE="$(fm1_pane_state "$TMUX_NAME")" || PANE_STATE="unknown"
    if [ "$PANE_STATE" != "working" ]; then
      fm_event "$BUILD_ID" "codex-notify-unsuppressed" "auxiliary thread pane=$PANE_STATE; waking"
      fm1_fire_wake "$WORKDIR"
      exit 0
    fi

    SCHEDULED_TOKEN="$(date +%s)-$$-${RANDOM:-0}"
    fm_event "$BUILD_ID" "codex-wake-deferred" "token=$SCHEDULED_TOKEN auxiliary thread + codex spinner; interval=${FM1_RETRY_INTERVAL_SECONDS}s cap=$FM1_RETRY_MAX_CHECKS"
    if ! command -v setsid >/dev/null 2>&1; then
      fm_event "$BUILD_ID" "codex-wake-deferral-unknown" "setsid unavailable; waking"
      fm1_fire_wake "$WORKDIR"
      exit 0
    fi
    setsid "$0" --retry "$BUILD_ID" "$WORKDIR" "$TMUX_NAME" "$SCHEDULED_TOKEN" </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null || true
    ;;
  *)
    fm_event "$BUILD_ID" "codex-notify-unknown" "thread identity unavailable; waking"
    fm1_fire_wake "$WORKDIR"
    ;;
esac
