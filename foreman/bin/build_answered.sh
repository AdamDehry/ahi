#!/usr/bin/env bash
# build_answered.sh — the owner answered a build's question in the thread; say so on its timeline.
#
#   build_answered.sh <build-id> "<the answer, one plain line>"
#
# WHY: a card shows "one question for you" while the newest status record of
# one of its runs is a needs_owner, and only a LATER record from that run clears
# it. The owner answers in the thread, which reaches Michael as conversation and
# writes nothing on the build's timeline. When the question was asked AFTER the
# build closed (build_ask.sh on a closed build), no executor will ever post
# again, so the card would ask forever. This is the later record.
# build_finish.sh posts one too, so a shipped build never needs this.
# On a gateway without a status endpoint (rc 3) there is no card to clear; the
# answer is still recorded on the build ledger.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
FM_STATUS="${FM_STATUS:-$(dirname "$0")/fm_status.py}"
BUILD_ID="${1:?build id}"; shift
ANSWER="${*:?the answer, one plain line}"
[ -f "$BUILDS_DIR/$BUILD_ID/meta.json" ] || { echo "ERROR: no such build $BUILD_ID" >&2; exit 1; }
# Strict text rails up front (make is lax by design — the gateway would swap in fixed words).
ERRS="$(python3 -B -c 'import sys; sys.path.insert(0, sys.argv[1]); import fm_status as f
print("; ".join(f.line_errors(f.normalize_line(sys.argv[2]), f.CAP_LINE)))' "$(dirname "$FM_STATUS")" "$ANSWER")"
[ -z "$ERRS" ] || { echo "REFUSED: the answer must be one plain line ($ERRS)" >&2; exit 2; }
NAME="$(fm_meta "$BUILD_ID" name 2>/dev/null || true)"
REC="$(python3 -B "$FM_STATUS" make --build "$BUILD_ID" --source michael --kind progress \
         --finished "The owner answered the question." --now "$ANSWER" ${NAME:+--title "$NAME"})" || exit 2
if OUT="$(printf '%s' "$REC" | fm_status_post 2>&1)"; then
  fm_event "$BUILD_ID" "answered" "$ANSWER"
  echo "recorded: $OUT"
else
  rc=$?
  if [ "$rc" -eq 3 ]; then
    fm_event "$BUILD_ID" "answered" "$ANSWER"
    echo "recorded on the build ledger only (no status endpoint on this gateway): $OUT"
    exit 0
  fi
  fm_event "$BUILD_ID" "answered-failed" "rc=$rc"
  echo "ERROR: not recorded (rc=$rc): $OUT" >&2; exit 1
fi
