#!/usr/bin/env bash
# Put ONE question in front of the owner about a build, rendered in code:
#   **I need you — <build>**
#   <the question>
# Usage: build_ask.sh <build-id> "<one question, ending in ?>"
# Michael's path to the owner's chat while wake replies stay on the build
# timeline. Refused — exit 2 with reasons — if the question carries brackets,
# paths, gate ids, markup or more than one ?.
# Needs a gateway with a status endpoint (FM_STATUS_ENDPOINT, see lib.sh). On a
# gateway without one the question is recorded on the build ledger and Michael
# is told to ask the owner in his own reply instead (exit 0).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

BUILD_ID="${1:?build id}"; shift
QUESTION="${*:?question}"
[ -f "$BUILDS_DIR/$BUILD_ID/meta.json" ] || { echo "ERROR: no such build $BUILD_ID" >&2; exit 1; }
NAME="$(fm_meta "$BUILD_ID" name 2>/dev/null || true)"
WORKDIR="$(fm_meta "$BUILD_ID" workdir 2>/dev/null || true)"

REC="$(python3 -B "$FM_STATUS" foreman --build "$BUILD_ID" --event ask --question "$QUESTION" \
         ${WORKDIR:+--workdir "$WORKDIR"} ${NAME:+--title "$NAME"})" || exit 2
if OUT="$(printf '%s' "$REC" | fm_status_post 2>&1)"; then
  fm_event "$BUILD_ID" "ask" "$QUESTION"
  echo "asked: $OUT"
else
  rc=$?
  if [ "$rc" -eq 3 ]; then
    # Optional integration absent: the gateway has no status endpoint. The
    # question is still an ask (the waiting sweep must not nag a build that is
    # waiting on the owner), so it is ledgered — and the owner gets it from
    # Michael's reply, which /ui/send already puts in the owner's chat.
    fm_event "$BUILD_ID" "ask" "$QUESTION"
    echo "NOTE: this gateway has no status endpoint ($OUT)." >&2
    echo "      The question is recorded on $BUILD_ID's ledger; put it to the owner in your own reply." >&2
    exit 0
  fi
  fm_event "$BUILD_ID" "ask-failed" "rc=$rc $QUESTION"
  echo "ERROR: question NOT delivered (rc=$rc): $OUT" >&2
  exit 1
fi
