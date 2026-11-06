#!/usr/bin/env bash
# build_finish.sh — the LAST step of every ship: once the owner has given the OK, the
# change is shipped and the build is closed out, and its copy is archived and removed.
#
#   build_finish.sh <build-id> --shipped <repo>@<sha> [--review rv-…] [--owner-said "…"]
#                   [--keep-copy] [--dry-run]
#
# Run it once the change is shipped — a Ship flow (optional gateway integration) may run
# it itself; otherwise Michael runs it after his ff-merge + push. In order:
#   1. proof first, nothing changed yet: <sha> exists in <repo> and CONTAINS the build's
#      tip (a finish that cannot show the work shipped refuses), and the owner's OK is on
#      the record — the review card approved (or done), --owner-said in their words, or the
#      ledger's ship:ok from a Ship tap. No recorded OK → refused.
#   2. the build closed `done` in the ledger (build_done.sh if still active) + a
#      `finished` event naming <repo>@<sha>.
#   3. OPTIONAL review cards (FM_REVIEW_MJS / FM_REVIEW_CLI): the review item marked done;
#      the build's card closed (every row of it) — review.mjs build-close, falling back to
#      track-close of its own row on a gateway without that verb. Absent → skipped, noted.
#   4. the copy: fm_close.py clean --finished — keepers archived (local archive by default,
#      restic when configured), the archive read back, THEN git worktree remove + the merged
#      branch deleted. Any doubt holds the copy and says why; the close above stands either way.
#   5. one progress record on the build's timeline (also clears a stale question).
# Idempotent: re-running a finished build changes nothing that is already done.
# Exit 0 finished · 2 refused (nothing changed) · 3 finished, copy held · 1 copy failed.
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"
source "$BIN/lib.sh"
FM_STATUS="${FM_STATUS:-$BIN/fm_status.py}"
FM_REVIEW_MJS="${FM_REVIEW_MJS:-$FM_GATEWAY_DIR/scripts/review.mjs}"   # optional review-card CLI

BUILD_ID="${1:?usage: build_finish.sh <build-id> --shipped <repo>@<sha> [--review rv-…] [--owner-said \"…\"] [--keep-copy] [--dry-run]}"; shift
SHIPPED=""; REVIEW=""; SAID=""; KEEP=""; DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --shipped) shift; SHIPPED="${1:?repo@sha}" ;;
    --review) shift; REVIEW="${1:?review id}" ;;
    --owner-said) shift; SAID="${1:?the owner words}" ;;
    --keep-copy) KEEP=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "build_finish: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
refuse() { echo "build_finish: REFUSED — $*" >&2; exit 2; }
run() { if [ -n "$DRY" ]; then printf 'would: %s\n' "$*"; else "$@"; fi; }
[ -f "$BUILDS_DIR/$BUILD_ID/meta.json" ] || refuse "no such build in the ledger: $BUILD_ID"
case "$SHIPPED" in *@*) ;; *) refuse "--shipped <repo>@<sha> is required" ;; esac
REPO="${SHIPPED%@*}"; SHA_IN="${SHIPPED##*@}"

# Card + review calls go through the gateway's own CLI, which reads its token in-process
# and never prints it. A harness ledger never reaches the live desk (same rule as
# fm_status_post) unless a test hands us its own CLI. Review cards are an OPTIONAL
# integration: no review.mjs → every card call is skipped with a note.
REVIEW_CLI=()
if [ -n "${FM_REVIEW_CLI:-}" ]; then read -ra REVIEW_CLI <<<"$FM_REVIEW_CLI"
elif ! fm_is_live; then REVIEW_SKIP="harness ledger"
elif [ -f "$FM_REVIEW_MJS" ]; then REVIEW_CLI=("$(command -v node || echo /usr/local/bin/node)" "$FM_REVIEW_MJS")
else REVIEW_SKIP="no review cards configured (FM_REVIEW_MJS)"; fi
review() { [ ${#REVIEW_CLI[@]} -gt 0 ] || { echo "($REVIEW_SKIP: desk call skipped)"; return 0; }; "${REVIEW_CLI[@]}" "$@"; }

# ── 1. proof, before anything changes ──────────────────────────────────
SHA="$(git -C "$REPO" rev-parse --verify --quiet "$SHA_IN^{commit}" 2>/dev/null)" || refuse "$SHA_IN is not a commit in $REPO"
WORKDIR="$(fm_meta "$BUILD_ID" workdir 2>/dev/null || true)"
TIP=""
if [ -n "$WORKDIR" ] && [ -e "$WORKDIR" ]; then
  TIP="$(git -C "$WORKDIR" rev-parse HEAD 2>/dev/null)" || refuse "the build's workdir $WORKDIR is not a git tree"
  git -C "$REPO" merge-base --is-ancestor "$TIP" "$SHA" 2>/dev/null \
    || refuse "the shipped commit ${SHA:0:12} does not contain this build's work (tip ${TIP:0:12}) — ship it first"
fi

REVIEW_STATE=""
if [ -n "$REVIEW" ] && [ ${#REVIEW_CLI[@]} -eq 0 ]; then
  echo "($REVIEW_SKIP: review item $REVIEW not read)"
elif [ -n "$REVIEW" ]; then
  LINE="$(review status "$REVIEW" 2>&1 | head -1)" || true
  REVIEW_STATE="$(awk '{print $3}' <<<"$LINE")"
  case "$REVIEW_STATE" in
    approved|done) [ -n "$SAID" ] || SAID="approved $REVIEW ($(sed -n 's/.*(\([^)]*\)).*/\1/p' <<<"$LINE" | head -1))" ;;
    "") refuse "could not read review item $REVIEW: $LINE" ;;
    *) refuse "review item $REVIEW is $REVIEW_STATE, not approved — the owner has not given the OK" ;;
  esac
fi
if [ -z "$SAID" ]; then
  OKLINE="$(grep -h '"type": "ship:ok"' "$BUILDS_DIR/$BUILD_ID/events.jsonl" 2>/dev/null | tail -1 || true)"
  [ -n "$OKLINE" ] && SAID="tapped Ship — $(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("detail",""))' "$OKLINE")"
fi
[ -n "$SAID" ] || refuse "no recorded OK from the owner: pass --review <rv-id> (approved) or --owner-said \"<their words>\""

# ── 2. the ledger ──────────────────────────────────────────────────────
STATUS="$(fm_status "$BUILD_ID")"
case "$STATUS" in
  active) run bash "$BIN/build_done.sh" "$BUILD_ID" done ;;
  stalled) run fm_event "$BUILD_ID" "status:done" "closed by build_finish (was stalled); shipped $REPO@${SHA:0:12}" ;;
  done|failed|abandoned) ;;
  *) refuse "build status is '$STATUS'" ;;
esac
DETAIL="$REPO@$SHA"
if grep -qF "\"detail\": \"$DETAIL\"" "$BUILDS_DIR/$BUILD_ID/events.jsonl" 2>/dev/null; then
  echo "already recorded finished: $DETAIL"
else
  run fm_event "$BUILD_ID" "finished" "$DETAIL"
fi

# ── 3. the review item and the card ────────────────────────────────────
if [ "$REVIEW_STATE" = "approved" ]; then
  run review done "$REVIEW" --note "Shipped: $(basename "$REPO") at ${SHA:0:12}." --actor foreman || echo "note: review item $REVIEW not marked done (see above)"
fi
CARD="kept"
if [ ${#REVIEW_CLI[@]} -eq 0 ]; then
  echo "card: ($REVIEW_SKIP: skipped)"; CARD="none"
elif [ -n "$DRY" ]; then
  printf 'would: review build-close %s --owner-said %q --actor foreman\n' "$BUILD_ID" "$SAID"
elif OUT="$(review build-close "$BUILD_ID" --owner-said "$SAID" --actor foreman 2>&1)"; then
  echo "card: $OUT"; CARD="closed"
elif grep -q "No card on the board" <<<"$OUT"; then
  echo "card: none on the board for this build"; CARD="none"
elif grep -qE "→ 404|404 Not Found|Not Found" <<<"$OUT"; then
  # A gateway without build-close: close the build's own row; other runs of the same job may keep the card.
  if OUT2="$(review track-close "bld-$BUILD_ID" --kind closed --owner-said "$SAID" --actor foreman 2>&1)"; then
    echo "card (row only — this gateway has no build-close): $OUT2"; CARD="closed"
  elif grep -q "already" <<<"$OUT2"; then echo "card: already closed"; CARD="closed"
  else echo "note: card not closed: $OUT2"; fi
else
  echo "note: card not closed: $OUT"
fi

# ── 4. the copy ────────────────────────────────────────────────────────
COPY="kept"; RC=0
if [ -n "$KEEP" ]; then
  echo "copy: kept (--keep-copy)"
elif [ -z "$TIP" ]; then
  echo "copy: the worktree is already gone"; COPY="gone"
else
  APPLY=(--apply); [ -n "$DRY" ] && APPLY=()
  set +e
  python3 -B "$BIN/fm_close.py" clean "$BUILD_ID" --finished "${APPLY[@]}"
  RC=$?
  set -e
  case "$RC" in 0) COPY="removed" ;; 3) COPY="held" ;; *) COPY="failed" ;; esac
  [ -n "$DRY" ] && COPY="kept"
fi

# ── 5. one line on the timeline ────────────────────────────────────────
case "$COPY" in
  removed|gone) NOW="Its build copy is archived and removed from this machine." ;;
  held) NOW="Its build copy is kept for now because a safety check held it, and Michael has the reason." ;;
  failed) NOW="Its build copy is kept because the archive did not verify, so nothing was deleted." ;;
  *) NOW="Its build copy is kept for now." ;;
esac
if [ -z "$DRY" ] && [ -r "$FM_STATUS" ]; then
  NAME="$(fm_meta "$BUILD_ID" name 2>/dev/null || true)"
  if REC="$(python3 -B "$FM_STATUS" make --build "$BUILD_ID" --source foreman --id "finished-$BUILD_ID" \
              --kind progress --finished "Shipped and closed out." --now "$NOW" ${NAME:+--title "$NAME"} 2>/dev/null)"; then
    RC_POST=0; printf '%s' "$REC" | fm_status_post >/dev/null 2>&1 || RC_POST=$?
    fm_event "$BUILD_ID" "status-finished" "rc=$RC_POST"
  fi
  fm_event "$BUILD_ID" "finish" "shipped ${SHA:0:12} card=$CARD copy=$COPY"
fi
echo "build_finish: $BUILD_ID shipped at ${SHA:0:12} — ledger done, card $CARD, copy $COPY"
case "$COPY" in held) exit 3 ;; failed) exit 1 ;; esac
exit 0
