#!/usr/bin/env bash
set -euo pipefail

REPO=""
PHASE="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --phase) PHASE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$REPO" ]] || { echo "Usage: $0 --repo <path> [--phase B1|B2|B3|B4|all]" >&2; exit 2; }
[[ -d "$REPO/.git" ]] || { echo "run-audit: repo is not a git checkout: $REPO" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATE="$(date +%F)"
PROJECT="$(basename "$REPO")"
if [[ "$PROJECT" == "crm" ]]; then PROJECT="business-crm"; fi
MIRROR="${AUDIT_MIRROR_DIR:-$HOME/ai/builds/$PROJECT/audits}"
REPO_AUDITS="$REPO/docs/audits"
mkdir -p "$MIRROR" "$REPO_AUDITS"

FULL="$MIRROR/${DATE}-full-audit.md"
WORK="$(mktemp -d -t audit_run.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

cd "$REPO"
remote_url="$(git remote get-url origin 2>/dev/null || true)"
GH_REPO="$(printf "%s" "$remote_url" | sed -E 's#^git@github.com:(.*)\\.git$#\\1#; s#^https://github.com/(.*)\\.git$#\\1#')"
if [[ -z "$GH_REPO" ]]; then GH_REPO="unknown"; fi

gh_status="missing"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then gh_status="authenticated"; fi

apps_note="$(mktemp -t audit_apps.XXXXXX)"
{
  echo "GitHub repo: $GH_REPO"
  echo "gh CLI: $gh_status"
  echo "Repo installation endpoint with user token:"
  gh api "repos/${GH_REPO}/installation" 2>&1 || true
  echo
  echo "User-visible installations containing bugbot/cubic:"
  gh api user/installations --paginate 2>/dev/null | jq -r '.installations[]? | select((.app_slug // "" | ascii_downcase) | test("bugbot|cubic|cursor")) | "- " + .app_slug + " on " + (.account.login // "unknown")' || true
} > "$apps_note"

run_phase() {
  local phase="$1"
  local script="$2"
  local out="$WORK/${DATE}-${phase}.md"
  "$SCRIPT_DIR/$script" --repo "$REPO" --output "$out"
  cp "$out" "$REPO_AUDITS/$(basename "$out")"
  echo "$out"
}

outputs=()
if [[ "$PHASE" == "all" || "$PHASE" == "B1" || "$PHASE" == "b1" ]]; then
  set +e
  b1_out="$(run_phase "secret-leak-audit" "b1-secret-leak.sh")"
  rc=$?
  set -e
  outputs+=("$b1_out")
  if [[ "$rc" -eq 10 ]]; then
    {
      echo "# Full Code Audit — $PROJECT"
      echo "Date: $DATE"
      echo "Author: audit-codebase harness"
      echo "Scope: Phase B all"
      echo
      echo "## GitHub App Status"
      echo
      cat "$apps_note"
      echo
      echo "## BLOCKED"
      echo
      echo "B/1 found potential committed secret material. Per gate policy, later phases and PR-bot exposure were halted."
      echo
      cat "$b1_out"
    } > "$FULL"
    cp "$FULL" "$REPO_AUDITS/$(basename "$FULL")"
    echo "$FULL"
    exit 10
  elif [[ "$rc" -ne 0 ]]; then
    exit "$rc"
  fi
fi

if [[ "$PHASE" == "all" || "$PHASE" =~ ^[Bb]2$ ]]; then outputs+=("$(run_phase "database-security-audit" "b2-database-security.sh")"); fi
if [[ "$PHASE" == "all" || "$PHASE" =~ ^[Bb]3$ ]]; then outputs+=("$(run_phase "api-route-auth-audit" "b3-api-route-audit.sh")"); fi
if [[ "$PHASE" == "all" || "$PHASE" =~ ^[Bb]4$ ]]; then outputs+=("$(run_phase "web-security-posture-audit" "b4-web-security-posture.sh")"); fi

{
  echo "# Full Code Audit — $PROJECT"
  echo "Date: $DATE"
  echo "Author: audit-codebase harness"
  echo "Scope: Phase ${PHASE}"
  echo "Repo: $REPO"
  echo
  echo "## GitHub App Status"
  echo
  cat "$apps_note"
  echo
  echo "BugBot note: if no BugBot installation/comment is visible, treat BugBot as inactive/unavailable."
  echo "Cubic note: use PR comments/checks when available; current trial should be usable."
  echo
  echo "## Executive Summary"
  echo
  echo "Phase reports are concatenated below. A perf-specific H-079 section should be appended by the agent after reviewing route/component scan and Codex consult output."
  echo
  for out in "${outputs[@]}"; do
    echo
    echo "---"
    echo
    cat "$out"
  done
} > "$FULL"
cp "$FULL" "$REPO_AUDITS/$(basename "$FULL")"
echo "$FULL"
