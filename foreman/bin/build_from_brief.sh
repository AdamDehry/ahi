#!/usr/bin/env bash
# build_from_brief.sh — launch a foreman build FROM A BRIEF'S MACHINE HEADER, with no questions.
#
#   build_from_brief.sh [--dry-run] [--out <dir>] [--launch-id <id>] [--actor <who>] [--base <git-ref>] <brief.md>
#
# A UI "Start" button can land here (optional integration: whatever launches it
# passes --out and reads result.json). It is also a hand tool: Michael can start any
# brief that carries a valid header the same way, and --dry-run shows the EXACT
# build_start.sh call without touching anything.
#
# What it does, in order:
#   1. validates the header (fm_brief_header.py) — invalid = exit 2, nothing started
#   2. takes a non-blocking lock on the brief's sha — a double tap / duplicate wake
#      finds the lock held and exits 4 ("launch already in progress")
#   3. refuses if an ACTIVE build already carries a `brief` event for this brief
#      (exit 5, naming the build) — the second half of idempotence, across restarts
#   4. with `repo:` — cuts the worktree (fm_worktree.sh) if it does not exist yet
#   5. composes the prompt and the build_start.sh invocation from the header: the
#      agent, runtime, model, effort and why are the brief's own (MODEL GATE honoured,
#      never a silent default); pre_approved: yes adds the runs-to-preview clause
#   6. runs build_start.sh; FM_CAP's refusal (or any other) is surfaced verbatim
#   7. appends ONE `brief` event to the new build's ledger (path, sha, actor, launch id)
#      and writes <out>/result.json for the caller to pick up
#
# Exit codes: 0 started (or dry run) · 2 invalid header · 3 worktree failed ·
#             4 launch already in progress · 5 already running · 6 build_start refused
set -uo pipefail
source "$(dirname "$0")/lib.sh"

DRY=0; OUT=""; LAUNCH_ID=""; ACTOR="michael"; BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --out) OUT="${2:?--out needs a dir}"; shift 2 ;;
    --launch-id) LAUNCH_ID="${2:?--launch-id needs an id}"; shift 2 ;;
    --actor) ACTOR="${2:?--actor needs a name}"; shift 2 ;;
    --base) BASE="${2:?--base needs a git ref}"; shift 2 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    --) shift; break ;;
    -*) echo "build_from_brief: unknown option $1" >&2; exit 1 ;;
    *) break ;;
  esac
done
BRIEF="${1:?brief path}"
case "$BRIEF" in /*) ;; *) BRIEF="$(pwd)/$BRIEF" ;; esac
BRIEF="$(readlink -f "$BRIEF" 2>/dev/null || printf '%s' "$BRIEF")"
# Must match fm_worktree.sh, which cuts the worktree at $BUILDS_ROOT/<worktree>.
BUILDS_ROOT="${BUILDS_ROOT:-$FM_WORKTREES_DIR}"
LOCKS_DIR="${FM_LOCKS_DIR:-$FOREMAN_ROOT/locks}"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# result.json is how the caller learns what happened — it only ever READS it.
result() { # ok|error, key=value pairs…
  [ -n "$OUT" ] || return 0
  mkdir -p "$OUT"
  python3 - "$OUT/result.json" "$@" <<'PY'
import json, sys
path, state, *kv = sys.argv[1:]
rec = {"state": state}
for p in kv:
    k, _, v = p.partition("=")
    rec[k] = v
json.dump(rec, open(path + ".tmp", "w"), indent=2)
import os; os.replace(path + ".tmp", path)
PY
}
fail() { # code, message
  echo "build_from_brief: $2" >&2
  result failed "code=$1" "error=$2" "at=$STAMP" "launch_id=$LAUNCH_ID" "brief=$BRIEF" "sha256=${SHA:-}"
  exit "$1"
}

# ── 1. the header ───────────────────────────────────────────────────────────
HDR_JSON="$(python3 -B "$FOREMAN_ROOT/bin/fm_brief_header.py" validate "$BRIEF")" || {
  ERRS="$(printf '%s' "$HDR_JSON" | python3 -c 'import json,sys; print("; ".join(json.load(sys.stdin)["errors"]))' 2>/dev/null)"
  fail 2 "brief header invalid — ${ERRS:-unreadable}"
}
hdr() { printf '%s' "$HDR_JSON" | python3 -c 'import json,sys; v=json.load(sys.stdin)["header"].get(sys.argv[1]); print("" if v is None else (("yes" if v else "no") if isinstance(v,bool) else v))' "$1"; }
SHA="$(printf '%s' "$HDR_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha256"])')"
AGENT="$(hdr agent)"; RUNTIME="$(hdr runtime)"; MODEL="$(hdr model)"; EFFORT="$(hdr effort)"
NAME="$(hdr name)"; WHY="$(hdr why)"; PRE="$(hdr pre_approved)"; SUMMARY="$(hdr summary)"
REPO="$(hdr repo)"; BRANCH="$(hdr branch)"; WORKTREE="$(hdr worktree)"; WORKDIR="$(hdr workdir)"; TRACK="$(hdr track)"

# ── 2. one launch per brief at a time ──────────────────────────────────────
mkdir -p "$LOCKS_DIR"
LOCK="$LOCKS_DIR/brief-${SHA:0:16}.lock"
exec 8>>"$LOCK" || fail 4 "cannot open $LOCK"
if ! flock -n 8; then
  fail 4 "launch already in progress for this brief (lock $LOCK held)"
fi

# ── 3. already running? the ledger's `brief` events say ─────────────────────
HOLDER=""
for d in "$BUILDS_DIR"/*/; do
  [ -f "$d/meta.json" ] || continue
  id="$(basename "$d")"
  grep -qF "\"type\": \"brief\"" "$d/events.jsonl" 2>/dev/null || continue
  grep -F "\"type\": \"brief\"" "$d/events.jsonl" | grep -qF "sha=$SHA" || continue
  [ "$(fm_status "$id")" = "active" ] || continue
  HOLDER="$id"; break
done
if [ -n "$HOLDER" ]; then
  result started "build_id=$HOLDER" "already=yes" "at=$STAMP" "launch_id=$LAUNCH_ID" "brief=$BRIEF" "sha256=$SHA"
  echo "build_from_brief: this brief is already running as $HOLDER — nothing started." >&2
  echo "BUILD_ID=$HOLDER"
  exit 5
fi

# ── 4. the workdir ──────────────────────────────────────────────────────────
WT_CMD=""
if [ -n "$REPO" ]; then
  WORKDIR="$BUILDS_ROOT/$WORKTREE"
  WT_CMD="$FOREMAN_ROOT/bin/fm_worktree.sh $(printf '%q' "$REPO") $(printf '%q' "$WORKTREE") $(printf '%q' "$BRANCH")${BASE:+ $(printf '%q' "$BASE")}"
fi

# ── 5. the prompt and the invocation ────────────────────────────────────────
AGENT_CAP="$(python3 -c "print('$AGENT'.capitalize())")"
PROMPT="You are $AGENT_CAP. Your full brief is at $BRIEF — read it in full first. It states goals and evidence, not steps; you own the design. $SUMMARY"
if [ -n "$REPO" ]; then
  PROMPT="$PROMPT Work on branch $BRANCH in this worktree (cut from $REPO). Never restart, merge, deploy or push; never pkill node; never touch production state under $AHI_HOME/state or the live checkout at $FM_GATEWAY_DIR."
else
  PROMPT="$PROMPT Work in this folder only. Never restart, merge, deploy or push; never pkill node; never touch production state under $AHI_HOME/state or the live checkout at $FM_GATEWAY_DIR."
fi
if [ "$PRE" = "yes" ]; then
  PROMPT="$PROMPT This build is PRE-APPROVED by the owner: run all the way to a working preview without asking; there is no approve step after launch. Nothing deploys."
else
  PROMPT="$PROMPT Ship only on the owner's go; the normal close-out applies."
fi
PROMPT="$PROMPT Write REPORT.md in the worktree root and finish with a one-paragraph status. (Started from a brief by $ACTOR${TRACK:+ for row $TRACK}.)"

INVOCATION="$FOREMAN_ROOT/bin/build_start.sh -r $(printf '%q' "$RUNTIME") -m $(printf '%q' "$MODEL") -e $(printf '%q' "$EFFORT") -w $(printf '%q' "$WHY") $(printf '%q' "$AGENT") $(printf '%q' "$NAME") $(printf '%q' "$WORKDIR") $(printf '%q' "$PROMPT")"

if [ "$DRY" = 1 ]; then
  echo "DRY RUN — nothing started."
  echo "brief:     $BRIEF"
  echo "sha256:    $SHA"
  echo "workdir:   $WORKDIR"
  [ -n "$WT_CMD" ] && { if [ -e "$WORKDIR" ]; then echo "worktree:  exists (reused)"; else echo "worktree:  $WT_CMD"; fi; }
  echo "pre_approved: $PRE"
  echo "invocation:"
  echo "$INVOCATION"
  result dry-run "invocation=$INVOCATION" "workdir=$WORKDIR" "worktree_cmd=$WT_CMD" "at=$STAMP" "launch_id=$LAUNCH_ID" "brief=$BRIEF" "sha256=$SHA" "pre_approved=$PRE"
  exit 0
fi

if [ -n "$WT_CMD" ] && [ ! -e "$WORKDIR" ]; then
  if ! WT_OUT="$(eval "$WT_CMD" 2>&1)"; then
    fail 3 "worktree failed: $(printf '%s' "$WT_OUT" | tail -3 | tr '\n' ' ')"
  fi
fi

# ── 6. launch ───────────────────────────────────────────────────────────────
START_OUT="$(mktemp /tmp/fm_from_brief.XXXXXX)"
RC=0
eval "$INVOCATION" >"$START_OUT" 2>&1 || RC=$?
BUILD_ID="$(grep -oE '^BUILD_ID=.*' "$START_OUT" | head -1 | cut -d= -f2-)"
if [ "$RC" -ne 0 ] || [ -z "$BUILD_ID" ]; then
  MSG="$(grep -vE '^\s*$' "$START_OUT" | head -c 1200)"
  rm -f "$START_OUT"
  fail 6 "build_start refused (rc=$RC): $MSG"
fi
RC_URL="$(grep -oE 'https://claude\.ai/code/[A-Za-z0-9_]+' "$START_OUT" | head -1 || true)"
rm -f "$START_OUT"

# ── 7. the record ───────────────────────────────────────────────────────────
fm_event "$BUILD_ID" "brief" "path=$BRIEF sha=$SHA actor=$ACTOR launch=$LAUNCH_ID pre_approved=$PRE${TRACK:+ track=$TRACK}"
result started "build_id=$BUILD_ID" "workdir=$WORKDIR" "at=$STAMP" "launch_id=$LAUNCH_ID" "brief=$BRIEF" "sha256=$SHA" "pre_approved=$PRE" "rc_url=$RC_URL" "track=$TRACK"
echo "BUILD_ID=$BUILD_ID"
[ -n "$RC_URL" ] && echo "watch anywhere: $RC_URL"
exit 0
