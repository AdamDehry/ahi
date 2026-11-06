#!/usr/bin/env bash
# fm_worktree.sh — create a build copy (git worktree) whose node_modules come from the
# shared, read-only dependency cache (fm_depcache.py) instead of a fresh download.
#
#   fm_worktree.sh <repo> <name> <branch> [<base>]
#       git worktree add  $BUILDS_ROOT/<name>  (new <branch> from <base>, default the repo's
#       HEAD; an existing <branch> is checked out as is), then node_modules for every tracked
#       package-lock.json at depth <= 2 (e.g. the repo root and web/) from the cache.
#       <branch> may be --detach for a branchless copy at <base>.
#   fm_worktree.sh deps <worktree-dir>
#       (re)materialise node_modules in an existing worktree. Any dir that already has a
#       node_modules is left alone — remove it first to migrate.
#   fm_worktree.sh clean [--apply]
#       CLOSED builds only: drop node_modules / .next / dist in their worktrees. Dry run by
#       default. The worktree and branch always stay. See fm_worktree_clean.py.
#       Refuses any target that holds an enrolled redaction source (when a redactor is
#       configured — see fm_redaction_guard.py).
#   fm_worktree.sh guard <path>...
#       RUN BEFORE RETIRING ANY FOLDER (rm, cold storage, archive). Exit 0 = no enrolled
#       redaction source under the path(s), or no redactor configured (FM_REDACTOR_MJS
#       unset — proceed); 3 = sources found (listed — retire them first); 4 = a configured
#       redactor's source table is unreadable (treat as protected). Moving an enrolled
#       source away makes every ingest fail closed until the enrollment is repaired.
#       See fm_redaction_guard.py.
#
# The result is a normal, full tree: npm test, tsc, the web build and the dev server run as
# before. `npm ci` / `npm install` inside it are safe (they replace files; the cache is
# read-only and manifest-checked) — they just make that one copy private again.
# Never use this on the live gateway checkout as a destination; it refuses.
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"
AHI_HOME="${FM_AHI_HOME:-${AHI_HOME:-$HOME/ahi}}"
FM_GATEWAY_DIR="${FM_GATEWAY_DIR:-$AHI_HOME/gateway}"      # the live gateway tree: never a destination
FM_WORKTREES_DIR="${FM_WORKTREES_DIR:-$AHI_HOME/builds}"   # where build copies / worktrees live
BUILDS_ROOT="${BUILDS_ROOT:-$FM_WORKTREES_DIR}"            # build_from_brief.sh uses the same default
# readlink -m: the guard must hold even when the gateway is not installed (an absent path
# still compares, it just never matches a real tree).
LIVE_GW="$(readlink -m "$FM_GATEWAY_DIR")"
export NODE_ENV="${NODE_ENV:-}"   # npm ci always gets --include=dev regardless

lockdirs() {  # tracked package-lock.json dirs, depth <= 2, relative to $1
  git -C "$1" ls-files -- 'package-lock.json' '*/package-lock.json' \
    | awk -F/ 'NF<=2' | xargs -r -n1 dirname
}

deps() {
  local wt; wt="$(readlink -f "$1")"
  case "$wt/" in "$LIVE_GW"/*) echo "fm_worktree: $wt is the live gateway tree — refused" >&2; exit 1;; esac
  local rc=0 d
  for d in $(lockdirs "$wt"); do
    if [ -e "$wt/$d/node_modules" ]; then
      echo "fm_worktree: $wt/$d/node_modules exists — left alone"
      continue
    fi
    python3 -B "$BIN/fm_depcache.py" materialise "$wt/$d" || rc=$?
  done
  return $rc
}

case "${1:-}" in
  ""|-h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
  deps)  deps "${2:?worktree dir}"; exit $? ;;
  clean) shift; exec python3 -B "$BIN/fm_worktree_clean.py" "$@" ;;
  guard) shift; [ $# -gt 0 ] || { echo "fm_worktree: guard needs at least one path" >&2; exit 2; }
         exec python3 -B "$BIN/fm_redaction_guard.py" check "$@" ;;
esac

REPO="${1:?repo}"; NAME="${2:?name}"; BRANCH="${3:?branch}"; BASE="${4:-HEAD}"
DEST="$BUILDS_ROOT/$NAME"
[ -e "$DEST" ] && { echo "fm_worktree: $DEST already exists — refused" >&2; exit 1; }
case "$(readlink -m "$DEST")/" in "$LIVE_GW"/*) echo "fm_worktree: $DEST is inside the live gateway — refused" >&2; exit 1;; esac
mkdir -p "$(dirname "$DEST")"

before=$(df -k --output=used / | tail -1)
if [ "$BRANCH" = "--detach" ]; then      # no branch: probes, measurements, read-only builds
  git -C "$REPO" worktree add --detach "$DEST" "$BASE"
elif git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$REPO" worktree add "$DEST" "$BRANCH"
else
  git -C "$REPO" worktree add -b "$BRANCH" "$DEST" "$BASE"
fi
deps "$DEST" || echo "fm_worktree: WARNING dependency step returned non-zero — see above" >&2
after=$(df -k --output=used / | tail -1)
echo "fm_worktree: $DEST ready ($BRANCH, base $BASE) — disk used grew $(( (after - before) / 1024 )) MB (df; du of the tree alone overcounts shared hardlinks)"
