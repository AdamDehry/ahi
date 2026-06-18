#!/usr/bin/env bash
set -euo pipefail

REPO=""
PR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --pr) PR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$REPO" && -n "$PR" ]] || { echo "Usage: $0 --repo <repo-path-or-owner/name> --pr <number>" >&2; exit 2; }

if [[ -d "$REPO/.git" ]]; then
  cd "$REPO"
  GH_REPO="$(git remote get-url origin | sed -E 's#.*github.com[:/](.*)\\.git#\\1#')"
else
  GH_REPO="$REPO"
fi

json="$(gh pr view "$PR" --repo "$GH_REPO" --json comments,reviews,statusCheckRollup 2>/dev/null || echo '{}')"

echo "## Bot Findings for PR #$PR"
echo
echo "$json" | jq -r '
  [
    (.comments // [])[] | {kind:"comment", author:(if (.author|type) == "object" then (.author.login // "") else (.author // "") end), body:(.body // ""), path:null},
    (.reviews // [])[] | {kind:"review", author:(if (.author|type) == "object" then (.author.login // "") else (.author // "") end), body:(.body // ""), path:null}
  ]
  | map(select((.author // "" | ascii_downcase) | test("cubic|bugbot|cursor")))
  | if length == 0 then
      "No BugBot/Cubic comments found. BugBot may be inactive; Cubic may not have posted yet or may only annotate checks."
    else
      map("### " + .author + " (" + .kind + ")\n\n" + (.body // "_No body_")) | join("\n\n---\n\n")
    end
'
echo
echo "## Bot Check Status"
echo
echo "$json" | jq -r '
  (.statusCheckRollup // [])
  | map(select((.name // .context // "" | ascii_downcase) | test("cubic|bugbot|cursor")))
  | if length == 0 then
      "No BugBot/Cubic check runs found."
    else
      map("- " + (.name // .context // "unknown") + ": " + (.status // .state // "unknown") + " " + (.conclusion // "") + (if .detailsUrl then " — " + .detailsUrl else "" end)) | join("\n")
    end
'
