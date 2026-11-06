#!/usr/bin/env bash
# fm_branch_note.sh — sourced by build_done.sh.
#
# A build that closes `done` with its work on an unmerged branch is not shipped:
# the owner hears about it through a review card (when the gateway has review
# cards), which announces itself in the owner's chat and waits in Reviews. The
# close wake spells out the three steps, so the chain never depends on Michael
# remembering them. Prints nothing for any other close.
#
# Review cards are an OPTIONAL integration (FM_REVIEW_MJS). Without them, step 2
# becomes "ask the owner in chat" — the approval rule itself does not change.
#
#   fm_branch_close_note <build-id> <status> <workdir>

FM_REVIEW_MJS="${FM_REVIEW_MJS:-$FM_GATEWAY_DIR/scripts/review.mjs}"

fm_branch_close_note() {
  local build_id="$1" status="$2" workdir="$3" branch step2
  [ "$status" = "done" ] || return 0
  [ -n "$workdir" ] && [ -d "$workdir" ] || return 0
  git -C "$workdir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  branch="$(git -C "$workdir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  case "$branch" in
    ""|HEAD|main|master) return 0 ;;
  esac
  if [ -f "$FM_REVIEW_MJS" ]; then
    step2="  2. Post the card for the owner: node $FM_REVIEW_MJS post --lane YELLOW --desk \"<desk>\" --title \"<plain title — no paths, ids or hashes>\" --brief-file <plain-English brief> --ref $build_id
     The card announces itself in the owner's chat and waits in Reviews."
  else
    step2="  2. Ask the owner for approval in chat with a plain-English brief (no review cards configured — FM_REVIEW_MJS not found)."
  fi
  cat <<NOTE
BRANCH-ONLY BUILD — its work is on branch $branch (not merged, not deployed). Next, in order:
  1. Review it: the diff against main, the build's closing status, its tests.
$step2
  3. Done. Merge, deploy or restart only after the owner approves.
NOTE
}
