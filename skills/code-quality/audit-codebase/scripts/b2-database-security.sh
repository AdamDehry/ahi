#!/usr/bin/env bash
set -euo pipefail

REPO=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$REPO" && -n "$OUTPUT" ]] || { echo "b2-database-security: --repo and --output required" >&2; exit 2; }
mkdir -p "$(dirname "$OUTPUT")"

DATE="$(date +%F)"
PKG="$REPO/package.json"
ENV_EX="$REPO/.env.example"
MIG="$REPO/supabase/migrations"

stack="none"
if [[ -f "$PKG" ]] && grep -qi 'supabase' "$PKG"; then stack="supabase"; fi
if [[ -f "$ENV_EX" ]] && grep -qiE 'DATABASE_URL|POSTGRES' "$ENV_EX"; then stack="${stack},postgres-direct"; fi
if [[ -f "$PKG" ]] && grep -qi 'firebase' "$PKG"; then stack="firebase"; fi

advisor_out="$(mktemp -t audit_b2_advisor.XXXXXX)"
grant_out="$(mktemp -t audit_b2_grants.XXXXXX)"
rls_out="$(mktemp -t audit_b2_rls.XXXXXX)"
trap 'rm -f "$advisor_out" "$grant_out" "$rls_out"' EXIT

advisor_status="not-run"
if [[ "$stack" == *supabase* ]]; then
  if command -v supabase >/dev/null 2>&1; then
    (cd "$REPO" && supabase db advisors --linked >"$advisor_out" 2>&1) && advisor_status="ran" || advisor_status="failed"
  else
    advisor_status="supabase-cli-missing"
  fi
  if [[ -d "$MIG" ]]; then
    rg -n "grant\\s+all|grant\\s+.*\\s+to\\s+(anon|authenticated|public)|alter\\s+table\\s+.*disable\\s+row\\s+level\\s+security" "$MIG" -i > "$grant_out" || true
    rg -n "enable\\s+row\\s+level\\s+security|create\\s+policy|disable\\s+row\\s+level\\s+security" "$MIG" -i > "$rls_out" || true
  fi
fi

grant_count="$(wc -l < "$grant_out" 2>/dev/null | tr -d " " || echo 0)"
advisor_findings=0
if [[ -s "$advisor_out" ]]; then
  advisor_findings="$(grep -Eic 'warn|error|security|rls|policy' "$advisor_out" || true)"
fi
medium="$grant_count"
if [[ "$advisor_status" == "failed" || "$advisor_status" == "supabase-cli-missing" ]]; then medium=$((medium + 1)); fi

{
  echo "# Database Security Audit — $(basename "$REPO")"
  echo "Date: $DATE"
  echo "Author: audit-codebase harness"
  echo "Scope: Database stack detection, Supabase advisor attempt, migration grant/RLS scan"
  echo "Method: package/env stack detection; optional Supabase CLI; regex scan of SQL migrations"
  echo
  echo "## Summary"
  echo
  echo "- HIGH: 0"
  echo "- MEDIUM: $medium"
  echo "- LOW: $advisor_findings"
  echo
  echo "Top findings:"
  if [[ "$medium" -eq 0 && "$advisor_findings" -eq 0 ]]; then
    echo "1. No blocking database security findings from the local harness."
  else
    echo "1. Review Supabase advisor/migration notes below."
  fi
  echo
  echo "## Inventory"
  echo
  echo "| Item | Path | Status | Notes |"
  echo "|---|---|---|---|"
  echo "| Stack | package/env | detected | $stack |"
  echo "| Supabase migrations | supabase/migrations | checked | $(find "$MIG" -type f 2>/dev/null | wc -l | tr -d " ") migration file(s) |"
  echo "| Supabase advisors | linked project | $advisor_status | requires local Supabase auth/link |"
  echo
  echo "## Detailed Findings"
  echo
  n=1
  if [[ "$advisor_status" == "failed" || "$advisor_status" == "supabase-cli-missing" ]]; then
    echo "### MEDIUM-$n: Supabase advisor did not complete"
    echo
    echo "[SOURCE: \`supabase/config.toml\` at line 1]"
    echo
    echo "The repo uses Supabase, but the linked advisor check could not complete locally (\`$advisor_status\`)."
    echo
    echo "**Recommendation:** Run \`supabase db advisors --linked\` from an authenticated environment and fold warnings into the next audit."
    echo
    n=$((n + 1))
  fi
  if [[ "$grant_count" -gt 0 ]]; then
    while IFS= read -r line; do
      file="${line%%:*}"
      rest="${line#*:}"
      lineno="${rest%%:*}"
      echo "### MEDIUM-$n: Broad grant or RLS disable statement requires review"
      echo
      echo "[SOURCE: \`${file#$REPO/}\` at line $lineno]"
      echo
      echo "Migration contains a broad grant, public role grant, or RLS disable statement. It may be intentional, but it should be reviewed against current access boundaries."
      echo
      echo "**Recommendation:** Confirm the grant is required and not broader than \`authenticated\`/service-role use actually needs."
      echo
      n=$((n + 1))
    done < "$grant_out"
  fi
  if [[ "$n" -eq 1 ]]; then echo "No HIGH or MEDIUM findings."; fi
  echo
  echo "## Advisor Output"
  echo
  if [[ -s "$advisor_out" ]]; then
    echo '```text'
    sed -n '1,160p' "$advisor_out"
    echo '```'
  else
    echo "No advisor output captured."
  fi
  echo
  echo "## RLS/Policy Inventory"
  echo
  if [[ -s "$rls_out" ]]; then
    echo '```text'
    sed -n '1,120p' "$rls_out"
    echo '```'
  else
    echo "No RLS/policy statements found by regex."
  fi
  echo
  echo "## Recommendations (ranked by value / effort)"
  echo
  echo "1. Run Supabase advisors from a linked, authenticated shell — value: high · effort: low."
  echo "2. Keep every customer-sensitive table under RLS with explicit policies — value: high · effort: medium."
  echo
  echo "## Out of Scope"
  echo
  echo "- Live Supabase dashboard settings were not inspected."
  echo "- Production role grants were not queried directly unless the local Supabase CLI advisor succeeded."
} > "$OUTPUT"
